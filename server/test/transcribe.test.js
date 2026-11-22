// Live captions: who may have them, and how the sentences are kept. Run: node --test test/transcribe.test.js
const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const features = require('../features');
const transcribe = require('../transcribe');

const make = (env = {}) => {
    const db = new DatabaseSync(':memory:'), audited = [];
    const t = transcribe.init({ db, audit: (a, cam) => audited.push([a, cam]), log: { warn() {}, log() {} }, env });
    return { db, t, audited };
};

test('captions are off without a service address and token', () => {
    assert.equal(make({}).t.enabled, false);
    assert.equal(make({ TRANSCRIBE_URL: 'http://x' }).t.enabled, false);
    assert.equal(make({ TRANSCRIBE_URL: 'http://x', TRANSCRIBE_TOKEN: 't' }).t.enabled, true);
});

test('only the right token is accepted (and nothing when captions are off)', () => {
    const on = make({ TRANSCRIBE_URL: 'http://x', TRANSCRIBE_TOKEN: 'secret' }).t;
    assert.equal(on.tokenOk('secret'), true);
    assert.equal(on.tokenOk('secreT'), false);
    assert.equal(on.tokenOk('secretsecret'), false);
    assert.equal(on.tokenOk(''), false);
    assert.equal(on.tokenOk(undefined), false);
    assert.equal(make({}).t.tokenOk(''), false);
});

test('sentences are kept in order, cleaned and limited', () => {
    const { t } = make({ TRANSCRIBE_URL: 'http://x', TRANSCRIBE_TOKEN: 't' });
    const a = t.record({ cameraId: 'C1', text: '  مرحبا   بك  ', lang: 'ar', ts: Date.now() });
    const b = t.record({ cameraId: 'C1', text: 'hello', lang: 'en' });
    t.record({ cameraId: 'C2', text: 'other camera' });
    assert.equal(a.text, 'مرحبا بك');
    assert.ok(b.id > a.id);
    assert.equal(t.record({ cameraId: 'C1', text: '   ' }), null, 'an empty sentence is dropped');
    assert.equal(t.record({ cameraId: '', text: 'x' }), null);
    assert.equal(t.record({ cameraId: 'C1', text: 'x'.repeat(5000) }).text.length, 2000);
    assert.deepEqual(t.history('C1').slice(0, 2).map((l) => l.text), ['مرحبا بك', 'hello']);
    assert.equal(t.history('C2').length, 1, 'cameras are kept apart');
    assert.equal(t.history('C1', { limit: 1 }).length, 1, 'the limit is respected');
    assert.equal(t.history('C1', { after: b.id }).length, 1, '"after" returns only newer lines');
});

test('a draft is shown but never kept; the final of the same sentence is kept', () => {
    const { t } = make({ TRANSCRIBE_URL: 'http://x', TRANSCRIBE_TOKEN: 't' });
    const d = t.record({ cameraId: 'C1', text: 'مرحبا', partial: true, utt: 4 });
    assert.deepEqual([d.partial, d.id, d.utt], [true, 0, 4]);
    assert.equal(t.history('C1').length, 0, 'a draft is not stored');
    const f = t.record({ cameraId: 'C1', text: 'مرحبا بك', partial: false, utt: 4 });
    assert.deepEqual([f.partial, f.utt], [false, 4]);
    assert.ok(f.id > 0);
    assert.equal(t.history('C1').length, 1);
    assert.equal(t.record({ cameraId: 'C1', text: 'x', utt: 'abc' }).utt, 0, 'a bad sentence number is ignored');
});

test('a clock that is far off is replaced by the server time', () => {
    const { t } = make({ TRANSCRIBE_URL: 'http://x', TRANSCRIBE_TOKEN: 't' });
    const l = t.record({ cameraId: 'C1', text: 'x', ts: 5 });
    assert.ok(Math.abs(l.ts - Date.now()) < 5000);
});

test('old sentences are removed after the retention days', () => {
    const { t, db } = make({ TRANSCRIBE_URL: 'http://x', TRANSCRIBE_TOKEN: 't', TRANSCRIPT_DAYS: '7' });
    assert.equal(t.days, 7);
    t.record({ cameraId: 'C1', text: 'new' });
    db.prepare('INSERT INTO transcripts(ts,camera_id,text) VALUES(?,?,?)').run(Date.now() - 8 * 86400000, 'C1', 'old');
    assert.equal(t.sweep(), 1);
    assert.deepEqual(t.history('C1').map((l) => l.text), ['new']);
});

test('starting is audited once, and a failing service never throws', async () => {
    const { t, audited } = make({ TRANSCRIBE_URL: 'http://127.0.0.1:9', TRANSCRIBE_TOKEN: 't' });
    assert.equal(await t.start('C1', { playUrl: 'rtmp://x/live/C1', callback: 'http://x' }), false, 'nobody is listening on that port');
    assert.deepEqual(audited, []);
    await t.stop('C1');
});

test('Live captions are never on by default: Smart Way has to tick them for a company', () => {
    const co = (f) => features.ceiling(f);
    assert.ok(!co(null).includes('transcribe'), 'a company without a chosen list does not get them');
    assert.ok(!features.effective({ role: 'client', companyFeatures: null, perms: null }).includes('transcribe'));
    assert.ok(features.effective({ staff: true }).includes('transcribe'), 'Smart Way staff can use them');
    const ticked = features.store(['live', 'transcribe'], true);
    assert.ok(features.ceiling(ticked).includes('transcribe'));
    assert.ok(features.effective({ role: 'manager', manager: true, companyFeatures: ticked }).includes('transcribe'));
    assert.ok(!features.effective({ role: 'client', companyFeatures: ticked, perms: null }).includes('transcribe'), 'a user needs it given to them too');
    assert.ok(features.effective({ role: 'client', companyFeatures: ticked, perms: JSON.stringify(['live', 'transcribe']) }).includes('transcribe'));
    assert.ok(!features.clean(['transcribe']).includes('transcribe'), 'it needs the live dashboard');
    assert.equal(features.ruleFor('/api/transcripts/BWC-01'), 'transcribe');
});
