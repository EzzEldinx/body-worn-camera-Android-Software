// The check-out rules: which camera is ready, who gets it, and how a shift starts and ends by itself when the camera leaves and returns to the dock.
const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const checkoutMod = require('../checkout');

function setup(opts = {}) {
    const db = new DatabaseSync(':memory:');
    db.exec(`
        CREATE TABLE cameras(id TEXT PRIMARY KEY, holder TEXT, holder_src TEXT, holder_prev TEXT);
        CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, role TEXT);
        CREATE TABLE assignments(
            id INTEGER PRIMARY KEY AUTOINCREMENT, camera_id TEXT NOT NULL, user_id INTEGER, username TEXT NOT NULL, name TEXT NOT NULL, employee_no TEXT, company_id INTEGER,
            status TEXT NOT NULL, issued_ts INTEGER NOT NULL, hold_until INTEGER, picked_ts INTEGER, returned_ts INTEGER,
            dock_id TEXT, slot INTEGER, battery_out INTEGER, battery_in INTEGER, ended_by TEXT, note TEXT);`);
    const cams = new Map(), docked = new Map(), told = [], audits = [], published = [];
    const addCam = (id, extra = {}) => { db.prepare('INSERT INTO cameras(id) VALUES(?)').run(id); cams.set(id, { cameraId: id, name: id, companyId: 1, online: true, ...extra }); };
    const dockIn = (id, extra = {}) => docked.set(id, { dockId: 'dock-1', slot: Number(id.slice(-1)) - 1, state: 'synced', battery: 90, ...extra });
    const dock = { docked: () => docked, anyDockOnline: () => dockUp.on };
    const dockUp = { on: true };
    const publish = (id, patch) => { cams.set(id, { ...cams.get(id), ...patch }); published.push([id, patch]); };
    const co = checkoutMod.create({ db, cams, publish, dock, audit: (u, a, c, d) => audits.push([u, a, c, d]), tellCamera: (id, e, p) => told.push([id, e, p]), ...opts });
    return { db, cams, docked, dockUp, addCam, dockIn, co, told, audits, published };
}
const ahmed = { id: 7, username: 'ahassan', name: 'Ahmed Hassan', employeeNo: '0147', companyId: 1 };
const sara = { id: 8, username: 'sara', name: 'Sara Ali', employeeNo: '0200', companyId: 1 };
const T0 = 1_000_000_000_000;

test('a docked, charged, idle camera is ready; the others say why not', () => {
    const t = setup();
    for (const n of ['BWC-1', 'BWC-2', 'BWC-3', 'BWC-4', 'BWC-5', 'BWC-6']) t.addCam(n);
    t.dockIn('BWC-1'); t.dockIn('BWC-2', { battery: 12 });
    t.dockIn('BWC-3', { state: 'offloading', progress: { index: 2, total: 9 } }); t.dockIn('BWC-4', { state: 'updating' }); t.dockIn('BWC-5', { state: 'error', message: 'upload failed' });
    // BWC-6 is not on a dock at all
    const r = t.co.readiness(ahmed, T0);
    assert.deepStrictEqual(r.ready.map((x) => x.cameraId), ['BWC-1']);
    const why = Object.fromEntries(r.notReady.map((x) => [x.cameraId, x.reason]));
    assert.deepStrictEqual(why, { 'BWC-2': 'charging', 'BWC-3': 'copying', 'BWC-4': 'updating', 'BWC-5': 'attention' });
    assert.match(r.notReady.find((x) => x.cameraId === 'BWC-2').note, /12%.*30%/);
    assert.match(r.notReady.find((x) => x.cameraId === 'BWC-3').note, /2 of 9/);
    assert.strictEqual(r.suggested, 'BWC-1');
});

test('a company only sees its own cameras', () => {
    const t = setup();
    t.addCam('BWC-1'); t.addCam('BWC-2', { companyId: 2 });
    t.dockIn('BWC-1'); t.dockIn('BWC-2');
    assert.deepStrictEqual(t.co.readiness(ahmed, T0).ready.map((x) => x.cameraId), ['BWC-1']);
    assert.deepStrictEqual(t.co.readiness({ ...ahmed, companyId: null }, T0).ready.map((x) => x.cameraId).sort(), ['BWC-1', 'BWC-2'], 'Smart Way staff see every company');
});

