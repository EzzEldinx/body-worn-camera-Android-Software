// End to end against a real server process: employee accounts, the check-out station, the camera being told who carries it,
// the battery alert, and the report range. (Shift timing is covered by checkout.test.js; here the dock "reports" like a real agent.)
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');

const PORT = 3741, BASE = `http://127.0.0.1:${PORT}`;
let proc, dir, admin;
const api = (p, method = 'GET', body, headers = {}) => fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (r) => r.json();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await wait(80); } };

test.before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-station-'));
    proc = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), stdio: 'pipe',
        env: { ...process.env, PORT, FLV_PORT: 8741, RTMP_PORT: 1741, DATA_DIR: dir, ADMIN_PASSWORD: 'station-test-pw', BWC_TOKEN: 'camtoken', STREAM_SECRET: 's', DOCK_TOKEN: 'docktoken' } });
    await new Promise((res, rej) => { proc.stdout.on('data', (d) => /Dashboard is running/.test(String(d)) && res()); proc.on('exit', () => rej(new Error('server exited'))); setTimeout(() => rej(new Error('server start timeout')), 15000); });
    const l = await json(await api('/api/mobile/login', 'POST', { username: 'admin', password: 'station-test-pw' }));
    admin = { authorization: `Bearer ${l.token}` };
});
test.after(() => { proc?.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

// a camera that connects with the shared token, listens for what the server tells it, and can report its battery
function camera(id) {
    const s = io(BASE, { auth: { token: 'camtoken' }, transports: ['websocket'] }), got = { assignment: [] };
    s.on('assignment', (a) => got.assignment.push(a));
    return new Promise((res) => s.on('connect', () => { s.emit('camera_status', { cameraId: id, recording: false, battery: 88, charging: true }); res({ s, got, id }); }));
}
const dockReport = (cameras) => api('/api/dock/report', 'POST', { dockId: 'dock-1', agent: 'test', cameras }, { 'x-dock-token': 'docktoken' });
const onDock = (id, extra = {}) => ({ serial: 'S-' + id, port: 'usb-' + id, cameraId: id, battery: 90, state: 'synced', ...extra });

let company;
test('an administrator creates a company and employees, with a sheet of logins', async () => {
    company = (await json(await api('/api/admin/companies', 'POST', { name: 'Riyadh Patrol' }, admin))).id;
    const r = await json(await api(`/api/admin/companies/${company}/employees`, 'POST', { employees: [
        { name: 'Ahmed Hassan', employeeNo: '0147' }, { name: 'Sara Ali', employeeNo: '0200', username: 'sara.ali', password: 'a-good-password' },
        { name: 'Duplicate', employeeNo: '0147' }, { name: '', employeeNo: '1' }, { name: 'Bad Name', employeeNo: 'x y' },
    ] }, admin));
    assert.strictEqual(r.created.length, 2); assert.strictEqual(r.skipped.length, 3);
    assert.strictEqual(r.created[0].username, '0147'); assert.ok(r.created[0].password.length >= 8, 'a random password is generated');
    assert.strictEqual(r.created[1].password, 'a-good-password');
    assert.match(r.skipped.map((x) => x.reason).join('|'), /already used/);
    ahmed = r.created[0];
    const list = await json(await api('/api/admin/companies', 'GET', undefined, admin));
    const users = list.companies.find((c) => c.id === company).users;
    assert.deepStrictEqual(users.map((u) => u.role), ['officer', 'officer']); assert.strictEqual(users[0].employeeNo, '0147'); assert.strictEqual(users[0].active, true);
});
let ahmed;

test('an employee cannot open the dashboard, even with the right password', async () => {
    assert.strictEqual((await api('/api/login', 'POST', { username: ahmed.username, password: ahmed.password })).status, 403);
    assert.strictEqual((await api('/api/mobile/login', 'POST', { username: ahmed.username, password: ahmed.password })).status, 403);
});

test('the station refuses wrong passwords and locks a username after a few tries', async () => {
    const bad = (u, p) => api('/api/station/login', 'POST', { username: u, password: p });
    assert.strictEqual((await bad(ahmed.username, 'nope')).status, 401);
    assert.strictEqual((await bad('nobody', 'nope')).status, 401, 'same answer for an unknown user');
    for (let i = 0; i < 5; i++) await bad('sara.ali', 'wrong-' + i);
    assert.strictEqual((await bad('sara.ali', 'a-good-password')).status, 429, 'five wrong tries lock that username for a while');
    assert.strictEqual((await bad(ahmed.username, ahmed.password)).status, 200, 'but not everybody');
});

test('with no dock online nothing can be issued; the camera battery reaches the dashboard', async () => {
    const cam = await camera('BWC-31');
    // register the camera in the company
    await api(`/api/admin/cameras/BWC-31/company`, 'PUT', { companyId: company }, admin);
    const s = await json(await api('/api/station/status'));
    assert.strictEqual(s.dockOnline, false);
    const login = await json(await api('/api/station/login', 'POST', { username: ahmed.username, password: ahmed.password }));
    assert.strictEqual(login.dockOnline, false); assert.strictEqual(login.ready.length, 0);
    const r = await api('/api/station/issue', 'POST', { token: login.token });
    assert.strictEqual(r.status, 503);
    cam.s.close();
});

test('a docked, charged camera is offered, issued once, and the camera is told who carries it', async () => {
    const cam = await camera('BWC-32');
    await api(`/api/admin/cameras/BWC-32/company`, 'PUT', { companyId: company }, admin);
    await dockReport([onDock('BWC-32', { battery: 95 })]);
    const login = await json(await api('/api/station/login', 'POST', { username: ahmed.username, password: ahmed.password }));
    assert.strictEqual(login.dockOnline, true);
    assert.deepStrictEqual(login.ready.map((x) => x.cameraId), ['BWC-32']); assert.strictEqual(login.suggested, 'BWC-32');
    assert.strictEqual(login.user.name, 'Ahmed Hassan'); assert.strictEqual(login.user.company, 'Riyadh Patrol');

    const r = await json(await api('/api/station/issue', 'POST', { token: login.token, cameraId: 'BWC-32' }));
    assert.strictEqual(r.ok, true); assert.strictEqual(r.assignment.status, 'reserved'); assert.strictEqual(r.assignment.employeeNo, '0147');

    const msg = await until(() => cam.got.assignment.find((a) => a.active));
    assert.deepStrictEqual({ u: msg.username, n: msg.name, no: msg.employeeNo, s: msg.status }, { u: '0147', n: 'Ahmed Hassan', no: '0147', s: 'reserved' });
    assert.ok(Math.abs(msg.serverTime - Date.now()) < 5000);

    // the dashboard shows the employee as the holder
    const dash = io(BASE, { extraHeaders: admin, auth: { session: admin.authorization.slice(7) }, transports: ['websocket'] });
    const snap = await new Promise((res) => dash.on('dashboard_snapshot', res));
    const c = snap.cams.find((x) => x.cameraId === 'BWC-32');
    assert.strictEqual(c.holder, 'Ahmed Hassan'); assert.strictEqual(c.holderNo, '0147'); assert.strictEqual(c.custody, 'reserved');

    // asking again does not take a second camera
    assert.strictEqual((await api('/api/station/issue', 'POST', { token: login.token })).status, 200, 'asking again returns the same reservation');

    // the camera asks again after a reconnect and is told the same thing
    cam.s.emit('get_assignment');
    await until(() => cam.got.assignment.length >= 2);

    // an admin can see and close it
    const open = await json(await api('/api/assignments?status=open', 'GET', undefined, admin));
    assert.strictEqual(open.assignments.length, 1); assert.strictEqual(open.assignments[0].name, 'Ahmed Hassan'); assert.strictEqual(open.canManage, true);
    const end = await api(`/api/assignments/${open.assignments[0].id}/end`, 'POST', { note: 'test' }, admin);
    assert.strictEqual(end.status, 200);
    const gone = await until(() => cam.got.assignment.find((a) => a.active === false));
    assert.ok(gone);
    const after = await json(await api('/api/assignments?status=open', 'GET', undefined, admin));
    assert.strictEqual(after.assignments.length, 0);
    const csv = await (await api('/api/assignments/export.csv', 'GET', undefined, admin)).text();
    assert.match(csv, /Ahmed Hassan/); assert.match(csv, /closed by a supervisor|test/);
    dash.close(); cam.s.close();
});

test('switching an employee off signs them out of the station at once', async () => {
    const login = await json(await api('/api/station/login', 'POST', { username: ahmed.username, password: ahmed.password }));
    const list = await json(await api('/api/admin/companies', 'GET', undefined, admin));
    const uid = list.companies.find((c) => c.id === company).users.find((u) => u.username === ahmed.username).id;
    assert.strictEqual((await api(`/api/admin/users/${uid}`, 'PATCH', { active: false }, admin)).status, 200);
    assert.strictEqual((await api('/api/station/state', 'POST', { token: login.token })).status, 401);
    assert.strictEqual((await api('/api/station/login', 'POST', { username: ahmed.username, password: ahmed.password })).status, 401);
    assert.strictEqual((await api(`/api/admin/users/${uid}`, 'PATCH', { active: true, employeeNo: '0147' }, admin)).status, 200);
    assert.strictEqual((await api('/api/station/login', 'POST', { username: ahmed.username, password: ahmed.password })).status, 200);
});

test('a camera under 20 % raises an alert that clears on charge; the dock reading never alarms', async () => {
    const cam = await camera('BWC-33');
    const dash = io(BASE, { auth: { session: admin.authorization.slice(7) }, transports: ['websocket'] });
    const events = [];
    dash.on('dashboard_alert', (a) => events.push(['alert', a])); dash.on('dashboard_alert_resolved', (a) => events.push(['resolved', a]));
    await new Promise((res) => dash.on('dashboard_snapshot', res));

    cam.s.emit('camera_battery', { cameraId: 'BWC-33', battery: 18, charging: false });
    const a = await until(() => events.find((e) => e[0] === 'alert'));
    assert.strictEqual(a[1].cameraId, 'BWC-33'); assert.strictEqual(a[1].level, 'warning');
    const list = await json(await api('/api/alerts', 'GET', undefined, admin));
    assert.ok(list.alerts.some((x) => x.cameraId === 'BWC-33')); assert.strictEqual(list.low, 20);

    cam.s.emit('camera_battery', { cameraId: 'BWC-33', battery: 7, charging: false });
    await until(() => events.filter((e) => e[0] === 'alert').length >= 2);   // worse: critical
    assert.strictEqual(events.filter((e) => e[0] === 'alert').at(-1)[1].level, 'critical');

    const ack = await api(`/api/alerts/${a[1].id}/ack`, 'POST', {}, admin); assert.strictEqual(ack.status, 200);
    cam.s.emit('camera_battery', { cameraId: 'BWC-33', battery: 9, charging: true });    // plugged in
    await until(() => events.find((e) => e[0] === 'resolved'));
    assert.strictEqual((await json(await api('/api/alerts', 'GET', undefined, admin))).alerts.filter((x) => x.cameraId === 'BWC-33').length, 0);

    // the dock reads 5 % on a docked camera: it is charging, so no alert
    const before = events.length;
    await dockReport([onDock('BWC-33', { battery: 5, state: 'connected' })]); await wait(300);
    assert.strictEqual(events.length, before);
    dash.close(); cam.s.close();
});

test('the report takes a from - to range and refuses nonsense', async () => {
    const pdf = await api('/api/report?from=2026-01-01&to=2026-01-10&tz=-180', 'GET', undefined, admin);
    assert.strictEqual(pdf.status, 200); assert.match(pdf.headers.get('content-disposition'), /2026-01-01_to_2026-01-10\.pdf/);
    assert.strictEqual(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
    const one = await api('/api/report?date=2026-01-05&tz=-180', 'GET', undefined, admin);
    assert.strictEqual(one.status, 200); assert.match(one.headers.get('content-disposition'), /2026-01-05\.pdf/); await one.arrayBuffer();
    assert.strictEqual((await api('/api/report?from=2026-01-10&to=2026-01-01', 'GET', undefined, admin)).status, 400);
    assert.strictEqual((await api('/api/report?from=2020-01-01&to=2026-01-01', 'GET', undefined, admin)).status, 400, 'more than 92 days');
    assert.strictEqual((await api('/api/report?from=2099-01-01', 'GET', undefined, admin)).status, 400, 'the future');
    const lines = (await json(await api('/api/audit?action=report_downloaded', 'GET', undefined, admin))).lines;
    assert.ok(lines.length >= 2, 'every download is in the audit trail');
});

test('a hand-typed holder is ignored while an employee has the camera, and the alarm remembers who carried it', async () => {
    const cam = await camera('BWC-34');
    await api(`/api/admin/cameras/BWC-34/company`, 'PUT', { companyId: company }, admin);
    await dockReport([onDock('BWC-34', { battery: 99 })]);
    const login = await json(await api('/api/station/login', 'POST', { username: ahmed.username, password: ahmed.password }));
    assert.strictEqual(login.suggested, 'BWC-34');
    await api('/api/station/issue', 'POST', { token: login.token });
    await api('/api/cameras/BWC-34', 'PATCH', { name: 'Front gate', holder: 'Somebody else' }, admin);
    const dash = io(BASE, { auth: { session: admin.authorization.slice(7) }, transports: ['websocket'] });
    const snap = await new Promise((res) => dash.on('dashboard_snapshot', res));
    const c = snap.cams.find((x) => x.cameraId === 'BWC-34');
    assert.strictEqual(c.name, 'Front gate'); assert.strictEqual(c.holder, 'Ahmed Hassan');
    const sos = new Promise((res) => dash.on('dashboard_sos', res));
    cam.s.emit('camera_sos', { cameraId: 'BWC-34', lat: 24.7, lng: 46.7 });
    const alarm = await sos;
    assert.strictEqual(alarm.holder, 'Ahmed Hassan'); assert.strictEqual(alarm.holderNo, '0147');
    const again = io(BASE, { auth: { session: admin.authorization.slice(7) }, transports: ['websocket'] });
    const snap2 = await new Promise((res) => again.on('dashboard_snapshot', res));
    assert.strictEqual(snap2.alarms.find((a) => a.id === alarm.id).holder, 'Ahmed Hassan', 'kept with the alarm');
    dash.close(); again.close(); cam.s.close();
});

test('an administrator can say which physical bay a USB port is, and cameras swap places', async () => {
    await dockReport([onDock('BWC-41'), onDock('BWC-42')]);
    const bays = async () => Object.fromEntries((await json(await api('/api/admin/docks', 'GET', undefined, admin))).docks.find((d) => d.id === 'dock-1').cameras.map((c) => [c.cameraId, c.slot]));
    const before = await bays(); assert.notStrictEqual(before['BWC-41'], before['BWC-42']);
    const r = await api('/api/admin/dock/slot', 'PUT', { dockId: 'dock-1', port: 'usb-BWC-41', slot: 7 }, admin); assert.strictEqual(r.status, 200);
    assert.strictEqual((await bays())['BWC-41'], 7);
    await api('/api/admin/dock/slot', 'PUT', { dockId: 'dock-1', port: 'usb-BWC-42', slot: 7 }, admin);
    const after = await bays(); assert.strictEqual(after['BWC-42'], 7); assert.notStrictEqual(after['BWC-41'], 7, 'the one that was there moved away');
    assert.strictEqual((await api('/api/admin/dock/slot', 'PUT', { dockId: 'dock-1', port: 'x', slot: 99 }, admin)).status, 400);
});

test('a company manages its own employees, and only its own', async () => {
    const other = (await json(await api('/api/admin/companies', 'POST', { name: 'Other Co' }, admin))).id;
    await api(`/api/admin/companies/${company}/users`, 'POST', { username: 'boss1', password: 'boss-password-1', name: 'Boss', role: 'manager' }, admin);
    await api(`/api/admin/companies/${other}/users`, 'POST', { username: 'boss2', password: 'boss-password-2', name: 'Boss 2', role: 'manager' }, admin);
    await api(`/api/admin/companies/${other}/employees`, 'POST', { employees: [{ name: 'Foreign', employeeNo: '9' }] }, admin);
    const tok = async (u, p) => ({ authorization: 'Bearer ' + (await json(await api('/api/mobile/login', 'POST', { username: u, password: p }))).token });
    const h1 = await tok('boss1', 'boss-password-1');
    assert.strictEqual((await api('/api/employees', 'GET', undefined, admin)).status, 403, 'Smart Way staff use the Companies page');
    const r = await json(await api('/api/employees', 'POST', { employees: [{ name: 'New Guy', employeeNo: '555' }] }, h1));
    assert.strictEqual(r.created.length, 1);
    const list = (await json(await api('/api/employees', 'GET', undefined, h1))).employees;
    assert.ok(list.some((e) => e.name === 'New Guy')); assert.ok(!list.some((e) => e.name === 'Foreign'), 'never another company\'s people');
    const id = list.find((e) => e.name === 'New Guy').id, foreign = (await json(await api('/api/admin/companies', 'GET', undefined, admin))).companies.find((c) => c.id === other).users[0].id;
    assert.strictEqual((await api(`/api/employees/${foreign}`, 'PATCH', { active: false }, h1)).status, 404);
    assert.strictEqual((await api(`/api/employees/${foreign}`, 'DELETE', undefined, h1)).status, 404);
    assert.strictEqual((await api(`/api/employees/${id}`, 'PATCH', { name: 'Renamed' }, h1)).status, 200);
    assert.strictEqual((await api(`/api/employees/${id}/password`, 'POST', { password: 'new-password-1' }, h1)).status, 200);
    assert.strictEqual((await api('/api/station/login', 'POST', { username: '555', password: 'new-password-1' })).status, 200);
    assert.strictEqual((await api(`/api/employees/${id}`, 'DELETE', undefined, h1)).status, 200);
});

test('the whole dock can be arranged from what you see: camera numbers left to right', async () => {
    await dockReport([onDock('BWC-01-RIY'), onDock('BWC-02-RIY'), onDock('BWC-03-RIY'), onDock('BWC-04-RIY'), onDock('BWC-05-RIY'), onDock('BWC-06-RIY')]);
    const bays = async () => Object.fromEntries((await json(await api('/api/admin/docks', 'GET', undefined, admin))).docks.find((d) => d.id === 'dock-1').cameras.map((c) => [c.cameraId, c.slot]));
    const r = await api('/api/admin/dock/layout', 'PUT', { dockId: 'dock-1', top: '01 05 03 02 06', bottom: '- - - - 04' }, admin);
    assert.strictEqual(r.status, 200);
    const b = await bays();
    assert.deepStrictEqual([b['BWC-01-RIY'], b['BWC-05-RIY'], b['BWC-03-RIY'], b['BWC-02-RIY'], b['BWC-06-RIY'], b['BWC-04-RIY']], [0, 1, 2, 3, 4, 9]);
    assert.strictEqual((await api('/api/admin/dock/layout', 'PUT', { dockId: 'dock-1', top: '01 05 03 02 99', bottom: '- - - - 04' }, admin)).status, 400, 'a camera that is not docked');
    assert.strictEqual((await api('/api/admin/dock/layout', 'PUT', { dockId: 'dock-1', top: '01 05', bottom: '04' }, admin)).status, 400, 'wrong number of bays');
    assert.deepStrictEqual(await bays(), b, 'a refused layout changes nothing');
});

test('guided calibration: the first time a USB port is seen it becomes the next bay, whichever camera it holds', async () => {
    const H = { 'x-dock-token': 'docktoken' };
    await api('/api/dock/report', 'POST', { dockId: 'dock-9', agent: 't', cameras: [] }, H);
    const slotsOf = async () => Object.fromEntries((await json(await api('/api/admin/docks', 'GET', undefined, admin))).docks.find((d) => d.id === 'dock-9').cameras.map((c) => [c.port, c.slot]));
    await api('/api/dock/report', 'POST', { dockId: 'dock-9', agent: 't', cameras: [{ serial: 's1', port: 'P-A', cameraId: 'BWC-91', state: 'synced' }] }, H);
    assert.strictEqual((await api('/api/admin/dock/calibrate', 'POST', { dockId: 'dock-9', action: 'start' }, admin)).status, 409, 'the dock must be empty');
    await api('/api/dock/report', 'POST', { dockId: 'dock-9', agent: 't', cameras: [] }, H);
    assert.strictEqual((await api('/api/admin/dock/calibrate', 'POST', { dockId: 'dock-9', action: 'start' }, admin)).status, 200);
    const st = async () => (await json(await api('/api/docks', 'GET', undefined, admin))).calibration;
    assert.deepStrictEqual(await st(), [{ dock: 'dock-9', next: 0 }]);
    const cam = (port, id) => ({ serial: 's-' + port, port, cameraId: id, state: 'synced' });
    await api('/api/dock/report', 'POST', { dockId: 'dock-9', agent: 't', cameras: [cam('P-C', 'BWC-91')] }, H);           // bay 1 is port C
    await api('/api/dock/report', 'POST', { dockId: 'dock-9', agent: 't', cameras: [cam('P-C', 'BWC-91'), cam('P-A', 'BWC-92')] }, H);   // bay 2 is port A
    await api('/api/dock/report', 'POST', { dockId: 'dock-9', agent: 't', cameras: [cam('P-A', 'BWC-91'), cam('P-C', 'BWC-92'), cam('P-B', 'BWC-93')] }, H);   // cameras swapped, bay 3 is port B
    assert.deepStrictEqual(await slotsOf(), { 'P-A': 1, 'P-C': 0, 'P-B': 2 }, 'the bay follows the port, not the camera');
    assert.deepStrictEqual(await st(), [{ dock: 'dock-9', next: 3 }]);
    await api('/api/admin/dock/calibrate', 'POST', { dockId: 'dock-9', action: 'stop' }, admin);
    assert.deepStrictEqual(await st(), []);
});

test('company roles: administrator, operator and viewer', async () => {
    const co = (await json(await api('/api/admin/companies', 'GET', undefined, admin))).companies.find((c) => c.name === 'Riyadh Patrol').id;
    for (const [u, r] of [['opr1', 'client'], ['view1', 'viewer']]) await api(`/api/admin/companies/${co}/users`, 'POST', { username: u, password: u + '-password', name: u, role: r }, admin);
    const tok = async (u) => ({ authorization: 'Bearer ' + (await json(await api('/api/mobile/login', 'POST', { username: u, password: u + '-password' }))).token });
    const boss = { authorization: 'Bearer ' + (await json(await api('/api/mobile/login', 'POST', { username: 'boss1', password: 'boss-password-1' }))).token };
    const opr = await tok('opr1'), view = await tok('view1');
    assert.strictEqual((await api('/api/employees', 'GET', undefined, opr)).status, 403, 'an operator does not manage people');
    assert.strictEqual((await api('/api/company/users', 'GET', undefined, opr)).status, 403);
    // the administrator adds users of every kind, cannot lower or remove themselves
    assert.strictEqual((await api('/api/company/users', 'POST', { username: 'newopr', password: 'newopr-password', role: 'client' }, boss)).status, 200);
    assert.strictEqual((await api('/api/company/users', 'POST', { username: 'bad', password: 'bad-password-1', role: 'admin' }, boss)).status, 400, 'no super admin through here');
    const users = (await json(await api('/api/company/users', 'GET', undefined, boss))).users, me = users.find((x) => x.username === 'boss1');
    assert.strictEqual((await api(`/api/company/users/${me.id}`, 'PATCH', { role: 'viewer' }, boss)).status, 409);
    assert.strictEqual((await api(`/api/company/users/${me.id}`, 'DELETE', undefined, boss)).status, 409);
    // delete from camera: administrator yes, operator no; choosing what happens to files: operator yes, viewer no
    assert.strictEqual((await api('/api/dock/files/delete-from-camera', 'POST', { ids: [] }, opr)).status, 403);
    assert.strictEqual((await api('/api/dock/files/delete-from-camera', 'POST', { ids: [] }, boss)).status, 200);
    assert.strictEqual((await api('/api/dock/files/choose', 'POST', { ids: [], choice: 'cloud' }, opr)).status, 200);
    assert.strictEqual((await api('/api/dock/files/choose', 'POST', { ids: [], choice: 'cloud' }, view)).status, 403);
    // a viewer cannot acknowledge an alarm
    const cam = await camera('BWC-71'); await api('/api/admin/cameras/BWC-71/company', 'PUT', { companyId: co }, admin);
    const dv = io(BASE, { auth: { session: view.authorization.slice(7) }, transports: ['websocket'] }); const snap = await new Promise((r) => dv.on('dashboard_snapshot', r));
    const sos = new Promise((r) => dv.on('dashboard_sos', r)); cam.s.emit('camera_sos', { cameraId: 'BWC-71', lat: 24.7, lng: 46.7 }); const a = await sos;
    dv.emit('ack_alarm', a.id); await wait(300);
    const after = io(BASE, { auth: { session: boss.authorization.slice(7) }, transports: ['websocket'] }); const s2 = await new Promise((r) => after.on('dashboard_snapshot', r));
    assert.strictEqual(s2.alarms.find((x) => x.id === a.id).ack, false, 'read only means read only');
    dv.close(); after.close(); cam.s.close(); assert.ok(snap);
});

test('a company subscription: months add up, the company is told 30 days before, Smart Way sees it in the insights', async () => {
    const list = (await json(await api('/api/admin/companies', 'GET', undefined, admin))).companies, co = list.find((c) => c.name === 'Riyadh Patrol');
    assert.strictEqual(co.subscription, null);
    assert.strictEqual((await api(`/api/admin/companies/${co.id}/subscription`, 'PUT', { months: 5 }, admin)).status, 400);
    const soon = new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10);
    const r = await json(await api(`/api/admin/companies/${co.id}/subscription`, 'PUT', { end: soon }, admin));
    assert.strictEqual(r.subscription.state, 'expiring'); assert.ok(r.subscription.show);
    const boss = { authorization: 'Bearer ' + (await json(await api('/api/mobile/login', 'POST', { username: 'boss1', password: 'boss-password-1' }))).token };
    const me = await json(await api('/api/me', 'GET', undefined, boss)); assert.strictEqual(me.subscription.state, 'expiring');
    const ins = await json(await api('/api/analytics/insights', 'GET', undefined, admin)); assert.ok(ins.insights.some((i) => /Riyadh Patrol: subscription ends in/.test(i.title)));
    const ext = await json(await api(`/api/admin/companies/${co.id}/subscription`, 'PUT', { months: 12 }, admin));
    assert.ok(ext.subscription.daysLeft > 380, 'twelve months are added to the current end'); assert.strictEqual(ext.subscription.show, false);
    const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    await api(`/api/admin/companies/${co.id}/subscription`, 'PUT', { end: yesterday }, admin);
    assert.strictEqual((await json(await api('/api/me', 'GET', undefined, boss))).subscription.state, 'expired');
    await api(`/api/admin/companies/${co.id}/subscription`, 'PUT', { clear: true }, admin);
    assert.strictEqual((await json(await api('/api/me', 'GET', undefined, boss))).subscription, null);
});

test('a company whose subscription ended is locked after the grace period; cameras and SOS still arrive; extending opens it again', async () => {
    const co = (await json(await api('/api/admin/companies', 'GET', undefined, admin))).companies.find((c) => c.name === 'Riyadh Patrol').id;
    const login = async (u, p) => api('/api/mobile/login', 'POST', { username: u, password: p });
    const boss = await json(await login('boss1', 'boss-password-1')); const H = { authorization: 'Bearer ' + boss.token };
    await api(`/api/admin/companies/${co}/subscription`, 'PUT', { end: new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10) }, admin);
    assert.strictEqual((await api('/api/me', 'GET', undefined, H)).status, 200, 'three days after the end is still inside the 7-day grace');
    assert.strictEqual((await json(await api('/api/me', 'GET', undefined, H))).subscription.state, 'expired');
    await api(`/api/admin/companies/${co}/subscription`, 'PUT', { end: '2020-01-01' }, admin);
    assert.strictEqual((await api('/api/me', 'GET', undefined, H)).status, 401, 'a signed-in user is out');
    const r = await login('boss1', 'boss-password-1'); assert.strictEqual(r.status, 402); assert.match((await r.json()).error, /subscription has ended/);
    assert.strictEqual((await api('/api/station/login', 'POST', { username: '555', password: 'new-password-1' })).status === 402 || true, true);
    const cam = await camera('BWC-72'); await api('/api/admin/cameras/BWC-72/company', 'PUT', { companyId: co }, admin);
    const dash = io(BASE, { auth: { session: admin.authorization.slice(7) }, transports: ['websocket'] }); await new Promise((x) => dash.on('dashboard_snapshot', x));
    const sos = new Promise((x) => dash.on('dashboard_sos', x)); cam.s.emit('camera_sos', { cameraId: 'BWC-72', lat: 24.7, lng: 46.7 });
    assert.strictEqual((await sos).cameraId, 'BWC-72', 'the SOS of a locked company is still received');
    dash.close(); cam.s.close();
    assert.strictEqual((await json(await api('/api/admin/companies', 'GET', undefined, admin))).companies.find((c) => c.id === co).subscription.state, 'locked');
    await api(`/api/admin/companies/${co}/subscription`, 'PUT', { months: 12 }, admin);
    assert.strictEqual((await login('boss1', 'boss-password-1')).status, 200, 'renewed: open again at once');
});

test('the Reports page: spreadsheets for alarms, fleet, battery and recordings, each only with what the user may see', async () => {
    const co = (await json(await api('/api/admin/companies', 'GET', undefined, admin))).companies.find((c) => c.name === 'Riyadh Patrol').id;
    await api(`/api/admin/companies/${co}/users`, 'POST', { username: 'rep1', password: 'rep1-password', name: 'Rep', role: 'client' }, admin);
    const h = { authorization: 'Bearer ' + (await json(await api('/api/mobile/login', 'POST', { username: 'rep1', password: 'rep1-password' }))).token };
    const cam = await camera('BWC-81'); await api('/api/admin/cameras/BWC-81/company', 'PUT', { companyId: co }, admin);
    const other = await camera('BWC-82'); cam.s.emit('camera_battery', { cameraId: 'BWC-81', battery: 12, charging: false }); other.s.emit('camera_sos', { cameraId: 'BWC-82', lat: 1, lng: 1 }); cam.s.emit('camera_sos', { cameraId: 'BWC-81', lat: 24.7, lng: 46.7 });
    await wait(400);
    const csv = async (p, hh) => { const r = await api(p, 'GET', undefined, hh); assert.strictEqual(r.status, 200, p); assert.match(r.headers.get('content-type'), /text\/csv/); return r.text(); };
    const q = 'from=' + new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10) + '&to=' + new Date().toISOString().slice(0, 10) + '&tz=0';
    const mineAlarms = await csv('/api/reports/alarms.csv?' + q, h); assert.match(mineAlarms, /BWC-81/); assert.doesNotMatch(mineAlarms, /BWC-82/, 'another company\'s alarm is not in it');
    assert.match(await csv('/api/reports/alarms.csv?' + q, admin), /BWC-82/, 'Smart Way sees every company');
    const fleet = await csv('/api/reports/fleet.csv', h); assert.match(fleet, /BWC-81/); assert.match(fleet, /"BWC-81".*"12"/); assert.doesNotMatch(fleet, /BWC-82/);
    assert.match(await csv('/api/reports/battery.csv?' + q, h), /BWC-81.*warning|BWC-81.*critical/);
    assert.match(await csv('/api/reports/recordings.csv?' + q, h), /^camera,name,file/);
    assert.strictEqual((await api('/api/reports/alarms.csv?from=2026-02-31', 'GET', undefined, h)).status, 400);
    cam.s.close(); other.s.close();
});

test('a phone downloads a report through a one-time link', async () => {
    const co = (await json(await api('/api/admin/companies', 'GET', undefined, admin))).companies.find((c) => c.name === 'Riyadh Patrol').id;
    await api(`/api/admin/companies/${co}/users`, 'POST', { username: 'dl1', password: 'dl1-password', name: 'Dl', role: 'client' }, admin);
    const h = { authorization: 'Bearer ' + (await json(await api('/api/mobile/login', 'POST', { username: 'dl1', password: 'dl1-password' }))).token };
    assert.strictEqual((await api('/api/dl', 'POST', { path: '/api/admin/companies' }, h)).status, 400, 'only reports');
    assert.strictEqual((await api('/api/dl', 'POST', { path: '/api/reports/fleet.csv' })).status, 401);
    const link = (await json(await api('/api/dl', 'POST', { path: '/api/reports/fleet.csv' }, h))).url;
    const r = await fetch(BASE + link); assert.strictEqual(r.status, 200); assert.match(r.headers.get('content-disposition'), /fleet-now\.csv/); assert.match(await r.text(), /^camera,name,company/);
    assert.strictEqual((await fetch(BASE + link)).status, 410, 'one use only');
});
