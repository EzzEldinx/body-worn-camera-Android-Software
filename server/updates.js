// Camera updates as the people who use the system see them.
//
//   * A NOTICE is what the super administrator sends to every company after publishing a build: "a new update is ready, put all your cameras on
//     the docking station". Every user gets it once as a window (with a pulsing red heart on the Updates tab until they have seen it); it stays
//     on the Updates page. A build can be published without a notice (a test build must not trouble customers).
//   * The Updates page shows a company only its own cameras: which ones already run the announced build and which still wait, and what each one
//     waits for. The client does nothing but connect the camera to the docking station (or nothing at all for cameras that update over the network).
//   * The super administrator also sets, per camera, whether it may be updated over the network (see rollout.js) and can pause or resume that.

const DEFAULT_NOTICE = {
    title: 'New camera update',
    titleAr: 'تحديث جديد للكاميرات',
    body: 'A new update is ready for your cameras. Please put all your cameras on the docking station. They update by themselves as soon as they are connected, and you do not need to do anything else.',
    bodyAr: 'يوجد تحديث جديد لكاميراتكم. يرجى وضع جميع الكاميرات على محطة الإرساء (Docking Station)، وستتحدّث تلقائياً فور توصيلها، ولا يلزم أي إجراء آخر منكم.',
};
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);

const WHAT = {   // what a camera that updates over the network is doing, in words
    queued: 'Update on the way', downloading: 'Downloading the update', installing: 'Installing the update', waiting: 'Waiting for the recording to end',
    waiting_wifi: 'Waiting for Wi-Fi', waiting_battery: 'Waiting for more battery',
};
const WHY = { offline: 'Offline. It updates when it is online', recording: 'Waiting for the recording to end', battery: 'Waiting for more battery', busy: 'Update in progress' };

function create({ db, cams, latest, rollout, docked = () => new Map(), now = Date.now }) {
    db.exec('CREATE TABLE IF NOT EXISTS update_notices(id INTEGER PRIMARY KEY AUTOINCREMENT, build TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, body_ar TEXT, created INTEGER NOT NULL, by TEXT NOT NULL)');
    if (!db.prepare('PRAGMA table_info(update_notices)').all().some((c) => c.name === 'title_ar')) db.exec('ALTER TABLE update_notices ADD COLUMN title_ar TEXT');   // the notice title in Arabic (customers read the title in their own language)
    db.exec('CREATE TABLE IF NOT EXISTS update_notice_seen(user_id INTEGER NOT NULL, notice_id INTEGER NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY(user_id, notice_id))');
    const shape = (r, staff) => r && ({ id: r.id, build: r.build.slice(0, 12), title: r.title, titleAr: r.title_ar || '', body: r.body, bodyAr: r.body_ar || '', created: r.created, ...(staff ? { by: r.by } : {}) });
    const latestNotice = () => db.prepare('SELECT * FROM update_notices ORDER BY id DESC LIMIT 1').get() || null;
    const managed = (c) => c.updateMode === 'wifi' || c.updateMode === 'any';

    function add({ title, titleAr, body, bodyAr, by }) {
        const m = latest();
        if (!m) return { status: 409, error: 'Publish a build first.' };
        const t = clean(title, 80) || DEFAULT_NOTICE.title, b = clean(body, 700) || DEFAULT_NOTICE.body, a = clean(bodyAr, 700) || DEFAULT_NOTICE.bodyAr, ta = clean(titleAr, 80) || DEFAULT_NOTICE.titleAr;
        const id = Number(db.prepare('INSERT INTO update_notices(build,title,title_ar,body,body_ar,created,by) VALUES(?,?,?,?,?,?,?)').run(m.build, t, ta, b, a, now(), clean(by, 80)).lastInsertRowid);
        return { ok: true, notice: shape(db.prepare('SELECT * FROM update_notices WHERE id = ?').get(id), true) };
    }

    // The notice a user has not seen yet (company users only: Smart Way staff send it, they are not its audience).
    function unseen(user) {
        if (!user.companyId) return null;
        const n = latestNotice();
        if (!n || db.prepare('SELECT 1 FROM update_notice_seen WHERE user_id = ? AND notice_id = ?').get(user.id, n.id)) return null;
        return shape(n);
    }
    function markSeen(user, id) {
        id = Number(id);
        if (!Number.isInteger(id) || !db.prepare('SELECT 1 FROM update_notices WHERE id = ?').get(id)) return false;
        db.prepare('INSERT OR IGNORE INTO update_notice_seen(user_id,notice_id,ts) VALUES(?,?,?)').run(user.id, id, now());
        return true;
    }

    // Cameras of this user's company (Smart Way staff: all) that do not run the announced build, and what each is waiting for.
    function cameras(user) {
        const n = latestNotice(), m = latest(), t = now();
        const mine = [...cams.values()].filter((c) => !user.companyId || c.companyId === user.companyId);
        if (!n) return { announced: false, total: mine.length, current: 0, dock: 0, network: 0, list: [] };
        const dockedNow = docked(t);
        const out = { announced: true, total: mine.length, current: 0, dock: 0, network: 0, list: [] };
        for (const c of mine) {
            if (c.appBuild && (c.appBuild === n.build || (m && c.appBuild === m.build))) { out.current++; continue; }
            const why = rollout ? rollout.why(c, t) : 'dock';
            // over the network only while that can still work; a camera the network could not reach (or that cannot keep to Wi-Fi yet) needs the dock
            let how = managed(c) && !['needs-app', 'unknown', 'gave-up', 'refused'].includes(why) ? 'network' : 'dock', detail;
            if (dockedNow.has(c.cameraId)) { how = 'dock'; detail = 'On the docking station: updating now'; }
            else if (how === 'dock') detail = c.online ? 'Put it on the docking station' : 'Offline. Put it on the docking station';
            else detail = (c.update && WHAT[c.update.state] && t - (c.update.ts || 0) < 30 * 60_000 ? WHAT[c.update.state] : null) || WHY[why] || 'Update on the way';
            out[how]++;
            out.list.push({ id: c.cameraId, name: c.name || c.cameraId, how, online: !!c.online, lastSeen: c.ts || null, detail,
                ...(c.update && c.update.state === 'downloading' ? { pct: Math.min(100, Math.max(0, Number(c.update.pct) || 0)) } : {}) });
        }
        out.list.sort((a, b) => (a.how === b.how ? String(a.name).localeCompare(String(b.name)) : a.how === 'dock' ? -1 : 1));
        out.list = out.list.slice(0, 300);
        return out;
    }

    const history = (staff, n = 10) => db.prepare('SELECT * FROM update_notices ORDER BY id DESC LIMIT ?').all(n).map((r) => shape(r, staff));

    return {
        DEFAULT_NOTICE, latestNotice: (staff) => shape(latestNotice(), staff), add, unseen, markSeen, cameras, history,
        // what every page's header needs: the heart, and how many cameras still wait for the docking station
        badge(user) {
            if (!user.companyId) return { notice: null, waiting: 0 };
            return { notice: unseen(user), waiting: cameras(user).dock };
        },
        view(user) {
            const staff = !user.companyId;
            const c = cameras(user), m = latest();
            return { announced: c.announced, notice: shape(latestNotice(), staff), notices: history(staff), cameras: { total: c.total, current: c.current, dock: c.dock, network: c.network }, list: c.list,
                latest: m ? { short: m.build.slice(0, 12), uploaded: m.uploaded } : null };
        },
    };
}

