// The PDF report: date range parsing (from - to) and what a multi-day report adds up.
const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { PassThrough } = require('node:stream');
const { parseRange, MAX_DAYS } = require('../range');
const report = require('../report');

const RIYADH = -180;                                     // Date.getTimezoneOffset() of UTC+3
const local = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) + RIYADH * 60000;   // a Riyadh wall-clock time as a timestamp
const NOW = local(2026, 11, 9, 14, 30);                  // 9 Nov 2026, 14:30 in Riyadh

test('no parameters = today, in the reader\'s own zone', () => {
    const r = parseRange({ tz: RIYADH }, { now: NOW });
    assert.strictEqual(r.fromStamp, '2026-11-09'); assert.strictEqual(r.toStamp, '2026-11-09'); assert.strictEqual(r.days, 1);
    assert.strictEqual(r.from, local(2026, 11, 9)); assert.strictEqual(r.to, local(2026, 11, 10));
});

test('around midnight the reader\'s zone decides which day is "today"', () => {
    const lateUtc = Date.UTC(2026, 10, 8, 22, 30);       // 22:30 UTC on the 8th is 01:30 on the 9th in Riyadh
    assert.strictEqual(parseRange({ tz: RIYADH }, { now: lateUtc }).fromStamp, '2026-11-09');
    assert.strictEqual(parseRange({ tz: 0 }, { now: lateUtc }).fromStamp, '2026-11-08');
});

test('the old ?date= parameter still works and means one day', () => {
    const r = parseRange({ date: '2026-11-03', tz: RIYADH }, { now: NOW });
    assert.strictEqual(r.days, 1); assert.strictEqual(r.from, local(2026, 11, 3)); assert.strictEqual(r.to, local(2026, 11, 4));
});

test('from - to includes both days and ends at the midnight after the last one', () => {
    const r = parseRange({ from: '2026-11-01', to: '2026-11-07', tz: RIYADH }, { now: NOW });
    assert.strictEqual(r.days, 7); assert.strictEqual(r.from, local(2026, 11, 1)); assert.strictEqual(r.to, local(2026, 11, 8));
    const m = parseRange({ from: '2026-10-28', to: '2026-11-02', tz: RIYADH }, { now: NOW });   // across a month end
    assert.strictEqual(m.days, 6);
    const y = parseRange({ from: '2025-12-30', to: '2026-01-02', tz: RIYADH }, { now: NOW });   // across a year end
    assert.strictEqual(y.days, 4);
});

test('bad ranges are refused with a plain message', () => {
    const bad = (q) => parseRange({ tz: RIYADH, ...q }, { now: NOW }).error;
    assert.match(bad({ from: '2026-11-07', to: '2026-11-01' }), /must not be after/);
    assert.match(bad({ from: '2026-11-10' }), /today or an earlier/);
    assert.match(bad({ from: '2026-11-01', to: '2026-11-10' }), /future/);
    assert.match(bad({ from: '2026-02-31' }), /dates like/);
    assert.match(bad({ from: 'yesterday' }), /dates like/);
    assert.match(bad({ from: '2026-07-01', to: '2026-11-09' }), new RegExp(`at most ${MAX_DAYS}`));
    assert.ok(!parseRange({ from: '2026-08-09', to: '2026-11-08', tz: RIYADH }, { now: NOW }).error, 'exactly 92 days is allowed');
});

