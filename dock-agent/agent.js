#!/usr/bin/env node
// VisionGuard Dock Agent: runs on the PC next to the docking station.
// For every camera visible over USB (adb) it COPIES new recordings to this PC's own storage (DOCK_STORAGE, default ~/VisionGuard-Dock),
// verified by SHA-256, and tells the server. The user then chooses on the dashboard (Docking > Files) for each file or in bulk:
// "Push to cloud" (the agent uploads it from the PC, verified again by the server) or "Keep on dock storage". The server policy can also
// decide automatically: Ask me / Automatic · Cloud / Automatic · Dock storage. With --delete a file is removed from the camera only after
// it is safe where the user wanted it. DOCK_PURGE_UPLOADED=1 frees the PC's copy once a file is verified in the cloud.
//
//   DOCK_SERVER=https://visionguard.example.com DOCK_TOKEN=... node agent.js [--once] [--delete] [--report-only] [--dry-run] [--interval 30] [--only VID_x.mp4] [--limit N] [--smallest] [--latest N] [--since today|YYYY-MM-DD] [--report-only] [--no-update] [--update-only] [--no-screen]
//
// Camera app updates: the moment a camera is docked (and then every cycle) the agent compares the app installed on it with the latest build
// published on the server (Dashboard > Updates) and installs the new one over USB when the camera is not recording and is either powered by
// the dock or has >= 20% battery. This comes BEFORE copying recordings: an update takes seconds, copying can take minutes. A camera signed
// with an older key cannot be updated this way: it is flagged "needs migration" and left untouched.
//
// On the camera's own screen: while the agent works on a camera (connected, updating, uploading, done, needs attention) it writes a small
// status file into the camera app's folder and the camera app shows it as a full-screen window (see screen.js). --no-screen turns this off.
//
// Requires: Node 22+, adb in PATH (or ADB=/path/to/adb).
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const screenFile = require('./screen');

const ARGV = process.argv.slice(2);
const flag = (n) => ARGV.includes(`--${n}`);
const opt = (n, d) => { const i = ARGV.indexOf(`--${n}`); return i >= 0 ? ARGV[i + 1] : d; };
const SERVER = (process.env.DOCK_SERVER || 'http://localhost:3000').replace(/\/$/, '');
const TOKEN = process.env.DOCK_TOKEN || '';
const DOCK_ID = process.env.DOCK_ID || os.hostname().replace(/[^\w.-]/g, '').slice(0, 30) || 'dock';
const ADB = process.env.ADB || 'adb';
const APP_DIR = '/sdcard/Android/data/com.swg.swg_bwc/files';
const REC_DIR = `${APP_DIR}/SWG_BWC`;
const STAGING = process.env.DOCK_STAGING || path.join(os.tmpdir(), 'visionguard-dock');
const DELETE = flag('delete');
const REPORT_ONLY = flag('report-only');   // show the docks on the dashboard but copy/upload nothing (no files are touched)
const LIMIT = Number(opt('limit', 0)) || 0;   // offload at most N files per camera and cycle (handy for a first test)
const SMALLEST = flag('smallest');             // take the smallest files first
const LATEST = Number(opt('latest', 0)) || 0;  // only the newest N files per camera
const SINCE_RAW = opt('since', null);          // 'today' or YYYY-MM-DD: ignore everything recorded before that day
const SINCE = SINCE_RAW === 'today' ? new Date(new Date().setHours(0, 0, 0, 0)).getTime() : SINCE_RAW ? new Date(SINCE_RAW + 'T00:00:00').getTime() : 0;
// Where this dock stands (decimal degrees), e.g. DOCK_LOCATION=24.65997,46.71219 or --location 24.65997,46.71219.
// Cameras on the dock are indoors with no GPS fix; the server then shows them at this spot ("at the docking station").
const LOC_RAW = opt('location', process.env.DOCK_LOCATION || '');
const LOC = (() => { const m = String(LOC_RAW).split(',').map((x) => Number(x.trim())); return m.length >= 2 && m.every(Number.isFinite) && Math.abs(m[0]) <= 90 && Math.abs(m[1]) <= 180 ? { lat: m[0], lng: m[1], acc: m[2] || 25 } : null; })();
const NO_UPDATE = flag('no-update');          // do NOT update the camera app from the dock (default: update outdated cameras)
const UPDATE_ONLY = flag('update-only');      // only update the camera app, copy no recordings (tests / first rollout)
const NO_SCREEN = flag('no-screen');          // do NOT show the "updating / uploading" window on the camera's own screen
const MIN_BATTERY = Number(process.env.DOCK_UPDATE_MIN_BATTERY) || 20;   // a camera that is NOT powered by the dock needs this much battery to be updated
const DRY = flag('dry-run');                   // list what would be offloaded, touch nothing
const ONLY = opt('only', null);
if ((ARGV.includes('--only') && !ONLY) || (SINCE_RAW && !Number.isFinite(SINCE)) || (ARGV.includes('--since') && !SINCE_RAW)) { console.error('Bad --only / --since value: refusing to run without a filter.'); process.exit(2); }  // restrict to one file name (useful for tests)
const MIN_AGE_MS = 60_000; // never touch a file that changed in the last minute (still being recorded)
const NAME_RE = /^(VID|IMG)_\d{6,16}\.(mp4|jpg)$/;

