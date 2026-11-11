// Failure-mode and abuse tests against a real server process (its own data folder and ports).
// Every test is one thing somebody hostile, broken or unlucky can do; the server must refuse it, stay up and keep serving the others.
// If the server dies in one test it is started again for the next one, so each finding fails on its own.
// Run with: node --test test/resilience.test.js
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { io } = require('socket.io-client');

const PORT = 3761, BASE = `http://127.0.0.1:${PORT}`, ADMIN_PW = 'resilience-admin-pw', PW = 'correct-horse-9';
let proc, dir, exited = null, log = '';

function start(port = PORT, extra = {}) {
    const p = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), stdio: 'pipe',
        env: { ...process.env, PORT: port, FLV_PORT: port + 5000, RTMP_PORT: port - 2000, DATA_DIR: dir, ADMIN_PASSWORD: ADMIN_PW, BWC_TOKEN: 't', STREAM_SECRET: 's', DOCK_TOKEN: 'dt',
            SESSION_SWEEP_MS: 300, SOS_COALESCE_MS: 1000, ...extra } });
    p.out = '';
    p.stdout.on('data', (d) => { p.out += d; log += d; }); p.stderr.on('data', (d) => { p.out += d; log += d; });
    p.gone = new Promise((res) => p.on('exit', (code, signal) => res({ code, signal })));
    return new Promise((res, rej) => {
        p.stdout.on('data', () => /Dashboard is running/.test(p.out) && res(p));
        p.on('exit', () => rej(new Error('server exited while starting:\n' + p.out.slice(-600))));
        setTimeout(() => rej(new Error('server start timeout')), 15000);
    });
}
async function boot() { exited = null; proc = await start(); proc.on('exit', (code, signal) => { exited = { code, signal }; }); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(what); })]);
async function mustBeAlive(after) {
    await sleep(80);
    assert.strictEqual(exited, null, `the server process died ${after}: ${JSON.stringify(exited)}\n${log.slice(-500)}`);
    assert.strictEqual((await fetch(BASE + '/api/mobile/config')).status, 200, `the server does not answer ${after}`);
}
const sql = (fn) => { const db = new DatabaseSync(path.join(dir, 'bwc.db')); try { db.exec('PRAGMA busy_timeout = 3000'); return fn(db); } finally { db.close(); } };

