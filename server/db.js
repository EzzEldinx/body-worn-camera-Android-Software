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