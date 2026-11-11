// The licence: signing and checking, the life of a licence (valid, expiring, grace, limited), limits, features, a clock set back, renewal requests.
const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const core = require('../license-core');
const licenseMod = require('../license');

const vendor = core.makeKeyPair(), KEYS = [{ kid: 'sw-test', pem: vendor.publicPem }];
const DAY = 86400000;
const T0 = Date.UTC(2026, 10, 10);                         // 10 Nov 2026

function server(opts = {}) {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE audit(id INTEGER PRIMARY KEY, ts INTEGER)');
    let t = opts.at ?? T0;
    const used = { cameras: 0, users: 0, employees: 0, companies: 0, live: 0 }, audits = [], mails = [];
    const make = () => licenseMod.create({ db, keys: opts.keys || KEYS, usage: () => used, audit: (...a) => audits.push(a), notify: async (s, b) => { mails.push([s, b]); }, env: { LICENSE_MODE: 'enforce', ...(opts.env || {}) }, now: () => t });
    const lic = make();
    return { db, lic, used, audits, mails, at: (x) => { t = x; lic.touch(); }, restart: () => make() };
}
const issue = (s, over = {}) => {
    const start = over.start ?? T0, term = over.term ?? '12m';
    const payload = { v: 1, serial: 'VG-2026-000001', customer: 'Ministry of Test', installId: s.lic.installId, issued: T0, start, expires: core.termEnd(start, term), term, ...over };
    delete payload.at;
    return core.sign(payload, vendor.privatePem, 'sw-test');
};

test('terms end on the last day, at the very end of it', () => {
    assert.strictEqual(new Date(core.termEnd(T0, '12m')).toISOString(), '2027-11-09T23:59:59.999Z');
    assert.strictEqual(new Date(core.termEnd(T0, '3m')).toISOString(), '2027-02-09T23:59:59.999Z');
    assert.strictEqual(new Date(core.termEnd(T0, '36m')).toISOString(), '2029-11-09T23:59:59.999Z');
    assert.strictEqual(new Date(core.termEnd(Date.UTC(2026, 10, 30), '3m')).toISOString(), '2027-02-27T23:59:59.999Z', '30 Nov + 3 months lands on the last day of February');
    assert.strictEqual(new Date(core.termEnd(Date.UTC(2027, 7, 31), '6m')).toISOString(), '2028-02-28T23:59:59.999Z'.replace('28', '28'), '31 Aug + 6 months: February is shorter');
});

test('a licence verifies, and any change to it, or a different key, breaks it', () => {
    const s = server(), lic = issue(s);
    assert.strictEqual(core.verify(lic, KEYS).ok, true);
    assert.strictEqual(core.verify(JSON.stringify(lic), KEYS).ok, true, 'as file text');
    const forged = { ...lic, payload: core.b64u(JSON.stringify({ ...JSON.parse(Buffer.from(lic.payload, 'base64url')), expires: T0 + 99 * 365 * DAY })) };
    assert.strictEqual(core.verify(forged, KEYS).code, 'signature');
    const other = core.makeKeyPair();
    assert.strictEqual(core.verify(lic, [{ kid: 'sw-test', pem: other.publicPem }]).code, 'signature');
    assert.strictEqual(core.verify(lic, [{ kid: 'someone-else', pem: vendor.publicPem }]).code, 'key');
    assert.strictEqual(core.verify('not json', KEYS).code, 'format');
    assert.strictEqual(core.verify({ format: 'x' }, KEYS).code, 'format');
});

test('a licence that says nonsense cannot even be signed', () => {
    const base = { v: 1, serial: 'VG-1-2', customer: 'X', installId: '*', issued: T0, start: T0, expires: T0 + DAY };
    for (const bad of [{ expires: T0 - 1 }, { limits: { cameras: -1 } }, { limits: { dragons: 3 } }, { features: ['telepathy'] }, { installId: 'VG-NOPE' }, { graceDays: 9999 }, { afterExpiry: 'explode' }, { customer: '' }]) {
        assert.throws(() => core.sign({ ...base, ...bad }, vendor.privatePem, 'k'), undefined, JSON.stringify(bad));
    }
    assert.doesNotThrow(() => core.sign(base, vendor.privatePem, 'k'));
});

test('mode off (Smart Way hosted): no licence needed, nothing limited', () => {
    const s = server({ env: { LICENSE_MODE: 'off' } });
    assert.strictEqual(s.lic.status().state, 'off');
    s.used.cameras = 5000; assert.strictEqual(s.lic.allow('camera').ok, true);
    assert.strictEqual(s.lic.has('ai'), true);
    assert.strictEqual(s.lic.summary({ role: 'admin' }).show, false);
});

