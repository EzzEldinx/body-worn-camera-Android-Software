const express = require('express');
const report = require('./report');
const { parseRange } = require('./range');
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const NodeMediaServer = require('node-media-server');
const { db, hashPassword, verifyPassword, verifyPasswordAsync } = require('./db');
const { safeCookies, guard, tokenBucket, loginLimiter, securityHeaders, housekeeping, processGuards } = require('./hardening');
const packages = require('./packages');
const auditlog = require('./auditlog');
const features = require('./features');
const insights = require('./insights');
const support = require('./support');
const deviceTokens = require('./tokens');

// Cameras present this shared token for now (per-device tokens come later).
const CAMERA_TOKEN = process.env.BWC_TOKEN || 'change-me';
if (CAMERA_TOKEN === 'change-me') console.warn('WARNING: BWC_TOKEN is not set. Using the insecure default.');
// Cameras should authenticate with their own token. The old shared BWC_TOKEN keeps working until
// ALLOW_SHARED_TOKEN=false is set, so a fleet can be migrated camera by camera.
const ALLOW_SHARED_TOKEN = process.env.ALLOW_SHARED_TOKEN !== 'false';
// -> { id } for a per-camera token, { shared: true } for the legacy shared token, null otherwise.
function authCamera(token) {
    if (typeof token !== 'string' || !token) return null;
    const row = db.prepare('SELECT id FROM cameras WHERE token_hash = ?').get(deviceTokens.hashToken(token));
    if (row) return { id: row.id };
    if (ALLOW_SHARED_TOKEN && deviceTokens.safeEqual(token, CAMERA_TOKEN)) return { shared: true };
    return null;
}
// Live-stream play URLs are signed per request; the secret only lives in memory.
const STREAM_SECRET = process.env.STREAM_SECRET || crypto.randomBytes(24).toString('hex');
const DAY = 86400000;

// ---------- First run: create the admin account ----------
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
    db.prepare('INSERT INTO users(username,name,pass,role) VALUES(?,?,?,?)')
        .run('admin', 'Administrator', hashPassword(pw), 'admin');
    console.log(`\nFirst run: created user "admin" with password: ${pw}`);
    console.log('Change it with: node tools/create-user.js admin <new-password> "Administrator" admin\n');
}
// Old GPS points and expired sessions are removed at start and then every hour, in small batches (it used to happen only at start, in one blocking statement).
const keepHouse = guard('housekeeping', () => housekeeping({ db, positionsDays: Number(process.env.POSITIONS_DAYS) || 30, eventsDays: Number(process.env.EVENTS_DAYS) || 0 }));
keepHouse(); setInterval(keepHouse, 3600000).unref();

// ---------- Helpers ----------
const str = (v) => (typeof v === 'string' && /^(?!\.+$)[\w.-]{1,32}$/.test(v) ? v : null);   // an id is also a folder name: "." and ".." are never ids
const num = (v, min, max) => (Number.isFinite(v) && v >= min && v <= max ? v : null);
const parseCookie = safeCookies;   // never throws: a malformed cookie used to stop the whole server from one WebSocket handshake
// A company whose subscription ended is locked after a short grace period (SUBSCRIPTION_GRACE_DAYS, default 7): its users cannot sign in or stay signed in.
// Its cameras keep connecting and every SOS and recording is still received and kept. Extending the subscription opens it again at once.
const SUB_GRACE_DAYS = process.env.SUBSCRIPTION_GRACE_DAYS === undefined ? 7 : Math.max(0, Number(process.env.SUBSCRIPTION_GRACE_DAYS) || 0);
const subLocked = (subEnd) => !!subEnd && Date.now() > subEnd + SUB_GRACE_DAYS * 86400000;
const SUB_LOCK_MSG = 'Your subscription has ended. Contact Smart Way to renew it.';
const userBySession = (t) => {
    const u = !t || typeof t !== 'string' ? null : db.prepare(`SELECT u.id,u.username,u.name,u.role,u.company_id AS companyId,c.name AS company,c.sub_end AS subEnd,c.features AS coFeatures,u.perms AS perms,u.avatar_ts AS avatarTs,c.logo_ts AS logoTs
        FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN companies c ON c.id = u.company_id
        WHERE s.token = ? AND s.exp > ? AND u.active != 0`).get(t, Date.now());
    if (!u || (u.companyId && subLocked(u.subEnd))) return null;
    u.features = features.effective({ staff: !u.companyId, manager: u.role === 'manager', role: u.role, companyFeatures: u.coFeatures, perms: u.perms });   // what this person may use (see features.js)
    delete u.subEnd; delete u.coFeatures; delete u.perms; return u;
};
const userFromCookie = (header) => userBySession(parseCookie(header).sid);
// Web uses the sid cookie; the mobile apps send the same session as "Authorization: Bearer <token>".
const bearer = (h = '') => (/^Bearer ([0-9a-f]{64})$/.exec(String(h)) || [])[1] || null;
const userFromRequest = (req) => userFromCookie(req.headers.cookie) || userBySession(bearer(req.headers.authorization));
// Smart Way staff have no company and see every camera; company users only see their own.
const isStaff = (u) => !u.companyId;
const isSuper = (u) => u.role === 'admin' && !u.companyId;
// Company users: manager = everything in their company (employees, users, delete files); client = operator (watch, alarms, chat, choose what happens to files, no delete); viewer = read only.
const ROLES = ['manager', 'client', 'viewer'];
const can = (u, f) => u.features.includes(f);
const isManager = (u) => isSuper(u) || u.role === 'manager';
const canWrite = (u) => u.role !== 'viewer';
const needWrite = (req, res, next) => (canWrite(req.user) ? next() : res.status(403).json({ error: 'Your account is read only.' }));
const needDelete = (req, res, next) => (isManager(req.user) || (canWrite(req.user) && can(req.user, 'delete')) ? next() : res.status(403).json({ error: 'You are not allowed to delete files.' }));
const needFiles = (req, res, next) => (canWrite(req.user) && can(req.user, 'files') ? next() : res.status(403).json({ error: 'You are not allowed to decide on recordings.' }));
// A company's subscription: notice 30 days before it ends, and after.
const subscriptionOf = (companyId) => {
    const e = companyId ? db.prepare('SELECT sub_end FROM companies WHERE id = ?').get(companyId)?.sub_end : null;
    if (!e) return null;
    const daysLeft = Math.ceil((e - Date.now()) / DAY);
    return { end: e, daysLeft, state: subLocked(e) ? 'locked' : e < Date.now() ? 'expired' : daysLeft <= 30 ? 'expiring' : 'active', show: daysLeft <= 30, lockOn: e + SUB_GRACE_DAYS * DAY };
};

// ---------- Camera registry (database + live state) ----------
const cams = new Map();  // cameraId -> state sent to dashboards
const live = new Map();  // cameraId -> socket.id currently owning it
const lastPos = new Map();
for (const r of db.prepare('SELECT * FROM cameras').all()) {
    const p = db.prepare('SELECT lat,lng,ts FROM positions WHERE camera_id=? ORDER BY ts DESC LIMIT 1').get(r.id);
    cams.set(r.id, {
        cameraId: r.id, name: r.name || r.id, grp: r.grp || '', holder: r.holder || '', online: false, recording: false,
        lat: p ? p.lat : null, lng: p ? p.lng : null, ts: p ? p.ts : 0, companyId: r.company_id || null, region: r.region || null, updateMode: r.update_mode || 'off',
        ...(r.battery != null ? { battery: r.battery, batteryTs: r.battery_ts || null, charging: !!r.charging } : {}),   // last reading, shown until the camera reports again
    });
}
const companyName = (id) => (id ? db.prepare('SELECT name FROM companies WHERE id = ?').get(id)?.name || null : null);
// What dashboards receive: the camera state plus its company's name (for grouping in the list).
const decorate = (c) => ({ ...c, company: companyName(c.companyId) });
// Cameras the admin removed stay hidden until the camera is really used again (recording, SOS or PTT).
const deleted = new Set(db.prepare('SELECT id FROM deleted_cameras').all().map((r) => r.id));
const revive = (id) => {
    if (!deleted.has(id)) return;
    deleted.delete(id);
    db.prepare('DELETE FROM deleted_cameras WHERE id = ?').run(id);
};
const canSee = (u, camId) => isStaff(u) || cams.get(camId)?.companyId === u.companyId;
const visibleCams = (u) => [...cams.values()].filter((c) => isStaff(u) || c.companyId === u.companyId).map(decorate);

// Dashboards of Smart Way staff join room:admin; company dashboards join room:company_<id>.
const roomsFor = (id) => {
    const cid = cams.get(id)?.companyId;
    return cid ? ['room:admin', `room:company_${cid}`] : ['room:admin'];
};
const toCam = (id, event, data) => io.to(roomsFor(id)).emit(event, data);

// Activity log used by the daily report: online/offline, recording, PTT, messages.
const logEvent = (id, type, info) => db.prepare('INSERT INTO events(ts,camera_id,type,info) VALUES(?,?,?,?)').run(Date.now(), id, type, info || null);
function publish(id, patch) {
    if (!cams.has(id)) {
        const ok = license.allow('camera');
        if (!ok.ok) { refuseCamera(id, ok.error); return; }
        db.prepare('INSERT OR IGNORE INTO cameras(id,name,grp,created) VALUES(?,?,?,?)').run(id, id, '', Date.now());
    }
    const prev = cams.get(id);
    const state = {
        cameraId: id, name: id, grp: '', online: false, recording: false, lat: null, lng: null, ts: 0, companyId: null,
        ...cams.get(id), ...patch,
    };
    if (state.online && !prev?.online) state.onlineSince = Date.now();   // how long it has stayed connected (a new build only counts as proven on a camera that does)
    if (!!prev?.online !== !!state.online) logEvent(id, state.online ? 'online' : 'offline');
    if (!!prev?.recording !== !!state.recording) logEvent(id, state.recording ? 'rec_start' : 'rec_stop');
    if (!!prev?.ptt !== !!state.ptt) logEvent(id, state.ptt ? 'ptt_start' : 'ptt_end');
    cams.set(id, state);
    toCam(id, 'dashboard_cam', decorate(state));
}
const alarmRow = (r) => ({ id: r.id, cameraId: r.camera_id, lat: r.lat, lng: r.lng, ts: r.ts, ack: r.ack_ts != null, holder: r.holder || null, holderNo: r.holder_no || null });
const recentAlarms = (u) => (isStaff(u)
    ? db.prepare('SELECT id,camera_id,lat,lng,ts,ack_ts,holder,holder_no FROM alarms ORDER BY id DESC LIMIT 100').all()
    : db.prepare(`SELECT a.id,a.camera_id,a.lat,a.lng,a.ts,a.ack_ts,a.holder,a.holder_no FROM alarms a
        JOIN cameras c ON c.id = a.camera_id WHERE c.company_id = ? ORDER BY a.id DESC LIMIT 100`).all(u.companyId)
).map(alarmRow);
// An SOS nobody has answered yet. While one is open (and not older than SOS_GUARD_MS) nobody may cut that camera's recording from the dashboard.
const SOS_GUARD_MS = Number(process.env.STOPREC_SOS_GUARD_MS) || 2 * 3600000;
const sosOpen = (camId) => !!db.prepare('SELECT 1 FROM alarms WHERE camera_id = ? AND ack_ts IS NULL AND ts > ? LIMIT 1').get(camId, Date.now() - SOS_GUARD_MS);

// Package limits: how many cameras a company owns and how many may stream live at once.
const companyLimits = (id) => (id ? db.prepare('SELECT max_cameras AS maxCameras, max_live AS maxLive FROM companies WHERE id = ?').get(id) : null);
const cameraCount = (id) => [...cams.values()].filter((c) => c.companyId === id).length;
const liveCount = (id) => [...cams.values()].filter((c) => c.companyId === id && c.online && (c.recording || c.remote)).length;

