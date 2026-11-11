// Unit tests of hardening.js: no server, no network, fake clocks. Run with: node --test test/hardening.test.js
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { safeCookies, guard, tokenBucket, loginLimiter, securityHeaders, housekeeping, processGuards } = require('../hardening');

const quiet = { log() {}, warn() {}, error() {} };
const clock = (t = 1_000_000) => { const c = () => t; c.add = (ms) => { t += ms; }; return c; };

// ---------- safeCookies ----------
test('cookies: a normal header is parsed and decoded', () => {
    assert.deepStrictEqual({ ...safeCookies('sid=abc; theme=dark%20blue') }, { sid: 'abc', theme: 'dark blue' });
});
test('cookies: broken percent-encoding never throws (it used to crash the process)', () => {
    for (const bad of ['sid=%', 'sid=%E0%A4%A', '%=%', 'sid=%zz; ok=1', '=;=;=', ';;;', 'sid', 'a=b=c']) assert.doesNotThrow(() => safeCookies(bad), bad);
    assert.strictEqual(safeCookies('sid=%').sid, '%');
    assert.strictEqual(safeCookies('sid=%zz; ok=1').ok, '1');
    assert.strictEqual(safeCookies('a=b=c').a, 'b=c');
});
test('cookies: anything that is not a sane header gives an empty object', () => {
    for (const bad of [undefined, null, 5, {}, [], '', 'x'.repeat(9000)]) assert.deepStrictEqual({ ...safeCookies(bad) }, {});
});
test('cookies: the first value wins and __proto__ cannot be set', () => {
    assert.strictEqual(safeCookies('sid=real; sid=injected').sid, 'real');
    const c = safeCookies('__proto__=x; sid=1');
    assert.strictEqual(Object.getPrototypeOf(c), Object.prototype); assert.strictEqual(c.sid, '1');
});

// ---------- guard ----------
test('guard: a throwing handler is logged, not rethrown', () => {
    const seen = [];
    const g = guard('socket camera_sos', () => { throw new Error('boom'); }, { error: (...a) => seen.push(a.join(' ')) });
    assert.doesNotThrow(() => g({ any: 'payload' }));
    assert.match(seen[0], /socket camera_sos failed:.*boom/s);
});
test('guard: a rejected promise is logged too, and a good handler keeps its result', async () => {
    const seen = [];
    await guard('job', async () => { throw new Error('later'); }, { error: (...a) => seen.push(a.join(' ')) })();
    await new Promise((r) => setImmediate(r));
    assert.match(seen[0], /job failed:.*later/s);
    assert.strictEqual(guard('ok', (a, b) => a + b, quiet)(2, 3), 5);
});

// ---------- tokenBucket ----------
test('bucket: allows a burst up to the capacity, then refuses', () => {
    const now = clock(), b = tokenBucket({ capacity: 5, refillPerSec: 1, now });
    for (let i = 0; i < 5; i++) assert.strictEqual(b.take('cam'), true);
    assert.strictEqual(b.take('cam'), false);
    assert.strictEqual(b.take('other'), true, 'one key never uses another key\'s allowance');
});
test('bucket: refills with time and never above the capacity', () => {
    const now = clock(), b = tokenBucket({ capacity: 5, refillPerSec: 2, now });
    for (let i = 0; i < 5; i++) b.take('k');
    now.add(1000);                                   // +2 tokens
    assert.strictEqual(b.take('k'), true); assert.strictEqual(b.take('k'), true); assert.strictEqual(b.take('k'), false);
    now.add(3600_000);                               // a long silence is not a licence for a huge burst
    let n = 0; while (b.take('k')) n++;
    assert.strictEqual(n, 5);
});
test('bucket: an expensive action costs more; idle keys are pruned', () => {
    const now = clock(), b = tokenBucket({ capacity: 10, refillPerSec: 1, now });
    assert.strictEqual(b.take('k', 8), true); assert.strictEqual(b.take('k', 8), false);
    b.take('idle'); now.add(700_000); b.take('fresh'); b.prune();
    assert.strictEqual(b.size, 1);
});

// ---------- loginLimiter ----------
const miss = (l, ip, user) => { if (!l.enter(ip, user)) return 'blocked'; return l.leave(ip, user, false) ? 'locked-now' : 'wrong'; };
const good = (l, ip, user) => { if (!l.enter(ip, user)) return 'blocked'; l.leave(ip, user, true); return 'ok'; };