test('a new installation gets a 30-day trial with a small camera limit, then limited mode', () => {
    const s = server();
    let st = s.lic.status();
    assert.strictEqual(st.state, 'trial'); assert.strictEqual(st.daysLeft, 30); assert.deepStrictEqual(st.limits, { cameras: 10 });
    s.used.cameras = 9; assert.strictEqual(s.lic.allow('camera').ok, true);
    s.used.cameras = 10; const no = s.lic.allow('camera'); assert.strictEqual(no.ok, false); assert.match(no.error, /allows 10 cameras and 10 are in use/);
    s.at(T0 + 29 * DAY); assert.strictEqual(s.lic.status().state, 'trial');
    s.at(T0 + 31 * DAY); assert.strictEqual(s.lic.status().state, 'restricted');
    assert.strictEqual(s.lic.allow('camera').ok, false); assert.strictEqual(s.lic.allow('user').code, 'license_restricted');
    assert.strictEqual(s.lic.allow('live').ok, true, 'watching live is a safety function, never refused');
});

test('the trial can be switched off or lengthened by the environment', () => {
    assert.strictEqual(server({ env: { LICENSE_TRIAL_DAYS: '0' } }).lic.status().state, 'restricted');
    assert.strictEqual(server({ env: { LICENSE_TRIAL_DAYS: '90' } }).lic.status().daysLeft, 90);
});

test('a licence is installed once, for this installation, and shows its life: valid, expiring, grace, limited', () => {
    const s = server();
    const r = s.lic.install(issue(s, { limits: { cameras: 300, employees: 800 }, features: ['reports', 'docking', 'checkout'], graceDays: 20 }), 'admin');
    assert.strictEqual(r.ok, true);
    let st = s.lic.status();
    assert.strictEqual(st.state, 'valid'); assert.strictEqual(st.customer, 'Ministry of Test'); assert.strictEqual(st.daysLeft, 365); assert.strictEqual(st.limits.cameras, 300);
    assert.deepStrictEqual(s.audits.at(-1).slice(0, 3), ['admin', 'license_installed', null]);
    assert.strictEqual(s.lic.has('ai'), false, 'not in this licence'); assert.strictEqual(s.lic.has('reports'), true);
    const end = st.expires;
    s.at(end - 31 * DAY); assert.strictEqual(s.lic.status().state, 'valid');
    s.at(end - 29 * DAY); assert.strictEqual(s.lic.status().state, 'expiring');
    s.at(end - 1000); assert.strictEqual(s.lic.status().state, 'expiring');
    s.at(end + 5 * DAY); st = s.lic.status(); assert.strictEqual(st.state, 'grace'); assert.strictEqual(st.graceUntil, end + 20 * DAY);
    assert.strictEqual(s.lic.allow('camera').ok, true, 'in grace everything still works');
    s.at(end + 21 * DAY); assert.strictEqual(s.lic.status().state, 'restricted');
    assert.strictEqual(s.lic.allow('camera').ok, false);
});

test('a licence that asks for "locked" really locks after the grace period', () => {
    const s = server(); s.lic.install(issue(s, { afterExpiry: 'locked', graceDays: 0 }), 'admin');
    const end = s.lic.status().expires;
    s.at(end + 1000); assert.strictEqual(s.lic.status().state, 'locked'); assert.strictEqual(s.lic.locked(), true);
});

test('a licence for another installation, a forged one, or an old one is refused', () => {
    const s = server(), other = server();
    const wrongBox = s.lic.install(issue(other), 'admin');
    assert.strictEqual(wrongBox.status, 409); assert.match(wrongBox.error, /another installation/);
    assert.strictEqual(s.lic.install('garbage', 'admin').status, 400);
    const old = issue(s, { start: T0 - 800 * DAY });
    assert.match(s.lic.install(old, 'admin').error, /ended/);
    assert.strictEqual(s.lic.status().state, 'trial', 'nothing was installed');
    assert.strictEqual(s.lic.install(issue(s, { installId: '*' }), 'admin').ok, true, 'a "*" licence (for testing) works anywhere');
});

test('the licence survives a restart, and a licence from an unknown key is ignored with the reason', () => {
    const s = server(); s.lic.install(issue(s), 'admin');
    assert.strictEqual(s.restart().status().state, 'valid');
    const rotated = licenseMod.create({ db: s.db, keys: [{ kid: 'sw-new', pem: core.makeKeyPair().publicPem }], usage: () => ({}), env: { LICENSE_MODE: 'enforce' }, now: () => T0 });
    const st = rotated.status();
    assert.strictEqual(st.state, 'trial'); assert.match(st.problem, /key this server does not know|signature/);
});