// every sign-in comes from its own address (the server trusts X-Forwarded-For from 127.0.0.1), so the login limiter of one test never touches another
let ipN = 0; const freshIp = () => `203.0.113.${++ipN}`;
const json = (p, { method = 'GET', body, sid, bearer, ip, headers = {} } = {}) => fetch(BASE + p, { method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(sid ? { cookie: `sid=${sid}` } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(ip ? { 'x-forwarded-for': ip } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined });
const tryLogin = (username, password, ip = freshIp(), headers) => json('/api/login', { method: 'POST', body: { username, password }, ip, headers });
async function login(username, password = PW) {
    const r = await tryLogin(username, password);
    assert.strictEqual(r.status, 200, `sign-in of ${username} failed with ${r.status}`);
    return /sid=([0-9a-f]{64})/.exec(r.headers.get('set-cookie'))[1];
}

const sockets = [];
const connect = (opts) => { const s = io(BASE, { transports: ['websocket'], reconnection: false, forceNew: true, ...opts }); sockets.push(s); return s; };
const opened = (s) => new Promise((res, rej) => { s.on('connect', () => res(s)); s.on('connect_error', (e) => rej(new Error('socket refused: ' + e.message))); });
const camera = (token = 't') => opened(connect({ auth: { token } }));
/** A signed-in dashboard socket; everything it receives is kept in s.got[event]. */
function dashboard(session) {
    const s = connect({ auth: { session } }); s.got = {};
    s.onAny((ev, d) => { (s.got[ev] ||= []).push(d); });
    return new Promise((res, rej) => { s.on('dashboard_snapshot', () => res(s)); s.on('connect_error', (e) => rej(new Error('dashboard refused: ' + e.message))); });
}
const dropped = (s) => new Promise((res) => (s.disconnected ? res('already') : s.on('disconnect', res)));
const camState = async (id) => (await (await json('/api/admin/companies', { sid: S.admin })).json()).cameras.find((c) => c.id === id);
async function untilOnline(id, want = true) { for (let i = 0; i < 40; i++) { if (!!(await camState(id))?.online === want) return; await sleep(50); } assert.fail(`${id} never became ${want ? 'online' : 'offline'}`); }

const S = {};   // sessions, company ids, camera tokens made once for the whole file
test.before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-resilience-'));
    await boot();
    S.admin = await login('admin', ADMIN_PW);
    const admin = (p, method, body) => json(p, { method, body, sid: S.admin }).then(async (r) => { const j = await r.json(); assert.ok(r.ok, `${method} ${p} -> ${r.status} ${JSON.stringify(j)}`); return j; });
    S.A = (await admin('/api/admin/companies', 'POST', { name: 'Alpha Security' })).id;
    S.B = (await admin('/api/admin/companies', 'POST', { name: 'Beta Guards' })).id;
    for (const [u, role, c] of [['a_mgr', 'manager', S.A], ['a_op', 'client', S.A], ['b_mgr', 'manager', S.B]]) await admin(`/api/admin/companies/${c}/users`, 'POST', { username: u, password: PW, name: u, role });
    for (const [id, c] of [['CAM-A1', S.A], ['CAM-B1', S.B]]) {
        S[id] = (await admin(`/api/admin/cameras/${id}/token`, 'POST', {})).token;
        await admin(`/api/admin/cameras/${id}/company`, 'PUT', { companyId: c });
    }
});
test.beforeEach(async () => { if (exited) await boot(); });
test.afterEach(() => { for (const s of sockets.splice(0)) s.close(); });
test.after(() => { proc?.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); });

// =====================================================================================================================
// 1. One request must never take the server down
// =====================================================================================================================
test('a malformed cookie on the socket handshake is refused and the server stays up', async () => {
    const s = connect({ extraHeaders: { cookie: 'sid=%' } });
    const err = await within(new Promise((res) => { s.on('connect_error', res); s.on('connect', () => res(null)); }), 5000, 'no answer to the handshake');
    await mustBeAlive('after a handshake with Cookie: sid=%');
    assert.match(String(err?.message), /unauthorized/);
});

test('a malformed cookie on a normal request is "sign in", not a server error', async () => {
    for (const cookie of ['sid=%', 'sid=%E0%A4%A', 'a=%zz; sid=' + 'f'.repeat(64)]) {
        const r = await fetch(BASE + '/api/me', { headers: { cookie } });
        assert.strictEqual(r.status, 401, `Cookie: ${cookie}`);
    }
    assert.strictEqual((await fetch(BASE + '/api/logout', { method: 'POST', headers: { cookie: 'sid=%' } })).status, 200);
    await mustBeAlive('after malformed cookies');
});

test('broken JSON and oversized JSON get a JSON error without a stack trace', async () => {
    const bad = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"username": "adm' });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.headers.get('content-type'), /application\/json/);
    const text = await bad.text();
    assert.ok(JSON.parse(text).error); assert.doesNotMatch(text, /SyntaxError|node_modules|\bat /);
    const big = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'x'.repeat(300000) }) });
    assert.strictEqual(big.status, 413); assert.match(big.headers.get('content-type'), /application\/json/);
});