function fixture() {
    const db = new DatabaseSync(':memory:');
    db.exec(`
        CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, camera_id TEXT NOT NULL, type TEXT NOT NULL, info TEXT);
        CREATE TABLE positions(id INTEGER PRIMARY KEY AUTOINCREMENT, camera_id TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, ts INTEGER NOT NULL, acc REAL);
        CREATE TABLE alarms(id INTEGER PRIMARY KEY AUTOINCREMENT, camera_id TEXT NOT NULL, lat REAL, lng REAL, ts INTEGER NOT NULL, ack_by TEXT, ack_ts INTEGER);
        CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, username TEXT NOT NULL, action TEXT NOT NULL, camera_id TEXT);
        CREATE TABLE assignments(id INTEGER PRIMARY KEY AUTOINCREMENT, camera_id TEXT NOT NULL, user_id INTEGER, username TEXT, name TEXT, employee_no TEXT, status TEXT NOT NULL, issued_ts INTEGER NOT NULL, picked_ts INTEGER, returned_ts INTEGER);`);
    const ev = db.prepare('INSERT INTO events(ts,camera_id,type) VALUES(?,?,?)');
    ev.run(local(2026, 11, 1, 8), 'BWC-01', 'online');
    ev.run(local(2026, 11, 1, 23), 'BWC-01', 'rec_start');          // records across midnight: 1 h on the 1st, 1 h on the 2nd
    ev.run(local(2026, 11, 2, 1), 'BWC-01', 'rec_stop');
    ev.run(local(2026, 11, 3, 10), 'BWC-01', 'rec_start');
    ev.run(local(2026, 11, 3, 10, 30), 'BWC-01', 'rec_stop');
    const al = db.prepare('INSERT INTO alarms(camera_id,ts,ack_by,ack_ts) VALUES(?,?,?,?)');
    al.run('BWC-01', local(2026, 11, 2, 12), 'ops', local(2026, 11, 2, 12, 1));
    al.run('BWC-01', local(2026, 11, 3, 9), null, null);
    al.run('BWC-02', local(2026, 11, 3, 9, 5), null, null);
    db.prepare('INSERT INTO assignments(camera_id,user_id,username,name,employee_no,status,issued_ts,picked_ts,returned_ts) VALUES(?,?,?,?,?,?,?,?,?)')
        .run('BWC-01', 7, 'ahassan', 'Ahmed Hassan', '0147', 'returned', local(2026, 11, 2, 7, 55), local(2026, 11, 2, 8), local(2026, 11, 2, 16));
    db.prepare('INSERT INTO assignments(camera_id,user_id,username,name,employee_no,status,issued_ts) VALUES(?,?,?,?,?,?,?)')
        .run('BWC-02', 8, 'cancelled-one', 'Nobody', '1', 'cancelled', local(2026, 11, 2, 9));
    return db;
}
const cameras = [{ cameraId: 'BWC-01', name: 'BWC-01', online: true }, { cameraId: 'BWC-02', name: 'BWC-02', online: false }];

test('a multi-day report splits time, alarms and custody per day, in the reader\'s zone', () => {
    const db = fixture();
    const from = local(2026, 11, 1), to = local(2026, 11, 8);
    const d = report.gather(db, cameras, from, to, report.zone(RIYADH));
    assert.strictEqual(d.days.length, 7);
    assert.strictEqual(d.days[0].recMs, 3600000, 'the hour before midnight');
    assert.strictEqual(d.days[1].recMs, 3600000, 'the hour after midnight');
    assert.strictEqual(d.days[2].recMs, 1800000);
    assert.deepStrictEqual(d.days.map((x) => x.sos), [0, 1, 2, 0, 0, 0, 0]);
    assert.strictEqual(d.perCam.get('BWC-01').recMs, 3600000 * 2 + 1800000);
    assert.strictEqual(d.alarms.length, 3);
    assert.strictEqual(d.shifts.length, 1, 'a cancelled check-out is not custody');
    assert.strictEqual(d.shifts[0].who, 'Ahmed Hassan #0147');
    assert.ok(d.timeline.some((e) => /Camera taken by Ahmed Hassan/.test(e.text)) && d.timeline.some((e) => /Camera returned by Ahmed Hassan/.test(e.text)));
    db.close();
});

test('the same data cut as one day only counts that day', () => {
    const db = fixture();
    const d = report.gather(db, cameras, local(2026, 11, 3), local(2026, 11, 4), report.zone(RIYADH));
    assert.strictEqual(d.days.length, 1); assert.strictEqual(d.alarms.length, 2); assert.strictEqual(d.shifts.length, 0);
    db.close();
});

function pdf(db, opts) {
    return new Promise((resolve, reject) => {
        const out = new PassThrough(), chunks = [];
        out.on('data', (c) => chunks.push(c)); out.on('end', () => resolve(Buffer.concat(chunks))); out.on('error', reject);
        report.build(db, { title: 'Operations report', scopeLabel: 'Test', cameras, regionOf: () => 'Riyadh', nameOf: (c) => c.name, tz: RIYADH, compress: false, ...opts }, out);
    });
}
const pages = (buf) => (buf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) || []).length;

test('the PDF builds for one day and for a long range', async () => {
    const db = fixture();
    const one = await pdf(db, { from: local(2026, 11, 3), to: local(2026, 11, 4) });
    assert.strictEqual(one.subarray(0, 5).toString(), '%PDF-'); assert.match(one.subarray(-8).toString(), /%%EOF/);
    const many = await pdf(db, { from: local(2026, 8, 10), to: local(2026, 11, 10) });      // 92 days: day-by-day table spills over several pages
    assert.strictEqual(many.subarray(0, 5).toString(), '%PDF-');
    assert.ok(pages(many) > pages(one), `long range should need more pages (${pages(many)} vs ${pages(one)})`);
    db.close();
});
