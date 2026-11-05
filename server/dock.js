// Docking-station API: a Dock Agent (PC next to the docks) offloads recordings from cameras to the server,
// which verifies every file by SHA-256 before it is stored. Dashboards list/download recordings (company-scoped).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeEqual } = require('./tokens');

const NAME_RE = /^(VID|IMG)_\d{6,16}\.(mp4|jpg)$/;
const MAX_BYTES = 8 * 1024 ** 3;

function register(app, ctx) {
    const { db, cams, needUser, needAdmin, canSee, isStaff, str } = ctx;
    const DOCK_TOKEN = process.env.DOCK_TOKEN || '';
    const dir = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'recordings');
    fs.mkdirSync(dir, { recursive: true });

    db.exec(`CREATE TABLE IF NOT EXISTS recordings(
        id INTEGER PRIMARY KEY AUTOINCREMENT, camera_id TEXT NOT NULL, filename TEXT NOT NULL, size INTEGER NOT NULL,
        sha256 TEXT NOT NULL, recorded_ts INTEGER, uploaded_ts INTEGER NOT NULL, dock_id TEXT,
        UNIQUE(camera_id, sha256))`);
    db.exec('CREATE INDEX IF NOT EXISTS rec_cam ON recordings(camera_id, recorded_ts)');
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

    // Agent reports what it sees on the docks (battery, storage, build).
    app.post('/api/dock/report', needDock, (req, res) => {
        const dockId = String(req.body?.dockId || 'dock').slice(0, 40);
        const list = Array.isArray(req.body?.cameras) ? req.body.cameras.slice(0, 200).map((c) => ({
            serial: String(c.serial || '').slice(0, 40), cameraId: str(c.cameraId) || null, battery: Number.isFinite(c.battery) ? c.battery : null,
            storageFreeMb: Number.isFinite(c.storageFreeMb) ? c.storageFreeMb : null, files: Number.isFinite(c.files) ? c.files : null,
            pendingMb: Number.isFinite(c.pendingMb) ? c.pendingMb : null,
        })) : [];
        docks.set(dockId, { ts: Date.now(), cameras: list });
        res.json({ ok: true });
    });
    app.get('/api/admin/docks', needUser, needAdmin, (req, res) => res.json({ docks: [...docks].map(([id, d]) => ({ id, ...d })) }));

    const visible = (u, id) => canSee(u, id);
    app.get('/api/recordings', needUser, (req, res) => {
        const cam = req.query.camera ? str(String(req.query.camera)) : null;
        const rows = db.prepare(`SELECT id,camera_id AS cameraId,filename,size,sha256,recorded_ts AS recordedTs,uploaded_ts AS uploadedTs,dock_id AS dockId
            FROM recordings ${cam ? 'WHERE camera_id = ?' : ''} ORDER BY COALESCE(recorded_ts, uploaded_ts) DESC LIMIT 500`).all(...(cam ? [cam] : []));
        res.json({ recordings: rows.filter((r) => cams.has(r.cameraId) ? visible(req.user, r.cameraId) : isStaff(req.user)) });
    });
    app.get('/api/recordings/:id/file', needUser, (req, res) => {
        const r = db.prepare('SELECT * FROM recordings WHERE id = ?').get(Number(req.params.id));
        if (!r || !(cams.has(r.camera_id) ? visible(req.user, r.camera_id) : isStaff(req.user))) return res.status(404).json({ error: 'Not found.' });
        audit(req.user.username, 'recording_downloaded', r.camera_id);
        res.sendFile(path.join(dir, r.camera_id, r.filename));
    });
}
module.exports = { register, NAME_RE };
