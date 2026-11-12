// The licence through the real server: a customer installation starts in trial, an administrator requests and installs a licence,
// limits and the expired (limited) mode are enforced, and the apps are told.
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const core = require('../license-core');

const PORT = 3751, BASE = `http://127.0.0.1:${PORT}`, DAY = 86400000;
const vendor = core.makeKeyPair();
let proc, dir, admin, installId;
const api = (p, method = 'GET', body, headers = {}) => fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = (r) => r.json();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await wait(80); } };

function start(env = {}) {
    return new Promise((res, rej) => {
        proc = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), stdio: 'pipe',
            env: { ...process.env, PORT, FLV_PORT: 8751, RTMP_PORT: 1751, DATA_DIR: dir, ADMIN_PASSWORD: 'license-test-pw', BWC_TOKEN: 'camtoken', STREAM_SECRET: 's', DOCK_TOKEN: 'docktoken',
                LICENSE_MODE: 'enforce', LICENSE_PUBKEY_FILE: path.join(dir, 'vendor-public.pem'), ...env } });
        proc.stdout.on('data', (d) => /Dashboard is running/.test(String(d)) && res());
        proc.on('exit', () => rej(new Error('server exited'))); setTimeout(() => rej(new Error('server start timeout')), 15000);
    });
}
const login = async () => { const l = await json(await api('/api/mobile/login', 'POST', { username: 'admin', password: 'license-test-pw' })); admin = { authorization: `Bearer ${l.token}` }; };
const stop = () => new Promise((r) => { if (!proc) return r(); proc.once('exit', r); proc.kill(); });
const licenseFor = (over = {}) => {
    const start = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) - (over.startDaysAgo ?? 0) * DAY;
    const term = over.term ?? '12m';
    const payload = { v: 1, serial: over.serial || 'VG-T-000001', customer: 'Ministry of Test', installId, issued: Date.now(), start, expires: over.expires ?? core.termEnd(start, term), term, ...over.payload };
    return core.sign(payload, vendor.privatePem, 'test');
};

test.before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-license-'));
    fs.writeFileSync(path.join(dir, 'vendor-public.pem'), vendor.publicPem);
    await start(); await login();
});
test.after(async () => { await stop(); fs.rmSync(dir, { recursive: true, force: true }); });

test('a new customer installation starts in trial and says so to the apps and the pages', async () => {
    const cfg = await json(await api('/api/mobile/config'));
    assert.strictEqual(cfg.license.state, 'trial'); assert.strictEqual(cfg.license.canManage, false);
    const me = await json(await api('/api/me', 'GET', undefined, admin));
    assert.strictEqual(me.license.state, 'trial'); assert.strictEqual(me.license.canManage, true); assert.strictEqual(me.license.show, true);
    const d = await json(await api('/api/license', 'GET', undefined, admin));
    assert.match(d.installId, /^VG-([0-9A-F]{4}-){4}[0-9A-F]{4}$/); installId = d.installId;
    assert.strictEqual(d.limits.cameras, 10); assert.strictEqual(d.daysLeft, 30);
});

test('only an administrator may see or change the licence', async () => {
    assert.strictEqual((await api('/api/license')).status, 401);
    const co = (await json(await api('/api/admin/companies', 'POST', { name: 'Dept A' }, admin))).id;
    await api(`/api/admin/companies/${co}/users`, 'POST', { username: 'deptuser', password: 'dept-user-pw', name: 'Dept' }, admin);
    const u = await json(await api('/api/mobile/login', 'POST', { username: 'deptuser', password: 'dept-user-pw' }));
    const h = { authorization: `Bearer ${u.token}` };
    assert.strictEqual((await api('/api/license', 'GET', undefined, h)).status, 403);
    assert.strictEqual((await api('/api/license', 'POST', { license: 'x' }, h)).status, 403);
    assert.strictEqual((await api('/api/license/status', 'GET', undefined, h)).status, 200, 'but everybody can see the banner');
    assert.strictEqual((await api('/license.html', 'GET', undefined, h)).redirected, true);
});

test('the renewal request downloads as a signed file', async () => {
    const r = await api('/api/license/request?term=12m&note=hello', 'GET', undefined, admin);
    assert.strictEqual(r.status, 200); assert.match(r.headers.get('content-disposition'), new RegExp(`${installId}\\.vgreq`));
    const v = core.verifyRequest(await r.text());
    assert.strictEqual(v.ok, true); assert.strictEqual(v.installId, installId); assert.strictEqual(v.payload.note, 'hello');
    assert.strictEqual((await api('/api/license/request?term=5y', 'GET', undefined, admin)).status, 400);
});