// Move a camera to a company (or back to unassigned) and keep every live view consistent.
function assignCamera(id, companyId) {
    const old = cams.get(id)?.companyId || null;
    db.prepare('UPDATE cameras SET company_id = ? WHERE id = ?').run(companyId, id);
    if (old && old !== companyId) io.to(`room:company_${old}`).emit('dashboard_cam_removed', { cameraId: id });
    publish(id, { companyId });
    const s = live.get(id) && io.sockets.sockets.get(live.get(id));
    if (s) { s.leave(`room:public_${old || 0}`); s.join(`room:public_${companyId || 0}`); }
}

// ---------- HTTP: login, API, pages ----------
const app = express();
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal');   // behind nginx: req.ip is the real client, so a few wrong passwords do not lock everybody out
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 15e6 }); // voice notes travel as Base64 (default cap is 1 MB)
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(express.json());

// ---------- Licence (self-hosted installations; off on Smart Way's own servers, see license.js and docs/LICENSING.md) ----------
const mailer = support.createMailer();
const license = require('./license').create({
    db, keys: require('./license-pubkey').keys(), version: require('./package.json').version,
    usage: () => ({
        cameras: cams.size, live: [...cams.values()].filter((c) => c.online && (c.recording || c.remote)).length,
        users: db.prepare("SELECT COUNT(*) n FROM users WHERE role != 'officer' AND active != 0").get().n,
        employees: db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'officer' AND active != 0").get().n,
        companies: db.prepare('SELECT COUNT(*) n FROM companies').get().n,
    }),
    audit: (user, action, cam, detail) => auditlog.add(db, user, action, cam || null, detail || null),
    notify: (subject, text) => mailer.send(subject, text, [process.env.SUPPORT_EMAIL || 'sdpt@smart-way.com.sa', ...String(process.env.LICENSE_NOTIFY || '').split(',').map((x) => x.trim()).filter(Boolean)].join(',')),
});
app.use(license.guard);                                               // an expired licence cannot grow the system or export from it; cameras, SOS and evidence are never touched
// A feature the company does not have, or the user was not given, is refused here for every route that needs it (the menus hide it too, but this is the real lock).
app.use((req, res, next) => {
    const f = features.ruleFor(req.path); if (!f) return next();
    const u = userFromRequest(req);
    return !u || can(u, f) ? next() : res.status(403).json({ error: 'This feature is not included in your account.', code: 'feature' });
});
app.use('/api/station', license.gate('checkout')); app.use('/api/assignments', license.gate('checkout'));
app.use('/api/dock', license.gate('docking')); app.use('/api/docks', license.gate('docking'));
app.use('/api/mobile', (req, res, next) => (req.path === '/config' ? next() : license.gate('mobile')(req, res, next)));
license.tick(); setInterval(license.tick, 10 * 60 * 1000).unref();
const licenseRefused = new Map();
const refuseCamera = (id, why) => { if (licenseRefused.size > 1000) licenseRefused.clear(); if (Date.now() - (licenseRefused.get(id) || 0) > 3600000) { licenseRefused.set(id, Date.now()); console.warn(`licence: camera ${id} not registered: ${why}`); auditlog.add(db, 'system', 'license_camera_refused', id, { reason: why }); } };

const needUser = (req, res, next) => {
    req.user = userFromRequest(req);
    if (req.user) return next();
    if (req.path.startsWith('/api')) return res.status(401).json({ error: 'Sign in required.' });
    res.redirect('/login.html');
};
const needAdmin = (req, res, next) =>
    isSuper(req.user) ? next() : res.status(403).json({ error: 'Admins only.' });

