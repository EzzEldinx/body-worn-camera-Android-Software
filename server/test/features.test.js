// What a company may use (set by Smart Way) and what each user may use (set by the company's administrator), enforced by the server.
// Run with: node --test test/features.test.js
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const features = require('../features');
const seen = (list) => list.filter((k) => features.KEYS.includes(k));   // the features only (actions are tested on their own)

test('clean: unknown keys vanish, a feature without what it needs is dropped', () => {
    assert.deepStrictEqual(features.clean(['live', 'bogus', 'wall']), ['live', 'wall']);
    assert.deepStrictEqual(features.clean(['wall']), []);                // the wall needs the live dashboard
    assert.deepStrictEqual(features.clean(['ai']), []);                  // AI needs analytics
    assert.deepStrictEqual(features.clean('x'), []);
});
test('effective: staff all, administrator = company, user = company AND own list, nothing set = company', () => {
    const co = JSON.stringify(['live', 'analytics', 'reports']);
    assert.strictEqual(features.effective({ staff: true }).length, features.ALL.length);
    assert.deepStrictEqual(seen(features.effective({ manager: true, companyFeatures: co, perms: JSON.stringify(['live']) })), ['live', 'analytics', 'reports']);
    assert.deepStrictEqual(features.effective({ role: 'client', companyFeatures: co, perms: JSON.stringify(['live', 'docks']) }), ['live']);   // cannot hold what the company has not
    assert.deepStrictEqual(seen(features.effective({ role: 'client', companyFeatures: co, perms: null })), ['live', 'analytics', 'reports']);
    assert.strictEqual(seen(features.effective({ role: 'client', companyFeatures: null, perms: null })).length, features.KEYS.length);                // a company from before this existed keeps everything
});

const PORT = 3771, BASE = `http://127.0.0.1:${PORT}`;
let proc, dir, ipN = 0;
const json = async (p, { method = 'GET', body, sid } = {}) => { const r = await fetch(BASE + p, { method, redirect: 'manual', headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${++ipN}`, ...(sid ? { cookie: `sid=${sid}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})), loc: r.headers.get('location'), cookie: r.headers.get('set-cookie') }; };
const login = async (u, pw) => { const r = await json('/api/login', { method: 'POST', body: { username: u, password: pw } }); assert.strictEqual(r.status, 200, `${u} sign-in ${r.status}`); return /sid=([0-9a-f]{64})/.exec(r.cookie)[1]; };

test.before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-feat-'));
    proc = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), stdio: 'pipe', env: { ...process.env, PORT, FLV_PORT: PORT + 5000, RTMP_PORT: PORT - 2000, DATA_DIR: dir, ADMIN_PASSWORD: 'feature-admin-pw', BWC_TOKEN: 't', STREAM_SECRET: 's', DOCK_TOKEN: 'd' } });
    let out = ''; proc.stdout.on('data', (d) => { out += d; }); proc.stderr.on('data', (d) => { out += d; });
    await new Promise((res, rej) => { proc.stdout.on('data', () => /Dashboard is running/.test(out) && res()); proc.on('exit', () => rej(new Error(out.slice(-500)))); setTimeout(() => rej(new Error('start timeout')), 15000); });
});
test.after(() => { proc.kill('SIGTERM'); fs.rmSync(dir, { recursive: true, force: true }); });

