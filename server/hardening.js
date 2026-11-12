// Reliability and abuse guards used by server.js. Everything here is small, has no dependency and is unit-tested (test/hardening.test.js):
//   safeCookies      a malformed cookie can never throw (it used to take the whole process down from one WebSocket handshake)
//   guard            runs a handler and logs what it throws instead of letting it reach the process
//   tokenBucket      a rate limit per key (socket events)
//   loginLimiter     wrong passwords are counted per address + username and per address
//   securityHeaders  the response headers every page and API answer carries
//   housekeeping     old GPS points, expired sessions and (optionally) old activity lines are removed in small batches
//   processGuards    SIGTERM closes cleanly; an unexpected error is logged, and a storm of them restarts the process

/** Cookie header -> { name: value }. A value that is not valid percent-encoding is kept as it is instead of throwing. */
function safeCookies(header) {
    const out = {};
    if (typeof header !== 'string' || !header || header.length > 8192) return out;
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i < 1) continue;
        const k = part.slice(0, i).trim(); let v = part.slice(i + 1).trim();
        if (!k || k === '__proto__') continue;
        try { v = decodeURIComponent(v); } catch { /* keep the raw value */ }
        if (!(k in out)) out[k] = v;
    }
    return out;
}

/** Wrap a handler: whatever it throws (or rejects with) is logged with a label, never rethrown. */
function guard(label, fn, log = console) {
    return (...args) => {
        try {
            const r = fn(...args);
            if (r && typeof r.then === 'function') return r.then((v) => v, (e) => { log.error(`${label} failed:`, e && e.stack ? e.stack : e); });
            return r;
        } catch (e) { log.error(`${label} failed:`, e && e.stack ? e.stack : e); return undefined; }
    };
}

/** Classic token bucket per key: `capacity` actions at once, refilled at `refillPerSec`. take() says whether the action may run. */
function tokenBucket({ capacity, refillPerSec, now = Date.now }) {
    const m = new Map();
    return {
        take(key, cost = 1) {
            const t = now(); let b = m.get(key);
            if (!b) { b = { n: capacity, t }; m.set(key, b); }
            b.n = Math.min(capacity, b.n + ((t - b.t) / 1000) * refillPerSec); b.t = t;
            if (b.n < cost) return false;
            b.n -= cost; return true;
        },
        drop(key) { m.delete(key); },
        prune(idleMs = 600000) { const t = now(); for (const [k, b] of m) if (t - b.t > idleMs) m.delete(k); },
        get size() { return m.size; },
    };
}

/**
 * Wrong passwords. Two counters, both reset after `windowMs` without a new miss:
 *   address + username   `perUser` misses lock that account from that address (one person's typos do not lock the whole office)
 *   address              `perIp` misses lock the address (someone walking through many usernames)
 * A good password only clears its own address + username counter: signing in to your own account does not buy more guesses at somebody else's.
 */
function loginLimiter({ perUser = 5, perIp = 30, windowMs = 300000, now = Date.now } = {}) {
    const m = new Map();   // key -> { n: misses, t: time of the last one, told: the lock was already reported }
    const live = (k) => { const f = m.get(k); if (!f) return null; if (now() - f.t >= windowMs) { m.delete(k); return null; } return f; };
    const count = (k) => live(k)?.n || 0;
    const bump = (k) => { const f = live(k) || { n: 0, told: false }; f.n++; f.t = now(); m.set(k, f); return f; };
    const uk = (ip, user) => `u:${ip}|${String(user).toLowerCase().slice(0, 64)}`, ik = (ip) => `i:${ip}`;
    return {
        blocked: (ip, user) => count(uk(ip, user)) >= perUser || count(ik(ip)) >= perIp,
        /** Call BEFORE checking the password. False = refused (locked). Otherwise the attempt is counted as a miss at once,
         *  so a burst of parallel guesses cannot all pass before the first one has been counted. */
        enter(ip, user) { if (this.blocked(ip, user)) return false; bump(uk(ip, user)); bump(ik(ip)); return true; },
        /** Call AFTER checking the password. A good one takes its own miss back; a wrong one returns true the first time a lock is reached
         *  (so the caller writes one audit line, not one per attempt). */
        leave(ip, user, good) {
            if (good) { m.delete(uk(ip, user)); const f = live(ik(ip)); if (f && --f.n <= 0) m.delete(ik(ip)); return false; }
            for (const [k, max] of [[uk(ip, user), perUser], [ik(ip), perIp]]) { const f = live(k); if (f && f.n >= max && !f.told) { f.told = true; return true; } }
            return false;
        },
        prune() { const t = now(); for (const [k, f] of m) if (t - f.t >= windowMs) m.delete(k); },
        get size() { return m.size; },
    };
}

