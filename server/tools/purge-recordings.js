// Delete offloaded recordings from the server (files and database rows). For test/demo servers.
//   node tools/purge-recordings.js --all --yes            everything
//   node tools/purge-recordings.js --older-than-days 3    only what is older
// In Docker:  docker exec visionguard node tools/purge-recordings.js --all --yes
const path = require('path');
const { db } = require('../db');
const { sweep } = require('../retention');

db.exec(`CREATE TABLE IF NOT EXISTS recordings(
    id INTEGER PRIMARY KEY AUTOINCREMENT, camera_id TEXT NOT NULL, filename TEXT NOT NULL, size INTEGER NOT NULL,
    sha256 TEXT NOT NULL, recorded_ts INTEGER, uploaded_ts INTEGER NOT NULL, dock_id TEXT, UNIQUE(camera_id, sha256))`);
const args = process.argv.slice(2);
const dir = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'recordings');
const i = args.indexOf('--older-than-days');
const days = i >= 0 ? Number(args[i + 1]) : 0;
if (args.includes('--all')) {
    if (!args.includes('--yes')) { console.log('This deletes ALL recordings. Run again with --all --yes to confirm.'); process.exit(1); }
    const n = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(size),0) b FROM recordings').get();
    const r = sweep({ db, dir, days: 1e-9, now: Date.now() + 1 }); // every row is older than "now"
    console.log(`Removed ${r.removed} of ${n.n} recordings (${(r.bytes / 1e6).toFixed(0)} MB).`);
} else if (days > 0) {
    const r = sweep({ db, dir, days });
    console.log(`Removed ${r.removed} recordings older than ${days} days (${(r.bytes / 1e6).toFixed(0)} MB).`);
} else {
    console.log('Usage: node tools/purge-recordings.js --all --yes | --older-than-days N');
    process.exit(1);
}
