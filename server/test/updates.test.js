// End to end against a real server process: the update notice every company gets, what each company sees of ITS cameras only, the camera
// update mode, and the automatic update over the network (the camera is told, the canary goes first). Run: node --test test/updates.test.js
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');

const PORT = 3811, BASE = `http://127.0.0.1:${PORT}`;
let proc, dir, admin;
const api = (p, method = 'GET', body, headers = {}) => fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await wait(60); } };

// A file that passes the server's "is this an APK" check (the content is never run)
const fakeApk = (seed) => { const b = Buffer.alloc(1_200_000, seed); b.writeUInt32LE(0x04034b50, 0); b.write('AndroidManifest.xml', 100); return b; };
const OLD = crypto.createHash('sha256').update('old build').digest('hex');
const build = (b) => crypto.createHash('sha256').update(b).digest('hex');

test.before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-updates-'));
    proc = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), stdio: 'pipe',
        env: { ...process.env, PORT, FLV_PORT: 8811, RTMP_PORT: 1811, DATA_DIR: dir, ADMIN_PASSWORD: 'updates-test-pw', BWC_TOKEN: 'camtoken', STREAM_SECRET: 's', DOCK_TOKEN: 'docktoken', ROLLOUT_PROVE_MS: '300' } });
    await new Promise((res, rej) => { proc.stdout.on('data', (d) => /Dashboard is running/.test(String(d)) && res()); proc.on('exit', () => rej(new Error('server exited'))); setTimeout(() => rej(new Error('server start timeout')), 15000); });
    admin = await signIn('admin', 'updates-test-pw');
});
test.after(() => { for (const c of Object.values(cams)) c.s.close(); proc?.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

const signIn = async (username, password) => { const l = await json(await api('/api/mobile/login', 'POST', { username, password })); assert.ok(l.token, `${username} signs in`); return { authorization: `Bearer ${l.token}` }; };

// a camera that connects with the shared token, reports the build it runs and what it can do, and listens for update orders
function camera(id, { build: b = OLD, caps = ['update-net'], battery = 80 } = {}) {
    const s = io(BASE, { auth: { token: 'camtoken' }, transports: ['websocket'] }), orders = [];
    s.on('update_app', (o) => orders.push(o));
    return new Promise((res) => s.on('connect', () => { s.emit('camera_status', { cameraId: id, recording: false, build: b, caps, battery, charging: false }); res({ s, orders, id }); }));
}
const status = (cam, extra) => cam.s.emit('camera_status', { cameraId: cam.id, recording: false, caps: ['update-net'], battery: 80, charging: false, ...extra });

let coA, coB, mgrA, viewerA, mgrB;
const cams = {};

test('two companies with their cameras, and the Updates page has nothing to say before a build is announced', async () => {
    coA = (await json(await api('/api/admin/companies', 'POST', { name: 'Alpha Security' }, admin))).id;
    coB = (await json(await api('/api/admin/companies', 'POST', { name: 'Beta Patrol' }, admin))).id;
    for (const [co, u, role] of [[coA, 'mgr.a', 'manager'], [coA, 'view.a', 'viewer'], [coB, 'mgr.b', 'manager']]) await api(`/api/admin/companies/${co}/users`, 'POST', { username: u, password: 'a-good-password-1', role }, admin);
    mgrA = await signIn('mgr.a', 'a-good-password-1'); viewerA = await signIn('view.a', 'a-good-password-1'); mgrB = await signIn('mgr.b', 'a-good-password-1');
    for (const [id, co] of [['A-1', coA], ['A-2', coA], ['A-3', coA], ['B-1', coB]]) {
        cams[id] = await camera(id);
        await api(`/api/admin/cameras/${id}/company`, 'PUT', { companyId: co }, admin);
    }
    const v = await json(await api('/api/updates', 'GET', undefined, mgrA));
    assert.strictEqual(v.status, 200); assert.strictEqual(v.announced, false); assert.strictEqual(v.notice, null); assert.deepStrictEqual(v.list, []);
    assert.strictEqual((await json(await api('/api/me', 'GET', undefined, mgrA))).updates.notice, null, 'no heart yet');
});

test('only a Smart Way administrator publishes, notifies and sets how cameras update', async () => {
    for (const [m, p, b] of [['POST', '/api/admin/update/notice', {}], ['PUT', '/api/admin/update/mode', { cameraId: 'A-1', mode: 'any' }], ['POST', '/api/admin/update/rollout', { action: 'halt' }]]) {
        assert.ok([401, 403].includes((await api(p, m, b, mgrA)).status), `${m} ${p} refused for a company administrator`);
        assert.ok([401, 403].includes((await api(p, m, b)).status), `${m} ${p} refused when signed out`);
    }
    assert.strictEqual((await json(await api('/api/admin/update/notice', 'POST', {}, admin))).status, 409, 'nothing to announce before a build exists');
});

let apk1, apk1Build;
test('a published build is not announced by itself: customers hear about it only when the administrator sends the notice', async () => {
    apk1 = fakeApk(1); apk1Build = build(apk1);
    const up = await fetch(BASE + '/api/admin/update/apk', { method: 'PUT', headers: admin, body: apk1 });
    assert.strictEqual(up.status, 200);
    assert.strictEqual((await json(await api('/api/updates', 'GET', undefined, mgrA))).announced, false);
    assert.strictEqual((await json(await api('/api/me', 'GET', undefined, mgrA))).updates.notice, null);
});

test('the notice reaches every company user once, with the default words, and the heart stops when they have seen it', async () => {
    const sent = await json(await api('/api/admin/update/notice', 'POST', {}, admin));
    assert.strictEqual(sent.status, 200); assert.match(sent.notice.body, /put all your cameras on the docking station/i); assert.match(sent.notice.bodyAr, /محطة الإرساء/);
    for (const who of [mgrA, viewerA, mgrB]) {
        const me = await json(await api('/api/me', 'GET', undefined, who));
        assert.strictEqual(me.updates.notice.id, sent.notice.id, 'the heart is there');
    }
    assert.strictEqual((await json(await api('/api/me', 'GET', undefined, admin))).updates.notice, null, 'Smart Way staff send it, they are not its audience');
    assert.strictEqual((await json(await api('/api/updates/seen', 'POST', { id: sent.notice.id }, viewerA))).ok, true);
    assert.strictEqual((await json(await api('/api/me', 'GET', undefined, viewerA))).updates.notice, null, 'seen: no heart');
    assert.ok((await json(await api('/api/me', 'GET', undefined, mgrA))).updates.notice, 'the others have not seen it yet');
    assert.strictEqual((await json(await api('/api/updates/seen', 'POST', { id: 99999 }, mgrA))).ok, false);
});

test('a company sees only its own cameras and what each one waits for: the client only has to dock them', async () => {
    const a = await json(await api('/api/updates', 'GET', undefined, mgrA));
    assert.strictEqual(a.announced, true);
    assert.deepStrictEqual(a.cameras, { total: 3, current: 0, dock: 3, network: 0 });
    assert.deepStrictEqual(a.list.map((c) => c.id), ['A-1', 'A-2', 'A-3']);
    assert.strictEqual(a.list[0].how, 'dock'); assert.match(a.list[0].detail, /Put it on the docking station/);
    const b = await json(await api('/api/updates', 'GET', undefined, mgrB));
    assert.deepStrictEqual(b.list.map((c) => c.id), ['B-1'], 'nothing of Alpha');
    assert.strictEqual((await json(await api('/api/me', 'GET', undefined, mgrA))).updates.waiting, 3, 'the number on the tab');
    assert.strictEqual((await json(await api('/api/updates', 'GET', undefined, admin))).cameras.total, 4, 'staff see all');
    assert.strictEqual(a.notice.by, undefined, 'who sent it is for staff only');
    // a camera that has the new build (put on the dock) drops out of the list
    status(cams['A-3'], { build: apk1Build });
    await until(async () => (await json(await api('/api/updates', 'GET', undefined, mgrA))).cameras.current === 1);
    assert.deepStrictEqual((await json(await api('/api/updates', 'GET', undefined, mgrA))).list.map((c) => c.id), ['A-1', 'A-2']);
});

test('switching a camera to "update over the network" tells it to update, and the company then sees it is on its way', async () => {
    assert.strictEqual((await json(await api('/api/admin/update/mode', 'PUT', { cameraId: 'A-1', mode: 'bogus' }, admin))).status, 400);
    assert.strictEqual((await json(await api('/api/admin/update/mode', 'PUT', { cameraId: 'NOPE', mode: 'any' }, admin))).status, 404);
    // A-3 already runs the new build and proves it (the proof time is short in this test): the rollout is open
    await wait(450); await api('/api/admin/update/rollout', 'POST', { action: 'resume' }, admin);
    const r = await json(await api('/api/admin/update/mode', 'PUT', { cameraIds: ['A-1', 'B-1'], mode: 'any' }, admin));
    assert.deepStrictEqual([r.status, r.changed], [200, 2]);
    const order = await until(() => cams['A-1'].orders[0]);
    assert.deepStrictEqual({ build: order.build, auto: order.auto, net: order.net, force: order.force }, { build: apk1Build, auto: true, net: 'any', force: false });
    assert.ok(order.size > 1e6);
    const a = await json(await api('/api/updates', 'GET', undefined, mgrA));
    const row = a.list.find((c) => c.id === 'A-1');
    assert.strictEqual(row.how, 'network'); assert.match(row.detail, /on the way/i);
    assert.strictEqual(a.cameras.network, 1);
    // progress shows on the page
    cams['A-1'].s.emit('camera_update', { cameraId: 'A-1', state: 'downloading', pct: 40 });
    await until(async () => (await json(await api('/api/updates', 'GET', undefined, mgrA))).list.find((c) => c.id === 'A-1')?.pct === 40);
    assert.match((await json(await api('/api/updates', 'GET', undefined, mgrA))).list.find((c) => c.id === 'A-1').detail, /Downloading/);
    // the administrator's page knows the mode, the reason and the rollout
    const adm = await json(await api('/api/admin/update', 'GET', undefined, admin));
    assert.strictEqual(adm.cameras.find((c) => c.id === 'A-1').mode, 'any'); assert.strictEqual(adm.cameras.find((c) => c.id === 'A-2').mode, 'off');
    assert.ok(adm.rollout && adm.rollout.build.length === 64); assert.ok(adm.defaults.body);
});

test('a Wi-Fi only camera whose app cannot keep to Wi-Fi is not asked; it needs the docking station once', async () => {
    cams['A-2'].s.close(); cams['A-2'] = await camera('A-2', { caps: [] });
    await api('/api/admin/update/mode', 'PUT', { cameraId: 'A-2', mode: 'wifi' }, admin);
    await wait(300);
    assert.deepStrictEqual(cams['A-2'].orders, [], 'not asked over a link that might be a SIM');
    const row = (await json(await api('/api/updates', 'GET', undefined, mgrA))).list.find((c) => c.id === 'A-2');
    assert.strictEqual(row.how, 'dock');
    const adm = await json(await api('/api/admin/update', 'GET', undefined, admin));
    assert.strictEqual(adm.cameras.find((c) => c.id === 'A-2').why, 'needs-app'); assert.strictEqual(adm.cameras.find((c) => c.id === 'A-2').canWifi, false);
});

test('two cameras that refuse the build stop the automatic updates and the administrator can resume them', async () => {
    const state = async () => (await json(await api('/api/admin/update', 'GET', undefined, admin))).rollout;
    await until(() => cams['B-1'].orders[0]);
    cams['A-1'].s.emit('camera_update', { cameraId: 'A-1', state: 'failed', error: 'INSTALL_FAILED_OLDER_SDK' });
    await wait(300);
    assert.strictEqual((await state()).state, 'rolling', 'one refusal can be that phone');
    cams['B-1'].s.emit('camera_update', { cameraId: 'B-1', state: 'failed', error: 'INSTALL_FAILED_OLDER_SDK' });
    const adm = { rollout: await until(async () => { const r = await state(); return r.state === 'halted' ? r : null; }) };
    assert.match(adm.rollout.note, /refused the new build/);
    assert.strictEqual((await json(await api('/api/admin/update/rollout', 'POST', { action: 'resume' }, admin))).ok, true);
    assert.strictEqual((await json(await api('/api/admin/update', 'GET', undefined, admin))).rollout.state, 'rolling');
    assert.strictEqual((await json(await api('/api/admin/update/rollout', 'POST', { action: 'nonsense' }, admin))).status, 400);
    assert.strictEqual((await json(await api('/api/admin/update/rollout', 'POST', { action: 'halt', note: 'wait' }, admin))).ok, true);
    assert.strictEqual((await json(await api('/api/admin/update', 'GET', undefined, admin))).rollout.state, 'halted');
});

test('the audit trail says who sent the notice, who changed a camera and why the rollout stopped', async () => {
    const log = await json(await api('/api/audit?action=update_', 'GET', undefined, admin));
    const actions = (log.lines || []).map((r) => r.action);
    for (const a of ['update_notice_sent', 'update_mode_any', 'update_halted_' + apk1Build.slice(0, 12), 'update_auto_' + apk1Build.slice(0, 12), 'update_resumed_' + apk1Build.slice(0, 12)]) assert.ok(actions.includes(a), `audit has ${a}`);
});

test('a new notice makes the heart beat again for everybody', async () => {
    const second = await json(await api('/api/admin/update/notice', 'POST', { title: 'Second', body: 'Please dock your cameras again.', bodyAr: 'x' }, admin));
    assert.strictEqual(second.notice.title, 'Second');
    assert.strictEqual((await json(await api('/api/me', 'GET', undefined, viewerA))).updates.notice.id, second.notice.id);
    assert.strictEqual((await json(await api('/api/updates', 'GET', undefined, mgrB))).notices.length, 2, 'the page keeps the history');
});
