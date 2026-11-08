const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { sweep } = require('../retention');

function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-ret-'));
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE recordings(id INTEGER PRIMARY KEY, camera_id TEXT, filename TEXT, size INTEGER, sha256 TEXT, uploaded_ts INTEGER); CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, username TEXT NOT NULL, action TEXT NOT NULL, camera_id TEXT)');
    require('../auditlog').init(db);
    fs.mkdirSync(path.join(dir, 'C1'));
    const add = (name, ageDays) => { fs.writeFileSync(path.join(dir, 'C1', name), 'x'.repeat(10)); db.prepare('INSERT INTO recordings(camera_id,filename,size,sha256,uploaded_ts) VALUES(?,?,?,?,?)').run('C1', name, 10, 'sha-' + name, Date.now() - ageDays * 86400000); };
    return { dir, db, add };
}

test('recordings older than the retention window are deleted, newer ones stay', () => {
    const { dir, db, add } = setup();
    add('VID_old.mp4', 5); add('VID_new.mp4', 1);
    const r = sweep({ db, dir, days: 3 });
    assert.deepStrictEqual(r, { removed: 1, bytes: 10 });
    assert.ok(!fs.existsSync(path.join(dir, 'C1', 'VID_old.mp4')));
    assert.ok(fs.existsSync(path.join(dir, 'C1', 'VID_new.mp4')));
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM recordings').get().n, 1);
    const actions = db.prepare('SELECT action FROM audit ORDER BY id').all().map((x) => x.action);
    assert.deepStrictEqual(actions, ['recording_expired', 'recordings_expired_1']);   // each removed file leaves its own line
    assert.strictEqual(require('../auditlog').verify(db).ok, true);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('retention 0 keeps everything (evidence is kept forever by default)', () => {
    const { dir, db, add } = setup();
    add('VID_old.mp4', 400);
    assert.deepStrictEqual(sweep({ db, dir, days: 0 }), { removed: 0, bytes: 0 });
    assert.ok(fs.existsSync(path.join(dir, 'C1', 'VID_old.mp4')));
    fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing file does not stop the clean-up of its row', () => {
    const { dir, db, add } = setup();
    add('VID_gone.mp4', 9); fs.rmSync(path.join(dir, 'C1', 'VID_gone.mp4'));
    assert.strictEqual(sweep({ db, dir, days: 3 }).removed, 1);
    fs.rmSync(dir, { recursive: true, force: true });
});
