// Operations analytics for the Analytics page: fleet health, the evidence pipeline (dock -> cloud), trends, and plain-language findings.
// Everything is computed from the server's own data and scoped to the cameras the user may see.
const fs = require('fs');
const auditlog = require('./auditlog');
const { isLow, LOW, CRITICAL } = require('./battery');
const i18n = require('./i18n');

const DAY = 86400000, HOUR = 3600000;
const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const label = (t) => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric' });

// lang: 'en' or 'ar'. Every sentence below is written in it (the keys are in lang/texts.js); the numbers and names are the same in both.
function build({ db, cameras, recordingsDir, staff, now = Date.now(), lang = 'en' }) {
    const T = (key, params) => i18n.tr(lang, key, params);
    const when = (ts) => (lang === 'ar' ? new Date(ts).toLocaleString('ar-SA-u-ca-gregory-nu-latn') : new Date(ts).toLocaleString('en'));
    const ids = new Set(cameras.map((c) => c.cameraId));
    const inScope = (id) => ids.has(id);

    // ---- recordings in the cloud, last 14 days
    const recRows = db.prepare('SELECT camera_id,size,COALESCE(recorded_ts,uploaded_ts) ts FROM recordings WHERE COALESCE(recorded_ts,uploaded_ts) > ?').all(now - 14 * DAY).filter((r) => inScope(r.camera_id));
    const recDays = [];
    for (let i = 13; i >= 0; i--) {
        const from = dayStart(now - i * DAY), rs = recRows.filter((r) => r.ts >= from && r.ts < from + DAY);
        recDays.push({ day: label(from), ts: from, count: rs.length, bytes: rs.reduce((a, r) => a + r.size, 0) });
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
    for (let i = 13; i >= 0; i--) { const from = dayStart(now - i * DAY); alarmDays.push({ day: label(from), ts: from, count: alarms.filter((a) => a.ts >= from && a.ts < from + DAY).length }); }
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
        if (isLow(c)) flags.push('low_battery');   // below 20 % and not on a charger
        if (!c.online && c.ts && now - c.ts > DAY) flags.push('offline_24h');
        if (c.online && (!c.fixTs || now - c.fixTs > 2 * HOUR)) flags.push('no_gps');
        if ((offEvents.get(c.cameraId) || 0) > 10) flags.push('unstable');
        return { id: c.cameraId, name: c.name || c.cameraId, holder: c.holder || null, online: !!c.online, recording: !!c.recording, battery: c.battery ?? null, charging: !!c.charging, batterySrc: c.batterySrc || null, batteryAgeMin: batteryOld == null ? null : Math.round(batteryOld / 60000),
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
    const names = (list) => list.slice(0, 5).map((h) => h.name).join(lang === 'ar' ? '، ' : ', ') + (list.length > 5 ? '…' : '');
    if (!audit.ok) add('critical', 'audit', T('ins.audit.title'), T('ins.audit.detail', { id: audit.firstBadId }));
    if (unacked.length) add('critical', 'sos', T('ins.sos.title', { n: unacked.length }), T('ins.sos.detail'));
    if (pipeline.failed.n) add('critical', 'failed', T('ins.failed.title', { n: pipeline.failed.n }), T('ins.failed.detail'));
    const ageH = oldestAwaiting ? Math.round((now - oldestAwaiting) / HOUR) : 0;
    if (pipeline.awaiting.n) add(ageH >= 24 ? 'warning' : 'info', 'awaiting', T('ins.awaiting.title', { n: pipeline.awaiting.n }), T(ageH >= 1 ? 'ins.awaiting.detailAge' : 'ins.awaiting.detail', { gb: (pipeline.awaiting.bytes / 1e9).toFixed(1), h: ageH }));
    health.filter((h) => h.flags.includes('low_battery')).forEach((h) => add(h.battery < 10 ? 'critical' : 'warning', 'bat_' + h.id, T('ins.bat.title', { name: h.name, pct: h.battery }), h.batteryAgeMin == null ? T('ins.bat.detailWhile') : T('ins.bat.detail', { min: h.batteryAgeMin }), { camera: h.id }));
    health.filter((h) => h.flags.includes('offline_24h')).forEach((h) => add('warning', 'off_' + h.id, T('ins.off.title', { name: h.name }), T('ins.off.detail', { when: when(h.lastSeen) }), { camera: h.id }));
    health.filter((h) => h.flags.includes('unstable')).forEach((h) => add('warning', 'flap_' + h.id, T('ins.flap.title', { name: h.name }), T('ins.flap.detail', { n: h.offlineEvents7d }), { camera: h.id }));
    const noGps = health.filter((h) => h.flags.includes('no_gps'));
    if (noGps.length) add('info', 'gps', T('ins.gps.title', { n: noGps.length }), T('ins.gps.detail', { names: names(noGps) }));
    const today = alarmDays[13].count, prevAvg = alarmDays.slice(7, 13).reduce((a, d) => a + d.count, 0) / 6;
    if (today >= 3 && today > prevAvg * 2) add('warning', 'spike', T('ins.spike.title', { today, avg: prevAvg.toFixed(1) }), T('ins.spike.detail'));
    const rw = resp(thisWeek), rl = resp(lastWeek);
    if (rw != null && rl != null && rl > 0 && rw > rl * 1.5 && rw > 60) add('warning', 'resp', T('ins.resp.title', { now: rw, before: rl }), T('ins.resp.detail'));
    if (disk && disk.freeBytes / disk.totalBytes < 0.15) add('critical', 'disk', T('ins.disk.title', { pct: Math.round((1 - disk.freeBytes / disk.totalBytes) * 100) }), T('ins.disk.detail', { gb: (disk.freeBytes / 1e9).toFixed(0) }));
    else if (daysLeft != null && daysLeft < 14) add('warning', 'disk_days', T('ins.diskDays.title', { n: daysLeft }), T('ins.diskDays.detail'));
    const idle = health.filter((h) => h.online && !h.recordings7d && !pipeline.awaiting.n && h.alarms30d === 0);
    if (idle.length && cameras.length > 1) add('info', 'idle', T('ins.idle.title', { n: idle.length }), T('ins.idle.detail', { names: names(idle) }));
    if (audit.ok && audit.checked) add('good', 'audit_ok', T('ins.auditOk.title'), T('ins.auditOk.detail', { n: audit.checked }));
    if (cameras.length && healthy === cameras.length) add('good', 'all_good', T('ins.allGood.title'), T('ins.allGood.detail'));
    let subs = []; try { if (staff) subs = db.prepare('SELECT name, sub_end FROM companies WHERE sub_end IS NOT NULL').all(); } catch (e) { /* no companies table */ }
    for (const c of subs) {   // subscriptions about to end (Smart Way sees every company)
        const d = Math.ceil((c.sub_end - now) / DAY);
        if (d < 0) add('critical', 'sub_' + c.name, T('ins.subEnded.title', { name: c.name, n: -d }), T('ins.subEnded.detail'));
        else if (d <= 30) add(d <= 7 ? 'warning' : 'info', 'sub_' + c.name, T('ins.subEnds.title', { name: c.name, n: d }), T('ins.subEnds.detail', { date: new Date(c.sub_end).toISOString().slice(0, 10) }));
    }
    const rank = { critical: 0, warning: 1, info: 2, good: 3 };
    out.sort((a, b) => rank[a.severity] - rank[b.severity]);

    return {
        generatedAt: now, scope: { cameras: cameras.length },
        score: cameras.length ? Math.round((healthy / cameras.length) * 100) : null,
        recordings: { days: recDays, cloudBytes, cloudFiles: allRec.length, last14: recDays.reduce((a, d) => a + d.count, 0), last14Bytes: recDays.reduce((a, d) => a + d.bytes, 0) },
        pipeline: { ...pipeline, oldestAwaitingHours: oldestAwaiting ? ageH : null, removedFromCameras },
        alarms: { byHour, days: alarmDays, thisWeek: thisWeek.length, lastWeek: lastWeek.length, avgResponseThisWeekSec: rw, avgResponseLastWeekSec: rl, unacked: unacked.length },
        storage: { disk, growthBytesPerDay: Math.round(growth), daysLeft },
        battery: { low: health.filter((h) => h.flags.includes('low_battery')).length, critical: health.filter((h) => h.flags.includes('low_battery') && h.battery < CRITICAL).length,
            known: health.filter((h) => h.battery != null).length, charging: health.filter((h) => h.charging).length, threshold: LOW },
        health, audit: { ok: audit.ok, checked: audit.checked, head: audit.head, total: audit.total, legacy: audit.legacy || 0 },
        insights: out,
    };
}

/** A written summary even without an AI key: the findings in plain language. */
function plainSummary(a, lang = 'en') {
    const T = (key, params) => i18n.tr(lang, key, params), sep = T('plain.sep');
    const lines = [];
    lines.push(T('plain.score', { score: a.score ?? '-', n: a.scope.cameras }));
    const crit = a.insights.filter((i) => i.severity === 'critical'), warn = a.insights.filter((i) => i.severity === 'warning');
    if (crit.length) lines.push(T('plain.now', { list: crit.map((i) => i.title).join(sep) }));
    if (warn.length) lines.push(T('plain.watch', { list: warn.slice(0, 5).map((i) => i.title).join(sep) }));
    if (!crit.length && !warn.length) lines.push(T('plain.none'));
    lines.push(T('plain.evidence', { cloud: a.pipeline.cloud.n, local: a.pipeline.local.n, waiting: a.pipeline.awaiting.n }));
    return lines.join('\n');
}

/** Optional written analysis by Claude. Only aggregated numbers and camera names are sent, never video, file names or users. Off unless ANTHROPIC_API_KEY is set. */
async function aiNarrative(a, { fetchImpl = fetch, env = process.env, lang = 'en' } = {}) {
    if (!env.ANTHROPIC_API_KEY) return { ai: false, text: plainSummary(a, lang) };
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
            system: 'You are the operations analyst of a body-worn-camera platform. From the JSON facts, write a short briefing for the fleet owner: 1) a two-sentence overall assessment, 2) the three most important things to do, most urgent first, each with the reason, 3) one pattern or risk you notice in the numbers. Use only the facts given, never invent numbers, no markdown headings, plain short sentences. ' + i18n.tr(lang, 'ai.askLang'),
            messages: [{ role: 'user', content: JSON.stringify(facts) }],
        }),
    });
    if (!r.ok) return { ai: false, text: plainSummary(a, lang), error: `AI service answered ${r.status}` };
    const j = await r.json();
    const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return text ? { ai: true, model: j.model || env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', text } : { ai: false, text: plainSummary(a, lang) };
}

module.exports = { build, plainSummary, aiNarrative };