test('limits count what is already in use', () => {
    const s = server(); s.lic.install(issue(s, { limits: { cameras: 3, employees: 2, companies: 1, users: 5, live: 1 } }), 'admin');
    s.used.cameras = 2; assert.strictEqual(s.lic.allow('camera').ok, true);
    s.used.cameras = 3; const r = s.lic.allow('camera'); assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'license_limit'); assert.match(r.error, /3 cameras/);
    s.used.employees = 1; assert.strictEqual(s.lic.allow('employee').ok, true); assert.strictEqual(s.lic.allow('employee', 2).ok, false, 'a batch that would go over');
    s.used.companies = 1; assert.strictEqual(s.lic.allow('company').ok, false);
    s.used.live = 1; assert.strictEqual(s.lic.allow('live').ok, false);
    const free = server(); free.lic.install(issue(free), 'admin'); free.used.cameras = 99999;
    assert.strictEqual(free.lic.allow('camera').ok, true, 'no limit in the licence = unlimited');
});

test('a clock set back to dodge the expiry puts the system in limited mode', () => {
    const s = server(); s.lic.install(issue(s), 'admin');
    s.at(T0 + 100 * DAY); s.lic.tick();                          // the server has seen day 100
    assert.strictEqual(s.lic.status().state, 'valid');
    s.at(T0 + 99 * DAY + 3600000); assert.strictEqual(s.lic.status().state, 'valid', 'a day of slack is fine (time zone, NTP)');
    s.at(T0 + 50 * DAY);
    const st = s.lic.status();
    assert.strictEqual(st.state, 'restricted'); assert.strictEqual(st.clock, true);
    assert.match(s.lic.allow('camera').error, /clock/);
    // the audit trail is a second witness: a later entry also proves the clock went back
    const t = server(); t.lic.install(issue(t), 'admin');
    t.db.prepare('INSERT INTO audit(ts) VALUES(?)').run(T0 + 200 * DAY);
    t.at(T0 + 10 * DAY); assert.strictEqual(t.lic.status().clock, true);
});

test('the guard blocks growth and exports when limited, never the safety functions', () => {
    const s = server({ env: { LICENSE_TRIAL_DAYS: '0' } });
    const run = (method, path) => { const out = { code: 200 }; const res = { status(c) { out.code = c; return this; }, json(b) { out.body = b; }, redirect(u) { out.redirect = u; } }; let passed = false; s.lic.guard({ method, path }, res, () => { passed = true; }); return { ...out, passed }; };
    for (const [m, p] of [['POST', '/api/admin/companies'], ['POST', '/api/admin/companies/3/users'], ['POST', '/api/admin/companies/3/employees'], ['POST', '/api/admin/cameras/BWC-1/token'],
        ['PUT', '/api/admin/update/apk'], ['GET', '/api/report'], ['GET', '/api/audit/export.csv'], ['GET', '/api/assignments/export.csv'], ['POST', '/api/analytics/ai']]) {
        const r = run(m, p); assert.strictEqual(r.passed, false, `${m} ${p}`); assert.strictEqual(r.code, 402); assert.strictEqual(r.body.code, 'license_restricted');
    }
    for (const [m, p] of [['GET', '/api/me'], ['GET', '/api/license'], ['POST', '/api/license'], ['POST', '/api/login'], ['GET', '/api/docks'], ['POST', '/api/dock/upload'], ['POST', '/api/station/login'],
        ['GET', '/api/stream/BWC-1'], ['POST', '/api/tickets'], ['DELETE', '/api/admin/users/4'], ['POST', '/api/admin/users/4/password'], ['GET', '/api/recordings'], ['GET', '/index.html']]) {
        assert.strictEqual(run(m, p).passed, true, `${m} ${p}`);
    }
    const ok = server(); ok.lic.install(issue(ok), 'admin');
    assert.strictEqual((() => { let p = false; ok.lic.guard({ method: 'GET', path: '/api/report' }, {}, () => { p = true; }); return p; })(), true, 'a valid licence blocks nothing');
});

