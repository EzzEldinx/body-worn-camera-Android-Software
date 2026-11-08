#!/usr/bin/env node
// VisionGuard Dock Agent: runs on the PC next to the docking station.
// For every camera visible over USB (adb) it COPIES new recordings to this PC's own storage (DOCK_STORAGE, default ~/VisionGuard-Dock),
// verified by SHA-256, and tells the server. The user then chooses on the dashboard (Docking > Files) for each file or in bulk:
// "Push to cloud" (the agent uploads it from the PC, verified again by the server) or "Keep on dock storage". The server policy can also
// decide automatically: Ask me / Automatic · Cloud / Automatic · Dock storage. With --delete a file is removed from the camera only after
// it is safe where the user wanted it. DOCK_PURGE_UPLOADED=1 frees the PC's copy once a file is verified in the cloud.
//
//   DOCK_SERVER=https://visionguard.example.com DOCK_TOKEN=... node agent.js [--once] [--delete] [--report-only] [--dry-run] [--interval 30] [--only VID_x.mp4] [--limit N] [--smallest] [--latest N] [--since today|YYYY-MM-DD] [--report-only] [--no-update] [--update-only]
//
// Camera app updates: every cycle the agent compares the app installed on each docked camera with the latest build published on the server
// (Dashboard > Updates) and installs the new one over USB when the camera is not recording and has >= 20% battery. A camera signed with an
// older key cannot be updated this way: it is flagged "needs migration" and left untouched.
//
// Requires: Node 22+, adb in PATH (or ADB=/path/to/adb).
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

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
const DRY = flag('dry-run');                   // list what would be offloaded, touch nothing
const ONLY = opt('only', null);
if ((ARGV.includes('--only') && !ONLY) || (SINCE_RAW && !Number.isFinite(SINCE)) || (ARGV.includes('--since') && !SINCE_RAW)) { console.error('Bad --only / --since value: refusing to run without a filter.'); process.exit(2); }  // restrict to one file name (useful for tests)
const MIN_AGE_MS = 60_000; // never touch a file that changed in the last minute (still being recorded)
const NAME_RE = /^(VID|IMG)_\d{6,16}\.(mp4|jpg)$/;

// What the agent is doing per camera right now; sent to the server so the Docking page shows live progress.
const status = new Map();   // serial -> { state, message, progress, synced, failed, lastSyncTs }
let lastInfos = [], lastReportAt = 0;
const AGENT_VERSION = '1.5';
const log = (dev, ...a) => console.log(new Date().toISOString().slice(11, 19), dev ? `[${dev}]` : '', ...a);
const run = (args) => new Promise((resolve, reject) => execFile(ADB, args, { maxBuffer: 64 * 1024 * 1024 }, (e, so, se) => (e ? reject(new Error((se || e.message).trim())) : resolve(so))));
const shell = (serial, cmd) => run(['-s', serial, 'shell', cmd]);
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
    const battery = Number((await shell(serial, 'dumpsys battery | grep level')).split(':')[1]) || null;
    const df = (await shell(serial, 'df -k /sdcard | tail -1')).trim().split(/\s+/);
    const storageFreeMb = Math.round(Number(df[3]) / 1024) || null;
    const listing = await shell(serial, `cd ${REC_DIR} 2>/dev/null && for f in *; do [ -f "$f" ] && echo "$f $(stat -c '%s %Y' "$f")"; done`).catch(() => '');
    const files = listing.split('\n').map((l) => l.trim().split(' ')).filter((p) => p.length === 3 && NAME_RE.test(p[0]))
        .map(([name, size, mtime]) => ({ name, size: Number(size), mtimeMs: Number(mtime) * 1000 }));
    return { serial, cameraId, battery, storageFreeMb, files };
}

// ---------- the dock's own storage, and what the user decided for each file ----------
// Every file is first COPIED from the camera to this PC (verified by SHA-256) and announced to the server. The user then chooses on the
// dashboard: "Push to cloud" (the agent uploads it from here, at any time, even after the camera has left) or "Keep on dock storage"
// (it stays here). The server's policy can also decide automatically (Ask / Auto-cloud / Auto-local).
const STORE = path.resolve(process.env.DOCK_STORAGE || path.join(os.homedir(), 'VisionGuard-Dock'));
const PURGE_UPLOADED = process.env.DOCK_PURGE_UPLOADED === '1';   // free the dock's disk once a file is verified in the cloud (default: keep the local copy)
const localPath = (cameraId, name) => path.join(STORE, cameraId, name);
const shaCache = new Map();   // camera-side hash by serial|name|size|mtime: a 1.9 GB file is hashed once, not every cycle
let policy = { mode: 'ask', legacy: false };
const legacyPending = [];     // old servers without the catalog: upload straight after the copy, like before
const uploadFailedAt = new Map();