test('company features and per-user access are enforced by the server, not only hidden in the menu', async () => {
    const admin = await login('admin', 'feature-admin-pw');
    const co = await json('/api/admin/companies', { method: 'POST', sid: admin, body: { name: 'Feature Co', features: ['live', 'analytics', 'reports'] } });
    assert.strictEqual(co.status, 200); const cid = co.body.id;
    await json(`/api/admin/companies/${cid}/users`, { method: 'POST', sid: admin, body: { username: 'boss1', password: 'boss-pass-123', role: 'manager' } });
    const boss = await login('boss1', 'boss-pass-123');

    // the administrator of the company has what the company has, and nothing else
    let me = (await json('/api/me', { sid: boss })).body;
    assert.deepStrictEqual(seen(me.features), ['live', 'analytics', 'reports']);
    assert.strictEqual((await json('/api/docks', { sid: boss })).status, 403, 'docks are not in this company\'s plan');
    assert.strictEqual((await json('/api/analytics', { sid: boss })).status, 200);
    assert.strictEqual((await json('/docks.html', { sid: boss })).status, 302, 'the page is not served either');

    // the administrator creates a user who may only watch live
    const list = (await json('/api/company/users', { sid: boss })).body;
    assert.deepStrictEqual(seen(list.available), ['live', 'analytics', 'reports']);
    const add = await json('/api/company/users', { method: 'POST', sid: boss, body: { username: 'watcher', password: 'watch-pass-123', role: 'client', perms: ['live', 'docks', 'ack'] } });   // docks is not theirs to give
    assert.strictEqual(add.status, 200);
    const w = await login('watcher', 'watch-pass-123');
    assert.deepStrictEqual(seen((await json('/api/me', { sid: w })).body.features), ['live']);
    assert.strictEqual((await json('/api/analytics', { sid: w })).status, 403);
    assert.strictEqual((await json('/api/report', { sid: w })).status, 403);
    assert.strictEqual((await json('/analytics.html', { sid: w })).status, 302);
    assert.strictEqual((await json('/', { sid: w })).status, 200, 'the dashboard page is allowed');

    // widening it later takes effect at once; a user can never exceed the company
    const uid = list.users.find((u) => u.username === 'watcher')?.id ?? (await json('/api/company/users', { sid: boss })).body.users.find((u) => u.username === 'watcher').id;
    assert.strictEqual((await json(`/api/company/users/${uid}`, { method: 'PATCH', sid: boss, body: { perms: ['live', 'analytics', 'ai', 'wall'] } })).status, 200);
    const w2 = await login('watcher', 'watch-pass-123');
    assert.deepStrictEqual(seen((await json('/api/me', { sid: w2 })).body.features), ['live', 'analytics']);   // ai is not in the company, wall is not in the company
    assert.strictEqual((await json('/api/analytics', { sid: w2 })).status, 200);

    // only a user's own administrator, and only Smart Way, can change this
    assert.strictEqual((await json(`/api/company/users/${uid}`, { method: 'PATCH', sid: w2, body: { perms: ['live'] } })).status, 403);
    assert.strictEqual((await json(`/api/admin/companies/${cid}/features`, { method: 'PUT', sid: boss, body: { features: ['live'] } })).status, 403);

    // Smart Way takes analytics away from the company: everybody loses it, the administrator's list is cut too
    assert.strictEqual((await json(`/api/admin/companies/${cid}/features`, { method: 'PUT', sid: admin, body: { features: ['live', 'reports', 'wall'] } })).status, 200);
    assert.deepStrictEqual(seen((await json('/api/me', { sid: boss })).body.features), ['live', 'wall', 'reports']);
    assert.strictEqual((await json('/api/analytics', { sid: w2 })).status, 403);
    // the admin panel shows the company's list
    const c = (await json('/api/admin/companies', { sid: admin })).body.companies.find((x) => x.id === cid);
    assert.deepStrictEqual(c.features, ['live', 'wall', 'reports']);

    // a company created without choosing gets everything (nothing is taken away by default)
    const plain = await json('/api/admin/companies', { method: 'POST', sid: admin, body: { name: 'Plain Co' } });
    assert.strictEqual((await json('/api/admin/companies', { sid: admin })).body.companies.find((x) => x.id === plain.body.id).features.length, features.ALL.length);
    // staff are never limited
    assert.strictEqual((await json('/api/me', { sid: admin })).body.features.length, features.ALL.length);
});

