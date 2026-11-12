// Automatic camera updates over the network, for cameras that are not near a docking station ("remote" cameras).
//
// The super administrator sets, per camera, how it may be updated: off (only on a docking station), wifi (over Wi-Fi only) or any (Wi-Fi or SIM).
// When a new build is published the server pushes it to every camera that allows it, with care, because a remote camera that gets a broken build
// has no dock to be rescued on:
//   * proving   the first camera is the canary. Nothing else is sent until a camera has run the new build, online, for a few minutes
//               (a camera updated on a docking station counts as proof too).
//   * rolling   the rest follow, a few at a time, so the server's uplink is not flooded.
//   * halted    the canary failed to install or never came back, or two cameras refused the build: nothing more is sent until an administrator
//               looks and presses "Resume" (or publishes a new build).
// A camera is only asked when it is online, not recording or live, not sitting on a dock (the dock does it in seconds), has enough battery, and (for
// Wi-Fi only) runs a camera app that can keep to Wi-Fi. A failed download is retried later with growing pauses; an install that is refused is not.
// Everything is injected (clock, camera list, sender), so test/rollout.test.js runs it without a server.

const DEFAULTS = {
    proveMs: Number(process.env.ROLLOUT_PROVE_MS) || 5 * 60_000,         // the new build must have run this long, online, on a camera
    canaryMs: Number(process.env.ROLLOUT_CANARY_MS) || 30 * 60_000,      // the canary must be back on the new build within this time
    parallel: Number(process.env.ROLLOUT_PARALLEL) || 3,                 // cameras downloading at the same time
    minBattery: Number(process.env.ROLLOUT_MIN_BATTERY) || 30,           // percent, unless the camera is charging
    busyMs: 30 * 60_000,                                                 // an update older than this that never finished is not "in progress" any more
    backoffMs: [10, 30, 120, 360].map((m) => m * 60_000),                // pause after the 1st, 2nd, 3rd, 4th failed download; the 5th attempt is the last
};
const BUSY = ['queued', 'downloading', 'installing', 'waiting', 'waiting_wifi', 'waiting_battery'];
const MODES = ['off', 'wifi', 'any'];
// A failed download is the network's fault (retry later); anything else is the build or the phone refusing it.
const isNetworkFailure = (e) => /socket|timeout|timed out|connection|network|host|http|download|handshake|certificate|reset|closed|dns|resolve|checksum/i.test(String(e || ''));