test('the best camera comes first: the one you used last, then online, then the fullest battery', () => {
    const t = setup();
    for (const n of ['BWC-1', 'BWC-2', 'BWC-3']) t.addCam(n);
    t.dockIn('BWC-1', { battery: 70 }); t.dockIn('BWC-2', { battery: 99 }); t.dockIn('BWC-3', { battery: 95 });
    assert.strictEqual(t.co.readiness(ahmed, T0).suggested, 'BWC-2', 'fullest battery');
    t.cams.get('BWC-2').online = false;
    assert.strictEqual(t.co.readiness(ahmed, T0).suggested, 'BWC-3', 'an online camera beats an offline one');
    t.db.prepare("INSERT INTO assignments(camera_id,user_id,username,name,status,issued_ts) VALUES('BWC-1',7,'ahassan','Ahmed Hassan','returned',1)").run();
    assert.strictEqual(t.co.readiness(ahmed, T0).suggested, 'BWC-1', 'your own camera from last time, if it is ready');
    assert.strictEqual(t.co.readiness(sara, T0).suggested, 'BWC-3', 'somebody else is not affected');
});

test('issuing reserves the camera, puts the name on it and tells the camera', () => {
    const t = setup();
    t.addCam('BWC-1'); t.dockIn('BWC-1', { slot: 3 });
    const r = t.co.issue(ahmed, null, T0);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.assignment.cameraId, 'BWC-1'); assert.strictEqual(r.assignment.status, 'reserved'); assert.strictEqual(r.assignment.slot, 3);
    assert.strictEqual(r.assignment.holdUntil, T0 + 10 * 60000);
    assert.strictEqual(t.cams.get('BWC-1').holder, 'Ahmed Hassan'); assert.strictEqual(t.cams.get('BWC-1').holderNo, '0147'); assert.strictEqual(t.cams.get('BWC-1').custody, 'reserved');
    assert.strictEqual(t.db.prepare('SELECT holder_src FROM cameras').get().holder_src, 'checkout');
    const msg = t.told.at(-1);
    assert.strictEqual(msg[0], 'BWC-1'); assert.strictEqual(msg[1], 'assignment');
    assert.deepStrictEqual({ a: msg[2].active, u: msg[2].username, no: msg[2].employeeNo, n: msg[2].name }, { a: true, u: 'ahassan', no: '0147', n: 'Ahmed Hassan' });
    assert.ok(msg[2].serverTime > 0, 'the camera gets the server time to correct its clock');
    assert.strictEqual(t.audits.at(-1)[1], 'camera_checkout'); assert.strictEqual(t.audits.at(-1)[0], 'ahassan');
});

test('two people cannot get the same camera, and one person holds one camera', () => {
    const t = setup();
    t.addCam('BWC-1'); t.addCam('BWC-2'); t.dockIn('BWC-1', { battery: 99 }); t.dockIn('BWC-2', { battery: 80 });
    assert.strictEqual(t.co.issue(ahmed, null, T0).assignment.cameraId, 'BWC-1');
    assert.strictEqual(t.co.issue(sara, 'BWC-1', T0).status, 409, 'asked for the one Ahmed has');
    assert.strictEqual(t.co.issue(sara, null, T0).assignment.cameraId, 'BWC-2', 'she gets the next one');
    assert.strictEqual(t.co.issue(ahmed, null, T0).already, true, 'asking again returns the same reservation');
    assert.strictEqual(t.db.prepare('SELECT COUNT(*) n FROM assignments').get().n, 2);
});

test('with no camera ready or no dock online nothing is issued', () => {
    const t = setup();
    t.addCam('BWC-1'); t.dockIn('BWC-1', { battery: 5 });
    assert.match(t.co.issue(ahmed, null, T0).error, /No camera is ready/);
    t.dockIn('BWC-1'); t.dockUp.on = false;
    const r = t.co.issue(ahmed, null, T0); assert.strictEqual(r.status, 503); assert.match(r.error, /offline/);
});

test('a camera that is picked up becomes "in use" only after it has really been gone for a while', () => {
    const t = setup();
    t.addCam('BWC-1'); t.dockIn('BWC-1'); t.co.issue(ahmed, null, T0);
    t.docked.delete('BWC-1');
    t.co.sweep(T0 + 5_000); t.co.sweep(T0 + 15_000);
    assert.strictEqual(t.co.current('BWC-1').status, 'reserved', 'a USB hiccup is not a shift');
    t.dockIn('BWC-1'); t.co.sweep(T0 + 18_000);
    t.docked.delete('BWC-1');
    t.co.sweep(T0 + 30_000); assert.strictEqual(t.co.current('BWC-1').status, 'reserved');
    t.co.sweep(T0 + 60_000);
    const a = t.co.current('BWC-1');
    assert.strictEqual(a.status, 'in_use'); assert.strictEqual(a.pickedTs, T0 + 60_000);
    assert.strictEqual(t.cams.get('BWC-1').custody, 'in_use');
    assert.strictEqual(t.audits.at(-1)[1], 'camera_picked_up');
});

