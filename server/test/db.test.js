const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bwc-test-'));
const { db, hashPassword, verifyPassword } = require('../db');

test('password hashing verifies correct and rejects wrong password', () => {
    const h = hashPassword('S3cret-pass');
    assert.ok(verifyPassword('S3cret-pass', h));
    assert.ok(!verifyPassword('wrong', h));
});

test('schema is created with default regions', () => {
    const names = db.prepare('SELECT name FROM regions').all().map(r => r.name);
    assert.deepStrictEqual(names.sort(), ['Dammam', 'Jeddah', 'Riyadh']);
});
