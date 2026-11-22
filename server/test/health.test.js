// /healthz: public, shows no data, says 503 when the data disk is almost full.
// Run: node --test test/health.test.js
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const start = async (port, extra = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-health-'));
    const p = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), stdio: 'pipe', env: { ...process.env, PORT: port, FLV_PORT: port + 5000, RTMP_PORT: port - 2000, DATA_DIR: dir, ADMIN_PASSWORD: 'h-pw', BWC_TOKEN: 't', STREAM_SECRET: 's', DOCK_TOKEN: 'd', ...extra } });
    await new Promise((res, rej) => { p.stdout.on('data', (d) => /Dashboard is running/.test(String(d)) && res()); p.on('exit', () => rej(new Error('exit'))); setTimeout(() => rej(new Error('timeout')), 15000); });
    return { p, dir };
};
test('/healthz answers 200 without signing in and shows no data; 503 when the disk threshold is not met', async () => {
    const a = await start(3834);
    try {
        const r = await fetch('http://127.0.0.1:3834/healthz');
        const j = await r.json();
        assert.strictEqual(r.status, 200); assert.strictEqual(j.ok, true); assert.strictEqual(j.checks.db, 'ok');
        assert.deepStrictEqual(Object.keys(j).sort(), ['camerasOnline', 'checks', 'ok', 'uptimeSec']);
    } finally { a.p.kill(); fs.rmSync(a.dir, { recursive: true, force: true }); }
    const b = await start(3836, { HEALTH_MIN_FREE_PCT: '100' });   // "100 % must be free" can never be true
    try { assert.strictEqual((await fetch('http://127.0.0.1:3836/healthz')).status, 503); }
    finally { b.p.kill(); fs.rmSync(b.dir, { recursive: true, force: true }); }
});
