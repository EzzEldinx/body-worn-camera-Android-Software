// Geofencing: geometry, schedule, debounce, exit / enter / checkpoint alerts, scope. Pure module + in-memory database, with a fake clock.
// Run: node --test test/geofence.test.js
const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const g = require('../geofence');

const CENTRE = { lat: 24.7136, lng: 46.6753 };
const at = (dLat, dLng) => ({ lat: CENTRE.lat + dLat / 111320, lng: CENTRE.lng + dLng / (111320 * Math.cos(CENTRE.lat * Math.PI / 180)) });   // metres north / east of the centre
const circle = (r = 100) => ({ type: 'circle', lat: CENTRE.lat, lng: CENTRE.lng, r });

function rig({ cams: initial = {}, now = Date.UTC(2026, 10, 16, 9, 0, 0) } = {}) {   // Mon 16 Nov 2026 09:00 UTC = 12:00 Riyadh
    const db = new DatabaseSync(':memory:');
    const t = { now };
    const cams = new Map(Object.entries({ A: { cameraId: 'A', companyId: 1, online: true, grp: 'North', region: 'Riyadh' }, B: { cameraId: 'B', companyId: 1, online: true, grp: 'South' }, X: { cameraId: 'X', companyId: 2, online: true }, ...initial }));
    const sent = [], resolved = [], notes = [], changes = [];
    const geo = g.create({
        db, cams, now: () => t.now, sweepMs: 0,
        toCam: (id, ev, d) => (ev === 'dashboard_alert' ? sent : resolved).push({ id, ...d }),
        notify: (a) => notes.push(a), changed: (c) => changes.push(c),
    });
    const step = (ms) => { t.now += ms; };
    // walk a camera to a place: two fixes more than the debounce apart, like a real stream
    const walk = (id, p, { acc = 5, secs = 40 } = {}) => { geo.position(id, p.lat, p.lng, { acc, ts: t.now }); step(secs * 500); geo.position(id, p.lat, p.lng, { acc, ts: t.now }); step(secs * 500); geo.position(id, p.lat, p.lng, { acc, ts: t.now }); };
    return { db, geo, cams, t, sent, resolved, notes, changes, step, walk, owner: { username: 'boss', companyId: 1 } };
}
const zoneBody = (o = {}) => ({ name: 'Gate', kind: 'zone', shape: circle(), onExit: true, ...o });

test('geometry: circle, polygon, edge distance', () => {
    assert.ok(g.isInside(circle(100), ...Object.values(at(50, 0))));
    assert.ok(!g.isInside(circle(100), ...Object.values(at(150, 0))));
    const sq = { type: 'polygon', pts: [[24.70, 46.67], [24.70, 46.68], [24.72, 46.68], [24.72, 46.67]] };
    assert.ok(g.isInside(sq, 24.71, 46.675));
    assert.ok(!g.isInside(sq, 24.73, 46.675));
    assert.ok(Math.abs(g.edgeDistance(circle(100), ...Object.values(at(130, 0))) - 30) < 1);
    const p = at(0, 0); assert.ok(g.edgeDistance(sq, 24.71, 46.675) > 500);
    assert.ok(g.edgeDistance(sq, 24.7001, 46.675) < 20 && p);
});

test('validation: what is refused and what is kept', () => {
    assert.match(g.clean({ ...zoneBody(), name: ' ' }).error, /name/);
    assert.match(g.clean({ ...zoneBody(), onExit: false, onEnter: false }).error, /alert/);
    assert.match(g.clean({ ...zoneBody(), shape: circle(5) }).error, /radius/);
    assert.match(g.clean({ ...zoneBody(), shape: { type: 'polygon', pts: [[1, 1], [2, 2]] } }).error, /3 points/);
    assert.match(g.clean({ ...zoneBody(), shape: { type: 'circle', lat: 99, lng: 0, r: 100 } }).error, /centre/);
    assert.match(g.clean({ ...zoneBody(), from: '08:00' }).error, /both/);
    assert.match(g.clean({ ...zoneBody(), from: '25:00', to: '10:00' }).error, /Times/);
    assert.match(g.clean({ ...zoneBody(), scope: { type: 'cameras', ids: [] } }).error, /Pick at least one/);
    assert.match(g.clean({ ...zoneBody(), days: [] }).error, /day/);
    assert.match(g.clean({ name: 'P', kind: 'checkpoint', shape: circle() }).error, /every/);
    const ok = g.clean({ ...zoneBody(), from: '22:00', to: '06:00', days: [0, 1], tz: 180 }).value;
    assert.deepEqual([ok.fromMin, ok.toMin, ok.days], [1320, 360, 3]);
});

