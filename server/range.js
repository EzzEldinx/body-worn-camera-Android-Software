// Date range for the PDF report: "from" and "to" are calendar days (YYYY-MM-DD), both included.
// The days are cut in the viewer's time zone: the browser sends tz = Date.getTimezoneOffset() (minutes, UTC minus local, e.g. -180 for Riyadh),
// otherwise the server's own zone is used. A single day is the same call with from = to (or the old "date" parameter).
const MAX_DAYS = 92;
const RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n) => String(n).padStart(2, '0');

/** "2026-11-09" -> { y, m, d } or null when it is not a real calendar day. */
function parseStamp(s) {
    const m = RE.exec(String(s || ''));
    if (!m) return null;
    const y = +m[1], mo = +m[2] - 1, d = +m[3];
    const c = new Date(Date.UTC(y, mo, d));
    return c.getUTCFullYear() === y && c.getUTCMonth() === mo && c.getUTCDate() === d ? { y, mo, d } : null;
}
const stampOf = (y, mo, d) => `${y}-${pad(mo + 1)}-${pad(d)}`;

/** Midnight at the start of a calendar day, in ms since the epoch. */
function dayStart(p, tz) {
    return Number.isFinite(tz) ? Date.UTC(p.y, p.mo, p.d) + tz * 60000 : new Date(p.y, p.mo, p.d).getTime();
}

/** Today's calendar day in the viewer's zone. */
function todayOf(now, tz) {
    const t = new Date(Number.isFinite(tz) ? now - tz * 60000 : now - new Date(now).getTimezoneOffset() * 60000);
    return { y: t.getUTCFullYear(), mo: t.getUTCMonth(), d: t.getUTCDate() };
}

/**
 * -> { error } or { from, to, days, fromStamp, toStamp, tz }, where from is inclusive and to is exclusive (midnight after the last day).
 */
function parseRange(q = {}, { now = Date.now() } = {}) {
    const tzRaw = q.tz === undefined || q.tz === '' ? NaN : Number(q.tz);
    const tz = Number.isFinite(tzRaw) && Math.abs(tzRaw) <= 14 * 60 ? Math.round(tzRaw) : undefined;
    const today = todayOf(now, tz);
    const fromS = String(q.from || q.date || stampOf(today.y, today.mo, today.d));
    const toS = String(q.to || fromS);
    const a = parseStamp(fromS), b = parseStamp(toS);
    if (!a || !b) return { error: 'Use dates like 2026-11-09.' };
    const t0 = Date.UTC(a.y, a.mo, a.d), t1 = Date.UTC(b.y, b.mo, b.d), tToday = Date.UTC(today.y, today.mo, today.d);
    if (t1 < t0) return { error: '"From" must not be after "To".' };
    if (t0 > tToday) return { error: 'Pick today or an earlier date.' };
    if (t1 > tToday) return { error: '"To" cannot be in the future.' };
    const days = Math.round((t1 - t0) / 86400000) + 1;
    if (days > MAX_DAYS) return { error: `Pick a range of at most ${MAX_DAYS} days.` };
    const next = new Date(t1 + 86400000);
    return {
        from: dayStart(a, tz), to: dayStart({ y: next.getUTCFullYear(), mo: next.getUTCMonth(), d: next.getUTCDate() }, tz),
        days, fromStamp: fromS, toStamp: toS, tz,
    };
}

module.exports = { parseRange, MAX_DAYS };
