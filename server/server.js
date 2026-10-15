const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const NodeMediaServer = require('node-media-server');
const { db, hashPassword, verifyPassword } = require('./db');

// Cameras present this shared token for now (per-device tokens come later).
const CAMERA_TOKEN = process.env.BWC_TOKEN || 'change-me';
if (CAMERA_TOKEN === 'change-me') console.warn('WARNING: BWC_TOKEN is not set. Using the insecure default.');
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
db.prepare('DELETE FROM positions WHERE ts < ?').run(Date.now() - 30 * DAY);
db.prepare('DELETE FROM sessions WHERE exp < ?').run(Date.now());

// ---------- Helpers ----------
const str = (v) => (typeof v === 'string' && /^[\w.-]{1,32}$/.test(v) ? v : null);
const num = (v, min, max) => (Number.isFinite(v) && v >= min && v <= max ? v : null);
const parseCookie = (h = '') => Object.fromEntries(
    h.split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((p) => p[0]));
const userFromCookie = (header) => {
    const t = parseCookie(header).sid;
    if (!t) return null;
    return db.prepare(`SELECT u.id,u.username,u.name,u.role,u.company_id AS companyId,c.name AS company
        FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN companies c ON c.id = u.company_id
        WHERE s.token = ? AND s.exp > ?`).get(t, Date.now()) || null;
};
// Smart Way staff have no company and see every camera; company users only see their own.
const isStaff = (u) => !u.companyId;
const isSuper = (u) => u.role === 'admin' && !u.companyId;

