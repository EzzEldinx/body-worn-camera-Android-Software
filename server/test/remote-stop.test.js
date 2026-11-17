// "Stop" in the dashboard: ending a recording the OFFICER started, which used to be impossible from the control room.
// It must be explicit, allowed to that person only, obeyed only by a camera that says it can, refused while an SOS is unanswered, and always audited.
// Run: node --test test/remote-stop.test.js
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { io } = require('socket.io-client');

const PORT = 3822, BASE = `http://127.0.0.1:${PORT}`, PW = 'a-good-password-1';
let proc, dir, admin, coA, mgr, op, viewer;
const sockets = [];
const api = (p, method = 'GET', body, headers = {}) => fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const signIn = async (username, password) => { const l = await json(await api('/api/mobile/login', 'POST', { username, password })); assert.ok(l.token, `sign-in of ${username}`); return { authorization: `Bearer ${l.token}`, token: l.token }; };
const audit = () => { const db = new DatabaseSync(path.join(dir, 'bwc.db')); try { return db.prepare('SELECT username,action,camera_id FROM audit ORDER BY id').all(); } finally { db.close(); } };

/** A dashboard socket of somebody; it keeps every camera and alarm it hears about. */
async function dash(who) {
    const s = io(BASE, { auth: { session: who.token }, transports: ['websocket'] }); sockets.push(s);
    s.sos = [];
    s.on('dashboard_sos', (a) => s.sos.push(a));
    await new Promise((r) => s.on('dashboard_snapshot', r));
    return s;
}
/** A camera: it keeps every remote_stream command the server sends it. */
async function camera(id, status = {}) {
    const s = io(BASE, { auth: { token: 'camtoken' }, transports: ['websocket'] }); sockets.push(s);
    s.cmds = []; s.on('remote_stream', (d) => s.cmds.push(d));
    await new Promise((r) => s.on('connect', r));
    s.emit('camera_status', { cameraId: id, recording: false, remote: false, ...status });
    await wait(250);
    await api(`/api/admin/cameras/${id}/company`, 'PUT', { companyId: coA }, admin);
    await wait(100);
    return s;
}
/** Ask the server and wait for its answer about that camera. */
const ask = (s, payload) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('no answer for ' + JSON.stringify(payload))), 3000);
    const h = (r) => { if (r.cameraId === payload.cameraId) { clearTimeout(t); s.off('remote_stream_result', h); res(r); } };
    s.on('remote_stream_result', h); s.emit('remote_stream', payload);
});