function register(app, { updates, rollout, db, cams, needUser, adminOnly, isSuper, publish, audit, str }) {
    app.get('/api/updates', needUser, (req, res) => res.json(updates.view(req.user)));
    app.get('/api/updates/badge', needUser, (req, res) => res.json(updates.badge(req.user)));
    app.post('/api/updates/seen', needUser, (req, res) => res.json({ ok: updates.markSeen(req.user, req.body?.id) }));

    const must = (req, res, next) => (isSuper(req.user) ? next() : res.status(403).json({ error: 'Only Smart Way administrators can do this.' }));
    app.post('/api/admin/update/notice', ...adminOnly, must, (req, res) => {
        const r = updates.add({ title: req.body?.title, titleAr: req.body?.titleAr, body: req.body?.body, bodyAr: req.body?.bodyAr, by: req.user.username });
        if (r.error) return res.status(r.status).json({ error: r.error });
        audit(req.user.username, 'update_notice_sent', null, { build: r.notice.build, title: r.notice.title });
        res.json(r);
    });

    // How a camera may be updated: off (docking station only), wifi, any (Wi-Fi or SIM). One camera or many.
    app.put('/api/admin/update/mode', ...adminOnly, must, (req, res) => {
        const mode = req.body?.mode;
        if (!rollout.isMode(mode)) return res.status(400).json({ error: 'The way to update is off, wifi or any.' });
        const ids = (Array.isArray(req.body?.cameraIds) ? req.body.cameraIds : [req.body?.cameraId]).map((x) => str(x)).filter((id) => id && cams.has(id)).slice(0, 2000);
        if (!ids.length) return res.status(404).json({ error: 'No such camera.' });
        for (const id of ids) {
            db.prepare('UPDATE cameras SET update_mode = ? WHERE id = ?').run(mode, id);
            publish(id, { updateMode: mode });
            audit(req.user.username, `update_mode_${mode}`, id);
            rollout.seen(id);
        }
        res.json({ ok: true, changed: ids.length });
    });

    app.post('/api/admin/update/rollout', ...adminOnly, must, (req, res) => {
        const action = req.body?.action;
        if (action === 'halt') return res.json({ ok: rollout.halt(req.user.username, String(req.body?.note || 'Paused by an administrator.').slice(0, 200)) });
        if (action === 'resume') { const ok = rollout.resume(req.user.username); if (ok) rollout.tick(); return res.json({ ok }); }
        res.status(400).json({ error: 'The action is halt or resume.' });
    });
}

module.exports = { create, register, DEFAULT_NOTICE };