test('garbage in every socket event (camera and dashboard) is ignored and the server stays up', async () => {
    const junk = [undefined, null, 0, -1, 'x', '', true, [], [[]], {}, { cameraId: null }, { cameraId: {} }, { cameraId: ['a'] }, { cameraId: 'x'.repeat(33) }, { cameraId: 'FUZZ-1' },
        { cameraId: 'FUZZ-1', lat: 'x', lng: {}, battery: {}, charging: 'y', acc: -1, fixTs: 'z', recording: {}, build: 5, quality: [], state: 'downloading', pct: 'NaN', error: {}, active: [] },
        { cameraId: 'FUZZ-1', lat: 24.7, lng: 46.7, battery: 1e308, acc: 1e308, fixTs: -1 }, { cameraId: 'FUZZ-1', state: 'failed', error: 'e'.repeat(5000), pct: {} },
        { chatType: 'PRIVATE', targetId: {}, message: {} }, { chatType: 'PRIVATE', targetId: 'FUZZ-1', message: null, audio: {} }, { chatType: 'GROUP', targetId: null }, { chatType: 'PUBLIC', message: 'm'.repeat(5000), audio: 5 },
        { groupId: 'g', cameraIds: [null, {}, 5, '..', 'FUZZ-1'] }, { groupId: {}, cameraIds: 'x' }, { action: 'start', cameraId: 'FUZZ-1' }, { action: {}, cameraId: 'FUZZ-1' }, { quality: '480p', cameraId: 'FUZZ-1' },
        { cameraIds: [{}, null, 'FUZZ-1'], force: 'yes' }, 'a'.repeat(100000), 1e308, { length: 5 }];
    const fire = async (make, events) => {
        for (const ev of events) {          // one connection per event name, so the per-connection rate limit never hides a payload from its handler
            const s = await make();
            s.emit(ev); s.emit(ev, 1, 2, 3); s.emit(ev, null, null);
            for (const j of junk) s.emit(ev, j);
            await sleep(120); s.close();
        }
    };
    await fire(() => camera('t'), ['camera_gps_update', 'camera_battery', 'camera_status', 'camera_update', 'camera_ptt', 'camera_sos', 'send_message', 'get_assignment', 'create_group', 'ack_alarm', 'remote_stream', 'no_such_event']);
    await mustBeAlive('after garbage from a camera');
    await fire(() => dashboard(S.admin), ['create_group', 'send_message', 'ack_alert', 'remote_stream', 'update_cameras', 'set_quality', 'ack_alarm', 'camera_sos', 'camera_status', 'no_such_event']);
    await mustBeAlive('after garbage from a dashboard');
    const cam = await camera('t'); cam.emit('camera_status', { cameraId: 'FUZZ-OK', recording: true });
    await untilOnline('FUZZ-OK');                                        // and it still does its job
});

// =====================================================================================================================
// 2. Nobody acts as somebody else
// =====================================================================================================================
test('a camera with its own token cannot speak as, bind to, or knock offline another camera', async () => {
    const victim = await camera(S['CAM-B1']); victim.emit('camera_status', { cameraId: 'CAM-B1', recording: false });
    await untilOnline('CAM-B1');
    const admin = await dashboard(S.admin);
    const victimHears = []; victim.on('receive_message', (m) => victimHears.push(m));
    const attacker = await camera(S['CAM-A1']);                          // company A's camera; it has not announced itself yet
    attacker.emit('send_message', { chatType: 'PRIVATE', targetId: 'CAM-B1', message: 'spoofed order' });
    attacker.emit('camera_status', { cameraId: 'CAM-B1', recording: true });
    attacker.emit('camera_sos', { cameraId: 'CAM-B1', lat: 24.7, lng: 46.7 });
    await sleep(400);
    const msgs = (admin.got.receive_message || []).filter((m) => m.message === 'spoofed order');
    assert.deepStrictEqual(msgs.map((m) => [m.senderId, m.targetId]), [['CAM-A1', 'CAM-A1']], 'the message may only appear in the sender\'s own thread, under its own name');
    assert.deepStrictEqual(victimHears, [], 'the other camera must not receive it');
    assert.strictEqual((admin.got.dashboard_sos || []).filter((a) => a.cameraId === 'CAM-B1').length, 0, 'no SOS in the other camera\'s name');
    attacker.close(); await sleep(300);
    assert.strictEqual((await camState('CAM-B1')).online, true, 'the real CAM-B1 is still connected: it must still be shown online');
    assert.strictEqual((await camState('CAM-B1')).companyId, S.B);
});