/** Headers for every answer. No CSP here: the pages use inline scripts; see docs for the plan to add one with nonces. */
function securityHeaders(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');           // one-time download links and signed stream URLs never leave in a Referer
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    if (req.path.startsWith('/api/')) {                         // JSON answers are never kept by a browser or a proxy; file downloads (video, APK, PDF) keep their own caching and Range behaviour
        const json = res.json;
        res.json = function (body) { if (!res.headersSent && !res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-store'); return json.call(this, body); };
    }
    next();
}

/**
 * Remove what nobody needs any more, a batch at a time so the event loop is never held for long.
 * positionsDays: GPS trail kept this long (the map and reports never look further back). eventsDays: 0 keeps activity lines forever.
 */
async function housekeeping({ db, now = Date.now(), positionsDays = 30, eventsDays = 0, batch = 20000, pause = () => new Promise((r) => setImmediate(r)) }) {
    const DAY = 86400000, out = { positions: 0, events: 0, sessions: 0 };
    const drain = async (table, cutoff) => {
        const stmt = db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ts < ? LIMIT ?)`);
        let total = 0;
        for (;;) { const n = Number(stmt.run(cutoff, batch).changes); total += n; if (n < batch) return total; await pause(); }
    };
    if (positionsDays > 0) out.positions = await drain('positions', now - positionsDays * DAY);
    if (eventsDays > 0) out.events = await drain('events', now - eventsDays * DAY);
    out.sessions = Number(db.prepare('DELETE FROM sessions WHERE exp < ?').run(now).changes);
    return out;
}

/**
 * SIGTERM / SIGINT: close() runs (stop listening, close sockets, close the database), then the process ends with code 0.
 * An error nobody caught is logged and the server keeps answering: one bad packet must not disconnect a whole fleet. If `stormMax` of them arrive
 * within `stormMs` something is really broken, and the process closes and ends with code 1 so the supervisor (Docker, systemd) starts a clean one.
 */
function processGuards({ close, proc = process, log = console, exit = (c) => process.exit(c), graceMs = 8000, stormMax = 5, stormMs = 60000, now = Date.now }) {
    let closing = false; const recent = [];
    const shutdown = (why, code) => {
        if (closing) return; closing = true;
        log.log(`shutting down (${why})`);
        const t = setTimeout(() => exit(code || 1), graceMs); if (t.unref) t.unref();
        Promise.resolve().then(close).catch((e) => log.error('error while closing:', e)).then(() => exit(code));
    };
    const onError = (kind) => (e) => {
        log.error(`${kind}:`, e && e.stack ? e.stack : e);
        const t = now(); recent.push(t); while (recent.length && t - recent[0] > stormMs) recent.shift();
        if (recent.length >= stormMax) shutdown(`${recent.length} unexpected errors in ${Math.round(stormMs / 1000)} s`, 1);
    };
    proc.on('SIGTERM', () => shutdown('SIGTERM', 0));
    proc.on('SIGINT', () => shutdown('SIGINT', 0));
    proc.on('uncaughtException', onError('uncaught exception'));
    proc.on('unhandledRejection', onError('unhandled rejection'));
    return { shutdown, get closing() { return closing; } };
}

module.exports = { safeCookies, guard, tokenBucket, loginLimiter, securityHeaders, housekeeping, processGuards };
