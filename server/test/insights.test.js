const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const auditlog = require('../auditlog');
const insights = require('../insights');

function setup() {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, username TEXT NOT NULL, action TEXT NOT NULL, camera_id TEXT);
      CREATE TABLE recordings(id INTEGER PRIMARY KEY, camera_id TEXT, filename TEXT, size INTEGER, sha256 TEXT, recorded_ts INTEGER, uploaded_ts INTEGER);
      CREATE TABLE dock_files(id INTEGER PRIMARY KEY, camera_id TEXT, size INTEGER, state TEXT, choice TEXT, added_ts INTEGER, cam_delete INTEGER DEFAULT 0, cam_deleted_ts INTEGER);
      CREATE TABLE alarms(id INTEGER PRIMARY KEY, camera_id TEXT, ts INTEGER, ack_ts INTEGER);
      CREATE TABLE events(id INTEGER PRIMARY KEY, ts INTEGER, camera_id TEXT, type TEXT, info TEXT)`);
    auditlog.init(db);
    return db;
}
const now = Date.now(), H = 3600000;
const cams = [
    { cameraId: 'A', name: 'BWC-01', online: true, recording: false, battery: 7, batteryTs: now - 600000, ts: now, fixTs: now - 60000 },
    { cameraId: 'B', name: 'BWC-02', online: false, ts: now - 30 * H },
];

test('findings: low battery, long offline, waiting files, unacknowledged SOS, failed uploads', () => {
    const db = setup();
    db.prepare('INSERT INTO dock_files(camera_id,size,state,choice,added_ts) VALUES(?,?,?,?,?)').run('A', 2e9, 'on_dock', null, now - 30 * H);
    db.prepare('INSERT INTO dock_files(camera_id,size,state,choice,added_ts) VALUES(?,?,?,?,?)').run('A', 5e8, 'failed', 'cloud', now - H);
    db.prepare('INSERT INTO dock_files(camera_id,size,state,choice,added_ts) VALUES(?,?,?,?,?)').run('A', 5e8, 'cloud', 'cloud', now - H);
    db.prepare('INSERT INTO alarms(camera_id,ts,ack_ts) VALUES(?,?,NULL)').run('A', now - 20 * 60000);
    const a = insights.build({ db, cameras: cams, staff: false, now });
    const ids = a.insights.map((i) => i.id);
    for (const want of ['bat_A', 'off_B', 'awaiting', 'sos', 'failed']) assert.ok(ids.includes(want), want);
    assert.strictEqual(a.insights[0].severity, 'critical');                              // most urgent first
    assert.deepStrictEqual([a.pipeline.awaiting.n, a.pipeline.failed.n, a.pipeline.cloud.n], [1, 1, 1]);
    assert.ok(a.pipeline.oldestAwaitingHours >= 29);
    assert.strictEqual(a.score, 0);                                                      // both cameras have a problem
});

test('a healthy fleet gets good news, and the trail is reported as verified', () => {
    const db = setup();
    auditlog.add(db, 'alice', 'camera_edited', 'A');
    const a = insights.build({ db, cameras: [{ cameraId: 'A', name: 'BWC-01', online: true, battery: 80, batteryTs: now, ts: now, fixTs: now }], staff: false, now });
    assert.deepStrictEqual(a.insights.map((i) => i.id).sort(), ['all_good', 'audit_ok']);
    assert.strictEqual(a.score, 100); assert.strictEqual(a.audit.ok, true);
});

test('a broken audit trail is the top finding', () => {
    const db = setup();
    auditlog.add(db, 'a', 'x'); auditlog.add(db, 'a', 'y');
    db.exec('DROP TRIGGER audit_no_update'); db.exec("UPDATE audit SET action = 'z' WHERE id = 1");
    const a = insights.build({ db, cameras: [], staff: true, now });
    assert.strictEqual(a.insights[0].id, 'audit'); assert.strictEqual(a.insights[0].severity, 'critical');
});

test('the written analysis: plain summary without a key, Claude with one, and only aggregates are sent', async () => {
    const db = setup();
    const a = insights.build({ db, cameras: cams, staff: false, now });
    const plain = await insights.aiNarrative(a, { env: {} });
    assert.strictEqual(plain.ai, false); assert.match(plain.text, /health score/i);
    let sent;
    const ai = await insights.aiNarrative(a, { env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl: async (url, o) => { sent = { url, o }; return { ok: true, json: async () => ({ model: 'm', content: [{ type: 'text', text: 'Overall fine.' }] }) }; } });
    assert.strictEqual(ai.ai, true); assert.strictEqual(ai.text, 'Overall fine.');
    assert.match(sent.url, /api\.anthropic\.com/); assert.strictEqual(sent.o.headers['x-api-key'], 'k');
    assert.doesNotMatch(sent.o.body, /sha256|filename|username/i);
    const failed = await insights.aiNarrative(a, { env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl: async () => ({ ok: false, status: 500 }) });
    assert.strictEqual(failed.ai, false);                                                // an AI outage never breaks the page
});
