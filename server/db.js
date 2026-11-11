// SQLite storage (built into Node 22+, no install needed) and password helpers.
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(path.join(dir, 'bwc.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pass TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer');
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, exp INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cameras(id TEXT PRIMARY KEY, name TEXT, grp TEXT, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS alarms(id INTEGER PRIMARY KEY AUTOINCREMENT, camera_id TEXT NOT NULL, lat REAL, lng REAL, ts INTEGER NOT NULL, ack_by TEXT, ack_ts INTEGER);
CREATE TABLE IF NOT EXISTS positions(id INTEGER PRIMARY KEY AUTOINCREMENT, camera_id TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS pos_cam_ts ON positions(camera_id, ts);
CREATE INDEX IF NOT EXISTS pos_ts ON positions(ts, camera_id);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, username TEXT NOT NULL, action TEXT NOT NULL, camera_id TEXT);
CREATE TABLE IF NOT EXISTS companies(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, created INTEGER NOT NULL);
`);

// Multi-company: users and cameras may belong to a company (NULL = Smart Way staff / unassigned).
function addColumn(table, col, ddl) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
    }
}
addColumn('users', 'company_id', 'INTEGER');
addColumn('cameras', 'holder', 'TEXT');               // who carries the camera (shown above it on the map)
addColumn('cameras', 'token_hash', 'TEXT');           // sha256 of the camera's own device token
addColumn('companies', 'max_cameras', 'INTEGER');   // package size (NULL = unlimited / legacy)
addColumn('companies', 'max_live', 'INTEGER');
addColumn('companies', 'sub_end', 'INTEGER');       // end of the company's subscription (NULL = no end date)      // max cameras streaming live at once (NULL = unlimited)
addColumn('cameras', 'company_id', 'INTEGER');
addColumn('cameras', 'region', 'TEXT');
addColumn('cameras', 'battery', 'INTEGER');           // last battery reading (percent), kept across restarts
addColumn('cameras', 'battery_ts', 'INTEGER');
addColumn('cameras', 'charging', 'INTEGER');
addColumn('users', 'employee_no', 'TEXT');            // badge / employee number printed on every recording the person makes
addColumn('users', 'active', 'INTEGER NOT NULL DEFAULT 1');   // 0 = switched off (kept for the history, cannot sign in)
addColumn('cameras', 'holder_prev', 'TEXT');          // the holder an administrator typed by hand, kept aside while a check-out shift lasts
addColumn('cameras', 'holder_src', 'TEXT');           // 'checkout' when the holder comes from the check-out station, empty when an admin typed it
addColumn('alarms', 'holder', 'TEXT');                // who carried the camera when the SOS was pressed
addColumn('alarms', 'holder_no', 'TEXT');
db.exec(`CREATE TABLE IF NOT EXISTS assignments(
    id INTEGER PRIMARY KEY AUTOINCREMENT, camera_id TEXT NOT NULL, user_id INTEGER, username TEXT NOT NULL, name TEXT NOT NULL, employee_no TEXT, company_id INTEGER,
    status TEXT NOT NULL,                 -- reserved (issued, still on the dock) | in_use (left the dock) | returned | cancelled
    issued_ts INTEGER NOT NULL, hold_until INTEGER, picked_ts INTEGER, returned_ts INTEGER,
    dock_id TEXT, slot INTEGER, battery_out INTEGER, battery_in INTEGER, ended_by TEXT, note TEXT)`);
db.exec('CREATE INDEX IF NOT EXISTS assignments_cam ON assignments(camera_id, status)');
db.exec('CREATE INDEX IF NOT EXISTS assignments_user ON assignments(user_id, status)');
db.exec('CREATE INDEX IF NOT EXISTS assignments_time ON assignments(issued_ts)');
addColumn('positions', 'acc', 'REAL');
db.exec('CREATE TABLE IF NOT EXISTS deleted_cameras(id TEXT PRIMARY KEY, ts INTEGER NOT NULL)');
require('./auditlog').init(db);
db.exec('CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, camera_id TEXT NOT NULL, type TEXT NOT NULL, info TEXT)');
db.exec('CREATE INDEX IF NOT EXISTS events_ts ON events(ts)');
db.exec('CREATE TABLE IF NOT EXISTS regions(name TEXT PRIMARY KEY, created INTEGER NOT NULL)');
if (!db.prepare('SELECT 1 FROM regions LIMIT 1').get()) {
    ['Riyadh', 'Jeddah', 'Dammam'].forEach((n, i) => db.prepare('INSERT INTO regions(name,created) VALUES(?,?)').run(n, Date.now() + i));
}

function hashPassword(pw) {
    const salt = crypto.randomBytes(16).toString('hex');
    return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function verifyPassword(pw, stored) {
    const [salt, hash] = String(stored || '').split(':');
    if (!salt || !hash) return false;
    const a = Buffer.from(hash, 'hex');
    const b = crypto.scryptSync(pw, salt, 64);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// The same check off the event loop (libuv thread pool): a burst of sign-ins no longer freezes GPS, SOS and video relay for 20 ms each.
function verifyPasswordAsync(pw, stored) {
    const [salt, hash] = String(stored || '').split(':');
    if (!salt || !hash) return Promise.resolve(false);
    return new Promise((resolve) => crypto.scrypt(String(pw), salt, 64, (err, b) => {
        if (err) return resolve(false);
        const a = Buffer.from(hash, 'hex');
        resolve(a.length === b.length && crypto.timingSafeEqual(a, b));
    }));
}

module.exports = { db, hashPassword, verifyPassword, verifyPasswordAsync };