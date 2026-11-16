// Geofencing: zones drawn on the map, and alerts when a camera leaves one, enters one, or does not pass a checkpoint in time.
//
//   zone kinds
//     zone        a circle or a polygon with a rule: alert when a camera LEAVES it (on_exit, "allowed area") and/or ENTERS it (on_enter, "forbidden area")
//     checkpoint  a circle or a polygon a camera must pass every `every_min` minutes while the schedule is on (patrol round); no visit = alert
//   who and when
//     scope       all cameras of the company, or chosen cameras / groups / regions
//     schedule    days of the week and a time window (overnight windows work), in the time zone the zone was made in
//
//   how alerts behave (kept calm on purpose: a GPS fix wobbles)
//     * a change of side counts only after it holds for DEBOUNCE_MS and two fixes, and a fix closer to the edge than its own accuracy changes nothing
//     * the first fix of a camera only sets the starting point: "left the zone" needs the camera to have been inside first
//     * a camera on a docking station (its position comes from the dock) is not judged; its open geofence alerts close
//     * alerts live in the same `alerts` table as the battery alerts, so acknowledging, the Alarms list, the mobile app and push work unchanged
//     * an alert closes by itself when the camera is back in line (or the checkpoint was visited)
const DEBOUNCE_MS = Number(process.env.GEOFENCE_DEBOUNCE_MS) || 15000;
const GRACE_MS = Number(process.env.GEOFENCE_GRACE_MS) || 2 * 60000;     // extra time after a checkpoint is due before it is called missed
const SWEEP_MS = 15000;
const MAX_ZONES = 200, MAX_POINTS = 100, MAX_SCOPE = 500;
const KINDS = ['zone', 'checkpoint'];
const ALERT_KINDS = ['geo_exit', 'geo_enter', 'checkpoint_missed'];
const R_EARTH = 6371000;

// ---------- geometry (small areas: a flat local approximation is exact enough) ----------
const rad = (d) => (d * Math.PI) / 180;
function distance(aLat, aLng, bLat, bLng) {   // haversine, metres
    const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}
const toXY = (lat, lng, lat0) => [rad(lng) * R_EARTH * Math.cos(rad(lat0)), rad(lat) * R_EARTH];
function pointInPolygon(lat, lng, pts) {   // ray casting on [lat,lng] pairs
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [yi, xi] = pts[i], [yj, xj] = pts[j];
        if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}
function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
const isInside = (shape, lat, lng) => (shape.type === 'circle' ? distance(lat, lng, shape.lat, shape.lng) <= shape.r : pointInPolygon(lat, lng, shape.pts));
/** Metres from the point to the edge of the shape (either side). */
function edgeDistance(shape, lat, lng) {
    if (shape.type === 'circle') return Math.abs(distance(lat, lng, shape.lat, shape.lng) - shape.r);
    const [px, py] = toXY(lat, lng, lat);
    let best = Infinity;
    for (let i = 0, j = shape.pts.length - 1; i < shape.pts.length; j = i++) {
        const [ax, ay] = toXY(shape.pts[j][0], shape.pts[j][1], lat), [bx, by] = toXY(shape.pts[i][0], shape.pts[i][1], lat);
        best = Math.min(best, segDist(px, py, ax, ay, bx, by));
    }
    return best;
}