// Wrong passwords: 5 per username from one address, 30 per address, in 5 minutes (see hardening.js). The attempt is counted before the password is checked,
// the check runs off the event loop, and an unknown username costs the same time as a wrong password (so accounts cannot be listed by timing).
const logins = loginLimiter();
setInterval(() => logins.prune(), 60000).unref();
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));
// Shared by the web login and the mobile login: same accounts, same rate limit.
async function checkLogin(req) {
    const username = String(req.body?.username ?? '').slice(0, 64), password = String(req.body?.password ?? '').slice(0, 256);
    if (!logins.enter(req.ip, username)) return { status: 429, error: 'Too many attempts. Try again in a few minutes.' };
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    const good = (await verifyPasswordAsync(password, u ? u.pass : DUMMY_HASH)) && !!u && u.active !== 0;
    if (logins.leave(req.ip, username, good)) auditlog.add(db, 'system', 'login_locked', null, { user: username.slice(0, 32), ip: req.ip });
    if (!good) return { status: 401, error: 'Wrong username or password.' };
    // an employee account only opens the check-out station, never the control-room dashboard
    if (u.company_id && subLocked(db.prepare('SELECT sub_end FROM companies WHERE id = ?').get(u.company_id)?.sub_end)) return { status: 402, error: SUB_LOCK_MSG };
    if (u.role === 'officer') return { status: 403, error: 'This account is for taking a camera at the docking station. Ask your administrator for a dashboard account.' };
    return { user: u };
}
const newSession = (userId, ttl) => {
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions(token,user_id,exp) VALUES(?,?,?)').run(token, userId, Date.now() + ttl);
    return token;
};
// Ending a session also closes the live connections opened with it (they used to keep receiving until the page was closed).
function dropSession(token) {
    if (typeof token !== 'string' || !token) return;
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    for (const s of io.sockets.sockets.values()) if (s.data.session === token) s.disconnect(true);
}
app.post('/api/login', async (req, res) => {
    const r = await checkLogin(req);
    if (r.error) return res.status(r.status).json({ error: r.error });
    const token = newSession(r.user.id, 7 * DAY);
    res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 86400}${req.secure ? '; Secure' : ''}`);   // Secure whenever the site is reached over HTTPS
    res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
    dropSession(parseCookie(req.headers.cookie).sid);
    res.setHeader('Set-Cookie', 'sid=; Max-Age=0; Path=/');
    res.json({ ok: true });
});

const push = require('./push').createPush({ db });

// Battery of every camera (its own report, or the dock's reading) and the low-battery alert that follows from it (see battery.js).
const battery = require('./battery').create({
    db, cams, publish, toCam,
    audit: (action, id, detail) => auditlog.add(db, 'system', action, id, detail),
    notify: (alert, c) => push.notifyAlert(alert, c.name || c.cameraId, c.companyId || null),
});
// Geofencing: zones on the map, alerts for leaving / entering / missed checkpoints (see geofence.js). Alerts share the battery alerts' table and screens.
const geofence = require('./geofence').create({
    db, cams, toCam,
    audit: (action, id, detail) => auditlog.add(db, 'system', action, id, detail),
    notify: (alert, c) => push.notifyAlert(alert, c.name || c.cameraId, c.companyId || null),
    changed: (companyId) => io.to(companyId ? [`room:company_${companyId}`, 'room:admin'] : ['room:admin']).emit('geofences_changed'),
});
const needZones = (req, res, next) => (isManager(req.user) || (canWrite(req.user) && can(req.user, 'zones')) ? next() : res.status(403).json({ error: 'You are not allowed to change zones.' }));
const zoneOwner = (req) => (isStaff(req.user) ? (Number.isInteger(req.body?.companyId) ? req.body.companyId : null) : req.user.companyId);
const zoneVisible = (u, z) => (isStaff(u) ? true : z.companyId === u.companyId);
app.get('/api/geofences', needUser, (req, res) => {
    const only = isStaff(req.user) && req.query.company !== undefined ? (req.query.company === '' || req.query.company === 'none' ? null : Number(req.query.company)) : undefined;
    res.json({ zones: geofence.list({ staff: isStaff(req.user), companyId: req.user.companyId, only }), canEdit: isManager(req.user) || (canWrite(req.user) && can(req.user, 'zones')) });
});
app.get('/api/geofences/alerts', needUser, (req, res) => res.json({ alerts: geofence.history((id) => canSee(req.user, id), { days: Number(req.query.days) || 7 }) }));
app.get('/api/geofences/:id/status', needUser, (req, res) => {
    const z = geofence.get(req.params.id);
    if (!z || !zoneVisible(req.user, z)) return res.status(404).json({ error: 'Zone not found.' });
    res.json(geofence.status(z.id, (id) => canSee(req.user, id)));
});
app.post('/api/geofences', needUser, needZones, (req, res) => {
    const r = geofence.add(req.body, { username: req.user.username, companyId: zoneOwner(req) });
    r.error ? res.status(400).json({ error: r.error }) : res.status(201).json(r);
});
app.put('/api/geofences/:id', needUser, needZones, (req, res) => {
    const z = geofence.get(req.params.id);
    if (!z || !zoneVisible(req.user, z)) return res.status(404).json({ error: 'Zone not found.' });
    const r = geofence.update(z.id, req.body, { username: req.user.username });
    r.error ? res.status(r.status || 400).json({ error: r.error }) : res.json(r);
});
app.delete('/api/geofences/:id', needUser, needZones, (req, res) => {
    const z = geofence.get(req.params.id);
    if (!z || !zoneVisible(req.user, z)) return res.status(404).json({ error: 'Zone not found.' });
    res.json(geofence.remove(z.id, { username: req.user.username }));
});
app.get('/api/alerts', needUser, (req, res) => res.json({ alerts: battery.open((id) => canSee(req.user, id)), low: battery.LOW, critical: battery.CRITICAL }));
app.post('/api/alerts/:id/ack', needUser, (req, res) => (battery.ack(req.params.id, req.user.username, (id) => canSee(req.user, id)) ? res.json({ ok: true }) : res.status(404).json({ error: 'Alert not found.' })));

// ---------- Mobile apps (iOS / Android) ----------
// Public: lets the app check it can talk to this server and whether it must be updated (no data is exposed).
const MOBILE_API = 1;
app.get('/api/mobile/config', (req, res) => res.json({
    name: 'VisionGuard', api: MOBILE_API, minAppVersion: process.env.MIN_APP_VERSION || '1.0.0', maintenance: process.env.MAINTENANCE === '1',
    license: license.summary(null),
}));
app.post('/api/mobile/login', async (req, res) => {
    const r = await checkLogin(req);
    if (r.error) return res.status(r.status).json({ error: r.error });
    const ttl = 30 * DAY, token = newSession(r.user.id, ttl);
    const u = userBySession(token);
    auditlog.add(db, u.username, 'mobile_login', null);
    res.json({ token, expiresAt: Date.now() + ttl, user: { ...u, staff: isStaff(u), super: isSuper(u) } });
});
app.post('/api/mobile/logout', needUser, (req, res) => {
    const t = bearer(req.headers.authorization);
    if (t) { dropSession(t); db.prepare('DELETE FROM push_devices WHERE session = ?').run(t); }
    res.json({ ok: true });
});
// Push registration: the app hands over its FCM/APNs token so SOS alerts can reach a locked phone (see push.js).
db.exec('CREATE TABLE IF NOT EXISTS push_devices(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, platform TEXT NOT NULL, session TEXT, created INTEGER NOT NULL)');
app.post('/api/mobile/push', needUser, (req, res) => {
    const token = String(req.body?.token || ''), platform = req.body?.platform;
    if (!/^[\w:.\-]{20,4096}$/.test(token) || !['ios', 'android'].includes(platform)) return res.status(400).json({ error: 'Bad push token.' });
    db.prepare('INSERT INTO push_devices(token,user_id,platform,session,created) VALUES(?,?,?,?,?) ON CONFLICT(token) DO UPDATE SET user_id=excluded.user_id, platform=excluded.platform, session=excluded.session')
        .run(token, req.user.id, platform, bearer(req.headers.authorization), Date.now());
    res.json({ ok: true });
});
app.delete('/api/mobile/push', needUser, (req, res) => {
    db.prepare('DELETE FROM push_devices WHERE token = ? AND user_id = ?').run(String(req.body?.token || ''), req.user.id);
    res.json({ ok: true });
});
const needCompanyManager = (req, res, next) => (req.user.companyId && req.user.role === 'manager' ? next() : res.status(403).json({ error: 'Only your company\'s administrators manage users.' }));
const ownUser = (req) => db.prepare("SELECT * FROM users WHERE id = ? AND company_id = ? AND role IN ('manager','client','viewer')").get(Number(req.params.id), req.user.companyId);
const companyFeaturesRaw = (companyId) => db.prepare('SELECT features FROM companies WHERE id = ?').get(companyId)?.features ?? null;
const companyAvail = (companyId) => features.parse(companyFeaturesRaw(companyId)) || [...features.KEYS];   // the features a company has
// What an administrator ticked for a user: features only if the company has them, any action; the same as the role's default = nothing stored (NULL).
const permsToStore = (list, companyId, role) => {
    if (!Array.isArray(list)) return undefined;
    const avail = companyAvail(companyId), l = features.clean(list.filter((k) => features.ACTION_KEYS.includes(k) || avail.includes(k)));
    const dflt = features.effective({ role, companyFeatures: companyFeaturesRaw(companyId), perms: null });
    return l.length === dflt.length && l.every((k) => dflt.includes(k)) ? null : JSON.stringify(l);
};
// A user row as the administrators see it: `access` = everything the person may see and do right now.
const withAccess = ({ perms, ...u }, companyId) => ({ ...u, access: features.effective({ manager: u.role === 'manager', role: u.role, companyFeatures: companyFeaturesRaw(companyId), perms }), custom: perms != null });
app.get('/api/company/users', needUser, needCompanyManager, (req, res) => res.json({ users: db.prepare("SELECT id,username,name,role,perms,avatar_ts AS avatarTs FROM users WHERE company_id = ? AND role IN ('manager','client','viewer') ORDER BY username").all(req.user.companyId).map((u) => withAccess(u, req.user.companyId)),
    available: [...companyAvail(req.user.companyId), ...features.ACTION_KEYS], catalog: features.ALL, defaults: Object.fromEntries(['manager', 'client', 'viewer'].map((r) => [r, features.effective({ manager: r === 'manager', role: r, companyFeatures: companyFeaturesRaw(req.user.companyId) })])) }));
app.post('/api/company/users', needUser, needCompanyManager, (req, res) => {
    const username = String(req.body?.username ?? '').trim(), password = String(req.body?.password ?? ''), name = String(req.body?.name ?? '').trim().slice(0, 60) || username, role = String(req.body?.role || 'client');
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'Pick Administrator, Operator or Viewer.' });
    if (!/^[\w.-]{3,32}$/.test(username)) return res.status(400).json({ error: 'Username: 3-32 letters, numbers, . _ -' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const lic = license.allow('user'); if (!lic.ok) return res.status(402).json({ error: lic.error, code: lic.code });
    const perms = permsToStore(req.body?.perms, req.user.companyId, role) ?? null;
    try { db.prepare('INSERT INTO users(username,name,pass,role,company_id,perms) VALUES(?,?,?,?,?,?)').run(username, name, hashPassword(password), role, req.user.companyId, perms); }
    catch (e) { return res.status(409).json({ error: 'This username is already taken.' }); }
    auditlog.add(db, req.user.username, 'user_created', null, { user: name, role, company: req.user.company });
    res.json({ ok: true });
});
app.patch('/api/company/users/:id', needUser, needCompanyManager, (req, res) => {
    const u = ownUser(req); if (!u) return res.status(404).json({ error: 'User not found.' });
    const role = req.body?.role !== undefined ? String(req.body.role) : u.role;
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'Pick Administrator, Operator or Viewer.' });
    if (u.id === req.user.id && role !== 'manager') return res.status(409).json({ error: 'You cannot lower your own access.' });
    const perms = permsToStore(req.body?.perms, req.user.companyId, role), permsNew = perms === undefined ? u.perms : perms;
    db.prepare('UPDATE users SET role = ?, name = ?, perms = ? WHERE id = ?').run(role, req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 60) || u.name : u.name, permsNew, u.id);
    auditlog.add(db, req.user.username, perms !== undefined ? 'user_access_set' : 'user_role_set', null, { user: u.username, role, access: perms === undefined ? undefined : perms === null ? 'all' : JSON.parse(perms).join(',') });
    if (role !== u.role || permsNew !== u.perms) kickUsers([u.id]);   // their open pages reconnect and get the new role (a live connection used to keep the old one)
    res.json({ ok: true });
});
app.post('/api/company/users/:id/password', needUser, needCompanyManager, (req, res) => {
    const u = ownUser(req), password = String(req.body?.password ?? ''); if (!u) return res.status(404).json({ error: 'User not found.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    db.prepare('UPDATE users SET pass = ? WHERE id = ?').run(hashPassword(password), u.id); db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id); kickUsers([u.id]);
    res.json({ ok: true });
});
app.delete('/api/company/users/:id', needUser, needCompanyManager, (req, res) => {
    const u = ownUser(req); if (!u) return res.status(404).json({ error: 'User not found.' });
    if (u.id === req.user.id) return res.status(409).json({ error: 'You cannot remove yourself.' });
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id); db.prepare('DELETE FROM users WHERE id = ?').run(u.id); kickUsers([u.id]);
    auditlog.add(db, req.user.username, 'user_removed', null, { user: u.name, company: req.user.company });
    res.json({ ok: true });
});
app.get('/api/me', needUser, (req, res) => res.json({ ...req.user, featureList: features.FEATURES, staff: isStaff(req.user), super: isSuper(req.user), license: license.summary(req.user), subscription: subscriptionOf(req.user.companyId), updates: updatesMod.badge(req.user) }));

app.patch('/api/cameras/:id', needUser, needAdmin, (req, res) => {
    const id = str(req.params.id);
    if (!id || !cams.has(id)) return res.status(404).json({ error: 'Camera not found.' });
    const name = String(req.body?.name ?? '').trim().slice(0, 40) || id;
    const grp = String(req.body?.grp ?? '').trim().slice(0, 40);
    let region = cams.get(id).region || null;
    if (req.body && 'region' in req.body) {
        const r = req.body.region;
        region = r === null || r === '' ? null : String(r);
        if (region && !db.prepare('SELECT 1 FROM regions WHERE name = ?').get(region)) return res.status(400).json({ error: 'Unknown region.' });
    }
    // while an employee has the camera checked out, the employee is the holder; the name is only typed by hand when nobody has it
    const holder = checkout.openFor(id) ? (cams.get(id).holder || '') : req.body && 'holder' in req.body ? String(req.body.holder ?? '').trim().slice(0, 60) : (cams.get(id).holder || '');
    db.prepare('UPDATE cameras SET name = ?, grp = ?, region = ?, holder = ? WHERE id = ?').run(name, grp, region, holder, id);
    auditlog.add(db, req.user.username, 'camera_edited', id, { name, holder, grp, region });
    publish(id, { name, grp, region, holder });
    res.json({ ok: true });
});
app.delete('/api/cameras/:id', needUser, needAdmin, (req, res) => {
    const id = str(req.params.id);
    if (!id || !cams.has(id)) return res.status(404).json({ error: 'Camera not found.' });
    const rooms = roomsFor(id);
    auditlog.add(db, req.user.username, 'camera_removed', id, { name: cams.get(id).name });
    battery.forget(id); geofence.forget(id);
    db.prepare('DELETE FROM cameras WHERE id = ?').run(id);
    db.prepare('INSERT OR REPLACE INTO deleted_cameras(id,ts) VALUES(?,?)').run(id, Date.now());
    deleted.add(id);
    cams.delete(id); live.delete(id);
    io.to(rooms).emit('dashboard_cam_removed', { cameraId: id });
    res.json({ ok: true });
});

// Signed play URL: only users allowed to see a camera can obtain a stream signature for it.
app.get('/api/stream/:id', needUser, (req, res) => {
    const id = str(req.params.id);
    if (!id || !cams.has(id) || !canSee(req.user, id)) return res.status(404).json({ error: 'Camera not found.' });
    const exp = Math.floor(Date.now() / 1000) + 6 * 3600;
    const hash = crypto.createHash('md5').update(`/live/${id}-${exp}-${STREAM_SECRET}`).digest('hex');
    res.json({ sign: `${exp}-${hash}` });
});

// ---------- PDF report: one day, or any range of days (from - to, both included, up to 92 days) ----------
// A company downloads its own report; Smart Way staff can pick a company or take every company.
// ?from=2026-11-01&to=2026-11-07 (or the old ?date=2026-11-09 for a single day); tz = the browser's Date.getTimezoneOffset() so days are cut in the reader's own zone.
app.get('/api/report', needUser, license.gate('reports'), (req, res) => {
    const u = req.user;
    const companyId = isStaff(u) ? (req.query.company ? Number(req.query.company) : null) : u.companyId;
    if (companyId && !db.prepare('SELECT 1 FROM companies WHERE id = ?').get(companyId)) return res.status(404).json({ error: 'Company not found.' });
    const range = parseRange(req.query);
    if (range.error) return res.status(400).json({ error: range.error });
    const cameras = [...cams.values()].filter((c) => (companyId ? c.companyId === companyId : isStaff(u)));
    const label = companyId ? companyName(companyId) : 'All companies';
    const stamp = range.days > 1 ? `${range.fromStamp}_to_${range.toStamp}` : range.fromStamp;
    auditlog.add(db, u.username, 'report_downloaded', null, { from: range.fromStamp, to: range.toStamp, days: range.days, scope: label });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="VisionGuard-Report-${String(label).replace(/[^\w.-]+/g, '_')}-${stamp}.pdf"`);
    report.build(db, {
        title: range.days > 1 ? 'Operations report' : 'Daily operations report', scopeLabel: label, cameras, from: range.from, to: range.to, tz: range.tz,
        regionOf: (c) => c?.region, nameOf: (c) => (c && c.name) || c?.cameraId,
    }, res);
});

// ---------- More reports, as spreadsheets (CSV) for the Reports page; each one only holds what the user may see ----------
const csvSend = (res, name, head, rows) => {
    const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"', iso = (t) => (t ? new Date(t).toISOString() : '');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="VisionGuard-${name}.csv"`);
    res.send('\ufeff' + head.join(',') + '\n' + rows.map((r) => r.map((v) => q(typeof v === 'number' && v > 1e12 ? iso(v) : v)).join(',')).join('\n'));
};
const reportRange = (req, res) => { const r = parseRange(req.query); if (r.error) { res.status(400).json({ error: r.error }); return null; } return r; };
const reportName = (r, what) => `${what}-${r.fromStamp}${r.days > 1 ? '_to_' + r.toStamp : ''}`;
app.get('/api/reports/alarms.csv', needUser, license.gate('reports'), (req, res) => {
    const r = reportRange(req, res); if (!r) return;
    const rows = db.prepare('SELECT id,camera_id,ts,ack_by,ack_ts,lat,lng,holder,holder_no FROM alarms WHERE ts >= ? AND ts < ? ORDER BY ts').all(r.from, r.to).filter((a) => (cams.has(a.camera_id) ? canSee(req.user, a.camera_id) : isStaff(req.user)));
    auditlog.add(db, req.user.username, 'report_downloaded', null, { type: 'alarms', from: r.fromStamp, to: r.toStamp });
    csvSend(res, reportName(r, 'sos-alarms'), ['id', 'time', 'camera', 'camera_name', 'carried_by', 'employee_no', 'acknowledged_by', 'acknowledged_at', 'response_seconds', 'lat', 'lng'],
        rows.map((a) => [a.id, a.ts, a.camera_id, cams.get(a.camera_id)?.name || a.camera_id, a.holder, a.holder_no, a.ack_by, a.ack_ts, a.ack_ts ? Math.round((a.ack_ts - a.ts) / 1000) : '', a.lat, a.lng]));
});
app.get('/api/reports/fleet.csv', needUser, license.gate('reports'), (req, res) => {
    auditlog.add(db, req.user.username, 'report_downloaded', null, { type: 'fleet' });
    csvSend(res, 'fleet-now', ['camera', 'name', 'company', 'region', 'group', 'holder', 'employee_no', 'online', 'recording', 'battery_percent', 'charging', 'battery_source', 'battery_read_at', 'last_seen', 'lat', 'lng'],
        visibleCams(req.user).map((c) => [c.cameraId, c.name, c.company, c.region, c.grp, c.holder, c.holderNo, c.online ? 'yes' : 'no', c.recording ? 'yes' : 'no', c.battery ?? '', c.battery == null ? '' : c.charging ? 'yes' : 'no', c.batterySrc, c.batteryTs || '', c.ts || '', c.lat, c.lng]));
});
app.get('/api/reports/battery.csv', needUser, license.gate('reports'), (req, res) => {
    const r = reportRange(req, res); if (!r) return;
    const rows = db.prepare('SELECT * FROM alerts WHERE kind = ? AND ts >= ? AND ts < ? ORDER BY ts').all('low_battery', r.from, r.to).filter((a) => (cams.has(a.camera_id) ? canSee(req.user, a.camera_id) : isStaff(req.user)));
    auditlog.add(db, req.user.username, 'report_downloaded', null, { type: 'battery', from: r.fromStamp, to: r.toStamp });
    csvSend(res, reportName(r, 'low-battery'), ['camera', 'name', 'level', 'battery_percent_when_raised', 'raised_at', 'dismissed_by', 'cleared_at', 'cleared_by'],
        rows.map((a) => [a.camera_id, cams.get(a.camera_id)?.name || a.camera_id, a.level, a.value, a.ts, a.ack_by, a.resolved_ts, a.resolved_by]));
});
app.get('/api/reports/recordings.csv', needUser, license.gate('reports'), (req, res) => {
    const r = reportRange(req, res); if (!r) return;
    const rows = db.prepare('SELECT camera_id,filename,size,sha256,recorded_ts,uploaded_ts,dock_id FROM recordings WHERE COALESCE(recorded_ts, uploaded_ts) >= ? AND COALESCE(recorded_ts, uploaded_ts) < ? ORDER BY COALESCE(recorded_ts, uploaded_ts)').all(r.from, r.to)
        .filter((x) => (cams.has(x.camera_id) ? canSee(req.user, x.camera_id) : isStaff(req.user)));
    auditlog.add(db, req.user.username, 'report_downloaded', null, { type: 'recordings', from: r.fromStamp, to: r.toStamp });
    csvSend(res, reportName(r, 'recordings'), ['camera', 'name', 'file', 'size_bytes', 'sha256', 'recorded_at', 'in_cloud_since', 'dock'],
        rows.map((x) => [x.camera_id, cams.get(x.camera_id)?.name || x.camera_id, x.filename, x.size, x.sha256, x.recorded_ts || '', x.uploaded_ts, x.dock_id]));
});

