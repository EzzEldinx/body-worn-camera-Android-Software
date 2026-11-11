// Licence for self-hosted installations (see docs/LICENSING.md).
//   Smart Way signs a licence file (customer, term, limits, features) with a private key it alone holds. The server verifies it OFFLINE with the public key
//   it carries, so it works inside a closed government network, and the customer cannot extend or edit it. To renew, the customer's administrator downloads a
//   signed request from the License page, sends it to Smart Way, and installs the new file we send back. Nothing leaves the customer's network on its own.
//
//   LICENSE_MODE=off      (default) Smart Way's own hosted servers: no licence needed.
//   LICENSE_MODE=enforce  a customer installation. States, in order of a licence's life:
//       trial       no licence yet, first LICENSE_TRIAL_DAYS (30) days, up to LICENSE_TRIAL_CAMERAS (10) cameras
//       valid       licence in force
//       expiring    valid, 30 days or fewer left: banner for administrators
//       grace       expired, still inside the grace period (default 30 days): everything works, banner for everybody
//       restricted  grace over, or no licence after the trial: the system keeps doing its safety job (cameras, SOS, live view, evidence in and out)
//                   but cannot grow or export (no new cameras, users or companies, no reports/exports/AI, no app updates)
//       locked      like restricted, and dashboards cannot sign in (only if the licence says afterExpiry = locked)
//   A camera's SOS and the evidence it uploads are never refused, in any state.
const crypto = require('crypto');
const os = require('os');
const core = require('./license-core');

const DAY = core.DAY;
const WARN_DAYS = [60, 30, 14, 7, 3, 1];
const CLOCK_SLACK = 2 * DAY;      // the clock may be set back this far (time zone / NTP mistakes); more than that is treated as tampering

// What the restricted state refuses: growing the system and taking data out. Everything else (live, SOS, evidence, dock, support) keeps working.
const BLOCKED = [
    ['POST', /^\/api\/admin\/companies$/], ['POST', /^\/api\/admin\/companies\/\d+\/(users|employees)$/], ['PUT', /^\/api\/admin\/companies\/\d+\/package$/],
    ['POST', /^\/api\/admin\/regions$/], ['POST', /^\/api\/admin\/cameras\/[^/]+\/token$/], ['PUT', /^\/api\/admin\/update\/apk$/],
    ['PUT', /^\/api\/admin\/dock\/policy$/], ['PUT', /^\/api\/admin\/checkout\/settings$/],
    ['GET', /^\/api\/report$/], ['GET', /\/export\.csv$/], ['POST', /^\/api\/analytics\/ai$/],
];
// In the locked state only these still answer (and cameras and docks keep delivering evidence).
const OPEN_WHEN_LOCKED = /^\/api\/(login|logout|me|license|tickets|support|mobile\/(config|login|logout)|dock\/|update\/apk|station\/)/;
const PAGES_WHEN_LOCKED = new Set(['/', '/index.html', '/analytics.html', '/docks.html', '/wall.html', '/admin.html', '/updates.html']);