function create({ db, cams, latest, send, docked = () => new Map(), audit = () => {}, now = Date.now, config = {} }) {
    const cfg = { ...DEFAULTS, ...config };
    db.exec('CREATE TABLE IF NOT EXISTS update_rollout(build TEXT PRIMARY KEY, state TEXT NOT NULL, canary TEXT, started INTEGER NOT NULL, canary_ts INTEGER, note TEXT, by TEXT)');
    const tries = new Map();      // camera -> { build, n, next }: how often this camera was asked for this build, and when it may be asked again
    const refused = new Map();    // build -> Set of cameras whose install was refused

    const row = (build) => db.prepare('SELECT * FROM update_rollout WHERE build = ?').get(build);
    function ensure(m, t) {
        let r = row(m.build);
        if (!r) { db.prepare("INSERT INTO update_rollout(build,state,started) VALUES(?,?,?)").run(m.build, 'proving', t); r = row(m.build); }
        return r;
    }
    const set = (build, patch) => {
        for (const [k, v] of Object.entries(patch)) db.prepare(`UPDATE update_rollout SET ${k} = ? WHERE build = ?`).run(v, build);
    };
    const short = (b) => String(b).slice(0, 12);

    const managed = (c) => c.updateMode === 'wifi' || c.updateMode === 'any';
    const busy = (c, t) => !!(c.update && BUSY.includes(c.update.state) && t - (c.update.ts || 0) < cfg.busyMs);
    const inflight = (m, t) => { let n = 0; for (const c of cams.values()) if (managed(c) && c.appBuild !== m.build && busy(c, t)) n++; return n; };

    // Why this camera is (not) being updated right now: null = it may be asked, otherwise a code the screen turns into words.
    function why(c, m, t, dockedNow) {
        if (!managed(c)) return 'dock';
        if (!c.appBuild) return 'unknown';
        if (c.appBuild === m.build) return 'current';
        if (!c.online) return 'offline';
        if (c.recording || c.remote) return 'recording';
        if (dockedNow.has(c.cameraId)) return 'docked';
        if (c.updateMode === 'wifi' && !(Array.isArray(c.caps) && c.caps.includes('update-net'))) return 'needs-app';
        if (typeof c.battery === 'number' && c.battery < cfg.minBattery && !c.charging) return 'battery';
        if (refused.get(m.build)?.has(c.cameraId)) return 'refused';
        if (busy(c, t)) return 'busy';
        const k = tries.get(c.cameraId);
        if (k && k.build === m.build) { if (k.n > cfg.backoffMs.length) return 'gave-up'; if (t < k.next) return 'retry-later'; }
        return null;
    }

    function ask(c, m, t) {
        const k = tries.get(c.cameraId);
        const n = (k && k.build === m.build ? k.n : 0) + 1;
        tries.set(c.cameraId, { build: m.build, n, next: t + cfg.backoffMs[Math.min(n - 1, cfg.backoffMs.length - 1)] });
        send(c.cameraId, { build: m.build, size: m.size, force: false, auto: true, net: c.updateMode });
        audit('system', `update_auto_${short(m.build)}`, c.cameraId, { mode: c.updateMode, attempt: n });
    }

    function halt(m, note, by = 'system') {
        set(m.build, { state: 'halted', note: String(note).slice(0, 200), by });
        audit(by, `update_halted_${short(m.build)}`, null, { note });
    }

    // The new build runs: some camera has been online with it long enough.
    function proof(m, t) {
        for (const c of cams.values()) {
            if (c.online && c.appBuild === m.build && t - Math.max(c.buildTs || 0, c.onlineSince || 0) >= cfg.proveMs) return c.cameraId;
        }
        return null;
    }

    // ctx = what one pass knows: the build, the clock, the docks and how many downloads are already running
    function consider(c, ctx) {
        const { m, t } = ctx, r = row(m.build);
        if (r.state === 'halted' || why(c, m, t, ctx.dockedNow) !== null) return;
        if (r.state === 'proving') {
            if (r.canary) return;
            ask(c, m, t); ctx.flight++;
            set(m.build, { canary: c.cameraId, canary_ts: t });
            return;
        }
        if (ctx.flight >= cfg.parallel) return;
        ask(c, m, t); ctx.flight++;
    }

    function run(t, only) {
        const m = latest();
        if (!m) return;
        let r = ensure(m, t);
        if (r.state === 'halted') return;
        if (r.state === 'proving' && !only) {
            const by = proof(m, t);
            if (by) { set(m.build, { state: 'rolling', note: `proved by ${by}` }); audit('system', `update_rolling_${short(m.build)}`, by); }
            else if (r.canary && t - (r.canary_ts || t) > cfg.canaryMs) {
                const c = cams.get(r.canary);
                if (!c || c.appBuild !== m.build) {
                    // It got as far as installing and never came back: the new build may be broken. If it never got that far (offline, slow link)
                    // the network is to blame, not the build: another camera takes the lead.
                    if (c && c.update && c.update.state === 'installing') { halt(m, `The first camera (${r.canary}) installed the new build and did not come back within ${Math.round(cfg.canaryMs / 60000)} minutes.`); return; }
                    set(m.build, { canary: null, canary_ts: null });
                }
            }
        }
        const ctx = { m, t, dockedNow: docked(t), flight: inflight(m, t) };
        if (only) { const c = cams.get(only); if (c) consider(c, ctx); return; }
        const list = [...cams.values()].filter(managed).sort((a, b) => (Number(b.battery || 0) - Number(a.battery || 0)) || String(a.cameraId).localeCompare(String(b.cameraId)));
        for (const c of list) consider(c, ctx);
    }

    return {
        MODES,
        isMode: (v) => MODES.includes(v),
        // a new build was uploaded
        publish(m, t = now()) { ensure(m, t); run(t); },
        // every 30 s: advance the rollout, time out a canary that never came back
        tick(t = now()) { run(t); },
        // a camera connected or reported its build: ask it at once when it is its turn (cheap: looks at this camera only)
        seen(id, t = now()) { run(t, id); },
        // progress reports of a camera's update
        progress(id, state, error, t = now()) {
            const m = latest(); const c = cams.get(id);
            if (!m || !c || state !== 'failed') return;
            const r = ensure(m, t);
            const k = tries.get(id);
            if (isNetworkFailure(error)) {
                if (r.canary === id) set(m.build, { canary: null, canary_ts: null });   // another camera may take the lead
                if (k) k.next = t + cfg.backoffMs[Math.min(k.n - 1, cfg.backoffMs.length - 1)];
                return;
            }
            if (k) k.n = cfg.backoffMs.length + 1;   // the phone refused the build: do not ask this camera again
            const set_ = refused.get(m.build) || new Set(); set_.add(id); refused.set(m.build, set_);
            if (r.state !== 'halted' && (r.canary === id || set_.size >= 2)) halt(m, `${id} refused the new build (${String(error || 'install failed').slice(0, 100)}).`);
        },
        halt(by, note = 'Paused by an administrator.') { const m = latest(); if (!m) return false; ensure(m, now()); halt(m, note, by); return true; },
        resume(by) {
            const m = latest(); if (!m) return false;
            ensure(m, now());
            set(m.build, { state: 'rolling', note: `resumed by ${by}`, by });
            for (const [id, k] of tries) if (k.build === m.build) tries.delete(id);
            audit(by, `update_resumed_${short(m.build)}`, null);
            return true;
        },
        why: (c, t = now()) => { const m = latest(); return m ? why(c, m, t, docked(t)) : null; },
        // what the administrator sees
        status(t = now()) {
            const m = latest();
            if (!m) return null;
            const r = ensure(m, t), dockedNow = docked(t);
            const out = { build: m.build, short: short(m.build), state: r.state, canary: r.canary || null, note: r.note || null, started: r.started, remote: 0, current: 0, updating: 0, waiting: 0, failed: 0 };
            for (const c of cams.values()) {
                if (!managed(c)) continue;
                out.remote++;
                const w = why(c, m, t, dockedNow);
                if (w === 'current') out.current++;
                else if (c.update && c.update.state === 'failed' && c.appBuild !== m.build) out.failed++;
                else if (busy(c, t) && c.appBuild !== m.build) out.updating++;
                else out.waiting++;
            }
            return out;
        },
    };
}

module.exports = { create, MODES, BUSY, isNetworkFailure, DEFAULTS };