// ---------- Camera registry (database + live state) ----------
const cams = new Map();  // cameraId -> state sent to dashboards
const live = new Map();  // cameraId -> socket.id currently owning it
const lastPos = new Map();
for (const r of db.prepare('SELECT * FROM cameras').all()) {
    const p = db.prepare('SELECT lat,lng,ts FROM positions WHERE camera_id=? ORDER BY ts DESC LIMIT 1').get(r.id);
    cams.set(r.id, {
        cameraId: r.id, name: r.name || r.id, grp: r.grp || '', online: false, recording: false,
        lat: p ? p.lat : null, lng: p ? p.lng : null, ts: p ? p.ts : 0, companyId: r.company_id || null, region: r.region || null,
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

function publish(id, patch) {
    if (!cams.has(id)) {
        db.prepare('INSERT OR IGNORE INTO cameras(id,name,grp,created) VALUES(?,?,?,?)').run(id, id, '', Date.now());
    }
    const state = {
        cameraId: id, name: id, grp: '', online: false, recording: false, lat: null, lng: null, ts: 0, companyId: null,
        ...cams.get(id), ...patch,
    };
    cams.set(id, state);
    toCam(id, 'dashboard_cam', decorate(state));
}
const alarmRow = (r) => ({ id: r.id, cameraId: r.camera_id, lat: r.lat, lng: r.lng, ts: r.ts, ack: r.ack_ts != null });
const recentAlarms = (u) => (isStaff(u)
    ? db.prepare('SELECT id,camera_id,lat,lng,ts,ack_ts FROM alarms ORDER BY id DESC LIMIT 100').all()
    : db.prepare(`SELECT a.id,a.camera_id,a.lat,a.lng,a.ts,a.ack_ts FROM alarms a
        JOIN cameras c ON c.id = a.camera_id WHERE c.company_id = ? ORDER BY a.id DESC LIMIT 100`).all(u.companyId)
).map(alarmRow);

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
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 15e6 }); // voice notes travel as Base64 (default cap is 1 MB)
app.use(express.json());

const needUser = (req, res, next) => {
    req.user = userFromCookie(req.headers.cookie);
    if (req.user) return next();
    if (req.path.startsWith('/api')) return res.status(401).json({ error: 'Sign in required.' });
    res.redirect('/login.html');
};
const needAdmin = (req, res, next) =>
    isSuper(req.user) ? next() : res.status(403).json({ error: 'Admins only.' });

const fails = new Map();
app.post('/api/login', (req, res) => {
    const f = fails.get(req.ip) || { n: 0, t: 0 };
    if (Date.now() - f.t >= 5 * 60000) f.n = 0;
    if (f.n >= 5) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    const { username = '', password = '' } = req.body || {};
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username));
    if (!u || !verifyPassword(String(password), u.pass)) {
        fails.set(req.ip, { n: f.n + 1, t: Date.now() });
        return res.status(401).json({ error: 'Wrong username or password.' });
    }
    fails.delete(req.ip);
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions(token,user_id,exp) VALUES(?,?,?)').run(token, u.id, Date.now() + 7 * DAY);
    res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 86400}`);
    res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
    const t = parseCookie(req.headers.cookie).sid;
    if (t) db.prepare('DELETE FROM sessions WHERE token = ?').run(t);
    res.setHeader('Set-Cookie', 'sid=; Max-Age=0; Path=/');
    res.json({ ok: true });
});
app.get('/api/me', needUser, (req, res) => res.json({ ...req.user, staff: isStaff(req.user), super: isSuper(req.user) }));

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
    db.prepare('UPDATE cameras SET name = ?, grp = ?, region = ? WHERE id = ?').run(name, grp, region, id);
    publish(id, { name, grp, region });
    res.json({ ok: true });
});
app.delete('/api/cameras/:id', needUser, needAdmin, (req, res) => {
    const id = str(req.params.id);
    if (!id || !cams.has(id)) return res.status(404).json({ error: 'Camera not found.' });
    const rooms = roomsFor(id);
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

// ---------- Regions (Riyadh, Jeddah, Dammam ...) ----------
app.get('/api/regions', needUser, (req, res) => res.json(db.prepare('SELECT name FROM regions ORDER BY created').all().map((r) => r.name)));

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
    const gps = [...ids].length
        ? db.prepare('SELECT camera_id FROM positions WHERE ts > ?').all(now - DAY).filter((p) => ids.has(p.camera_id)).length : 0;
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

// ---------- Company management (Smart Way administrators only) ----------
const adminOnly = [needUser, needAdmin];
app.get('/api/admin/companies', adminOnly, (req, res) => {
    const companies = db.prepare('SELECT id,name FROM companies ORDER BY name').all().map((c) => ({
        ...c,
        users: db.prepare('SELECT id,username,name FROM users WHERE company_id = ? ORDER BY username').all(c.id),
    }));
    const cameras = [...cams.values()].map((c) => ({ id: c.cameraId, name: c.name, companyId: c.companyId, region: c.region || null, online: c.online }));
    const regions = db.prepare('SELECT name FROM regions ORDER BY created').all().map((r) => r.name);
    res.json({ companies, cameras, regions });
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
    try {
        const r = db.prepare('INSERT INTO companies(name,created) VALUES(?,?)').run(name, Date.now());
        res.json({ ok: true, id: Number(r.lastInsertRowid) });
    } catch (e) { res.status(409).json({ error: 'A company with this name already exists.' }); }
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
    if (!/^[\w.-]{3,32}$/.test(username)) return res.status(400).json({ error: 'Username: 3-32 letters, numbers, . _ -' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    try {
        db.prepare('INSERT INTO users(username,name,pass,role,company_id) VALUES(?,?,?,?,?)')
            .run(username, name, hashPassword(password), 'client', id);
        res.json({ ok: true });
    } catch (e) { res.status(409).json({ error: 'This username is already taken.' }); }
});
const clientUser = (id) => db.prepare("SELECT id FROM users WHERE id = ? AND company_id IS NOT NULL").get(Number(id));
app.delete('/api/admin/users/:id', adminOnly, (req, res) => {
    const u = clientUser(req.params.id);
    if (!u) return res.status(404).json({ error: 'User not found.' });
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
app.put('/api/admin/cameras/:id/company', adminOnly, (req, res) => {
    const id = str(req.params.id);
    if (!id || !cams.has(id)) return res.status(404).json({ error: 'Camera not found.' });
    const raw = req.body?.companyId;
    const companyId = raw === null || raw === '' || raw === undefined ? null : Number(raw);
    if (companyId !== null && !db.prepare('SELECT 1 FROM companies WHERE id = ?').get(companyId)) {
        return res.status(404).json({ error: 'Company not found.' });
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
    db.prepare('INSERT INTO audit(ts,username,action,camera_id) VALUES(?,?,?,?)').run(Date.now(), req.user.username, `update_upload_${build.slice(0, 12)}`, null);
    res.json({ ok: true, ...meta });
});
app.get('/api/admin/update', adminOnly, (req, res) => {
    const meta = readMeta();
    res.json({
        latest: meta ? { ...meta, short: meta.build.slice(0, 12) } : null,
        cameras: [...cams.values()].map((c) => ({
            id: c.cameraId, name: c.name, region: c.region || null, company: companyName(c.companyId), online: !!c.online,
            recording: !!c.recording, build: c.appBuild ? c.appBuild.slice(0, 12) : null,
            current: !!(meta && c.appBuild && c.appBuild === meta.build), update: c.update || null,
        })),
    });
});
// Cameras download with their shared token (header or query); Range requests are supported so a weak link can resume.
app.get('/api/update/apk', (req, res) => {
    const tok = req.headers['x-bwc-token'] || req.query.token;
    if (tok !== CAMERA_TOKEN) return res.status(401).end();
    if (!fs.existsSync(UPD_APK)) return res.status(404).end();
    res.type('application/vnd.android.package-archive').sendFile(UPD_APK);
});

// ---------- Pages ----------
const page = (file) => (req, res) => res.sendFile(path.join(__dirname, 'public', file));
app.get(['/', '/index.html'], needUser, page('index.html'));
app.get('/analytics.html', needUser, page('analytics.html'));
app.get('/updates.html', needUser, (req, res) => (isSuper(req.user) ? page('updates.html')(req, res) : res.redirect('/analytics.html')));
app.get('/admin.html', needUser, (req, res, next) => (isSuper(req.user) ? page('admin.html')(req, res) : res.redirect('/analytics.html')));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ---------- Sockets ----------
io.use((socket, next) => {
    if (socket.handshake.auth?.token === CAMERA_TOKEN) { socket.data.role = 'camera'; return next(); }
    const u = userFromCookie(socket.handshake.headers.cookie);
    if (u) { socket.data.role = 'dashboard'; socket.data.user = u; return next(); }
    next(new Error('unauthorized'));
});

io.on('connection', (socket) => {
    console.log(`${socket.data.role} connected:`, socket.id);

    const isDash = socket.data.role === 'dashboard';
    const user = socket.data.user;
    socket.join('room:public'); // staff broadcasts reach everyone
    if (isDash) {
        if (isStaff(user)) { socket.join('room:admin'); socket.join('room:public_0'); }
        else { socket.join(`room:company_${user.companyId}`); socket.join(`room:public_${user.companyId}`); }
    }

    // --- Chat ---
    socket.on('create_group', (data) => {
        if (!isDash) return;
        const { groupId, cameraIds } = data || {};
        if (!str(groupId) || !Array.isArray(cameraIds)) return;
        cameraIds.filter((camId) => str(camId) && canSee(user, camId)).forEach((camId) => {
            const sid = live.get(camId);
            const target = sid && io.sockets.sockets.get(sid);
            if (target) target.join(`room:group_${groupId}`);
        });
        socket.join(`room:group_${groupId}`);
    });

    socket.on('send_message', (payload) => {
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
        if (msg.chatType === 'PUBLIC') {
            if (isDash && isStaff(user)) io.to('room:public').emit('receive_message', msg);
            else io.to(['room:admin', `room:public_${scope}`]).emit('receive_message', msg);
        } else if (msg.chatType === 'PRIVATE') {
            const camId = isDash ? msg.targetId : (socket.data.cameraId || str(payload.targetId)); // a camera can only talk in its own thread
            if (!camId || !cams.has(camId) || (isDash && !canSee(user, camId))) return;
            if (!isDash && !socket.data.cameraId) { bind(camId); msg.senderId = msg.senderName = camId; }
            msg.targetId = camId;
            io.to([`room:camera_${camId}`, ...roomsFor(camId)]).emit('receive_message', msg);
        } else if (socket.rooms.has(`room:group_${msg.targetId}`)) {
            io.to(`room:group_${msg.targetId}`).emit('receive_message', msg);
        }
    });

    if (isDash) {
        socket.emit('dashboard_snapshot', { cams: visibleCams(user), alarms: recentAlarms(user) });
        // Control room starts/stops a camera's live stream without the officer doing anything (like PTT, but remote).
        socket.on('remote_stream', (d) => {
            const id = str(d?.cameraId), action = d?.action;
            if (!id || !['start', 'stop'].includes(action) || !canSee(user, id)) return;
            const c = cams.get(id);
            if (!c?.online) return socket.emit('remote_stream_result', { cameraId: id, ok: false, reason: 'offline' });
            if (action === 'stop' && !c.remote) return; // never cut a recording the officer started
            db.prepare('INSERT INTO audit(ts,username,action,camera_id) VALUES(?,?,?,?)').run(Date.now(), user.username, `remote_stream_${action}`, id);
            io.to(`room:camera_${id}`).emit('remote_stream', { action });
            if (action === 'start') publish(id, { remote: true });
            socket.emit('remote_stream_result', { cameraId: id, ok: true, action });
        });
        // Super admin tells cameras to download and install the latest APK.
        socket.on('update_cameras', (d) => {
            if (!isSuper(user)) return;
            const meta = readMeta();
            if (!meta || !Array.isArray(d?.cameraIds)) return;
            let sent = 0;
            for (const id of d.cameraIds.slice(0, 500)) {
                const c = str(id) && cams.get(id);
                if (!c || !c.online) continue;
                db.prepare('INSERT INTO audit(ts,username,action,camera_id) VALUES(?,?,?,?)').run(Date.now(), user.username, `update_app_${meta.build.slice(0, 12)}`, id);
                io.to(`room:camera_${id}`).emit('update_app', { build: meta.build, size: meta.size, force: !!d.force });
                publish(id, { update: { state: 'queued', ts: Date.now() } });
                sent++;
            }
            socket.emit('update_result', { sent });
        });
        // Control room changes a camera's video quality (e.g. weak network -> 480p).
        socket.on('set_quality', (d) => {
            const id = str(d?.cameraId), quality = d?.quality;
            if (!id || !['240p', '480p', '720p', '1080p', '4k'].includes(quality) || !canSee(user, id) || !cams.get(id)?.online) return;
            db.prepare('INSERT INTO audit(ts,username,action,camera_id) VALUES(?,?,?,?)').run(Date.now(), user.username, `set_quality_${quality}`, id);
            io.to(`room:camera_${id}`).emit('set_quality', { quality });
        });
        socket.on('ack_alarm', (id) => {
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
    };

    socket.on('camera_gps_update', (d) => {
        const id = str(d?.cameraId);
        const lat = num(d?.lat, -90, 90);
        const lng = num(d?.lng, -180, 180);
        if (!id || lat === null || lng === null) return;
        if (deleted.has(id)) return; // removed from the dashboard: stays hidden until it records / SOS / PTT
        bind(id);
        const now = Date.now();
        if (now - (lastPos.get(id) || 0) >= 5000) { // keep a trail, one point per 5 s
            db.prepare('INSERT INTO positions(camera_id,lat,lng,ts) VALUES(?,?,?,?)').run(id, lat, lng, now);
            lastPos.set(id, now);
        }
        publish(id, { lat, lng, online: true, ts: now });
    });

    socket.on('camera_status', (d) => {
        const id = str(d?.cameraId);
        if (!id) return;
        if (deleted.has(id)) { if (!d.recording) return; revive(id); } // starting a recording brings it back
        bind(id);
        // the camera is back after an update and reports the latest build: the update is finished
        const upd = cams.get(id)?.update;
        if (upd && ['installing', 'queued', 'waiting'].includes(upd.state) && typeof d.build === 'string' && d.build === readMeta()?.build) {
            publish(id, { update: { state: 'done', ts: Date.now() } });
        }
        publish(id, { recording: !!d.recording, online: true, ...(typeof d.build === 'string' && /^[0-9a-f]{64}$/.test(d.build) ? { appBuild: d.build } : {}), ...(['240p', '480p', '720p', '1080p', '4k'].includes(d.quality) ? { quality: d.quality } : {}), ...(d.recording ? (typeof d.remote === 'boolean' ? { remote: d.remote } : {}) : { remote: false }) });
    });

    // Progress of a remote update: queued / downloading (pct) / installing / failed (error) / done
    socket.on('camera_update', (d) => {
        const id = str(d?.cameraId);
        if (!id || deleted.has(id) || !['downloading', 'installing', 'waiting', 'failed', 'done'].includes(d.state)) return;
        bind(id);
        publish(id, { update: { state: d.state, pct: Math.min(100, Math.max(0, Number(d.pct) || 0)), error: d.error ? String(d.error).slice(0, 160) : undefined, ts: Date.now() } });
    });

    socket.on('camera_ptt', (d) => {
        const id = str(d?.cameraId);
        if (!id) return;
        if (deleted.has(id)) { if (!d.active) return; revive(id); }
        bind(id);
        publish(id, { ptt: !!d.active, online: true });
    });

    socket.on('camera_sos', (d) => {
        const id = str(d?.cameraId);
        if (!id) return;
        revive(id); // an SOS always brings the camera back
        bind(id);
        if (!cams.has(id)) publish(id, { online: true });
        const lat = num(d.lat, -90, 90), lng = num(d.lng, -180, 180), ts = Date.now();
        const r = db.prepare('INSERT INTO alarms(camera_id,lat,lng,ts) VALUES(?,?,?,?)').run(id, lat, lng, ts);
        toCam(id, 'dashboard_sos', { id: Number(r.lastInsertRowid), cameraId: id, lat, lng, ts, ack: false });
    });

    socket.on('disconnect', () => {
        const id = socket.data.cameraId;
        if (id && live.get(id) === socket.id) { // ignore a socket already replaced by a reconnect
            live.delete(id);
            if (cams.has(id)) publish(id, { online: false, recording: false, ptt: false });
        }
    });
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => console.log(`Central Dashboard is running on: http://localhost:${PORT}`));

// RTMP media server. Stream key = cameraId, e.g. rtmp://HOST:1935/live/BWC-01
// Playing needs a signed URL from /api/stream/:id (publishing stays open for the cameras).
new NodeMediaServer({
    rtmp: { port: Number(process.env.RTMP_PORT) || 1935, chunk_size: 60000, gop_cache: true, ping: 10, ping_timeout: 20 },
    http: { port: Number(process.env.FLV_PORT) || 8000, allow_origin: '*' },
    auth: { play: true, publish: false, secret: STREAM_SECRET },
}).run();