test('login: five misses lock that username from that address, and only that one', () => {
    const l = loginLimiter({ now: clock() });
    assert.deepStrictEqual([1, 2, 3, 4, 5].map(() => miss(l, '1.1.1.1', 'sara')), ['wrong', 'wrong', 'wrong', 'wrong', 'locked-now']);
    assert.strictEqual(miss(l, '1.1.1.1', 'sara'), 'blocked');
    assert.strictEqual(miss(l, '1.1.1.1', 'SARA'), 'blocked', 'upper case is the same account');
    assert.strictEqual(good(l, '1.1.1.1', 'omar'), 'ok', 'a colleague behind the same address still signs in');
    assert.strictEqual(good(l, '2.2.2.2', 'sara'), 'ok', 'sara herself still signs in from somewhere else');
});
test('login: signing in to your own account does not reset the count on someone else\'s', () => {
    const l = loginLimiter({ now: clock() });
    for (let i = 0; i < 4; i++) miss(l, '1.1.1.1', 'victim');
    assert.strictEqual(good(l, '1.1.1.1', 'attacker'), 'ok');           // the old limiter forgot everything here
    assert.strictEqual(miss(l, '1.1.1.1', 'victim'), 'locked-now');
    assert.strictEqual(miss(l, '1.1.1.1', 'victim'), 'blocked');
});
test('login: walking through many usernames locks the address', () => {
    const l = loginLimiter({ perIp: 30, now: clock() });
    for (let i = 0; i < 29; i++) assert.strictEqual(miss(l, '9.9.9.9', 'user' + i), 'wrong');
    assert.strictEqual(miss(l, '9.9.9.9', 'user29'), 'locked-now');
    assert.strictEqual(good(l, '9.9.9.9', 'anyone'), 'blocked');
    assert.strictEqual(good(l, '8.8.8.8', 'anyone'), 'ok');
});
test('login: good sign-ins never add up to an address lock', () => {
    const l = loginLimiter({ perIp: 10, now: clock() });
    for (let i = 0; i < 200; i++) assert.strictEqual(good(l, '1.1.1.1', 'user' + (i % 7)), 'ok');
    assert.strictEqual(l.size, 0);
});
test('login: a burst of parallel guesses is counted before any answer comes back', () => {
    const l = loginLimiter({ now: clock() });
    const entered = Array.from({ length: 50 }, () => l.enter('1.1.1.1', 'victim')).filter(Boolean).length;   // 50 requests arrive together
    assert.strictEqual(entered, 5);
});
test('login: the lock ends after the window; the lock is reported once; old entries are pruned', () => {
    const now = clock(), l = loginLimiter({ windowMs: 300_000, now });
    const results = Array.from({ length: 8 }, () => miss(l, '1.1.1.1', 'sara'));
    assert.strictEqual(results.filter((r) => r === 'locked-now').length, 1);
    now.add(300_000);
    assert.strictEqual(l.blocked('1.1.1.1', 'sara'), false);
    assert.strictEqual(good(l, '1.1.1.1', 'sara'), 'ok');
    miss(l, '3.3.3.3', 'x'); now.add(300_000); l.prune();
    assert.strictEqual(l.size, 0);
});

// ---------- securityHeaders ----------
const fakeRes = () => { const h = {}; return { h, headersSent: false, setHeader: (k, v) => { h[k.toLowerCase()] = v; }, getHeader: (k) => h[k.toLowerCase()], json(b) { this.sent = b; return this; } }; };
test('headers: every answer gets the basic set; HSTS only over HTTPS', () => {
    const a = fakeRes(); let nexted = 0;
    securityHeaders({ secure: false, path: '/index.html' }, a, () => nexted++);
    assert.strictEqual(a.h['x-content-type-options'], 'nosniff'); assert.strictEqual(a.h['x-frame-options'], 'SAMEORIGIN'); assert.strictEqual(a.h['referrer-policy'], 'same-origin');
    assert.strictEqual(a.h['strict-transport-security'], undefined, 'plain HTTP must not pin HTTPS (the test server runs on HTTP)');
    const b = fakeRes(); securityHeaders({ secure: true, path: '/' }, b, () => nexted++);
    assert.match(b.h['strict-transport-security'], /max-age=\d+/); assert.strictEqual(nexted, 2);
});
test('headers: JSON from the API is never cached; files keep their own caching', () => {
    const api = fakeRes(); securityHeaders({ secure: false, path: '/api/me' }, api, () => {});
    assert.strictEqual(api.h['cache-control'], undefined, 'not before the handler decides what it sends');
    api.json({ ok: true });
    assert.strictEqual(api.h['cache-control'], 'no-store'); assert.deepStrictEqual(api.sent, { ok: true });
    const own = fakeRes(); securityHeaders({ secure: false, path: '/api/x' }, own, () => {}); own.setHeader('Cache-Control', 'private, max-age=5'); own.json({});
    assert.strictEqual(own.h['cache-control'], 'private, max-age=5');
});