test('camera ids made only of dots are refused everywhere (they are folder names on disk)', async () => {
    const cam = await camera('t');
    for (const id of ['.', '..', '...']) { cam.emit('camera_status', { cameraId: id, recording: true }); cam.emit('camera_sos', { cameraId: id, lat: 1, lng: 1 }); }
    await sleep(300);
    const all = (await (await json('/api/admin/companies', { sid: S.admin })).json()).cameras.map((c) => c.id);
    assert.deepStrictEqual(all.filter((id) => /^\.+$/.test(id)), []);
    const body = Buffer.from('x'.repeat(64)), sha = crypto.createHash('sha256').update(body).digest('hex');
    const up = await fetch(BASE + '/api/dock/upload', { method: 'POST', body, headers: { 'x-dock-token': 'dt', 'x-camera-id': '..', 'x-filename': 'VID_20261110120000.mp4', 'x-sha256': sha, 'x-size': String(body.length) } });
    assert.strictEqual(up.status, 400);
    assert.strictEqual(fs.existsSync(path.join(dir, 'VID_20261110120000.mp4')), false, 'nothing may be written outside the recordings folder');
    assert.strictEqual((await fetch(`${BASE}/api/dock/has?camera=..&sha256=${sha}`, { headers: { 'x-dock-token': 'dt' } })).status, 400);
});

test('a group chat of one company cannot be joined or read by another company', async () => {
    const camA = await camera(S['CAM-A1']); camA.emit('camera_status', { cameraId: 'CAM-A1', recording: false }); await untilOnline('CAM-A1');
    const camHears = []; camA.on('receive_message', (m) => camHears.push(m.message));
    const a = await dashboard(await login('a_mgr')), b = await dashboard(await login('b_mgr'));
    a.emit('create_group', { groupId: 'ops', cameraIds: ['CAM-A1'] });
    b.emit('create_group', { groupId: 'ops', cameraIds: ['CAM-A1'] });   // same name, and it even asks for A's camera
    await sleep(150);
    a.emit('send_message', { chatType: 'GROUP', targetId: 'ops', message: 'alpha only' });
    b.emit('send_message', { chatType: 'GROUP', targetId: 'ops', message: 'from beta' });
    await sleep(300);
    const heard = (s) => (s.got.receive_message || []).map((m) => m.message);
    assert.deepStrictEqual(heard(a), ['alpha only']); assert.deepStrictEqual(heard(b), ['from beta']);
    assert.deepStrictEqual(camHears, ['alpha only'], 'the company\'s own camera is in the group; the other company cannot reach it');
});

// =====================================================================================================================
// 3. A session that ended really ends (the live connection used to outlive it)
// =====================================================================================================================
test('signing out on the web closes that browser\'s live connection', async () => {
    const sid = await login('a_op'), other = await login('a_op');
    const s = await dashboard(sid), stay = await dashboard(other);
    assert.strictEqual((await json('/api/logout', { method: 'POST', sid })).status, 200);
    await within(dropped(s), 2000, 'the socket is still open two seconds after sign-out');
    await sleep(500); assert.strictEqual(stay.connected, true, 'the same person\'s other browser stays signed in');
});

test('signing out in the mobile app closes the app\'s live connection', async () => {
    const { token } = await (await json('/api/mobile/login', { method: 'POST', body: { username: 'a_op', password: PW }, ip: freshIp() })).json();
    const s = await dashboard(token);
    assert.strictEqual((await json('/api/mobile/logout', { method: 'POST', body: {}, bearer: token })).status, 200);
    await within(dropped(s), 2000, 'the socket is still open two seconds after sign-out');
});

