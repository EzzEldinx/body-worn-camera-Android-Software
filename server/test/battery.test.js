// Battery readings and the low-battery alert (below 20 % and not charging).
const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const battery = require('../battery');
const push = require('../push');

function setup() {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE cameras(id TEXT PRIMARY KEY, battery INTEGER, battery_ts INTEGER, charging INTEGER)');
    db.prepare('INSERT INTO cameras(id) VALUES(?)').run('BWC-01');
    db.prepare('INSERT INTO cameras(id) VALUES(?)').run('BWC-02');
    const cams = new Map([['BWC-01', { cameraId: 'BWC-01' }], ['BWC-02', { cameraId: 'BWC-02' }]]);
    const sent = [], audits = [], notices = [];
    let clock = 1_000_000;
    const publish = (id, patch) => { cams.set(id, { ...cams.get(id), ...patch }); sent.push([id, patch]); };
    const toCam = (id, event, data) => sent.push([id, event, data]);
    const b = battery.create({ db, cams, publish, toCam, audit: (a, id, d) => audits.push([a, id, d]), notify: (al, c) => notices.push([al, c.cameraId]), now: () => clock });
    return { db, cams, b, sent, audits, notices, tick: (ms) => { clock += ms; }, events: (name) => sent.filter((x) => x[1] === name) };
}
const all = () => true;

test('a reading is published with its source and time, and kept in the database', () => {
    const t = setup();
    assert.strictEqual(t.b.set('BWC-01', { battery: 83.4, charging: false }), true);
    assert.strictEqual(t.cams.get('BWC-01').battery, 83);
    assert.strictEqual(t.cams.get('BWC-01').batterySrc, 'camera');
    assert.strictEqual(t.cams.get('BWC-01').online, true, 'a message from the camera proves it is online');
    assert.deepStrictEqual({ ...t.db.prepare('SELECT battery,charging FROM cameras WHERE id = ?').get('BWC-01') }, { battery: 83, charging: 0 });
});

test('the same reading repeated within 30 seconds is not sent to the dashboards again', () => {
    const t = setup();
    t.b.set('BWC-01', { battery: 60, src: 'dock' });
    const n = t.sent.length;
    t.tick(2000); t.b.set('BWC-01', { battery: 60, src: 'dock' }); t.tick(2000); t.b.set('BWC-01', { battery: 60, src: 'dock' });
    assert.strictEqual(t.sent.length, n, 'the dock repeats itself every 2 s');
    t.tick(40_000); t.b.set('BWC-01', { battery: 60, src: 'dock' });
    assert.strictEqual(t.sent.length, n + 1, 'after 30 s the time of the reading is refreshed');
    t.b.set('BWC-01', { battery: 61, src: 'dock' });
    assert.strictEqual(t.sent.length, n + 2, 'a new value goes out at once');
});

test('nonsense readings and unknown cameras are ignored', () => {
    const t = setup();
    for (const v of [NaN, -1, 101, 1e9, undefined, null, '50', true, [], {}]) assert.strictEqual(t.b.set('BWC-01', { battery: v }), false, String(v));   // null must not become 0 %
    assert.strictEqual(t.b.set('NOPE', { battery: 50 }), false);
    assert.strictEqual(t.cams.get('BWC-01').battery, undefined);
});

test('the database is not written on every reading', () => {
    const t = setup();
    t.b.set('BWC-01', { battery: 80 });
    t.db.prepare('UPDATE cameras SET battery = 1 WHERE id = ?').run('BWC-01');   // if the next call wrote again we would see 80 back
    t.tick(30_000); t.b.set('BWC-01', { battery: 80 });
    assert.strictEqual(t.db.prepare('SELECT battery FROM cameras WHERE id = ?').get('BWC-01').battery, 1, 'same value within 5 minutes: not saved');
    t.b.set('BWC-01', { battery: 79 });
    assert.strictEqual(t.db.prepare('SELECT battery FROM cameras WHERE id = ?').get('BWC-01').battery, 79, 'a new value is saved');
});

test('below 20 % and not charging raises one alert, everyone is told once', () => {
    const t = setup();
    t.b.set('BWC-01', { battery: 35 }); assert.strictEqual(t.b.open(all).length, 0);
    t.b.set('BWC-01', { battery: 19 });
    const open = t.b.open(all);
    assert.strictEqual(open.length, 1); assert.strictEqual(open[0].level, 'warning'); assert.strictEqual(open[0].value, 19); assert.strictEqual(open[0].cameraId, 'BWC-01');
    t.b.set('BWC-01', { battery: 18 }); t.b.set('BWC-01', { battery: 17 });
    assert.strictEqual(t.events('dashboard_alert').length, 1, 'no repeat while it keeps falling');
    assert.strictEqual(t.notices.length, 1);
    assert.deepStrictEqual(t.audits.map((a) => a[0]), ['battery_low']);
});