test('when locked, pages go to the licence page and the API closes except what is needed to renew', () => {
    const s = server(); s.lic.install(issue(s, { afterExpiry: 'locked', graceDays: 0 }), 'admin'); s.at(s.lic.status().expires + 1000);
    const run = (method, path) => { const out = { passed: false }; s.lic.guard({ method, path }, { status(c) { out.code = c; return this; }, json(b) { out.body = b; }, redirect(u) { out.redirect = u; } }, () => { out.passed = true; }); return out; };
    assert.strictEqual(run('GET', '/').redirect, '/license.html'); assert.strictEqual(run('GET', '/analytics.html').redirect, '/license.html');
    assert.strictEqual(run('GET', '/api/cameras').code, 402); assert.strictEqual(run('GET', '/api/recordings').code, 402);
    for (const p of ['/api/license', '/api/me', '/api/login', '/api/tickets', '/api/mobile/config', '/api/dock/report', '/api/update/apk']) assert.strictEqual(run('POST', p).passed, true, p);
    assert.strictEqual(run('GET', '/license.html').passed, true);
});

test('features can be left out of a licence', () => {
    const s = server(); s.lic.install(issue(s, { features: ['docking'] }), 'admin');
    const run = (f) => { let code = 200, passed = false; s.lic.gate(f)({}, { status(c) { code = c; return this; }, json() {} }, () => { passed = true; }); return { code, passed }; };
    assert.deepStrictEqual(run('docking'), { code: 200, passed: true });
    assert.deepStrictEqual(run('ai'), { code: 402, passed: false });
});

test('a renewal request is signed by this installation and carries what Smart Way needs to decide', () => {
    const s = server(); s.used.cameras = 42; s.used.employees = 120; s.lic.install(issue(s), 'admin');
    const r = s.lic.request('24m', 'we need 100 more cameras');
    const v = core.verifyRequest(r.file);
    assert.strictEqual(v.ok, true); assert.strictEqual(v.installId, s.lic.installId);
    assert.strictEqual(v.payload.term, '24m'); assert.strictEqual(v.payload.currentSerial, 'VG-2026-000001'); assert.strictEqual(v.payload.usage.cameras, 42); assert.strictEqual(v.payload.usage.employees, 120);
    assert.match(v.payload.note, /100 more/);
    const edited = { ...r.file, payload: core.b64u(JSON.stringify({ ...v.payload, term: '36m' })) };
    assert.match(core.verifyRequest(edited).error, /changed/);
    assert.strictEqual(s.lic.request('7m').status, 400);
});

test('reminders go out once per step: 60, 30, 14, 7, 3, 1 days, then when it expires', () => {
    const s = server(); s.lic.install(issue(s, { term: '3m' }), 'admin');
    const end = s.lic.status().expires, tick = (t) => { s.at(t); s.lic.tick(); };
    tick(end - 70 * DAY); assert.strictEqual(s.mails.length, 0, 'far from the end');
    tick(end - 59 * DAY); assert.strictEqual(s.mails.length, 1); assert.match(s.mails[0][0], /expires in 59 day/);
    tick(end - 58 * DAY); assert.strictEqual(s.mails.length, 1, 'the same step is not repeated');
    tick(end - 29 * DAY); tick(end - 13 * DAY); tick(end - 6 * DAY); tick(end - 2 * DAY); tick(end - 0.5 * DAY);
    assert.strictEqual(s.mails.length, 6);
    tick(end + 2 * DAY); assert.match(s.mails.at(-1)[0], /expired \(grace/);
    tick(end + 40 * DAY); assert.match(s.mails.at(-1)[0], /limited mode/);
    const n = s.mails.length; tick(end + 41 * DAY); assert.strictEqual(s.mails.length, n);
    assert.ok(s.audits.some((a) => a[1] === 'license_warning'));
    // a new licence starts the reminders over
    s.lic.install(issue(s, { serial: 'VG-2026-000002', start: end + 41 * DAY, term: '3m' }), 'admin');
    assert.strictEqual(s.lic.status().state, 'valid');
});

test('who sees the banner: administrators early, everybody when it matters', () => {
    const s = server(), admin = { role: 'admin', companyId: null }, user = { role: 'client', companyId: 3 };
    s.lic.install(issue(s, { term: '3m' }), 'admin');
    const end = s.lic.status().expires;
    s.at(end - 80 * DAY); assert.deepStrictEqual([s.lic.summary(admin).show, s.lic.summary(user).show], [false, false]);
    s.at(end - 20 * DAY); assert.deepStrictEqual([s.lic.summary(admin).show, s.lic.summary(user).show], [true, false]);
    s.at(end - 5 * DAY); assert.deepStrictEqual([s.lic.summary(admin).show, s.lic.summary(user).show], [true, true]);
    s.at(end + 3 * DAY); assert.strictEqual(s.lic.summary(user).show, true); assert.strictEqual(s.lic.summary(user).canManage, false); assert.strictEqual(s.lic.summary(admin).canManage, true);
});
