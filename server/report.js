// Daily operations report (PDF) for a company or for all companies.
const PDFDocument = require('pdfkit');
const path = require('path');

const W = 595.28, H = 841.89, M = 38;
const C = {
    ink: '#0F1B2D', mut: '#62738C', line: '#DDE4EE', soft: '#F3F6FB', white: '#FFFFFF',
    navy: '#150F3D', brand: '#5E4A9E', violet: '#7C5CFF', blue: '#2F7BFF', teal: '#12C2C2',
    ok: '#00B87C', rec: '#FF3355', amber: '#FFB300',
};
const LOGO = path.join(__dirname, 'public', 'logo-dark.png');

// Fonts only cover Latin: anything else (e.g. Arabic names) is replaced so the page never shows broken glyphs.
const latin = (s, fb = '-') => {
    const t = String(s ?? '').replace(/[^\x20-\x7E -ɏ]/g, '').trim();
    return t || fb;
};
const pad = (n) => String(n).padStart(2, '0');
const hm = (ms) => { const m = Math.round(ms / 60000); return `${Math.floor(m / 60)}h ${pad(m % 60)}m`; };
const clock = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const km = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
const secs = (s) => (s == null ? '-' : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${pad(s % 60)}s` : `${(s / 3600).toFixed(1)}h`);

function haversine(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
}

// ---------------------------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------------------------
function gather(db, cameras, from, to) {
    const ids = cameras.map((c) => c.cameraId);
    const byId = new Map(cameras.map((c) => [c.cameraId, c]));
    const end = Math.min(Date.now(), to);
    const out = {
        from, to, end, cameras, perCam: new Map(), alarms: [], recs: [], timeline: [], actions: [], hours: new Array(24).fill(0),
        totals: { online: 0, recMs: 0, recSessions: 0, km: 0, msgs: 0, voice: 0, ptt: 0, active: 0 },
    };
    ids.forEach((id) => out.perCam.set(id, { id, onlineMs: 0, recMs: 0, sessions: 0, meters: 0, alarms: 0, ptt: 0, msgs: 0, voice: 0, first: null, last: null, hours: new Set() }));
    if (!ids.length) return out;
    const ph = ids.map(() => '?').join(',');

    const events = db.prepare(`SELECT ts,camera_id,type,info FROM events WHERE ts >= ? AND ts < ? AND camera_id IN (${ph}) ORDER BY ts`).all(from, to, ...ids);
    const pos = db.prepare(`SELECT camera_id,lat,lng,ts FROM positions WHERE ts >= ? AND ts < ? AND camera_id IN (${ph}) ORDER BY camera_id, ts`).all(from, to, ...ids);
    const alarms = db.prepare(`SELECT id,camera_id,ts,ack_ts,ack_by FROM alarms WHERE ts >= ? AND ts < ? AND camera_id IN (${ph}) ORDER BY ts`).all(from, to, ...ids);
    const audit = db.prepare(`SELECT ts,username,action,camera_id FROM audit WHERE ts >= ? AND ts < ? AND camera_id IN (${ph}) ORDER BY ts`).all(from, to, ...ids);

    const touch = (id, ts) => {
        const p = out.perCam.get(id); if (!p) return;
        p.first = p.first == null ? ts : Math.min(p.first, ts);
        p.last = p.last == null ? ts : Math.max(p.last, ts);
        const h = new Date(ts).getHours(); p.hours.add(h);
    };

    // state before the day began (was the camera online / recording at 00:00?)
    const last = db.prepare("SELECT type FROM events WHERE camera_id = ? AND type IN (?,?) AND ts < ? ORDER BY ts DESC LIMIT 1");
    for (const id of ids) {
        const p = out.perCam.get(id);
        const mine = events.filter((e) => e.camera_id === id);
        let on = last.get(id, 'online', 'offline', from)?.type === 'online';
        let rec = last.get(id, 'rec_start', 'rec_stop', from)?.type === 'rec_start';
        let curOn = from, curRec = from;
        for (const e of mine) {
            touch(id, e.ts);
            if (e.type === 'online' && !on) { on = true; curOn = e.ts; }
            else if (e.type === 'offline' && on) { on = false; p.onlineMs += e.ts - curOn; }
            else if (e.type === 'rec_start' && !rec) { rec = true; curRec = e.ts; p.sessions++; }
            else if (e.type === 'rec_stop' && rec) { rec = false; p.recMs += e.ts - curRec; out.recs.push({ cam: id, start: curRec, end: e.ts }); }
            else if (e.type === 'ptt_start') p.ptt++;
            else if (e.type === 'msg') p.msgs++;
            else if (e.type === 'voice') p.voice++;
        }
        if (on) p.onlineMs += end - curOn;
        if (rec) { p.recMs += end - curRec; out.recs.push({ cam: id, start: curRec, end: null }); }
        if (on || rec) { /* still active at the end of the window */ }
    }

    // distance (ignore GPS jumps faster than 150 km/h) and hourly presence
    let prev = null;
    for (const p of pos) {
        const st = out.perCam.get(p.camera_id);
        touch(p.camera_id, p.ts);
        if (prev && prev.camera_id === p.camera_id) {
            const d = haversine(prev, p), dt = (p.ts - prev.ts) / 1000;
            if (dt > 0 && d / dt < 42) st.meters += d;
        }
        prev = p;
    }
    for (const a of alarms) {
        touch(a.camera_id, a.ts);
        out.perCam.get(a.camera_id).alarms++;
        out.alarms.push({ ...a, resp: a.ack_ts ? Math.round((a.ack_ts - a.ts) / 1000) : null });
    }
    for (const p of out.perCam.values()) p.hours.forEach((h) => { out.hours[h]++; });

    // totals
    const t = out.totals;
    for (const p of out.perCam.values()) {
        t.recMs += p.recMs; t.recSessions += p.sessions; t.km += p.meters; t.msgs += p.msgs; t.voice += p.voice; t.ptt += p.ptt;
        if (p.first != null || p.onlineMs > 0) t.active++;
    }

    // control-room actions
    const label = (a) => (a === 'remote_stream_start' ? 'Live view started remotely' : a === 'remote_stream_stop' ? 'Remote live view stopped'
        : a.startsWith('set_quality_') ? `Video quality set to ${a.slice(12)}` : a.startsWith('update_app_') ? 'App update sent' : a);
    for (const a of audit) out.actions.push({ ts: a.ts, who: a.username, camera: a.camera_id, text: label(a.action) });

    // timeline of notable moments
    const tl = [];
    for (const a of alarms) {
        tl.push({ ts: a.ts, kind: 'sos', cam: a.camera_id, text: 'SOS alarm raised' });
        if (a.ack_ts) tl.push({ ts: a.ack_ts, kind: 'ack', cam: a.camera_id, text: `SOS acknowledged by ${latin(a.ack_by, 'dispatcher')}` });
    }
    for (const e of events) {
        if (e.type === 'online') tl.push({ ts: e.ts, kind: 'on', cam: e.camera_id, text: 'Camera came online' });
        else if (e.type === 'offline') tl.push({ ts: e.ts, kind: 'off', cam: e.camera_id, text: 'Camera went offline' });
    }
    for (const r of out.recs) {
        tl.push({ ts: r.start, kind: 'rec', cam: r.cam, text: r.end ? `Recording ${clock(r.start)} - ${clock(r.end)}  (${hm(r.end - r.start)})` : `Recording since ${clock(r.start)}  (in progress)` });
    }
    for (const a of out.actions) tl.push({ ts: a.ts, kind: 'act', cam: a.camera, text: `${a.text} (${latin(a.who)})` });
    out.timeline = tl.sort((a, b) => a.ts - b.ts);
    return out;
}

// ---------------------------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------------------------
const grad = (doc, x0, y0, x1, y1, stops) => { const g = doc.linearGradient(x0, y0, x1, y1); stops.forEach(([o, c, a]) => g.stop(o, c, a)); return g; };

function wave(doc, y, amp, len, phase, color, op, w = 1.2) {
    doc.save().opacity(op).lineWidth(w).strokeColor(color);
    doc.moveTo(-10, y);
    for (let x = -10; x < W + 30; x += len) {
        doc.bezierCurveTo(x + len * 0.25, y - amp + phase, x + len * 0.75, y + amp + phase, x + len, y);
    }
    doc.stroke().restore();
}

function banner(doc, h, big) {
    doc.save();
    doc.rect(0, 0, W, h).clip();
    doc.rect(0, 0, W, h).fill(grad(doc, 0, 0, W, h, [[0, C.navy], [0.45, C.brand], [0.8, C.blue], [1, C.teal]]));
    // soft glows and rings: the "motion" of the page
    doc.save().opacity(0.22).circle(W - 70, 20, 150).fill(grad(doc, W - 220, -130, W + 80, 170, [[0, '#FFFFFF', 0.9], [1, '#FFFFFF', 0]])).restore();
    doc.save().opacity(0.16).circle(60, h + 10, 120).fill('#7C5CFF').restore();
    for (let i = 0; i < 4; i++) doc.save().opacity(0.10 - i * 0.015).lineWidth(1.4).circle(W - 90, big ? 95 : 25, 60 + i * 28).stroke('#FFFFFF').restore();
    if (big) {
        for (let i = 0; i < 6; i++) wave(doc, 118 + i * 14, 16 + i * 2, 120, i * 5, '#FFFFFF', 0.10 - i * 0.012);
        // dotted trail, like a patrol route
        doc.save().opacity(0.35).fillColor('#FFFFFF');
        for (let i = 0; i < 26; i++) doc.circle(40 + i * 12, 152 - Math.sin(i / 3) * 14 - i * 0.9, i % 5 === 0 ? 1.8 : 1).fill();
        doc.restore();
    }
    doc.restore();
}

function shadowCard(doc, x, y, w, h, r = 12) {
    for (let i = 4; i >= 1; i--) doc.save().opacity(0.018 * i).roundedRect(x - i + 1, y + i + 1, w + 2 * i - 2, h + 2 * i - 2, r + i).fill('#0F1B2D').restore();
    doc.roundedRect(x, y, w, h, r).fill(C.white);
    doc.roundedRect(x, y, w, h, r).lineWidth(0.6).stroke(C.line);
}

function heading(doc, x, y, text, sub) {
    doc.roundedRect(x, y + 1, 4, 14, 2).fill(grad(doc, x, y, x, y + 16, [[0, C.amber], [1, C.violet]]));
    doc.font('Helvetica-Bold').fontSize(8.6).fillColor(C.mut).text(text.toUpperCase(), x + 12, y + 3, { characterSpacing: 1.4, lineBreak: false });
    if (sub) doc.font('Helvetica').fontSize(8).fillColor(C.mut).text(sub, x, y + 3, { width: W - M - x, align: 'right', lineBreak: false });
}

function icon(doc, kind, cx, cy) {
    doc.save().lineWidth(1.6).lineCap('round').lineJoin('round').strokeColor('#FFFFFF').fillColor('#FFFFFF');
    if (kind === 'cam') { doc.roundedRect(cx - 7, cy - 4.5, 10, 9, 2).stroke(); doc.moveTo(cx + 3, cy - 1).lineTo(cx + 8, cy - 4).lineTo(cx + 8, cy + 4).lineTo(cx + 3, cy + 1).stroke(); }
    else if (kind === 'sos') { doc.moveTo(cx, cy - 7).lineTo(cx + 7, cy + 5).lineTo(cx - 7, cy + 5).closePath().stroke(); doc.moveTo(cx, cy - 2).lineTo(cx, cy + 1).stroke(); doc.circle(cx, cy + 3.2, 0.5).fill(); }
    else if (kind === 'clock') { doc.circle(cx, cy, 7).stroke(); doc.moveTo(cx, cy - 4).lineTo(cx, cy).lineTo(cx + 3.5, cy + 2).stroke(); }
    else if (kind === 'pin') { doc.circle(cx, cy - 2, 4.2).stroke(); doc.moveTo(cx - 3.6, cy + 1).lineTo(cx, cy + 7).lineTo(cx + 3.6, cy + 1).stroke(); }
    else if (kind === 'rec') { doc.circle(cx, cy, 7).stroke(); doc.circle(cx, cy, 3).fill(); }
    else if (kind === 'chat') { doc.roundedRect(cx - 7, cy - 6, 14, 10, 3).stroke(); doc.moveTo(cx - 2, cy + 4).lineTo(cx - 4, cy + 8).lineTo(cx + 1, cy + 4).stroke(); }
    doc.restore();
}

function kpi(doc, x, y, w, h, label, value, sub, kind, g0, g1) {
    shadowCard(doc, x, y, w, h);
    doc.circle(x + 25, y + 25, 14).fill(grad(doc, x + 11, y + 11, x + 39, y + 39, [[0, g0], [1, g1]]));
    doc.save().opacity(0.22).circle(x + 25, y + 25, 18).lineWidth(2.5).stroke(g1).restore();
    icon(doc, kind, x + 25, y + 25);
    doc.font('Helvetica-Bold').fontSize(7.2).fillColor(C.mut).text(label.toUpperCase(), x + 47, y + 19, { characterSpacing: 0.6, width: w - 52, lineBreak: false, ellipsis: true });
    // the number gets the whole card width and shrinks to fit
    let fs = 23;
    doc.font('Helvetica-Bold');
    while (fs > 11 && doc.fontSize(fs).widthOfString(String(value)) > w - 24) fs -= 1;
    doc.fontSize(fs).fillColor(C.ink).text(String(value), x + 14, y + 46 - fs * 0.3, { width: w - 24, lineBreak: false });
    doc.font('Helvetica').fontSize(7.4).fillColor(C.mut).text(sub || '', x + 14, y + h - 17, { width: w - 24, lineBreak: false, ellipsis: true });
}

function arc(doc, cx, cy, r, a0, a1, width, color) {
    const sx = cx + r * Math.cos(a0), sy = cy + r * Math.sin(a0);
    const ex = cx + r * Math.cos(a1), ey = cy + r * Math.sin(a1);
    const large = a1 - a0 > Math.PI ? 1 : 0;
    doc.save().lineWidth(width).lineCap('butt').path(`M ${sx} ${sy} A ${r} ${r} 0 ${large} 1 ${ex} ${ey}`).stroke(color).restore();
}

function donut(doc, cx, cy, r, thick, parts, centerTop, centerBottom) {
    const total = parts.reduce((s, p) => s + p.v, 0);
    doc.save().lineWidth(thick).circle(cx, cy, r).stroke('#E8EDF5').restore();
    if (total > 0) {
        let a = -Math.PI / 2;
        for (const p of parts.filter((q) => q.v > 0)) {
            const sweep = (p.v / total) * Math.PI * 2;
            if (sweep > Math.PI * 2 - 0.01) doc.save().lineWidth(thick).circle(cx, cy, r).stroke(p.c).restore();
            else arc(doc, cx, cy, r, a + 0.02, a + sweep - 0.02, thick, p.c);
            a += sweep;
        }
    }
    doc.font('Helvetica-Bold').fontSize(22).fillColor(C.ink).text(String(centerTop), cx - 40, cy - 14, { width: 80, align: 'center', lineBreak: false });
    doc.font('Helvetica').fontSize(7.5).fillColor(C.mut).text(centerBottom.toUpperCase(), cx - 40, cy + 10, { width: 80, align: 'center', characterSpacing: 0.7, lineBreak: false });
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------
function build(db, { title, scopeLabel, cameras, from, to, regionOf, nameOf }, res) {
    const d = gather(db, cameras, from, to);
    const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, info: { Title: `VisionGuard daily report - ${scopeLabel}`, Author: 'VisionGuard', Subject: title } });
    doc.pipe(res);

    const dayLabel = new Date(from).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const isToday = to > Date.now() && from <= Date.now();
    const sos = d.alarms.length, acked = d.alarms.filter((a) => a.ack_ts).length;
    const resp = d.alarms.filter((a) => a.resp != null);
    const avgResp = resp.length ? Math.round(resp.reduce((s, a) => s + a.resp, 0) / resp.length) : null;
    const online = cameras.filter((c) => c.online).length;

    // ---- page 1: banner
    banner(doc, 215, true);
    try { doc.image(LOGO, M, 28, { height: 24 }); } catch (e) { /* logo optional */ }
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#FFFFFF').opacity(0.85).text('DAILY OPERATIONS REPORT', M, 78, { characterSpacing: 3, lineBreak: false }).opacity(1);
    doc.font('Helvetica-Bold').fontSize(30).fillColor('#FFFFFF').text(latin(scopeLabel, 'All companies'), M, 94, { width: W - 2 * M - 120, lineBreak: false, ellipsis: true });
    doc.font('Helvetica').fontSize(13).fillColor('#FFFFFF').opacity(0.92).text(dayLabel, M, 136, { lineBreak: false }).opacity(1);
    doc.save().fillOpacity(0.18).roundedRect(M, 160, 168, 20, 10).fill('#FFFFFF').restore();
    doc.font('Helvetica-Bold').fontSize(7.8).fillColor('#FFFFFF').text(`${isToday ? 'LIVE DAY, UP TO ' + clock(d.end) : 'FULL DAY 00:00 - 23:59'}`, M + 12, 166, { characterSpacing: 0.8, lineBreak: false });

    // ---- KPI cards
    const cw = (W - 2 * M - 3 * 10) / 4, ky = 188;
    kpi(doc, M, ky, cw, 78, 'Active cameras', `${d.totals.active}`, `of ${cameras.length} · ${online} online now`, 'cam', C.violet, C.blue);
    kpi(doc, M + (cw + 10), ky, cw, 78, 'SOS alarms', `${sos}`, sos ? `${acked} answered · avg ${secs(avgResp)}` : 'no emergency today', 'sos', '#FF7A59', C.rec);
    kpi(doc, M + 2 * (cw + 10), ky, cw, 78, 'Recorded time', d.totals.recMs ? hm(d.totals.recMs) : '0h 00m', `${d.totals.recSessions} session${d.totals.recSessions === 1 ? '' : 's'}`, 'rec', C.rec, C.amber);
    kpi(doc, M + 3 * (cw + 10), ky, cw, 78, 'Distance covered', km(d.totals.km), `${d.totals.ptt} PTT · ${d.totals.msgs + d.totals.voice} messages`, 'pin', C.teal, C.ok);

    // ---- fleet donut + hourly activity
    let y = 292;
    shadowCard(doc, M, y, 200, 160);
    heading(doc, M + 14, y + 12, 'Fleet right now');
    const rec = cameras.filter((c) => c.recording).length, idle = Math.max(0, online - rec), off = cameras.length - online;
    donut(doc, M + 62, y + 98, 38, 12, [{ v: rec, c: C.rec }, { v: idle, c: C.ok }, { v: off, c: '#B9C4D6' }], cameras.length, 'cameras');
    [['Recording', rec, C.rec], ['Online, idle', idle, C.ok], ['Offline', off, '#B9C4D6']].forEach(([l, v, c], i) => {
        doc.roundedRect(M + 118, y + 70 + i * 22, 9, 9, 3).fill(c);
        doc.font('Helvetica').fontSize(8.6).fillColor(C.ink).text(l, M + 133, y + 70 + i * 22 + 0.5, { lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(9).fillColor(C.ink).text(String(v), M + 118, y + 70 + i * 22 + 0.5, { width: 70, align: 'right', lineBreak: false });
    });

    const bx = M + 212, bw = W - M - bx;
    shadowCard(doc, bx, y, bw, 160);
    heading(doc, bx + 14, y + 12, 'Cameras reporting by hour', 'distinct cameras with activity');
    const maxH = Math.max(1, ...d.hours), cx0 = bx + 18, cwid = bw - 36, bwid = cwid / 24, base = y + 138, ch = 84;
    for (let g = 0; g <= 3; g++) doc.save().lineWidth(0.4).dash(2, { space: 2 }).moveTo(cx0, base - (ch * g) / 3).lineTo(cx0 + cwid, base - (ch * g) / 3).stroke('#E3E9F2').undash().restore();
    d.hours.forEach((v, i) => {
        const h = v ? Math.max(3, (v / maxH) * ch) : 1.5;
        doc.roundedRect(cx0 + i * bwid + 1.5, base - h, bwid - 3, h, 2).fill(v ? grad(doc, 0, base - h, 0, base, [[0, C.violet], [1, C.blue]]) : '#E8EDF5');
        if (i % 3 === 0) doc.font('Helvetica').fontSize(6.8).fillColor(C.mut).text(pad(i), cx0 + i * bwid - 2, base + 4, { width: bwid + 4, align: 'center', lineBreak: false });
    });
    if (d.hours.every((v) => v === 0)) doc.font('Helvetica-Oblique').fontSize(9).fillColor(C.mut).text('No activity recorded for this day.', bx, y + 80, { width: bw, align: 'center', lineBreak: false });

    // ---- helper for flowing sections
    const bottom = H - 52;
    let page = 1;
    const newPage = () => {
        doc.addPage(); page++;
        banner(doc, 46, false);
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#FFFFFF').text(`VisionGuard  |  ${latin(scopeLabel, 'All companies')}  |  ${dayLabel}`, M, 18, { characterSpacing: 0.6, lineBreak: false });
        y = 68;
    };
    const need = (h) => { if (y + h > bottom) newPage(); };

    // ---- SOS alarms
    y = 474;
    need(60);
    heading(doc, M, y, 'SOS alarms', `${sos} today`);
    y += 24;
    if (!d.alarms.length) {
        shadowCard(doc, M, y, W - 2 * M, 38);
        doc.circle(M + 22, y + 19, 8).fill(grad(doc, M + 14, y + 11, M + 30, y + 27, [[0, C.ok], [1, C.teal]]));
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(C.ink).text('No SOS alarms were raised.', M + 40, y + 11, { lineBreak: false });
        doc.font('Helvetica').fontSize(8.5).fillColor(C.mut).text('A quiet day for your fleet.', M + 40, y + 24, { lineBreak: false });
        y += 52;
    } else {
        const colX = [M + 14, M + 70, M + 170, M + 290, M + 390];
        const head = () => { doc.roundedRect(M, y, W - 2 * M, 20, 6).fill('#EEF2F9'); ['TIME', 'CAMERA', 'REGION', 'RESPONSE', 'STATUS'].forEach((t, i) => doc.font('Helvetica-Bold').fontSize(7.4).fillColor(C.mut).text(t, colX[i], y + 7, { characterSpacing: 0.8, lineBreak: false })); y += 24; };
        head();
        d.alarms.slice(0, 60).forEach((a, i) => {
            if (y + 22 > bottom) { newPage(); head(); }
            if (i % 2) doc.roundedRect(M, y - 3, W - 2 * M, 21, 5).fill('#F8FAFD');
            const cam = byIdSafe(cameras, a.camera_id);
            doc.font('Helvetica-Bold').fontSize(8.8).fillColor(C.ink).text(clock(a.ts), colX[0], y + 2, { lineBreak: false });
            doc.font('Helvetica').fontSize(8.8).fillColor(C.ink).text(latin(nameOf(cam), a.camera_id), colX[1], y + 2, { width: 95, lineBreak: false, ellipsis: true });
            doc.fillColor(C.mut).text(latin(regionOf(cam), '-'), colX[2], y + 2, { width: 110, lineBreak: false, ellipsis: true });
            doc.fillColor(C.ink).text(a.resp == null ? 'waiting' : secs(a.resp), colX[3], y + 2, { lineBreak: false });
            const ok = !!a.ack_ts;
            doc.roundedRect(colX[4], y - 0.5, 74, 14, 7).fill(ok ? '#DDF7EE' : '#FFE1E6');
            doc.font('Helvetica-Bold').fontSize(7.4).fillColor(ok ? '#008F62' : '#D01F3C').text(ok ? 'ACKNOWLEDGED' : 'OPEN', colX[4], y + 3.2, { width: 74, align: 'center', characterSpacing: 0.5, lineBreak: false });
            y += 21;
        });
        y += 14;
    }

    // ---- camera activity
    need(80);
    heading(doc, M, y, 'Camera activity', `${cameras.length} cameras`);
    y += 24;
    const cols = [M + 12, M + 128, M + 205, M + 278, M + 352, M + 410, M + 454, M + 498];
    const camHead = () => {
        doc.roundedRect(M, y, W - 2 * M, 20, 6).fill('#EEF2F9');
        ['CAMERA', 'REGION', 'ONLINE', 'RECORDED', 'DISTANCE', 'SOS', 'PTT', 'MSGS'].forEach((t, i) => doc.font('Helvetica-Bold').fontSize(7.2).fillColor(C.mut).text(t, cols[i], y + 7, { characterSpacing: 0.7, lineBreak: false }));
        y += 24;
    };
    camHead();
    const maxRec = Math.max(1, ...[...d.perCam.values()].map((p) => p.recMs));
    const rows = [...d.perCam.values()].sort((a, b) => b.recMs - a.recMs || b.onlineMs - a.onlineMs || a.id.localeCompare(b.id));
    rows.forEach((p, i) => {
        if (y + 24 > bottom) { newPage(); camHead(); }
        const cam = byIdSafe(cameras, p.id);
        if (i % 2) doc.roundedRect(M, y - 4, W - 2 * M, 24, 5).fill('#F8FAFD');
        doc.circle(M + 6, y + 6, 2.6).fill(cam?.recording ? C.rec : cam?.online ? C.ok : '#B9C4D6');
        doc.font('Helvetica-Bold').fontSize(8.8).fillColor(C.ink).text(latin(nameOf(cam), p.id), cols[0], y + 1, { width: 112, lineBreak: false, ellipsis: true });
        doc.font('Helvetica').fontSize(8.4).fillColor(C.mut).text(latin(regionOf(cam), '-'), cols[1], y + 1.4, { width: 72, lineBreak: false, ellipsis: true });
        doc.fillColor(C.ink).text(p.onlineMs ? hm(p.onlineMs) : '-', cols[2], y + 1.4, { lineBreak: false });
        doc.fillColor(C.ink).text(p.recMs ? hm(p.recMs) : '-', cols[3], y + 1.4, { lineBreak: false });
        if (p.recMs) doc.roundedRect(cols[3], y + 12, 62 * (p.recMs / maxRec), 3, 1.5).fill(grad(doc, cols[3], 0, cols[3] + 62, 0, [[0, C.rec], [1, C.amber]]));
        doc.fillColor(C.ink).text(p.meters ? km(p.meters) : '-', cols[4], y + 1.4, { lineBreak: false });
        doc.font('Helvetica-Bold').fillColor(p.alarms ? C.rec : C.mut).text(String(p.alarms || '-'), cols[5], y + 1.4, { lineBreak: false });
        doc.font('Helvetica').fillColor(C.ink).text(String(p.ptt || '-'), cols[6], y + 1.4, { lineBreak: false });
        doc.text(String(p.msgs + p.voice || '-'), cols[7], y + 1.4, { lineBreak: false });
        y += 24;
    });
    y += 12;

    // ---- control-room actions
    if (d.actions.length) {
        need(70);
        heading(doc, M, y, 'Control-room actions', `${d.actions.length} today`);
        y += 24;
        d.actions.slice(0, 25).forEach((a) => {
            if (y + 16 > bottom) newPage();
            doc.font('Helvetica-Bold').fontSize(8.4).fillColor(C.ink).text(clock(a.ts), M + 6, y, { lineBreak: false });
            doc.font('Helvetica').fillColor(C.ink).text(`${a.text}`, M + 48, y, { width: 260, lineBreak: false, ellipsis: true });
            doc.fillColor(C.mut).text(`${latin(nameOf(byIdSafe(cameras, a.camera)), a.camera || '-')}   by ${latin(a.who)}`, M + 300, y, { width: W - M - 300 - M, lineBreak: false, ellipsis: true });
            y += 16;
        });
        y += 10;
    }

    // ---- timeline
    need(80);
    heading(doc, M, y, 'Timeline', `${d.timeline.length} event${d.timeline.length === 1 ? '' : 's'}`);
    y += 26;
    if (!d.timeline.length) {
        doc.font('Helvetica-Oblique').fontSize(9).fillColor(C.mut).text('Events are logged from the moment this version of VisionGuard started recording them.', M + 6, y, { lineBreak: false });
        y += 20;
    } else {
        const colors = { sos: C.rec, ack: C.ok, rec: C.amber, recstop: '#E0A100', on: C.blue, off: '#9AA8BD', act: C.violet };
        const shown = d.timeline.slice(0, 70);
        const top = y;
        shown.forEach((e, i) => {
            if (y + 24 > bottom) { newPage(); }
            doc.save().lineWidth(1).moveTo(M + 68, y - 4).lineTo(M + 68, y + 20).stroke('#DDE4EE').restore();
            doc.font('Helvetica-Bold').fontSize(8.4).fillColor(C.ink).text(clock(e.ts), M + 6, y + 3, { lineBreak: false });
            doc.circle(M + 68, y + 6, 4.6).fill('#FFFFFF');
            doc.circle(M + 68, y + 6, 3.4).fill(colors[e.kind] || C.mut);
            doc.font('Helvetica').fontSize(8.8).fillColor(C.ink).text(e.text, M + 84, y + 2, { width: 250, lineBreak: false, ellipsis: true });
            doc.fillColor(C.mut).text(latin(nameOf(byIdSafe(cameras, e.cam)), e.cam || ''), M + 340, y + 2, { width: W - M - 340 - M, lineBreak: false, ellipsis: true });
            y += 20;
        });
        if (d.timeline.length > shown.length) { doc.font('Helvetica-Oblique').fontSize(8.4).fillColor(C.mut).text(`+ ${d.timeline.length - shown.length} more events`, M + 84, y + 2, { lineBreak: false }); y += 18; }
    }

    // ---- footer on every page
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        doc.rect(0, H - 34, W, 1.6).fill(grad(doc, 0, 0, W, 0, [[0, C.violet], [0.5, C.blue], [1, C.teal]]));
        doc.font('Helvetica').fontSize(7.6).fillColor(C.mut).text('VisionGuard  |  Smart Way Group  |  Confidential: for the named company only', M, H - 24, { lineBreak: false });
        doc.font('Helvetica-Bold').text(`${i + 1} / ${range.count}`, W - M - 60, H - 24, { width: 60, align: 'right', lineBreak: false });
        doc.font('Helvetica').fillColor(C.mut).text(`Generated ${new Date().toLocaleString('en-GB')}`, M, H - 14, { lineBreak: false });
    }
    doc.end();
}

function byIdSafe(cams, id) { return cams.find((c) => c.cameraId === id) || { cameraId: id, name: id }; }

module.exports = { build };
