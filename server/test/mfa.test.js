// Two-step sign-in (mfa.js): the TOTP maths against the RFC 6238 test vector, then the whole flow on a real server:
// set-up, sign-in with a code (web and app), a code never works twice, recovery codes work once, switching off needs password + code,
// and an administrator can switch it off for someone who lost their phone.
// Run: node --test test/mfa.test.js
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mfa = require('../mfa');

test('TOTP matches the RFC 6238 test vector and accepts one step of clock drift', () => {
    const secret = mfa.b32encode(Buffer.from('12345678901234567890'));
    assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    assert.equal(mfa.codeAt(secret, mfa.counterAt(59000)), '287082');          // RFC 6238: 94287082 at T=59 (last 6 digits)
    assert.equal(mfa.codeAt(secret, mfa.counterAt(1111111109000)), '081804');  // 07081804 at T=1111111109
    const now = 1111111109000, step = mfa.counterAt(now);
    assert.equal(mfa.match(secret, mfa.codeAt(secret, step - 1), now), step - 1, 'the previous step is accepted');
    assert.equal(mfa.match(secret, mfa.codeAt(secret, step + 2), now), null, 'two steps away is not');
    assert.equal(mfa.match(secret, mfa.codeAt(secret, step), now, step), null, 'a step already used is refused');
    assert.equal(mfa.match(secret, 'abc', now), null);
    assert.match(mfa.otpauthUrl(secret, 'ezz'), /^otpauth:\/\/totp\/VisionGuard:ezz\?secret=GEZDG/);
});

test('the sign-in flow on a real server', async () => {
    const PORT = 3861, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-mfa-'));
    const proc = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), stdio: 'pipe',
        env: { ...process.env, PORT, FLV_PORT: 8861, RTMP_PORT: 1861, DATA_DIR: dir, ADMIN_PASSWORD: 'mfa-test-pw', BWC_TOKEN: 'camtoken', STREAM_SECRET: 's' } });
    const base = `http://127.0.0.1:${PORT}`;
    const call = async (p, body, cookie, bearer) => {
        const r = await fetch(base + p, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, json: await r.json().catch(() => ({})), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
    };
    try {
        await new Promise((res, rej) => { proc.stdout.on('data', (d) => /Dashboard is running/.test(String(d)) && res()); proc.on('exit', () => rej(new Error('server exited'))); setTimeout(() => rej(new Error('no start')), 15000); });
        // no MFA yet: password alone signs in
        const first = await call('/api/login', { username: 'admin', password: 'mfa-test-pw' });
        assert.equal(first.status, 200); assert.ok(first.cookie.startsWith('sid='));
        const ck = first.cookie;
        assert.equal((await call('/api/me/mfa', null, ck)).json.enabled, false);
        // set-up: a wrong code does not switch it on, the right one does and returns 10 recovery codes
        const setup = (await call('/api/me/mfa/setup', {}, ck)).json;
        assert.match(setup.url, /^otpauth:\/\/totp\//);
        assert.equal((await call('/api/me/mfa/enable', { code: '000000' }, ck)).status, 400);
        const step0 = mfa.counterAt(Date.now());
        const on = await call('/api/me/mfa/enable', { code: mfa.codeAt(setup.secret, step0) }, ck);
        assert.equal(on.status, 200); assert.equal(on.json.recoveryCodes.length, 10);
        // web sign-in now stops at the challenge: no cookie until the code
        const s1 = await call('/api/login', { username: 'admin', password: 'mfa-test-pw' });
        assert.equal(s1.json.mfa, true); assert.ok(s1.json.challenge); assert.equal(s1.cookie, '');
        const bad = await call('/api/login/mfa', { challenge: s1.json.challenge, code: '123456' });
        assert.equal(bad.status, 401); assert.equal(bad.json.code, 'mfa_wrong');
        assert.equal((await call('/api/login/mfa', { challenge: s1.json.challenge, code: mfa.codeAt(setup.secret, step0) })).status, 401, 'the code used for the set-up cannot be used again');
        const good = await call('/api/login/mfa', { challenge: s1.json.challenge, code: mfa.codeAt(setup.secret, step0 + 1) });
        assert.equal(good.status, 200); assert.ok(good.cookie.startsWith('sid='));
        assert.equal((await call('/api/login/mfa', { challenge: s1.json.challenge, code: mfa.codeAt(setup.secret, step0 + 1) })).status, 401, 'a challenge is used up');
        // the app: same steps, a recovery code works once
        const m1 = await call('/api/mobile/login', { username: 'admin', password: 'mfa-test-pw' });
        assert.equal(m1.json.mfa, true);
        const rec = on.json.recoveryCodes[0];
        const m2 = await call('/api/mobile/login/mfa', { challenge: m1.json.challenge, code: rec });
        assert.equal(m2.status, 200); assert.ok(m2.json.token);
        const m3 = await call('/api/mobile/login', { username: 'admin', password: 'mfa-test-pw' });
        assert.equal((await call('/api/mobile/login/mfa', { challenge: m3.json.challenge, code: rec })).status, 401, 'a recovery code works once');
        assert.equal((await call('/api/me/mfa', null, null, m2.json.token)).json.recoveryLeft, 9);
        // five wrong codes end the challenge
        const m4 = await call('/api/mobile/login', { username: 'admin', password: 'mfa-test-pw' });
        for (let i = 0; i < 5; i++) await call('/api/mobile/login/mfa', { challenge: m4.json.challenge, code: '111111' });
        assert.equal((await call('/api/mobile/login/mfa', { challenge: m4.json.challenge, code: mfa.codeAt(setup.secret, mfa.counterAt(Date.now()) + 1) })).status, 429);
        // switching off needs the password and a current code
        assert.equal((await call('/api/me/mfa/disable', { password: 'wrong', code: '000000' }, good.cookie)).status, 401);
        // an administrator can reset someone else's: make a company manager with MFA and reset it
        const co = await call('/api/admin/companies', { name: 'MFA Co', adminUsername: 'mgr1', adminPassword: 'mgr1-password' }, good.cookie);
        assert.ok([200, 201].includes(co.status), JSON.stringify(co.json));
        const mgr = await call('/api/login', { username: 'mgr1', password: 'mgr1-password' });
        const ms = (await call('/api/me/mfa/setup', {}, mgr.cookie)).json;
        assert.equal((await call('/api/me/mfa/enable', { code: mfa.codeAt(ms.secret, mfa.counterAt(Date.now())) }, mgr.cookie)).status, 200);
        const list = (await call('/api/admin/companies', null, good.cookie)).json;
        const mgrRow = (list.companies || list).flatMap((c) => c.users || []).find((u) => u.username === 'mgr1');
        assert.equal(mgrRow.mfa, 1);
        assert.equal((await call(`/api/users/${mgrRow.id}/mfa-reset`, {}, good.cookie)).status, 200);
        assert.equal((await call('/api/login', { username: 'mgr1', password: 'mgr1-password' })).json.mfa, undefined, 'after the reset the password alone works again');
    } finally { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});