test.before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-stoprec-'));
    proc = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), stdio: 'pipe',
        env: { ...process.env, PORT, FLV_PORT: 8822, RTMP_PORT: 1822, DATA_DIR: dir, ADMIN_PASSWORD: 'stop-test-pw', BWC_TOKEN: 'camtoken', STREAM_SECRET: 's', DOCK_TOKEN: 'docktoken', SOS_COALESCE_MS: '100' } });
    await new Promise((res, rej) => { proc.stdout.on('data', (d) => /Dashboard is running/.test(String(d)) && res()); proc.on('exit', () => rej(new Error('server exited'))); setTimeout(() => rej(new Error('server start timeout')), 15000); });
    admin = await signIn('admin', 'stop-test-pw');
    coA = (await json(await api('/api/admin/companies', 'POST', { name: 'Alpha', features: require('../features').ALL.map((f) => f.key) }, admin))).id;
    for (const [u, role] of [['mgr', 'manager'], ['oper', 'client'], ['view', 'viewer']]) {
        const r = await json(await api(`/api/admin/companies/${coA}/users`, 'POST', { username: u, password: PW, name: u, role }, admin));
        assert.ok(r.status < 300, `creating ${u}: ${r.status} ${JSON.stringify(r)}`);
    }
    mgr = await signIn('mgr', PW); op = await signIn('oper', PW); viewer = await signIn('view', PW);
});
test.afterEach(() => { for (const s of sockets.splice(0)) s.close(); });
test.after(() => { proc?.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('the new permission exists, nobody gets it by default but managers and Smart Way staff', async () => {
    const f = require('../features');
    assert.ok(f.ACTION_KEYS.includes('stoprec'));
    assert.deepStrictEqual(f.defaultsFor('client'), ['ack', 'stream', 'quality', 'files'], 'an operator does not get it');
    const me = async (h) => (await json(await api('/api/me', 'GET', undefined, h))).features;
    assert.ok((await me(mgr)).includes('stoprec'), 'the company administrator has it');
    assert.ok(!(await me(op)).includes('stoprec'), 'the operator does not');
    assert.ok((await me(admin)).includes('stoprec'), 'Smart Way staff have it');
});

test('a recording the officer started: a plain stop is still ignored, an explicit one reaches the camera and is audited', async () => {
    const cam = await camera('R-1', { recording: true, caps: ['update-net', 'remote-stop'] });
    const d = await dash(mgr);
    d.emit('remote_stream', { cameraId: 'R-1', action: 'stop' });
    await wait(400);
    assert.deepStrictEqual(cam.cmds, [], 'the old stop never cuts an officer recording');
    const r = await ask(d, { cameraId: 'R-1', action: 'stop', recording: true });
    assert.strictEqual(r.ok, true); assert.strictEqual(r.recording, true);
    await wait(200);
    assert.deepStrictEqual(cam.cmds, [{ action: 'stop', force: true }], 'the camera is told this is on purpose');
    const a = audit().filter((x) => x.camera_id === 'R-1');
    assert.deepStrictEqual(a.map((x) => [x.username, x.action]), [['mgr', 'remote_record_stop']]);
});

test('an operator without the permission and a viewer are refused; the camera hears nothing', async () => {
    const cam = await camera('R-2', { recording: true, caps: ['remote-stop'] });
    const o = await dash(op);
    const r = await ask(o, { cameraId: 'R-2', action: 'stop', recording: true });
    assert.deepStrictEqual([r.ok, r.reason], [false, 'not_allowed']);
    const v = await dash(viewer);
    v.emit('remote_stream', { cameraId: 'R-2', action: 'stop', recording: true });
    await wait(400);
    assert.deepStrictEqual(cam.cmds, []);
    // the company's administrator can give it to the operator
    const users = (await json(await api('/api/company/users', 'GET', undefined, mgr))).users, opId = users.find((u) => u.username === 'oper').id;
    assert.strictEqual((await api(`/api/company/users/${opId}`, 'PATCH', { perms: ['live', 'stoprec', 'ack', 'stream'] }, mgr)).status, 200);
    const o2 = await dash(await signIn('oper', PW));
    assert.strictEqual((await ask(o2, { cameraId: 'R-2', action: 'stop', recording: true })).ok, true);
});

test('a camera that has not said it can obey is refused with "needs_update"; one that is not recording with "not_recording"', async () => {
    const old = await camera('R-3', { recording: true, caps: ['update-net'] });
    const d = await dash(mgr);
    assert.strictEqual((await ask(d, { cameraId: 'R-3', action: 'stop', recording: true })).reason, 'needs_update');
    assert.deepStrictEqual(old.cmds, []);
    await camera('R-4', { recording: false, caps: ['remote-stop'] });
    assert.strictEqual((await ask(d, { cameraId: 'R-4', action: 'stop', recording: true })).reason, 'not_recording');
});

test('while an SOS of that camera is unanswered it cannot be cut; once somebody has acknowledged it, it can', async () => {
    const cam = await camera('R-5', { recording: true, caps: ['remote-stop'] });
    const d = await dash(mgr);
    cam.emit('camera_sos', { cameraId: 'R-5', lat: 24.7, lng: 46.7 });
    for (let i = 0; i < 40 && !d.sos.length; i++) await wait(50);
    assert.ok(d.sos.length, 'the SOS reached the dashboard');
    assert.strictEqual((await ask(d, { cameraId: 'R-5', action: 'stop', recording: true })).reason, 'sos_open');
    assert.deepStrictEqual(cam.cmds, []);
    d.emit('ack_alarm', d.sos[0].id);
    await wait(300);
    assert.strictEqual((await ask(d, { cameraId: 'R-5', action: 'stop', recording: true })).ok, true);
    assert.deepStrictEqual(cam.cmds, [{ action: 'stop', force: true }]);
});

test('a live view the control room started still stops the old way, without the "force" flag', async () => {
    const cam = await camera('R-6', { recording: false, caps: ['remote-stop'] });
    const d = await dash(op);
    assert.strictEqual((await ask(d, { cameraId: 'R-6', action: 'start' })).ok, true);
    cam.emit('camera_status', { cameraId: 'R-6', recording: true, remote: true, caps: ['remote-stop'] });
    await wait(250);
    assert.strictEqual((await ask(d, { cameraId: 'R-6', action: 'stop' })).ok, true, 'an operator may stop the stream the control room started');
    assert.deepStrictEqual(cam.cmds, [{ action: 'start' }, { action: 'stop' }]);
    assert.ok(audit().some((x) => x.camera_id === 'R-6' && x.action === 'remote_stream_stop'));
});