test('a bad licence is refused with a reason; the right one is installed without a restart', async () => {
    const wrong = core.sign({ v: 1, serial: 'VG-X', customer: 'Someone else', installId: 'VG-AAAA-BBBB-CCCC-DDDD-EEEE', issued: Date.now(), start: Date.now(), expires: Date.now() + 365 * DAY }, vendor.privatePem, 'test');
    const r1 = await api('/api/license', 'POST', { license: JSON.stringify(wrong) }, admin);
    assert.strictEqual(r1.status, 409); assert.match((await r1.json()).error, /another installation/);
    const stranger = core.makeKeyPair();
    const forged = core.sign({ v: 1, serial: 'VG-F', customer: 'Forger', installId, issued: Date.now(), start: Date.now(), expires: Date.now() + 999 * DAY }, stranger.privatePem, 'test');
    const r2 = await api('/api/license', 'POST', { license: forged }, admin);
    assert.strictEqual(r2.status, 400); assert.match((await r2.json()).error, /signature/);
    assert.strictEqual((await api('/api/license', 'POST', { license: 'hello' }, admin)).status, 400);

    const ok = await api('/api/license', 'POST', { license: licenseFor({ payload: { limits: { cameras: 2, employees: 3, companies: 3 }, features: ['reports', 'docking', 'checkout', 'mobile'] } }) }, admin);
    assert.strictEqual(ok.status, 200);
    const d = await ok.json();
    assert.strictEqual(d.state, 'valid'); assert.strictEqual(d.customer, 'Ministry of Test'); assert.strictEqual(d.history.length, 1); assert.strictEqual(d.limits.cameras, 2);
    assert.strictEqual((await json(await api('/api/mobile/config'))).license.state, 'valid');
    assert.ok((await json(await api('/api/audit?action=license_installed', 'GET', undefined, admin))).lines.length >= 1);
});

test('the licence limits cameras, employees and companies, and leaves out features it does not include', async () => {
    const cams = [];
    for (const id of ['L-1', 'L-2', 'L-3']) {
        const s = io(BASE, { auth: { token: 'camtoken' }, transports: ['websocket'] });
        await new Promise((res) => s.on('connect', res)); s.emit('camera_status', { cameraId: id, recording: false }); cams.push(s); await wait(150);
    }
    const dash = io(BASE, { auth: { session: admin.authorization.slice(7) }, transports: ['websocket'] });
    const snap = await new Promise((res) => dash.on('dashboard_snapshot', res)); dash.close();
    assert.deepStrictEqual(snap.cams.map((c) => c.cameraId).sort(), ['L-1', 'L-2'], 'the third camera is not registered: the licence allows two');
    const issueToken = await api('/api/admin/cameras/L-9/token', 'POST', {}, admin);
    assert.strictEqual(issueToken.status, 402); assert.match((await issueToken.json()).error, /allows 2 cameras/);
    cams.forEach((s) => s.close());

    const co = (await json(await api('/api/admin/companies', 'GET', undefined, admin))).companies[0].id;
    const emps = await api(`/api/admin/companies/${co}/employees`, 'POST', { employees: [{ name: 'A', employeeNo: '1' }, { name: 'B', employeeNo: '2' }, { name: 'C', employeeNo: '3' }, { name: 'D', employeeNo: '4' }] }, admin);
    assert.strictEqual(emps.status, 402, 'four employees do not fit the licensed three');
    assert.strictEqual((await api(`/api/admin/companies/${co}/employees`, 'POST', { employees: [{ name: 'A', employeeNo: '1' }, { name: 'B', employeeNo: '2' }] }, admin)).status, 200);
    assert.strictEqual((await api('/api/admin/companies', 'POST', { name: 'Dept B' }, admin)).status, 200);
    assert.strictEqual((await api('/api/admin/companies', 'POST', { name: 'Dept C' }, admin)).status, 200);   // Dept A was the first: three are licensed
    assert.strictEqual((await api('/api/admin/companies', 'POST', { name: 'Dept D' }, admin)).status, 402, 'the fourth company does not fit the licence');
    assert.strictEqual((await api('/api/analytics/ai', 'POST', {}, admin)).status, 402, 'AI is not in this licence');
    const body = await (await api('/api/analytics/ai', 'POST', {}, admin)).json(); assert.strictEqual(body.code, 'license_feature');
});