test('lowering somebody\'s role reconnects them with the new role', async () => {
    const mgr = await login('a_mgr'), s = await dashboard(await login('a_op'));
    const id = (await (await json('/api/company/users', { sid: mgr })).json()).users.find((u) => u.username === 'a_op').id;
    try {
        assert.strictEqual((await json(`/api/company/users/${id}`, { method: 'PATCH', body: { role: 'viewer' }, sid: mgr })).status, 200);
        await within(dropped(s), 2000, 'the operator\'s socket kept its old (write) role after being made a viewer');
    } finally { await json(`/api/company/users/${id}`, { method: 'PATCH', body: { role: 'client' }, sid: mgr }); }
});

test('an expired session loses its live connection', async () => {
    const sid = await login('a_op'), s = await dashboard(sid);
    sql((db) => db.prepare('UPDATE sessions SET exp = ? WHERE token = ?').run(Date.now() - 1000, sid));
    await within(dropped(s), 3000, 'the socket is still open after its session expired');
    assert.strictEqual((await json('/api/me', { sid })).status, 401);
});

test('a company whose subscription is locked loses its live connections; the other company and its own cameras do not', async () => {
    const b = await dashboard(await login('b_mgr')), a = await dashboard(await login('a_mgr'));
    const cam = await camera(S['CAM-B1']); cam.emit('camera_status', { cameraId: 'CAM-B1', recording: false });
    try {
        assert.strictEqual((await json(`/api/admin/companies/${S.B}/subscription`, { method: 'PUT', body: { end: '2020-01-01' }, sid: S.admin })).status, 200);
        await within(dropped(b), 3000, 'the locked company still receives live data');
        await sleep(400);
        assert.strictEqual(a.connected, true); assert.strictEqual(cam.connected, true, 'cameras of a locked company keep delivering (SOS, recordings)');
    } finally { await json(`/api/admin/companies/${S.B}/subscription`, { method: 'PUT', body: { clear: true }, sid: S.admin }); }
});

// =====================================================================================================================
// 4. Guessing passwords
// =====================================================================================================================
test('five wrong passwords lock that account from that address, not the whole office', async () => {
    const office = freshIp(), codes = [];
    for (let i = 0; i < 6; i++) codes.push((await tryLogin('a_mgr', 'wrong-' + i, office)).status);
    assert.deepStrictEqual(codes, [401, 401, 401, 401, 401, 429]);
    assert.strictEqual((await tryLogin('a_mgr', PW, office)).status, 429, 'even the right password waits once the account is locked');
    assert.strictEqual((await tryLogin('a_op', PW, office)).status, 200, 'a colleague behind the same address signs in');
    assert.strictEqual((await tryLogin('a_mgr', PW, freshIp())).status, 200, 'the owner signs in from another address');
});

test('signing in to your own account does not buy more guesses at somebody else\'s', async () => {
    const ip = freshIp(), codes = [];
    for (let round = 0; round < 3; round++) {
        for (let i = 0; i < 4; i++) codes.push((await tryLogin('a_mgr', `guess-${round}-${i}`, ip)).status);
        assert.strictEqual((await tryLogin('a_op', PW, ip)).status, 200);   // the attacker's own valid account
    }
    assert.ok(codes.filter((c) => c === 401).length <= 5, `twelve guesses, ${codes.filter((c) => c === 401).length} were checked: ${codes}`);
    assert.strictEqual(codes.at(-1), 429);
});

test('trying many usernames from one address locks the address', async () => {
    const ip = freshIp(), codes = [];
    for (let i = 0; i < 31; i++) codes.push((await tryLogin('nobody' + i, 'x', ip)).status);
    assert.deepStrictEqual(codes.slice(0, 30), Array(30).fill(401)); assert.strictEqual(codes[30], 429);
    assert.strictEqual((await tryLogin('a_op', PW, ip)).status, 429);
});

