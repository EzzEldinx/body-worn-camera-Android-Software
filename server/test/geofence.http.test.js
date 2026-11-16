// Geofencing end to end against a real server: who may draw zones, company separation, and a camera's GPS stream turning into an alert on the dashboard socket.
// Run: node --test test/geofence.http.test.js
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');

const PORT = 3812, BASE = `http://127.0.0.1:${PORT}`;
let proc, dir, admin, mgrA, viewerA, mgrB, coA, coB, cam, dash;
const api = (p, method = 'GET', body, headers = {}) => fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await wait(50); } };
const signIn = async (username, password) => { const l = await json(await api('/api/mobile/login', 'POST', { username, password })); assert.ok(l.token); return { authorization: `Bearer ${l.token}`, token: l.token }; };

const C = { lat: 24.7136, lng: 46.6753 };
const at = (m) => ({ lat: C.lat + m / 111320, lng: C.lng });

test.before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-geo-'));
    proc = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), stdio: 'pipe',
        env: { ...process.env, PORT, FLV_PORT: 8812, RTMP_PORT: 1812, DATA_DIR: dir, ADMIN_PASSWORD: 'geo-test-pw', BWC_TOKEN: 'camtoken', STREAM_SECRET: 's', DOCK_TOKEN: 'docktoken', GEOFENCE_DEBOUNCE_MS: '300' } });
    await new Promise((res, rej) => { proc.stdout.on('data', (d) => /Dashboard is running/.test(String(d)) && res()); proc.on('exit', () => rej(new Error('server exited'))); setTimeout(() => rej(new Error('server start timeout')), 15000); });
    admin = await signIn('admin', 'geo-test-pw');
});
test.after(() => { cam?.close(); dash?.close(); proc?.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

const zone = (o = {}) => ({ name: 'Site', kind: 'zone', shape: { type: 'circle', ...C, r: 100 }, onExit: true, ...o });

test('setup: two companies, a manager and a read-only viewer in the first', async () => {
    coA = (await json(await api('/api/admin/companies', 'POST', { name: 'Alpha' }, admin))).id;
    coB = (await json(await api('/api/admin/companies', 'POST', { name: 'Beta' }, admin))).id;
    for (const [co, u, role] of [[coA, 'mgr.a', 'manager'], [coA, 'view.a', 'viewer'], [coB, 'mgr.b', 'manager']]) await api(`/api/admin/companies/${co}/users`, 'POST', { username: u, password: 'a-good-password-1', role }, admin);
    mgrA = await signIn('mgr.a', 'a-good-password-1'); viewerA = await signIn('view.a', 'a-good-password-1'); mgrB = await signIn('mgr.b', 'a-good-password-1');
    assert.strictEqual((await api('/api/geofences')).status, 401, 'signed out');
});

test('a manager draws a zone; a viewer can read but not change; another company sees nothing', async () => {
    const made = await json(await api('/api/geofences', 'POST', zone(), mgrA));
    assert.strictEqual(made.status, 201); assert.strictEqual(made.zone.companyId, coA); assert.strictEqual(made.zone.name, 'Site');
    const list = await json(await api('/api/geofences', 'GET', undefined, viewerA));
    assert.strictEqual(list.zones.length, 1); assert.strictEqual(list.canEdit, false);
    assert.strictEqual((await api('/api/geofences', 'POST', zone(), viewerA)).status, 403);
    assert.strictEqual((await api(`/api/geofences/${made.zone.id}`, 'PUT', { name: 'x' }, viewerA)).status, 403);
    assert.strictEqual((await json(await api('/api/geofences', 'GET', undefined, mgrB))).zones.length, 0, 'Beta does not see Alpha zones');
    assert.strictEqual((await api(`/api/geofences/${made.zone.id}`, 'PUT', { name: 'steal' }, mgrB)).status, 404, 'nor edit them');
    assert.strictEqual((await api(`/api/geofences/${made.zone.id}`, 'DELETE', undefined, mgrB)).status, 404);
    assert.strictEqual((await json(await api('/api/geofences', 'POST', zone({ shape: { type: 'circle', lat: 1, lng: 1, r: 1 } }), mgrA))).status, 400);
    const staff = await json(await api('/api/geofences', 'GET', undefined, admin));
    assert.strictEqual(staff.zones.length, 1, 'Smart Way staff see all');
});

test('a camera of the company leaves the zone: the dashboard gets the alert, the other company does not, and it clears on return', async () => {
    cam = io(BASE, { auth: { token: 'camtoken' }, transports: ['websocket'] });
    await new Promise((r) => cam.on('connect', r));
    cam.emit('camera_status', { cameraId: 'G-1', recording: false, battery: 80, charging: false });
    await wait(300);
    await api('/api/admin/cameras/G-1/company', 'PUT', { companyId: coA }, admin);
    const sock = (h) => io(BASE, { auth: { session: h.token }, transports: ['websocket'] });
    dash = sock(mgrA); const other = sock(mgrB); const got = [], gone = [], otherGot = [];
    dash.on('dashboard_alert', (a) => got.push(a)); dash.on('dashboard_alert_resolved', (a) => gone.push(a)); other.on('dashboard_alert', (a) => otherGot.push(a));
    await Promise.all([dash, other].map((s) => new Promise((r) => s.on('dashboard_snapshot', r))));
    const fix = (m) => cam.emit('camera_gps_update', { cameraId: 'G-1', ...at(m), acc: 5, battery: 80 });
    const hold = async (m, ms = 900) => { const t = Date.now(); while (Date.now() - t < ms) { fix(m); await wait(120); } };
    await hold(20);                       // inside
    await wait(200);
    await hold(400);                      // walks out
    await until(() => got.length);
    assert.strictEqual(got[0].kind, 'geo_exit'); assert.strictEqual(got[0].zone, 'Site'); assert.strictEqual(got[0].cameraId, 'G-1'); assert.strictEqual(got[0].ack, false);
    assert.strictEqual(otherGot.length, 0, 'Beta hears nothing');
    const snap = io(BASE, { auth: { session: mgrA.token }, transports: ['websocket'] });
    const s = await new Promise((r) => snap.on('dashboard_snapshot', r)); snap.close();
    assert.ok(s.alerts.some((a) => a.kind === 'geo_exit' && a.zone === 'Site'), 'a dashboard opened later sees it too');
    assert.strictEqual((await json(await api('/api/geofences/alerts', 'GET', undefined, mgrA))).alerts.length, 1);
    assert.strictEqual((await json(await api('/api/geofences/alerts', 'GET', undefined, mgrB))).alerts.length, 0);
    dash.emit('ack_alert', got[0].id);
    await until(() => got.length > 1 && got[got.length - 1].ack);
    await hold(10);                       // back
    await until(() => gone.length);
    assert.strictEqual(gone[0].id, got[0].id);
    other.close();
});

test('deleting a zone works for the manager and the audit log records who did what', async () => {
    const z = (await json(await api('/api/geofences', 'GET', undefined, mgrA))).zones[0];
    const st = await json(await api(`/api/geofences/${z.id}/status`, 'GET', undefined, mgrA));
    assert.strictEqual(st.status, 200); assert.deepStrictEqual(st.cameras.map((c) => c.cameraId), ['G-1']); assert.ok(st.cameras[0].why);
    assert.strictEqual((await api(`/api/geofences/${z.id}/status`, 'GET', undefined, mgrB)).status, 404, 'another company cannot ask');
    const r = await json(await api(`/api/geofences/${z.id}`, 'DELETE', undefined, mgrA));
    assert.strictEqual(r.ok, true);
    assert.strictEqual((await json(await api('/api/geofences', 'GET', undefined, mgrA))).zones.length, 0);
    const a = await json(await api('/api/audit?limit=100', 'GET', undefined, admin));
    const text = JSON.stringify(a);
    assert.match(text, /geofence_created/); assert.match(text, /geofence_removed/); assert.match(text, /geo_exit/);
});
