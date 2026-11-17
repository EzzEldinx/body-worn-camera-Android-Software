'use strict';
// Fills an empty database with the demo company's history: 30 days of shifts, activity, SOS alarms, alerts, recordings, check-outs, tickets and
// an audit trail whose hash chain verifies like a real one. Nothing here is copied from anywhere: it is generated from the seed in world.js.
//
// It runs in a short-lived copy of the server that has loaded every module (so every table exists) and exits as soon as this is done
// (see index.js): the real demo process then starts on the finished database and loads it like any other.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { make } = require('./rng');
const D = require('./data');

const MIN = 60000, HOUR = 3600000, DAY = 86400000, TZ = 3 * HOUR;
const localMidnight = (t) => Math.floor((t + TZ) / DAY) * DAY - TZ;

function run({ db, world: w, hashPassword, hashToken, tokenOf, auditlog, geofenceMod, dataDir, password }) {
    const rng = make(w.seed + 7), now = w.now;
    const log = { cameras: 0, shifts: 0, alarms: 0, events: 0, positions: 0, recordings: 0, dockFiles: 0, alerts: 0, audit: 0, tickets: 0 };
    const auditPlan = [];                                      // [ts, username, action, camera, detail, ref]: written in time order at the end
    const addAudit = (ts, username, action, cam = null, detail = null, ref = null) => auditPlan.push([ts, username, action, cam, detail, ref]);
    db.exec('BEGIN');
    try {
        // ---------------------------------------------------------------- regions, company, people
        db.exec('DELETE FROM regions');
        w.regions.forEach((n, i) => db.prepare('INSERT INTO regions(name,created) VALUES(?,?)').run(n, now - 200 * DAY + i));
        const companyId = Number(db.prepare('INSERT INTO companies(name,created,max_cameras,max_live,features,sub_end) VALUES(?,?,?,?,?,?)')
            .run(w.company, now - 170 * DAY, 20, 8, null, now + 200 * DAY).lastInsertRowid);
        const pass = hashPassword(password || crypto.randomBytes(24).toString('hex'));      // every account has this password: nobody knows it (people enter through "Try the demo", never with a password)
        const insUser = db.prepare('INSERT INTO users(username,name,pass,role,company_id,employee_no) VALUES(?,?,?,?,?,?)');
        const user = (p) => ({ ...p, id: Number(insUser.run(p.username, p.name, pass, p.role, companyId, p.employeeNo || null).lastInsertRowid) });
        const manager = user(w.manager), operators = w.operators.map(user), viewer = user(w.viewer), employees = w.employees.map(user);
        const staffOps = [manager, ...operators];              // the people who answer alarms in the control room

        // ---------------------------------------------------------------- cameras
        const insCam = db.prepare(`INSERT INTO cameras(id,name,grp,created,holder,token_hash,company_id,region,battery,battery_ts,charging,update_mode,holder_src,holder_prev)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        for (const c of w.cameras) {
            const s = c.start, off = s.mode === 'offline';
            insCam.run(c.id, c.id, c.site, now - 150 * DAY, s.holder ? s.holder.name : '', hashToken(tokenOf(c.id)), companyId, c.region,
                Math.round(s.battery), off ? s.lastSeen : now, s.mode === 'docked' ? 1 : 0, c.updateMode, s.holder ? 'checkout' : null, s.holder ? '' : null);
            log.cameras++;
        }

        // ---------------------------------------------------------------- shifts (who carried which camera, when) for the last 30 days
        const shifts = [];                                     // closed ones
        const open = [];                                       // the ones in progress right now
        const midnight = localMidnight(now);
        for (const c of w.cameras) {
            const s = c.start;
            const cutoff = s.mode === 'patrol' ? now - s.sinceMin * MIN - 20 * MIN : s.mode === 'docked' ? now - s.sinceMin * MIN - 3 * MIN : s.lastSeen;
            if (s.mode === 'patrol') open.push({ cam: c, employee: s.holder, start: now - s.sinceMin * MIN, end: now, open: true });
            for (let d = 30; d >= 0; d--) {
                if (rng.chance(0.1)) continue;                                              // a day off for this camera
                const day = midnight - d * DAY, no = (c.i + d) % 3, startH = [6, 14, 22][no];
                const start = day + startH * HOUR + rng.int(-10, 12) * MIN, end = start + 8 * HOUR + rng.int(-25, 25) * MIN;
                if (end > cutoff) continue;
                shifts.push({ cam: c, employee: employees[(c.i * 3 + d * 2 + no) % employees.length], start, end, no,
                    batteryOut: rng.int(91, 100), batteryIn: c.weakBattery ? rng.int(3, 15) : rng.int(13, 48), issued: start - rng.int(1, 4) * MIN });
            }
            // a camera that just came back to its dock has just ended a shift: it is what the dock is offloading
            if (s.mode === 'docked') {
                const end = now - s.sinceMin * MIN, start = end - rng.int(420, 500) * MIN;
                shifts.push({ cam: c, employee: employees[(c.i * 3 + 1) % employees.length], start, end, no: 0, batteryOut: 96, batteryIn: Math.max(8, s.battery - 12), issued: start - 2 * MIN, justBack: true });
            }
        }
        shifts.sort((a, b) => a.start - b.start);
        log.shifts = shifts.length + open.length;
        const all = [...shifts, ...open];
        const insAssign = db.prepare(`INSERT INTO assignments(camera_id,user_id,username,name,employee_no,company_id,status,issued_ts,hold_until,picked_ts,returned_ts,dock_id,slot,battery_out,battery_in,ended_by,note)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        for (const sh of all) {
            const e = sh.employee, c = sh.cam;
            if (sh.open) {
                const batteryOut = Math.min(100, Math.round(c.start.battery + c.start.sinceMin * (c.weakBattery ? 0.34 : 0.17)));
                insAssign.run(c.id, e.id, e.username, e.name, e.employeeNo, companyId, 'in_use', sh.start - 2 * MIN, sh.start + 8 * MIN, sh.start, null, c.dockId, c.slot, batteryOut, null, null, null);
                addAudit(sh.start - 2 * MIN, e.username, 'camera_checkout', c.id, { employee: e.name, employeeNo: e.employeeNo, dock: c.dockId, slot: c.slot + 1, battery: batteryOut });
                addAudit(sh.start, e.username, 'camera_picked_up', c.id, { employee: e.name, employeeNo: e.employeeNo });
                continue;
            }
            insAssign.run(c.id, e.id, e.username, e.name, e.employeeNo, companyId, 'returned', sh.issued, sh.issued + 10 * MIN, sh.start, sh.end, c.dockId, c.slot, sh.batteryOut, sh.batteryIn, 'dock', null);
            addAudit(sh.issued, e.username, 'camera_checkout', c.id, { employee: e.name, employeeNo: e.employeeNo, dock: c.dockId, slot: c.slot + 1, battery: sh.batteryOut });
            addAudit(sh.start, e.username, 'camera_picked_up', c.id, { employee: e.name, employeeNo: e.employeeNo });
            addAudit(sh.end, 'dock', 'camera_returned', c.id, { employee: e.name, employeeNo: e.employeeNo, endedBy: 'dock', minutesOut: Math.round((sh.end - sh.start) / MIN), batteryOut: sh.batteryOut, batteryIn: sh.batteryIn });
        }

        // ---------------------------------------------------------------- activity of every shift: online, recordings, push-to-talk, messages
        const insEvent = db.prepare('INSERT INTO events(ts,camera_id,type,info) VALUES(?,?,?,?)');
        const ev = (ts, id, type, info) => { insEvent.run(Math.round(ts), id, type, info || null); log.events++; };
        const sessions = [];                                   // recording sessions: they become files on the dock
        for (const sh of all) {
            const c = sh.cam, end = sh.open ? now - 20 * 1000 : sh.end;
            ev(sh.open ? sh.start : sh.start + rng.int(0, 90) * 1000, c.id, 'online');
            const n = rng.int(3, 6), span = (end - sh.start) / n;
            for (let k = 0; k < n; k++) {
                const a = sh.start + span * k + rng.int(3, 20) * MIN, len = rng.int(7, 38) * MIN, b = a + len;
                if (b > end - 2 * MIN) continue;
                ev(a, c.id, 'rec_start'); ev(b, c.id, 'rec_stop');
                sessions.push({ sh, cam: c, a, b });
                for (let p = rng.int(0, 3); p > 0; p--) { const t = a + rng.int(1, Math.max(2, Math.floor(len / MIN) - 1)) * MIN; ev(t, c.id, 'ptt_start'); ev(t + rng.int(3, 14) * 1000, c.id, 'ptt_end'); }
            }
            for (let k = rng.int(1, 3); k > 0; k--) ev(sh.start + rng.int(10, 400) * MIN, c.id, 'msg', 'PUBLIC');
            if (!sh.open) ev(end + rng.int(5, 90) * 1000, c.id, 'offline');
            if (c.flaky && end > now - 7 * DAY) for (let k = rng.int(1, 3); k > 0; k--) { const t = sh.start + rng.int(20, 440) * MIN; ev(t, c.id, 'offline'); ev(t + rng.int(20, 130) * 1000, c.id, 'online'); }
        }
        for (const c of w.cameras) if (c.start.mode === 'offline') ev(c.start.lastSeen, c.id, 'offline');

        // ---------------------------------------------------------------- SOS alarms: about one and a half a day, more at night, answered by the control room
        const insAlarm = db.prepare('INSERT INTO alarms(camera_id,lat,lng,ts,ack_by,ack_ts,holder,holder_no) VALUES(?,?,?,?,?,?,?,?)');
        const hourW = [1.8, 1.7, 1.6, 1.5, 1.2, 1.1, .8, .8, .9, 1, 1, 1.1, 1.1, 1, 1.1, 1.2, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9];
        const alarmTimes = [];
        for (let d = 30; d >= 0; d--) {
            const day = midnight - d * DAY, dow = new Date(day + TZ).getUTCDay(), mean = (dow === 5 || dow === 6 ? 0.9 : 1.5) * (d <= 3 ? 1.15 : 1);
            for (let k = rng.poisson(mean); k > 0; k--) {
                const ts = day + rng.weighted(hourW) * HOUR + rng.int(0, 3599) * 1000;
                if (ts > now - 40 * MIN) continue;
                const cover = all.filter((s) => s.start <= ts && (s.open ? now : s.end) >= ts);
                if (!cover.length) continue;
                const sh = rng.pick(cover), c = sh.cam, p = c.route.at(((ts - sh.start) / 1000) * c.speed + 40);
                const r = rng.next(), delay = (r < 0.75 ? rng.int(22, 120) : r < 0.95 ? rng.int(121, 360) : rng.int(361, 1500)) * 1000;
                const by = rng.pick(staffOps);
                insAlarm.run(c.id, +p.lat.toFixed(6), +p.lng.toFixed(6), ts, by.username, ts + delay, sh.employee.name, sh.employee.employeeNo);
                alarmTimes.push({ ts, cam: c, by, sh });
                log.alarms++;
            }
        }

        // ---------------------------------------------------------------- GPS trail of the last 24 hours (one point a minute while a camera is out)
        const insPos = db.prepare('INSERT INTO positions(camera_id,lat,lng,ts,acc) VALUES(?,?,?,?,?)');
        for (const sh of all) {
            const c = sh.cam, from = Math.max(sh.start, now - 24 * HOUR), to = sh.open ? now - 5000 : sh.end;
            for (let t = from; t <= to; t += MIN) {
                const s = sh.open ? c.start.s - c.speed * ((now - 5000 - t) / 1000) : ((t - sh.start) / 1000) * c.speed + 40, p = c.route.at(s);
                insPos.run(c.id, +p.lat.toFixed(6), +p.lng.toFixed(6), Math.round(t), Math.round(rng.float(5, 14) * 10) / 10); log.positions++;
            }
        }
        // where every camera is right now (the server starts from the last point of each)
        for (const c of w.cameras) {
            const s = c.start, ts = s.mode === 'offline' ? s.lastSeen : now - 4000;
            insPos.run(c.id, +s.lat.toFixed(6), +s.lng.toFixed(6), ts, s.mode === 'docked' ? 25 : 8); log.positions++;
        }

        // ---------------------------------------------------------------- zones
        const insZone = db.prepare(`INSERT INTO geofences(company_id,name,kind,shape,on_exit,on_enter,severity,days,from_min,to_min,tz,scope,every_min,active,created,updated,created_by,overrides)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        const zoneIds = w.zones.map((z, i) => {
            const body = { ...z, days: [0, 1, 2, 3, 4, 5, 6], tz: 180, active: true, ...(i === 3 ? { from: '20:00', to: '06:00' } : {}) };
            const c = geofenceMod.clean(body); if (c.error) throw new Error(`demo zone "${z.name}": ${c.error}`);
            const v = c.value, t = now - (60 - i * 4) * DAY;
            const id = Number(insZone.run(companyId, v.name, v.kind, JSON.stringify(v.shape), v.onExit, v.onEnter, v.severity, v.days, v.fromMin, v.toMin, v.tz, JSON.stringify(v.scope), v.everyMin, v.active, t, t, manager.username, '{}').lastInsertRowid);
            addAudit(t, manager.username, 'geofence_created', null, { name: v.name, kind: v.kind, by: manager.username });
            return id;
        });

        // ---------------------------------------------------------------- alerts of the past: low battery (when a camera came back nearly empty) and zone alerts
        const insAlert = db.prepare('INSERT INTO alerts(kind,camera_id,level,value,ts,ack_by,ack_ts,resolved_ts,resolved_by,zone_id,zone_name) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
        const alert = (kind, c, level, value, ts, resolvedTs, resolvedBy, zone) => {
            const by = rng.chance(0.65) ? rng.pick(staffOps) : null;
            insAlert.run(kind, c.id, level, value, Math.round(ts), by ? by.username : null, by ? Math.round(ts + rng.int(40, 480) * 1000) : null, Math.round(resolvedTs), resolvedBy, zone == null ? null : zoneIds[zone], zone == null ? null : w.zones[zone].name);
            addAudit(ts, 'system', kind === 'low_battery' ? (level === 'critical' ? 'battery_critical' : 'battery_low') : kind, c.id, kind === 'low_battery' ? { battery: value, level } : { zone: zone == null ? null : w.zones[zone].name, zoneId: zone == null ? null : zoneIds[zone], value });
            log.alerts++;
        };
        const zoneOfSite = { 0: [0, 'geo_exit', 'back in line'], 1: [1, 'geo_enter', 'back in line'], 3: [2, 'checkpoint_missed', 'visited'], 4: [3, 'geo_exit', 'back in line'], 5: [4, 'geo_enter', 'back in line'] };
        for (const sh of shifts) {
            if (sh.batteryIn < 20) { const ts = sh.end - rng.int(10, 40) * MIN; alert('low_battery', sh.cam, sh.batteryIn < 10 ? 'critical' : 'warning', sh.batteryIn + rng.int(0, 2), ts, sh.end + rng.int(2, 10) * MIN, 'charging'); }
            const z = zoneOfSite[sh.cam.siteIdx];
            if (z && rng.chance(z[1] === 'checkpoint_missed' ? 0.1 : 0.13)) {
                const ts = sh.start + rng.int(30, 420) * MIN;
                alert(z[1], sh.cam, w.zones[z[0]].severity, z[1] === 'checkpoint_missed' ? rng.int(24, 46) : null, ts, ts + rng.int(1, 8) * MIN, z[2], z[0]);
            }
        }

        // ---------------------------------------------------------------- recordings: what the docks copied and what was decided for each file
        const insRec = db.prepare('INSERT INTO recordings(camera_id,filename,size,sha256,recorded_ts,uploaded_ts,dock_id) VALUES(?,?,?,?,?,?,?)');
        const insFile = db.prepare(`INSERT INTO dock_files(camera_id,filename,size,sha256,recorded_ts,dock_id,state,choice,chosen_by,message,added_ts,updated_ts,cam_delete,cam_deleted_ts)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        const MB = 1048576;
        let awaiting = 0, queued = 0, failed = 0;
        const files = [];
        for (const s of sessions) files.push({ cam: s.cam, kind: 'mp4', t: s.a, size: Math.round(((s.b - s.a) / 1000) * rng.float(0.48, 0.6) * MB), sh: s.sh });
        for (const a of alarmTimes) files.push({ cam: a.cam, kind: 'jpg', t: a.ts + 2000, size: Math.round(rng.float(1.1, 2.7) * MB), sh: a.sh });
        files.sort((x, y) => x.t - y.t);
        for (const f of files) {
            const sha = rng.hex(32), name = `${f.kind === 'mp4' ? 'VID' : 'IMG'}_${Math.round(f.t)}.${f.kind}`, c = f.cam;
            if (f.sh && f.sh.open) continue;                                                          // a camera still out on patrol: its files are still on the camera
            const copied = f.sh.end + rng.int(2, 12) * MIN;                                           // the dock copies a shift's files when the camera is back
            if (copied > now - 3 * MIN) continue;
            const age = now - copied, ops = rng.pick(staffOps);
            const decided = copied + rng.int(20, 300) * MIN;
            let state = 'cloud', choice = 'cloud', by = ops.username, msg = null, uploaded = Math.min(decided + rng.int(2, 40) * MIN, now - MIN);
            if (age < 20 * HOUR && f.kind === 'mp4' && awaiting < 7 && f.size > 80 * MB) { state = 'on_dock'; choice = null; by = null; awaiting++; }
            else if (age < 20 * HOUR && f.kind === 'mp4' && queued < 2) { state = 'on_dock'; choice = 'cloud'; queued++; }
            else if (age < 30 * HOUR && f.kind === 'mp4' && failed < 1 && rng.chance(0.5)) { state = 'failed'; choice = 'cloud'; failed++; msg = 'Upload interrupted: the connection was reset. The dock tries again by itself.'; }
            else if (f.kind === 'mp4' && rng.chance(0.34)) { state = 'on_dock'; choice = 'local'; by = ops.username; }
            const removed = state !== 'on_dock' || choice === 'local' ? (age > 3 * DAY && rng.chance(0.55)) : false;
            if (copied > now - 14 * DAY) {
                insFile.run(c.id, name, f.size, sha, Math.round(f.t), c.dockId, state, choice, by, msg, Math.round(copied), Math.round(state === 'on_dock' && !choice ? copied : decided), removed ? 0 : 0, removed ? Math.round(decided + 30 * MIN) : null);
                log.dockFiles++;
                addAudit(copied, `dock:${c.dockId}`, 'dock_file_copied', c.id, { file: name, size: f.size, dock: c.dockId, copiedAndVerified: true }, sha);
                if (choice) addAudit(decided, by || 'auto', `dock_file_choice_${choice}`, c.id, { file: name, size: f.size, was: 'undecided' }, sha);
                if (removed) addAudit(decided + 30 * MIN, 'dock', 'dock_file_deleted_from_camera', c.id, { verifiedCopyChecked: true }, sha);
            }
            if (state === 'cloud') {
                insRec.run(c.id, name, f.size, sha, Math.round(f.t), Math.round(uploaded), c.dockId); log.recordings++;
                addAudit(uploaded, `dock:${c.dockId}`, 'dock_file_uploaded_cloud', c.id, { file: name, size: f.size, verifiedSha256: true }, sha);
            }
        }
        // older recordings that only exist in the cloud now (their dock rows were cleaned up long ago)
        for (let i = 0; i < 60; i++) {
            const c = rng.pick(w.cameras), t = now - rng.int(15 * 24, 30 * 24) * HOUR, sha = rng.hex(32), size = Math.round(rng.float(80, 700) * MB);
            insRec.run(c.id, `VID_${t}.mp4`, size, sha, t, t + rng.int(2, 9) * HOUR, c.dockId); log.recordings++;
        }

        // ---------------------------------------------------------------- docks: which bay each camera belongs in
        const insSlot = db.prepare('INSERT OR REPLACE INTO dock_slots(dock_id,port,slot) VALUES(?,?,?)');
        for (const c of w.cameras) insSlot.run(c.dockId, c.port, c.slot);

        // ---------------------------------------------------------------- support tickets
        const insTicket = db.prepare('INSERT INTO tickets(user_id,username,company_id,subject,category,priority,camera_id,status,created,updated,emailed,mail_note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
        const insMsg = db.prepare('INSERT INTO ticket_messages(ticket_id,author,staff,body,ts) VALUES(?,?,?,?,?)');
        D.TICKETS.forEach(([subject, category, priority, status, camera, hoursAgo, msgs], k) => {
            const who = k % 3 === 1 ? operators[0] : manager, created = now - hoursAgo * HOUR;
            const last = created + msgs[msgs.length - 1][1] * HOUR;
            const id = Number(insTicket.run(who.id, who.username, companyId, subject, category, priority, camera, status, created, last, 1, null).lastInsertRowid);
            msgs.forEach(([from, h, text], j) => {
                const staff = from === 'staff', author = staff ? w.support[(k + j) % w.support.length].name : who.name;
                insMsg.run(id, author, staff ? 1 : 0, text, created + h * HOUR);
            });
            addAudit(created, who.username, 'ticket_created', camera, { ref: 'VG-' + String(id).padStart(5, '0'), subject, priority, category });
            log.tickets++;
        });

        // ---------------------------------------------------------------- camera updates: a build published two days ago, announced to the company
        const updDir = path.join(dataDir, 'updates');
        fs.mkdirSync(updDir, { recursive: true });
        const published = now - 2 * DAY;
        fs.writeFileSync(path.join(updDir, 'meta.json'), JSON.stringify({ build: w.builds.latest, size: 38_412_800, uploaded: published, by: 'system' }));
        db.prepare('INSERT INTO update_notices(build,title,body,body_ar,created,by) VALUES(?,?,?,?,?,?)').run(w.builds.latest, 'New camera update',
            'A new update is ready for your cameras. Please put all your cameras on the docking station. They update by themselves as soon as they are connected, and you do not need to do anything else.',
            'يوجد تحديث جديد لكاميراتكم. يرجى وضع جميع الكاميرات على محطة الإرساء (Docking Station)، وستتحدّث تلقائياً فور توصيلها، ولا يلزم أي إجراء آخر منكم.', published, 'system');
        addAudit(published, 'system', `update_upload_${w.builds.latest.slice(0, 12)}`, null, null);
        addAudit(published + MIN, 'system', 'update_notice_sent', null, { build: w.builds.latest.slice(0, 12), title: 'New camera update' });

        // ---------------------------------------------------------------- a few more lines of ordinary life in the audit trail
        for (let d = 30; d >= 0; d--) {
            const day = midnight - d * DAY;
            for (let k = rng.int(2, 5); k > 0; k--) { const u = rng.pick(staffOps); addAudit(day + rng.int(6, 22) * HOUR + rng.int(0, 59) * MIN, u.username, 'mobile_login', null, null); }
            if (rng.chance(0.18)) addAudit(day + rng.int(8, 20) * HOUR, manager.username, 'report_downloaded', null, { from: new Date(day - 6 * DAY + TZ).toISOString().slice(0, 10), to: new Date(day + TZ).toISOString().slice(0, 10), days: 7, scope: w.company });
        }

        // ---------------------------------------------------------------- the audit trail itself: in time order, hash-chained exactly like the server writes it
        auditPlan.sort((a, b) => a[0] - b[0]);
        const last = db.prepare('SELECT hash FROM audit WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1').get(), seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'audit'").get();
        let prev = last?.hash || '', id = seq?.seq || 0;
        const insAudit = db.prepare('INSERT INTO audit(id,ts,username,action,camera_id,detail,ref,prev_hash,hash) VALUES(?,?,?,?,?,?,?,?,?)');
        for (const [ts0, username, action, cam, detail, ref] of auditPlan) {
            const row = { id: ++id, ts: Math.round(ts0), username: String(username || 'system').slice(0, 80), action: String(action).slice(0, 120), camera_id: cam || null, detail: detail ? JSON.stringify(detail).slice(0, 2000) : null, ref: ref ? String(ref).slice(0, 80) : null };
            const hash = auditlog.lineHash(prev, row);
            insAudit.run(row.id, row.ts, row.username, row.action, row.camera_id, row.detail, row.ref, prev, hash);
            prev = hash; log.audit++;
        }
        db.exec('COMMIT');
        return { companyId, managerId: manager.id, managerUsername: manager.username, log };
    } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw e;
    }
}

module.exports = { run };