test('schedule: days, a window, and an overnight window that belongs to the day it started on', () => {
    const z = (o) => ({ days: g.ALL_DAYS, fromMin: null, toMin: null, tz: 180, ...o });
    const mon9 = Date.UTC(2026, 10, 16, 6, 0);          // 09:00 Riyadh, Monday
    assert.ok(g.activeAt(z({}), mon9));
    assert.ok(!g.activeAt(z({ days: 1 << 0 }), mon9), 'Sundays only: Monday is off');
    assert.ok(g.activeAt(z({ fromMin: 480, toMin: 1020 }), mon9));
    assert.ok(!g.activeAt(z({ fromMin: 600, toMin: 1020 }), mon9));
    const night = z({ fromMin: 1320, toMin: 360, days: 1 << 1 });   // Mondays 22:00 -> 06:00
    assert.ok(g.activeAt(night, Date.UTC(2026, 10, 16, 19, 30)), 'Monday 22:30');
    assert.ok(g.activeAt(night, Date.UTC(2026, 10, 17, 1, 0)), 'Tuesday 04:00 still the Monday shift');
    assert.ok(!g.activeAt(night, Date.UTC(2026, 10, 17, 19, 30)), 'Tuesday 22:30 is not a Monday');
    assert.equal(g.windowStart(night, Date.UTC(2026, 10, 17, 1, 0)), Date.UTC(2026, 10, 16, 19, 0), 'window began Monday 22:00 Riyadh');
});

test('leaving a zone raises one alert after the debounce, and it clears by itself on return', () => {
    const r = rig(); const { zone } = r.geo.add(zoneBody(), r.owner);
    r.walk('A', at(10, 0));                                   // inside: starting point
    assert.equal(r.sent.length, 0);
    r.walk('A', at(300, 0));                                  // outside, held long enough
    assert.equal(r.sent.length, 1);
    assert.equal(r.sent[0].kind, 'geo_exit'); assert.equal(r.sent[0].zone, 'Gate'); assert.equal(r.notes.length, 1);
    r.walk('A', at(320, 0)); assert.equal(r.sent.length, 1, 'no second alert while it stays out');
    r.walk('A', at(20, 0));                                   // back
    assert.equal(r.resolved.length, 1);
    assert.ok(zone.id);
});

test('a single stray fix does not alert, and neither does a fix as close to the edge as its own accuracy', () => {
    const r = rig(); r.geo.add(zoneBody(), r.owner);
    r.walk('A', at(10, 0));
    r.geo.position('A', at(300, 0).lat, at(300, 0).lng, { acc: 5, ts: r.t.now }); r.step(1000);
    r.geo.position('A', at(10, 0).lat, at(10, 0).lng, { acc: 5, ts: r.t.now }); r.step(30000);
    r.geo.position('A', at(10, 0).lat, at(10, 0).lng, { acc: 5, ts: r.t.now });
    assert.equal(r.sent.length, 0);
    for (let i = 0; i < 6; i++) { r.step(10000); r.geo.position('A', at(105, 0).lat, at(105, 0).lng, { acc: 40, ts: r.t.now }); }   // 5 m outside, but the fix is good to 40 m
    assert.equal(r.sent.length, 0);
});

test('a camera first seen outside the zone has not "left" it; one that was inside has', () => {
    const r = rig(); r.geo.add(zoneBody(), r.owner);
    r.walk('A', at(500, 0)); r.walk('A', at(600, 0));
    assert.equal(r.sent.length, 0, 'never inside: on its way, not leaving');
    r.walk('A', at(20, 0)); r.walk('A', at(400, 0));
    assert.equal(r.sent.length, 1);
});

