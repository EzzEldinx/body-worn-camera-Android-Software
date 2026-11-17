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
    const { db, cams, needUser, needAdmin, needWrite = needAdmin, needDelete = needAdmin, canSee, isStaff, str, companyName, publish, setBattery } = ctx;
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
    // One default for everybody (Smart Way sets it) and, when a company's administrator chose, one per company: what happens to files the dock copied for that company's cameras.
    const policy = (companyId) => { const m = (companyId && getSetting('mode:' + companyId, null)) || getSetting('mode', 'ask'); return { mode: MODES.has(m) ? m : 'ask', uploadQuality: 'original', own: !!(companyId && getSetting('mode:' + companyId, null)) }; };
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
            // The same file may have arrived on another connection while this one was still uploading (a retry racing the first attempt):
            // it is stored once. Everything below runs in one go, so this second look cannot be overtaken.
            const twin = db.prepare('SELECT id FROM recordings WHERE camera_id = ? AND sha256 = ?').get(id, got);
            if (twin) { fs.rm(tmp, { force: true }, () => {}); return res.json({ ok: true, duplicate: true, id: twin.id }); }
            let final = path.join(camDir, name), moved = false;
            try {
                if (fs.existsSync(final)) final = path.join(camDir, `${got.slice(0, 8)}_${name}`);
                fs.renameSync(tmp, final); moved = true;
                const r = db.prepare('INSERT INTO recordings(camera_id,filename,size,sha256,recorded_ts,uploaded_ts,dock_id) VALUES(?,?,?,?,?,?,?)')
                    .run(id, path.basename(final), size, got, rts, Date.now(), dockId);
                db.prepare("UPDATE dock_files SET state='cloud', message=NULL, updated_ts=? WHERE camera_id=? AND sha256=?").run(Date.now(), id, got);
                audit(`dock:${dockId}`, 'dock_file_uploaded_cloud', id, { file: name, size, verifiedSha256: true }, got);
                res.json({ ok: true, id: Number(r.lastInsertRowid), sha256: got });
            } catch (e) {   // disk full, database busy...: no file without a row, no crash; the dock keeps its copy and sends it again
                console.error(`dock upload ${id}/${name} could not be stored:`, e);
                if (moved && !db.prepare('SELECT 1 FROM recordings WHERE camera_id = ? AND sha256 = ?').get(id, got)) fs.rm(final, { force: true }, () => {});
                fail(500, 'Could not store the file. Try again.');
            }
        });
    });

    // Agent reports what it sees on the docks (battery, storage, build) and what it is doing with each camera.
    const STATES = new Set(['connected', 'offloading', 'synced', 'error', 'updating']);
    const num = (v) => (Number.isFinite(v) ? v : null);
    // Guided calibration: with the dock empty, plug a camera into bay 1, then bay 2 ... The first time a USB port is seen it becomes the next bay,
    // so every bay (even ones never used) is learned from the real hardware. From then on the bay follows the port, whichever camera is in it.
    const calibrating = new Map();   // dock id -> { next, started }
    app.post('/api/dock/report', needDock, (req, res) => {
        const dockId = String(req.body?.dockId || 'dock').slice(0, 40);
        const cal = calibrating.get(dockId);
        if (cal && Array.isArray(req.body?.cameras)) for (const c of req.body.cameras.slice(0, 200)) {
            const port = String(c.port || c.serial || '').slice(0, 60);
            if (!port || db.prepare('SELECT 1 FROM dock_slots WHERE dock_id = ? AND port = ?').get(dockId, port)) continue;
            db.prepare('INSERT INTO dock_slots(dock_id,port,slot) VALUES(?,?,?)').run(dockId, port, cal.next++);
            if (cal.next >= SLOTS) { calibrating.delete(dockId); audit('system', 'dock_calibrated', null, { dock: dockId }); break; }
        }
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
        // The battery of every docked camera (read over USB while it charges): hand it to the fleet state so every dashboard and the app show it.
        // A camera that reports its own battery keeps doing so; the newest reading wins.
        for (const c of list) if (c.cameraId && c.battery != null && cams.has(c.cameraId)) (setBattery ? setBattery(c.cameraId, c.battery) : publish(c.cameraId, { battery: c.battery, batteryTs: Date.now() }));
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
    // The bay a camera shows in follows the USB port it is plugged into. First sight puts it in the first free bay, which is rarely its real position:
    // an administrator tells the system which physical bay a port is (the camera in the target bay swaps places).
    app.put('/api/admin/dock/slot', needUser, needAdmin, (req, res) => {
        const dockId = String(req.body?.dockId || '').slice(0, 40), port = String(req.body?.port || '').slice(0, 60), slot = Number(req.body?.slot);
        if (!dockId || !port || !Number.isInteger(slot) || slot < 0 || slot >= SLOTS) return res.status(400).json({ error: 'Bad bay.' });
        const mine = db.prepare('SELECT slot FROM dock_slots WHERE dock_id = ? AND port = ?').get(dockId, port);
        const other = db.prepare('SELECT port FROM dock_slots WHERE dock_id = ? AND slot = ? AND port != ?').get(dockId, slot, port);
        if (other) db.prepare('UPDATE dock_slots SET slot = ? WHERE dock_id = ? AND port = ?').run(mine ? mine.slot : SLOTS + db.prepare('SELECT COUNT(*) n FROM dock_slots WHERE dock_id = ?').get(dockId).n, dockId, other.port);
        db.prepare('INSERT INTO dock_slots(dock_id,port,slot) VALUES(?,?,?) ON CONFLICT(dock_id,port) DO UPDATE SET slot = excluded.slot').run(dockId, port, slot);
        const d = docks.get(dockId); if (d) for (const c of d.cameras) if (c.port) c.slot = slotFor(dockId, c.port);   // show it at once
        audit(req.user.username, 'dock_bay_set', null, { dock: dockId, port, bay: slot + 1 });
        res.json({ ok: true });
    });
    // Arrange every bay at once from what you see in front of the dock: two rows of five, camera numbers or names left to right, "-" for an empty bay.
    //   { dockId, top: ['01','05','03','02','06'], bottom: ['-','-','-','-','04'] }
    app.put('/api/admin/dock/layout', needUser, needAdmin, (req, res) => {
        const d = docks.get(String(req.body?.dockId || '')); if (!d) return res.status(404).json({ error: 'That dock is not reporting.' });
        const row = (r) => (Array.isArray(r) ? r : String(r || '').split(/[\s,;]+/)).map((x) => String(x).trim()).filter(Boolean);
        const wanted = [...row(req.body?.top), ...row(req.body?.bottom)];
        const half = Math.ceil(SLOTS / 2);
        if (row(req.body?.top).length !== half || row(req.body?.bottom).length !== SLOTS - half) return res.status(400).json({ error: `Give ${half} entries for the top row and ${SLOTS - half} for the bottom row (use - for an empty bay).` });
        const cams = d.cameras.filter((c) => c.port && c.cameraId), pick = [], used = new Set();
        for (let i = 0; i < wanted.length; i++) {
            const w = wanted[i]; if (w === '-' || w === '0') continue;
            const num = /^\d+$/.test(w) ? new RegExp(`(^|\\D)0*${Number(w)}(\\D|$)`) : null;
            const hits = cams.filter((c) => !used.has(c.port) && (num ? num.test(c.cameraId) : c.cameraId.toLowerCase().includes(w.toLowerCase())));
            if (hits.length !== 1) return res.status(400).json({ error: hits.length ? `"${w}" matches more than one docked camera (${hits.map((h) => h.cameraId).join(', ')}).` : `No docked camera matches "${w}".` });
            used.add(hits[0].port); pick.push([hits[0].port, i]);
        }
        const taken = new Set(pick.map((x) => x[1]));
        db.prepare('DELETE FROM dock_slots WHERE dock_id = ?').run(d.id || String(req.body.dockId));
        for (const [port, slot] of pick) db.prepare('INSERT INTO dock_slots(dock_id,port,slot) VALUES(?,?,?)').run(String(req.body.dockId), port, slot);
        for (const c of d.cameras) if (c.port && !used.has(c.port)) { let n = 0; while (taken.has(n)) n++; taken.add(n); db.prepare('INSERT INTO dock_slots(dock_id,port,slot) VALUES(?,?,?)').run(String(req.body.dockId), c.port, n); }
        for (const c of d.cameras) if (c.port) c.slot = slotFor(String(req.body.dockId), c.port);
        audit(req.user.username, 'dock_bays_arranged', null, { dock: String(req.body.dockId), top: row(req.body?.top).join(' '), bottom: row(req.body?.bottom).join(' ') });
        res.json({ ok: true });
    });
    app.post('/api/admin/dock/calibrate', needUser, needAdmin, (req, res) => {
        const dockId = String(req.body?.dockId || '').slice(0, 40), d = docks.get(dockId);
        if (req.body?.action === 'stop') { calibrating.delete(dockId); return res.json({ ok: true }); }
        if (!d) return res.status(404).json({ error: 'That dock is not reporting.' });
        if (d.cameras.length) return res.status(409).json({ error: 'Take every camera off the dock first, then start.' });
        db.prepare('DELETE FROM dock_slots WHERE dock_id = ?').run(dockId);
        calibrating.set(dockId, { next: 0, started: Date.now() });
        audit(req.user.username, 'dock_calibration_started', null, { dock: dockId });
        res.json({ ok: true });
    });
    app.delete('/api/admin/dock/slots', needUser, needAdmin, (req, res) => {   // forget every mapping: bays fill in order of arrival again
        db.prepare('DELETE FROM dock_slots WHERE dock_id = ?').run(String(req.query.dockId || '').slice(0, 40));
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
            updateMode: c.updateMode || 'off', canWifi: Array.isArray(c.caps) && c.caps.includes('update-net'),   // how the camera may be updated (the Registered tab, super administrator)
            recordings: db.prepare('SELECT COUNT(*) n FROM recordings WHERE camera_id = ?').get(id).n }));
        const fc = { awaiting: 0, local: 0, queued: 0, cloud: 0, failed: 0 };
        for (const r of db.prepare('SELECT camera_id,state,choice FROM dock_files').all()) if (mine(req.user, r.camera_id)) fc[r.state === 'cloud' ? 'cloud' : r.state === 'failed' ? 'failed' : r.choice === null ? 'awaiting' : r.choice === 'local' ? 'local' : 'queued']++;
        res.json({ slots: SLOTS, calibration: [...calibrating].map(([id, c]) => ({ dock: id, next: c.next })), enabled: !!DOCK_TOKEN, policy: policy(req.user.companyId), storageDir: req.user.companyId ? getSetting('dir:' + req.user.companyId, null) : null, fileCounts: fc, docks: list, cameras: known,
            storage: { retentionDays: RETENTION_DAYS, recordings: rec.n, recordingsBytes: rec.bytes, todayCount: td.n, todayBytes: td.bytes, ...(disk || {}) } });
    });

    // ---------- what to do with the files a dock has copied ----------
    // Where each camera's files are kept on the dock computer when its company chose a folder (cameraId -> folder).
    const dirsFor = () => { const o = {}; for (const [id, c] of cams) { const d = c.companyId && getSetting('dir:' + c.companyId, null); if (d) o[id] = d; } return o; };
    app.get('/api/dock/policy', needDock, (req, res) => res.json({ ...policy(), dirs: dirsFor() }));
    app.get('/api/admin/dock/policy', needUser, (req, res) => res.json(policy(req.user.companyId)));
    // Smart Way sets the default (or one company's choice: companyId); a company's administrator with "Decide on recordings" sets his own company's.
    app.put('/api/admin/dock/policy', needUser, (req, res) => {
        const u = req.user, mode = String(req.body?.mode || '');
        if (!MODES.has(mode)) return res.status(400).json({ error: 'mode must be ask, auto_cloud or auto_local.' });
        const staff = !u.companyId;
        if (staff ? u.role !== 'admin' : !(u.role === 'manager' && (u.features || []).includes('files'))) return res.status(403).json({ error: 'You are not allowed to decide on recordings.' });
        const cid = staff ? (Number.isInteger(Number(req.body?.companyId)) && Number(req.body?.companyId) > 0 ? Number(req.body.companyId) : null) : u.companyId;
        const key = cid ? 'mode:' + cid : 'mode', was = policy(cid).mode;
        db.prepare('INSERT INTO dock_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, mode);
        audit(u.username, `dock_policy_${mode}`, null, { mode, was, companyId: cid });
        res.json(policy(cid));
    });

    // Browsing the dock computer's folders: the dashboard asks, the Dock Agent (polling every 1.5 s) answers. Only folders, only under the agent's own allowed places.
    const browse = new Map(); let browseSeq = 0;
    const askAgent = (type, p) => new Promise((resolve) => { const id = ++browseSeq; browse.set(id, { id, type, path: p, taken: false, resolve }); setTimeout(() => { if (browse.delete(id)) resolve(null); }, 20000); });
    const mayChoose = (u) => (!u.companyId ? u.role === 'admin' : u.role === 'manager' && (u.features || []).includes('files'));
    app.get('/api/dock/browse-pending', needDock, (req, res) => { const out = [...browse.values()].filter((r) => !r.taken); out.forEach((r) => { r.taken = true; }); res.json({ requests: out.map(({ id, type, path: p }) => ({ id, type, path: p })) }); });
    app.post('/api/dock/browse-result', needDock, (req, res) => { const r = browse.get(Number(req.body?.id)); if (r) { browse.delete(r.id); r.resolve(req.body); } res.json({ ok: true }); });
    app.post('/api/dock/browse', needUser, async (req, res) => {
        if (!mayChoose(req.user)) return res.status(403).json({ error: 'You are not allowed to decide on recordings.' });
        const r = await askAgent('list', String(req.body?.path || '').slice(0, 500));
        if (!r) return res.status(504).json({ error: 'The dock computer did not answer. Is the Dock Agent running and up to date?' });
        res.json({ ok: !!r.ok, path: r.path || '', parent: r.parent || null, dirs: Array.isArray(r.dirs) ? r.dirs.slice(0, 300) : [], error: r.error || null });
    });
    // The folder a company keeps its files in on the dock computer: checked by the agent (created and written to) before it is saved.
    app.put('/api/admin/dock/storage', needUser, async (req, res) => {
        const u = req.user;
        if (!mayChoose(u)) return res.status(403).json({ error: 'You are not allowed to decide on recordings.' });
        const cid = u.companyId || (Number(req.body?.companyId) > 0 ? Number(req.body.companyId) : null), p = String(req.body?.path || '').slice(0, 500);
        if (!cid) return res.status(400).json({ error: 'Pick the company.' });
        if (!p) return res.status(400).json({ error: 'Pick a folder.' });
        const r = await askAgent('check', p);
        if (!r) return res.status(504).json({ error: 'The dock computer did not answer. Is the Dock Agent running and up to date?' });
        if (!r.ok) return res.status(400).json({ error: String(r.error || 'The dock computer cannot use that folder.').slice(0, 160) });
        db.prepare('INSERT INTO dock_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('dir:' + cid, r.path);
        audit(u.username, 'dock_storage_set', null, { companyId: cid, dir: r.path });
        res.json({ ok: true, dir: r.path });
    });

    // The agent announces files that are now safe on the dock's own storage; the answer says what to do with each.
    app.post('/api/dock/catalog', needDock, (req, res) => {
        const dockId = String(req.body?.dockId || 'dock').slice(0, 40);
        const files = Array.isArray(req.body?.files) ? req.body.files.slice(0, 1000) : [];
        const now = Date.now(), out = [];
        const ins = db.prepare(`INSERT INTO dock_files(camera_id,filename,size,sha256,recorded_ts,dock_id,state,choice,chosen_by,added_ts,updated_ts)
            VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(camera_id,sha256) DO UPDATE SET dock_id = excluded.dock_id, updated_ts = excluded.updated_ts`);
        for (const f of files) {
            const cameraId = str(f.cameraId), name = String(f.name || ''), sha = String(f.sha256 || '').toLowerCase(), size = Number(f.size);
            if (!cameraId || !NAME_RE.test(name) || !/^[0-9a-f]{64}$/.test(sha) || !Number.isInteger(size) || size < 1) continue;
            const onCloud = !!db.prepare('SELECT 1 FROM recordings WHERE camera_id = ? AND sha256 = ?').get(cameraId, sha);
            const mode = policy(cams.get(cameraId)?.companyId).mode, auto = mode === 'auto_cloud' ? 'cloud' : mode === 'auto_local' ? 'local' : null;
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
        const rows = db.prepare(`SELECT id,camera_id AS cameraId,filename,size,sha256,updated_ts AS updatedTs,recorded_ts AS recordedTs,dock_id AS dockId,state,choice,chosen_by AS chosenBy,message,added_ts AS addedTs,(SELECT r.id FROM recordings r WHERE r.camera_id = dock_files.camera_id AND r.sha256 = dock_files.sha256) AS recordingId,cam_delete AS camDelete,cam_deleted_ts AS camDeletedTs
            FROM dock_files ORDER BY added_ts DESC, id DESC LIMIT 3000`).all().filter((r) => mine(req.user, r.cameraId));
        const bucket = (r) => (r.state === 'cloud' ? 'cloud' : r.state === 'failed' ? 'failed' : r.choice === null ? 'awaiting' : r.choice === 'local' ? 'local' : 'queued');
        const counts = { awaiting: { n: 0, bytes: 0 }, local: { n: 0, bytes: 0 }, queued: { n: 0, bytes: 0 }, cloud: { n: 0, bytes: 0 }, failed: { n: 0, bytes: 0 } };
        for (const r of rows) { const b = bucket(r); counts[b].n++; counts[b].bytes += r.size; }
        const files = rows.filter((r) => !state || bucket(r) === state).slice(0, 500).map((r) => ({ ...r, bucket: bucket(r) }));
        res.json({ policy: policy(req.user.companyId), storageDir: req.user.companyId ? getSetting('dir:' + req.user.companyId, null) : null, counts, files });
    });
    // The user's decision: push to the cloud, or keep on the dock's own storage. Works on a list of files or on everything waiting.
    app.post('/api/dock/files/choose', needUser, needWrite, (req, res) => {
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
    app.post('/api/dock/files/delete-from-camera', needUser, needDelete, (req, res) => {
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

    // What the check-out station needs to know: which cameras sit on a dock right now (its agent reported in the last 30 s) and in what state.
    const FRESH = 30_000;
    const anyDockOnline = (now = Date.now()) => [...docks.values()].some((d) => now - d.ts <= FRESH);
    const docked = (now = Date.now()) => {
        const out = new Map();
        for (const [dockId, d] of docks) {
            if (now - d.ts > FRESH) continue;
            for (const c of d.cameras) if (c.cameraId) out.set(c.cameraId, { dockId, slot: c.slot, state: c.state, battery: c.battery, message: c.message, progress: c.progress, pendingMb: c.pendingMb, ts: d.ts });
        }
        return out;
    };
    return { docked, anyDockOnline, needDock };
}
module.exports = { register, NAME_RE };
