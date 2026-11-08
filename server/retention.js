// Automatic clean-up of offloaded recordings. Off by default (evidence is kept forever); a test or demo server sets
// RECORDINGS_RETENTION_DAYS=3 so old test videos do not pile up.
const fs = require('fs');
const path = require('path');

const DAY = 86400000;

/** Remove recordings uploaded more than `days` days ago (file first, then the database row). */
function sweep({ db, dir, days, now = Date.now(), log = console }) {
    if (!(days > 0)) return { removed: 0, bytes: 0 };
    const rows = db.prepare('SELECT id, camera_id, filename, size FROM recordings WHERE uploaded_ts < ?').all(now - days * DAY);
    let removed = 0, bytes = 0;
    for (const r of rows) {
        try { fs.rmSync(path.join(dir, r.camera_id, r.filename), { force: true }); } catch (e) { log.warn(`retention: cannot remove ${r.camera_id}/${r.filename}: ${e.message}`); continue; }
        db.prepare('DELETE FROM recordings WHERE id = ?').run(r.id);
        removed++; bytes += r.size;
    }
    // Half-finished uploads (.part) older than a day are garbage too.
    try {
        for (const cam of fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
            for (const f of fs.readdirSync(path.join(dir, cam.name))) {
                const p = path.join(dir, cam.name, f);
                if (f.endsWith('.part') && now - fs.statSync(p).mtimeMs > DAY) fs.rmSync(p, { force: true });
            }
        }
    } catch (e) { /* directory may not exist yet */ }
    if (removed) db.prepare('INSERT INTO audit(ts,username,action,camera_id) VALUES(?,?,?,?)').run(now, 'system', `recordings_expired_${removed}`, null);
    return { removed, bytes };
}

function start({ db, dir, days, log = console }) {
    if (!(days > 0)) return null;
    const run = () => { try { const r = sweep({ db, dir, days, log }); if (r.removed) log.log(`retention: removed ${r.removed} recordings older than ${days} days`); } catch (e) { log.warn(`retention failed: ${e.message}`); } };
    run();
    const t = setInterval(run, 3600_000);
    t.unref();
    return t;
}

module.exports = { sweep, start };
