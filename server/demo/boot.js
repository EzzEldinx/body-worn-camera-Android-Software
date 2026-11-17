'use strict';
// Demo mode, step one. server.js requires this file FIRST, before anything reads the environment or opens the database.
//
//   DEMO_MODE=1 makes the process a public demo: it runs on generated sample data only and holds nothing real. This file makes that true BEFORE the rest starts:
//     1. every secret and integration the real system uses is removed from the environment; the secrets the server still needs are replaced by random
//        values made right now and known to nobody (the simulator that drives the sample cameras gets them from here, in memory);
//     2. the data folder is inspected. A folder that holds a real database (any user, camera, company, alarm or audit line without our marker) or
//        any file that is not ours makes the process REFUSE TO START and touch nothing. Only a folder that a demo made, or an empty one, is wiped and made new:
//        the demo's data is regenerated on every start, which is also how it "resets";
//     3. a new database holding only our marker is created, so a crash half way through never leaves something the next start would mistake for real data.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
const ON = truthy(process.env.DEMO_MODE);
const state = { ON, secrets: null, dataDir: null, refused: null };

// Everything below is removed from the environment of a demo. (A demo is started with a clean environment anyway; this is the second lock.)
const SCRUB = [
    'BWC_TOKEN', 'DOCK_TOKEN', 'STREAM_SECRET', 'ADMIN_PASSWORD', 'ALLOW_SHARED_TOKEN',
    'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SUPPORT_EMAIL',
    'FCM_SERVICE_ACCOUNT', 'GOOGLE_APPLICATION_CREDENTIALS', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
    'LICENSE_MODE', 'LICENSE_NOTIFY', 'LICENSE_PUBKEY_FILE', 'LICENSE_TRIAL_DAYS', 'LICENSE_TRIAL_CAMERAS',
    'PUBLIC_URL', 'DEMO_URL', 'RECORDINGS_RETENTION_DAYS', 'MAINTENANCE', 'MIN_APP_VERSION',
];
// What a demo data folder may hold. Anything else means this is somebody's real folder.
const OURS = new Set(['bwc.db', 'bwc.db-wal', 'bwc.db-shm', 'bwc.db-journal', 'demo', 'recordings', 'updates', 'lost+found']);
const MARKER = 'demo_marker';

function refuse(why) {
    state.refused = why;
    console.error(`\nDEMO_MODE refused to start: ${why}\nNothing was changed. A demo needs its own empty data folder (set DATA_DIR to a new volume).\n`);
    process.exit(78);
}

function guardDataFolder(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const entries = fs.readdirSync(dir);
    const strange = entries.filter((e) => !OURS.has(e));
    if (strange.length) refuse(`the data folder ${dir} holds files that are not a demo's (${strange.slice(0, 5).join(', ')}).`);
    const file = path.join(dir, 'bwc.db');
    let isDemo = false;
    if (fs.existsSync(file)) {
        const { DatabaseSync } = require('node:sqlite');
        let probe;
        try { probe = new DatabaseSync(file, { readOnly: true }); } catch (e) { return refuse(`the database in ${dir} cannot be inspected (${e.message}).`); }
        try {
            const has = (t) => !!probe.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
            isDemo = has(MARKER);
            if (!isDemo) {
                for (const t of ['users', 'cameras', 'companies', 'alarms', 'audit', 'assignments', 'recordings', 'dock_files', 'tickets']) {
                    if (has(t) && probe.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n > 0) return refuse(`the database in ${dir} holds real data (${t}) and is not a demo's.`);
                }
            }
        } catch (e) { return refuse(`the database in ${dir} cannot be inspected (${e.message}).`); } finally { try { probe.close(); } catch { /* ignore */ } }
    }
    // The recordings folder of a demo is empty (the demo never stores a recording); a folder with files in it is not ours to delete.
    const rec = path.join(dir, 'recordings');
    if (fs.existsSync(rec) && !isDemo && fs.readdirSync(rec).length) refuse(`${rec} holds recordings.`);
    for (const f of ['bwc.db', 'bwc.db-wal', 'bwc.db-shm', 'bwc.db-journal']) fs.rmSync(path.join(dir, f), { force: true });
    if (isDemo) for (const d of ['recordings', 'updates']) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
    // a new database that says "this is a demo" from its very first moment
    const { DatabaseSync } = require('node:sqlite');
    const fresh = new DatabaseSync(file);
    fresh.exec(`CREATE TABLE ${MARKER}(created INTEGER NOT NULL, version INTEGER NOT NULL)`);
    fresh.prepare(`INSERT INTO ${MARKER}(created, version) VALUES(?, 1)`).run(Date.now());
    fresh.close();
}

if (ON) {
    for (const k of SCRUB) delete process.env[k];
    const rnd = () => crypto.randomBytes(24).toString('hex');
    state.secrets = { camera: rnd(), dock: rnd(), stream: rnd(), admin: rnd() };
    process.env.BWC_TOKEN = state.secrets.camera;       // the old shared camera token is a random value nobody has, and per-camera tokens are the only way in
    process.env.ALLOW_SHARED_TOKEN = 'false';
    process.env.DOCK_TOKEN = state.secrets.dock;        // only the simulated dock agent knows it
    process.env.STREAM_SECRET = state.secrets.stream;
    process.env.ADMIN_PASSWORD = state.secrets.admin;   // the demo has no administrator account at all (seed.js makes users first), this is only a seat-filler
    process.env.SUPPORT_EMAIL = 'support@visionguard-demo.example';
    process.env.LICENSE_MODE = 'off';
    process.env.POSITIONS_DAYS = '60';
    process.env.RECORDINGS_RETENTION_DAYS = '0';
    state.dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
    guardDataFolder(state.dataDir);
}

module.exports = state;
module.exports.truthy = truthy;
module.exports.MARKER = MARKER;