test('forbidden area: entering raises the alert, urgent severity is kept, and starting inside raises it at once', () => {
    const r = rig(); r.geo.add(zoneBody({ name: 'Vault', onExit: false, onEnter: true, severity: 'critical' }), r.owner);
    r.walk('A', at(500, 0)); assert.equal(r.sent.length, 0);
    r.walk('A', at(10, 0));
    assert.equal(r.sent.length, 1); assert.equal(r.sent[0].kind, 'geo_enter'); assert.equal(r.sent[0].level, 'critical');
    r.walk('A', at(500, 0)); assert.equal(r.resolved.length, 1);
    const r2 = rig(); r2.geo.add(zoneBody({ onExit: false, onEnter: true }), r2.owner);
    r2.geo.position('B', at(10, 0).lat, at(10, 0).lng, { acc: 5, ts: r2.t.now });
    assert.equal(r2.sent.length, 1, 'first fix already inside a forbidden area');
});

test('both ways: leaving and entering are separate alerts', () => {
    const r = rig(); r.geo.add(zoneBody({ onExit: true, onEnter: true }), r.owner);
    r.walk('A', at(500, 0)); r.walk('A', at(10, 0)); r.walk('A', at(500, 0));
    assert.deepEqual(r.sent.map((a) => a.kind), ['geo_enter', 'geo_exit']);
});

test('the schedule decides when an alert may be raised, and starting later catches a camera already outside', () => {
    const r = rig(); r.geo.add(zoneBody({ from: '14:00', to: '18:00' }), r.owner);   // now is 12:00 Riyadh
    r.walk('A', at(10, 0)); r.walk('A', at(400, 0));
    assert.equal(r.sent.length, 0, 'outside the working hours nothing is raised');
    r.step(2.1 * 3600000); r.geo.sweep(r.t.now);              // 14:00 passes
    assert.equal(r.sent.length, 1, 'the window opened while it was outside');
    assert.equal(r.sent[0].kind, 'geo_exit');
});

test('who it applies to: company, chosen cameras, groups, regions', () => {
    const r = rig();
    r.geo.add(zoneBody({ name: 'One', scope: { type: 'cameras', ids: ['A'] } }), r.owner);
    r.geo.add(zoneBody({ name: 'South', scope: { type: 'groups', ids: ['South'] } }), r.owner);
    for (const id of ['A', 'B', 'X']) { r.walk(id, at(10, 0)); r.walk(id, at(400, 0)); }
    assert.deepEqual(r.sent.map((a) => a.cameraId + ':' + a.zone).sort(), ['A:One', 'B:South'], 'X belongs to another company and hears nothing');
    assert.equal(g.applies({ companyId: 1, scope: { type: 'regions', ids: ['Riyadh'] } }, r.cams.get('A')), true);
    assert.equal(g.applies({ companyId: 1, scope: { type: 'regions', ids: ['Riyadh'] } }, r.cams.get('B')), false);
});

test('a camera that goes onto a dock is not judged and its open geofence alerts close', () => {
    const r = rig(); r.geo.add(zoneBody(), r.owner);
    r.walk('A', at(10, 0)); r.walk('A', at(400, 0)); assert.equal(r.sent.length, 1);
    r.cams.get('A').posSrc = 'dock'; r.geo.sweep(r.t.now);
    assert.equal(r.resolved.length, 1);
    r.geo.sweep(r.t.now); assert.equal(r.sent.length, 1, 'still nothing new while docked');
});

