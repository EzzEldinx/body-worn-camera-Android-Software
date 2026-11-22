// Battery readings and low-battery alerts.
//   Cameras report their own battery (camera_status / camera_battery / camera_gps_update) and docks report the battery of every docked camera,
//   so a camera shows its battery wherever it is. Below LOW (default 20 %) while NOT charging an alert is raised on every dashboard and in the app;
//   below CRITICAL (default 10 %) it becomes critical. It clears by itself once the camera is charging or back above LOW + 5 % (no flapping around 20 %).
const LOW = Number(process.env.BATTERY_LOW) || 20;
const CRITICAL = Number(process.env.BATTERY_CRITICAL) || 10;
const CLEAR = LOW + 5;
const SAVE_EVERY = 5 * 60000;

// a real number from 0 to 100 only: null, a string or a fraction is not a reading (Number(null) would be 0 % and raise a critical alert)
const pct = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? Math.round(v) : null);
/** A camera that needs attention: low and not on a charger. */
const isLow = (c) => c && c.battery != null && c.battery < LOW && !c.charging;
const levelOf = (battery) => (battery < CRITICAL ? 'critical' : 'warning');

function create({ db, cams, publish, toCam, audit = () => {}, notify = () => {}, now = Date.now }) {
    db.exec(`CREATE TABLE IF NOT EXISTS alerts(
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, camera_id TEXT NOT NULL, level TEXT NOT NULL, value INTEGER, ts INTEGER NOT NULL,
        ack_by TEXT, ack_ts INTEGER, resolved_ts INTEGER, resolved_by TEXT)`);
    db.exec('CREATE INDEX IF NOT EXISTS alerts_open ON alerts(kind, camera_id, resolved_ts)');
    const saved = new Map();   // camera -> { battery, ts } last written to the database

    const shape = (r) => ({ id: r.id, kind: r.kind, cameraId: r.camera_id, level: r.level, value: r.value, ts: r.ts, ack: r.ack_ts != null, ...(r.zone_name ? { zone: r.zone_name, zoneId: r.zone_id } : {}) });
    const openRow = (id) => db.prepare("SELECT * FROM alerts WHERE kind = 'low_battery' AND camera_id = ? AND resolved_ts IS NULL ORDER BY id DESC LIMIT 1").get(id);

    function persist(id, patch) {
        const prev = saved.get(id);
        if (prev && prev.battery === patch.battery && patch.ts - prev.ts < SAVE_EVERY) return;
        db.prepare('UPDATE cameras SET battery = ?, battery_ts = ?, charging = ? WHERE id = ?').run(patch.battery, patch.ts, patch.charging ? 1 : 0, id);
        saved.set(id, { battery: patch.battery, ts: patch.ts });
    }

    function resolve(row, by) {
        db.prepare('UPDATE alerts SET resolved_ts = ?, resolved_by = ? WHERE id = ?').run(now(), by, row.id);
        audit('battery_recovered', row.camera_id, { was: row.value, by });
        toCam(row.camera_id, 'dashboard_alert_resolved', { id: row.id, cameraId: row.camera_id });
    }

    function evaluate(id, c) {
        const open = openRow(id);
        if (isLow(c)) {
            const level = levelOf(c.battery);
            if (!open) {
                const r = db.prepare('INSERT INTO alerts(kind,camera_id,level,value,ts) VALUES(?,?,?,?,?)').run('low_battery', id, level, c.battery, now());
                const row = db.prepare('SELECT * FROM alerts WHERE id = ?').get(Number(r.lastInsertRowid));
                audit('battery_low', id, { battery: c.battery, level });
                toCam(id, 'dashboard_alert', shape(row));
                notify(shape(row), c);
            } else if (open.level === 'warning' && level === 'critical') {   // got worse: raise it again, even if someone had acknowledged it
                db.prepare('UPDATE alerts SET level = ?, value = ?, ack_by = NULL, ack_ts = NULL WHERE id = ?').run(level, c.battery, open.id);
                const row = db.prepare('SELECT * FROM alerts WHERE id = ?').get(open.id);
                audit('battery_critical', id, { battery: c.battery });
                toCam(id, 'dashboard_alert', shape(row));
                notify(shape(row), c);
            } else if (open.value !== c.battery) db.prepare('UPDATE alerts SET value = ? WHERE id = ?').run(c.battery, open.id);
        } else if (open && (c.charging || (c.battery != null && c.battery >= CLEAR))) resolve(open, c.charging ? 'charging' : 'recovered');
    }

    return {
        LOW, CRITICAL,
        /** A battery reading from a camera ('camera'), or from the dock it sits on ('dock': it is charging by definition). */
        set(id, { battery, charging, src = 'camera', ts = now() }) {
            const b = pct(battery);
            if (b === null || !cams.has(id)) return false;
            const ch = src === 'dock' ? true : typeof charging === 'boolean' ? charging : false;
            const cur = cams.get(id);
            // the dock repeats every camera's battery every couple of seconds: nothing new, nothing to send to every dashboard
            if (cur && cur.battery === b && cur.batterySrc === src && !!cur.charging === ch && ts - (cur.batteryTs || 0) < 30000) return true;
            const patch = { battery: b, batteryTs: ts, batterySrc: src, charging: ch };
            publish(id, src === 'camera' ? { ...patch, online: true } : patch);
            persist(id, { battery: b, ts, charging: ch });
            evaluate(id, cams.get(id));
            return true;
        },
        /** Alerts still open that the given user may see (canSee decides). */
        open(canSee) {
            return db.prepare("SELECT * FROM alerts WHERE resolved_ts IS NULL ORDER BY ts DESC LIMIT 200").all().filter((r) => cams.has(r.camera_id) && canSee(r.camera_id)).map(shape);
        },
        ack(alertId, username, canSee) {
            const r = db.prepare('SELECT * FROM alerts WHERE id = ? AND resolved_ts IS NULL').get(Number(alertId));
            if (!r || !canSee(r.camera_id) || r.ack_ts) return false;
            db.prepare('UPDATE alerts SET ack_by = ?, ack_ts = ? WHERE id = ?').run(username, now(), r.id);
            toCam(r.camera_id, 'dashboard_alert', shape({ ...r, ack_ts: now() }));
            return true;
        },
        /** The camera was removed from the fleet: its open alert goes with it. */
        forget(id) { const o = openRow(id); if (o) resolve(o, 'removed'); saved.delete(id); },
        isLow,
    };
}

module.exports = { create, isLow, levelOf, pct, LOW, CRITICAL, CLEAR };
