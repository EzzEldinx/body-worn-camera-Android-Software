// Tamper-evident activity log.
//  * append-only: the database itself refuses UPDATE and DELETE on the audit table (triggers), nothing in the app can erase or edit a line;
//  * hash-chained: every line stores the SHA-256 of itself plus the previous line's hash, so removing, editing or inserting a line anywhere breaks
//    the chain from that point on, and /api/audit/verify says exactly where. Keep a copy of the head hash outside the server to also catch a full rewrite.
// Lines written before the chain existed (hash NULL) are shown but cannot be verified.
const crypto = require('crypto');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const lineHash = (prev, r) => sha([prev, r.id, r.ts, r.username, r.action, r.camera_id || '', r.detail || '', r.ref || ''].join('|'));

function init(db) {
    for (const [col, ddl] of [['detail', 'TEXT'], ['ref', 'TEXT'], ['prev_hash', 'TEXT'], ['hash', 'TEXT']]) {
        if (!db.prepare('PRAGMA table_info(audit)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE audit ADD COLUMN ${col} ${ddl}`);
    }
    db.exec('CREATE INDEX IF NOT EXISTS audit_ref ON audit(ref)');
    db.exec('CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts)');
    db.exec("CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END");
    db.exec("CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END");
}

/** Append one line. `detail` is a small JSON object (file name, size, who decided what), `ref` an id to find a thing's whole history (a file's SHA-256). */
function add(db, username, action, cameraId = null, detail = null, ref = null) {
    const last = db.prepare('SELECT hash FROM audit WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1').get();
    const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'audit'").get();
    const row = { id: (seq?.seq || 0) + 1, ts: Date.now(), username: String(username || 'system').slice(0, 80), action: String(action).slice(0, 120), camera_id: cameraId || null,
        detail: detail ? JSON.stringify(detail).slice(0, 2000) : null, ref: ref ? String(ref).slice(0, 80) : null };
    const prev = last?.hash || '';
    db.prepare('INSERT INTO audit(id,ts,username,action,camera_id,detail,ref,prev_hash,hash) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(row.id, row.ts, row.username, row.action, row.camera_id, row.detail, row.ref, prev, lineHash(prev, row));
    return row.id;
}

/** Recompute the whole chain. */
function verify(db) {
    const rows = db.prepare('SELECT id,ts,username,action,camera_id,detail,ref,prev_hash,hash FROM audit WHERE hash IS NOT NULL ORDER BY id').all();
    let prev = '', n = 0;
    for (const r of rows) {
        if (r.prev_hash !== prev || lineHash(prev, r) !== r.hash) return { ok: false, checked: n, firstBadId: r.id, head: prev || null, total: rows.length };
        prev = r.hash; n++;
    }
    return { ok: true, checked: n, head: prev || null, total: rows.length, legacy: db.prepare('SELECT COUNT(*) n FROM audit WHERE hash IS NULL').get().n };
}

module.exports = { init, add, verify, lineHash };