test('checkpoint: a missed round raises one alert, a visit clears it, the schedule ending closes it', () => {
    const r = rig(); const { zone } = r.geo.add({ name: 'Back door', kind: 'checkpoint', shape: circle(), everyMin: 30, from: '08:00', to: '18:00' }, r.owner);
    r.cams.get('A').onlineSince = r.t.now;
    r.geo.sweep(r.t.now); assert.equal(r.sent.length, 0);
    r.step(20 * 60000); r.geo.sweep(r.t.now); assert.equal(r.sent.length, 0, 'not due yet');
    r.step(11 * 60000); r.geo.sweep(r.t.now); assert.equal(r.sent.length, 0, 'due, still inside the grace time');
    r.step(5 * 60000); r.geo.sweep(r.t.now);
    assert.deepEqual(r.sent.map((a) => a.kind + ':' + a.cameraId), ['checkpoint_missed:A', 'checkpoint_missed:B']);
    assert.ok(r.sent[0].value >= 30);
    r.geo.sweep(r.t.now); assert.equal(r.sent.length, 2, 'one alert per camera');
    r.geo.position('A', at(20, 0).lat, at(20, 0).lng, { acc: 5, ts: r.t.now });
    assert.equal(r.resolved.length, 1, 'A reached it');
    r.step(7 * 3600000); r.geo.sweep(r.t.now);                  // 19:xx: the round is over
    assert.equal(r.resolved.length, 2, 'B: the schedule ended');
    assert.ok(zone.id);
});

test('checkpoint: a camera that is offline is not blamed', () => {
    const r = rig({ cams: { A: { cameraId: 'A', companyId: 1, online: false } } });
    r.geo.add({ name: 'P', kind: 'checkpoint', shape: circle(), everyMin: 5 }, r.owner);
    r.step(3600000); r.geo.sweep(r.t.now);
    assert.ok(!r.sent.some((a) => a.cameraId === 'A'));
});

test('editing a zone closes what was open and forgets the old state; deleting does too', () => {
    const r = rig(); const { zone } = r.geo.add(zoneBody(), r.owner);
    r.walk('A', at(10, 0)); r.walk('A', at(400, 0)); assert.equal(r.sent.length, 1);
    const up = r.geo.update(zone.id, { shape: circle(1000) }, { username: 'boss' });
    assert.equal(up.zone.shape.r, 1000); assert.equal(r.resolved.length, 1);
    r.walk('A', at(10, 0)); r.walk('A', at(1500, 0)); assert.equal(r.sent.length, 2);
    assert.ok(r.geo.remove(zone.id, { username: 'boss' }).ok);
    assert.equal(r.resolved.length, 2); assert.equal(r.geo.list({ staff: false, companyId: 1 }).length, 0);
    assert.deepEqual(r.changes.filter((c) => c === 1).length, 3, 'dashboards are told after add, edit and delete');
});

test('zones are kept per company, limited in number, and survive a restart with their state', () => {
    const r = rig(); r.geo.add(zoneBody({ name: 'Mine' }), r.owner); r.geo.add(zoneBody({ name: 'Theirs' }), { username: 'o', companyId: 2 });
    assert.deepEqual(r.geo.list({ staff: false, companyId: 1 }).map((z) => z.name), ['Mine']);
    assert.equal(r.geo.list({ staff: true }).length, 2);
    assert.equal(r.geo.list({ staff: true, only: 2 }).length, 1);
    r.walk('A', at(10, 0));
    const again = g.create({ db: r.db, cams: r.cams, now: () => r.t.now, sweepMs: 0, toCam: (id, ev, d) => r.sent.push(d), notify() {} });
    again.position('A', at(400, 0).lat, at(400, 0).lng, { acc: 5, ts: r.t.now }); r.step(20000);
    again.position('A', at(400, 0).lat, at(400, 0).lng, { acc: 5, ts: r.t.now }); r.step(20000);
    again.position('A', at(400, 0).lat, at(400, 0).lng, { acc: 5, ts: r.t.now });
    assert.equal(r.sent.length, 1, 'it remembered the camera had been inside');
    for (let i = 0; i < 199; i++) r.geo.add(zoneBody({ name: 'Z' + i }), r.owner);
    assert.match(r.geo.add(zoneBody({ name: 'one too many' }), r.owner).error, /at most 200/);
});

