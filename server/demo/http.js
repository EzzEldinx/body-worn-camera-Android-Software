'use strict';
// Everything the demo changes about the web side of the server:
//   * a demo is `noindex`, has no password login at all, and can change very little (a list of harmless actions; everything else is refused);
//   * "Try the demo": POST /api/demo/login gives a short session of the demo's administrator to anybody, within a rate limit and a cap of sessions;
//   * every page is sent with a small script that blurs every name, shows the "Demo - sample data" ribbon and (on the login page) the demo button;
//   * the production instance only gets the button (when DEMO_URL is set) and nothing else changes.
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

/** The few things a visitor of the demo may change. Anything else with a method that changes data is refused. */
const ALLOW = [
    ['POST', /^\/api\/(demo\/(login|logout)|logout)$/],
    ['POST', /^\/api\/updates\/seen$/],
    ['POST', /^\/api\/alerts\/\d+\/ack$/],
    ['POST', /^\/api\/analytics\/ai$/],
    ['POST', /^\/api\/dock\/files\/(choose|delete-from-camera)$/],
    ['POST', /^\/api\/assignments\/\d+\/end$/],
    ['POST', /^\/api\/dl$/],
    ['POST', /^\/api\/geofences$/], ['PUT', /^\/api\/geofences\/\d+$/], ['DELETE', /^\/api\/geofences\/\d+$/],
];
const REFUSE = [   // what a refused action says, by what it touches
    [/^\/api\/(tickets|support)/, 'Support tickets are read-only in the demo: nobody reads what is written here.'],
    [/^\/api\/(employees|company\/users|avatar)/, 'Adding people and pictures is turned off in the demo.'],
];
const REFUSED = 'This is turned off in the demo.';
const HARD_404 = /^\/api\/(login|mobile\/(login|push)|license)(\/|$)/;   // no passwords in a demo, no licence, no push registration

