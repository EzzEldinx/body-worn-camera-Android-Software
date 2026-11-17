'use strict';
// The demo company's world, planned once at start from a seed: who works there, which twelve cameras they carry, where those cameras patrol,
// which zones are drawn on the map and what state everything is in at the moment the server starts.
// The seed code (seed.js) writes this plan into the database and the simulator (sim.js) lives it, so both agree on where everything is.
const { make } = require('./rng');
const D = require('./data');

const DAY = 86400000;
const R = 6371000, rad = (d) => (d * Math.PI) / 180;

/** [lat, lng] moved north / east by metres */
const offset = (c, north, east) => [c[0] + north / 111320, c[1] + east / (111320 * Math.cos(rad(c[0])))];
/** metres between two [lat, lng] points */
function meters(a, b) {
    const dLat = rad(b[0] - a[0]), dLng = rad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
const bearing = (a, b) => (Math.atan2(rad(b[1] - a[1]) * Math.cos(rad(a[0])), rad(b[0] - a[0])) * 180 / Math.PI + 360) % 360;

/** A closed loop through the points: its length, and where on it a distance is. */
function loop(pts) {
    const cum = [0];
    for (let i = 1; i <= pts.length; i++) cum.push(cum[i - 1] + meters(pts[i - 1], pts[i % pts.length]));
    const len = cum[pts.length];
    return {
        pts, len, cum,
        at(s) {
            s = ((s % len) + len) % len;
            let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
            const a = pts[i - 1], b = pts[i % pts.length], f = (s - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
            return { lat: a[0] + (b[0] - a[0]) * f, lng: a[1] + (b[1] - a[1]) * f, heading: bearing(a, b) };
        },
    };
}
const rectangle = (c, hN, hE, clockwise = true) => {
    const pts = [offset(c, hN, -hE), offset(c, hN, hE), offset(c, -hN, hE), offset(c, -hN, -hE)];
    return clockwise ? pts : pts.reverse();
};

// Which cameras exist, and what each is doing when the server starts. Index = camera number - 1.
//   mode: patrol (out on its loop) | docked (charging on its area's dock) | offline (switched off for two days)
const START = [
    { mode: 'patrol', battery: 71, rec: true },        // 01
    { mode: 'docked', battery: 46, files: 4 },         // 02  (older app: updates itself on the dock)
    { mode: 'patrol', battery: 64, rec: false },       // 03
    { mode: 'patrol', battery: 82, rec: true },        // 04
    { mode: 'patrol', battery: 58, rec: false },       // 05  vehicle
    { mode: 'docked', battery: 93, files: 0 },         // 06
    { mode: 'patrol', battery: 23, rec: false },       // 07  weak battery: a low-battery alert soon
    { mode: 'patrol', battery: 77, rec: false },       // 08  updates over Wi-Fi
    { mode: 'patrol', battery: 69, rec: true },        // 09  vehicle
    { mode: 'docked', battery: 88, files: 3 },         // 10
    { mode: 'patrol', battery: 52, rec: false },       // 11
    { mode: 'offline', battery: 34, rec: false },      // 12  off for two days
];
const VEHICLES = new Set([4, 8]);
const OLD_BUILD = new Set([1, 4, 7, 11]);                  // 0-based: these run the previous camera app
const NO_REMOTE_STOP = new Set([1, 11]);                  // and cannot be stopped from the dashboard until they update
const UPDATE_MODE = { 4: 'any', 7: 'wifi' };
const WALK_MS = 4.2, DRIVE_MS = 9;                        // metres per second (a little faster than real life so the map visibly moves)

/** @returns the whole plan */
function build({ seed = 20261117, now = Date.now(), cameras = 12 } = {}) {
    const rng = make(seed);
    const w = { seed, now, company: D.COMPANY, regions: D.REGIONS.slice() };

    // ----- people: 1 administrator, 2 operators, 1 viewer, 14 employees (they take cameras at the dock), 3 support staff
    const folk = D.people(rng, 1 + 2 + 1 + 14 + 3);
    w.manager = { ...folk[0], role: 'manager' };
    w.operators = folk.slice(1, 3).map((p) => ({ ...p, role: 'client' }));
    w.viewer = { ...folk[3], role: 'viewer' };
    w.employees = folk.slice(4, 18).map((p, i) => ({ ...p, role: 'officer', employeeNo: `E-${2001 + i * 7}` }));
    w.support = folk.slice(18, 21).map((p) => ({ name: p.name }));

    // ----- docks (one for each area)
    w.docks = D.DOCKS.map((d, i) => ({ ...d, idx: i }));

    // ----- cameras
    const cams = [];
    const seatsUsed = [0, 0, 0];
    for (let i = 0; i < cameras; i++) {
        const site = D.SITES[Math.floor(i / 2)], seat = i % 2, st = START[i] || { mode: 'patrol', battery: 60, rec: false }, vehicle = VEHICLES.has(i);
        const big = vehicle ? 1.55 : 1;
        const pts = rectangle(site.c, site.half[0] * (seat ? 0.62 : 1) * big, site.half[1] * (seat ? 0.62 : 1) * big, seat === 0);
        const route = loop(pts);
        const dock = w.docks[site.dock];
        const slot = [0, 2, 5, 7][seatsUsed[site.dock]++ % 4];
        const s0 = rng.float(0, route.len);
        const p0 = route.at(s0);
        const holder = st.mode === 'patrol' ? w.employees[(i * 5 + 1) % w.employees.length] : null;
        cams.push({
            i, id: `BWC-${String(i + 1).padStart(2, '0')}`, site: site.name, siteIdx: Math.floor(i / 2), region: D.REGIONS[site.region], regionIdx: site.region, seat, vehicle,
            speed: vehicle ? DRIVE_MS : WALK_MS, route, dockIdx: site.dock, dockId: dock.id, slot, port: `demo-port-${dock.id}-${slot}`,
            updateMode: UPDATE_MODE[i] || 'off', oldBuild: OLD_BUILD.has(i), remoteStop: !NO_REMOTE_STOP.has(i),
            weakBattery: i === 6,                                   // 07: drains faster and returns late
            flaky: i === 7,                                         // 08: its network drops now and then (14 times in the last week)
            start: {
                mode: st.mode, battery: st.battery, rec: !!st.rec, files: st.files || 0, holder,
                s: s0, lat: st.mode === 'docked' ? dock.c[0] : p0.lat, lng: st.mode === 'docked' ? dock.c[1] : p0.lng,
                sinceMin: st.mode === 'patrol' ? rng.int(40, 230) : st.mode === 'docked' ? rng.int(2, 25) : 2900,
            },
        });
    }
    w.cameras = cams;
    // the camera that is off was last seen where it was switched off, two days ago
    for (const c of cams) if (c.start.mode === 'offline') {
        const p = c.route.at(rng.float(0, c.route.len)); c.start.lat = p.lat; c.start.lng = p.lng; c.start.lastSeen = now - 51 * 3600000;
    }

    // ----- zones (names are blurred in the demo, like every other name)
    const site = (n) => D.SITES.find((s) => s.name === n);
    const hit = site('Hittin Business Park'), mal = site('Al Malqa Mall'), wh = site('Central Warehouse'), ind = site('Industrial Yard'), ex = site('Exit 15 Checkpoint');
    const at = (c, n, e) => { const p = offset(c, n, e); return { lat: +p[0].toFixed(6), lng: +p[1].toFixed(6) }; };
    const dockLoc = at(mal.c, 330, 150);
    const whGate = at(wh.c, -wh.half[0], wh.half[1]);
    w.zones = [
        { name: 'Hittin perimeter', kind: 'zone', shape: { type: 'circle', ...at(hit.c, 0, 0), r: 430 }, onExit: true, onEnter: false, severity: 'warning', scope: { type: 'groups', ids: [hit.name] } },
        { name: 'Malqa loading dock (restricted)', kind: 'zone', shape: { type: 'circle', ...dockLoc, r: 38 }, onExit: false, onEnter: true, severity: 'critical', scope: { type: 'groups', ids: [mal.name] } },
        { name: 'Warehouse gate 2', kind: 'checkpoint', shape: { type: 'circle', ...whGate, r: 45 }, everyMin: 20, severity: 'warning', scope: { type: 'groups', ids: [wh.name] } },
        { name: 'Industrial yard fence line', kind: 'zone', shape: { type: 'polygon', pts: [offset(ind.c, 560, -700), offset(ind.c, 560, 700), offset(ind.c, -560, 700), offset(ind.c, -560, -700)].map((p) => [+p[0].toFixed(6), +p[1].toFixed(6)]) }, onExit: true, onEnter: false, severity: 'warning', scope: { type: 'groups', ids: [ind.name] } },
        { name: 'Neighbouring plot (no entry)', kind: 'zone', shape: { type: 'polygon', pts: [offset(ex.c, 330, -120), offset(ex.c, 330, 160), offset(ex.c, 250, 160), offset(ex.c, 250, -120)].map((p) => [+p[0].toFixed(6), +p[1].toFixed(6)]) }, onExit: false, onEnter: true, severity: 'warning', scope: { type: 'groups', ids: [ex.name] } },
    ];
    // the two things the simulator does on purpose now and then: one camera leaves its allowed area, another enters a forbidden one
    w.beats = [
        { camera: 0, kind: 'exit', zone: 0, target: at(hit.c, 0, 530) },       // BWC-01 walks out of "Hittin perimeter"
        { camera: 2, kind: 'enter', zone: 1, target: dockLoc },                 // BWC-03 walks into "Malqa loading dock"
    ];

    // ----- software builds (the camera app): the latest and the one before
    w.builds = { latest: rng.hex(32), old: rng.hex(32) };
    w.tokens = null;           // the per-camera tokens are made at start (index.js) and never stored anywhere but in the database as hashes
    w.dockLocation = (idx) => ({ lat: w.docks[idx].c[0], lng: w.docks[idx].c[1] });
    return w;
}

module.exports = { build, loop, rectangle, offset, meters, bearing, DAY, START };