// A phone cannot send a login header to the browser that opens a download: it asks for a short-lived link instead (one use, two minutes) and opens that.
const DL_OK = /^\/api\/(report\?|reports\/[\w-]+\.csv|assignments\/export\.csv|audit\/export\.csv)/;
const dlLinks = new Map();   // token -> { userId, path, exp }
app.post('/api/dl', needUser, (req, res) => {
    const path = String(req.body?.path || '');
    if (!DL_OK.test(path) || path.length > 400) return res.status(400).json({ error: 'Not a downloadable report.' });
    for (const [k, v] of dlLinks) if (v.exp < Date.now()) dlLinks.delete(k);
    const token = crypto.randomBytes(18).toString('hex');
    dlLinks.set(token, { userId: req.user.id, path, exp: Date.now() + 120000 });
    res.json({ url: `/api/dl/${token}` });
});
app.get('/api/dl/:token', (req, res) => {
    const l = dlLinks.get(req.params.token); dlLinks.delete(req.params.token);
    if (!l || l.exp < Date.now()) return res.status(410).send('This download link has expired. Ask for a new one in the app.');
    const tok = newSession(l.userId, 120000);
    req.headers.authorization = `Bearer ${tok}`; req.headers.cookie = ''; req.url = l.path;
    res.on('finish', () => db.prepare('DELETE FROM sessions WHERE token = ?').run(tok));
    app.handle(req, res, () => res.status(404).end());
});

// ---------- Regions (Riyadh, Jeddah, Dammam ...) ----------
app.get('/api/regions', needUser, (req, res) => res.json(db.prepare('SELECT name FROM regions ORDER BY created').all().map((r) => r.name)));

