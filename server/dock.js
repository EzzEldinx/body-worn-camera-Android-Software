// Docking-station API: a Dock Agent (PC next to the docks) offloads recordings from cameras to the server,
// which verifies every file by SHA-256 before it is stored. Dashboards list/download recordings (company-scoped).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeEqual } = require('./tokens');
const auditlog = require('./auditlog');

const NAME_RE = /^(VID|IMG)_\d{6,16}\.(mp4|jpg)$/;
const MAX_BYTES = 8 * 1024 ** 3;

function register(app, ctx) {
    const { db, cams, needUser, needAdmin, canSee, isStaff, str, companyName, publish } = ctx;
    const DOCK_TOKEN = process.env.DOCK_TOKEN || '';
    const dir = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'recordings');
    fs.mkdirSync(dir, { recursive: true });

    db.exec(`CREATE TABLE IF NOT EXISTS recordings(
        id INTEGER PRIMARY KEY AUTOINCREMENT, camera_id TEXT NOT NULL, filename TEXT NOT NULL, size INTEGER NOT NULL,
        sha256 TEXT NOT NULL, recorded_ts INTEGER, uploaded_ts INTEGER NOT NULL, dock_id TEXT,
        UNIQUE(camera_id, sha256))`);
    db.exec('CREATE INDEX IF NOT EXISTS rec_cam ON recordings(camera_id, recorded_ts)');
    // Files the dock has copied from cameras, and what the user decided to do with each one:
    //   state  on_dock (safe on the dock's own storage) | uploading | cloud (stored on this server) | failed
    //   choice NULL = waiting for the user | 'cloud' = push to the cloud | 'local' = keep on the dock's storage
    db.exec(`CREATE TABLE IF NOT EXISTS dock_files(
        id INTEGER PRIMARY KEY AUTOINCREMENT, camera_id TEXT NOT NULL, filename TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
        recorded_ts INTEGER, dock_id TEXT, state TEXT NOT NULL DEFAULT 'on_dock', choice TEXT, chosen_by TEXT, message TEXT,
        added_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL, UNIQUE(camera_id, sha256))`);
    for (const [col, ddl] of [['cam_delete', 'INTEGER NOT NULL DEFAULT 0'], ['cam_deleted_ts', 'INTEGER']]) {   // "delete from the camera": requested by the user, done by the agent
        if (!db.prepare('PRAGMA table_info(dock_files)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE dock_files ADD COLUMN ${col} ${ddl}`);
    }
    db.exec('CREATE INDEX IF NOT EXISTS dock_files_state ON dock_files(state, choice)');
    db.exec('CREATE TABLE IF NOT EXISTS dock_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    // Policy: what happens to files the dock has just copied. ask = the user decides per file (or in bulk); auto_cloud / auto_local = automatic.
    const MODES = new Set(['ask', 'auto_cloud', 'auto_local']);
    const getSetting = (k, d) => db.prepare('SELECT value FROM dock_settings WHERE key = ?').get(k)?.value ?? d;
    const policy = () => ({ mode: MODES.has(getSetting('mode', 'ask')) ? getSetting('mode', 'ask') : 'ask', uploadQuality: 'original' });
    // A camera's physical dock port (USB location) always lands in the same bay: first free bay on first sight.
    db.exec('CREATE TABLE IF NOT EXISTS dock_slots(dock_id TEXT NOT NULL, port TEXT NOT NULL, slot INTEGER NOT NULL, PRIMARY KEY(dock_id, port))');
    const SLOTS = Math.max(1, Math.min(64, Number(process.env.DOCK_SLOTS) || 10));
    const slotFor = (dockId, port) => {
        const hit = db.prepare('SELECT slot FROM dock_slots WHERE dock_id = ? AND port = ?').get(dockId, port);
        if (hit) return hit.slot;
        const used = new Set(db.prepare('SELECT slot FROM dock_slots WHERE dock_id = ?').all(dockId).map((r) => r.slot));
        let n = 0; while (used.has(n)) n++;
        db.prepare('INSERT INTO dock_slots(dock_id,port,slot) VALUES(?,?,?)').run(dockId, port, n);
        return n;
    };
    const RETENTION_DAYS = Number(process.env.RECORDINGS_RETENTION_DAYS) || 0;
    require('./retention').start({ db, dir, days: RETENTION_DAYS }); // 0 = keep forever (default)
    const docks = new Map(); // dock id -> last report (in memory)

    const needDock = (req, res, next) => {
        if (!DOCK_TOKEN) return res.status(503).json({ error: 'Docking is disabled: set DOCK_TOKEN on the server.' });
        if (!safeEqual(req.headers['x-dock-token'] || '', DOCK_TOKEN)) return res.status(401).json({ error: 'Bad dock token.' });
        next();
    };
    const audit = (user, action, cam, detail, ref) => auditlog.add(db, user, action, cam || null, detail || null, ref || null);
    // one line per file and step, so a file's whole life (copied, decided, uploaded, removed from the camera) can be read back and nobody can quietly change it
    const fileLog = (user, action, row, extra) => audit(user, action, row.camera_id ?? row.cameraId, { file: row.filename ?? row.name, size: row.size, ...(extra || {}) }, row.sha256);

    // Camera app updates through the dock: the agent asks which build is the latest and installs it on every docked camera that runs an older one.
    const updDir = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'updates');
    app.get('/api/dock/update', needDock, (req, res) => {
        try { const m = JSON.parse(fs.readFileSync(path.join(updDir, 'meta.json'), 'utf8')); res.json({ build: m.build, size: m.size, uploaded: m.uploaded }); }
        catch { res.status(404).json({ error: 'No camera app has been published yet.' }); }
    });
    app.get('/api/dock/update/apk', needDock, (req, res) => {
        const f = path.join(updDir, 'app.apk');
        if (!fs.existsSync(f)) return res.status(404).end();
        res.type('application/vnd.android.package-archive').sendFile(f);
    });

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
        if (dup) { req.resume(); audit(`dock:${dockId}`, 'dock_file_uploaded_cloud', id, { file: name, size, duplicate: true }, want); db.prepare("UPDATE dock_files SET state='cloud', message=NULL, updated_ts=? WHERE camera_id=? AND sha256=?").run(Date.now(), id, want); return res.json({ ok: true, duplicate: true, id: dup.id }); }
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
            db.prepare("UPDATE dock_files SET state='cloud', message=NULL, updated_ts=? WHERE camera_id=? AND sha256=?").run(Date.now(), id, got);
            audit(`dock:${dockId}`, 'dock_file_uploaded_cloud', id, { file: name, size, verifiedSha256: true }, got);
            res.json({ ok: true, id: Number(r.lastInsertRowid), sha256: got });
        });
    });

    // Agent reports what it sees on the docks (battery, storage, build) and what it is doing with each camera.
    const STATES = new Set(['connected', 'offloading', 'synced', 'error', 'updating']);
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
        // A docked camera's battery is the only battery reading we have (cameras do not report it themselves yet):
        // hand it to the fleet state so every dashboard and the mobile app show it, with the time it was read.
        for (const c of list) if (c.cameraId && c.battery != null && cams.has(c.cameraId)) publish(c.cameraId, { battery: c.battery, batteryTs: Date.now() });
        // A camera on the dock is indoors and cannot see the sky, so it has no GPS fix. The dock's own (fixed) location is the best
        // position there is: show the camera there (marked "at the docking station") until it reports a fresh fix of its own.
        const loc = req.body?.location && Number.isFinite(req.body.location.lat) && Number.isFinite(req.body.location.lng)
            && Math.abs(req.body.location.lat) <= 90 && Math.abs(req.body.location.lng) <= 180 ? req.body.location : null;
        if (loc) {
            const now = Date.now(), acc = Number.isFinite(req.body.location.acc) && req.body.location.acc > 0 ? Math.min(req.body.location.acc, 500) : 25;
            for (const c of list) {
                const cam = c.cameraId ? cams.get(c.cameraId) : null;
                if (!cam) continue;
                const ownFresh = cam.posSrc !== 'dock' && cam.fixTs && now - cam.fixTs < 120000;
                if (ownFresh) continue;
                if (cam.posSrc === 'dock' && cam.lat === loc.lat && cam.lng === loc.lng && now - (cam.fixTs || 0) < 30000) continue; // refresh every 30 s, not every report
                publish(c.cameraId, { lat: loc.lat, lng: loc.lng, acc, fixTs: now, posSrc: 'dock' });
            }
        }
        docks.set(dockId, { ts: Date.now(), storage: req.body?.storage && typeof req.body.storage === 'object' ? { dir: String(req.body.storage.dir || '').slice(0, 200), freeBytes: num(req.body.storage.freeBytes), usedBytes: num(req.body.storage.usedBytes) } : null, agent: String(req.body?.agent || '').slice(0, 20), mode: req.body?.deleteAfter ? 'move' : 'copy', cameras: list });
        res.json({ ok: true });
    });
    app.get('/api/admin/docks', needUser, needAdmin, (req, res) => res.json({ docks: [...docks].map(([id, d]) => ({ id, ...d })) }));

    const visible = (u, id) => canSee(u, id);
    const mine = (u, cameraId) => (cameraId && cams.has(cameraId) ? visible(u, cameraId) : isStaff(u));

    // Everything the Docking page needs in one call: bays, registered cameras, server storage. Company users only see their cameras.
    app.get('/api/docks', needUser, (req, res) => {
        const now = Date.now();
        // The agent sends a heartbeat every 2 s: fresh = online, a few missed beats = connecting, long silence = offline.
        const statusOf = (age) => (age < 8_000 ? 'online' : age < 30_000 ? 'connecting' : 'offline');
        const list = [...docks].map(([id, d]) => ({ id, ts: d.ts, status: statusOf(now - d.ts), online: now - d.ts < 8_000, agent: d.agent, mode: d.mode, storage: d.storage || null,
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
        const fc = { awaiting: 0, local: 0, queued: 0, cloud: 0, failed: 0 };
        for (const r of db.prepare('SELECT camera_id,state,choice FROM dock_files').all()) if (mine(req.user, r.camera_id)) fc[r.state === 'cloud' ? 'cloud' : r.state === 'failed' ? 'failed' : r.choice === null ? 'awaiting' : r.choice === 'local' ? 'local' : 'queued']++;
        res.json({ slots: SLOTS, enabled: !!DOCK_TOKEN, policy: policy(), fileCounts: fc, docks: list, cameras: known,
            storage: { retentionDays: RETENTION_DAYS, recordings: rec.n, recordingsBytes: rec.bytes, todayCount: td.n, todayBytes: td.bytes, ...(disk || {}) } });
    });

    // ---------- what to do with the files a dock has copied ----------
    app.get('/api/dock/policy', needDock, (req, res) => res.json(policy()));
    app.get('/api/admin/dock/policy', needUser, (req, res) => res.json(policy()));
    app.put('/api/admin/dock/policy', needUser, needAdmin, (req, res) => {
        const mode = String(req.body?.mode || '');
        if (!MODES.has(mode)) return res.status(400).json({ error: 'mode must be ask, auto_cloud or auto_local.' });
        const was = policy().mode;
        db.prepare('INSERT INTO dock_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('mode', mode);
        audit(req.user.username, `dock_policy_${mode}`, null, { mode, was });
        res.json(policy());
    });

    // The agent announces files that are now safe on the dock's own storage; the answer says what to do with each.
    app.post('/api/dock/catalog', needDock, (req, res) => {
        const dockId = String(req.body?.dockId || 'dock').slice(0, 40);
        const files = Array.isArray(req.body?.files) ? req.body.files.slice(0, 1000) : [];
        const mode = policy().mode, now = Date.now(), out = [];
        const ins = db.prepare(`INSERT INTO dock_files(camera_id,filename,size,sha256,recorded_ts,dock_id,state,choice,chosen_by,added_ts,updated_ts)
            VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(camera_id,sha256) DO UPDATE SET dock_id = excluded.dock_id, updated_ts = excluded.updated_ts`);
        for (const f of files) {
            const cameraId = str(f.cameraId), name = String(f.name || ''), sha = String(f.sha256 || '').toLowerCase(), size = Number(f.size);
            if (!cameraId || !NAME_RE.test(name) || !/^[0-9a-f]{64}$/.test(sha) || !Number.isInteger(size) || size < 1) continue;
            const onCloud = !!db.prepare('SELECT 1 FROM recordings WHERE camera_id = ? AND sha256 = ?').get(cameraId, sha);
            const auto = mode === 'auto_cloud' ? 'cloud' : mode === 'auto_local' ? 'local' : null;
            const existed = !!db.prepare('SELECT 1 FROM dock_files WHERE camera_id = ? AND sha256 = ?').get(cameraId, sha);
            ins.run(cameraId, name, size, sha, Number(f.recordedTs) || null, dockId, onCloud ? 'cloud' : 'on_dock', onCloud ? 'cloud' : auto, auto && !onCloud ? 'auto' : null, now, now);
            if (!existed) audit(`dock:${dockId}`, 'dock_file_copied', cameraId, { file: name, size, dock: dockId, copiedAndVerified: true }, sha);
            let row = db.prepare('SELECT id,state,choice FROM dock_files WHERE camera_id = ? AND sha256 = ?').get(cameraId, sha);
            // a file first seen before automation was switched on gets the automatic decision now
            if (row.choice === null && auto) { db.prepare("UPDATE dock_files SET choice = ?, chosen_by = 'auto', updated_ts = ? WHERE id = ?").run(auto, now, row.id); row = { ...row, choice: auto }; audit('auto', `dock_file_choice_${auto}`, cameraId, { file: name, size, mode }, sha); }
            out.push({ cameraId, sha256: sha, action: row.state === 'cloud' ? 'done' : row.choice === 'cloud' ? 'upload' : row.choice === 'local' ? 'keep' : 'wait' });
        }
        res.json({ policy: policy(), files: out });
    });
    // Files the user wants in the cloud that are not there yet (they may sit on the dock even after the camera has left).
    app.get('/api/dock/queue', needDock, (req, res) => {
        const dockId = String(req.query.dockId || '').slice(0, 40);
        const rows = db.prepare(`SELECT id,camera_id AS cameraId,filename AS name,size,sha256,recorded_ts AS recordedTs FROM dock_files
            WHERE choice = 'cloud' AND state IN ('on_dock','failed') AND (? = '' OR dock_id = ?) ORDER BY added_ts LIMIT 200`).all(dockId, dockId);
        res.json({ files: rows });
    });
    app.post('/api/dock/file-state', needDock, (req, res) => {
        const state = String(req.body?.state || '');
        if (!['on_dock', 'uploading', 'failed'].includes(state)) return res.status(400).json({ error: 'Bad state.' });
        if (state === 'failed') audit('dock', 'dock_file_upload_failed', str(req.body?.cameraId), { reason: String(req.body?.message || '').slice(0, 160) }, String(req.body?.sha256 || ''));
        db.prepare("UPDATE dock_files SET state = ?, message = ?, updated_ts = ? WHERE camera_id = ? AND sha256 = ? AND state != 'cloud'")
            .run(state, String(req.body?.message || '').slice(0, 160) || null, Date.now(), str(req.body?.cameraId), String(req.body?.sha256 || ''));
        res.json({ ok: true });
    });
    app.get('/api/dock/files', needUser, (req, res) => {
        const state = req.query.state === 'all' ? '' : String(req.query.state || '');
        const rows = db.prepare(`SELECT id,camera_id AS cameraId,filename,size,sha256,updated_ts AS updatedTs,recorded_ts AS recordedTs,dock_id AS dockId,state,choice,chosen_by AS chosenBy,message,added_ts AS addedTs,cam_delete AS camDelete,cam_deleted_ts AS camDeletedTs
            FROM dock_files ORDER BY added_ts DESC, id DESC LIMIT 3000`).all().filter((r) => mine(req.user, r.cameraId));
        const bucket = (r) => (r.state === 'cloud' ? 'cloud' : r.state === 'failed' ? 'failed' : r.choice === null ? 'awaiting' : r.choice === 'local' ? 'local' : 'queued');
        const counts = { awaiting: { n: 0, bytes: 0 }, local: { n: 0, bytes: 0 }, queued: { n: 0, bytes: 0 }, cloud: { n: 0, bytes: 0 }, failed: { n: 0, bytes: 0 } };
        for (const r of rows) { const b = bucket(r); counts[b].n++; counts[b].bytes += r.size; }
        const files = rows.filter((r) => !state || bucket(r) === state).slice(0, 500).map((r) => ({ ...r, bucket: bucket(r) }));
        res.json({ policy: policy(), counts, files });
    });
    // The user's decision: push to the cloud, or keep on the dock's own storage. Works on a list of files or on everything waiting.
    app.post('/api/dock/files/choose', needUser, needAdmin, (req, res) => {
        const choice = String(req.body?.choice || '');
        if (!['cloud', 'local'].includes(choice)) return res.status(400).json({ error: 'choice must be cloud or local.' });
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger).slice(0, 5000) : null;
        let rows = ids ? ids.map((id) => db.prepare('SELECT * FROM dock_files WHERE id = ?').get(id)).filter(Boolean)
            : req.body?.allAwaiting ? db.prepare("SELECT * FROM dock_files WHERE choice IS NULL AND state != 'cloud'").all() : [];
        rows = rows.filter((r) => mine(req.user, r.camera_id) && r.state !== 'cloud');
        const upd = db.prepare('UPDATE dock_files SET choice = ?, chosen_by = ?, updated_ts = ?, state = CASE WHEN state = ? THEN ? ELSE state END WHERE id = ?');
        const now = Date.now();
        for (const r of rows) { upd.run(choice, req.user.username, now, 'failed', 'on_dock', r.id); fileLog(req.user.username, `dock_file_choice_${choice}`, r, { was: r.choice || 'undecided' }); }
        res.json({ ok: true, changed: rows.length });
    });

    // "Delete from the camera": the user asks, the agent removes the file from the camera only when it is docked and a verified copy exists
    // (on the dock's storage or in the cloud). The copy is never touched by this.
    app.post('/api/dock/files/delete-from-camera', needUser, needAdmin, (req, res) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger).slice(0, 5000) : [];
        const rows = ids.map((id) => db.prepare('SELECT * FROM dock_files WHERE id = ?').get(id)).filter((r) => r && mine(req.user, r.camera_id) && !r.cam_deleted_ts);
        const upd = db.prepare('UPDATE dock_files SET cam_delete = 1, message = NULL, updated_ts = ? WHERE id = ?');
        for (const r of rows) { upd.run(Date.now(), r.id); fileLog(req.user.username, 'dock_file_delete_requested', r); }
        res.json({ ok: true, requested: rows.length });
    });
    app.get('/api/dock/deletions', needDock, (req, res) => {
        res.json({ files: db.prepare(`SELECT id,camera_id AS cameraId,filename AS name,size,sha256,state FROM dock_files
            WHERE cam_delete = 1 AND cam_deleted_ts IS NULL ORDER BY updated_ts LIMIT 200`).all() });
    });
    app.post('/api/dock/deleted', needDock, (req, res) => {
        const ok = req.body?.ok !== false, now = Date.now();
        audit(ok ? 'dock' : 'dock', ok ? 'dock_file_deleted_from_camera' : 'dock_file_delete_refused', str(req.body?.cameraId), ok ? { verifiedCopyChecked: true } : { reason: String(req.body?.message || '').slice(0, 160) }, String(req.body?.sha256 || ''));
        db.prepare('UPDATE dock_files SET cam_delete = 0, cam_deleted_ts = ?, message = ?, updated_ts = ? WHERE camera_id = ? AND sha256 = ?')
            .run(ok ? now : null, ok ? null : String(req.body?.message || 'Not removed from the camera').slice(0, 160), now, str(req.body?.cameraId), String(req.body?.sha256 || ''));
        res.json({ ok: true });
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
        audit(req.user.username, 'recording_downloaded', r.camera_id, { file: r.filename, size: r.size }, r.sha256);
        res.sendFile(path.join(dir, r.camera_id, r.filename));
    });
}
module.exports = { register, NAME_RE };
