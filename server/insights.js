// Operations analytics for the Analytics page: fleet health, the evidence pipeline (dock -> cloud), trends, and plain-language findings.
// Everything is computed from the server's own data and scoped to the cameras the user may see.
const fs = require('fs');
const auditlog = require('./auditlog');

const DAY = 86400000, HOUR = 3600000;
const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const label = (t) => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric' });

function build({ db, cameras, recordingsDir, staff, now = Date.now() }) {
    const ids = new Set(cameras.map((c) => c.cameraId));
    const inScope = (id) => ids.has(id);

    // ---- recordings in the cloud, last 14 days
    const recRows = db.prepare('SELECT camera_id,size,COALESCE(recorded_ts,uploaded_ts) ts FROM recordings WHERE COALESCE(recorded_ts,uploaded_ts) > ?').all(now - 14 * DAY).filter((r) => inScope(r.camera_id));
    const recDays = [];
    for (let i = 13; i >= 0; i--) {
        const from = dayStart(now - i * DAY), rs = recRows.filter((r) => r.ts >= from && r.ts < from + DAY);
        recDays.push({ day: label(from), count: rs.length, bytes: rs.reduce((a, r) => a + r.size, 0) });
    }
    const allRec = db.prepare('SELECT camera_id,size FROM recordings').all().filter((r) => inScope(r.camera_id));
    const cloudBytes = allRec.reduce((a, r) => a + r.size, 0);

    // ---- the pipeline: files copied by the docks and what was decided for them
    const files = db.prepare('SELECT camera_id,size,state,choice,added_ts,cam_delete,cam_deleted_ts FROM dock_files').all().filter((f) => inScope(f.camera_id));
    const bucket = (f) => (f.state === 'cloud' ? 'cloud' : f.state === 'failed' ? 'failed' : f.choice === null ? 'awaiting' : f.choice === 'local' ? 'local' : 'queued');
    const pipeline = { awaiting: { n: 0, bytes: 0 }, queued: { n: 0, bytes: 0 }, local: { n: 0, bytes: 0 }, cloud: { n: 0, bytes: 0 }, failed: { n: 0, bytes: 0 } };
    let oldestAwaiting = null, removedFromCameras = 0;
    for (const f of files) {
        const b = bucket(f); pipeline[b].n++; pipeline[b].bytes += f.size;
        if (b === 'awaiting' && (oldestAwaiting === null || f.added_ts < oldestAwaiting)) oldestAwaiting = f.added_ts;
        if (f.cam_deleted_ts) removedFromCameras++;
    }

    // ---- alarms
    const alarms = db.prepare('SELECT camera_id,ts,ack_ts FROM alarms WHERE ts > ?').all(now - 30 * DAY).filter((a) => inScope(a.camera_id));
    const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 }));
    alarms.forEach((a) => { byHour[new Date(a.ts).getHours()].count++; });
    const alarmDays = [];
    for (let i = 13; i >= 0; i--) { const from = dayStart(now - i * DAY); alarmDays.push({ day: label(from), count: alarms.filter((a) => a.ts >= from && a.ts < from + DAY).length }); }
    const resp = (list) => { const k = list.filter((a) => a.ack_ts != null); return k.length ? Math.round(k.reduce((s, a) => s + (a.ack_ts - a.ts), 0) / k.length / 1000) : null; };
    const thisWeek = alarms.filter((a) => a.ts > now - 7 * DAY), lastWeek = alarms.filter((a) => a.ts <= now - 7 * DAY && a.ts > now - 14 * DAY);
    const unacked = alarms.filter((a) => a.ack_ts == null && now - a.ts > 5 * 60000);

    // ---- cameras
    const offEvents = new Map(db.prepare("SELECT camera_id, COUNT(*) n FROM events WHERE type = 'offline' AND ts > ? GROUP BY camera_id").all(now - 7 * DAY).map((r) => [r.camera_id, r.n]));
    const alarmCount = new Map(); alarms.forEach((a) => alarmCount.set(a.camera_id, (alarmCount.get(a.camera_id) || 0) + 1));
    const rec7 = new Map(); recRows.filter((r) => r.ts > now - 7 * DAY).forEach((r) => rec7.set(r.camera_id, (rec7.get(r.camera_id) || 0) + 1));
    const health = cameras.map((c) => {
        const flags = [];
        const batteryOld = c.batteryTs ? now - c.batteryTs : null;
        if (c.battery != null && c.battery < 20) flags.push('low_battery');
        if (!c.online && c.ts && now - c.ts > DAY) flags.push('offline_24h');
        if (c.online && (!c.fixTs || now - c.fixTs > 2 * HOUR)) flags.push('no_gps');
        if ((offEvents.get(c.cameraId) || 0) > 10) flags.push('unstable');
        return { id: c.cameraId, name: c.name || c.cameraId, holder: c.holder || null, online: !!c.online, recording: !!c.recording, battery: c.battery ?? null, batteryAgeMin: batteryOld == null ? null : Math.round(batteryOld / 60000),
            lastSeen: c.ts || null, gpsFixAgeMin: c.fixTs ? Math.round((now - c.fixTs) / 60000) : null, alarms30d: alarmCount.get(c.cameraId) || 0, recordings7d: rec7.get(c.cameraId) || 0, offlineEvents7d: offEvents.get(c.cameraId) || 0, flags };
    });
    const healthy = health.filter((h) => !h.flags.length).length;

    // ---- storage
    let disk = null;
    if (staff && recordingsDir) { try { const f = fs.statfsSync(recordingsDir); disk = { totalBytes: f.blocks * f.bsize, freeBytes: f.bavail * f.bsize }; } catch { /* not supported */ } }
    const growth = recDays.slice(-7).reduce((a, d) => a + d.bytes, 0) / 7;   // bytes added per day, last week
    const daysLeft = disk && growth > 0 ? Math.floor(disk.freeBytes / growth) : null;

    const audit = auditlog.verify(db);

    // ---- findings
    const out = [];
    const add = (severity, id, title, detail, extra) => out.push({ severity, id, title, detail, ...(extra || {}) });
    if (!audit.ok) add('critical', 'audit', 'The audit trail does not verify', `A line was changed or removed near entry #${audit.firstBadId}. Treat this as a security incident and keep a copy of the database.`);
    if (unacked.length) add('critical', 'sos', `${unacked.length} SOS alarm${unacked.length === 1 ? ' has' : 's have'} not been acknowledged`, 'An alarm older than 5 minutes is still open. Open the live dashboard and acknowledge it.');
    if (pipeline.failed.n) add('critical', 'failed', `${pipeline.failed.n} file${pipeline.failed.n === 1 ? '' : 's'} failed to upload`, 'The dock retries automatically. If it keeps failing, check the dock PC\'s connection to the server.');
    const ageH = oldestAwaiting ? Math.round((now - oldestAwaiting) / HOUR) : 0;
    if (pipeline.awaiting.n) add(ageH >= 24 ? 'warning' : 'info', 'awaiting', `${pipeline.awaiting.n} file${pipeline.awaiting.n === 1 ? ' is' : 's are'} waiting for your decision`, `${(pipeline.awaiting.bytes / 1e9).toFixed(1)} GB on the dock${ageH >= 1 ? `; the oldest has waited ${ageH} h` : ''}. Open Docking > Files to push to the cloud or keep on the dock, or switch on an automatic mode.`);
    health.filter((h) => h.flags.includes('low_battery')).forEach((h) => add(h.battery < 10 ? 'critical' : 'warning', 'bat_' + h.id, `${h.name} battery is ${h.battery}%`, `Last read ${h.batteryAgeMin == null ? 'a while' : h.batteryAgeMin + ' min'} ago. Put it on the dock to charge.`, { camera: h.id }));
    health.filter((h) => h.flags.includes('offline_24h')).forEach((h) => add('warning', 'off_' + h.id, `${h.name} has been offline for over a day`, `Last seen ${new Date(h.lastSeen).toLocaleString('en')}. Check that it is charged and has a network.`, { camera: h.id }));
    health.filter((h) => h.flags.includes('unstable')).forEach((h) => add('warning', 'flap_' + h.id, `${h.name} keeps dropping offline`, `${h.offlineEvents7d} disconnections in 7 days. Likely a weak network or a failing SIM/Wi-Fi.`, { camera: h.id }));
    const noGps = health.filter((h) => h.flags.includes('no_gps'));
    if (noGps.length) add('info', 'gps', `${noGps.length} online camera${noGps.length === 1 ? ' has' : 's have'} no recent GPS fix`, `${noGps.slice(0, 5).map((h) => h.name).join(', ')}${noGps.length > 5 ? '…' : ''}. Indoors or on the dock this is normal; outdoors it needs a look.`);
    const today = alarmDays[13].count, prevAvg = alarmDays.slice(7, 13).reduce((a, d) => a + d.count, 0) / 6;
    if (today >= 3 && today > prevAvg * 2) add('warning', 'spike', `SOS alarms are up today (${today} vs ${prevAvg.toFixed(1)}/day)`, 'More than double the recent daily average.');
    const rw = resp(thisWeek), rl = resp(lastWeek);
    if (rw != null && rl != null && rl > 0 && rw > rl * 1.5 && rw > 60) add('warning', 'resp', `Alarm response is slower (${rw}s vs ${rl}s last week)`, 'Review who is on duty at the control room.');
    if (disk && disk.freeBytes / disk.totalBytes < 0.15) add('critical', 'disk', `Server storage is ${Math.round((1 - disk.freeBytes / disk.totalBytes) * 100)}% full`, `${(disk.freeBytes / 1e9).toFixed(0)} GB free.`);
    else if (daysLeft != null && daysLeft < 14) add('warning', 'disk_days', `Storage may run out in about ${daysLeft} days`, 'At the current recording growth. Use "Keep on dock storage" or a shorter retention.');
    const idle = health.filter((h) => h.online && !h.recordings7d && !pipeline.awaiting.n && h.alarms30d === 0);
    if (idle.length && cameras.length > 1) add('info', 'idle', `${idle.length} camera${idle.length === 1 ? '' : 's'} sent nothing to the cloud this week`, `${idle.slice(0, 5).map((h) => h.name).join(', ')}. They may be unused or their files are kept on the dock.`);
    if (audit.ok && audit.checked) add('good', 'audit_ok', 'Audit trail verified', `${audit.checked} recorded steps checked, none changed or removed.`);
    if (cameras.length && healthy === cameras.length) add('good', 'all_good', 'Every camera looks healthy', 'Battery, connection and GPS are fine on all cameras.');
    const rank = { critical: 0, warning: 1, info: 2, good: 3 };
    out.sort((a, b) => rank[a.severity] - rank[b.severity]);

    return {
        generatedAt: now, scope: { cameras: cameras.length },
        score: cameras.length ? Math.round((healthy / cameras.length) * 100) : null,
        recordings: { days: recDays, cloudBytes, cloudFiles: allRec.length, last14: recDays.reduce((a, d) => a + d.count, 0), last14Bytes: recDays.reduce((a, d) => a + d.bytes, 0) },
        pipeline: { ...pipeline, oldestAwaitingHours: oldestAwaiting ? ageH : null, removedFromCameras },
        alarms: { byHour, days: alarmDays, thisWeek: thisWeek.length, lastWeek: lastWeek.length, avgResponseThisWeekSec: rw, avgResponseLastWeekSec: rl, unacked: unacked.length },
        storage: { disk, growthBytesPerDay: Math.round(growth), daysLeft },
        health, audit: { ok: audit.ok, checked: audit.checked, head: audit.head, total: audit.total, legacy: audit.legacy || 0 },
        insights: out,
    };
}