// ---------- schedule ----------
const ALL_DAYS = 127;   // bit 0 = Sunday ... bit 6 = Saturday
const hasDay = (mask, d) => ((mask >> ((d + 7) % 7)) & 1) === 1;
const localOf = (t, tz) => { const d = new Date(t + tz * 60000); return { day: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes() }; };
/** Is the zone's schedule on at time t? (no window = the whole day) */
function activeAt(z, t) {
    const { day, min } = localOf(t, z.tz);
    if (z.fromMin == null || z.toMin == null || z.fromMin === z.toMin) return hasDay(z.days, day);
    if (z.fromMin < z.toMin) return hasDay(z.days, day) && min >= z.fromMin && min < z.toMin;
    return (hasDay(z.days, day) && min >= z.fromMin) || (hasDay(z.days, day - 1) && min < z.toMin);   // overnight: the window belongs to the day it started on
}
/** When did the schedule window that is on at time t begin? */
function windowStart(z, t) {
    const { min } = localOf(t, z.tz);
    const dayStart = Math.floor((t + z.tz * 60000) / 86400000) * 86400000 - z.tz * 60000;   // local midnight, as a real timestamp
    if (z.fromMin == null || z.toMin == null || z.fromMin === z.toMin) return dayStart;
    if (z.fromMin < z.toMin || min >= z.fromMin) return dayStart + z.fromMin * 60000;
    return dayStart - 86400000 + z.fromMin * 60000;
}
const minutesOf = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '')); if (!m) return null; const h = +m[1], mi = +m[2]; return h < 24 && mi < 60 ? h * 60 + mi : null; };
const hhmm = (m) => (m == null ? null : String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'));

// ---------- validation ----------
const num = (v, lo, hi) => { const n = typeof v === 'string' && v.trim() === '' ? NaN : Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
const r6 = (n) => Math.round(n * 1e6) / 1e6;
function cleanShape(s) {
    if (!s || typeof s !== 'object') return { error: 'Draw the zone on the map first.' };
    if (s.type === 'circle') {
        const lat = num(s.lat, -90, 90), lng = num(s.lng, -180, 180), r = num(s.r, 10, 50000);
        if (lat === null || lng === null) return { error: 'The centre of the circle is not a valid position.' };
        if (r === null) return { error: 'The radius must be between 10 m and 50 km.' };
        return { shape: { type: 'circle', lat: r6(lat), lng: r6(lng), r: Math.round(r) } };
    }
    if (s.type === 'polygon') {
        if (!Array.isArray(s.pts) || s.pts.length < 3) return { error: 'A polygon needs at least 3 points.' };
        if (s.pts.length > MAX_POINTS) return { error: `A polygon can have at most ${MAX_POINTS} points.` };
        const pts = [];
        for (const p of s.pts) {
            const lat = Array.isArray(p) ? num(p[0], -90, 90) : null, lng = Array.isArray(p) ? num(p[1], -180, 180) : null;
            if (lat === null || lng === null) return { error: 'One of the polygon points is not a valid position.' };
            pts.push([r6(lat), r6(lng)]);
        }
        return { shape: { type: 'polygon', pts } };
    }
    return { error: 'The zone must be a circle or a polygon.' };
}
function cleanScope(s) {
    const type = s?.type || 'all';
    if (type === 'all') return { scope: { type: 'all' } };
    if (!['cameras', 'groups', 'regions'].includes(type)) return { error: 'Choose all cameras, some cameras, groups or regions.' };
    const ids = [...new Set((Array.isArray(s.ids) ? s.ids : []).map((x) => String(x ?? '').trim().slice(0, 80)).filter(Boolean))];
    if (!ids.length) return { error: 'Pick at least one camera, group or region (or choose all cameras).' };
    if (ids.length > MAX_SCOPE) return { error: `At most ${MAX_SCOPE} entries.` };
    return { scope: { type, ids } };
}
/** A request body -> the fields stored, or { error }. */
function clean(b) {
    const name = String(b?.name ?? '').trim().slice(0, 60);
    if (!name) return { error: 'Give the zone a name.' };
    const kind = KINDS.includes(b?.kind) ? b.kind : 'zone';
    const sh = cleanShape(b?.shape); if (sh.error) return sh;
    const sc = cleanScope(b?.scope); if (sc.error) return sc;
    const days = Array.isArray(b?.days) ? b.days.reduce((m, d) => (Number.isInteger(d) && d >= 0 && d <= 6 ? m | (1 << d) : m), 0) : ALL_DAYS;
    if (!days) return { error: 'Choose at least one day.' };
    const hasFrom = b?.from !== undefined && b?.from !== null && b?.from !== '', hasTo = b?.to !== undefined && b?.to !== null && b?.to !== '';
    const fromMin = hasFrom ? minutesOf(b.from) : null, toMin = hasTo ? minutesOf(b.to) : null;
    if ((hasFrom && fromMin === null) || (hasTo && toMin === null)) return { error: 'Times must look like 08:00.' };
    if (hasFrom !== hasTo) return { error: 'Set both the start and the end time, or neither.' };
    const tz = b?.tz === undefined ? 180 : num(b.tz, -720, 840);
    if (tz === null) return { error: 'Unknown time zone.' };
    const v = { name, kind, shape: sh.shape, scope: sc.scope, days, fromMin, toMin, tz: Math.round(tz), active: b?.active === false ? 0 : 1, severity: b?.severity === 'critical' ? 'critical' : 'warning' };
    if (kind === 'zone') {
        v.onExit = b?.onExit ? 1 : 0; v.onEnter = b?.onEnter ? 1 : 0;
        if (!v.onExit && !v.onEnter) return { error: 'Choose when to alert: when a camera leaves, when it enters, or both.' };
        v.everyMin = null;
    } else {
        v.onExit = 0; v.onEnter = 0;
        const e = num(b?.everyMin, 5, 720);
        if (e === null) return { error: 'A checkpoint must be passed every 5 to 720 minutes.' };
        v.everyMin = Math.round(e);
    }
    return { value: v };
}

const rowToZone = (r) => ({
    id: r.id, companyId: r.company_id ?? null, name: r.name, kind: r.kind, shape: JSON.parse(r.shape), scope: JSON.parse(r.scope),
    onExit: !!r.on_exit, onEnter: !!r.on_enter, severity: r.severity, days: r.days, fromMin: r.from_min, toMin: r.to_min, tz: r.tz,
    everyMin: r.every_min, active: !!r.active, created: r.created, updated: r.updated, createdBy: r.created_by,
});
/** What the dashboard and the apps receive. */
const publicZone = (z, extra = {}) => ({
    id: z.id, companyId: z.companyId, name: z.name, kind: z.kind, shape: z.shape, scope: z.scope, onExit: z.onExit, onEnter: z.onEnter, severity: z.severity,
    days: [0, 1, 2, 3, 4, 5, 6].filter((d) => hasDay(z.days, d)), from: hhmm(z.fromMin), to: hhmm(z.toMin), tz: z.tz, everyMin: z.everyMin, active: z.active,
    created: z.created, updated: z.updated, createdBy: z.createdBy, ...extra,
});
const applies = (z, cam) => {
    if ((z.companyId ?? null) !== (cam.companyId ?? null)) return false;
    const s = z.scope;
    if (s.type === 'all') return true;
    if (s.type === 'cameras') return s.ids.includes(cam.cameraId);
    if (s.type === 'groups') return !!cam.grp && s.ids.includes(cam.grp);
    return !!cam.region && s.ids.includes(cam.region);
};

function create({ db, cams, toCam, audit = () => {}, notify = () => {}, changed = () => {}, now = Date.now, sweepMs = SWEEP_MS }) {
    db.exec(`CREATE TABLE IF NOT EXISTS geofences(
        id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER, name TEXT NOT NULL, kind TEXT NOT NULL, shape TEXT NOT NULL,
        on_exit INTEGER NOT NULL DEFAULT 0, on_enter INTEGER NOT NULL DEFAULT 0, severity TEXT NOT NULL DEFAULT 'warning',
        days INTEGER NOT NULL DEFAULT 127, from_min INTEGER, to_min INTEGER, tz INTEGER NOT NULL DEFAULT 180,
        scope TEXT NOT NULL DEFAULT '{"type":"all"}', every_min INTEGER, active INTEGER NOT NULL DEFAULT 1,
        created INTEGER NOT NULL, updated INTEGER NOT NULL, created_by TEXT)`);
    db.exec('CREATE INDEX IF NOT EXISTS geofences_company ON geofences(company_id)');
    db.exec(`CREATE TABLE IF NOT EXISTS geo_state(zone_id INTEGER NOT NULL, camera_id TEXT NOT NULL, inside INTEGER, seen_in INTEGER NOT NULL DEFAULT 0, last_visit INTEGER,
        PRIMARY KEY(zone_id, camera_id))`);
    db.exec(`CREATE TABLE IF NOT EXISTS alerts(
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, camera_id TEXT NOT NULL, level TEXT NOT NULL, value INTEGER, ts INTEGER NOT NULL,
        ack_by TEXT, ack_ts INTEGER, resolved_ts INTEGER, resolved_by TEXT)`);
    for (const [col, ddl] of [['zone_id', 'INTEGER'], ['zone_name', 'TEXT']]) {
        if (!db.prepare('PRAGMA table_info(alerts)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE alerts ADD COLUMN ${col} ${ddl}`);
    }

    let zones = [];                    // active and inactive, all companies; small
    const byCompany = new Map();       // company id (0 = none) -> zones that are switched on
    const states = new Map();          // `${zone}|${camera}` -> { inside, seenIn, pending, lastVisit, saved }
    const reload = () => {
        zones = db.prepare('SELECT * FROM geofences ORDER BY id').all().map(rowToZone);
        byCompany.clear();
        for (const z of zones) if (z.active) { const k = z.companyId || 0; if (!byCompany.has(k)) byCompany.set(k, []); byCompany.get(k).push(z); }
    };
    reload();
    for (const r of db.prepare('SELECT * FROM geo_state').all()) states.set(`${r.zone_id}|${r.camera_id}`, { inside: r.inside == null ? null : !!r.inside, seenIn: !!r.seen_in, pending: null, lastVisit: r.last_visit || 0, saved: r.last_visit || 0 });

    const shape = (r) => ({ id: r.id, kind: r.kind, cameraId: r.camera_id, level: r.level, value: r.value, ts: r.ts, ack: r.ack_ts != null, zone: r.zone_name || '', zoneId: r.zone_id ?? null });
    const stateOf = (zid, cid) => { const k = `${zid}|${cid}`; let s = states.get(k); if (!s) { s = { inside: null, seenIn: false, pending: null, lastVisit: 0, saved: 0 }; states.set(k, s); } return s; };
    const persist = (zid, cid, s) => {
        db.prepare('INSERT INTO geo_state(zone_id,camera_id,inside,seen_in,last_visit) VALUES(?,?,?,?,?) ON CONFLICT(zone_id,camera_id) DO UPDATE SET inside=excluded.inside, seen_in=excluded.seen_in, last_visit=excluded.last_visit')
            .run(zid, cid, s.inside == null ? null : s.inside ? 1 : 0, s.seenIn ? 1 : 0, s.lastVisit || null);
        s.saved = s.lastVisit;
    };
    const openRow = (kind, zid, cid) => db.prepare('SELECT * FROM alerts WHERE kind = ? AND zone_id = ? AND camera_id = ? AND resolved_ts IS NULL ORDER BY id DESC LIMIT 1').get(kind, zid, cid);

    function raise(kind, z, cam, value = null) {
        if (openRow(kind, z.id, cam.cameraId)) return;
        const r = db.prepare('INSERT INTO alerts(kind,camera_id,level,value,ts,zone_id,zone_name) VALUES(?,?,?,?,?,?,?)').run(kind, cam.cameraId, z.severity, value, now(), z.id, z.name);
        const row = db.prepare('SELECT * FROM alerts WHERE id = ?').get(Number(r.lastInsertRowid));
        audit(kind, cam.cameraId, { zone: z.name, zoneId: z.id, value });
        toCam(cam.cameraId, 'dashboard_alert', shape(row));
        notify(shape(row), cam);
    }
    function resolve(row, by) {
        db.prepare('UPDATE alerts SET resolved_ts = ?, resolved_by = ? WHERE id = ?').run(now(), by, row.id);
        audit(row.kind + '_cleared', row.camera_id, { zone: row.zone_name, by });
        toCam(row.camera_id, 'dashboard_alert_resolved', { id: row.id, cameraId: row.camera_id });
    }
    const resolveWhere = (sql, args, by) => { for (const r of db.prepare(`SELECT * FROM alerts WHERE resolved_ts IS NULL AND kind IN ('geo_exit','geo_enter','checkpoint_missed') AND ${sql}`).all(...args)) resolve(r, by); };

    // the alerts a camera's side of a zone calls for (exit / enter); `active` = the schedule is on
    function reconcile(z, cam, s, active) {
        const wantExit = z.onExit && s.inside === false && s.seenIn, wantEnter = z.onEnter && s.inside === true;
        for (const [kind, want] of [['geo_exit', wantExit], ['geo_enter', wantEnter]]) {
            const open = openRow(kind, z.id, cam.cameraId);
            if (want && active && cam.online && !open) raise(kind, z, cam);
            else if (!want && open) resolve(open, 'back in line');
        }
    }

    const lastFix = new Map();   // camera -> time of the last fix judged
    function position(id, lat, lng, { acc = null, ts = now(), fixTs = null } = {}) {
        const cam = cams.get(id);
        if (!cam || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
        // The camera repeats its last good fix every 10 s as a heartbeat. That is not a new observation: counting it could confirm a change
        // of side from a single real fix. (The camera itself already refuses fixes older than 20 s, so no age check here: camera clocks drift.)
        if (fixTs != null) {
            if (fixTs <= (lastFix.get(id) || 0)) return;
            lastFix.set(id, fixTs);
        }
        const list = byCompany.get(cam.companyId || 0);
        if (!list) return;
        for (const z of list) {
            if (!applies(z, cam)) continue;
            const s = stateOf(z.id, id);
            const ins = isInside(z.shape, lat, lng);
            if (z.kind === 'checkpoint') {
                if (ins && !(acc && edgeDistance(z.shape, lat, lng) < Math.min(acc, 30))) {
                    s.lastVisit = ts;
                    const open = openRow('checkpoint_missed', z.id, id);
                    if (open) resolve(open, 'visited');
                    if (ts - s.saved >= 60000) persist(z.id, id, s);
                }
                continue;
            }
            // a fix closer to the edge than its own accuracy cannot say which side the camera is on
            if (s.inside !== null && acc && edgeDistance(z.shape, lat, lng) < Math.min(acc, 30)) continue;
            if (s.inside === null) {                     // first sight: the starting point, never an alert by itself (except "inside a forbidden area")
                s.inside = ins; s.seenIn = ins; s.pending = null; persist(z.id, id, s);
                reconcile(z, cam, s, activeAt(z, ts));
            } else if (ins === s.inside) {
                s.pending = null;
            } else {
                if (!s.pending || s.pending.v !== ins) s.pending = { v: ins, since: ts, n: 1 }; else s.pending.n++;
                if (ts - s.pending.since >= DEBOUNCE_MS && s.pending.n >= 2) {
                    s.inside = ins; s.pending = null; if (ins) s.seenIn = true;
                    persist(z.id, id, s);
                    reconcile(z, cam, s, activeAt(z, ts));
                }
            }
        }
    }

    /** Cameras the schedule has switched on or off, missed checkpoints, cameras that went onto a dock. Runs by itself every few seconds. */
    function sweep(t = now()) {
        for (const z of zones) {
            if (!z.active) continue;
            const active = activeAt(z, t);
            for (const cam of cams.values()) {
                if (!applies(z, cam)) continue;
                if (cam.posSrc === 'dock') {                      // on a docking station: nothing to judge, and a camera that left earlier is not "missing" any more
                    const s = states.get(`${z.id}|${cam.cameraId}`);
                    if (s && (s.inside !== null || s.pending)) { s.inside = null; s.seenIn = false; s.pending = null; persist(z.id, cam.cameraId, s); }
                    resolveWhere('zone_id = ? AND camera_id = ?', [z.id, cam.cameraId], 'docked');
                    continue;
                }
                const s = stateOf(z.id, cam.cameraId);
                if (z.kind === 'zone') { reconcile(z, cam, s, active); continue; }
                const open = openRow('checkpoint_missed', z.id, cam.cameraId);
                if (!active) { if (open) resolve(open, 'schedule ended'); continue; }
                if (!cam.online || open) continue;
                const armed = Math.max(s.lastVisit || 0, windowStart(z, t), cam.onlineSince || 0, z.updated);
                const late = t - (armed + z.everyMin * 60000);
                if (late > GRACE_MS) raise('checkpoint_missed', z, cam, Math.round((t - armed) / 60000));
            }
        }
    }
    const timer = sweepMs > 0 ? setInterval(() => { try { sweep(); } catch (e) { console.warn('geofence sweep failed:', e.message); } }, sweepMs) : null;
    timer?.unref?.();

    function dropState(zid) {
        for (const k of [...states.keys()]) if (k.startsWith(zid + '|')) states.delete(k);
        db.prepare('DELETE FROM geo_state WHERE zone_id = ?').run(zid);
    }
    const countFor = (companyId) => db.prepare('SELECT COUNT(*) n FROM geofences WHERE company_id IS ?').get(companyId ?? null).n;

    return {
        DEBOUNCE_MS, position, sweep,
        /** Zones a user may see: their company's (Smart Way staff: all, or one company). */
        list({ staff, companyId, only }) {
            return zones.filter((z) => (staff ? (only === undefined ? true : (z.companyId ?? null) === only) : z.companyId === companyId)).map((z) => publicZone(z));
        },
        get: (id) => zones.find((z) => z.id === Number(id)) || null,
        add(body, { username, companyId }) {
            const c = clean(body); if (c.error) return c;
            if (countFor(companyId) >= MAX_ZONES) return { error: `A company can have at most ${MAX_ZONES} zones.` };
            const v = c.value, t = now();
            const r = db.prepare(`INSERT INTO geofences(company_id,name,kind,shape,on_exit,on_enter,severity,days,from_min,to_min,tz,scope,every_min,active,created,updated,created_by)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(companyId ?? null, v.name, v.kind, JSON.stringify(v.shape), v.onExit, v.onEnter, v.severity, v.days, v.fromMin, v.toMin, v.tz, JSON.stringify(v.scope), v.everyMin, v.active, t, t, username);
            reload();
            audit('geofence_created', null, { name: v.name, kind: v.kind, by: username });
            changed(companyId ?? null);
            return { zone: publicZone(this.get(Number(r.lastInsertRowid))) };
        },
        update(id, body, { username }) {
            const old = this.get(id); if (!old) return { error: 'Zone not found.', status: 404 };
            const c = clean({ ...publicZone(old), ...body }); if (c.error) return c;
            const v = c.value;
            db.prepare(`UPDATE geofences SET name=?,kind=?,shape=?,on_exit=?,on_enter=?,severity=?,days=?,from_min=?,to_min=?,tz=?,scope=?,every_min=?,active=?,updated=? WHERE id=?`)
                .run(v.name, v.kind, JSON.stringify(v.shape), v.onExit, v.onEnter, v.severity, v.days, v.fromMin, v.toMin, v.tz, JSON.stringify(v.scope), v.everyMin, v.active, now(), old.id);
            // a different shape, rule or audience: whatever was open or remembered about it no longer applies
            resolveWhere('zone_id = ?', [old.id], 'zone changed'); dropState(old.id);
            reload();
            audit('geofence_edited', null, { name: v.name, id: old.id, by: username });
            changed(old.companyId);
            return { zone: publicZone(this.get(old.id)) };
        },
        remove(id, { username }) {
            const old = this.get(id); if (!old) return { error: 'Zone not found.', status: 404 };
            resolveWhere('zone_id = ?', [old.id], 'zone removed'); dropState(old.id);
            db.prepare('DELETE FROM geofences WHERE id = ?').run(old.id);
            reload();
            audit('geofence_removed', null, { name: old.name, id: old.id, by: username });
            changed(old.companyId);
            return { ok: true };
        },
        /** Why a zone does or does not alert, camera by camera: the question "it went outside and nothing happened" answered with facts. */
        status(id, canSee) {
            const z = this.get(id); if (!z) return null;
            const t = now(), rows = [];
            for (const cam of cams.values()) {
                if (!applies(z, cam) || !canSee(cam.cameraId)) continue;
                const s = states.get(`${z.id}|${cam.cameraId}`) || { inside: null, seenIn: false };
                const age = cam.fixTs ? t - cam.fixTs : null, open = ALERT_KINDS.some((k) => openRow(k, z.id, cam.cameraId));
                let why, state = s.inside == null ? 'unknown' : s.inside ? 'inside' : 'outside';
                if (!z.active) why = 'zone_off';
                else if (cam.posSrc === 'dock') why = 'on_dock';
                else if (age == null || age > 120000) why = 'no_gps';
                else if (!cam.online) why = 'offline';
                else if (z.kind === 'checkpoint') why = s.lastVisit ? 'visited' : 'not_visited';
                else if (s.inside == null) why = 'waiting';
                else if (s.inside === false && z.onExit && !s.seenIn) why = 'never_inside';
                else if (!activeAt(z, t)) why = 'schedule_off';
                else why = 'watching';
                rows.push({ cameraId: cam.cameraId, name: cam.name || cam.cameraId, state, why, ageSec: age == null ? null : Math.round(age / 1000), alert: open, lastVisit: s.lastVisit || null });
            }
            return { zoneId: z.id, name: z.name, companyId: z.companyId, cameras: rows.sort((x, y) => x.name.localeCompare(y.name)) };
        },
        /** Past geofence alerts (open and closed) the caller may see, newest first. */
        history(canSee, { days = 7, limit = 200 } = {}) {
            const since = now() - Math.min(90, Math.max(1, days)) * 86400000;
            return db.prepare("SELECT * FROM alerts WHERE kind IN ('geo_exit','geo_enter','checkpoint_missed') AND ts > ? ORDER BY ts DESC LIMIT 1000").all(since)
                .filter((r) => cams.has(r.camera_id) && canSee(r.camera_id)).slice(0, limit)
                .map((r) => ({ ...shape(r), resolvedTs: r.resolved_ts || null, resolvedBy: r.resolved_by || null, ackBy: r.ack_by || null }));
        },
        /** The camera was removed from the fleet. */
        forget(id) {
            resolveWhere('camera_id = ?', [id], 'removed');
            for (const k of [...states.keys()]) if (k.endsWith('|' + id)) states.delete(k);
            lastFix.delete(id);
            db.prepare('DELETE FROM geo_state WHERE camera_id = ?').run(id);
        },
        stop() { if (timer) clearInterval(timer); },
    };
}

module.exports = { create, clean, cleanShape, cleanScope, isInside, edgeDistance, distance, pointInPolygon, activeAt, windowStart, applies, publicZone, minutesOf, hhmm, ALERT_KINDS, DEBOUNCE_MS, GRACE_MS, ALL_DAYS };