// What the agent is doing per camera right now; sent to the server so the Docking page shows live progress.
const status = new Map();   // serial -> { state, message, progress, synced, failed, lastSyncTs }
let lastInfos = [], lastReportAt = 0;
const screens = screenFile.create();   // what each docked camera's own screen says (screen.js)
const checks = new Map();              // serial -> 'current' | 'other': the app has been checked since this camera was docked
const pulling = new Map();             // serial -> the .part file being copied right now (its size moves the progress bar)
const screenSent = new Map();          // serial -> { key, at }: what the camera's screen file says and when it was last written
const AGENT_VERSION = '1.6';
const log = (dev, ...a) => console.log(new Date().toISOString().slice(11, 19), dev ? `[${dev}]` : '', ...a);
const run = (args, opts = {}) => new Promise((resolve, reject) => execFile(ADB, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (e, so, se) => (e ? reject(new Error((se || e.message).trim())) : resolve(so))));
const shell = (serial, cmd, timeout) => run(['-s', serial, 'shell', cmd], timeout ? { timeout } : {});
const hashFile = (f) => new Promise((res, rej) => { const h = crypto.createHash('sha256'); fs.createReadStream(f).on('data', (c) => h.update(c)).on('end', () => res(h.digest('hex'))).on('error', rej); });

