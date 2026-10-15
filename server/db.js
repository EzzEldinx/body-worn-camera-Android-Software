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
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pass TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer');
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, exp INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cameras(id TEXT PRIMARY KEY, name TEXT, grp TEXT, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS alarms(id INTEGER PRIMARY KEY AUTOINCREMENT, camera_id TEXT NOT NULL, lat REAL, lng REAL, ts INTEGER NOT NULL, ack_by TEXT, ack_ts INTEGER);
CREATE TABLE IF NOT EXISTS positions(id INTEGER PRIMARY KEY AUTOINCREMENT, camera_id TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS pos_cam_ts ON positions(camera_id, ts);
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
addColumn('cameras', 'company_id', 'INTEGER');
addColumn('cameras', 'region', 'TEXT');
db.exec('CREATE TABLE IF NOT EXISTS deleted_cameras(id TEXT PRIMARY KEY, ts INTEGER NOT NULL)');
db.exec('CREATE TABLE IF NOT EXISTS regions(name TEXT PRIMARY KEY, created INTEGER NOT NULL)');
if (!db.prepare('SELECT 1 FROM regions LIMIT 1').get()) {
    ['Riyadh', 'Jeddah', 'Dammam'].forEach((n, i) => db.prepare('INSERT INTO regions(name,created) VALUES(?,?)').run(n, Date.now() + i));
}

function hashPassword(pw) {
    const salt = crypto.randomBytes(16).toString('hex');
    return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function verifyPassword(pw, stored) {
    const [salt, hash] = stored.split(':');
    const a = Buffer.from(hash, 'hex');
    const b = crypto.scryptSync(pw, salt, 64);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { db, hashPassword, verifyPassword };