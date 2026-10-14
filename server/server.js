const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const NodeMediaServer = require('node-media-server');
const { db, hashPassword, verifyPassword } = require('./db');

// Cameras present this shared token for now (per-device tokens come later).
const CAMERA_TOKEN = process.env.BWC_TOKEN || 'change-me';
if (CAMERA_TOKEN === 'change-me') console.warn('WARNING: BWC_TOKEN is not set. Using the insecure default.');
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
    return db.prepare(`SELECT u.id,u.username,u.name,u.role FROM sessions s
        JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.exp > ?`).get(t, Date.now()) || null;
};

// ---------- Camera registry (database + live state) ----------
const cams = new Map();  // cameraId -> state sent to dashboards
const live = new Map();  // cameraId -> socket.id currently owning it
const lastPos = new Map();
for (const r of db.prepare('SELECT * FROM cameras').all()) {
    const p = db.prepare('SELECT lat,lng,ts FROM positions WHERE camera_id=? ORDER BY ts DESC LIMIT 1').get(r.id);
    cams.set(r.id, {
        cameraId: r.id, name: r.name || r.id, grp: r.grp || '', online: false, recording: false,
        lat: p ? p.lat : null, lng: p ? p.lng : null, ts: p ? p.ts : 0,
    });
}
function publish(id, patch) {
    if (!cams.has(id)) {
        db.prepare('INSERT OR IGNORE INTO cameras(id,name,grp,created) VALUES(?,?,?,?)').run(id, id, '', Date.now());
    }
    const state = {
        cameraId: id, name: id, grp: '', online: false, recording: false, lat: null, lng: null, ts: 0,
        ...cams.get(id), ...patch,
    };
    cams.set(id, state);
    io.emit('dashboard_cam', state);
}
const recentAlarms = () => db.prepare(
    'SELECT id,camera_id,lat,lng,ts,ack_ts FROM alarms ORDER BY id DESC LIMIT 100').all()
    .map((r) => ({ id: r.id, cameraId: r.camera_id, lat: r.lat, lng: r.lng, ts: r.ts, ack: r.ack_ts != null }));

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
    req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only.' });

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
app.get('/api/me', needUser, (req, res) => res.json(req.user));

app.patch('/api/cameras/:id', needUser, needAdmin, (req, res) => {
    const id = str(req.params.id);
    if (!id || !cams.has(id)) return res.status(404).json({ error: 'Camera not found.' });
    const name = String(req.body?.name ?? '').trim().slice(0, 40) || id;
    const grp = String(req.body?.grp ?? '').trim().slice(0, 40);
    db.prepare('UPDATE cameras SET name = ?, grp = ? WHERE id = ?').run(name, grp, id);
    publish(id, { name, grp });
    res.json({ ok: true });
});
app.delete('/api/cameras/:id', needUser, needAdmin, (req, res) => {
    const id = str(req.params.id);
    if (!id || !cams.has(id)) return res.status(404).json({ error: 'Camera not found.' });
    db.prepare('DELETE FROM cameras WHERE id = ?').run(id);
    cams.delete(id); live.delete(id);
    io.emit('dashboard_cam_removed', { cameraId: id });
    res.json({ ok: true });
});

app.get(['/', '/index.html'], needUser, (req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'index.html')));
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


    // --- ضيف السطور دي في بداية io.on('connection') ---
    socket.join('room:public');
    if (socket.data.role === 'dashboard') {
        socket.join('room:admin');
    }

    // --- أحداث الـ Chat الجديدة ---
    socket.on('create_group', (data) => {
        if (socket.data.role !== 'dashboard') return;
        const { groupId, cameraIds } = data;
        if (!groupId || !Array.isArray(cameraIds)) return;
        
        cameraIds.forEach((camId) => {
            const socketId = live.get(camId);
            if (socketId) {
                const targetSocket = io.sockets.sockets.get(socketId);
                if (targetSocket) {
                    targetSocket.join(`room:group_${groupId}`);
                }
            }
        });
        socket.join(`room:group_${groupId}`);
        console.log(`Group chat created: ${groupId} with cameras:`, cameraIds);
    });

    socket.on('send_message', (payload) => {
        if (!payload || !payload.chatType) return;
        const senderId = socket.data.role === 'dashboard' ? 'ADMIN' : (socket.data.cameraId || 'UNKNOWN');
        const senderName = socket.data.role === 'dashboard' ? (socket.data.user?.name || 'Admin') : senderId;
        const enrichedPayload = { ...payload, senderId, senderName, timestamp: Date.now() };

        if (payload.chatType === 'PUBLIC') {
            io.to('room:public').emit('receive_message', enrichedPayload);
        } else if (payload.chatType === 'PRIVATE') {
            io.to(`room:camera_${payload.targetId}`).emit('receive_message', enrichedPayload);
            io.to('room:admin').emit('receive_message', enrichedPayload);
        } else if (payload.chatType === 'GROUP') {
            io.to(`room:group_${payload.targetId}`).emit('receive_message', enrichedPayload);
        }
    });




    if (socket.data.role === 'dashboard') {
        socket.emit('dashboard_snapshot', { cams: [...cams.values()], alarms: recentAlarms() });
        socket.on('ack_alarm', (id) => {
            id = Number(id);
            if (!Number.isInteger(id)) return;
            db.prepare('UPDATE alarms SET ack_by=?, ack_ts=? WHERE id=? AND ack_ts IS NULL')
                .run(socket.data.user.username, Date.now(), id);
            io.emit('dashboard_alarm_ack', { id });
        });
        return;
    }

    const bind = (id) => { 
        socket.data.cameraId = id; 
        live.set(id, socket.id); 
        socket.join(`room:camera_${id}`); // 👈 ضيف السطر ده هنا
    };


    socket.on('camera_gps_update', (d) => {
        const id = str(d?.cameraId);
        const lat = num(d?.lat, -90, 90);
        const lng = num(d?.lng, -180, 180);
        if (!id || lat === null || lng === null) return;
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
        bind(id);
        publish(id, { recording: !!d.recording, online: true });
    });

    socket.on('camera_ptt', (d) => {
        const id = str(d?.cameraId);
        if (!id) return;
        bind(id);
        publish(id, { ptt: !!d.active, online: true });
    });

    socket.on('camera_sos', (d) => {
        const id = str(d?.cameraId);
        if (!id) return;
        bind(id);
        const lat = num(d.lat, -90, 90), lng = num(d.lng, -180, 180), ts = Date.now();
        const r = db.prepare('INSERT INTO alarms(camera_id,lat,lng,ts) VALUES(?,?,?,?)').run(id, lat, lng, ts);
        io.emit('dashboard_sos', { id: Number(r.lastInsertRowid), cameraId: id, lat, lng, ts, ack: false });
    });

    socket.on('disconnect', () => {
        const id = socket.data.cameraId;
        if (id && live.get(id) === socket.id) { // ignore a socket already replaced by a reconnect
            live.delete(id);
            if (cams.has(id)) publish(id, { online: false, recording: false, ptt: false });
        }
    });
});

server.listen(3000, () => console.log('Central Dashboard is running on: http://localhost:3000'));

// RTMP media server. Stream key = cameraId, e.g. rtmp://HOST:1935/live/BWC-01
new NodeMediaServer({
    rtmp: { port: 1935, chunk_size: 60000, gop_cache: true, ping: 10, ping_timeout: 20 },
    http: { port: 8000, allow_origin: '*' },
}).run();