test('history lists open and closed geofence alerts for what the caller may see', () => {
    const r = rig(); r.geo.add(zoneBody(), r.owner);
    r.walk('A', at(10, 0)); r.walk('A', at(400, 0)); r.walk('A', at(10, 0));
    const h = r.geo.history((id) => id === 'A');
    assert.equal(h.length, 1); assert.ok(h[0].resolvedTs); assert.equal(h[0].zone, 'Gate');
    assert.equal(r.geo.history((id) => id === 'B').length, 0);
});

test('push: a geofence alert reads as one, and the feature is offered to companies with its action', () => {
    const { buildAlertMessage } = require('../push');
    const m = buildAlertMessage('tok', 'android', { id: 3, kind: 'geo_exit', zone: 'Main gate', cameraId: 'A', level: 'warning', ts: 1 }, 'BWC-01');
    assert.match(m.notification.title, /Left the zone: BWC-01/); assert.match(m.notification.body, /left "Main gate"/); assert.strictEqual(m.data.type, 'geofence');
    const c = buildAlertMessage('tok', 'ios', { id: 4, kind: 'checkpoint_missed', zone: 'Back door', cameraId: 'A', level: 'critical', ts: 1 }, 'BWC-01');
    assert.match(c.notification.body, /did not reach checkpoint "Back door"/); assert.strictEqual(c.apns.headers['apns-priority'], '10');
    assert.strictEqual(buildAlertMessage('t', 'android', { id: 1, kind: 'low_battery', level: 'warning', value: 15, cameraId: 'A', ts: 1 }, 'X').data.type, 'battery', 'battery notices are unchanged');
    const f = require('../features');
    assert.ok(f.KEYS.includes('geofence') && f.ACTION_KEYS.includes('zones'));
    assert.deepStrictEqual(f.clean(['zones']), [], 'managing zones needs the feature');
    assert.ok(f.effective({ staff: false, manager: true, role: 'manager', companyFeatures: null, perms: null }).includes('zones'), 'a company manager can manage zones');
    assert.ok(!f.effective({ staff: false, manager: false, role: 'client', companyFeatures: null, perms: null }).includes('zones'), 'an operator cannot unless given it');
    assert.strictEqual(f.ruleFor('/api/geofences'), 'geofence');
});

test('a repeated fix (the camera heartbeat) is not a second observation, so one real fix cannot confirm leaving', () => {
    const r = rig(); r.geo.add(zoneBody(), r.owner);
    const fix = (m, fixTs) => { const p = at(m, 0); r.geo.position('A', p.lat, p.lng, { acc: 5, ts: r.t.now, fixTs }); };
    fix(10, 1000); r.step(1000); fix(10, 2000);
    fix(400, 3000);                                   // one real fix outside
    for (let i = 0; i < 6; i++) { r.step(5000); fix(400, 3000); }   // ...repeated by the heartbeat for 30 s
    assert.equal(r.sent.length, 0, 'still only one observation');
    r.step(5000); fix(400, 4000); r.step(16000); fix(400, 5000);     // real, new fixes
    assert.equal(r.sent.length, 1);
});

test('status explains, camera by camera, why a zone does or does not alert', () => {
    const r = rig(); const { zone } = r.geo.add(zoneBody(), r.owner);
    const why = (id) => r.geo.status(zone.id, () => true).cameras.find((c) => c.cameraId === id)?.why;
    assert.equal(why('X'), undefined, 'a camera of another company is not covered by this zone');
    assert.equal(why('A'), 'no_gps', 'no fix yet');
    r.cams.get('A').fixTs = r.t.now; r.cams.get('B').fixTs = r.t.now;
    assert.equal(why('A'), 'waiting');
    r.walk('A', at(500, 0)); r.cams.get('A').fixTs = r.t.now;
    assert.equal(why('A'), 'never_inside', 'outside, but never inside: it has not left');
    r.walk('A', at(10, 0)); r.cams.get('A').fixTs = r.t.now;
    assert.equal(why('A'), 'watching');
    r.cams.get('A').posSrc = 'dock'; assert.equal(why('A'), 'on_dock');
    r.cams.get('A').posSrc = null; r.t.now += 3 * 3600000; assert.equal(why('A'), 'no_gps', 'a fix hours old is not judged');
    assert.equal(r.geo.status(999, () => true), null);
});