async function loadPolicy() {
    try { policy = { ...(await api('GET', '/api/dock/policy')), legacy: false }; }
    catch (e) { if (/-> 404/.test(e.message)) policy = { mode: 'auto_cloud', legacy: true }; }
}
function storageInfo() {
    try { const f = fs.statfsSync(fs.existsSync(STORE) ? STORE : path.dirname(STORE)); return { dir: STORE, freeBytes: f.bavail * f.bsize }; } catch { return { dir: STORE }; }
}
const deleteOnCamera = async (serial, tag, name) => { await shell(serial, `rm "${REC_DIR}/${name}"`); log(tag, `${name} removed from the camera (verified)`); };

async function offload(info, stats) {
    const { serial, cameraId } = info; const tag = cameraId || serial;
    if (!cameraId) { log(tag, 'no config.json id on the camera: skipped'); return; }
    fs.mkdirSync(path.join(STORE, cameraId), { recursive: true });
    const st = status.get(serial) || {}; status.set(serial, st);
    let todo = info.files.filter((f) => f.size > 0 && !(ONLY && f.name !== ONLY) && Date.now() - f.mtimeMs >= MIN_AGE_MS);
    if (SINCE) todo = todo.filter((f) => f.mtimeMs >= SINCE);
    if (LATEST) todo = todo.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, LATEST);
    if (SMALLEST) todo = todo.sort((a, b) => a.size - b.size);
    if (LIMIT) todo = todo.slice(0, LIMIT);
    if (DRY) { todo.forEach((f) => log(tag, `would copy ${f.name}  ${(f.size / 1e6).toFixed(1)} MB  ${new Date(f.mtimeMs).toISOString().slice(0, 16)}`)); return; }
    const bytesTotal = todo.reduce((a, f) => a + f.size, 0); let bytesDone = 0, index = 0;
    st.synced = 0; st.failed = 0; st.message = '';
    const copied = [];
    for (const f of todo) {
        index++; Object.assign(st, { state: 'offloading', message: '', progress: { index, total: todo.length, file: f.name, bytesDone, bytesTotal } }); await report(false);
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
                const t0 = Date.now(), part = lp + '.part';
                await run(['-s', serial, 'pull', `${REC_DIR}/${f.name}`, part]);
                if ((await hashFile(part)) !== sha) { fs.rmSync(part, { force: true }); throw new Error('hash differs after USB copy'); }
                fs.renameSync(part, lp);
                log(tag, `${f.name} ${(f.size / 1e6).toFixed(1)} MB copied to the dock in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
                stats.copied++; stats.bytes += f.size;
            } else { log(tag, `${f.name} already on the dock`); stats.known++; }
            copied.push({ cameraId, name: f.name, size: f.size, sha256: sha, recordedTs: f.mtimeMs });
            bytesDone += f.size; st.synced++;
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
    if (modeOk && permOk) return;
    if (!modeOk) await shell(serial, 'settings put secure location_mode 3').catch(() => {});
    for (const perm of ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION']) await shell(serial, `pm grant ${PKG} android.permission.${perm}`).catch(() => {});
    log(tag, `GPS fixed (${[!modeOk && 'location was off', !permOk && 'permission was missing'].filter(Boolean).join(', ')})`);
}

async function updateApp(info) {
    if (NO_UPDATE) return;
    const { serial } = info; const tag = info.cameraId || serial;
    const meta = await latestBuild();
    if (!meta) return;
    const installed = (await shell(serial, `pm path ${PKG}`).catch(() => '')).trim().split('\n')[0].replace('package:', '').trim();
    if (!installed) { status.set(serial, { ...(status.get(serial) || {}), state: 'connected', message: 'Camera app not installed: provision this camera first' }); return; }
    const have = (await shell(serial, `sha256sum ${installed}`).catch(() => '')).trim().split(/\s+/)[0];
    if (have === meta.build) { const st = status.get(serial) || {}; if (st.state === 'updating' || /needs migration/i.test(st.message || '')) status.set(serial, { ...st, state: 'connected', message: '' }); return; }
    const failed = updateFailed.get(serial);
    if (failed && failed.build === meta.build && Date.now() - failed.at < 10 * 60_000) return;
    if (info.battery != null && info.battery < 20) { log(tag, `app is outdated but the battery is ${info.battery}%: waiting`); return; }
    const newest = Math.max(0, ...info.files.map((f) => f.mtimeMs));
    if (Date.now() - newest < 2 * MIN_AGE_MS) { log(tag, 'app is outdated but the camera is recording: waiting'); return; }
    const keep = status.get(serial) || {};
    try {
        status.set(serial, { ...keep, state: 'updating', message: 'Updating the camera app…' }); await report(true);
        const apk = await fetchApk(meta);
        log(tag, `installing camera app ${meta.build.slice(0, 12)}…`);
        await run(['-s', serial, 'install', '-r', apk]);
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
}

async function report(force) {
    if (!force && Date.now() - lastReportAt < 1500) return;   // progress updates are throttled
    lastReportAt = Date.now();
    await api('POST', '/api/dock/report', { body: { dockId: DOCK_ID, agent: AGENT_VERSION, ...(LOC ? { location: LOC } : {}), storage: storageInfo(), deleteAfter: DELETE, cameras: lastInfos.map((i) => ({
        serial: i.serial, port: i.port, cameraId: i.cameraId, battery: i.battery, storageFreeMb: i.storageFreeMb, files: i.files.length,
        pendingMb: Math.round(i.files.reduce((a, f) => a + f.size, 0) / 1e6), ...(status.get(i.serial) || { state: 'connected' }) })) } })
        .catch((e) => log('', 'report failed:', e.message));
}

async function cycle() {
    const devs = await devices();
    for (const k of [...status.keys()]) if (!devs.some((d) => d.serial === k)) status.delete(k);   // camera left the dock
    const infos = [];
    for (const d of devs) { try { infos.push({ ...(await inspect(d.serial)), port: d.port }); } catch (e) { log(d.serial, 'inspect failed:', e.message); } }
    lastInfos = infos;   // swapped in one go, so the heartbeat never reports a half-built list
    for (const i of lastInfos) if (!status.has(i.serial)) status.set(i.serial, { state: 'connected', synced: 0, failed: 0 });
    await report(true);   // also when the dock is empty: the page then shows the agent as online with idle bays
    if (!lastInfos.length) { log('', 'no camera on the dock'); return; }
    await loadPolicy();
    const stats = { copied: 0, known: 0, skipped: 0, failed: 0, deleted: 0, bytes: 0 };
    if (!REPORT_ONLY && !NO_UPDATE) await Promise.all(lastInfos.map((i) => ensureGps(i).catch((e) => log(i.cameraId || i.serial, 'GPS check failed:', e.message))));
    if (!REPORT_ONLY && !UPDATE_ONLY) await Promise.all(lastInfos.map((i) => offload(i, stats)));   // cameras in parallel, files in order
    if (flag('once') && !UPDATE_ONLY) { await processQueue(); await processDeletions(); }   // the long-running agent does this on its own timer so a big upload never blocks copying
    if (!REPORT_ONLY) await Promise.all(lastInfos.map((i) => updateApp(i).catch((e) => log(i.cameraId || i.serial, 'update check failed:', e.message))));   // after the recordings are safe
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
    try {
        const devs = await devices();
        const key = devs.map((d) => d.serial).sort().join(',');
        if (key !== lastKey) {
            lastKey = key;
            lastInfos = lastInfos.filter((i) => devs.some((d) => d.serial === i.serial));
            for (const k of [...status.keys()]) if (!devs.some((d) => d.serial === k)) status.delete(k);
            for (const d of devs) {
                if (lastInfos.some((i) => i.serial === d.serial)) continue;
                try { lastInfos = [...lastInfos, { ...(await inspect(d.serial)), port: d.port }]; status.set(d.serial, { state: 'connected', synced: 0, failed: 0 }); } catch (e) { log(d.serial, 'inspect failed:', e.message); }
            }
        }
        await report(true);
    } catch (e) { log('', 'heartbeat:', e.message); } finally { hbBusy = false; }
}

(async () => {
    if (!TOKEN) { console.error('Set DOCK_TOKEN (same value as on the server).'); process.exit(2); }
    log('', `Dock Agent ${DOCK_ID} -> ${SERVER} ${DELETE ? '(will delete verified files from cameras)' : '(copy only, nothing is deleted)'}`);
    if (!flag('once')) { setInterval(heartbeat, 2000); setInterval(() => { if (!UPDATE_ONLY) loadPolicy().then(() => Promise.all([processQueue(), processDeletions()])).catch(() => {}); }, 10_000); }   // act on the user's choices within seconds, camera docked or not
    do {
        try { await cycle(); } catch (e) { log('', 'cycle error:', e.message); }
        if (flag('once')) break;
        await new Promise((r) => setTimeout(r, Number(opt('interval', 30)) * 1000));
    } while (true);
})();