// A server whose licence ran out while it was running: put an already-ended licence straight into the database, like time passing would.
const { DatabaseSync } = require('node:sqlite');
function plant(over) {
    const db = new DatabaseSync(path.join(dir, 'bwc.db'));
    const lic = core.sign({ v: 1, serial: 'VG-T-OLD', customer: 'Old Customer', installId, issued: Date.now() - 400 * DAY, start: Date.now() - 400 * DAY, expires: Date.now() - 40 * DAY, ...over }, vendor.privatePem, 'test');
    db.prepare("INSERT INTO license_state(key,value) VALUES('current',?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(lic));
    db.close();
}
const dashboard = (h = admin) => io(BASE, { auth: { session: h.authorization.slice(7) }, transports: ['websocket'], reconnection: false });

test('an ended licence with grace left: everything keeps working, with a banner', async () => {
    await stop(); plant({ expires: Date.now() - 10 * DAY, graceDays: 30 }); await start(); await login();
    const st = await json(await api('/api/license/status', 'GET', undefined, admin));
    assert.strictEqual(st.state, 'grace'); assert.strictEqual(st.show, true); assert.ok(st.graceUntil > Date.now());
    assert.strictEqual((await api('/api/admin/companies', 'POST', { name: 'Allowed in grace' }, admin)).status, 200);
    const pdf = await api('/api/report', 'GET', undefined, admin); assert.strictEqual(pdf.status, 200); await pdf.arrayBuffer();
});

test('limited mode: no growth and no exports, but the cameras, SOS, live view and docks carry on', async () => {
    await stop(); plant({ expires: Date.now() - 40 * DAY, graceDays: 30 }); await start(); await login();
    assert.strictEqual((await json(await api('/api/license/status', 'GET', undefined, admin))).state, 'restricted');
    for (const [m, p, b] of [['POST', '/api/admin/companies', { name: 'Blocked' }], ['GET', '/api/report'], ['GET', '/api/audit/export.csv'], ['POST', '/api/analytics/ai', {}], ['POST', '/api/admin/regions', { name: 'Nowhere' }]]) {
        const r = await api(p, m, b, admin); assert.strictEqual(r.status, 402, `${m} ${p}`); assert.strictEqual((await r.json()).code, 'license_restricted');
    }
    assert.strictEqual((await api('/api/me', 'GET', undefined, admin)).status, 200);
    assert.strictEqual((await api('/api/docks', 'GET', undefined, admin)).status, 200);
    assert.strictEqual((await api('/api/dock/report', 'POST', { dockId: 'd', cameras: [] }, { 'x-dock-token': 'docktoken' })).status, 200, 'the dock keeps delivering');

    const dash = dashboard();
    const snap = await new Promise((res) => dash.on('dashboard_snapshot', res));
    assert.ok(snap.cams.some((c) => c.cameraId === 'L-1'), 'cameras registered earlier are still there');
    const sos = new Promise((res) => dash.on('dashboard_sos', res));
    const cam = io(BASE, { auth: { token: 'camtoken' }, transports: ['websocket'] });
    await new Promise((res) => cam.on('connect', res));
    cam.emit('camera_sos', { cameraId: 'L-1', lat: 24.7, lng: 46.7 });
    assert.strictEqual((await sos).cameraId, 'L-1', 'an SOS is never refused');
    cam.emit('camera_status', { cameraId: 'NEW-1', recording: false }); await wait(300);
    const again = dashboard(); const snap2 = await new Promise((res) => again.on('dashboard_snapshot', res));
    assert.ok(!snap2.cams.some((c) => c.cameraId === 'NEW-1'), 'a new camera is not registered while limited');
    dash.close(); again.close(); cam.close();

    // installing a current licence ends it at once, no restart
    const ok = await api('/api/license', 'POST', { license: licenseFor({ payload: { serial: 'VG-T-RENEWED' } }) }, admin); assert.strictEqual(ok.status, 200);
    assert.strictEqual((await json(await api('/api/license/status', 'GET', undefined, admin))).state, 'valid');
    assert.strictEqual((await api('/api/admin/companies', 'POST', { name: 'Allowed again' }, admin)).status, 200);
});

test('"locked": dashboards close and the pages send you to the licence page, cameras and docks still deliver', async () => {
    await stop(); plant({ expires: Date.now() - 1000, graceDays: 0, afterExpiry: 'locked' }); await start(); await login();
    assert.strictEqual((await json(await api('/api/license/status', 'GET', undefined, admin))).state, 'locked');
    const page = await fetch(BASE + '/', { headers: admin, redirect: 'manual' });
    assert.strictEqual(page.status, 302); assert.strictEqual(page.headers.get('location'), '/license.html');
    const closed = await api('/api/docks', 'GET', undefined, admin);
    assert.strictEqual(closed.status, 402); assert.strictEqual((await closed.json()).code, 'license_locked');
    const dash = dashboard(); const err = await new Promise((res) => dash.on('connect_error', res)); assert.match(err.message, /license/); dash.close();
    const cam = io(BASE, { auth: { token: 'camtoken' }, transports: ['websocket'], reconnection: false });
    await new Promise((res, rej) => { cam.on('connect', res); cam.on('connect_error', rej); });     // a camera still connects
    cam.close();
    assert.strictEqual((await api('/api/dock/report', 'POST', { dockId: 'd', cameras: [] }, { 'x-dock-token': 'docktoken' })).status, 200);
    assert.strictEqual((await api('/api/license', 'GET', undefined, admin)).status, 200, 'the licence page still opens');
    assert.strictEqual((await api('/api/license', 'POST', { license: licenseFor({ payload: { serial: 'VG-T-UNLOCK' } }) }, admin)).status, 200);
    assert.strictEqual((await api('/api/docks', 'GET', undefined, admin)).status, 200, 'open again');
    const d2 = dashboard(); await new Promise((res) => d2.on('dashboard_snapshot', res)); d2.close();
});
