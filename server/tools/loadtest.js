// Load probe (not part of "npm test"). Starts a throw-away server on its own data folder and measures two things:
//   1. the analytics GPS count on a big positions table: the old way (load every row of the last day) against the new way (COUNT on the index)
//   2. N simulated cameras sending a position every second: how long a plain API call waits meanwhile (= how long the event loop is held)
// Usage: node tools/loadtest.js [cameras=500] [positionRows=2000000] [seconds=20]
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { io } = require('socket.io-client');

const CAMS = Number(process.argv[2]) || 500, ROWS = Number(process.argv[3]) || 2000000, SECS = Number(process.argv[4]) || 20;
const PORT = 3791, BASE = `http://127.0.0.1:${PORT}`, DAY = 86400000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-load-'));
const ms = (t) => Number(process.hrtime.bigint() - t) / 1e6;
const pct = (a, p) => a.sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
const sleep = (n) => new Promise((r) => setTimeout(r, n));

function start() {
    const p = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), stdio: 'pipe',
        env: { ...process.env, PORT, FLV_PORT: PORT + 5000, RTMP_PORT: PORT - 2000, DATA_DIR: dir, ADMIN_PASSWORD: 'load-probe-pw', BWC_TOKEN: 'load', STREAM_SECRET: 's', DOCK_TOKEN: 'd' } });
    let out = ''; p.stderr.on('data', (d) => { out += d; });
    return new Promise((res, rej) => { p.stdout.on('data', (d) => { out += d; if (/Dashboard is running/.test(out)) res(p); }); p.on('exit', () => rej(new Error('server exited:\n' + out.slice(-800)))); });
}

(async () => {
    let server = await start(); server.kill('SIGTERM'); await new Promise((r) => server.on('exit', r));   // first start only creates the tables

    // ---- 1. a day of positions ----
    const db = new DatabaseSync(path.join(dir, 'bwc.db')), now = Date.now();
    let t = process.hrtime.bigint();
    db.exec('BEGIN');
    const cam = db.prepare('INSERT OR IGNORE INTO cameras(id,name,grp,created) VALUES(?,?,?,?)'), pos = db.prepare('INSERT INTO positions(camera_id,lat,lng,ts) VALUES(?,?,?,?)');
    for (let c = 0; c < CAMS; c++) cam.run(`LOAD-${c}`, `LOAD-${c}`, '', now);
    for (let i = 0; i < ROWS; i++) pos.run(`LOAD-${i % CAMS}`, 24.7, 46.7, now - Math.floor((i / ROWS) * DAY * 0.95));
    db.exec('COMMIT');
    console.log(`seeded ${ROWS.toLocaleString()} positions for ${CAMS} cameras in ${(ms(t) / 1000).toFixed(1)} s`);
    const ids = new Set(db.prepare('SELECT id FROM cameras').all().map((r) => r.id));
    const heap = () => Math.round(process.memoryUsage().heapUsed / 1048576);
    let h0 = heap(); t = process.hrtime.bigint();
    const oldN = db.prepare('SELECT camera_id FROM positions WHERE ts > ?').all(now - DAY).filter((p) => ids.has(p.camera_id)).length;
    const oldMs = ms(t), oldHeap = heap() - h0;
    t = process.hrtime.bigint();
    const newN = db.prepare('SELECT COUNT(*) n FROM positions p JOIN cameras c ON c.id = p.camera_id WHERE p.ts > ?').get(now - DAY).n;
    const newMs = ms(t);
    console.log(`analytics GPS count   old: ${oldMs.toFixed(0)} ms, +${oldHeap} MB heap (${oldN})   new: ${newMs.toFixed(0)} ms (${newN})   -> the server answers nothing else during that time`);
    db.close();

    // ---- 2. a fleet sending positions ----
    server = await start();
    const socks = await Promise.all(Array.from({ length: CAMS }, (_, c) => new Promise((res, rej) => {
        const s = io(BASE, { auth: { token: 'load' }, transports: ['websocket'], reconnection: false, forceNew: true });
        s.on('connect', () => res(s)); s.on('connect_error', rej); s.cam = `LOAD-${c}`;
    })));
    console.log(`${socks.length} cameras connected; each sends one position a second for ${SECS} s`);
    const tick = setInterval(() => { for (const s of socks) s.emit('camera_gps_update', { cameraId: s.cam, lat: 24.7 + Math.random() / 100, lng: 46.7, battery: 80 }); }, 1000);
    const lat = [], end = Date.now() + SECS * 1000;
    while (Date.now() < end) { const a = process.hrtime.bigint(); await fetch(BASE + '/api/mobile/config').then((r) => r.arrayBuffer()); lat.push(ms(a)); await sleep(20); }
    clearInterval(tick);
    console.log(`API latency under load  p50 ${pct(lat, 0.5).toFixed(1)} ms   p99 ${pct(lat, 0.99).toFixed(1)} ms   max ${Math.max(...lat).toFixed(1)} ms   (${lat.length} calls)`);
    const cookie = /sid=[0-9a-f]{64}/.exec((await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'load-probe-pw' }) })).headers.get('set-cookie'))[0];
    t = process.hrtime.bigint(); const a = await (await fetch(BASE + '/api/analytics', { headers: { cookie } })).json();
    console.log(`GET /api/analytics       ${ms(t).toFixed(0)} ms (gpsPoints24h ${a.gpsPoints24h})`);
    for (const s of socks) s.close();
    server.kill('SIGTERM'); await new Promise((r) => server.on('exit', r));
    fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