// ---------- housekeeping ----------
const DAY = 86400000;
const seedDb = () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE positions(id INTEGER PRIMARY KEY AUTOINCREMENT, camera_id TEXT, lat REAL, lng REAL, ts INTEGER);
             CREATE INDEX pos_ts ON positions(ts, camera_id);
             CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, camera_id TEXT, type TEXT, info TEXT);
             CREATE TABLE sessions(token TEXT PRIMARY KEY, user_id INTEGER, exp INTEGER);`);
    return db;
};
test('housekeeping: old GPS points and expired sessions go, everything else stays', async () => {
    const db = seedDb(), now = 1_800_000_000_000;
    const ins = db.prepare('INSERT INTO positions(camera_id,lat,lng,ts) VALUES(?,?,?,?)');
    db.exec('BEGIN'); for (let i = 0; i < 2500; i++) ins.run('C' + (i % 5), 24, 46, now - 31 * DAY - i); for (let i = 0; i < 40; i++) ins.run('C1', 24, 46, now - 29 * DAY + i); db.exec('COMMIT');
    db.prepare('INSERT INTO events(ts,camera_id,type) VALUES(?,?,?)').run(now - 400 * DAY, 'C1', 'online');
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run('old', 1, now - 1); db.prepare('INSERT INTO sessions VALUES(?,?,?)').run('live', 1, now + 1000);
    let pauses = 0;
    const out = await housekeeping({ db, now, batch: 1000, pause: async () => { pauses++; } });
    assert.deepStrictEqual(out, { positions: 2500, events: 0, sessions: 1 });
    assert.strictEqual(pauses, 2, 'three batches (1000, 1000, 500): the event loop got its turn between them');
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM positions').get().n, 40);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM events').get().n, 1, 'activity lines are kept unless EVENTS_DAYS says otherwise');
    assert.deepStrictEqual(db.prepare('SELECT token FROM sessions').all().map((r) => r.token), ['live']);
});
test('housekeeping: activity lines are removed only when asked; a second run finds nothing', async () => {
    const db = seedDb(), now = 1_800_000_000_000;
    db.prepare('INSERT INTO events(ts,camera_id,type) VALUES(?,?,?)').run(now - 400 * DAY, 'C1', 'online');
    db.prepare('INSERT INTO events(ts,camera_id,type) VALUES(?,?,?)').run(now - 10 * DAY, 'C1', 'online');
    assert.strictEqual((await housekeeping({ db, now, eventsDays: 365 })).events, 1);
    assert.deepStrictEqual(await housekeeping({ db, now, eventsDays: 365 }), { positions: 0, events: 0, sessions: 0 });
});

// ---------- processGuards ----------
const fakeProcess = () => { const p = new EventEmitter(); const exits = []; return { p, exits, exit: (c) => exits.push(c) }; };
const settle = () => new Promise((r) => setTimeout(r, 20));
test('process: SIGTERM closes everything once and ends with code 0', async () => {
    const { p, exits, exit } = fakeProcess(); let closed = 0;
    const g = processGuards({ proc: p, exit, log: quiet, close: async () => { closed++; } });
    p.emit('SIGTERM'); p.emit('SIGTERM'); p.emit('SIGINT');
    await settle();
    assert.strictEqual(closed, 1); assert.deepStrictEqual(exits, [0]); assert.strictEqual(g.closing, true);
});
test('process: a close() that hangs is cut off after the grace period', async () => {
    const { p, exits, exit } = fakeProcess();
    processGuards({ proc: p, exit, log: quiet, graceMs: 30, close: () => new Promise(() => {}) });
    p.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 80));
    assert.deepStrictEqual(exits, [1]);
});
test('process: one unexpected error is logged and the server keeps running', async () => {
    const { p, exits, exit } = fakeProcess(); const seen = []; let closed = 0;
    processGuards({ proc: p, exit, log: { ...quiet, error: (...a) => seen.push(String(a[0])) }, close: async () => { closed++; } });
    p.emit('uncaughtException', new Error('one bad packet')); p.emit('unhandledRejection', new Error('one bad promise'));
    await settle();
    assert.deepStrictEqual(seen, ['uncaught exception:', 'unhandled rejection:']); assert.strictEqual(closed, 0); assert.deepStrictEqual(exits, []);
});
test('process: a storm of unexpected errors restarts the process (code 1); slow drips do not', async () => {
    const now = clock(); const a = fakeProcess();
    processGuards({ proc: a.p, exit: a.exit, log: quiet, now, stormMax: 5, stormMs: 60_000, close: async () => {} });
    for (let i = 0; i < 20; i++) { a.p.emit('uncaughtException', new Error('drip')); now.add(61_000); }
    await settle(); assert.deepStrictEqual(a.exits, []);
    const b = fakeProcess();
    processGuards({ proc: b.p, exit: b.exit, log: quiet, now, stormMax: 5, stormMs: 60_000, close: async () => {} });
    for (let i = 0; i < 5; i++) { b.p.emit('uncaughtException', new Error('storm')); now.add(1000); }
    await settle(); assert.deepStrictEqual(b.exits, [1]);
});
