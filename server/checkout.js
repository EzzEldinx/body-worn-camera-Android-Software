// Employee check-out: every employee has a username and a password. At the check-out station next to the dock they sign in, the system picks
// a camera that is ready for them and reserves it, and the camera stamps the date and time, its own ID and the employee's ID on everything it records.
//
//   reserved   issued at the station; the camera is still seated on the dock (the reservation lapses after a few minutes if nobody takes it)
//   in_use     the camera left the dock: the employee is carrying it
//   returned   the camera is back on a dock (or someone closed the shift by hand)
//   cancelled  the reservation lapsed or was cancelled before the camera ever left the dock
//
// Who carried which camera, and when, is written to the `assignments` table and to the tamper-evident audit trail.
const crypto = require('crypto');

const DEFAULTS = { minBattery: Number(process.env.CHECKOUT_MIN_BATTERY) || 30, holdMinutes: Number(process.env.CHECKOUT_HOLD_MIN) || 10 };
const GONE_MS = 20_000;     // a reserved camera must be missing from every dock this long before we say it left (a USB hiccup must not start a shift)
const BACK_MS = 5_000;      // a camera in use must sit on a dock this long before we say it is back: docking it IS the return, nobody presses anything
const SESSION_MS = 3 * 60_000;

function create({ db, cams, publish, dock, audit, tellCamera = () => {}, now = Date.now }) {
    db.exec('CREATE TABLE IF NOT EXISTS checkout_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const getSetting = (k, d) => { const v = db.prepare('SELECT value FROM checkout_settings WHERE key = ?').get(k)?.value; return v === undefined ? d : Number(v); };
    const settings = () => ({ minBattery: getSetting('minBattery', DEFAULTS.minBattery), holdMinutes: getSetting('holdMinutes', DEFAULTS.holdMinutes) });
    function setSettings(patch) {
        const out = {};
        if (patch.minBattery !== undefined) { const v = Number(patch.minBattery); if (!Number.isFinite(v) || v < 0 || v > 100) return { error: 'The minimum battery is a percentage between 0 and 100.' }; out.minBattery = Math.round(v); }
        if (patch.holdMinutes !== undefined) { const v = Number(patch.holdMinutes); if (!Number.isFinite(v) || v < 1 || v > 120) return { error: 'The reservation time is between 1 and 120 minutes.' }; out.holdMinutes = Math.round(v); }
        for (const [k, v] of Object.entries(out)) db.prepare('INSERT INTO checkout_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
        return { settings: settings() };
    }

    const OPEN = "('reserved','in_use')";
    const openFor = (cameraId) => db.prepare(`SELECT * FROM assignments WHERE camera_id = ? AND status IN ${OPEN} ORDER BY id DESC LIMIT 1`).get(cameraId);
    const openOf = (userId) => db.prepare(`SELECT * FROM assignments WHERE user_id = ? AND status IN ${OPEN} ORDER BY id DESC LIMIT 1`).get(userId);
    const shape = (r) => r && ({
        id: r.id, cameraId: r.camera_id, cameraName: cams.get(r.camera_id)?.name || r.camera_id, userId: r.user_id, username: r.username, name: r.name, employeeNo: r.employee_no || null,
        companyId: r.company_id || null, status: r.status, issuedTs: r.issued_ts, holdUntil: r.hold_until || null, pickedTs: r.picked_ts || null, returnedTs: r.returned_ts || null,
        dockId: r.dock_id || null, slot: r.slot, batteryOut: r.battery_out, batteryIn: r.battery_in, endedBy: r.ended_by || null, note: r.note || null,
    });

    // What a camera is told: who is carrying it, so it can stamp it on the picture. serverTime lets it correct a wrong clock.
    function payload(cameraId) {
        const a = openFor(cameraId);
        return a ? { active: true, id: a.id, userId: a.user_id, username: a.username, name: a.name, employeeNo: a.employee_no || '', since: a.picked_ts || a.issued_ts, status: a.status, serverTime: now() }
            : { active: false, serverTime: now() };
    }
    // While a shift lasts the employee's name is the camera's holder. A name an administrator typed by hand is kept aside and comes back afterwards.
    const setHolder = (cameraId, a) => {
        if (a) {
            db.prepare("UPDATE cameras SET holder_prev = CASE WHEN holder_src = 'checkout' THEN holder_prev ELSE holder END, holder = ?, holder_src = 'checkout' WHERE id = ?").run(a.name, cameraId);
            publish(cameraId, { holder: a.name, holderNo: a.employee_no || '', holderUser: a.username, custody: a.status });
        } else {
            const row = db.prepare('SELECT holder, holder_src, holder_prev FROM cameras WHERE id = ?').get(cameraId) || {};
            const back = row.holder_src === 'checkout' ? (row.holder_prev || '') : (row.holder || '');
            if (row.holder_src === 'checkout') db.prepare('UPDATE cameras SET holder = ?, holder_src = NULL, holder_prev = NULL WHERE id = ?').run(back, cameraId);
            publish(cameraId, { holder: back, holderNo: '', holderUser: '', custody: null });
        }
    };
    const tell = (cameraId) => tellCamera(cameraId, 'assignment', payload(cameraId));

    // ---- which cameras can this person take right now?
    function readiness(user, t = now()) {
        const s = settings(), docked = dock.docked(t), mineId = (id) => !user.companyId || cams.get(id)?.companyId === user.companyId;
        const holding = openOf(user.id) || null;
        const last = db.prepare("SELECT camera_id FROM assignments WHERE user_id = ? AND status = 'returned' ORDER BY id DESC LIMIT 1").get(user.id)?.camera_id;
        const items = [];
        for (const [id, d] of docked) {
            if (!cams.has(id) || !mineId(id)) continue;
            const c = cams.get(id), open = openFor(id), battery = d.battery ?? c.battery ?? null;
            let reason = null, note = null;
            if (open) { reason = open.user_id === user.id ? 'yours' : 'issued'; }
            else if (d.state === 'offloading') { reason = 'copying'; note = d.progress && d.progress.total ? `copying files (${d.progress.index} of ${d.progress.total})` : 'copying files'; }
            else if (d.state === 'updating') { reason = 'updating'; note = 'updating its app'; }
            else if (d.state === 'error') { reason = 'attention'; note = d.message || 'needs attention'; }
            else if (battery !== null && battery < s.minBattery) { reason = 'charging'; note = `charging: ${battery}%, ready at ${s.minBattery}%`; }
            items.push({ cameraId: id, name: c.name || id, slot: d.slot, dockId: d.dockId, battery, online: !!c.online, ready: !reason, reason, note });
        }
        const rank = (x) => (x.cameraId === last ? 0 : 1);
        const ready = items.filter((x) => x.ready).sort((a, b) => rank(a) - rank(b) || (b.online - a.online) || ((b.battery ?? 0) - (a.battery ?? 0)) || ((a.slot ?? 99) - (b.slot ?? 99)));
        const notReady = items.filter((x) => !x.ready && x.reason !== 'yours').sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99));
        return { dockOnline: dock.anyDockOnline(t), ready, notReady, suggested: ready[0]?.cameraId || null, holding: shape(holding), minBattery: s.minBattery, holdMinutes: s.holdMinutes };
    }

    // ---- take a camera
    function issue(user, wanted, t = now()) {
        const r = readiness(user, t);
        if (!r.dockOnline) return { status: 503, error: 'The docking station is offline. Ask your supervisor.' };
        const mine = openOf(user.id);
        if (mine) {
            if (mine.status === 'reserved') return { ok: true, assignment: shape(mine), already: true };
            return { status: 409, error: `You still have ${cams.get(mine.camera_id)?.name || mine.camera_id} checked out. Put it back on the dock first.` };
        }
        const pick = wanted ? r.ready.find((x) => x.cameraId === wanted) : r.ready[0];
        if (!pick) return { status: 409, error: wanted ? 'That camera is not ready any more. Choose another one.' : 'No camera is ready right now.' };
        const id = Number(db.prepare(`INSERT INTO assignments(camera_id,user_id,username,name,employee_no,company_id,status,issued_ts,hold_until,dock_id,slot,battery_out)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(pick.cameraId, user.id, user.username, user.name || user.username, user.employeeNo || null, cams.get(pick.cameraId)?.companyId || null,
            'reserved', t, t + settings().holdMinutes * 60000, pick.dockId, pick.slot, pick.battery).lastInsertRowid);
        const row = db.prepare('SELECT * FROM assignments WHERE id = ?').get(id);
        setHolder(pick.cameraId, row); tell(pick.cameraId);
        audit(user.username, 'camera_checkout', pick.cameraId, { employee: row.name, employeeNo: row.employee_no, dock: pick.dockId, slot: pick.slot != null ? pick.slot + 1 : null, battery: pick.battery });
        return { ok: true, assignment: shape(row), holdMinutes: settings().holdMinutes };
    }

    // ---- ending a shift (all paths go through here)
    function finish(a, status, by, extra = {}) {
        const t = extra.ts ?? now();
        db.prepare('UPDATE assignments SET status = ?, returned_ts = ?, ended_by = ?, battery_in = ?, note = ? WHERE id = ?').run(status, t, by, extra.battery ?? null, extra.note ?? null, a.id);
        setHolder(a.camera_id, null); tell(a.camera_id);
        const hours = a.picked_ts ? Math.round((t - a.picked_ts) / 60000) : 0;
        audit(by.startsWith('admin:') || by.startsWith('user:') ? by.split(':')[1] : by, status === 'cancelled' ? 'checkout_cancelled' : 'camera_returned', a.camera_id,
            { employee: a.name, employeeNo: a.employee_no, endedBy: by, minutesOut: hours, batteryOut: a.battery_out, batteryIn: extra.battery ?? null, ...(extra.note ? { note: extra.note } : {}) });
    }
    const end = (id, by, note) => {
        const a = db.prepare(`SELECT * FROM assignments WHERE id = ? AND status IN ${OPEN}`).get(Number(id));
        if (!a) return false;
        finish(a, a.status === 'reserved' ? 'cancelled' : 'returned', by, { note, battery: cams.get(a.camera_id)?.battery ?? null });
        return true;
    };
    // The employee says "I'm done" at the station (the dock normally notices by itself when the camera is back).
    function giveBack(user) {
        const a = openOf(user.id);
        if (!a) return { status: 404, error: 'You have no camera checked out.' };
        finish(a, a.status === 'reserved' ? 'cancelled' : 'returned', `user:${user.username}`, { note: 'closed at the station', battery: cams.get(a.camera_id)?.battery ?? null });
        return { ok: true };
    }

    // ---- watching the dock: reserved -> in_use -> returned, and lapsed reservations
    const lastSeen = new Map(), backSince = new Map();
    function sweep(t = now()) {
        const docked = dock.docked(t), up = dock.anyDockOnline(t);
        for (const a of db.prepare(`SELECT * FROM assignments WHERE status IN ${OPEN}`).all()) {
            const d = docked.get(a.camera_id);
            if (d) lastSeen.set(a.camera_id, t);
            if (a.status === 'reserved') {
                if (up && !d && t - (lastSeen.get(a.camera_id) ?? a.issued_ts) > GONE_MS) {
                    db.prepare("UPDATE assignments SET status = 'in_use', picked_ts = ? WHERE id = ?").run(t, a.id);
                    const row = db.prepare('SELECT * FROM assignments WHERE id = ?').get(a.id);
                    setHolder(a.camera_id, row); tell(a.camera_id); backSince.delete(a.camera_id);
                    audit(a.username, 'camera_picked_up', a.camera_id, { employee: a.name, employeeNo: a.employee_no });
                } else if (t > a.hold_until && d) finish(a, 'cancelled', 'timeout', { ts: t, note: 'nobody took the camera in time', battery: d.battery ?? null });
            } else if (d && up) {
                if (!backSince.has(a.camera_id)) backSince.set(a.camera_id, t);
                if (t - backSince.get(a.camera_id) >= BACK_MS) { backSince.delete(a.camera_id); finish(a, 'returned', 'dock', { ts: t, battery: d.battery ?? null }); }
            } else backSince.delete(a.camera_id);
        }
    }

    // ---- lists and numbers for the dashboards (the caller decides which cameras a viewer may see)
    function list({ status = 'all', from, to, camera, user, limit = 200 } = {}, canSee = () => true) {
        const where = [], args = [];
        if (status === 'open') where.push(`status IN ${OPEN}`);
        if (camera) { where.push('camera_id = ?'); args.push(camera); }
        if (user) { where.push('(username = ? OR employee_no = ?)'); args.push(user, user); }
        if (Number(from)) { where.push('issued_ts >= ?'); args.push(Number(from)); }
        if (Number(to)) { where.push('issued_ts < ?'); args.push(Number(to)); }
        const rows = db.prepare(`SELECT * FROM assignments ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 5000`).all(...args);
        return rows.filter((r) => canSee(r.camera_id, r)).slice(0, Math.min(Math.max(Number(limit) || 200, 1), 5000)).map(shape);
    }
    // Cameras on duty / ready, for the Analytics gauge.
    function summary(list) {
        const ids = new Set(list.map((c) => c.cameraId));
        const open = db.prepare(`SELECT camera_id FROM assignments WHERE status IN ${OPEN}`).all().filter((r) => ids.has(r.camera_id)).length;
        const docked = dock.docked(), s = settings();
        let ready = 0;
        for (const [id, d] of docked) { if (!ids.has(id) || openFor(id) || d.state === 'offloading' || d.state === 'updating' || d.state === 'error') continue; if ((d.battery ?? cams.get(id)?.battery ?? 100) >= s.minBattery) ready++; }
        const hasEmployees = db.prepare("SELECT 1 FROM users WHERE role = 'officer' LIMIT 1").get() || db.prepare('SELECT 1 FROM assignments LIMIT 1').get();
        return hasEmployees ? { out: open, total: list.length, ready } : null;
    }
    // After a restart: every open shift puts its employee's name back on the camera.
    function restore() {
        for (const a of db.prepare(`SELECT * FROM assignments WHERE status IN ${OPEN}`).all()) if (cams.has(a.camera_id)) {
            const c = cams.get(a.camera_id); cams.set(a.camera_id, { ...c, holder: a.name, holderNo: a.employee_no || '', holderUser: a.username, custody: a.status });
        }
    }

    return { settings, setSettings, readiness, issue, giveBack, end, sweep, list, summary, restore, payload, openFor, openOf, current: (id) => shape(openFor(id)), shape };
}

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------
function register(app, ctx) {
    const { db, checkout, needUser, needAdmin, needDock, isStaff, canSee, str, hashPassword, verifyPassword, auditlog, kickUsers, companyName, cams, license, now = Date.now } = ctx;
    const stationSessions = new Map();   // token -> { userId, exp }
    const fails = new Map();             // "ip|user" and "ip" -> { n, t }
    const locked = (key, max) => { const f = fails.get(key); if (!f) return false; if (now() - f.t >= 300000) { fails.delete(key); return false; } return f.n >= max; };
    const miss = (key) => { const f = fails.get(key); fails.set(key, { n: (f && now() - f.t < 300000 ? f.n : 0) + 1, t: now() }); };
    setInterval(() => { for (const [k, v] of stationSessions) if (v.exp < now()) stationSessions.delete(k); }, 60000).unref();

    const userRow = (id) => db.prepare(`SELECT u.id,u.username,u.name,u.role,u.company_id AS companyId,u.employee_no AS employeeNo,u.active,c.name AS company
        FROM users u LEFT JOIN companies c ON c.id = u.company_id WHERE u.id = ?`).get(id);
    const bySession = (token) => {
        const s = typeof token === 'string' ? stationSessions.get(token) : null;
        if (!s || s.exp < now()) return null;
        const u = userRow(s.userId);
        if (!u || u.active === 0) return null;
        s.exp = now() + SESSION_MS;
        return u;
    };
    const view = (u) => ({ name: u.name || u.username, username: u.username, employeeNo: u.employeeNo || null, company: u.company || null });

    // The station is a public page: it only ever sees what the signed-in employee is allowed to take.
    app.get('/api/station/status', (req, res) => {
        const docked = ctx.dock.docked(), s = checkout.settings();
        let ready = 0, total = 0;
        for (const [id, d] of docked) { if (!cams.has(id)) continue; total++; if (!checkout.openFor(id) && ['connected', 'synced'].includes(d.state) && (d.battery ?? cams.get(id)?.battery ?? 100) >= s.minBattery) ready++; }
        res.json({ dockOnline: ctx.dock.anyDockOnline(), ready, docked: total });
    });
    app.post('/api/station/login', (req, res) => {
        const username = String(req.body?.username ?? '').trim().slice(0, 64), password = String(req.body?.password ?? ''), ip = req.ip;
        if (locked(`${ip}|${username.toLowerCase()}`, 5) || locked(ip, 40)) return res.status(429).json({ error: 'Too many attempts. Wait a few minutes or ask your supervisor.' });
        const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
        if (u && ctx.subscriptionLocked && ctx.subscriptionLocked(u.company_id) && verifyPassword(password, u.pass)) return res.status(402).json({ error: 'Your subscription has ended. Contact Smart Way to renew it.' });
        if (!u || u.active === 0 || !verifyPassword(password, u.pass)) { miss(`${ip}|${username.toLowerCase()}`); miss(ip); return res.status(401).json({ error: 'Wrong username or password.' }); }
        fails.delete(`${ip}|${username.toLowerCase()}`);
        const token = crypto.randomBytes(18).toString('hex');
        stationSessions.set(token, { userId: u.id, exp: now() + SESSION_MS });
        const user = userRow(u.id);
        res.json({ token, user: view(user), ...checkout.readiness(user) });
    });
    app.post('/api/station/state', (req, res) => {
        const u = bySession(req.body?.token); if (!u) return res.status(401).json({ error: 'Your session ended. Sign in again.' });
        res.json({ user: view(u), ...checkout.readiness(u) });
    });
    app.post('/api/station/issue', (req, res) => {
        const u = bySession(req.body?.token); if (!u) return res.status(401).json({ error: 'Your session ended. Sign in again.' });
        const r = checkout.issue(u, req.body?.cameraId ? String(req.body.cameraId) : null);
        if (r.error) return res.status(r.status || 400).json({ error: r.error });
        res.json({ ...r, user: view(u) });
    });
    app.post('/api/station/return', (req, res) => {
        const u = bySession(req.body?.token); if (!u) return res.status(401).json({ error: 'Your session ended. Sign in again.' });
        const r = checkout.giveBack(u);
        if (r.error) return res.status(r.status || 400).json({ error: r.error });
        res.json({ ok: true });
    });
    app.post('/api/station/logout', (req, res) => { stationSessions.delete(String(req.body?.token || '')); res.json({ ok: true }); });

    // The dock agent copies the assignment onto the camera over USB, so a camera with no network still knows who carries it.
    app.get('/api/dock/assignments', needDock, (req, res) => res.json({ assignments: checkout.list({ status: 'open' }).map((a) => ({
        id: a.id, cameraId: a.cameraId, userId: a.userId, username: a.username, name: a.name, employeeNo: a.employeeNo || '', since: a.pickedTs || a.issuedTs, status: a.status })), serverTime: now() }));

    // ---- shifts for the dashboards (a company only sees its own cameras)
    const mayManage = (u) => (isStaff(u) ? u.role === 'admin' : u.role === 'manager');
    const scope = (u) => (id) => (id && cams.has(id) ? canSee(u, id) : isStaff(u));
    app.get('/api/assignments', needUser, (req, res) => res.json({
        assignments: checkout.list({ status: req.query.status === 'open' ? 'open' : 'all', from: req.query.from, to: req.query.to, camera: req.query.camera ? String(req.query.camera) : null, user: req.query.user ? String(req.query.user) : null, limit: req.query.limit }, scope(req.user)),
        settings: checkout.settings(), canManage: mayManage(req.user),
    }));
    app.post('/api/assignments/:id/end', needUser, (req, res) => {
        if (!mayManage(req.user)) return res.status(403).json({ error: 'You cannot change check-outs.' });
        const a = db.prepare('SELECT camera_id FROM assignments WHERE id = ?').get(Number(req.params.id));
        if (!a || !scope(req.user)(a.camera_id)) return res.status(404).json({ error: 'Check-out not found.' });
        return checkout.end(req.params.id, `admin:${req.user.username}`, String(req.body?.note || '').slice(0, 120) || 'closed by a supervisor') ? res.json({ ok: true }) : res.status(409).json({ error: 'This check-out is already closed.' });
    });
    app.get('/api/assignments/export.csv', needUser, (req, res) => {
        const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"', iso = (t) => (t ? new Date(t).toISOString() : '');
        const rows = checkout.list({ status: 'all', from: req.query.from, to: req.query.to, camera: req.query.camera ? String(req.query.camera) : null, user: req.query.user ? String(req.query.user) : null, limit: 5000 }, scope(req.user));
        auditlog.add(db, req.user.username, 'checkouts_exported', null, { rows: rows.length });
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="VisionGuard-checkouts.csv"');
        res.send('﻿' + 'id,camera,employee,employee_no,username,status,issued,taken,returned,ended_by,battery_out,battery_in,note\n' + rows.map((r) =>
            [r.id, r.cameraName, r.name, r.employeeNo, r.username, r.status, iso(r.issuedTs), iso(r.pickedTs), iso(r.returnedTs), r.endedBy, r.batteryOut, r.batteryIn, r.note].map(q).join(',')).join('\n'));
    });
    app.get('/api/checkout/settings', needUser, (req, res) => res.json(checkout.settings()));
    app.put('/api/admin/checkout/settings', needUser, needAdmin, (req, res) => {
        const r = checkout.setSettings(req.body || {});
        if (r.error) return res.status(400).json({ error: r.error });
        auditlog.add(db, req.user.username, 'checkout_settings', null, r.settings);
        res.json(r.settings);
    });

    // ---- employees (Smart Way administrators create them inside a company)
    const clean = (s, n) => String(s ?? '').trim().slice(0, n);
    const validNo = (v) => !v || /^[\w.-]{1,20}$/.test(v);
    const takenNo = (companyId, no, exceptId) => !!no && !!db.prepare('SELECT 1 FROM users WHERE company_id = ? AND employee_no = ? AND id != ?').get(companyId, no, exceptId || 0);
    const makePassword = () => crypto.randomBytes(9).toString('base64url');

    app.post('/api/admin/companies/:id/employees', needUser, needAdmin, (req, res) => addEmployees(req, res, Number(req.params.id)));
    function addEmployees(req, res, id) {
        if (!db.prepare('SELECT 1 FROM companies WHERE id = ?').get(id)) return res.status(404).json({ error: 'Company not found.' });
        const list = Array.isArray(req.body?.employees) ? req.body.employees.slice(0, 500) : [];
        if (!list.length) return res.status(400).json({ error: 'Add at least one employee.' });
        const lic = license ? license.allow('employee', list.length) : { ok: true };       // the licence says how many employees this installation may have
        if (!lic.ok) return res.status(402).json({ error: lic.error, code: lic.code });
        const created = [], skipped = [];
        for (const e of list) {
            const name = clean(e.name, 60), employeeNo = clean(e.employeeNo, 20) || null;
            const username = clean(e.username, 32) || (employeeNo || '').toLowerCase();
            const password = String(e.password || '') || makePassword();
            if (!name) { skipped.push({ name: '', reason: 'no name' }); continue; }
            if (!/^[\w.-]{3,32}$/.test(username)) { skipped.push({ name, reason: 'username must be 3-32 letters, numbers, . _ -' }); continue; }
            if (!validNo(employeeNo)) { skipped.push({ name, reason: 'employee number: letters, numbers, . _ - (max 20)' }); continue; }
            if (password.length < 8) { skipped.push({ name, reason: 'password shorter than 8' }); continue; }
            if (takenNo(id, employeeNo)) { skipped.push({ name, reason: `employee number ${employeeNo} is already used` }); continue; }
            try { db.prepare('INSERT INTO users(username,name,pass,role,company_id,employee_no) VALUES(?,?,?,?,?,?)').run(username, name, hashPassword(password), 'officer', id, employeeNo); }
            catch (err) { skipped.push({ name, reason: `username ${username} is already taken` }); continue; }
            created.push({ name, username, employeeNo, password });
            auditlog.add(db, req.user.username, 'employee_created', null, { employee: name, employeeNo, company: companyName(id) });
        }
        res.json({ ok: true, created, skipped });
    }
    // Rename, change the employee number, or switch an account off / on. Switching off keeps the history and signs the person out at once.
    app.patch('/api/admin/users/:id', needUser, needAdmin, (req, res) => patchUser(req, res, db.prepare('SELECT * FROM users WHERE id = ? AND company_id IS NOT NULL').get(Number(req.params.id))));
    function patchUser(req, res, u) {
        if (!u) return res.status(404).json({ error: 'User not found.' });
        const b = req.body || {}, name = b.name !== undefined ? clean(b.name, 60) : u.name, no = b.employeeNo !== undefined ? (clean(b.employeeNo, 20) || null) : u.employee_no;
        const active = b.active !== undefined ? (b.active ? 1 : 0) : u.active;
        if (!name) return res.status(400).json({ error: 'The name cannot be empty.' });
        if (!validNo(no)) return res.status(400).json({ error: 'Employee number: letters, numbers, . _ - (max 20).' });
        if (takenNo(u.company_id, no, u.id)) return res.status(409).json({ error: `Employee number ${no} is already used in this company.` });
        db.prepare('UPDATE users SET name = ?, employee_no = ?, active = ? WHERE id = ?').run(name, no, active, u.id);
        if (!active) { db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id); kickUsers([u.id]); const open = checkout.openOf(u.id); if (open) checkout.end(open.id, `admin:${req.user.username}`, 'account switched off'); }
        if (u.active !== active) auditlog.add(db, req.user.username, active ? 'employee_enabled' : 'employee_disabled', null, { employee: name, employeeNo: no });
        else auditlog.add(db, req.user.username, 'employee_updated', null, { employee: name, employeeNo: no });
        res.json({ ok: true });
    }

    // ---- a company manages its own employees (users of that company who are not read-only); Smart Way administrators use the Companies page
    const needManager = (req, res, next) => (req.user.companyId && req.user.role === 'manager' ? next() : res.status(403).json({ error: 'Only your company\'s administrators manage employees.' }));
    const mine = (req) => db.prepare("SELECT * FROM users WHERE id = ? AND company_id = ? AND role = 'officer'").get(Number(req.params.id), req.user.companyId);
    app.get('/api/employees', needUser, needManager, (req, res) => res.json({ company: companyName(req.user.companyId), employees: db.prepare("SELECT id,username,name,employee_no AS employeeNo,active FROM users WHERE company_id = ? AND role = 'officer' ORDER BY name").all(req.user.companyId)
        .map((u) => ({ ...u, active: u.active !== 0, holding: checkout.openOf(u.id) ? cams.get(checkout.openOf(u.id).camera_id)?.name || checkout.openOf(u.id).camera_id : null })) }));
    app.post('/api/employees', needUser, needManager, (req, res) => addEmployees(req, res, req.user.companyId));
    app.patch('/api/employees/:id', needUser, needManager, (req, res) => patchUser(req, res, mine(req)));
    app.post('/api/employees/:id/password', needUser, needManager, (req, res) => {
        const u = mine(req), password = String(req.body?.password ?? '');
        if (!u) return res.status(404).json({ error: 'Employee not found.' });
        if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
        db.prepare('UPDATE users SET pass = ? WHERE id = ?').run(hashPassword(password), u.id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
        auditlog.add(db, req.user.username, 'employee_updated', null, { employee: u.name, passwordReset: true });
        res.json({ ok: true });
    });
    app.delete('/api/employees/:id', needUser, needManager, (req, res) => {
        const u = mine(req); if (!u) return res.status(404).json({ error: 'Employee not found.' });
        const open = checkout.openOf(u.id); if (open) checkout.end(open.id, `admin:${req.user.username}`, 'account removed');
        auditlog.add(db, req.user.username, 'employee_removed', null, { employee: u.name, employeeNo: u.employee_no });
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id); db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
        res.json({ ok: true });
    });
}

module.exports = { create, register, DEFAULTS };