test('exactly 20 % is fine, 19 % is not', () => {
    const t = setup();
    t.b.set('BWC-01', { battery: 20 }); assert.strictEqual(t.b.open(all).length, 0);
    t.b.set('BWC-01', { battery: 19 }); assert.strictEqual(t.b.open(all).length, 1);
});

test('a camera on a charger never alarms, and charging clears an open alert', () => {
    const t = setup();
    t.b.set('BWC-01', { battery: 8, charging: true }); assert.strictEqual(t.b.open(all).length, 0);
    t.b.set('BWC-02', { battery: 8, charging: false }); assert.strictEqual(t.b.open(all).length, 1);
    t.b.set('BWC-02', { battery: 9, charging: true });
    assert.strictEqual(t.b.open(all).length, 0);
    assert.strictEqual(t.events('dashboard_alert_resolved').length, 1);
    assert.strictEqual(t.db.prepare('SELECT resolved_by FROM alerts').get().resolved_by, 'charging');
});

test('a reading from the dock counts as charging', () => {
    const t = setup();
    t.b.set('BWC-01', { battery: 12, charging: false });
    assert.strictEqual(t.b.open(all).length, 1);
    t.b.set('BWC-01', { battery: 12, src: 'dock' });
    assert.strictEqual(t.b.open(all).length, 0);
    assert.strictEqual(t.cams.get('BWC-01').batterySrc, 'dock'); assert.strictEqual(t.cams.get('BWC-01').charging, true);
    t.b.set('BWC-02', { battery: 5, src: 'dock' }); assert.strictEqual(t.b.open(all).length, 0, 'docked and low is not an alert');
});

test('it clears only when the battery is back above 25 %, so 19-21 % does not flap', () => {
    const t = setup();
    t.b.set('BWC-01', { battery: 19 });
    t.b.set('BWC-01', { battery: 21 }); t.b.set('BWC-01', { battery: 24 });
    assert.strictEqual(t.b.open(all).length, 1, 'still open between 20 and 25');
    t.b.set('BWC-01', { battery: 19 }); assert.strictEqual(t.events('dashboard_alert').length, 1, 'no second alert for the same dip');
    t.b.set('BWC-01', { battery: 25 });
    assert.strictEqual(t.b.open(all).length, 0);
    t.b.set('BWC-01', { battery: 15 });
    assert.strictEqual(t.b.open(all).length, 1, 'a new dip is a new alert');
    assert.strictEqual(t.db.prepare('SELECT COUNT(*) n FROM alerts').get().n, 2);
});

test('below 10 % it becomes critical and rings again even if it was acknowledged', () => {
    const t = setup();
    t.b.set('BWC-01', { battery: 15 });
    const id = t.b.open(all)[0].id;
    assert.strictEqual(t.b.ack(id, 'ops', all), true);
    assert.strictEqual(t.b.open(all)[0].ack, true);
    t.b.set('BWC-01', { battery: 9 });
    const a = t.b.open(all)[0];
    assert.strictEqual(a.level, 'critical'); assert.strictEqual(a.ack, false); assert.strictEqual(a.value, 9);
    assert.strictEqual(t.notices.length, 2);
    assert.deepStrictEqual(t.audits.map((x) => x[0]), ['battery_low', 'battery_critical']);
});

test('people only see and acknowledge alerts of cameras they may see', () => {
    const t = setup();
    t.b.set('BWC-01', { battery: 10 }); t.b.set('BWC-02', { battery: 10 });
    const mine = (id) => id === 'BWC-01';
    assert.deepStrictEqual(t.b.open(mine).map((a) => a.cameraId), ['BWC-01']);
    const other = t.b.open(all).find((a) => a.cameraId === 'BWC-02');
    assert.strictEqual(t.b.ack(other.id, 'x', mine), false);
});

test('removing a camera closes its alert', () => {
    const t = setup();
    t.b.set('BWC-01', { battery: 10 }); t.b.forget('BWC-01');
    assert.strictEqual(t.b.open(all).length, 0);
    assert.strictEqual(t.db.prepare('SELECT resolved_by FROM alerts').get().resolved_by, 'removed');
});

test('the push notice says which camera and how low', () => {
    const m = push.buildAlertMessage('tok', 'android', { id: 4, cameraId: 'BWC-03', level: 'critical', value: 7, ts: 1 }, 'Front gate');
    assert.match(m.notification.title, /Battery critical: Front gate/); assert.match(m.notification.body, /7%/);
    assert.strictEqual(m.data.type, 'battery'); assert.strictEqual(m.android.priority, 'HIGH');
    assert.strictEqual(push.buildAlertMessage('t', 'ios', { id: 1, cameraId: 'x', level: 'warning', value: 18, ts: 1 }, 'x').apns.headers['apns-priority'], '5');
});
