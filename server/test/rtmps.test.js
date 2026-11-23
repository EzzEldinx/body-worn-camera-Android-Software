// Encrypted live video (RTMPS): the server tells each camera the RTMPS port with its push key, and a TLS-wrapped RTMP push through a
// front door (here a small Node TLS proxy standing in for the nginx of deploy/docker-compose.rtmps.yml) reaches the media server.
// Run: node --test test/rtmps.test.js
const test = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const { io } = require('socket.io-client');

const find = (names) => names.find((f) => fs.existsSync(f));
const ffmpeg = find(['/opt/homebrew/bin/ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']);
const openssl = find(['/usr/bin/openssl', '/opt/homebrew/bin/openssl', '/usr/local/bin/openssl']);

function startServer(env, dir) {
    const proc = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), stdio: 'pipe',
        env: { ...process.env, DATA_DIR: dir, ADMIN_PASSWORD: 'rtmps-test-pw', BWC_TOKEN: 'camtoken', STREAM_SECRET: 'stream-s', ...env } });
    const ready = new Promise((res, rej) => { proc.stdout.on('data', (d) => /Dashboard is running/.test(String(d)) && res()); proc.on('exit', () => rej(new Error('server exited'))); setTimeout(() => rej(new Error('no start')), 15000); });
    return { proc, ready };
}

// The camera stays connected (as a real one does while it streams); every socket is closed when its test ends, also on a failure.
const sockets = [];
function pushKeyOf(port, id) {
    const cam = io(`http://127.0.0.1:${port}`, { auth: { token: 'camtoken' }, transports: ['websocket'] });
    sockets.push(cam);
    return new Promise((res) => {
        cam.on('push_key', (d) => res({ ...d, cam }));
        cam.on('connect', () => { cam.emit('register', { id, type: 'bwc' }); cam.emit('camera_status', { cameraId: id, recording: false }); });
    });
}

test('without RTMPS_PUBLIC_PORT the camera gets no RTMPS port (it keeps plain RTMP)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-rtmps-a-'));
    const s = startServer({ PORT: 3846, FLV_PORT: 8846, RTMP_PORT: 1846 }, dir);
    try {
        await s.ready;
        const d = await pushKeyOf(3846, 'RS-0');
        assert.match(d.key, /^[0-9a-f]{32}$/);
        assert.equal(d.rtmpsPort, undefined);
        d.cam.close();
    } finally { sockets.forEach((c) => c.close()); s.proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('with RTMPS the camera is told the port, and an encrypted push with its key goes through', { skip: (!ffmpeg && 'ffmpeg is not installed') || (!openssl && 'openssl is not installed') }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-rtmps-b-'));
    // a throwaway self-signed certificate for the front door
    const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
    assert.equal(spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' }).status, 0);
    const s = startServer({ PORT: 3847, FLV_PORT: 8847, RTMP_PORT: 1847, RTMP_PUBLISH_AUTH: 'on', RTMPS_PUBLIC_PORT: '1947' }, dir);
    // the front door: TLS in on 1947, plain RTMP out to the media server (what nginx does in production)
    const door = tls.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (c) => {
        const up = net.connect(1847, '127.0.0.1'); c.pipe(up).pipe(c);
        c.on('error', () => up.destroy()); up.on('error', () => c.destroy());
    });
    await new Promise((r) => door.listen(1947, '127.0.0.1', r));
    try {
        await s.ready;
        const d = await pushKeyOf(3847, 'RS-1');
        assert.equal(d.rtmpsPort, 1947, 'the camera learns where to push encrypted');
        // async: the front door lives in this process, so a blocking spawnSync would starve it of its TLS handshake
        const push = (q) => new Promise((res) => {
            const p = spawn(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=10', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast',
                '-tls_verify', '0', '-f', 'flv', `rtmps://127.0.0.1:1947/live/RS-1${q}`], { stdio: 'ignore' });
            const t = setTimeout(() => p.kill(), 25000);
            p.on('exit', (code) => { clearTimeout(t); res(code); });
        });
        assert.equal(await push(`?key=${d.key}`), 0, 'an encrypted push with the camera\'s key works');
        assert.notEqual(await push(''), 0, 'without the key it is refused, encrypted or not');
        d.cam.close();
    } finally { sockets.forEach((c) => c.close()); door.close(); s.proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});