test('nothing is decided while the dock itself is offline', () => {
    const t = setup();
    t.addCam('BWC-1'); t.dockIn('BWC-1'); t.co.issue(ahmed, null, T0);
    t.docked.delete('BWC-1'); t.dockUp.on = false;
    t.co.sweep(T0 + 120_000);
    assert.strictEqual(t.co.current('BWC-1').status, 'reserved');
});

test('a camera back on the dock ends the shift by itself and clears the name', () => {
    const t = setup();
    t.addCam('BWC-1'); t.dockIn('BWC-1'); t.co.issue(ahmed, null, T0);
    t.docked.delete('BWC-1'); t.co.sweep(T0 + 40_000);                         // taken
    t.co.sweep(T0 + 3_600_000);
    assert.strictEqual(t.co.current('BWC-1').status, 'in_use', 'still out');
    t.dockIn('BWC-1', { battery: 41 });
    t.co.sweep(T0 + 7_200_000); assert.strictEqual(t.co.current('BWC-1').status, 'in_use', 'just arrived');
    t.co.sweep(T0 + 7_225_000);
    assert.strictEqual(t.co.current('BWC-1'), undefined, 'no open shift any more');
    const row = t.db.prepare('SELECT * FROM assignments').get();
    assert.strictEqual(row.status, 'returned'); assert.strictEqual(row.ended_by, 'dock'); assert.strictEqual(row.battery_in, 41); assert.strictEqual(row.battery_out, 90);
    assert.strictEqual(t.cams.get('BWC-1').holder, ''); assert.strictEqual(t.cams.get('BWC-1').custody, null);
    assert.strictEqual(t.told.at(-1)[2].active, false);
    assert.strictEqual(t.audits.at(-1)[1], 'camera_returned'); assert.ok(t.audits.at(-1)[3].minutesOut >= 119);
    // and the camera is free for the next person
    assert.strictEqual(t.co.issue(sara, null, T0 + 7_300_000).assignment.cameraId, 'BWC-1');
});

test('a reservation nobody uses lapses after the hold time', () => {
    const t = setup();
    t.addCam('BWC-1'); t.dockIn('BWC-1'); t.co.issue(ahmed, null, T0);
    t.co.sweep(T0 + 9 * 60000); assert.strictEqual(t.co.current('BWC-1').status, 'reserved');
    t.co.sweep(T0 + 11 * 60000);
    assert.strictEqual(t.co.current('BWC-1'), undefined);
    const row = t.db.prepare('SELECT * FROM assignments').get();
    assert.strictEqual(row.status, 'cancelled'); assert.strictEqual(row.ended_by, 'timeout');
    assert.strictEqual(t.cams.get('BWC-1').holder, '');
    assert.strictEqual(t.audits.at(-1)[1], 'checkout_cancelled');
});

test('a name an administrator typed by hand comes back when the shift ends', () => {
    const t = setup();
    t.addCam('BWC-1'); t.dockIn('BWC-1');
    t.db.prepare("UPDATE cameras SET holder = 'Gate 3' WHERE id = 'BWC-1'").run(); t.cams.get('BWC-1').holder = 'Gate 3';
    t.co.issue(ahmed, null, T0);
    assert.strictEqual(t.cams.get('BWC-1').holder, 'Ahmed Hassan', 'the employee owns the name while the shift lasts');
    t.co.giveBack(ahmed);
    assert.strictEqual(t.cams.get('BWC-1').holder, 'Gate 3'); assert.strictEqual(t.db.prepare('SELECT holder, holder_src, holder_prev FROM cameras').get().holder, 'Gate 3');
    assert.strictEqual(t.db.prepare('SELECT holder_src FROM cameras').get().holder_src, null);
    // a second shift in a row must not remember "Ahmed Hassan" as the hand-typed name
    t.co.issue(sara, null, T0 + 1000); t.co.giveBack(sara);
    assert.strictEqual(t.cams.get('BWC-1').holder, 'Gate 3');
    // and a camera with no hand-typed name ends up with none
    t.addCam('BWC-2'); t.dockIn('BWC-2'); t.co.issue(ahmed, 'BWC-2', T0); t.co.giveBack(ahmed);
    assert.strictEqual(t.cams.get('BWC-2').holder, '');
});