// ---------- Audit trail (tamper-evident, see auditlog.js) ----------
// Everyone sees the lines about their own cameras and their own company's users; Smart Way staff see everything.
function auditRows(u, q) {
    const where = [], args = [];
    if (q.camera) { where.push('camera_id = ?'); args.push(String(q.camera)); }
    if (q.ref) { where.push('ref = ?'); args.push(String(q.ref)); }
    if (q.user) { where.push('username = ?'); args.push(String(q.user)); }
    if (q.action) {   // one or several prefixes (comma separated): dock_file matches dock_file_copied; the underscore is a letter here, not a wildcard
        const pre = String(q.action).split(',').map((x) => x.trim()).filter(Boolean).slice(0, 8);
        if (pre.length) { where.push('(' + pre.map(() => "action LIKE ? ESCAPE '\\'").join(' OR ') + ')'); pre.forEach((x) => args.push(x.replace(/[\\%_]/g, '\\$&') + '%')); }
    }
    if (Number(q.from)) { where.push('ts >= ?'); args.push(Number(q.from)); }
    if (Number(q.to)) { where.push('ts < ?'); args.push(Number(q.to)); }
    const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 5000);
    const mates = isStaff(u) ? null : new Set(db.prepare('SELECT username FROM users WHERE company_id = ?').all(u.companyId).map((r) => r.username));
    const rows = db.prepare(`SELECT id,ts,username,action,camera_id AS cameraId,detail,ref,prev_hash AS prevHash,hash FROM audit
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...args, isStaff(u) ? limit : 20000);
    const out = [];
    for (const r of rows) {
        if (mates && !((r.cameraId && canSee(u, r.cameraId)) || mates.has(r.username))) continue;
        let detail = null; try { detail = r.detail ? JSON.parse(r.detail) : null; } catch { detail = null; }
        out.push({ ...r, detail });
        if (out.length >= limit) break;
    }
    return out;
}
app.get('/api/audit', needUser, (req, res) => res.json({ lines: auditRows(req.user, req.query) }));
app.get('/api/audit/verify', needUser, (req, res) => res.json(auditlog.verify(db)));
app.get('/api/audit/export.csv', needUser, (req, res) => {
    const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const lines = auditRows(req.user, { ...req.query, limit: 5000 });
    auditlog.add(db, req.user.username, 'audit_exported', null, { lines: lines.length });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="VisionGuard-audit.csv"');
    res.send('﻿' + 'id,time,user,action,camera,file_or_ref,detail,prev_hash,hash\n' + lines.map((r) =>
        [r.id, new Date(r.ts).toISOString(), r.username, r.action, r.cameraId, r.ref, r.detail ? JSON.stringify(r.detail) : '', r.prevHash, r.hash].map(q).join(',')).join('\n'));
});

// ---------- Analytics (scoped to the signed-in user) ----------
app.get('/api/analytics', needUser, (req, res) => {
    const u = req.user, now = Date.now();
    const list = visibleCams(u);
    const ids = new Set(list.map((c) => c.cameraId));
    const alarms = (isStaff(u)
        ? db.prepare('SELECT camera_id,ts,ack_ts FROM alarms WHERE ts > ?').all(now - 30 * DAY)
        : db.prepare(`SELECT a.camera_id,a.ts,a.ack_ts FROM alarms a JOIN cameras c ON c.id=a.camera_id
            WHERE c.company_id = ? AND a.ts > ?`).all(u.companyId, now - 30 * DAY));
    const acked = alarms.filter((a) => a.ack_ts != null);
    const avgResponse = acked.length ? Math.round(acked.reduce((s, a) => s + (a.ack_ts - a.ts), 0) / acked.length / 1000) : null;
    const days = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(now - i * DAY); d.setHours(0, 0, 0, 0);
        const from = d.getTime();
        days.push({ day: d.toLocaleDateString('en', { weekday: 'short' }), count: alarms.filter((a) => a.ts >= from && a.ts < from + DAY).length });
    }
    const groups = {};
    list.forEach((c) => { const g = c.grp || '-'; groups[g] = (groups[g] || 0) + 1; });
    // counted by the database on the (ts, camera_id) index; it used to load every point of the last day into memory on each call
    const gps = !ids.size ? 0 : isStaff(u)
        ? db.prepare('SELECT COUNT(*) n FROM positions p JOIN cameras c ON c.id = p.camera_id WHERE p.ts > ?').get(now - DAY).n
        : db.prepare('SELECT COUNT(*) n FROM positions p JOIN cameras c ON c.id = p.camera_id WHERE p.ts > ? AND c.company_id = ?').get(now - DAY, u.companyId).n;
    const out = {
        scope: { staff: isStaff(u), company: u.company || null },
        fleet: {
            total: list.length, online: list.filter((c) => c.online).length, recording: list.filter((c) => c.recording).length,
            offline: list.filter((c) => !c.online).length,
        },
        alarms: { total: alarms.length, open: alarms.filter((a) => a.ack_ts == null).length, acked: acked.length, avgResponseSec: avgResponse, days },
        groups: Object.entries(groups).map(([name, count]) => ({ name, count })),
        gpsPoints24h: gps,
    };
    if (isStaff(u)) {
        const names = new Map(db.prepare('SELECT id,name FROM companies').all().map((c) => [c.id, c.name]));
        const per = {};
        list.forEach((c) => { const n = c.companyId ? names.get(c.companyId) : 'Unassigned'; per[n || 'Unassigned'] = (per[n || 'Unassigned'] || 0) + 1; });
        out.companies = Object.entries(per).map(([name, count]) => ({ name, count }));
        out.totals = { companies: names.size, users: db.prepare('SELECT COUNT(*) n FROM users').get().n };
    }
    res.json(out);
});

const insightsFor = (u) => {
    const cameras = visibleCams(u);
    return { ...insights.build({ db, cameras, recordingsDir: path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'recordings'), staff: isStaff(u) }), shifts: checkout.summary(cameras) };
};
app.get('/api/analytics/insights', needUser, (req, res) => res.json(insightsFor(req.user)));
const aiCache = new Map(), aiLast = new Map();
app.post('/api/analytics/ai', needUser, license.gate('ai'), async (req, res) => {
    const key = isStaff(req.user) ? 'staff' : `c${req.user.companyId}`, now = Date.now();
    const hit = aiCache.get(key);
    if (hit && now - hit.at < 10 * 60000 && !req.body?.refresh) return res.json({ ...hit.v, cached: true });
    if (now - (aiLast.get(req.user.id) || 0) < 15000) return res.status(429).json({ error: 'Please wait a few seconds before asking again.' });
    aiLast.set(req.user.id, now);
    try {
        const v = { ...(await insights.aiNarrative(insightsFor(req.user))), generatedAt: now };
        aiCache.set(key, { at: now, v });
        auditlog.add(db, req.user.username, v.ai ? 'ai_analysis_generated' : 'summary_generated', null);
        res.json(v);
    } catch (e) { res.status(502).json({ error: 'The analysis could not be generated.' }); }
});

// ---------- Pictures: a profile picture for every user and a logo for every company (shown instead of the initial letter) ----------
// The browser shrinks the picture to 256 px first; the server still checks that it really is a small JPEG, PNG or WebP before keeping it.
const imageType = (b) => (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'image/png'
    : b.length > 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null);
const rawImage = express.raw({ type: () => true, limit: '300kb' });
const sendImage = (res, blob, ts) => { const b = Buffer.from(blob || []), t = imageType(b); if (!t) return res.status(404).end(); res.set({ 'content-type': t, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' }).end(b); };
const userTarget = (id) => db.prepare('SELECT id,username,company_id AS companyId,avatar,avatar_ts FROM users WHERE id = ?').get(Number(id));
const mayEditUser = (me, t) => !!t && (t.id === me.id || isSuper(me) || (me.role === 'manager' && me.companyId && t.companyId === me.companyId));
const maySeeCompany = (me, id) => isStaff(me) || me.companyId === id;
app.get('/api/avatar/user/:id', needUser, (req, res) => { const t = userTarget(req.params.id); return t && t.avatar && (t.id === req.user.id || isStaff(req.user) || t.companyId === req.user.companyId) ? sendImage(res, t.avatar) : res.status(404).end(); });
app.put('/api/avatar/user/:id', needUser, rawImage, (req, res) => {
    const t = userTarget(req.params.id); if (!mayEditUser(req.user, t)) return res.status(403).json({ error: 'You cannot change this picture.' });
    if (!Buffer.isBuffer(req.body) || !imageType(req.body)) return res.status(400).json({ error: 'Send a JPEG, PNG or WebP picture (up to 300 KB).' });
    db.prepare('UPDATE users SET avatar = ?, avatar_ts = ? WHERE id = ?').run(req.body, Date.now(), t.id); res.json({ ok: true });
});
app.delete('/api/avatar/user/:id', needUser, (req, res) => { const t = userTarget(req.params.id); if (!mayEditUser(req.user, t)) return res.status(403).json({ error: 'You cannot change this picture.' }); db.prepare('UPDATE users SET avatar = NULL, avatar_ts = NULL WHERE id = ?').run(t.id); res.json({ ok: true }); });
app.get('/api/avatar/company/:id', needUser, (req, res) => { const id = Number(req.params.id), c = maySeeCompany(req.user, id) && db.prepare('SELECT logo FROM companies WHERE id = ?').get(id); return c && c.logo ? sendImage(res, c.logo) : res.status(404).end(); });
const mayEditCompany = (me, id) => isSuper(me) || (me.role === 'manager' && me.companyId === id);
app.put('/api/avatar/company/:id', needUser, rawImage, (req, res) => {
    const id = Number(req.params.id); if (!mayEditCompany(req.user, id) || !db.prepare('SELECT 1 FROM companies WHERE id = ?').get(id)) return res.status(403).json({ error: 'You cannot change this logo.' });
    if (!Buffer.isBuffer(req.body) || !imageType(req.body)) return res.status(400).json({ error: 'Send a JPEG, PNG or WebP picture (up to 300 KB).' });
    db.prepare('UPDATE companies SET logo = ?, logo_ts = ? WHERE id = ?').run(req.body, Date.now(), id); res.json({ ok: true });
});
app.delete('/api/avatar/company/:id', needUser, (req, res) => { const id = Number(req.params.id); if (!mayEditCompany(req.user, id)) return res.status(403).json({ error: 'You cannot change this logo.' }); db.prepare('UPDATE companies SET logo = NULL, logo_ts = NULL WHERE id = ?').run(id); res.json({ ok: true }); });

// ---------- Company management (Smart Way administrators only) ----------
const adminOnly = [needUser, needAdmin];
app.get('/api/admin/companies', adminOnly, (req, res) => {
    const tokenIds = new Set(db.prepare('SELECT id FROM cameras WHERE token_hash IS NOT NULL').all().map((r) => r.id));
    const companies = db.prepare('SELECT id,name,max_cameras AS maxCameras,max_live AS maxLive,sub_end AS subEnd,features,logo_ts AS logoTs FROM companies ORDER BY name').all().map(({ features: f, ...c }) => ({
        ...c, features: companyAvail(c.id), allFeatures: f === null, subscription: subscriptionOf(c.id), camerasUsed: cameraCount(c.id), liveNow: liveCount(c.id),
        users: db.prepare('SELECT id,username,name,role,employee_no AS employeeNo,active,perms,avatar_ts AS avatarTs FROM users WHERE company_id = ? ORDER BY role = \'officer\', username').all(c.id)
            .map((u0) => withAccess(u0, c.id)).map((u) => ({ ...u, active: u.active !== 0, holding: u.role === 'officer' || u.role === 'client' ? (checkout.openOf(u.id) ? cams.get(checkout.openOf(u.id).camera_id)?.name || checkout.openOf(u.id).camera_id : null) : null })),
    }));
    const cameras = [...cams.values()].map((c) => ({ id: c.cameraId, name: c.name, companyId: c.companyId, region: c.region || null, online: c.online, hasToken: tokenIds.has(c.cameraId) }));
    const regions = db.prepare('SELECT name FROM regions ORDER BY created').all().map((r) => r.name);
    res.json({ companies, cameras, regions, packages: packages.PACKAGES, catalog: features.ALL });
});
app.post('/api/admin/regions', adminOnly, (req, res) => {
    const name = String(req.body?.name ?? '').trim().slice(0, 40);
    if (name.length < 2) return res.status(400).json({ error: 'Region name is too short.' });
    try { db.prepare('INSERT INTO regions(name,created) VALUES(?,?)').run(name, Date.now()); res.json({ ok: true }); }
    catch (e) { res.status(409).json({ error: 'This region already exists.' }); }
});
app.delete('/api/admin/regions/:name', adminOnly, (req, res) => {
    const name = String(req.params.name);
    if (!db.prepare('SELECT 1 FROM regions WHERE name = ?').get(name)) return res.status(404).json({ error: 'Region not found.' });
    db.prepare('UPDATE cameras SET region = NULL WHERE region = ?').run(name);
    db.prepare('DELETE FROM regions WHERE name = ?').run(name);
    for (const c of cams.values()) if (c.region === name) publish(c.cameraId, { region: null });
    res.json({ ok: true });
});
app.put('/api/admin/cameras/:id/region', adminOnly, (req, res) => {
    const id = str(req.params.id);
    if (!id || !cams.has(id)) return res.status(404).json({ error: 'Camera not found.' });
    const raw = req.body?.region;
    const region = raw === null || raw === '' || raw === undefined ? null : String(raw);
    if (region && !db.prepare('SELECT 1 FROM regions WHERE name = ?').get(region)) return res.status(404).json({ error: 'Region not found.' });
    db.prepare('UPDATE cameras SET region = ? WHERE id = ?').run(region, id);
    publish(id, { region });
    res.json({ ok: true });
});
app.post('/api/admin/companies', adminOnly, (req, res) => {
    const name = String(req.body?.name ?? '').trim().slice(0, 60);
    if (name.length < 2) return res.status(400).json({ error: 'Company name is too short.' });
    const lic = license.allow('company'); if (!lic.ok) return res.status(402).json({ error: lic.error, code: lic.code });
    try {
        const pkg = packages.parsePackage(req.body?.maxCameras, req.body?.maxLive);
        if (pkg.error) return res.status(400).json({ error: pkg.error });
        const r = db.prepare('INSERT INTO companies(name,created,max_cameras,max_live,features) VALUES(?,?,?,?,?)').run(name, Date.now(), pkg.maxCameras, pkg.maxLive, Array.isArray(req.body?.features) ? features.store(req.body.features) : null);
        const id = Number(r.lastInsertRowid);
        // optionally with the company's administrator account (the person who manages its users, employees and pictures)
        const au = String(req.body?.adminUsername ?? '').trim(), ap = String(req.body?.adminPassword ?? '');
        if (au) {
            if (!/^[\w.-]{3,32}$/.test(au) || ap.length < 8) { db.prepare('DELETE FROM companies WHERE id = ?').run(id); return res.status(400).json({ error: 'Administrator username: 3-32 letters, numbers, . _ -   Password: 8+ characters.' }); }
            try { db.prepare('INSERT INTO users(username,name,pass,role,company_id) VALUES(?,?,?,?,?)').run(au, name + ' Administrator', hashPassword(ap), 'manager', id); auditlog.add(db, req.user.username, 'user_created', null, { user: au, role: 'manager', company: name }); }
            catch (e) { db.prepare('DELETE FROM companies WHERE id = ?').run(id); return res.status(409).json({ error: 'This administrator username is already taken.' }); }
        }
        res.json({ ok: true, id });
    } catch (e) { res.status(409).json({ error: 'A company with this name already exists.' }); }
});
// Change a company's package (camera cap) and live-stream cap. Cannot shrink below what it already uses.
// How long a company's subscription runs: pick a number of months (added to the current end, or from today if it ended) or an exact end date.
app.put('/api/admin/companies/:id/subscription', adminOnly, (req, res) => {
    const id = Number(req.params.id), c = db.prepare('SELECT name,sub_end FROM companies WHERE id = ?').get(id);
    if (!c) return res.status(404).json({ error: 'Company not found.' });
    let end = null;
    if (req.body?.clear) end = null;
    else if (req.body?.end) { end = Date.parse(String(req.body.end) + 'T23:59:59Z'); if (!Number.isFinite(end)) return res.status(400).json({ error: 'Use a date like 2027-01-31.' }); }
    else { const m = Number(req.body?.months); if (![1, 3, 6, 12, 24, 36].includes(m)) return res.status(400).json({ error: 'Pick 1, 3, 6, 12, 24 or 36 months.' }); const base = new Date(Math.max(Date.now(), c.sub_end || 0)); base.setUTCMonth(base.getUTCMonth() + m); end = base.getTime(); }
    db.prepare('UPDATE companies SET sub_end = ? WHERE id = ?').run(end, id);
    auditlog.add(db, req.user.username, 'subscription_set', null, { company: c.name, end: end ? new Date(end).toISOString().slice(0, 10) : 'none' });
    res.json({ ok: true, subEnd: end, subscription: subscriptionOf(id) });
});
app.put('/api/admin/companies/:id/package', adminOnly, (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM companies WHERE id = ?').get(id)) return res.status(404).json({ error: 'Company not found.' });
    const pkg = packages.parsePackage(req.body?.maxCameras, req.body?.maxLive);
    if (pkg.error) return res.status(400).json({ error: pkg.error });
    if (pkg.maxCameras && cameraCount(id) > pkg.maxCameras) {
        return res.status(409).json({ error: `This company already has ${cameraCount(id)} cameras. Unassign some first or pick a bigger package.` });
    }
    db.prepare('UPDATE companies SET max_cameras = ?, max_live = ? WHERE id = ?').run(pkg.maxCameras, pkg.maxLive, id);
    auditlog.add(db, req.user.username, `package_${pkg.maxCameras || 'unlimited'}`, null);
    res.json({ ok: true });
});
// Which parts of the system a company has. Taking one away also takes it from every user of that company (their permissions are cut to what is left).
app.put('/api/admin/companies/:id/features', adminOnly, (req, res) => {
    const id = Number(req.params.id), c = db.prepare('SELECT name FROM companies WHERE id = ?').get(id);
    if (!c) return res.status(404).json({ error: 'Company not found.' });
    if (!Array.isArray(req.body?.features)) return res.status(400).json({ error: 'Send the list of features.' });
    const list = features.clean(req.body.features);
    db.prepare('UPDATE companies SET features = ? WHERE id = ?').run(list.length === features.KEYS.length ? null : JSON.stringify(list), id);
    auditlog.add(db, req.user.username, 'company_features_set', null, { company: c.name, features: list.join(',') || 'none' });
    kickUsers(db.prepare('SELECT id FROM users WHERE company_id = ?').all(id).map((r) => r.id));   // their open pages reload with the new menu
    res.json({ ok: true, features: list });
});
// What one user may see and do (Smart Way sets it for any user of any company; a company's own administrator does the same from the Team page).
app.put('/api/admin/users/:id/access', adminOnly, (req, res) => {
    const u = db.prepare("SELECT id,username,role,company_id AS companyId FROM users WHERE id = ? AND company_id IS NOT NULL AND role != 'officer'").get(Number(req.params.id));
    if (!u) return res.status(404).json({ error: 'User not found.' });
    if (u.role === 'manager') return res.status(409).json({ error: 'An administrator can use everything the company has. Make the user an Operator or a Viewer first.' });
    const perms = permsToStore(req.body?.perms, u.companyId, u.role); if (perms === undefined) return res.status(400).json({ error: 'Send the list.' });
    db.prepare('UPDATE users SET perms = ? WHERE id = ?').run(perms, u.id);
    auditlog.add(db, req.user.username, 'user_access_set', null, { user: u.username, access: perms === null ? 'default' : JSON.parse(perms).join(',') });
    kickUsers([u.id]); res.json({ ok: true });
});
function kickUsers(userIds) {
    for (const s of io.sockets.sockets.values()) if (userIds.includes(s.data.user?.id)) s.disconnect(true);
}
app.delete('/api/admin/companies/:id', adminOnly, (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM companies WHERE id = ?').get(id)) return res.status(404).json({ error: 'Company not found.' });
    for (const c of cams.values()) if (c.companyId === id) assignCamera(c.cameraId, null);
    const uids = db.prepare('SELECT id FROM users WHERE company_id = ?').all(id).map((r) => r.id);
    uids.forEach((uid) => db.prepare('DELETE FROM sessions WHERE user_id = ?').run(uid));
    db.prepare('DELETE FROM users WHERE company_id = ?').run(id);
    db.prepare('DELETE FROM companies WHERE id = ?').run(id);
    kickUsers(uids);
    res.json({ ok: true });
});
app.post('/api/admin/companies/:id/users', adminOnly, (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM companies WHERE id = ?').get(id)) return res.status(404).json({ error: 'Company not found.' });
    const username = String(req.body?.username ?? '').trim();
    const password = String(req.body?.password ?? '');
    const name = String(req.body?.name ?? '').trim().slice(0, 60) || username;
    const role = req.body?.role === 'officer' ? 'officer' : ROLES.includes(req.body?.role) ? req.body.role : 'client';   // dashboard user (manager / client / viewer) or officer = employee who takes cameras at the station
    const employeeNo = String(req.body?.employeeNo ?? '').trim().slice(0, 20) || null;
    if (!/^[\w.-]{3,32}$/.test(username)) return res.status(400).json({ error: 'Username: 3-32 letters, numbers, . _ -' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (employeeNo && !/^[\w.-]{1,20}$/.test(employeeNo)) return res.status(400).json({ error: 'Employee number: letters, numbers, . _ - (max 20).' });
    if (employeeNo && db.prepare('SELECT 1 FROM users WHERE company_id = ? AND employee_no = ?').get(id, employeeNo)) return res.status(409).json({ error: `Employee number ${employeeNo} is already used in this company.` });
    const lic = license.allow(role === 'officer' ? 'employee' : 'user'); if (!lic.ok) return res.status(402).json({ error: lic.error, code: lic.code });
    try {
        db.prepare('INSERT INTO users(username,name,pass,role,company_id,employee_no,perms) VALUES(?,?,?,?,?,?,?)')
            .run(username, name, hashPassword(password), role, id, employeeNo, role === 'officer' ? null : permsToStore(req.body?.perms, id, role) ?? null);
        auditlog.add(db, req.user.username, role === 'officer' ? 'employee_created' : 'user_created', null, { user: name, employeeNo, company: companyName(id) });
        res.json({ ok: true });
    } catch (e) { res.status(409).json({ error: 'This username is already taken.' }); }
});
const clientUser = (id) => db.prepare("SELECT id FROM users WHERE id = ? AND company_id IS NOT NULL").get(Number(id));
app.delete('/api/admin/users/:id', adminOnly, (req, res) => {
    const u = clientUser(req.params.id);
    if (!u) return res.status(404).json({ error: 'User not found.' });
    const open = checkout.openOf(u.id);
    if (open) checkout.end(open.id, `admin:${req.user.username}`, 'account removed');   // a removed employee cannot keep a camera
    const gone = db.prepare('SELECT username,name,role,employee_no AS no FROM users WHERE id = ?').get(u.id);
    auditlog.add(db, req.user.username, gone.role === 'officer' ? 'employee_removed' : 'user_removed', null, { user: gone.name, employeeNo: gone.no });
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    kickUsers([u.id]);
    res.json({ ok: true });
});
app.post('/api/admin/users/:id/password', adminOnly, (req, res) => {
    const u = clientUser(req.params.id);
    const password = String(req.body?.password ?? '');
    if (!u) return res.status(404).json({ error: 'User not found.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    db.prepare('UPDATE users SET pass = ? WHERE id = ?').run(hashPassword(password), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    kickUsers([u.id]);
    res.json({ ok: true });
});
// Issue (or rotate) a camera's own device token. The token is returned once; the old one stops working at once.
app.post('/api/admin/cameras/:id/token', adminOnly, (req, res) => {
    const id = str(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid camera id.' });
    if (!cams.has(id)) {   // pre-provision a camera that has not connected yet
        const lic = license.allow('camera'); if (!lic.ok) return res.status(402).json({ error: lic.error, code: lic.code });
        publish(id, {});
    }
    const token = deviceTokens.issueToken();
    db.prepare('UPDATE cameras SET token_hash = ? WHERE id = ?').run(deviceTokens.hashToken(token), id);
    auditlog.add(db, req.user.username, 'token_issued', id);
    // kick the camera's current connection so it must reconnect with the new token
    for (const s of io.sockets.sockets.values()) if (s.data.role === 'camera' && (s.data.authId === id || s.data.cameraId === id)) s.disconnect(true);
    res.json({ ok: true, token, config: { id, token } });
});
// Revoke a camera's device token (it can no longer connect with it).
app.delete('/api/admin/cameras/:id/token', adminOnly, (req, res) => {
    const id = str(req.params.id);
    if (!id || !cams.has(id)) return res.status(404).json({ error: 'Camera not found.' });
    db.prepare('UPDATE cameras SET token_hash = NULL WHERE id = ?').run(id);
    auditlog.add(db, req.user.username, 'token_revoked', id);
    for (const s of io.sockets.sockets.values()) if (s.data.role === 'camera' && s.data.authId === id) s.disconnect(true);
    res.json({ ok: true });
});
app.put('/api/admin/cameras/:id/company', adminOnly, (req, res) => {
    const id = str(req.params.id);
    if (!id || !cams.has(id)) return res.status(404).json({ error: 'Camera not found.' });
    const raw = req.body?.companyId;
    const companyId = raw === null || raw === '' || raw === undefined ? null : Number(raw);
    if (companyId !== null && !db.prepare('SELECT 1 FROM companies WHERE id = ?').get(companyId)) {
        return res.status(404).json({ error: 'Company not found.' });
    }
    if (companyId !== null && cams.get(id).companyId !== companyId && !packages.canAddCamera(companyLimits(companyId), cameraCount(companyId))) {
        return res.status(409).json({ error: 'This company reached its package limit. Upgrade its package first.' });
    }
    assignCamera(id, companyId);
    res.json({ ok: true });
});

// ---------- Remote app updates (OTA) ----------
// The latest camera APK lives on the server; cameras are told to download and install it.
// A build is identified by the SHA-256 of the APK file, which the camera computes from its own installed APK.
const UPD_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'updates');
const UPD_APK = path.join(UPD_DIR, 'app.apk');
const UPD_META = path.join(UPD_DIR, 'meta.json');
const readMeta = () => { try { return JSON.parse(fs.readFileSync(UPD_META, 'utf8')); } catch (e) { return null; } };
// The same, remembered for two seconds: every camera that reports in asks "what is the latest build?" and the file should not be read each time.
let metaCache = { at: 0, v: null };
const latestMeta = () => { if (Date.now() - metaCache.at > 2000) metaCache = { at: Date.now(), v: readMeta() }; return metaCache.v; };

app.put('/api/admin/update/apk', needUser, needAdmin, express.raw({ type: () => true, limit: '200mb' }), (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length < 1e6 || buf.readUInt32LE(0) !== 0x04034b50 || !buf.includes('AndroidManifest.xml')) {
        return res.status(400).json({ error: 'This does not look like an Android APK.' });
    }
    fs.mkdirSync(UPD_DIR, { recursive: true });
    const build = crypto.createHash('sha256').update(buf).digest('hex');
    fs.writeFileSync(UPD_APK + '.tmp', buf);
    fs.renameSync(UPD_APK + '.tmp', UPD_APK);
    const meta = { build, size: buf.length, uploaded: Date.now(), by: req.user.username };
    fs.writeFileSync(UPD_META, JSON.stringify(meta));
    metaCache = { at: 0, v: null };
    auditlog.add(db, req.user.username, `update_upload_${build.slice(0, 12)}`, null);
    rollout.publish(meta);   // cameras that may be updated over the network start now, carefully (see rollout.js)
    res.json({ ok: true, ...meta });
});
app.get('/api/admin/update', adminOnly, (req, res) => {
    const meta = readMeta();
    res.json({
        latest: meta ? { ...meta, short: meta.build.slice(0, 12) } : null,
        rollout: rollout.status(), notice: updatesMod.latestNotice(true), defaults: updatesMod.DEFAULT_NOTICE,
        cameras: [...cams.values()].map((c) => ({
            id: c.cameraId, name: c.name, region: c.region || null, company: companyName(c.companyId), online: !!c.online,
            recording: !!c.recording, build: c.appBuild ? c.appBuild.slice(0, 12) : null,
            current: !!(meta && c.appBuild && c.appBuild === meta.build), update: c.update || null,
            mode: c.updateMode || 'off', why: rollout.why(c), canWifi: Array.isArray(c.caps) && c.caps.includes('update-net'), battery: c.battery ?? null, charging: !!c.charging,
        })),
    });
});
// Cameras download with their shared token (header or query); Range requests are supported so a weak link can resume.
app.get('/api/update/apk', (req, res) => {
    if (!authCamera(req.headers['x-bwc-token'] || req.query.token)) return res.status(401).end();
    if (!fs.existsSync(UPD_APK)) return res.status(404).end();
    res.type('application/vnd.android.package-archive').sendFile(UPD_APK);
});

// Help & Support tickets (see support.js)
support.register(app, { db, needUser, isStaff, str, cams, canSee, companyName, mailer });
require('./license').register(app, { license, needUser, needAdmin, audit: (user, action, cam, detail) => auditlog.add(db, user, action, cam || null, detail || null) });

// Docking stations: offload recordings from cameras (see dock.js)
const dockApi = require('./dock').register(app, { db, cams, needUser, needAdmin, needWrite: needFiles, needDelete, canSee, isStaff, str, companyName, publish, setBattery: (id, b) => battery.set(id, { battery: b, src: 'dock' }) });

// Employees take a camera at the check-out station; the camera is told who carries it (see checkout.js)
const checkoutMod = require('./checkout');
const checkout = checkoutMod.create({
    db, cams, publish, dock: dockApi, companyName,
    audit: (user, action, cam, detail) => auditlog.add(db, user, action, cam || null, detail || null),
    tellCamera: (id, event, data) => io.to(`room:camera_${id}`).emit(event, data),
});
checkout.restore();
setInterval(() => { try { checkout.sweep(); } catch (e) { console.error('check-out sweep failed:', e.message); } }, 5000).unref();
// Camera updates as people see them (notices, which of a company's cameras still wait) and the careful automatic updates over the network
// for cameras that are not near a docking station (see updates.js, rollout.js)
const rollout = require('./rollout').create({
    db, cams, latest: latestMeta, docked: (t) => dockApi.docked(t),
    send: (id, payload) => {
        io.to(`room:camera_${id}`).emit('update_app', payload);
        publish(id, { update: { state: 'queued', ts: Date.now(), auto: true } });
    },
    audit: (user, action, cam, detail) => auditlog.add(db, user, action, cam || null, detail || null),
});
setInterval(() => { try { rollout.tick(); } catch (e) { console.error('update rollout failed:', e.message); } }, 30_000).unref();
const updatesLib = require('./updates');
const updatesMod = updatesLib.create({ db, cams, latest: latestMeta, rollout, docked: (t) => dockApi.docked(t) });
updatesLib.register(app, { updates: updatesMod, rollout, db, cams, needUser, adminOnly, isSuper, publish, str, audit: (user, action, cam, detail) => auditlog.add(db, user, action, cam || null, detail || null) });

checkoutMod.register(app, { db, checkout, subscriptionLocked: (cid) => !!cid && subLocked(db.prepare('SELECT sub_end FROM companies WHERE id = ?').get(cid)?.sub_end), needUser, needAdmin, needDock: dockApi.needDock, dock: dockApi, isStaff, canSee, str, hashPassword, verifyPassword, auditlog, kickUsers, companyName, cams, license });

// Live video over the dashboard's own port: the browser asks /live/<camera>.flv?sign=... here and we relay it from the media
// server's HTTP-FLV port. One port to open, works from phones and behind HTTPS (no mixed content). The media server still
// verifies the signature, so this adds no access. In production nginx can serve /live/ directly and never reaches this.
app.get(/^\/live\/([\w.-]+\.flv)$/, (req, res) => {
    const up = http.request({
        host: '127.0.0.1', port: Number(process.env.FLV_PORT) || 8000,
        path: req.originalUrl, method: 'GET', headers: { accept: '*/*' },
    }, (ur) => {
        res.writeHead(ur.statusCode || 502, { 'content-type': ur.headers['content-type'] || 'video/x-flv', 'cache-control': 'no-store' });
        ur.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.status(502).end(); else res.destroy(); });
    res.on('close', () => up.destroy());
    up.end();
});

// ---------- Pages ----------
const page = (file) => (req, res) => res.sendFile(path.join(__dirname, 'public', file));
const home = (u) => (isStaff(u) ? '/admin.html' : ['/', '/analytics.html', '/reports.html', '/docks.html', '/help.html'].find((p) => !features.PAGE_RULES[p] || can(u, features.PAGE_RULES[p])) || '/help.html');
const featPage = (file) => (req, res) => { const f = features.PAGE_RULES[req.path]; return f && !can(req.user, f) ? res.redirect(home(req.user)) : page(file)(req, res); };
app.get(['/', '/index.html'], needUser, featPage('index.html'));
app.get('/analytics.html', needUser, featPage('analytics.html'));
app.get('/docks.html', needUser, featPage('docks.html'));
app.get('/help.html', needUser, page('help.html'));
app.get('/reports.html', needUser, featPage('reports.html'));
app.get('/employees.html', needUser, (req, res) => (req.user.companyId && req.user.role === 'manager' ? page('employees.html')(req, res) : res.redirect(isStaff(req.user) ? '/admin.html' : '/analytics.html')));
app.get('/license.html', needUser, (req, res) => (isSuper(req.user) ? page('license.html')(req, res) : res.redirect('/analytics.html')));
app.get('/station.html', page('station.html'));   // the check-out station: public page, employees sign in on it
app.get('/wall.html', needUser, featPage('wall.html'));
app.get('/updates.html', needUser, page('updates.html'));   // everybody: what is new and which cameras wait; the super administrator's tools are on the same page
app.get('/admin.html', needUser, (req, res, next) => (isSuper(req.user) ? page('admin.html')(req, res) : res.redirect('/analytics.html')));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
// Whatever a route throws ends here: a short JSON answer, the details only in the server log (never a stack trace to the caller).
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = Number(err.status || err.statusCode);
    if (status >= 400 && status < 500) return res.status(status).json({ error: status === 413 ? 'Request too large.' : 'Bad request.' });
    console.error(`${req.method} ${req.path} failed:`, err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
});

// ---------- Sockets ----------
const socketRefusedAt = new Map();
// The session can arrive as the sid cookie, the socket.io auth payload, an Authorization bearer header or a query parameter:
// some networks and proxies drop one of them, so any valid one is enough. -> { u: the user, t: the session it came with }
const sessionOf = (h) => {
    for (const t of [parseCookie(h.headers.cookie).sid, h.auth?.session, bearer(h.headers.authorization), h.query?.session]) {
        const u = typeof t === 'string' ? userBySession(t) : null;
        if (u) return { u, t };
    }
    return null;
};
io.use((socket, next) => { try { socketAuth(socket, next); } catch (e) { console.error('socket handshake failed:', e); next(new Error('unauthorized')); } });   // nothing a client sends in a handshake may throw past this line
function socketAuth(socket, next) {
    const cam = authCamera(socket.handshake.auth?.token);
    if (cam) { socket.data.role = 'camera'; socket.data.authId = cam.id || null; return next(); }
    const h = socket.handshake;
    const s = sessionOf(h), u = s?.u;
    if (u) { if (license.locked()) return next(new Error('license')); socket.data.role = 'dashboard'; socket.data.user = u; socket.data.session = s.t; return next(); }   // a locked licence keeps cameras and docks delivering but closes the dashboards
    const now = Date.now();
    if (now - (socketRefusedAt.get(h.address) || 0) > 10000) {   // what the refused client sent (never the secret itself), so the cause can be read from the log
        socketRefusedAt.set(h.address, now);
        console.warn(`socket refused from ${h.address}: auth.session=${typeof h.auth?.session}(${String(h.auth?.session || '').length}) cookie=${!!h.headers.cookie} bearer=${!!h.headers.authorization} query=${!!h.query?.session} transport=${h.query?.transport} ua=${String(h.headers['user-agent'] || '').slice(0, 50)}`);
    }
    next(new Error('unauthorized'));
}
// A live connection lives only as long as its session: expiry, a deactivated account, a locked subscription or a changed role closes it
// within SESSION_SWEEP_MS (the page reconnects and is then refused or gets its new rights).
const SESSION_SWEEP_MS = Number(process.env.SESSION_SWEEP_MS) || 30000;
setInterval(guard('session sweep', () => {
    for (const s of io.sockets.sockets.values()) {
        if (s.data.role !== 'dashboard') continue;
        const u = userBySession(s.data.session);
        if (!u || u.role !== s.data.user.role || u.companyId !== s.data.user.companyId) s.disconnect(true);
    }
}), SESSION_SWEEP_MS).unref();
// Events per connection: 120 at once, then 20 a second (a camera sends a handful a minute). What is over the limit is dropped; an SOS is never dropped.
// Voice messages (up to 12 MB each) have their own, much smaller allowance.
const eventRate = tokenBucket({ capacity: Number(process.env.SOCKET_BURST) || 120, refillPerSec: Number(process.env.SOCKET_RATE) || 20 });
const voiceRate = tokenBucket({ capacity: 5, refillPerSec: 0.5 });
const rateWarned = new Map();
setInterval(() => { eventRate.prune(); voiceRate.prune(); rateWarned.clear(); }, 600000).unref();
// One emergency = one alarm: repeats from the same camera inside this window (stuck button, retry after a weak link) are the same SOS.
const SOS_COALESCE_MS = process.env.SOS_COALESCE_MS === undefined ? 3000 : Math.max(0, Number(process.env.SOS_COALESCE_MS) || 0);
const lastSos = new Map();

io.on('connection', (socket) => {
    console.log(`${socket.data.role} connected:`, socket.id);

    const isDash = socket.data.role === 'dashboard';
    // every handler below is registered through this: whatever it throws is logged and that one event is lost, not the server
    const on = (event, fn) => socket.on(event, guard(`socket ${event}`, fn));
    const rateKey = socket.data.authId ? `cam:${socket.data.authId}` : socket.id;   // a camera with its own token keeps its allowance across reconnects
    socket.use((packet, next) => {
        const [event, body] = packet;
        if (event === 'camera_sos') return next();
        const voice = event === 'send_message' && body && typeof body.audio === 'string' && body.audio.length > 1000;
        if (eventRate.take(rateKey) && (!voice || voiceRate.take(rateKey))) return next();
        if (!rateWarned.has(rateKey)) { rateWarned.set(rateKey, 1); console.warn(`${socket.data.role} ${socket.data.authId || socket.data.cameraId || socket.data.user?.username || socket.id} sends too fast: events are being dropped`); }
        // dropped: next() is not called
    });
    // A camera with its own token may only speak for itself: drop any event naming another camera.
    if (!isDash && socket.data.authId) {
        socket.use((packet, next) => {
            const named = packet[1] && typeof packet[1] === 'object' ? packet[1].cameraId : undefined;
            if (named !== undefined && named !== socket.data.authId) {
                console.warn(`camera ${socket.data.authId} tried to act as ${String(named).slice(0, 40)}: dropped`);
                return;   // dropped: next() is not called
            }
            next();
        });
    }
    const user = socket.data.user;
    socket.join('room:public'); // staff broadcasts reach everyone
    if (isDash) {
        if (isStaff(user)) { socket.join('room:admin'); socket.join('room:public_0'); }
        else { socket.join(`room:company_${user.companyId}`); socket.join(`room:public_${user.companyId}`); }
    }

    // --- Chat ---
    on('create_group', (data) => {
        if (!isDash) return;
        const { groupId, cameraIds } = data || {};
        if (!str(groupId) || !Array.isArray(cameraIds)) return;
        cameraIds.filter((camId) => str(camId) && canSee(user, camId)).forEach((camId) => {
            const sid = live.get(camId);
            const target = sid && io.sockets.sockets.get(sid);
            if (target) target.join(`room:group_${user.companyId || 0}:${groupId}`);
        });
        socket.join(`room:group_${user.companyId || 0}:${groupId}`);   // the company is part of the room: two companies using the same group name never meet
    });

    on('send_message', (payload) => {
        if (isDash && (!canWrite(user) || !can(user, 'talk'))) return;
        if (!payload || !['PUBLIC', 'PRIVATE', 'GROUP'].includes(payload.chatType)) return;
        const senderId = isDash ? 'ADMIN' : (socket.data.cameraId || 'UNKNOWN');
        const senderName = isDash ? (user.name || 'Admin') : senderId;
        const msg = {
            chatType: payload.chatType,
            targetId: String(payload.targetId ?? '').slice(0, 64),
            message: String(payload.message ?? '').slice(0, 2000),
            senderId, senderName, timestamp: Date.now(),
        };
        if (typeof payload.audio === 'string' && payload.audio.startsWith('data:audio/') && payload.audio.length < 12e6) msg.audio = payload.audio;

        // company of the sender: dashboard user's company or the camera's assigned company (0 = Smart Way / none)
        const scope = isDash ? (user.companyId || 0) : (cams.get(socket.data.cameraId)?.companyId || 0);
        const msgKind = msg.audio ? 'voice' : 'msg';
        if (!isDash && socket.data.cameraId && cams.has(socket.data.cameraId)) logEvent(socket.data.cameraId, msgKind, msg.chatType);
        if (msg.chatType === 'PUBLIC') {
            if (isDash && isStaff(user)) io.to('room:public').emit('receive_message', msg);
            else io.to(['room:admin', `room:public_${scope}`]).emit('receive_message', msg);
        } else if (msg.chatType === 'PRIVATE') {
            const camId = isDash ? msg.targetId : (socket.data.cameraId || socket.data.authId || str(payload.targetId)); // a camera can only talk in its own thread (its token's camera, when it has its own token)
            if (!camId || !cams.has(camId) || (isDash && !canSee(user, camId))) return;
            if (!isDash && !socket.data.cameraId) { bind(camId); msg.senderId = msg.senderName = camId; }
            msg.targetId = camId;
            if (isDash) logEvent(camId, msgKind, 'PRIVATE');
            io.to([`room:camera_${camId}`, ...roomsFor(camId)]).emit('receive_message', msg);
        } else {   // a group the sender is in (rooms are room:group_<company>:<name>)
            const rooms = [...socket.rooms].filter((r) => r.startsWith('room:group_') && r.slice(r.indexOf(':', 11) + 1) === msg.targetId);
            if (rooms.length) io.to(rooms).emit('receive_message', msg);
        }
    });

    if (isDash) {
        socket.emit('dashboard_snapshot', { cams: visibleCams(user), alarms: recentAlarms(user), alerts: battery.open((id) => canSee(user, id)) });
        on('ack_alert', (id) => {
            if (!canWrite(user) || !can(user, 'ack')) return; battery.ack(id, user.username, (camId) => canSee(user, camId)); });
        // Control room starts/stops a camera's live stream without the officer doing anything (like PTT, but remote).
        on('remote_stream', (d) => {
            if (!can(user, 'stream')) return;
            const id = str(d?.cameraId), action = d?.action;
            if (!id || !['start', 'stop'].includes(action) || !canSee(user, id)) return;
            const c = cams.get(id);
            if (!c?.online) return socket.emit('remote_stream_result', { cameraId: id, ok: false, reason: 'offline' });
            // A recording the officer started is never cut by accident. It ends only when somebody asks for exactly that (recording: true), may do it,
            // the camera can obey (it reports 'remote-stop') and no SOS of that camera is still waiting for an answer.
            const endRec = action === 'stop' && !c.remote && d?.recording === true;
            if (action === 'stop' && !c.remote && !endRec) return;
            if (endRec) {
                const refuse = (reason) => socket.emit('remote_stream_result', { cameraId: id, ok: false, reason, action });
                if (!canWrite(user) || !can(user, 'stoprec')) return refuse('not_allowed');
                if (!c.recording) return refuse('not_recording');
                if (!Array.isArray(c.caps) || !c.caps.includes('remote-stop')) return refuse('needs_update');
                if (sosOpen(id)) return refuse('sos_open');
            }
            // Package live cap: refuse a NEW live stream beyond the company's limit (officer-started SOS/recording is never blocked).
            if (action === 'start' && !c.recording && !c.remote && c.companyId && !packages.canGoLive(companyLimits(c.companyId), liveCount(c.companyId))) {
                return socket.emit('remote_stream_result', { cameraId: id, ok: false, reason: 'live_limit' });
            }
            if (action === 'start' && !c.recording && !c.remote && !license.allow('live').ok) return socket.emit('remote_stream_result', { cameraId: id, ok: false, reason: 'live_limit' });   // the installation's licensed number of live streams
            auditlog.add(db, user.username, endRec ? 'remote_record_stop' : `remote_stream_${action}`, id);
            io.to(`room:camera_${id}`).emit('remote_stream', endRec ? { action, force: true } : { action });
            if (action === 'start') publish(id, { remote: true });
            socket.emit('remote_stream_result', { cameraId: id, ok: true, action, ...(endRec ? { recording: true } : {}) });
        });
        // Super admin tells cameras to download and install the latest APK.
        on('update_cameras', (d) => {
            if (!isSuper(user)) return;
            const meta = readMeta();
            if (!meta || !Array.isArray(d?.cameraIds)) return;
            let sent = 0;
            for (const id of d.cameraIds.slice(0, 500)) {
                const c = str(id) && cams.get(id);
                if (!c || !c.online) continue;
                auditlog.add(db, user.username, `update_app_${meta.build.slice(0, 12)}`, id);
                io.to(`room:camera_${id}`).emit('update_app', { build: meta.build, size: meta.size, force: !!d.force });
                publish(id, { update: { state: 'queued', ts: Date.now() } });
                sent++;
            }
            socket.emit('update_result', { sent });
        });
        // Control room changes a camera's video quality (e.g. weak network -> 480p).
        on('set_quality', (d) => {
            if (!canWrite(user) || !can(user, 'quality')) return;
            const id = str(d?.cameraId), quality = d?.quality;
            if (!id || !['auto', '480p', '720p', '1080p'].includes(quality) || !canSee(user, id) || !cams.get(id)?.online) return;   // 240p/4k removed: not worth the failures
            auditlog.add(db, user.username, `set_quality_${quality}`, id);
            io.to(`room:camera_${id}`).emit('set_quality', { quality });
        });
        on('ack_alarm', (id) => {
            if (!canWrite(user) || !can(user, 'ack')) return;
            id = Number(id);
            if (!Number.isInteger(id)) return;
            const a = db.prepare('SELECT camera_id FROM alarms WHERE id = ?').get(id);
            if (!a || !canSee(user, a.camera_id)) return;
            db.prepare('UPDATE alarms SET ack_by=?, ack_ts=? WHERE id=? AND ack_ts IS NULL')
                .run(user.username, Date.now(), id);
            toCam(a.camera_id, 'dashboard_alarm_ack', { id });
        });
        return;
    }

    const bind = (id) => {
        socket.data.cameraId = id;
        live.set(id, socket.id);
        socket.join(`room:camera_${id}`);
        socket.join(`room:public_${cams.get(id)?.companyId || 0}`);
        if (socket.data.assignFor !== id) { socket.data.assignFor = id; socket.emit('assignment', checkout.payload(id)); }   // who carries this camera now (the camera stamps it on the picture)
    };
    on('get_assignment', () => { if (socket.data.cameraId) socket.emit('assignment', checkout.payload(socket.data.cameraId)); });

    on('camera_gps_update', (d) => {
        const id = str(d?.cameraId);
        const lat = num(d?.lat, -90, 90);
        const lng = num(d?.lng, -180, 180);
        if (!id || lat === null || lng === null) return;
        if (deleted.has(id)) return; // removed from the dashboard: stays hidden until it records / SOS / PTT
        if (lat === 0 && lng === 0) return;
        bind(id);
        const now = Date.now();
        // accuracy (metres) and the time of the fix: a poor or old fix never replaces the camera's position
        const acc = Number.isFinite(d?.acc) && d.acc > 0 && d.acc < 100000 ? Math.round(d.acc * 10) / 10 : null;
        const fixTs = Number.isFinite(d?.fixTs) && d.fixTs > now - 3600000 && d.fixTs <= now + 60000 ? d.fixTs : now;
        if (acc !== null && acc > 100) { publish(id, { online: true }); return; }
        if (now - (lastPos.get(id) || 0) >= 5000) { // keep a trail, one point per 5 s
            db.prepare('INSERT INTO positions(camera_id,lat,lng,ts,acc) VALUES(?,?,?,?,?)').run(id, lat, lng, now, acc);
            lastPos.set(id, now);
        }
        publish(id, { lat, lng, acc, fixTs, online: true, ts: now, posSrc: null });
        geofence.position(id, lat, lng, { acc, ts: now, fixTs: Number.isFinite(d?.fixTs) ? fixTs : null });   // fixTs: only a fix the camera really made counts, not its repeats
        if (d.battery !== undefined) battery.set(id, { battery: d.battery, charging: d.charging });
    });

    // The camera's own battery: { cameraId, battery: 0-100, charging: bool }. Sent whenever it changes by a point or two and at least every few minutes.
    on('camera_battery', (d) => {
        const id = str(d?.cameraId);
        if (!id || deleted.has(id)) return;
        bind(id);
        if (!cams.has(id)) publish(id, { online: true });
        battery.set(id, { battery: d.battery, charging: d.charging });
    });

    on('camera_status', (d) => {
        const id = str(d?.cameraId);
        if (!id) return;
        if (deleted.has(id)) { if (!d.recording) return; revive(id); } // starting a recording brings it back
        bind(id);
        // the camera is back after an update and reports the latest build: the update is finished
        const upd = cams.get(id)?.update;
        if (upd && ['installing', 'queued', 'waiting', 'waiting_wifi', 'waiting_battery', 'downloading'].includes(upd.state) && typeof d.build === 'string' && d.build === latestMeta()?.build) {
            publish(id, { update: { state: 'done', ts: Date.now() } });
        }
        const build = typeof d.build === 'string' && /^[0-9a-f]{64}$/.test(d.build) ? d.build : null;
        publish(id, { recording: !!d.recording, online: true, ...(build ? { appBuild: build, ...(build !== cams.get(id)?.appBuild ? { buildTs: Date.now() } : {}) } : {}),
            ...(Array.isArray(d.caps) ? { caps: d.caps.filter((x) => typeof x === 'string' && x.length <= 24).slice(0, 8) } : {}),...(['240p', '480p', '720p', '1080p', '4k'].includes(d.quality) ? { quality: d.quality } : {}), ...(typeof d.qualityAuto === 'boolean' ? { qualityAuto: d.qualityAuto } : {}), ...(d.recording ? (typeof d.remote === 'boolean' ? { remote: d.remote } : {}) : { remote: false }) });
        if (d.battery !== undefined) battery.set(id, { battery: d.battery, charging: d.charging });
        rollout.seen(id);   // a camera that may be updated over the network is asked the moment it is its turn
    });

    // Progress of a remote update: queued / downloading (pct) / installing / waiting (recording, wifi, battery) / failed (error) / done
    on('camera_update', (d) => {
        const id = str(d?.cameraId);
        if (!id || deleted.has(id) || !['downloading', 'installing', 'waiting', 'waiting_wifi', 'waiting_battery', 'failed', 'done'].includes(d.state)) return;
        bind(id);
        publish(id, { update: { state: d.state, pct: Math.min(100, Math.max(0, Number(d.pct) || 0)), error: d.error ? String(d.error).slice(0, 160) : undefined, ts: Date.now() } });
        rollout.progress(id, d.state, d.error);
    });

    on('camera_ptt', (d) => {
        const id = str(d?.cameraId);
        if (!id) return;
        if (deleted.has(id)) { if (!d.active) return; revive(id); }
        bind(id);
        publish(id, { ptt: !!d.active, online: true });
    });

    on('camera_sos', (d) => {
        const id = str(d?.cameraId);
        if (!id) return;
        revive(id); // an SOS always brings the camera back
        bind(id);
        if (!cams.has(id)) publish(id, { online: true });
        const lat = num(d.lat, -90, 90), lng = num(d.lng, -180, 180), ts = Date.now();
        if (ts - (lastSos.get(id) || 0) < SOS_COALESCE_MS) return;   // the same emergency, sent again
        lastSos.set(id, ts);
        const carrier = cams.get(id);   // who carried the camera when the SOS was pressed (kept with the alarm for good)
        const r = db.prepare('INSERT INTO alarms(camera_id,lat,lng,ts,holder,holder_no) VALUES(?,?,?,?,?,?)').run(id, lat, lng, ts, carrier?.holder || null, carrier?.holderNo || null);
        const alarm = { id: Number(r.lastInsertRowid), cameraId: id, lat, lng, ts, ack: false, holder: carrier?.holder || null, holderNo: carrier?.holderNo || null };
        toCam(id, 'dashboard_sos', alarm);
        push.notifyAlarm(alarm, cams.get(id)?.companyId || null); // locked phones: no-op until FCM_SERVICE_ACCOUNT is set
    });

    on('disconnect', () => {
        if (!socket.data.authId) { eventRate.drop(socket.id); voiceRate.drop(socket.id); }
        const id = socket.data.cameraId;
        if (id && live.get(id) === socket.id) { // ignore a socket already replaced by a reconnect
            live.delete(id);
            if (cams.has(id)) publish(id, { online: false, recording: false, ptt: false });
        }
    });
});

const PORT = Number(process.env.PORT) || 3000;
// Docking uploads are recordings of 100 MB to a few GB over a shared uplink: Node's default 5 minute request limit cut them off (HTTP 408).
// Headers must still arrive quickly; the body may take up to 3 hours (only the authenticated dock endpoint accepts large bodies).
server.requestTimeout = 3 * 60 * 60 * 1000;
server.headersTimeout = 60 * 1000;
server.listen(PORT, () => console.log(`Central Dashboard is running on: http://localhost:${PORT}`));

// RTMP media server. Stream key = cameraId, e.g. rtmp://HOST:1935/live/BWC-01
// Playing needs a signed URL from /api/stream/:id (publishing stays open for the cameras).
const nms = new NodeMediaServer({
    rtmp: { port: Number(process.env.RTMP_PORT) || 1935, chunk_size: 60000, gop_cache: true, ping: 10, ping_timeout: 20 },
    http: { port: Number(process.env.FLV_PORT) || 8000, allow_origin: '*' },
    auth: { play: true, publish: false, secret: STREAM_SECRET },
});
// When a camera (re)starts its stream (quality / camera switch / restart) tell the dashboards, so an open
// live tile reconnects by itself instead of staying frozen until it is closed and opened again.
nms.on('postPublish', (sid, streamPath) => {
    const id = String(streamPath || '').split('/').pop();
    if (id) toCam(id, 'stream_up', { cameraId: id, ts: Date.now() });
});
nms.run();

// SIGTERM (every deploy, every "docker stop"): stop taking connections, tell cameras and dashboards, close the database, exit 0.
// An error nobody caught is logged and the server keeps serving; five of them in a minute end the process so Docker starts a clean one.
processGuards({
    close: async () => {
        await new Promise((res) => { io.close(() => res()); server.closeAllConnections(); setTimeout(res, 3000).unref(); });
        try { await nms.stop(); } catch (e) { /* the media server may already be down */ }
        db.close();
    },
});
