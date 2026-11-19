// Pushing a live stream needs the camera's own key (publishkey.js). Unit tests of the key, then real RTMP pushes with ffmpeg against a server.
// Run: node --test test/publishkey.test.js
const test = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const publishkey = require('../publishkey');

const quiet = { warn() {} };

test('a key belongs to one camera, survives a restart, and a wrong one is refused', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-pk-'));
    const a = publishkey.init({ env: {}, dataDir: dir, streamSecret: 's', log: quiet });
    const b = publishkey.init({ env: {}, dataDir: dir, streamSecret: 's', log: quiet });
    assert.equal(a.keyOf('BWC-01'), b.keyOf('BWC-01'), 'the secret is kept in the data folder');
    assert.notEqual(a.keyOf('BWC-01'), a.keyOf('BWC-02'));
    assert.ok(a.valid('BWC-01', a.keyOf('BWC-01')));
    assert.ok(!a.valid('BWC-02', a.keyOf('BWC-01')), 'one camera cannot push as another');
    assert.ok(!a.valid('BWC-01', ''));
    assert.equal(a.mode, 'warn', 'warn is the default, so cameras that are not updated keep working');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('the check: "on" gives a valid push the internal signature and a bad one a failing one; "warn" lets both through', () => {
    const on = publishkey.init({ env: { RTMP_PUBLISH_AUTH: 'on', PUBLISH_SECRET: 'p' }, streamSecret: 's', log: quiet });
    const good = { streamPath: '/live/C1', streamQuery: { key: on.keyOf('C1') } };
    assert.equal(on.check(good), true);
    assert.match(good.streamQuery.sign, /^\d+-[0-9a-f]{32}$/);
    const bad = { streamPath: '/live/C1', streamQuery: { sign: 'a viewer play link' } };
    assert.equal(on.check(bad), false);
    assert.equal(bad.streamQuery.sign, 'x-x');
    const warn = publishkey.init({ env: { PUBLISH_SECRET: 'p' }, streamSecret: 's', log: quiet });
    assert.equal(warn.check({ streamPath: '/live/C1', streamQuery: {} }), true);
});

const ffmpeg = ['/opt/homebrew/bin/ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find((f) => fs.existsSync(f));
test('real pushes against a server with RTMP_PUBLISH_AUTH=on', { skip: !ffmpeg && 'ffmpeg is not installed' }, async () => {
    const PORT = 3844, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-pk-srv-'));
    const proc = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), stdio: 'pipe',
        env: { ...process.env, PORT, FLV_PORT: 8844, RTMP_PORT: 1844, DATA_DIR: dir, ADMIN_PASSWORD: 'pk-test-pw', BWC_TOKEN: 'camtoken', STREAM_SECRET: 'stream-s', RTMP_PUBLISH_AUTH: 'on' } });
    try {
        await new Promise((res, rej) => { proc.stdout.on('data', (d) => /Dashboard is running/.test(String(d)) && res()); proc.on('exit', () => rej(new Error('server exited'))); setTimeout(() => rej(new Error('no start')), 15000); });
        // the camera receives its key over its socket
        const cam = io(`http://127.0.0.1:${PORT}`, { auth: { token: 'camtoken' }, transports: ['websocket'] });
        const key = await new Promise((res) => { cam.on('push_key', (d) => res(d.key)); cam.on('connect', () => { cam.emit('register', { id: 'PK-1', type: 'bwc' }); cam.emit('camera_status', { cameraId: 'PK-1', recording: false }); }); });
        assert.match(key, /^[0-9a-f]{32}$/);
        const push = (q) => spawnSync(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=10', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-f', 'flv', `rtmp://127.0.0.1:1844/live/PK-1${q}`], { timeout: 20000 }).status;
        assert.notEqual(push(''), 0, 'a push without a key is refused');
        const play = `?sign=${Math.floor(Date.now() / 1000) + 600}-${require('crypto').createHash('md5').update(`/live/PK-1-${Math.floor(Date.now() / 1000) + 600}-stream-s`).digest('hex')}`;
        assert.notEqual(push(play), 0, 'a viewer\'s play link does not allow pushing');
        assert.equal(push(`?key=${key}`), 0, 'the camera\'s own key works');
        cam.close();
    } finally { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});