test('the employee can close the shift at the station, a supervisor can close any shift', () => {
    const t = setup();
    t.addCam('BWC-1'); t.dockIn('BWC-1'); t.addCam('BWC-2'); t.dockIn('BWC-2');
    t.co.issue(ahmed, 'BWC-1', T0); t.co.issue(sara, 'BWC-2', T0);
    assert.deepStrictEqual(t.co.giveBack(ahmed), { ok: true });
    assert.strictEqual(t.co.giveBack(ahmed).status, 404);
    assert.strictEqual(t.co.current('BWC-1'), undefined);
    const id = t.co.current('BWC-2').id;
    assert.strictEqual(t.co.end(id, 'admin:boss', 'left the company'), true);
    assert.strictEqual(t.co.end(id, 'admin:boss'), false, 'already closed');
    assert.strictEqual(t.db.prepare('SELECT ended_by, note FROM assignments WHERE id = ?').get(id).ended_by, 'admin:boss');
    assert.strictEqual(t.audits.at(-1)[0], 'boss');
});

test('lists are scoped to the cameras the viewer may see and can be filtered', () => {
    const t = setup();
    t.addCam('BWC-1'); t.addCam('BWC-2', { companyId: 2 }); t.dockIn('BWC-1'); t.dockIn('BWC-2');
    t.co.issue(ahmed, 'BWC-1', T0); t.co.issue({ ...sara, companyId: 2 }, 'BWC-2', T0);
    assert.strictEqual(t.co.list({ status: 'open' }).length, 2);
    assert.deepStrictEqual(t.co.list({ status: 'open' }, (id) => id === 'BWC-1').map((x) => x.cameraId), ['BWC-1']);
    assert.strictEqual(t.co.list({ user: '0147' }).length, 1, 'by employee number');
    assert.strictEqual(t.co.list({ user: 'ahassan' }).length, 1, 'by username');
    assert.strictEqual(t.co.list({ camera: 'BWC-2' })[0].username, 'sara');
    assert.strictEqual(t.co.list({ from: T0 + 1 }).length, 0);
});

test('the gauge counts cameras on duty and ready, and only exists once the feature is in use', () => {
    const t = setup();
    for (const n of ['BWC-1', 'BWC-2', 'BWC-3']) t.addCam(n);
    t.dockIn('BWC-1'); t.dockIn('BWC-2'); t.dockIn('BWC-3', { battery: 10 });
    const all = [...t.cams.values()];
    assert.strictEqual(t.co.summary(all), null, 'no employees yet: no gauge');
    t.db.prepare("INSERT INTO users(id,username,role) VALUES(7,'ahassan','officer')").run();
    assert.deepStrictEqual(t.co.summary(all), { out: 0, total: 3, ready: 2 });
    t.co.issue(ahmed, 'BWC-1', T0);
    assert.deepStrictEqual(t.co.summary(all), { out: 1, total: 3, ready: 1 });
});

test('after a restart every open shift puts its name back on the camera', () => {
    const t = setup();
    t.addCam('BWC-1'); t.dockIn('BWC-1'); t.co.issue(ahmed, null, T0);
    t.cams.set('BWC-1', { cameraId: 'BWC-1', name: 'BWC-1', companyId: 1 });           // state lost
    t.co.restore();
    assert.strictEqual(t.cams.get('BWC-1').holder, 'Ahmed Hassan'); assert.strictEqual(t.cams.get('BWC-1').custody, 'reserved');
});

test('settings are validated and used', () => {
    const t = setup();
    assert.deepStrictEqual(t.co.settings(), { minBattery: 30, holdMinutes: 10 });
    assert.match(t.co.setSettings({ minBattery: 101 }).error, /percentage/);
    assert.match(t.co.setSettings({ holdMinutes: 0 }).error, /between 1 and 120/);
    assert.deepStrictEqual(t.co.setSettings({ minBattery: 60, holdMinutes: 3 }).settings, { minBattery: 60, holdMinutes: 3 });
    t.addCam('BWC-1'); t.dockIn('BWC-1', { battery: 55 });
    assert.strictEqual(t.co.readiness(ahmed, T0).ready.length, 0, '55% is under the new minimum of 60%');
    t.dockIn('BWC-1', { battery: 61 });
    assert.strictEqual(t.co.issue(ahmed, null, T0).assignment.holdUntil, T0 + 3 * 60000);
});