test('an unknown username takes as long to refuse as a wrong password (no way to list accounts by timing)', async () => {
    const time = async (user) => { const t = process.hrtime.bigint(); await tryLogin(user, 'wrong-password'); return Number(process.hrtime.bigint() - t) / 1e6; };
    const median = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
    await time('a_mgr'); await time('ghost');                             // warm up
    const known = [], unknown = [];
    for (let i = 0; i < 9; i++) { known.push(await time('a_mgr')); unknown.push(await time('ghost' + i)); }
    const k = median(known), u = median(unknown);
    assert.ok(u > k * 0.5, `unknown user answered in ${u.toFixed(1)} ms, wrong password in ${k.toFixed(1)} ms`);
});

// =====================================================================================================================
// 5. Floods from one device
// =====================================================================================================================
test('a stuck SOS button gives one alarm, not hundreds; a later SOS is a new alarm', async () => {
    const count = () => sql((db) => db.prepare("SELECT COUNT(*) n FROM alarms WHERE camera_id = 'CAM-A1'").get().n);
    const admin = await dashboard(S.admin), cam = await camera(S['CAM-A1']), before = count();
    for (let i = 0; i < 80; i++) cam.emit('camera_sos', { cameraId: 'CAM-A1', lat: 24.7, lng: 46.7 });
    await sleep(500);
    assert.strictEqual(count() - before, 1, 'one alarm row for one emergency');
    assert.strictEqual((admin.got.dashboard_sos || []).length, 1, 'and the control room is told once');
    await sleep(1100);                                                     // SOS_COALESCE_MS is 1 s in this test
    cam.emit('camera_sos', { cameraId: 'CAM-A1', lat: 24.7, lng: 46.7 });
    await sleep(300);
    assert.strictEqual(count() - before, 2);
    await mustBeAlive('after an SOS flood');
});

test('a camera that floods position updates is slowed down, not allowed to drown the dashboards; SOS still passes', async () => {
    const admin = await dashboard(S.admin), cam = await camera('t');
    for (let i = 0; i < 3000; i++) cam.emit('camera_gps_update', { cameraId: 'FLOOD-1', lat: 24.7 + i / 1e5, lng: 46.7 });
    cam.emit('camera_sos', { cameraId: 'FLOOD-1', lat: 24.7, lng: 46.7 });   // sent right behind the flood
    await sleep(1500);
    const seen = (admin.got.dashboard_cam || []).filter((c) => c.cameraId === 'FLOOD-1').length;
    assert.ok(seen >= 1 && seen <= 400, `3000 updates in one burst produced ${seen} broadcasts to every dashboard`);
    assert.strictEqual((admin.got.dashboard_sos || []).filter((a) => a.cameraId === 'FLOOD-1').length, 1, 'an SOS is never rate limited');
    await sleep(1000);
    cam.emit('camera_status', { cameraId: 'FLOOD-1', recording: true });   // the limit is a slowdown, not a ban
    await sleep(300);
    assert.strictEqual((admin.got.dashboard_cam || []).filter((c) => c.cameraId === 'FLOOD-1').at(-1).recording, true);
    await mustBeAlive('after a position flood');
});

// =====================================================================================================================
// 6. Browser-side protections
// =====================================================================================================================
test('answers carry the security headers, JSON is not cached, and Express does not advertise itself', async () => {
    for (const p of ['/api/mobile/config', '/login.html']) {
        const r = await fetch(BASE + p);
        assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff', p); assert.strictEqual(r.headers.get('x-frame-options'), 'SAMEORIGIN', p);
        assert.strictEqual(r.headers.get('referrer-policy'), 'same-origin', p); assert.strictEqual(r.headers.get('x-powered-by'), null, p);
    }
    assert.strictEqual((await json('/api/me', { sid: S.admin })).headers.get('cache-control'), 'no-store');
});

test('the session cookie is Secure behind HTTPS and still works on a plain-HTTP test server', async () => {
    const https = await tryLogin('a_op', PW, freshIp(), { 'x-forwarded-proto': 'https' }), plain = await tryLogin('a_op', PW);
    assert.match(https.headers.get('set-cookie'), /; Secure/); assert.match(https.headers.get('set-cookie'), /HttpOnly/); assert.match(https.headers.get('set-cookie'), /SameSite=Lax/);
    assert.doesNotMatch(plain.headers.get('set-cookie'), /Secure/);
    assert.match(https.headers.get('strict-transport-security') || '', /max-age/); assert.strictEqual(plain.headers.get('strict-transport-security'), null);
});