test('actions: a user may only do what was given; defaults follow the role; Smart Way can set them too', async () => {
    const admin = await login('admin', 'feature-admin-pw');
    const co = await json('/api/admin/companies', { method: 'POST', sid: admin, body: { name: 'Action Co' } });
    const cid = co.body.id;
    await json(`/api/admin/companies/${cid}/users`, { method: 'POST', sid: admin, body: { username: 'boss2', password: 'boss-pass-123', role: 'manager' } });
    const boss = await login('boss2', 'boss-pass-123');
    for (const [u, role] of [['op1', 'client'], ['view1', 'viewer']]) await json('/api/company/users', { method: 'POST', sid: boss, body: { username: u, password: 'user-pass-1234', role } });
    const op = await login('op1', 'user-pass-1234'), view = await login('view1', 'user-pass-1234');
    const acts = async (sid) => (await json('/api/me', { sid })).body.features.filter((k) => features.ACTION_KEYS.includes(k));
    assert.deepStrictEqual(await acts(op), ['ack', 'stream', 'quality', 'files'], 'an operator can act, but not delete, by default');
    assert.deepStrictEqual(await acts(view), [], 'a viewer never acts');
    assert.strictEqual((await json('/api/alerts/1/ack', { method: 'POST', sid: view })).status, 403);
    const users = (await json('/api/company/users', { sid: boss })).body.users, opId = users.find((u) => u.username === 'op1').id;
    assert.ok(users.find((u) => u.username === 'op1').access.includes('ack'));
    // the company's administrator takes alarm handling away from the operator and gives delete
    assert.strictEqual((await json(`/api/company/users/${opId}`, { method: 'PATCH', sid: boss, body: { perms: ['live', 'delete', 'docks'] } })).status, 200);
    const op2 = await login('op1', 'user-pass-1234');
    assert.deepStrictEqual(await acts(op2), ['delete']);
    assert.strictEqual((await json('/api/alerts/1/ack', { method: 'POST', sid: op2 })).status, 403, 'no alarm handling any more');
    // Smart Way sets access from the admin panel
    assert.strictEqual((await json(`/api/admin/users/${opId}/access`, { method: 'PUT', sid: admin, body: { perms: [] } })).status, 200);
    assert.deepStrictEqual((await json('/api/me', { sid: await login('op1', 'user-pass-1234') })).body.features, []);
    assert.strictEqual((await json(`/api/admin/users/${opId}/access`, { method: 'PUT', sid: boss, body: { perms: [] } })).status, 403);
});

test('pictures: users and companies can have one, only the right people can change it, only real images are kept', async () => {
    const admin = await login('admin', 'feature-admin-pw');
    const co = await json('/api/admin/companies', { method: 'POST', sid: admin, body: { name: 'Picture Co' } }), cid = co.body.id;
    await json(`/api/admin/companies/${cid}/users`, { method: 'POST', sid: admin, body: { username: 'boss3', password: 'boss-pass-123', role: 'manager' } });
    await json(`/api/admin/companies/${cid}/users`, { method: 'POST', sid: admin, body: { username: 'op3', password: 'user-pass-1234', role: 'client' } });
    const boss = await login('boss3', 'boss-pass-123'), op = await login('op3', 'user-pass-1234');
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
    const put = (p, sid, body) => fetch(BASE + p, { method: 'PUT', headers: { cookie: `sid=${sid}`, 'content-type': 'image/png', 'x-forwarded-for': `198.51.100.${++ipN}` }, body });
    const me = async (sid) => (await json('/api/me', { sid })).body;
    const bossId = (await me(boss)).id, opId = (await me(op)).id;
    assert.strictEqual((await put(`/api/avatar/user/${opId}`, op, Buffer.from('<script>alert(1)</script>'.repeat(3)))).status, 400, 'not an image');
    assert.strictEqual((await put(`/api/avatar/user/${opId}`, op, png)).status, 200, 'a user changes their own');
    assert.strictEqual((await put(`/api/avatar/user/${bossId}`, op, png)).status, 403, 'an operator cannot change someone else\'s');
    assert.strictEqual((await put(`/api/avatar/user/${opId}`, boss, png)).status, 200, 'the company administrator can');
    assert.strictEqual((await put(`/api/avatar/company/${cid}`, op, png)).status, 403);
    assert.strictEqual((await put(`/api/avatar/company/${cid}`, boss, png)).status, 200);
    assert.strictEqual((await put(`/api/avatar/user/${opId}`, admin, png)).status, 200, 'Smart Way can');
    assert.strictEqual((await put('/api/avatar/user/1', admin, png)).status, 200, 'and the super admin has their own');
    const got = await fetch(`${BASE}/api/avatar/user/${opId}`, { headers: { cookie: `sid=${boss}` } });
    assert.strictEqual(got.status, 200); assert.strictEqual(got.headers.get('content-type'), 'image/png'); assert.strictEqual(got.headers.get('x-content-type-options'), 'nosniff');
    assert.ok((await me(op)).avatarTs && (await me(boss)).logoTs, 'the pages learn there is a picture');
    // somebody from another company cannot look at it
    const other = await json('/api/admin/companies', { method: 'POST', sid: admin, body: { name: 'Other Co' } });
    await json(`/api/admin/companies/${other.body.id}/users`, { method: 'POST', sid: admin, body: { username: 'boss4', password: 'boss-pass-123', role: 'manager' } });
    assert.strictEqual((await fetch(`${BASE}/api/avatar/user/${opId}`, { headers: { cookie: `sid=${await login('boss4', 'boss-pass-123')}` } })).status, 404);
    assert.strictEqual((await fetch(`${BASE}/api/avatar/user/${opId}`)).status, 401);
});

