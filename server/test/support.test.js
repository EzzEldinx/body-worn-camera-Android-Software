const test = require('node:test');
const assert = require('node:assert');
const { createMailer } = require('../support');

test('support mail goes to the support desk, and never breaks a ticket when it fails', async () => {
    const sent = [];
    const m = createMailer({ env: {}, transport: { sendMail: async (o) => { sent.push(o); } } });
    assert.strictEqual(m.to, 'sdpt@smart-way.com.sa');
    assert.deepStrictEqual(await m.send('[VG-00001] NORMAL: Hello', 'body'), { sent: true });
    assert.strictEqual(sent[0].to, 'sdpt@smart-way.com.sa'); assert.match(sent[0].from, /smart-way\.com\.sa/);
    const broken = createMailer({ env: {}, transport: { sendMail: async () => { throw new Error('connection refused'); } } });
    const r = await broken.send('s', 'b'); assert.strictEqual(r.sent, false); assert.match(r.reason, /connection refused/);
    const none = createMailer({ env: {} });
    assert.strictEqual(none.configured, false); assert.strictEqual((await none.send('s', 'b')).sent, false);   // not configured: stored, not mailed
    assert.strictEqual(createMailer({ env: { SUPPORT_EMAIL: 'x@y.sa', SMTP_HOST: 'h' } }).to, 'x@y.sa');
});