// =====================================================================================================================
// 7. Numbers stay right
// =====================================================================================================================
test('analytics counts the last day\'s GPS points of the cameras the user may see, and only those', async () => {
    const now = Date.now();
    sql((db) => {
        const ins = db.prepare('INSERT INTO positions(camera_id,lat,lng,ts) VALUES(?,?,?,?)');
        for (let i = 0; i < 3; i++) ins.run('CAM-A1', 24.7, 46.7, now - 1000 * i);
        for (let i = 0; i < 5; i++) ins.run('CAM-B1', 24.7, 46.7, now - 1000 * i);
        ins.run('CAM-A1', 24.7, 46.7, now - 2 * 86400000);                 // older than a day
        ins.run('REMOVED-CAM', 24.7, 46.7, now);                           // a camera that no longer exists
    });
    const points = async (sid) => (await (await json('/api/analytics', { sid })).json()).gpsPoints24h;
    assert.strictEqual(await points(await login('a_mgr')), 3); assert.strictEqual(await points(await login('b_mgr')), 5);
    const all = await points(S.admin), known = sql((db) => db.prepare('SELECT COUNT(*) n FROM positions p JOIN cameras c ON c.id = p.camera_id WHERE p.ts > ?').get(now - 86400000).n);
    assert.strictEqual(all, known);
});

// =====================================================================================================================
// 8. Evidence uploads: nothing half-written, nothing twice, nothing that stops the server
// =====================================================================================================================
const recDir = (cam) => path.join(dir, 'recordings', cam);
const filesOf = (cam) => (fs.existsSync(recDir(cam)) ? fs.readdirSync(recDir(cam)) : []);
const rowsOf = (sha) => sql((db) => db.prepare('SELECT COUNT(*) n FROM recordings WHERE sha256 = ?').get(sha).n);
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const upHeaders = (cam, name, body, over = {}) => ({ 'x-dock-token': 'dt', 'x-camera-id': cam, 'x-filename': name, 'x-sha256': sha256(body), 'x-size': String(body.length), 'x-dock-id': 'dock-test', ...over });
const upload = (cam, name, body, over) => fetch(BASE + '/api/dock/upload', { method: 'POST', body, headers: upHeaders(cam, name, body, over) }).then((r) => r.status, () => 'connection closed');

test('uploads that fail verification leave no file, no row and no half-written piece behind', async () => {
    const body = crypto.randomBytes(200000), cam = 'CAM-A1';
    assert.strictEqual(await upload(cam, 'VID_20261110120001.mp4', body, { 'x-dock-token': 'wrong' }), 401);
    assert.strictEqual(await upload(cam, '../../VID_20261110120001.mp4', body), 400);
    assert.strictEqual(await upload(cam, 'VID_20261110120001.mp4', body, { 'x-sha256': sha256(Buffer.from('other')) }), 422);          // damaged on the way
    assert.strictEqual(await upload(cam, 'VID_20261110120001.mp4', body, { 'x-size': String(body.length + 10) }), 422);              // shorter than declared
    assert.ok([413, 'connection closed'].includes(await upload(cam, 'VID_20261110120001.mp4', body, { 'x-size': '1000' })));          // longer than declared
    // the dock loses its link in the middle of a file
    await new Promise((res) => {
        const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/dock/upload', method: 'POST', headers: { ...upHeaders(cam, 'VID_20261110120001.mp4', body), 'content-length': body.length } });
        req.on('error', () => {}); req.write(body.subarray(0, 50000)); setTimeout(() => { req.destroy(); res(); }, 150);
    });
    await sleep(400);
    assert.deepStrictEqual(filesOf(cam), [], 'nothing may be left in the camera\'s folder');
    assert.strictEqual(rowsOf(sha256(body)), 0);
    await mustBeAlive('after failed uploads');
});