/** All the names that must be blurred, from the database: people, usernames, the company, sites, holders, zones, ticket authors, the support address. */
function namesFrom(db, extra = []) {
    const out = new Set(), add = (v) => { v = String(v ?? '').trim(); if (v.length >= 3 && /\p{L}/u.test(v)) out.add(v); };
    const rows = (sql) => { try { return db.prepare(sql).all(); } catch { return []; } };
    for (const r of rows('SELECT name, username FROM users')) { add(r.name); add(r.username); }
    for (const r of rows('SELECT name FROM companies')) add(r.name);
    for (const r of rows("SELECT DISTINCT grp AS v FROM cameras WHERE grp IS NOT NULL AND grp != ''")) add(r.v);
    for (const r of rows("SELECT DISTINCT holder AS v FROM cameras WHERE holder IS NOT NULL AND holder != ''")) add(r.v);
    for (const r of rows('SELECT name FROM geofences')) add(r.name);
    for (const r of rows('SELECT DISTINCT author AS v FROM ticket_messages')) add(r.v);
    for (const r of rows('SELECT DISTINCT name AS v FROM assignments')) add(r.v);
    for (const r of rows('SELECT DISTINCT zone_name AS v FROM alerts WHERE zone_name IS NOT NULL')) add(r.v);
    extra.forEach(add);
    return [...out].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Replaces every name in a text by stars of the same length (the PDF and CSV downloads: a file cannot be blurred). */
function masker(getNames) {
    let key = '', re = null;
    return (text) => {
        const names = getNames();
        if (!names.length || typeof text !== 'string' || !text) return text;
        const k = names.join('\u0001');
        if (k !== key || !re) { key = k; re = new RegExp(names.map(esc).join('|'), 'giu'); }
        return text.replace(re, (m) => '*'.repeat(m.length));
    };
}

function create({ on, link, home, now = Date.now }) {
    const S = { on, link, home };
    const cfg = {
        maxSessions: num(process.env.DEMO_MAX_SESSIONS, 120), ttlMin: num(process.env.DEMO_SESSION_MIN, 30),
        loginBurst: num(process.env.DEMO_LOGIN_BURST, 6), loginEveryS: num(process.env.DEMO_LOGIN_EVERY_S, 100),
    };
    let ctx = null, namesAt = 0, names = [];
    const getNames = () => {
        if (!ctx) return names;
        if (now() - namesAt > 4000) { names = namesFrom(ctx.db, [process.env.SUPPORT_EMAIL]); namesAt = now(); }
        return names;
    };
    const mask = masker(getNames);

    // ---------- pages: the same files with the demo script added (re-read when the file changes)
    const cache = new Map();
    const pageText = (file) => {
        const f = path.join(PUBLIC, file), st = fs.statSync(f), hit = cache.get(f);
        if (hit && hit.m === st.mtimeMs) return hit.t;
        const t = fs.readFileSync(f, 'utf8'); cache.set(f, { m: st.mtimeMs, t }); return t;
    };
    const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/ /g, '\\u2028').replace(/ /g, '\\u2029');
    const bootObject = (file) => ({ mode: on ? 'demo' : 'link', url: on ? null : link, home: on ? home : null, ttlMin: cfg.ttlMin, ...(on ? { names: getNames(), page: file } : {}) });
    function withDemo(file) {
        const t = pageText(file);
        const head = `<meta name="robots" content="noindex,nofollow"><link rel="stylesheet" href="/demo.css"><script>window.VG_DEMO=${json(bootObject(file))}</script><script src="/demo.js"></script>`;
        const m = /<meta[^>]*charset[^>]*>/i.exec(t) || /<head[^>]*>/i.exec(t);
        return m ? t.slice(0, m.index + m[0].length) + head + t.slice(m.index + m[0].length) : head + t;
    }
    /** server.js sends every page of its own through here first: true = the demo sent it (with the script), false = send it as it is. */
    function sendPage(res, file) {
        if (!on && !(link && file === 'login.html')) return false;
        try { res.set({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).send(withDemo(file)); return true; } catch { return false; }
    }
    const open = (file) => (req, res, next) => (sendPage(res, file) ? undefined : next());

    // ---------- the early part: runs before every other route
    function early(app, { tokenBucket }) {
        if (!on && !link) return;
        app.get('/api/demo/config', (req, res) => res.json({ demo: on, url: on ? null : link, home: on ? home : null, ttlMin: cfg.ttlMin }));
        app.get('/login.html', open('login.html'));
        if (!on) return;                       // production: only the login page gets the "Try the demo" button
        app.get('/privacy.html', open('privacy.html'));
        app.use((req, res, next) => { res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive'); next(); });
        app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
        // refused entirely, as if they did not exist
        app.use((req, res, next) => (HARD_404.test(req.path) ? res.status(404).json({ error: 'Not found.' }) : next()));
        // a visitor may change only what is listed, and not fast
        const budget = tokenBucket({ capacity: 40, refillPerSec: 1 / 6 });
        app.use((req, res, next) => {
            if (!req.path.startsWith('/api/') || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
            if (!ALLOW.some(([m, re]) => m === req.method && re.test(req.path))) {
                const why = (REFUSE.find(([re]) => re.test(req.path)) || [])[1] || REFUSED;
                return res.status(403).json({ error: why, demo: true });
            }
            const key = String(req.headers.cookie || '').match(/sid=([0-9a-f]{16})/)?.[1] || req.ip;
            if (!budget.take(key)) return res.status(429).json({ error: 'Slow down: you are changing things too fast for a demo.', demo: true });
            if (/^\/api\/geofences/.test(req.path) && req.body && typeof req.body.name === 'string') req.body.name = req.body.name.replace(/[^\p{L}\p{N} _().,'-]/gu, '').slice(0, 40);
            if (req.method === 'POST' && req.path === '/api/geofences' && ctx && ctx.db.prepare('SELECT COUNT(*) n FROM geofences').get().n >= 24) {
                return res.status(409).json({ error: 'The demo already holds as many zones as it allows. It starts again from scratch every few hours.', demo: true });
            }
            next();
        });
        // downloads cannot be blurred: the names in a spreadsheet are starred out
        app.use((req, res, next) => {
            if (req.method !== 'GET' || !/\.csv$/.test(req.path)) return next();
            const send = res.send;
            res.send = function (body) { return send.call(this, typeof body === 'string' ? mask(body) : body); };
            next();
        });
    }

    // ---------- the routes that need the session helpers of server.js
    function routes(app, d) {
        ctx = d;
        names = namesFrom(d.db, [process.env.SUPPORT_EMAIL]); namesAt = now();
        if (!on) return;
        app.get('/api/demo/names', (req, res) => res.json({ names: getNames() }));
        const bucket = d.tokenBucket({ capacity: cfg.loginBurst, refillPerSec: 1 / cfg.loginEveryS });
        app.post('/api/demo/login', (req, res) => {
            if (!bucket.take(req.ip)) return res.status(429).set('Retry-After', String(cfg.loginEveryS)).json({ error: 'You have started the demo several times in a row. Wait a minute and try again.' });
            const t = now();
            d.db.prepare('DELETE FROM sessions WHERE exp < ?').run(t);
            if (d.db.prepare('SELECT COUNT(*) n FROM sessions WHERE exp > ?').get(t).n >= cfg.maxSessions) return res.status(503).set('Retry-After', '120').json({ error: 'The demo is busy right now. Try again in a few minutes.' });
            const u = d.db.prepare("SELECT id FROM users WHERE role = 'manager' AND company_id IS NOT NULL ORDER BY id LIMIT 1").get();
            if (!u) return res.status(503).json({ error: 'The demo is not ready yet.' });
            const ttl = cfg.ttlMin * 60000, token = d.newSession(u.id, ttl);
            res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${cfg.ttlMin * 60}${req.secure ? '; Secure' : ''}`);
            d.db.prepare('DELETE FROM update_notice_seen WHERE user_id = ?').run(u.id);   // the update notice shows again for the next visitor
            if (S.onVisitor) { try { S.onVisitor(); } catch { /* the show goes on */ } }
            res.json({ ok: true, token, expiresAt: t + ttl, demo: true });
        });
        // every recording of the demo is the same short sample clip (the demo stores no real recording)
        app.get('/api/recordings/:id/file', d.needUser, (req, res) => {
            const r = d.db.prepare('SELECT camera_id, filename FROM recordings WHERE id = ?').get(Number(req.params.id));
            if (!r || !d.canSee(req.user, r.camera_id)) return res.status(404).json({ error: 'Not found.' });
            const clip = S.sampleClip && S.sampleClip();
            const jpg = /\.jpg$/i.test(r.filename), file = clip && (jpg ? clip.jpg : clip.mp4);
            if (!file) return res.status(404).json({ error: 'The sample clip is not available on this demo.' });
            res.type(jpg ? 'image/jpeg' : 'video/mp4').sendFile(file);
        });
        // the Help page says e-mail works (on a real server it does)
        app.get('/api/support/info', d.needUser, (req, res) => res.json({ email: process.env.SUPPORT_EMAIL, emailConfigured: true, staff: false,
            categories: ['question', 'camera', 'docking', 'live', 'alerts', 'account', 'app', 'other'], priorities: ['low', 'normal', 'high', 'urgent'] }));
    }

    return { S, cfg, early, routes, sendPage, mask, names: getNames };
}

module.exports = { create, namesFrom, masker, ALLOW, REFUSE, HARD_404 };
