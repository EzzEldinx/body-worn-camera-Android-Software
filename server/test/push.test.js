const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createPush, buildMessage, jwtAssertion } = require('../push');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const sa = { project_id: 'vg-test', client_email: 'push@vg-test.iam.gserviceaccount.com', private_key: privateKey };

test('the OAuth assertion is a valid RS256 JWT for the FCM scope', () => {
    const [h, b, s] = jwtAssertion(sa, 1000).split('.');
    assert.deepStrictEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
    const body = JSON.parse(Buffer.from(b, 'base64url'));
    assert.strictEqual(body.iss, sa.client_email);
    assert.strictEqual(body.exp - body.iat, 3600);
    assert.match(body.scope, /firebase\.messaging/);
    assert.ok(crypto.createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, s, 'base64url'));
});

test('messages are high priority and carry what the app needs to open the alarm', () => {
    const alarm = { id: 7, cameraId: 'BWC-06', lat: 24.7136, lng: 46.6753, ts: 5 };
    const a = buildMessage('tok', 'android', alarm, 'Officer 6');
    assert.strictEqual(a.android.priority, 'HIGH');
    assert.deepStrictEqual(a.data, { type: 'sos', alarmId: '7', cameraId: 'BWC-06', ts: '5' });
    assert.match(a.notification.body, /24\.7136, 46\.6753/);
    const i = buildMessage('tok', 'ios', { ...alarm, lat: null, lng: null }, 'Officer 6');
    assert.strictEqual(i.apns.payload.aps['interruption-level'], 'time-sensitive');
    assert.match(i.notification.body, /no GPS fix/);
});

function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-push-'));
    const keyFile = path.join(dir, 'sa.json'); fs.writeFileSync(keyFile, JSON.stringify(sa));
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY, company_id INTEGER); CREATE TABLE cameras(id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE push_devices(token TEXT PRIMARY KEY, user_id INTEGER, platform TEXT, session TEXT, created INTEGER);
      INSERT INTO users VALUES (1, NULL), (2, 10), (3, 20); INSERT INTO cameras VALUES ('BWC-06', 'Officer 6');
      INSERT INTO push_devices VALUES ('staff-tok', 1, 'ios', NULL, 0), ('acme-tok', 2, 'android', NULL, 0), ('other-tok', 3, 'android', NULL, 0);`);
    return { db, env: { FCM_SERVICE_ACCOUNT: keyFile }, dir };
}

test('an SOS reaches the camera\'s company and staff, never another company', async () => {
    const { db, env, dir } = setup(); const sent = [];
    const fetchImpl = async (url, opt) => {
        if (url.includes('oauth2')) return { ok: true, status: 200, json: async () => ({ access_token: 'AT', expires_in: 3600 }) };
        sent.push(JSON.parse(opt.body).message.token); return { ok: true, status: 200, json: async () => ({}) };
    };
    const p = createPush({ db, env, fetchImpl, log: { warn() {} } });
    assert.ok(p.enabled());
    const r = await p.notifyAlarm({ id: 1, cameraId: 'BWC-06', lat: 1, lng: 2, ts: 3 }, 10);
    assert.strictEqual(r.sent, 2);
    assert.deepStrictEqual(sent.sort(), ['acme-tok', 'staff-tok']);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('tokens of uninstalled apps are dropped; push is a no-op when not configured', async () => {
    const { db, env, dir } = setup();
    const fetchImpl = async (url, opt) => (url.includes('oauth2') ? { ok: true, status: 200, json: async () => ({ access_token: 'AT' }) }
        : { ok: false, status: JSON.parse(opt.body).message.token === 'acme-tok' ? 404 : 200, json: async () => ({}) });
    const p = createPush({ db, env, fetchImpl, log: { warn() {} } });
    await p.notifyAlarm({ id: 1, cameraId: 'BWC-06', lat: 1, lng: 2, ts: 3 }, 10);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM push_devices WHERE token = ?').get('acme-tok').n, 0);
    const off = createPush({ db, env: {}, fetchImpl, log: { warn() {} } });
    assert.strictEqual(off.enabled(), false);
    assert.deepStrictEqual(await off.notifyAlarm({ id: 1, cameraId: 'x', ts: 1 }, null), { sent: 0, skipped: 'push not configured' });
    fs.rmSync(dir, { recursive: true, force: true });
});