test('a good upload is stored once; sending it again is recognised as the same file', async () => {
    const body = crypto.randomBytes(300000), cam = 'CAM-A1', name = 'VID_20261110120002.mp4';
    assert.strictEqual(await upload(cam, name, body), 200);
    assert.strictEqual(sha256(fs.readFileSync(path.join(recDir(cam), name))), sha256(body), 'what is on disk is exactly what was sent');
    const again = await fetch(BASE + '/api/dock/upload', { method: 'POST', body, headers: upHeaders(cam, name, body) });
    assert.strictEqual((await again.json()).duplicate, true);
    assert.strictEqual(rowsOf(sha256(body)), 1); assert.deepStrictEqual(filesOf(cam), [name]);
});

test('the same file uploaded twice at the same moment is stored once and the server stays up', async () => {
    const body = crypto.randomBytes(400000), cam = 'CAM-B1', name = 'VID_20261110120003.mp4', half = body.length / 2;
    const send = () => {
        const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/dock/upload', method: 'POST', headers: { ...upHeaders(cam, name, body), 'content-length': body.length } });
        const done = new Promise((res) => { req.on('response', (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => res({ status: r.statusCode, body: b })); }); req.on('error', (e) => res({ status: 0, body: String(e) })); });
        req.write(body.subarray(0, half));
        return { req, done };
    };
    const one = send(), two = send();                                      // both pass the "do we have it already?" check before either has finished
    await sleep(200);
    one.req.end(body.subarray(half)); two.req.end(body.subarray(half));
    const results = await within(Promise.all([one.done, two.done]), 5000, 'no answer to the two uploads');
    await mustBeAlive('after two identical uploads at once');
    assert.deepStrictEqual(results.map((r) => r.status), [200, 200], JSON.stringify(results));
    assert.strictEqual(results.filter((r) => JSON.parse(r.body).duplicate).length, 1, 'one is stored, the other is told "already here"');
    assert.strictEqual(rowsOf(sha256(body)), 1); assert.deepStrictEqual(filesOf(cam), [name], 'no second copy and no leftover piece on disk');
});

// =====================================================================================================================
// 9. Deploys: SIGTERM is a clean stop, and the next start finds everything
// =====================================================================================================================
test('SIGTERM stops the server cleanly within seconds (code 0) and it starts again on the same data', async () => {
    const before = sql((db) => db.prepare('SELECT COUNT(*) n FROM alarms').get().n);
    const second = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-term-')); fs.cpSync(dir, second, { recursive: true });
    const keep = dir; dir = second;
    let p;
    try {
        p = await start(3762);
        const cam = io('http://127.0.0.1:3762', { transports: ['websocket'], reconnection: false, forceNew: true, auth: { token: 't' } }); sockets.push(cam);
        await opened(cam); const bye = dropped(cam);
        cam.emit('camera_sos', { cameraId: 'TERM-1', lat: 24.7, lng: 46.7 }); await sleep(200);
        p.kill('SIGTERM');
        const end = await within(p.gone, 4000, 'still running four seconds after SIGTERM');
        assert.deepStrictEqual(end, { code: 0, signal: null }, 'a clean exit, not a kill');
        await within(bye, 1000, 'the camera was not told the connection is closing');
        assert.strictEqual(sql((db) => db.prepare('SELECT COUNT(*) n FROM alarms').get().n), before + 1, 'the SOS received just before the stop is on disk');
        assert.deepStrictEqual(fs.readdirSync(second).filter((f) => f.endsWith('-wal') && fs.statSync(path.join(second, f)).size > 0), [], 'the database was closed (journal folded back in)');
        p = await start(3762);
        assert.strictEqual((await fetch('http://127.0.0.1:3762/api/mobile/config')).status, 200);
    } finally { p?.kill('SIGKILL'); dir = keep; fs.rmSync(second, { recursive: true, force: true }); }
});