/** A written summary even without an AI key: the findings in plain language. */
function plainSummary(a) {
    const lines = [];
    lines.push(`Fleet health score ${a.score ?? '-'}% across ${a.scope.cameras} camera${a.scope.cameras === 1 ? '' : 's'}.`);
    const crit = a.insights.filter((i) => i.severity === 'critical'), warn = a.insights.filter((i) => i.severity === 'warning');
    if (crit.length) lines.push('Needs attention now: ' + crit.map((i) => i.title).join('; ') + '.');
    if (warn.length) lines.push('Watch: ' + warn.slice(0, 5).map((i) => i.title).join('; ') + '.');
    if (!crit.length && !warn.length) lines.push('Nothing needs attention.');
    lines.push(`Evidence: ${a.pipeline.cloud.n} files in the cloud, ${a.pipeline.local.n} kept on the dock, ${a.pipeline.awaiting.n} waiting for a decision.`);
    return lines.join('\n');
}

/** Optional written analysis by Claude. Only aggregated numbers and camera names are sent, never video, file names or users. Off unless ANTHROPIC_API_KEY is set. */
async function aiNarrative(a, { fetchImpl = fetch, env = process.env } = {}) {
    if (!env.ANTHROPIC_API_KEY) return { ai: false, text: plainSummary(a) };
    const facts = {
        healthScorePercent: a.score, cameras: a.scope.cameras,
        cameraHealth: a.health.map((h) => ({ camera: h.name, online: h.online, battery: h.battery, flags: h.flags, alarms30d: h.alarms30d, recordings7d: h.recordings7d, offlineEvents7d: h.offlineEvents7d })),
        pipeline: a.pipeline, alarms: { ...a.alarms, byHour: a.alarms.byHour.filter((x) => x.count).map((x) => `${x.hour}h:${x.count}`) },
        storage: a.storage, findings: a.insights.map((i) => `${i.severity}: ${i.title}`),
        recordingsPerDay14d: a.recordings.days.map((d) => d.count),
    };
    const r = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
            model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', max_tokens: 700,
            system: 'You are the operations analyst of a body-worn-camera platform. From the JSON facts, write a short briefing for the fleet owner: 1) a two-sentence overall assessment, 2) the three most important things to do, most urgent first, each with the reason, 3) one pattern or risk you notice in the numbers. Use only the facts given, never invent numbers, no markdown headings, plain short sentences.',
            messages: [{ role: 'user', content: JSON.stringify(facts) }],
        }),
    });
    if (!r.ok) return { ai: false, text: plainSummary(a), error: `AI service answered ${r.status}` };
    const j = await r.json();
    const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return text ? { ai: true, model: j.model || env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', text } : { ai: false, text: plainSummary(a) };
}

module.exports = { build, plainSummary, aiNarrative };
