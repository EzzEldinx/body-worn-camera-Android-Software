// Add a dispatcher or reset a password. Run from the project root:
//   node tools/create-user.js <username> <password> ["Full name"] [admin|viewer]
const { db, hashPassword } = require('../db');
const [, , username, password, name = username, role = 'viewer'] = process.argv;
if (!username || !password || password.length < 8 || !['admin', 'viewer'].includes(role)) {
    console.log('Usage: node tools/create-user.js <username> <password (8+ chars)> ["Full name"] [admin|viewer]');
    process.exit(1);
}
db.prepare(`INSERT INTO users(username,name,pass,role) VALUES(?,?,?,?)
  ON CONFLICT(username) DO UPDATE SET name=excluded.name, pass=excluded.pass, role=excluded.role`)
    .run(username, name, hashPassword(password), role);
console.log(`User "${username}" saved with role ${role}.`);