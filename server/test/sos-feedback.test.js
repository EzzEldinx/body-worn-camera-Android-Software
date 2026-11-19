// The officer who pressed SOS must learn that the control room received it and that somebody acknowledged it.
// Before, both events went to the dashboards only and the camera's "SOS received" / "acknowledged" lines never appeared.
// Run: node --test test/sos-feedback.test.js
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');

const PORT = 3833, BASE = `http://127.0.0.1:${PORT}`;
let proc, dir, token;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-sos-'));
    proc = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), stdio: 'pipe',
        env: { ...process.env, PORT, FLV_PORT: 8833, RTMP_PORT: 1833, DATA_DIR: dir, ADMIN_PASSWORD: 'sos-test-pw', BWC_TOKEN: 'camtoken', STREAM_SECRET: 's', SOS_COALESCE_MS: '0' } });
    await new Promise((res, rej) => { proc.stdout.on('data', (d) => /Dashboard is running/.test(String(d)) && res()); proc.on('exit', () => rej(new Error('server exited'))); setTimeout(() => rej(new Error('server did not start')), 15000); });
    const r = await fetch(BASE + '/api/mobile/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'sos-test-pw' }) });
    token = (await r.json()).token;
    assert.ok(token);
});
test.after(() => { proc?.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('the camera that pressed SOS hears the alarm and its acknowledgement; another camera hears neither', async () => {
    const cam = io(BASE, { auth: { token: 'camtoken' }, transports: ['websocket'] });
    const other = io(BASE, { auth: { token: 'camtoken' }, transports: ['websocket'] });
    const dash = io(BASE, { auth: { session: token }, transports: ['websocket'] });
    const heard = [], otherHeard = [];
    cam.on('dashboard_sos', (a) => heard.push(['sos', a.id])); cam.on('dashboard_alarm_ack', (a) => heard.push(['ack', a.id]));
    other.on('dashboard_sos', (a) => otherHeard.push(a)); other.on('dashboard_alarm_ack', (a) => otherHeard.push(a));
    await Promise.all([cam, other].map((s) => new Promise((r) => s.on('connect', r))));
    await new Promise((r) => dash.on('dashboard_snapshot', r));
    cam.emit('register', { id: 'S-1', type: 'bwc' }); cam.emit('camera_status', { cameraId: 'S-1', recording: false });
    other.emit('register', { id: 'S-2', type: 'bwc' }); other.emit('camera_status', { cameraId: 'S-2', recording: false });
    await wait(300);
    const sos = new Promise((r) => dash.once('dashboard_sos', r));
    cam.emit('camera_sos', { cameraId: 'S-1', lat: 24.7, lng: 46.7 });
    const alarm = await sos;
    await wait(200);
    dash.emit('ack_alarm', alarm.id);
    await wait(400);
    assert.deepStrictEqual(heard, [['sos', alarm.id], ['ack', alarm.id]]);
    assert.deepStrictEqual(otherHeard, [], 'another officer is not told about this alarm');
    for (const s of [cam, other, dash]) s.close();
});
