// End-to-end check of the mobile API against a real server process (isolated data dir and ports).
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');

const PORT = 3731, BASE = `http://127.0.0.1:${PORT}`;
let proc, dir;

test.before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-mobile-'));
    proc = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), stdio: 'pipe',
        env: { ...process.env, PORT, FLV_PORT: 8731, RTMP_PORT: 1731, DATA_DIR: dir, ADMIN_PASSWORD: 'mobile-test-pw', BWC_TOKEN: 't', STREAM_SECRET: 's' } });
    await new Promise((res, rej) => { proc.stdout.on('data', (d) => /Dashboard is running/.test(String(d)) && res()); proc.on('exit', () => rej(new Error('server exited'))); setTimeout(() => rej(new Error('server start timeout')), 15000); });
});
test.after(() => { proc?.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

const post = (p, body, headers = {}) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('config is public and says which API version the server speaks', async () => {
    const j = await (await fetch(BASE + '/api/mobile/config')).json();
    assert.strictEqual(j.name, 'VisionGuard'); assert.strictEqual(j.api, 1); assert.strictEqual(j.maintenance, false);
});

test('a wrong password is refused', async () => {
    assert.strictEqual((await post('/api/mobile/login', { username: 'admin', password: 'nope' })).status, 401);
});

let token;
test('login returns a bearer token that works on the normal API', async () => {
    const r = await post('/api/mobile/login', { username: 'admin', password: 'mobile-test-pw' });
    assert.strictEqual(r.status, 200);
    const j = await r.json(); token = j.token;
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.strictEqual(j.user.username, 'admin'); assert.strictEqual(j.user.super, true);
    assert.ok(j.expiresAt > Date.now() + 29 * 864e5);
    const me = await (await fetch(BASE + '/api/me', { headers: { authorization: `Bearer ${token}` } })).json();
    assert.strictEqual(me.username, 'admin');
});

test('no token and a made-up token are refused', async () => {
    assert.strictEqual((await fetch(BASE + '/api/me')).status, 401);
    assert.strictEqual((await fetch(BASE + '/api/me', { headers: { authorization: 'Bearer ' + 'a'.repeat(64) } })).status, 401);
    assert.strictEqual((await fetch(BASE + '/api/me', { headers: { authorization: 'Bearer short' } })).status, 401);
});

test('the realtime socket accepts the token and sends the fleet snapshot', async () => {
    const s = io(BASE, { auth: { session: token }, transports: ['websocket'] });
    const snap = await new Promise((res, rej) => { s.on('dashboard_snapshot', res); s.on('connect_error', rej); setTimeout(() => rej(new Error('no snapshot')), 5000); });
    assert.ok(Array.isArray(snap.cams) && Array.isArray(snap.alarms));
    s.close();
    const bad = io(BASE, { auth: { session: 'f'.repeat(64) }, transports: ['websocket'], reconnection: false });
    const err = await new Promise((res) => bad.on('connect_error', res));
    assert.match(err.message, /unauthorized/); bad.close();
});

test('push registration validates input and logout kills the token', async () => {
    const h = { authorization: `Bearer ${token}` };
    assert.strictEqual((await post('/api/mobile/push', { token: 'x', platform: 'ios' }, h)).status, 400);
    assert.strictEqual((await post('/api/mobile/push', { token: 'a'.repeat(60), platform: 'windows' }, h)).status, 400);
    assert.strictEqual((await post('/api/mobile/push', { token: 'a'.repeat(60), platform: 'ios' }, h)).status, 200);
    assert.strictEqual((await post('/api/mobile/logout', {}, h)).status, 200);
    assert.strictEqual((await fetch(BASE + '/api/me', { headers: h })).status, 401);
});
