// What happens to new files (ask / automatic cloud / automatic dock) is chosen per company by its administrator.
// Run: node --test test/dockpolicy.test.js
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const PORT = 3832, BASE = `http://127.0.0.1:${PORT}`;
let proc, dir, admin, mgrA, opA, mgrB;
const api = (p, method = 'GET', body, h = {}) => fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...h }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) });
const signIn = async (u, p) => { const l = await json(await api('/api/mobile/login', 'POST', { username: u, password: p })); assert.ok(l.token, u); return { authorization: `Bearer ${l.token}` }; };
test.before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-dpol-'));
    proc = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), stdio: 'pipe', env: { ...process.env, PORT, FLV_PORT: 8832, RTMP_PORT: 1832, DATA_DIR: dir, ADMIN_PASSWORD: 'dp-pw', BWC_TOKEN: 't', STREAM_SECRET: 's', DOCK_TOKEN: 'dt' } });
    await new Promise((res, rej) => { proc.stdout.on('data', (d) => /Dashboard is running/.test(String(d)) && res()); proc.on('exit', () => rej(new Error('exit'))); setTimeout(() => rej(new Error('timeout')), 15000); });
    admin = await signIn('admin', 'dp-pw');
    const all = require('../features').ALL.map((f) => f.key);
    const a = (await json(await api('/api/admin/companies', 'POST', { name: 'Alpha Co', features: all }, admin))).id, b = (await json(await api('/api/admin/companies', 'POST', { name: 'Beta Co', features: all }, admin))).id;
    for (const [c, u, role] of [[a, 'mgr.a', 'manager'], [a, 'op.a', 'client'], [b, 'mgr.b', 'manager']]) await api(`/api/admin/companies/${c}/users`, 'POST', { username: u, password: 'a-good-password-1', name: u, role }, admin);
    mgrA = await signIn('mgr.a', 'a-good-password-1'); opA = await signIn('op.a', 'a-good-password-1'); mgrB = await signIn('mgr.b', 'a-good-password-1');
});
test.after(() => { proc?.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
const modeOf = async (h) => (await json(await api('/api/docks', 'GET', undefined, h))).policy.mode;
test('a company administrator chooses for his company only; an operator cannot; Smart Way sets the default', async () => {
    assert.strictEqual(await modeOf(mgrA), 'ask');
    assert.strictEqual((await api('/api/admin/dock/policy', 'PUT', { mode: 'auto_cloud' }, mgrA)).status, 200);
    assert.strictEqual(await modeOf(mgrA), 'auto_cloud'); assert.strictEqual(await modeOf(opA), 'auto_cloud', 'his colleagues see it');
    assert.strictEqual(await modeOf(mgrB), 'ask', 'the other company is not affected');
    assert.strictEqual((await api('/api/admin/dock/policy', 'PUT', { mode: 'auto_local' }, opA)).status, 403);
    assert.strictEqual((await api('/api/admin/dock/policy', 'PUT', { mode: 'auto_local' }, admin)).status, 200);
    assert.strictEqual(await modeOf(mgrB), 'auto_local', 'Smart Way default reaches a company that never chose');
    assert.strictEqual(await modeOf(mgrA), 'auto_cloud', 'and not one that did');
});