async function api(method, p, { body, headers } = {}) {
    const r = await fetch(SERVER + p, { method, headers: { 'x-dock-token': TOKEN, ...(body && !(body instanceof fs.ReadStream) ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body instanceof fs.ReadStream ? body : body ? JSON.stringify(body) : undefined, ...(body instanceof fs.ReadStream ? { duplex: 'half' } : {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${j.error || ''}`);
    return j;
}

async function devices() {
    const out = await run(['devices', '-l']);
    return out.split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((p) => p[1] === 'device')
        .map((p) => ({ serial: p[0], port: (p.find((x) => x.startsWith('usb:')) || '').slice(4) || p[0] }));   // usb:<location> = the physical dock port
}

async function inspect(serial) {
    let cameraId = null;
    try { cameraId = JSON.parse(await shell(serial, `cat ${APP_DIR}/config.json`)).id || null; } catch { /* not configured */ }
    const bat = await shell(serial, 'dumpsys battery | grep -E "level|powered"');
    const battery = Number((/level:\s*(\d+)/.exec(bat) || [])[1]) || null;
    const powered = /(AC|USB|Wireless) powered: true/.test(bat);   // on the dock the camera is powered: an update cannot be cut short by a flat battery
    const df = (await shell(serial, 'df -k /sdcard | tail -1')).trim().split(/\s+/);
    const storageFreeMb = Math.round(Number(df[3]) / 1024) || null;
    const listing = await shell(serial, `cd ${REC_DIR} 2>/dev/null && for f in *; do [ -f "$f" ] && echo "$f $(stat -c '%s %Y' "$f")"; done`).catch(() => '');
    const files = listing.split('\n').map((l) => l.trim().split(' ')).filter((p) => p.length === 3 && NAME_RE.test(p[0]))
        .map(([name, size, mtime]) => ({ name, size: Number(size), mtimeMs: Number(mtime) * 1000 }));
    return { serial, cameraId, battery, powered, storageFreeMb, files };
}

// The camera left the dock: forget everything about this visit (it gets its "connected" window again when it returns).
function forget(serial) {
    status.delete(serial); checks.delete(serial); pulling.delete(serial); screenSent.delete(serial); screens.forget(serial);
}

// ---------- the dock's own storage, and what the user decided for each file ----------
// Every file is first COPIED from the camera to this PC (verified by SHA-256) and announced to the server. The user then chooses on the
// dashboard: "Push to cloud" (the agent uploads it from here, at any time, even after the camera has left) or "Keep on dock storage"
// (it stays here). The server's policy can also decide automatically (Ask / Auto-cloud / Auto-local).
const STORE = path.resolve(process.env.DOCK_STORAGE || path.join(os.homedir(), 'VisionGuard-Dock'));
const PURGE_UPLOADED = process.env.DOCK_PURGE_UPLOADED === '1';   // free the dock's disk once a file is verified in the cloud (default: keep the local copy)
// A company can choose its own folder on this PC (dashboard > Docking > Files > Choose folder): policy.dirs = { cameraId: folder }.
// When it changes, the camera's files are moved there (copied, checked, then removed from the old place).
let dirs = {};
const ROOTS_FILE = path.join(STORE, '.roots.json');
const roots = (() => { try { return JSON.parse(fs.readFileSync(ROOTS_FILE, 'utf8')); } catch { return {}; } })();
const rootOf = (cameraId) => path.resolve(dirs[cameraId] || roots[cameraId] || STORE);
const localPath = (cameraId, name) => path.join(rootOf(cameraId), cameraId, name);
function relocate() {
    for (const [cameraId, want] of Object.entries(dirs)) {
        const from = path.resolve(roots[cameraId] || STORE), to = path.resolve(want);
        if (from === to) { roots[cameraId] = to; continue; }
        try {
            const src = path.join(from, cameraId), dst = path.join(to, cameraId);
            fs.mkdirSync(dst, { recursive: true });
            if (fs.existsSync(src)) {
                for (const f of fs.readdirSync(src)) {
                    const a = path.join(src, f), b = path.join(dst, f);
                    if (!fs.existsSync(b) || fs.statSync(b).size !== fs.statSync(a).size) fs.copyFileSync(a, b);
                    if (fs.statSync(b).size !== fs.statSync(a).size) throw new Error('copy of ' + f + ' is incomplete');
                }
                for (const f of fs.readdirSync(src)) fs.rmSync(path.join(src, f), { force: true });
                try { fs.rmdirSync(src); } catch { /* not empty: leave it */ }
            }
            roots[cameraId] = to; log(cameraId, 'files moved to', to);
        } catch (e) { dirs[cameraId] = roots[cameraId] || STORE; log(cameraId, 'could not use', want, ':', e.message); }
    }
    try { fs.mkdirSync(STORE, { recursive: true }); fs.writeFileSync(ROOTS_FILE, JSON.stringify(roots)); } catch { /* the default folder is not writable: nothing to remember */ }
}
const shaCache = new Map();   // camera-side hash by serial|name|size|mtime: a 1.9 GB file is hashed once, not every cycle
let policy = { mode: 'ask', legacy: false };
const legacyPending = [];     // old servers without the catalog: upload straight after the copy, like before
const uploadFailedAt = new Map();

async function loadPolicy() {
    try { policy = { ...(await api('GET', '/api/dock/policy')), legacy: false }; dirs = policy.dirs || {}; relocate(); }
    catch (e) { if (/-> 404/.test(e.message)) policy = { mode: 'auto_cloud', legacy: true }; }
}
function storageInfo() {
    try { const f = fs.statfsSync(fs.existsSync(STORE) ? STORE : path.dirname(STORE)); return { dir: STORE, freeBytes: f.bavail * f.bsize }; } catch { return { dir: STORE }; }
}
const deleteOnCamera = async (serial, tag, name) => { await shell(serial, `rm "${REC_DIR}/${name}"`); log(tag, `${name} removed from the camera (verified)`); };

async function offload(info, stats) {
    const { serial, cameraId } = info; const tag = cameraId || serial;
    if (!cameraId) { log(tag, 'no config.json id on the camera: skipped'); return; }
    fs.mkdirSync(path.join(rootOf(cameraId), cameraId), { recursive: true });
    const st = status.get(serial) || {}; status.set(serial, st);
    let todo = info.files.filter((f) => f.size > 0 && !(ONLY && f.name !== ONLY) && Date.now() - f.mtimeMs >= MIN_AGE_MS);
    if (SINCE) todo = todo.filter((f) => f.mtimeMs >= SINCE);
    if (LATEST) todo = todo.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, LATEST);
    if (SMALLEST) todo = todo.sort((a, b) => a.size - b.size);
    if (LIMIT) todo = todo.slice(0, LIMIT);
    if (DRY) { todo.forEach((f) => log(tag, `would copy ${f.name}  ${(f.size / 1e6).toFixed(1)} MB  ${new Date(f.mtimeMs).toISOString().slice(0, 16)}`)); return; }
    // Only what really has to travel counts as "copying / uploading": a file that is already on the dock is just verified again, quietly.
    const onDock = (f) => { try { return fs.statSync(localPath(cameraId, f.name)).size === f.size; } catch { return false; } };
    const travel = todo.filter((f) => !onDock(f));
    const bytesTotal = travel.reduce((a, f) => a + f.size, 0); let bytesDone = 0, index = 0;
    st.synced = 0; st.failed = 0; st.message = '';
    const copied = [];
    for (const f of todo) {
        let announced = false;
        const announce = async () => {   // from here on the camera's screen and the Docking page say "copying"
            if (announced) return;
            announced = true; index++;
            Object.assign(st, { state: 'offloading', message: '', progress: { index, total: Math.max(travel.length, index), file: f.name, bytesDone, bytesTotal: Math.max(bytesTotal, bytesDone + f.size) } });
            await report(false);
        };
        if (!onDock(f)) await announce();
        try {
            const key = `${serial}|${f.name}|${f.size}|${f.mtimeMs}`;
            let sha = shaCache.get(key);
            if (!sha) {
                sha = (await shell(serial, `sha256sum "${REC_DIR}/${f.name}"`)).trim().split(/\s+/)[0];
                if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error('cannot hash on camera');
                shaCache.set(key, sha);
            }
            const lp = localPath(cameraId, f.name);
            const have = fs.existsSync(lp) && fs.statSync(lp).size === f.size && (await hashFile(lp).catch(() => null)) === sha;
            if (!have) {
                await announce();
                const t0 = Date.now(), part = lp + '.part';
                pulling.set(serial, part);
                try { await run(['-s', serial, 'pull', `${REC_DIR}/${f.name}`, part]); } finally { pulling.delete(serial); }
                if ((await hashFile(part)) !== sha) { fs.rmSync(part, { force: true }); throw new Error('hash differs after USB copy'); }
                fs.renameSync(part, lp);
                log(tag, `${f.name} ${(f.size / 1e6).toFixed(1)} MB copied to the dock in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
                stats.copied++; stats.bytes += f.size;
            } else { log(tag, `${f.name} already on the dock`); stats.known++; }
            copied.push({ cameraId, name: f.name, size: f.size, sha256: sha, recordedTs: f.mtimeMs });
            if (announced) bytesDone += f.size;
            st.synced++;
        } catch (e) { log(tag, `${f.name} FAILED: ${e.message}`); stats.failed++; st.failed++; st.message = e.message.slice(0, 120); }
    }
    // tell the server what is now safe on the dock; it answers with what to do with each file
    if (copied.length) {
        if (policy.legacy) { legacyPending.push(...copied); }
        else {
            try {
                const r = await api('POST', '/api/dock/catalog', { body: { dockId: DOCK_ID, files: copied } });
                policy = { ...r.policy, legacy: false };
                const waiting = r.files.filter((x) => x.action === 'wait').length, toCloud = r.files.filter((x) => x.action === 'upload').length;
                st.message = waiting ? `${waiting} file${waiting === 1 ? '' : 's'} waiting for your choice` : toCloud ? `${toCloud} queued for the cloud` : '';
                if (DELETE) for (const x of r.files.filter((y) => y.action === 'keep')) await deleteOnCamera(serial, tag, copied.find((c) => c.sha256 === x.sha256).name).catch(() => {});
            } catch (e) { log(tag, 'catalog failed:', e.message); st.failed++; st.message = 'Could not reach the server: ' + e.message.slice(0, 80); }
        }
    }
    Object.assign(st, { state: st.failed ? 'error' : 'synced', progress: null, lastSyncTs: Date.now() });
}

// Uploads the files the user sent to the cloud, from the dock's storage, one at a time (they share one uplink).
let queueBusy = false;
async function processQueue() {
    if (queueBusy || REPORT_ONLY || DRY) return;
    queueBusy = true;
    try {
        let items;
        if (policy.legacy) items = legacyPending.splice(0);
        else items = (await api('GET', `/api/dock/queue?dockId=${encodeURIComponent(DOCK_ID)}`)).files;
        let index = 0;
        for (const f of items) {
            index++;
            const key = `${f.cameraId}|${f.sha256}`;
            if (Date.now() - (uploadFailedAt.get(key) || 0) < 60_000) continue;
            const lp = localPath(f.cameraId, f.name), info = lastInfos.find((i) => i.cameraId === f.cameraId), tag = f.cameraId;
            const setSt = (patch) => { if (info) status.set(info.serial, { ...(status.get(info.serial) || {}), ...patch }); };
            const markState = (state, message) => api('POST', '/api/dock/file-state', { body: { cameraId: f.cameraId, sha256: f.sha256, state, message } }).catch(() => {});
            try {
                if (!fs.existsSync(lp)) throw new Error('file is not on the dock storage');
                if ((await hashFile(lp)) !== f.sha256) throw new Error('file on the dock storage is damaged');
                if (!policy.legacy) await markState('uploading');
                setSt({ state: 'offloading', message: '', progress: { index, total: items.length, file: f.name, bytesDone: 0, bytesTotal: f.size } }); await report(false);
                const t0 = Date.now();
                const up = await api('POST', '/api/dock/upload', { body: fs.createReadStream(lp), headers: {
                    'content-type': 'application/octet-stream', 'x-camera-id': f.cameraId, 'x-filename': f.name, 'x-sha256': f.sha256,
                    'x-size': String(fs.statSync(lp).size), 'x-recorded-ts': String(f.recordedTs || ''), 'x-dock-id': DOCK_ID } });
                log(tag, `${f.name} ${(f.size / 1e6).toFixed(1)} MB pushed to the cloud in ${((Date.now() - t0) / 1000).toFixed(1)}s${up.duplicate ? ' (already there)' : ''}`);
                if (DELETE && info) await deleteOnCamera(info.serial, tag, f.name).catch(() => {});
                if (PURGE_UPLOADED) fs.rmSync(lp, { force: true });
                setSt({ state: 'synced', message: '', progress: null, lastSyncTs: Date.now() });
            } catch (e) {
                uploadFailedAt.set(key, Date.now());
                log(tag, `${f.name} cloud upload FAILED: ${e.message}`);
                if (!policy.legacy) await markState('failed', e.message.slice(0, 150));
                setSt({ state: 'error', message: `Cloud upload failed: ${e.message}`.slice(0, 150), progress: null });
            }
        }
    } catch (e) { log('', 'upload queue:', e.message); } finally { queueBusy = false; }
}


// "Delete from camera": the user asked for it on the dashboard. A file is removed from the camera only when (1) that camera is docked right now,
// (2) it is not being written, (3) the camera's copy is byte-identical (SHA-256) to the verified copy, and (4) that verified copy exists on the
// dock's storage or in the cloud. Anything else is left alone and reported.
let delBusy = false;
async function processDeletions() {
    if (delBusy || REPORT_ONLY || DRY || policy.legacy) return;
    delBusy = true;
    try {
        const { files } = await api('GET', '/api/dock/deletions');
        for (const f of files) {
            const info = lastInfos.find((i) => i.cameraId === f.cameraId);
            if (!info) continue;                                   // camera not on the dock: stays queued until it is
            const tell = (ok, message) => api('POST', '/api/dock/deleted', { body: { cameraId: f.cameraId, sha256: f.sha256, ok, message } }).catch(() => {});
            try {
                const cf = info.files.find((x) => x.name === f.name);
                if (!cf) { await tell(true); continue; }               // already gone from the camera
                if (Date.now() - cf.mtimeMs < MIN_AGE_MS) continue;    // still being written: try again later
                const lp = localPath(f.cameraId, f.name);
                const safe = f.state === 'cloud' || (fs.existsSync(lp) && (await hashFile(lp)) === f.sha256);
                if (!safe) { await tell(false, 'Not removed: no verified copy on the dock or in the cloud'); continue; }
                const key = `${info.serial}|${cf.name}|${cf.size}|${cf.mtimeMs}`;
                const camSha = shaCache.get(key) || (await shell(info.serial, `sha256sum "${REC_DIR}/${f.name}"`)).trim().split(/\s+/)[0];
                if (camSha !== f.sha256) { await tell(false, 'Not removed: the file on the camera differs from the verified copy'); continue; }
                await deleteOnCamera(info.serial, f.cameraId, f.name);
                await tell(true);
            } catch (e) { log(f.cameraId, `delete ${f.name} failed: ${e.message}`); await tell(false, ('Not removed: ' + e.message).slice(0, 150)); }
        }
    } catch (e) { log('', 'deletions:', e.message); } finally { delBusy = false; }
}

// ---------- camera app updates over the dock ----------
const PKG = 'com.swg.swg_bwc';
let latestP = null, latestAt = 0;
const updateFailed = new Map();   // serial -> { build, at }: do not hammer a camera that just refused this build
function latestBuild() {   // one request shared by every camera that asks within a minute
    if (!latestP || Date.now() - latestAt > 60_000) {
        latestAt = Date.now();
        latestP = api('GET', '/api/dock/update').catch((e) => { log('', 'cannot read the latest app build:', e.message); return null; });
    }
    return latestP;
}
async function fetchApk(meta) {
    fs.mkdirSync(STAGING, { recursive: true });
    const f = path.join(STAGING, `app-${meta.build.slice(0, 12)}.apk`);
    if (fs.existsSync(f) && (await hashFile(f)) === meta.build) return f;
    const r = await fetch(`${SERVER}/api/dock/update/apk`, { headers: { 'x-dock-token': TOKEN } });
    if (!r.ok) throw new Error(`download failed (${r.status})`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (crypto.createHash('sha256').update(buf).digest('hex') !== meta.build) throw new Error('downloaded app does not match the published build');
    fs.writeFileSync(f + '.tmp', buf); fs.renameSync(f + '.tmp', f);
    return f;
}

// GPS must be ready on every camera, after every install/update: location switched on (GPS provider), location permission granted.
const aidedOnce = new Set();   // assisted-GPS data is pushed once per camera and agent run
async function ensureGps(info) {
    const { serial } = info; const tag = info.cameraId || serial;
    const has = (await shell(serial, `pm path ${PKG}`).catch(() => '')).trim();
    if (!has) return;
    const probe = (await shell(serial, `echo mode:$(settings get secure location_mode); dumpsys package ${PKG} | grep -c "ACCESS_FINE_LOCATION: granted=true"`).catch(() => '')).trim().split('\n');
    const modeOk = (probe[0] || '').trim() === 'mode:3', permOk = Number(probe[1]) > 0;
    if (!aidedOnce.has(serial)) { aidedOnce.add(serial); await shell(serial, 'settings put global assisted_gps_enabled 1; cmd location providers send-extra-command gps force_time_injection; cmd location providers send-extra-command gps force_xtra_injection').catch(() => {}); }
    if (!aidedOnce.has(serial + ':bg')) {   // GPS must also work with the screen off: location "all the time" and no battery optimisation (both are harmless to repeat)
        aidedOnce.add(serial + ':bg');
        await shell(serial, `pm grant ${PKG} android.permission.ACCESS_BACKGROUND_LOCATION`).catch(() => {});
        await shell(serial, `dumpsys deviceidle whitelist +${PKG}`).catch(() => {});
    }
    if (modeOk && permOk) return;
    if (!modeOk) await shell(serial, 'settings put secure location_mode 3').catch(() => {});
    for (const perm of ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION']) await shell(serial, `pm grant ${PKG} android.permission.${perm}`).catch(() => {});
    log(tag, `GPS fixed (${[!modeOk && 'location was off', !permOk && 'permission was missing'].filter(Boolean).join(', ')})`);
}

// 'current' = the camera runs the latest build; 'other' = checked, and there is nothing to show (updated, waiting, failed, not installed...).
// The camera's own screen uses this to end its first "connected, checking" window.
const checked = (serial, kind) => { checks.set(serial, kind); };

async function updateApp(info) {
    const { serial } = info; const tag = info.cameraId || serial;
    if (NO_UPDATE) return checked(serial, 'other');
    const meta = await latestBuild();
    if (!meta) return checked(serial, 'other');
    const installed = (await shell(serial, `pm path ${PKG}`).catch(() => '')).trim().split('\n')[0].replace('package:', '').trim();
    if (!installed) { status.set(serial, { ...(status.get(serial) || {}), state: 'connected', message: 'Camera app not installed: provision this camera first' }); return checked(serial, 'other'); }
    const have = (await shell(serial, `sha256sum ${installed}`).catch(() => '')).trim().split(/\s+/)[0];
    if (have === meta.build) { const st = status.get(serial) || {}; if (st.state === 'updating' || /needs migration/i.test(st.message || '')) status.set(serial, { ...st, state: 'connected', message: '' }); return checked(serial, 'current'); }
    const failed = updateFailed.get(serial);
    if (failed && failed.build === meta.build && Date.now() - failed.at < 10 * 60_000) return checked(serial, 'other');
    // On the dock the camera is powered (USB), so a low battery cannot cut the update short; only a camera that is NOT powered must have enough charge.
    if (info.battery != null && info.battery < MIN_BATTERY && !info.powered) { log(tag, `app is outdated but the battery is ${info.battery}% and the camera is not powered: waiting`); return checked(serial, 'other'); }
    const newest = Math.max(0, ...info.files.map((f) => f.mtimeMs));
    if (Date.now() - newest < 2 * MIN_AGE_MS) { log(tag, 'app is outdated but the camera is recording: waiting'); return checked(serial, 'other'); }
    const keep = status.get(serial) || {};
    try {
        status.set(serial, { ...keep, state: 'updating', message: 'Updating the camera app…' }); await report(true);
        const apk = await fetchApk(meta);
        log(tag, `installing camera app ${meta.build.slice(0, 12)}…`);
        await run(['-s', serial, 'install', '-r', apk], { timeout: 180_000 });   // never hold the camera's window (and its bay) forever
        await shell(serial, `am start -n ${PKG}/.MainActivity`).catch(() => {});
        await ensureGps(info);
        log(tag, 'camera app updated');
        status.set(serial, { ...keep, state: 'connected', message: 'Camera app updated' });
        updateFailed.delete(serial);
    } catch (e) {
        const incompatible = /UPDATE_INCOMPATIBLE|signatures do not match|INSTALL_FAILED_VERSION_DOWNGRADE/i.test(e.message);
        updateFailed.set(serial, { build: meta.build, at: Date.now() });
        log(tag, 'app update failed:', e.message);
        status.set(serial, { ...keep, state: 'error', message: incompatible ? 'Camera app needs migration (older signing key): not updated' : `App update failed: ${e.message}`.slice(0, 150) });
    }
    checked(serial, 'other');
}

// One update at a time per camera: the heartbeat starts the check the moment a camera is docked, the cycle repeats it later.
const updating = new Set();
async function updateOnce(info) {
    if (updating.has(info.serial)) return;
    updating.add(info.serial);
    try { await updateApp(info); } finally { updating.delete(info.serial); }
}

// ---------- the dashboard browses this PC's folders (only folders, only under the home folder, /Volumes or the storage folder) ----------
const BROWSE_ROOTS = [os.homedir(), STORE, ...(process.platform === 'darwin' ? ['/Volumes'] : []), ...String(process.env.DOCK_BROWSE_ROOTS || '').split(path.delimiter).filter(Boolean)].map((x) => path.resolve(x));
const inRoots = (p) => BROWSE_ROOTS.some((r) => p === r || p.startsWith(r + path.sep));
async function browseOnce() {
    let q; try { q = await api('GET', '/api/dock/browse-pending'); } catch { return; }
    for (const r of q.requests || []) {
        let out = { id: r.id, ok: false, error: 'Folder not allowed' };
        try {
            const p = path.resolve(r.path || os.homedir());
            if (inRoots(p)) {
                if (r.type === 'check') {
                    fs.mkdirSync(p, { recursive: true }); const t = path.join(p, '.visionguard-write-test'); fs.writeFileSync(t, 'ok'); fs.rmSync(t, { force: true });
                    out = { id: r.id, ok: true, path: p };
                } else {
                    const dirsList = fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort((a, b) => a.localeCompare(b)).slice(0, 300);
                    const up = path.dirname(p);
                    out = { id: r.id, ok: true, path: p, parent: p !== up && inRoots(up) ? up : null, dirs: dirsList };
                }
            }
        } catch (e) { out = { id: r.id, ok: false, error: String(e.message || e).slice(0, 140) }; }
        api('POST', '/api/dock/browse-result', { body: out }).catch(() => {});
    }
}

async function report(force) {
    if (!force && Date.now() - lastReportAt < 1500) return;   // progress updates are throttled
    lastReportAt = Date.now();
    await api('POST', '/api/dock/report', { body: { dockId: DOCK_ID, agent: AGENT_VERSION, ...(LOC ? { location: LOC } : {}), storage: storageInfo(), deleteAfter: DELETE, cameras: lastInfos.map((i) => ({
        serial: i.serial, port: i.port, cameraId: i.cameraId, battery: i.battery, storageFreeMb: i.storageFreeMb, files: i.files.length,
        pendingMb: Math.round(i.files.reduce((a, f) => a + f.size, 0) / 1e6), ...(status.get(i.serial) || { state: 'connected' }) })) } })
        .catch((e) => log('', 'report failed:', e.message));
}

// ---------- the camera's own screen ----------
// What the docking station is doing with this camera (screen.js decides the words). Written every few seconds while there is something to
// say, so the camera knows the agent is alive; removed when there is nothing to say. A camera whose app is older than 1.6 simply ignores it.
const SCREEN_REFRESH_MS = 4000;
async function pushScreens() {
    if (NO_SCREEN || REPORT_ONLY || DRY) return;
    const t = Date.now();
    await Promise.all(lastInfos.map(async (i) => {
        const st = status.get(i.serial) || {};
        let partBytes = 0;
        const part = pulling.get(i.serial);
        if (part) { try { partBytes = fs.statSync(part).size; } catch { /* the first bytes have not arrived yet */ } }
        const view = screens.view(i.serial, { state: st.state, message: st.message, progress: st.progress, check: checks.get(i.serial), partBytes }, t);
        const key = view ? JSON.stringify(view) : '';
        const last = screenSent.get(i.serial);
        if (!last && !view) return;                                                  // never said anything: nothing to remove
        if (last && last.key === key && (!view || t - last.at < SCREEN_REFRESH_MS)) return;   // nothing new to say
        screenSent.set(i.serial, { key, at: t });
        await shell(i.serial, view ? screenFile.writeCommand(APP_DIR, screenFile.encode(view, t)) : screenFile.clearCommand(APP_DIR), 8000)
            .catch(() => screenSent.delete(i.serial));   // try again on the next beat
    }));
}
let screenBusy = false;
function pushScreensSoon() {   // never holds up the heartbeat: a camera that does not answer must not make the dock look offline
    if (screenBusy) return;
    screenBusy = true;
    pushScreens().catch(() => {}).finally(() => { screenBusy = false; });
}

// A camera was just docked: do not wait for the end of the pause between cycles.
let napWake = null, nudged = false;
const nudgeCycle = () => { nudged = true; if (napWake) napWake(); };
function nap(seconds) {
    if (nudged) { nudged = false; return Promise.resolve(); }
    return new Promise((resolve) => {
        const done = () => { clearTimeout(timer); napWake = null; nudged = false; resolve(); };
        const timer = setTimeout(done, seconds * 1000);
        napWake = done;
    });
}

async function cycle() {
    const devs = await devices();
    for (const k of [...status.keys()]) if (!devs.some((d) => d.serial === k)) forget(k);   // camera left the dock
    const infos = [];
    for (const d of devs) { try { infos.push({ ...(await inspect(d.serial)), port: d.port }); } catch (e) { log(d.serial, 'inspect failed:', e.message); } }
    lastInfos = infos;   // swapped in one go, so the heartbeat never reports a half-built list
    for (const i of lastInfos) if (!status.has(i.serial)) status.set(i.serial, { state: 'connected', synced: 0, failed: 0 });
    await report(true);   // also when the dock is empty: the page then shows the agent as online with idle bays
    if (!lastInfos.length) { log('', 'no camera on the dock'); return; }
    await loadPolicy();
    const stats = { copied: 0, known: 0, skipped: 0, failed: 0, deleted: 0, bytes: 0 };
    if (!REPORT_ONLY && !NO_UPDATE) await Promise.all(lastInfos.map((i) => ensureGps(i).catch((e) => log(i.cameraId || i.serial, 'GPS check failed:', e.message))));
    if (!REPORT_ONLY) await Promise.all(lastInfos.map((i) => updateOnce(i).catch((e) => log(i.cameraId || i.serial, 'update check failed:', e.message))));   // first: an update takes seconds, copying recordings can take minutes
    if (!REPORT_ONLY && !UPDATE_ONLY) await Promise.all(lastInfos.map((i) => offload(i, stats)));   // cameras in parallel, files in order
    if (flag('once') && !UPDATE_ONLY) { await processQueue(); await processDeletions(); }   // the long-running agent does this on its own timer so a big upload never blocks copying
    await report(true);
    log('', `cycle done: ${JSON.stringify(stats)}`);
    return stats;
}

// Heartbeat: every 2 s tell the server "I am alive and these cameras are on the dock", without waiting for a (slow) offload cycle.
// The Docking page turns Online -> Connecting -> Offline from how fresh this is, and a camera appears/disappears within about 2 s.
let lastKey = null, hbBusy = false;
async function heartbeat() {
    if (hbBusy) return;
    hbBusy = true;
    const justDocked = [];
    try {
        const devs = await devices();
        const key = devs.map((d) => d.serial).sort().join(',');
        if (key !== lastKey) {
            lastKey = key;
            lastInfos = lastInfos.filter((i) => devs.some((d) => d.serial === i.serial));
            for (const k of [...status.keys()]) if (!devs.some((d) => d.serial === k)) forget(k);
            for (const d of devs) {
                if (lastInfos.some((i) => i.serial === d.serial)) continue;
                try {
                    const info = { ...(await inspect(d.serial)), port: d.port };
                    lastInfos = [...lastInfos, info]; status.set(d.serial, { state: 'connected', synced: 0, failed: 0 });
                    justDocked.push(info);
                } catch (e) { log(d.serial, 'inspect failed:', e.message); }
            }
        }
        await report(true);
        pushScreensSoon();   // the camera shows "connected" within a second or two of being docked
        // Straight away, not at the next cycle: check the camera's app (an update starts at once) and wake the cycle for its recordings.
        for (const info of justDocked) { log(info.cameraId || info.serial, 'docked'); if (!REPORT_ONLY) updateOnce(info).catch((e) => log(info.cameraId || info.serial, 'update check failed:', e.message)); }
        if (justDocked.length) nudgeCycle();
    } catch (e) { log('', 'heartbeat:', e.message); } finally { hbBusy = false; }
}

(async () => {
    if (!TOKEN) { console.error('Set DOCK_TOKEN (same value as on the server).'); process.exit(2); }
    log('', `Dock Agent ${DOCK_ID} -> ${SERVER} ${DELETE ? '(will delete verified files from cameras)' : '(copy only, nothing is deleted)'}`);
    if (!flag('once')) { setInterval(heartbeat, 2000); setInterval(browseOnce, 1500); setInterval(() => { if (!UPDATE_ONLY) loadPolicy().then(() => Promise.all([processQueue(), processDeletions()])).catch(() => {}); }, 10_000); }   // act on the user's choices within seconds, camera docked or not
    do {
        try { await cycle(); } catch (e) { log('', 'cycle error:', e.message); }
        if (flag('once')) break;
        await nap(Number(opt('interval', 30)));
    } while (true);
})();
