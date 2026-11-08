const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const auditlog = require('../auditlog');

function fresh() {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, username TEXT NOT NULL, action TEXT NOT NULL, camera_id TEXT)');
    db.prepare('INSERT INTO audit(ts,username,action,camera_id) VALUES(1,?,?,?)').run('legacy', 'old_action', null);   // a line from before the chain existed
    auditlog.init(db);
    return db;
}

test('lines are chained and the chain verifies', () => {
    const db = fresh();
    auditlog.add(db, 'alice', 'dock_file_choice_cloud', 'BWC-01', { file: 'VID_1.mp4' }, 'abc');
    auditlog.add(db, 'dock:d', 'dock_file_uploaded_cloud', 'BWC-01', { file: 'VID_1.mp4' }, 'abc');
    const v = auditlog.verify(db);
    assert.strictEqual(v.ok, true); assert.strictEqual(v.checked, 2); assert.strictEqual(v.legacy, 1); assert.match(v.head, /^[0-9a-f]{64}$/);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM audit WHERE ref = ?').get('abc').n, 2);   // one file's whole life by its SHA-256
});

test('the database refuses to edit or delete a line', () => {
    const db = fresh();
    const id = auditlog.add(db, 'alice', 'camera_removed', 'BWC-01');
    assert.throws(() => db.prepare('DELETE FROM audit WHERE id = ?').run(id), /append-only/);
    assert.throws(() => db.prepare("UPDATE audit SET username = 'bob' WHERE id = ?").run(id), /append-only/);
    assert.throws(() => db.exec('DELETE FROM audit'), /append-only/);
});

test('even with direct database access, a changed, removed or inserted line is detected', () => {
    for (const tamper of [
        (db, ids) => { db.exec('DROP TRIGGER audit_no_update'); db.prepare("UPDATE audit SET action = 'nothing_happened' WHERE id = ?").run(ids[1]); },
        (db, ids) => { db.exec('DROP TRIGGER audit_no_delete'); db.prepare('DELETE FROM audit WHERE id = ?').run(ids[1]); },
        (db, ids) => { db.exec('DROP TRIGGER audit_no_update'); db.prepare("UPDATE audit SET hash = 'ff' WHERE id = ?").run(ids[2]); },
    ]) {
        const db = fresh();
        const ids = [1, 2, 3].map((i) => auditlog.add(db, 'alice', 'action_' + i, 'BWC-01'));
        assert.strictEqual(auditlog.verify(db).ok, true);
        tamper(db, ids);
        const v = auditlog.verify(db);
        assert.strictEqual(v.ok, false);
        assert.ok(v.firstBadId >= ids[1] - 0 && v.firstBadId <= ids[2], 'points at the damaged place');
    }
});