function create({ db, keys, usage = () => ({}), audit = () => {}, notify = async () => {}, env = process.env, now = Date.now, version = '1.0.0' }) {
    const mode = env.LICENSE_MODE === 'enforce' ? 'enforce' : 'off';
    const trialDays = env.LICENSE_TRIAL_DAYS === undefined || env.LICENSE_TRIAL_DAYS === '' ? 30 : Math.max(0, Number(env.LICENSE_TRIAL_DAYS) || 0);
    const trialCameras = Number(env.LICENSE_TRIAL_CAMERAS) || 10;

    db.exec('CREATE TABLE IF NOT EXISTS license_state(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.exec(`CREATE TABLE IF NOT EXISTS license_history(
        id INTEGER PRIMARY KEY AUTOINCREMENT, serial TEXT NOT NULL, customer TEXT NOT NULL, start_ts INTEGER NOT NULL, expires_ts INTEGER NOT NULL, term TEXT,
        installed_ts INTEGER NOT NULL, installed_by TEXT, file TEXT NOT NULL)`);
    const get = (k) => db.prepare('SELECT value FROM license_state WHERE key = ?').get(k)?.value ?? null;
    const set = (k, v) => db.prepare('INSERT INTO license_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));

    // this installation's own key: the licence is issued for its fingerprint
    if (!get('install_priv')) { const kp = core.makeKeyPair(); set('install_priv', kp.privatePem); set('install_pub', kp.publicPem); }
    if (!get('first_run')) set('first_run', now());
    const installPub = get('install_pub'), installPriv = get('install_priv');
    const installId = core.fingerprintOf(installPub);

    let current = null, problem = null;       // the licence in force (verified payload) and why a stored one was not accepted
    function load() {
        const text = get('current');
        current = null; problem = null;
        if (!text) return;
        const v = core.verify(text, keys);
        if (!v.ok) { problem = v.error; return; }
        if (v.payload.installId !== '*' && v.payload.installId !== installId) { problem = `This licence was issued for another installation (${v.payload.installId}); this one is ${installId}.`; return; }
        current = v.payload;
    }
    load();

    let cache = null, cacheAt = 0;
    const touch = () => { cache = null; };
    function evaluate(t = now()) {
        const out = { mode, installId, version, now: t, state: 'off', problem, limits: {}, features: [...core.FEATURES], customer: null, serial: null, edition: null, term: null, start: null, expires: null, graceUntil: null, graceDays: null, daysLeft: null, trialEnds: null, afterExpiry: 'restricted' };
        if (mode === 'off') return out;
        const firstRun = Number(get('first_run')) || t, high = Number(get('high_water')) || 0;
        const lastAudit = db.prepare('SELECT MAX(ts) t FROM audit').get()?.t || 0;
        // a clock set back to dodge the expiry: the system has already seen (and sealed in the audit trail) a later time
        out.clockBehind = Math.max(high, lastAudit) - t > CLOCK_SLACK ? Math.max(high, lastAudit) : null;
        if (current) {
            const p = current, grace = (p.graceDays ?? 30) * DAY;
            Object.assign(out, { customer: p.customer, serial: p.serial, edition: p.edition || null, term: p.term || null, start: p.start, expires: p.expires, graceDays: p.graceDays ?? 30, graceUntil: p.expires + grace, afterExpiry: p.afterExpiry || 'restricted',
                limits: p.limits || {}, features: p.features || [...core.FEATURES], daysLeft: Math.ceil((p.expires - t) / DAY), contact: p.contact || null });
            out.state = t < p.start - DAY ? 'restricted' : t <= p.expires ? (p.expires - t <= 30 * DAY ? 'expiring' : 'valid') : t <= p.expires + grace ? 'grace' : (p.afterExpiry === 'locked' ? 'locked' : 'restricted');
            if (t < p.start - DAY) out.problem = `This licence starts on ${new Date(p.start).toISOString().slice(0, 10)}.`;
        } else if (trialDays > 0 && t < firstRun + trialDays * DAY) {
            Object.assign(out, { state: 'trial', trialEnds: firstRun + trialDays * DAY, daysLeft: Math.ceil((firstRun + trialDays * DAY - t) / DAY), limits: { cameras: trialCameras } });
        } else out.state = 'restricted';
        if (out.clockBehind && out.state !== 'restricted' && out.state !== 'locked') { out.state = 'restricted'; out.clock = true; }
        return out;
    }
    const status = () => { const t = now(); if (!cache || t - cacheAt > 3000) { cache = evaluate(t); cacheAt = t; } return cache; };
    const restricted = () => { const s = status().state; return s === 'restricted' || s === 'locked'; };
    const locked = () => status().state === 'locked';

    // ---- limits (installation-wide) and features
    const KIND = { camera: 'cameras', user: 'users', employee: 'employees', company: 'companies', live: 'live' };
    const NOUN = { cameras: 'cameras', users: 'dashboard users', employees: 'employees', companies: 'companies', live: 'live streams' };
    /** May one more of this kind be added? kind = camera | user | employee | company | live. n = how many are being added. */
    function allow(kind, n = 1) {
        if (mode === 'off') return { ok: true };
        const s = status(), key = KIND[kind];
        if (s.state === 'restricted' || s.state === 'locked') {
            if (kind === 'live') return { ok: true };       // watching what a camera already streams is a safety function
            return { ok: false, code: 'license_restricted', error: s.clock ? 'The server clock is behind. Correct it, or contact Smart Way.' : 'The licence has expired, so the system cannot grow. Renew it on the License page.' };
        }
        const lim = s.limits[key];
        if (lim === undefined) return { ok: true };
        const used = (usage() || {})[key] ?? 0;
        return used + n <= lim ? { ok: true } : { ok: false, code: 'license_limit', error: `Your licence allows ${lim} ${NOUN[key]} and ${used} are in use. Ask Smart Way for a larger licence.` };
    }
    const has = (feature) => mode === 'off' || status().features.includes(feature);

    // ---- express middleware
    const gate = (feature) => (req, res, next) => (has(feature) ? next() : res.status(402).json({ code: 'license_feature', error: `Your licence does not include ${feature}. Contact Smart Way to add it.` }));
    const guard = (req, res, next) => {
        if (mode === 'off' || !restricted()) return next();
        const s = status();
        if (locked()) {
            if (req.method === 'GET' && PAGES_WHEN_LOCKED.has(req.path)) return res.redirect('/license.html');
            if (req.path.startsWith('/api/') && !OPEN_WHEN_LOCKED.test(req.path)) return res.status(402).json({ code: 'license_locked', error: 'The licence has expired and this system is locked. An administrator can renew it on the License page.' });
        }
        if (BLOCKED.some(([m, re]) => m === req.method && re.test(req.path))) {
            return res.status(402).json({ code: 'license_restricted', error: s.clock ? 'The server clock is behind. Correct it, or contact Smart Way.' : 'The licence has expired: the system is in limited mode (live view, alarms and evidence still work). Renew it on the License page.' });
        }
        next();
    };

    // ---- installing a licence / asking for a renewal
    function install(text, by) {
        const v = core.verify(text, keys);
        if (!v.ok) return { status: 400, error: v.error, code: v.code };
        const p = v.payload;
        if (p.installId !== '*' && p.installId !== installId) return { status: 409, error: `This licence is for another installation (${p.installId}). This installation is ${installId}. Ask Smart Way for a licence for this one.` };
        const t = now();
        if (p.expires + (p.graceDays ?? 30) * DAY < t) return { status: 409, error: `This licence ended on ${new Date(p.expires).toISOString().slice(0, 10)}. Ask Smart Way for a current one.` };
        const file = typeof text === 'string' ? text : JSON.stringify(text);
        db.prepare('INSERT INTO license_history(serial,customer,start_ts,expires_ts,term,installed_ts,installed_by,file) VALUES(?,?,?,?,?,?,?,?)').run(p.serial, p.customer, p.start, p.expires, p.term || null, t, by || null, file);
        set('current', file); load(); touch();
        audit(by || 'system', 'license_installed', null, { serial: p.serial, customer: p.customer, term: p.term || null, expires: new Date(p.expires).toISOString().slice(0, 10) });
        set('warned', '');   // reminders start again for the new term
        return { ok: true, status: status() };
    }
    function request(term, note) {
        if (!core.TERMS[term]) return { status: 400, error: 'Pick 3, 6, 12, 24 or 36 months.' };
        const u = usage() || {}, s = status();
        const payload = { v: 1, installId, term, note: String(note || '').slice(0, 300), created: now(), currentSerial: s.serial, customer: s.customer, state: s.state, expires: s.expires,
            usage: { cameras: u.cameras ?? 0, users: u.users ?? 0, employees: u.employees ?? 0, companies: u.companies ?? 0 }, host: os.hostname(), version };
        return { ok: true, file: core.makeRequest(payload, installPriv, installPub), installId };
    }
    const history = () => db.prepare('SELECT id,serial,customer,start_ts AS start,expires_ts AS expires,term,installed_ts AS installedAt,installed_by AS installedBy FROM license_history ORDER BY id DESC LIMIT 50').all();

    // ---- what each kind of reader may see
    function summary(user) {
        const s = status(), admin = !!user && user.role === 'admin' && !user.companyId;
        const base = { mode: s.mode, state: s.state, customer: s.customer, serial: s.serial, expires: s.expires, graceUntil: s.graceUntil, daysLeft: s.daysLeft, trialEnds: s.trialEnds, clock: !!s.clock, canManage: admin };
        base.show = mode === 'enforce' && (['grace', 'restricted', 'locked', 'trial'].includes(s.state) ? (s.state !== 'trial' || (s.daysLeft ?? 99) <= 10 || admin) : s.state === 'expiring' && (admin || (s.daysLeft ?? 99) <= 7));
        return base;
    }
    const details = () => { const s = status(); return { ...s, usage: usage() || {}, history: history(), keyIds: keys.map((k) => k.kid), term: s.term, terms: Object.keys(core.TERMS) }; };

    // ---- once a day: remember the latest time seen, remind before the end
    function tick() {
        const t = now(), hw = Number(get('high_water')) || 0;
        if (t > hw) set('high_water', t);
        touch();
        if (mode !== 'enforce') return;
        const s = status();
        if (s.daysLeft === null) return;
        const warned = new Set(String(get('warned') || '').split(',').filter(Boolean));
        const thr = [...WARN_DAYS].reverse().find((x) => s.daysLeft <= x);        // the smallest of 60/30/14/7/3/1 that still covers the days left
        const key = s.state === 'grace' ? 'grace' : s.state === 'restricted' || s.state === 'locked' ? 'ended' : thr ? (s.state === 'trial' ? 'trial' : 'd') + thr : null;
        if (!key || warned.has(key)) return;
        warned.add(key); set('warned', [...warned].join(','));
        const subject = s.state === 'trial' ? `VisionGuard trial ends in ${s.daysLeft} day(s)` : s.state === 'grace' ? 'VisionGuard licence has expired (grace period)' : s.state === 'restricted' || s.state === 'locked' ? 'VisionGuard is in limited mode: licence expired' : `VisionGuard licence expires in ${s.daysLeft} day(s)`;
        audit('system', 'license_warning', null, { state: s.state, daysLeft: s.daysLeft, serial: s.serial });
        notify(subject, `${subject}\n\nCustomer: ${s.customer || '(trial)'}\nLicence: ${s.serial || '-'}\nInstallation: ${installId}\nEnds: ${s.expires ? new Date(s.expires).toISOString().slice(0, 10) : s.trialEnds ? new Date(s.trialEnds).toISOString().slice(0, 10) : '-'}\n\nOpen the License page of VisionGuard to request a renewal from Smart Way.`).catch(() => {});
    }

    return { mode, installId, status, evaluate, restricted, locked, allow, has, gate, guard, install, request, summary, details, history, tick, load, touch, trialCameras };
}

function register(app, { license, needUser, needAdmin, audit }) {
    // a short summary for the banner (every signed-in user), the full picture for administrators
    app.get('/api/license/status', needUser, (req, res) => res.json(license.summary(req.user)));
    app.get('/api/license', needUser, needAdmin, (req, res) => res.json(license.details()));
    app.get('/api/license/request', needUser, needAdmin, (req, res) => {
        const r = license.request(String(req.query.term || '12m'), req.query.note);
        if (r.error) return res.status(r.status || 400).json({ error: r.error });
        audit(req.user.username, 'license_renewal_requested', null, { term: String(req.query.term || '12m') });
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="VisionGuard-renewal-request-${r.installId}.vgreq"`);
        res.send(JSON.stringify(r.file, null, 2));
    });
    app.post('/api/license', needUser, needAdmin, (req, res) => {
        const text = typeof req.body?.license === 'string' ? req.body.license : req.body?.license ? JSON.stringify(req.body.license) : '';
        if (!text || text.length > 200000) return res.status(400).json({ error: 'Choose the licence file from Smart Way.' });
        const r = license.install(text, req.user.username);
        if (r.error) return res.status(r.status || 400).json({ error: r.error, code: r.code });
        res.json({ ok: true, ...license.details() });
    });
}

module.exports = { create, register, BLOCKED, WARN_DAYS };
