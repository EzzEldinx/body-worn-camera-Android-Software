// Docking-station API: a Dock Agent (PC next to the docks) offloads recordings from cameras to the server,
// which verifies every file by SHA-256 before it is stored. Dashboards list/download recordings (company-scoped).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeEqual } = require('./tokens');

const NAME_RE = /^(VID|IMG)_\d{6,16}\.(mp4|jpg)$/;
const MAX_BYTES = 8 * 1024 ** 3;

function register(app, ctx) {
    const { db, cams, needUser, needAdmin, canSee, isStaff, str, companyName } = ctx;
    const DOCK_TOKEN = process.env.DOCK_TOKEN || '';
    const dir = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'recordings');
    fs.mkdirSync(dir, { recursive: true });

    db.exec(`CREATE TABLE IF NOT EXISTS recordings(
        id INTEGER PRIMARY KEY AUTOINCREMENT, camera_id TEXT NOT NULL, filename TEXT NOT NULL, size INTEGER NOT NULL,
        sha256 TEXT NOT NULL, recorded_ts INTEGER, uploaded_ts INTEGER NOT NULL, dock_id TEXT,
        UNIQUE(camera_id, sha256))`);
    db.exec('CREATE INDEX IF NOT EXISTS rec_cam ON recordings(camera_id, recorded_ts)');
    // A camera's physical dock port (USB location) always lands in the same bay: first free bay on first sight.
    db.exec('CREATE TABLE IF NOT EXISTS dock_slots(dock_id TEXT NOT NULL, port TEXT NOT NULL, slot INTEGER NOT NULL, PRIMARY KEY(dock_id, port))');
    const SLOTS = Math.max(1, Math.min(64, Number(process.env.DOCK_SLOTS) || 8));
    const slotFor = (dockId, port) => {
        const hit = db.prepare('SELECT slot FROM dock_slots WHERE dock_id = ? AND port = ?').get(dockId, port);
        if (hit) return hit.slot;
        const used = new Set(db.prepare('SELECT slot FROM dock_slots WHERE dock_id = ?').all(dockId).map((r) => r.slot));
        let n = 0; while (used.has(n)) n++;
        db.prepare('INSERT INTO dock_slots(dock_id,port,slot) VALUES(?,?,?)').run(dockId, port, n);
        return n;
    };
    const docks = new Map(); // dock id -> last report (in memory)

    const needDock = (req, res, next) => {
        if (!DOCK_TOKEN) return res.status(503).json({ error: 'Docking is disabled: set DOCK_TOKEN on the server.' });
        if (!safeEqual(req.headers['x-dock-token'] || '', DOCK_TOKEN)) return res.status(401).json({ error: 'Bad dock token.' });
        next();
    };
    const audit = (user, action, cam) => db.prepare('INSERT INTO audit(ts,username,action,camera_id) VALUES(?,?,?,?)').run(Date.now(), user, action, cam || null);

    // Does the server already hold this file? (lets the agent skip pulling it from the camera)
    app.get('/api/dock/has', needDock, (req, res) => {
        const id = str(req.query.camera), sha = String(req.query.sha256 || '');
        if (!id || !/^[0-9a-f]{64}$/.test(sha)) return res.status(400).json({ error: 'Bad query.' });
        res.json({ has: !!db.prepare('SELECT 1 FROM recordings WHERE camera_id = ? AND sha256 = ?').get(id, sha) });
    });

    // Raw body upload, verified against the SHA-256 the agent computed on the camera and on the dock.
    app.post('/api/dock/upload', needDock, (req, res) => {
        const id = str(req.headers['x-camera-id']), name = String(req.headers['x-filename'] || ''), want = String(req.headers['x-sha256'] || '');
        const size = Number(req.headers['x-size']), rts = Number(req.headers['x-recorded-ts']) || null, dockId = String(req.headers['x-dock-id'] || 'dock').slice(0, 40);
        if (!id || !NAME_RE.test(name) || !/^[0-9a-f]{64}$/.test(want) || !Number.isInteger(size) || size < 1 || size > MAX_BYTES) {
            return res.status(400).json({ error: 'Bad upload headers.' });
        }
        const dup = db.prepare('SELECT id FROM recordings WHERE camera_id = ? AND sha256 = ?').get(id, want);
        if (dup) { req.resume(); return res.json({ ok: true, duplicate: true, id: dup.id }); }
        const camDir = path.join(dir, id); fs.mkdirSync(camDir, { recursive: true });
        const tmp = path.join(camDir, `.${name}.${crypto.randomBytes(4).toString('hex')}.part`);
        const out = fs.createWriteStream(tmp), h = crypto.createHash('sha256'); let n = 0, failed = false;
        const fail = (code, error) => { if (failed) return; failed = true; out.destroy(); fs.rm(tmp, { force: true }, () => {}); if (!res.headersSent) res.status(code).json({ error }); };
        req.on('data', (c) => { n += c.length; h.update(c); if (n > size) { fail(413, 'Body larger than declared size.'); req.destroy(); } });
        req.on('error', () => fail(400, 'Upload aborted.'));
        req.pipe(out);
        out.on('error', () => fail(500, 'Cannot write file.'));
        out.on('finish', () => {
            if (failed) return;
            const got = h.digest('hex');
            if (n !== size || got !== want) return fail(422, `Verification failed (size ${n}/${size}, hash ${got === want ? 'ok' : 'mismatch'}).`);
            let final = path.join(camDir, name);
            if (fs.existsSync(final)) final = path.join(camDir, `${got.slice(0, 8)}_${name}`);
            fs.renameSync(tmp, final);
            const r = db.prepare('INSERT INTO recordings(camera_id,filename,size,sha256,recorded_ts,uploaded_ts,dock_id) VALUES(?,?,?,?,?,?,?)')
                .run(id, path.basename(final), size, got, rts, Date.now(), dockId);
            audit(`dock:${dockId}`, 'recording_offloaded', id);
            res.json({ ok: true, id: Number(r.lastInsertRowid), sha256: got });
        });
    });

    // Agent reports what it sees on the docks (battery, storage, build) and what it is doing with each camera.
    const STATES = new Set(['connected', 'offloading', 'synced', 'error']);
    const num = (v) => (Number.isFinite(v) ? v : null);
    app.post('/api/dock/report', needDock, (req, res) => {
        const dockId = String(req.body?.dockId || 'dock').slice(0, 40);
        const list = Array.isArray(req.body?.cameras) ? req.body.cameras.slice(0, 200).map((c) => {
            const port = String(c.port || c.serial || '').slice(0, 60);
            const pr = c.progress && typeof c.progress === 'object' ? c.progress : null;
            return {
                serial: String(c.serial || '').slice(0, 40), port, slot: port ? slotFor(dockId, port) : null, cameraId: str(c.cameraId) || null,
                battery: num(c.battery), storageFreeMb: num(c.storageFreeMb), files: num(c.files), pendingMb: num(c.pendingMb),
                state: STATES.has(c.state) ? c.state : 'connected', message: String(c.message || '').slice(0, 160),
                progress: pr ? { index: num(pr.index), total: num(pr.total), file: String(pr.file || '').slice(0, 60), bytesDone: num(pr.bytesDone), bytesTotal: num(pr.bytesTotal) } : null,
                synced: num(c.synced), failed: num(c.failed), lastSyncTs: num(c.lastSyncTs),
            };
        }) : [];
        docks.set(dockId, { ts: Date.now(), agent: String(req.body?.agent || '').slice(0, 20), mode: req.body?.deleteAfter ? 'move' : 'copy', cameras: list });
        res.json({ ok: true });
    });
    app.get('/api/admin/docks', needUser, needAdmin, (req, res) => res.json({ docks: [...docks].map(([id, d]) => ({ id, ...d })) }));

    const visible = (u, id) => canSee(u, id);
    const mine = (u, cameraId) => (cameraId && cams.has(cameraId) ? visible(u, cameraId) : isStaff(u));

    // Everything the Docking page needs in one call: bays, registered cameras, server storage. Company users only see their cameras.
    app.get('/api/docks', needUser, (req, res) => {
        const now = Date.now();
        const list = [...docks].map(([id, d]) => ({ id, ts: d.ts, online: now - d.ts < 90_000, agent: d.agent, mode: d.mode,
            // A bay holding someone else's camera is shown as occupied, without saying whose or which camera.
            cameras: d.cameras.map((c) => (mine(req.user, c.cameraId)
                ? { ...c, company: c.cameraId && cams.has(c.cameraId) ? companyName(cams.get(c.cameraId).companyId) : null }
                : { slot: c.slot, state: 'other', cameraId: null, serial: '', port: '' })) }));
        const rec = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(size),0) bytes FROM recordings').get();
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const td = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(size),0) bytes FROM recordings WHERE uploaded_ts >= ?').get(today.getTime());
        let disk = null; try { const f = fs.statfsSync(dir); disk = { totalBytes: f.blocks * f.bsize, freeBytes: f.bavail * f.bsize }; } catch (e) { /* not supported */ }
        const known = [...cams].filter(([id]) => visible(req.user, id)).map(([id, c]) => ({
            cameraId: id, company: companyName(c.companyId), region: c.region || null, online: !!c.online, recording: !!c.recording, ts: c.ts || null, quality: c.quality || null,
            recordings: db.prepare('SELECT COUNT(*) n FROM recordings WHERE camera_id = ?').get(id).n }));
        res.json({ slots: SLOTS, enabled: !!DOCK_TOKEN, docks: list, cameras: known,
            storage: { recordings: rec.n, recordingsBytes: rec.bytes, todayCount: td.n, todayBytes: td.bytes, ...(disk || {}) } });
    });

    app.get('/api/recordings', needUser, (req, res) => {
        const cam = req.query.camera ? str(String(req.query.camera)) : null;
        const from = Number(req.query.from) || null, to = Number(req.query.to) || null;
        const type = req.query.type === 'video' ? 'mp4' : req.query.type === 'image' ? 'jpg' : null;
        const where = [], args = [];
        if (cam) { where.push('camera_id = ?'); args.push(cam); }
        if (from) { where.push('COALESCE(recorded_ts, uploaded_ts) >= ?'); args.push(from); }
        if (to) { where.push('COALESCE(recorded_ts, uploaded_ts) < ?'); args.push(to); }
        if (type) { where.push('filename LIKE ?'); args.push('%.' + type); }
        const rows = db.prepare(`SELECT id,camera_id AS cameraId,filename,size,sha256,recorded_ts AS recordedTs,uploaded_ts AS uploadedTs,dock_id AS dockId
            FROM recordings ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY COALESCE(recorded_ts, uploaded_ts) DESC LIMIT 500`).all(...args);
        res.json({ recordings: rows.filter((r) => mine(req.user, r.cameraId)) });
    });
    app.get('/api/recordings/:id/file', needUser, (req, res) => {
        const r = db.prepare('SELECT * FROM recordings WHERE id = ?').get(Number(req.params.id));
        if (!r || !(cams.has(r.camera_id) ? visible(req.user, r.camera_id) : isStaff(req.user))) return res.status(404).json({ error: 'Not found.' });
        audit(req.user.username, 'recording_downloaded', r.camera_id);
        res.sendFile(path.join(dir, r.camera_id, r.filename));
    });
}
module.exports = { register, NAME_RE };
