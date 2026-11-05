#!/usr/bin/env node
// VisionGuard Dock Agent: runs on the PC next to the docking station.
// For every camera visible over USB (adb) it pulls new recordings, verifies them by SHA-256 on the camera and
// on the PC, uploads them to the server (which verifies again), and only then (optionally) deletes them from the camera.
//
//   DOCK_SERVER=https://visionguard.example.com DOCK_TOKEN=... node agent.js [--once] [--delete] [--interval 30] [--only VID_x.mp4]
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
const ONLY = opt('only', null);  // restrict to one file name (useful for tests)
const MIN_AGE_MS = 60_000; // never touch a file that changed in the last minute (still being recorded)
const NAME_RE = /^(VID|IMG)_\d{6,16}\.(mp4|jpg)$/;

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
    const out = await run(['devices']);
    return out.split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((p) => p[1] === 'device').map((p) => p[0]);
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

async function offload(info, stats) {
    const { serial, cameraId } = info; const tag = cameraId || serial;
    if (!cameraId) { log(tag, 'no config.json id on the camera: skipped'); return; }
    const dir = path.join(STAGING, cameraId); fs.mkdirSync(dir, { recursive: true });
    for (const f of info.files) {
        if (f.size === 0 || (ONLY && f.name !== ONLY)) continue;
        if (Date.now() - f.mtimeMs < MIN_AGE_MS) { log(tag, `${f.name} changed <1 min ago, left alone`); stats.skipped++; continue; }
        const remote = `${REC_DIR}/${f.name}`, local = path.join(dir, f.name);
        try {
            const remoteSha = (await shell(serial, `sha256sum "${remote}"`)).trim().split(/\s+/)[0];
            if (!/^[0-9a-f]{64}$/.test(remoteSha)) throw new Error('cannot hash on camera');
            const known = (await api('GET', `/api/dock/has?camera=${encodeURIComponent(cameraId)}&sha256=${remoteSha}`)).has;
            if (!known) {
                const t0 = Date.now();
                await run(['-s', serial, 'pull', remote, local]);
                const localSha = await hashFile(local);
                if (localSha !== remoteSha) throw new Error('hash differs after USB copy');
                const up = await api('POST', '/api/dock/upload', { body: fs.createReadStream(local), headers: {
                    'content-type': 'application/octet-stream', 'x-camera-id': cameraId, 'x-filename': f.name, 'x-sha256': localSha,
                    'x-size': String(fs.statSync(local).size), 'x-recorded-ts': String(f.mtimeMs), 'x-dock-id': DOCK_ID } });
                log(tag, `${f.name} ${(f.size / 1e6).toFixed(1)} MB offloaded in ${((Date.now() - t0) / 1000).toFixed(1)}s${up.duplicate ? ' (already on server)' : ''}`);
                fs.rmSync(local, { force: true });
                stats.uploaded++; stats.bytes += f.size;
            } else { log(tag, `${f.name} already on the server`); stats.known++; }
            if (DELETE) { await shell(serial, `rm "${remote}"`); log(tag, `${f.name} removed from the camera (verified on the server)`); stats.deleted++; }
        } catch (e) { log(tag, `${f.name} FAILED: ${e.message}`); stats.failed++; }
    }
}

async function cycle() {
    const serials = await devices();
    if (!serials.length) { log('', 'no camera on the dock'); return; }
    const infos = [];
    for (const s of serials) { try { infos.push(await inspect(s)); } catch (e) { log(s, 'inspect failed:', e.message); } }
    await api('POST', '/api/dock/report', { body: { dockId: DOCK_ID, cameras: infos.map((i) => ({
        serial: i.serial, cameraId: i.cameraId, battery: i.battery, storageFreeMb: i.storageFreeMb, files: i.files.length,
        pendingMb: Math.round(i.files.reduce((a, f) => a + f.size, 0) / 1e6) })) } }).catch((e) => log('', 'report failed:', e.message));
    const stats = { uploaded: 0, known: 0, skipped: 0, failed: 0, deleted: 0, bytes: 0 };
    await Promise.all(infos.map((i) => offload(i, stats)));   // cameras in parallel, files in order
    log('', `cycle done: ${JSON.stringify(stats)}`);
    return stats;
}

(async () => {
    if (!TOKEN) { console.error('Set DOCK_TOKEN (same value as on the server).'); process.exit(2); }
    log('', `Dock Agent ${DOCK_ID} -> ${SERVER} ${DELETE ? '(will delete verified files from cameras)' : '(copy only, nothing is deleted)'}`);
    do {
        try { await cycle(); } catch (e) { log('', 'cycle error:', e.message); }
        if (flag('once')) break;
        await new Promise((r) => setTimeout(r, Number(opt('interval', 30)) * 1000));
    } while (true);
})();