test('a company can be created together with its administrator account', async () => {
    const admin = await login('admin', 'feature-admin-pw');
    const ok = await json('/api/admin/companies', { method: 'POST', sid: admin, body: { name: 'With Admin Co', adminUsername: 'withadmin.admin', adminPassword: 'generated-pass-12' } });
    assert.strictEqual(ok.status, 200);
    const boss = await login('withadmin.admin', 'generated-pass-12');
    const me = (await json('/api/me', { sid: boss })).body;
    assert.strictEqual(me.role, 'manager'); assert.strictEqual(me.company, 'With Admin Co');
    assert.strictEqual((await json('/employees.html', { sid: boss })).status, 200, 'the Employees page opens for the company administrator');
    // a taken username or a weak password undoes the whole thing: no half-made company
    assert.strictEqual((await json('/api/admin/companies', { method: 'POST', sid: admin, body: { name: 'Half Co', adminUsername: 'withadmin.admin', adminPassword: 'generated-pass-12' } })).status, 409);
    assert.strictEqual((await json('/api/admin/companies', { method: 'POST', sid: admin, body: { name: 'Half Co', adminUsername: 'half.admin', adminPassword: 'short' } })).status, 400);
    assert.ok(!(await json('/api/admin/companies', { sid: admin })).body.companies.some((c) => c.name === 'Half Co'));
});

test('a camera is told its company name together with the assignment (it writes it into the picture)', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE assignments(id INTEGER PRIMARY KEY, camera_id TEXT, status TEXT)');
    const co = require('./../checkout').create({ db, cams: new Map([['C1', { companyId: 7 }]]), publish() {}, dock: {}, audit() {}, companyName: (id) => (id === 7 ? 'Al Noor' : null) });
    assert.equal(co.payload('C1').company, 'Al Noor');
    assert.equal(co.payload('C1').active, false);
    assert.equal(co.payload('NOPE').company, '');
});

test('a company administrator gets no more than Smart Way ticked for the company: features and actions', () => {
    const co = JSON.stringify(['live', 'ack', 'stream', '~a']);                       // actions chosen on purpose: only these two
    assert.deepStrictEqual(features.effective({ manager: true, role: 'manager', companyFeatures: co, perms: null }), ['live', 'ack', 'stream']);
    assert.deepStrictEqual(features.effective({ role: 'client', companyFeatures: co, perms: JSON.stringify(['live', 'ack', 'delete']) }), ['live', 'ack'], 'a user cannot be given what the company does not have');
    const legacy = JSON.stringify(['live', 'docks']);                                          // an older list of features only keeps every action until it is saved again
    assert.ok(features.effective({ manager: true, role: 'manager', companyFeatures: legacy, perms: null }).includes('delete'));
    assert.ok(!features.effective({ manager: true, role: 'manager', companyFeatures: JSON.stringify(['live', 'docks', '~a']), perms: null }).includes('delete'));
});
