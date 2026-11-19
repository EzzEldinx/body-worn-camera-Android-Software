// Live captions: the text of what a streaming camera hears.
// The heavy part (Whisper) runs in the separate service in /transcriber; this file only tells it which camera to listen to,
// receives the sentences it sends back, keeps them for search and hands them to the dashboards of people who may read them.
// Off unless TRANSCRIBE_URL and TRANSCRIBE_TOKEN are set. Voices are personal data: a company gets this only when Smart Way switches
// on its `transcribe` action (see features.js), and every start is written to the audit log.
const crypto = require('crypto');

const DAY = 86400000;
const MAX_TEXT = 2000;

function init({ db, audit, log = console, env = process.env }) {
    db.exec('CREATE TABLE IF NOT EXISTS transcripts(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, camera_id TEXT NOT NULL, text TEXT NOT NULL, lang TEXT)');
    db.exec('CREATE INDEX IF NOT EXISTS transcripts_cam_ts ON transcripts(camera_id, ts)');
    db.exec('CREATE INDEX IF NOT EXISTS transcripts_ts ON transcripts(ts)');

    const url = String(env.TRANSCRIBE_URL || '').replace(/\/$/, '');
    const token = String(env.TRANSCRIBE_TOKEN || '');
    const enabled = !!(url && token);
    const lang = ['ar', 'en'].includes(env.TRANSCRIBE_LANG) ? env.TRANSCRIBE_LANG : null;   // null = the model decides per sentence
    const days = Number(env.TRANSCRIPT_DAYS) > 0 ? Number(env.TRANSCRIPT_DAYS) : 30;
    const listening = new Set();                                                            // cameras the service was asked to listen to

    const tokenOk = (given) => {
        const a = Buffer.from(String(given || '')), b = Buffer.from(token);
        return enabled && a.length === b.length && crypto.timingSafeEqual(a, b);
    };
    async function call(path, body) {
        const r = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-transcribe-token': token }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error(`transcriber answered ${r.status}`);
    }

    // `playUrl()` gives the signed address the service pulls the stream from; `callback` is where it posts the sentences.
    async function start(id, { playUrl, callback }) {
        if (!enabled || !id) return false;
        try {
            await call('/start', { cameraId: id, url: playUrl, callback, lang });
            if (!listening.has(id)) audit('transcription_started', id);
            listening.add(id);
            return true;
        } catch (e) { log.warn(`transcription: cannot start for ${id}: ${e.message}`); return false; }
    }
    async function stop(id) {
        if (!enabled || !listening.delete(id)) return;
        try { await call('/stop', { cameraId: id }); } catch (e) { /* the service ends it by itself when the stream ends */ }
    }

    const insert = db.prepare('INSERT INTO transcripts(ts,camera_id,text,lang) VALUES(?,?,?,?)');
    function record({ cameraId, text, lang: l, ts }) {
        const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
        if (!cameraId || !t) return null;
        const when = Number.isFinite(ts) && Math.abs(Date.now() - ts) < 10 * 60 * 1000 ? ts : Date.now();
        const lang2 = typeof l === 'string' ? l.slice(0, 5) : null;
        const id = Number(insert.run(when, String(cameraId), t, lang2).lastInsertRowid);
        return { id, cameraId: String(cameraId), ts: when, text: t, lang: lang2 };
    }
    // newest last; `after` = only lines newer than this id (a dashboard that already has some)
    function history(cameraId, { after = 0, limit = 100 } = {}) {
        const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
        const rows = db.prepare('SELECT id, ts, text, lang FROM transcripts WHERE camera_id = ? AND id > ? ORDER BY id DESC LIMIT ?').all(String(cameraId), Number(after) || 0, n);
        return rows.reverse().map((r) => ({ id: r.id, cameraId: String(cameraId), ts: r.ts, text: r.text, lang: r.lang }));
    }
    function sweep(now = Date.now()) { return Number(db.prepare('DELETE FROM transcripts WHERE ts < ?').run(now - days * DAY).changes); }
    let timer = null;
    if (enabled) { sweep(); timer = setInterval(() => { try { sweep(); } catch (e) { log.warn(`transcripts sweep failed: ${e.message}`); } }, 3600_000); timer.unref(); }

    return { enabled, tokenOk, start, stop, record, history, sweep, days, listening: () => [...listening] };
}

module.exports = { init };
