#!/usr/bin/env node
// Load test: N pretend cameras (and a few dashboards) talk to a VisionGuard server the way real ones do.
//   node tools/loadtest.js --url http://127.0.0.1:3900 --token camtoken --admin-pw secret --cams 3000 --dash 20 --ramp 100 --hold 90 [--pid <server pid>]
// A camera: connects with the shared token, announces itself, sends its position every 10 s, its battery every 15 s and its status every 60 s
// (10 % of them are recording). A dashboard: a signed-in admin socket receiving every camera change. Run it ONLY against a throwaway server of your own.
const path = require('path');
const { execSync } = require('child_process');
let io; try { ({ io } = require('socket.io-client')); } catch { ({ io } = require(path.join(__dirname, '..', 'server', 'node_modules', 'socket.io-client'))); }
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const URL_ = arg('url', 'http://127.0.0.1:3900'), TOKEN = arg('token', 'camtoken'), PW = arg('admin-pw', ''), N = +arg('cams', 3000), D = +arg('dash', 20);
const RAMP = +arg('ramp', 100), HOLD = +arg('hold', 90), PID = arg('pid', '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const st = { connected: 0, failed: 0, sent: 0, dashGot: 0, lag: [], health: [], rss: [], cpu: [], healthFail: 0 };
const pct = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);

async function dashboards() {
    if (!D) return;
    const r = await fetch(URL_ + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: PW }) });
    const sid = /sid=([0-9a-f]+)/.exec(r.headers.get('set-cookie') || '')?.[1];
    if (!sid) { console.log('dashboard login failed: skipping dashboards'); return; }
    for (let i = 0; i < D; i++) {
        const s = io(URL_, { auth: { session: sid }, transports: ['websocket'], reconnection: false });
        const seen = new Map();   // lag is measured only on a NEW position (its fixTs is the camera's own clock): battery/status updates carry an old one
        s.on('dashboard_cam', (c) => { st.dashGot++; if (c && c.fixTs && seen.get(c.cameraId) !== c.fixTs) { seen.set(c.cameraId, c.fixTs); st.lag.push(Date.now() - c.fixTs); if (st.lag.length > 20000) st.lag.splice(0, 10000); } });
    }
}
function camera(i) {
    const id = 'LT-' + String(i).padStart(4, '0'), s = io(URL_, { auth: { token: TOKEN }, transports: ['websocket'], reconnection: false });
    let lat = 24.6 + Math.random() * 0.3, lng = 46.5 + Math.random() * 0.4, bat = 40 + Math.random() * 60;
    const rec = i % 10 === 0, send = (ev, d) => { s.emit(ev, { cameraId: id, ...d }); st.sent++; };
    s.on('connect', () => {
        st.connected++;
        send('camera_status', { recording: rec, remote: false, battery: Math.round(bat), charging: false, quality: '720p', caps: ['update-net', 'remote-stop'] });
        setInterval(() => { lat += (Math.random() - 0.5) * 0.0004; lng += (Math.random() - 0.5) * 0.0004; send('camera_gps_update', { lat, lng, acc: 8, battery: Math.round(bat), fixTs: Date.now() }); }, 10000 + Math.random() * 500);
        setInterval(() => { bat = Math.max(5, bat - 0.05); send('camera_battery', { battery: Math.round(bat), charging: false }); }, 15000 + Math.random() * 500);
        setInterval(() => send('camera_status', { recording: rec, remote: false, battery: Math.round(bat), quality: '720p', caps: ['update-net', 'remote-stop'] }), 60000);
    });
    s.on('connect_error', () => { st.failed++; });
}
async function probe() {
    const t = Date.now();
    try { const r = await fetch(URL_ + '/healthz', { signal: AbortSignal.timeout(8000) }); await r.json(); st.health.push(Date.now() - t); if (!r.ok) st.healthFail++; } catch { st.healthFail++; st.health.push(8000); }
    if (PID) { try { const [rss, cpu] = execSync(`ps -o rss=,pcpu= -p ${PID}`).toString().trim().split(/\s+/); st.rss.push(+rss / 1024); st.cpu.push(+cpu); } catch { /* server gone */ } }
}
(async () => {
    console.log(`load test: ${N} cameras (+${D} dashboards) -> ${URL_}, ramp ${RAMP}/s, hold ${HOLD}s`);
    await dashboards();
    const probeTimer = setInterval(probe, 2000), t0 = Date.now();
    for (let i = 1; i <= N; i += RAMP) { for (let k = i; k < i + RAMP && k <= N; k++) camera(k); await sleep(1000); process.stdout.write(`\r  connecting... ${st.connected}/${N} (failed ${st.failed})   `); }
    console.log(`\n  ramp done in ${Math.round((Date.now() - t0) / 1000)} s: ${st.connected} connected, ${st.failed} failed`);
    const sent0 = st.sent, got0 = st.dashGot, h0 = st.health.length; st.lag.length = 0;
    await sleep(HOLD * 1000);
    clearInterval(probeTimer);
    const secs = HOLD, hl = st.health.slice(h0);
    console.log('\n=== result (steady state) ===');
    console.log(`cameras connected        ${st.connected}/${N}   connection errors ${st.failed}`);
    console.log(`events sent by cameras   ${((st.sent - sent0) / secs).toFixed(0)}/s`);
    console.log(`events seen by dashboards ${((st.dashGot - got0) / secs).toFixed(0)}/s total (${D} dashboards)`);
    console.log(`dashboard lag (ms)       p50 ${pct(st.lag, 0.5)}  p95 ${pct(st.lag, 0.95)}  max ${pct(st.lag, 1)}`);
    console.log(`/healthz latency (ms)    p50 ${pct(hl, 0.5)}  p95 ${pct(hl, 0.95)}  max ${pct(hl, 1)}  failures ${st.healthFail}`);
    if (st.rss.length) console.log(`server memory (MB)       ${Math.round(st.rss[0])} -> ${Math.round(st.rss[st.rss.length - 1])}   cpu % p50 ${pct(st.cpu, 0.5)}  p95 ${pct(st.cpu, 0.95)}  max ${pct(st.cpu, 1)}`);
    process.exit(0);
})();
