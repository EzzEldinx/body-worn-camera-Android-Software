// Who may PUSH a live stream into the media server. Before, publishing was open: anybody who could reach port 1935 and knew a camera id could
// replace that camera's live picture. Now every camera has its own publish key, HMAC(secret, cameraId), which the server hands to the camera over
// its authenticated socket (event `push_key`); the camera adds ?key=<key> to its RTMP address.
// The media server's own "auth.publish" is not used on its own because it signs with the same secret and format as the PLAY links that every
// dashboard viewer receives (a viewer could then publish). Here the prePublish hook checks the camera key and only then gives the session a
// fresh internal signature, so the media server accepts it; anything else gets a signature that fails.
//   RTMP_PUBLISH_AUTH=warn (default)  a push without a valid key is allowed and logged (cameras not yet updated keep working)
//   RTMP_PUBLISH_AUTH=on              a push without a valid key is refused
//   RTMP_PUBLISH_AUTH=off             no check, no log
// The secret: PUBLISH_SECRET, or one generated once and kept in DATA_DIR/publish.secret (so keys survive restarts).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function init({ env = process.env, dataDir, streamSecret, log = console } = {}) {
    const mode = ['on', 'off', 'warn'].includes(String(env.RTMP_PUBLISH_AUTH || '').toLowerCase()) ? String(env.RTMP_PUBLISH_AUTH).toLowerCase() : 'warn';
    let secret = env.PUBLISH_SECRET || '';
    if (!secret && dataDir) {
        const f = path.join(dataDir, 'publish.secret');
        try { secret = fs.readFileSync(f, 'utf8').trim(); } catch { /* first run */ }
        if (!secret) { secret = crypto.randomBytes(32).toString('hex'); try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(f, secret, { mode: 0o600 }); } catch (e) { log.warn(`publish secret not saved: ${e.message}`); } }
    }
    if (!secret) secret = crypto.randomBytes(32).toString('hex');
    const keyOf = (id) => crypto.createHmac('sha256', secret).update(String(id)).digest('hex').slice(0, 32);
    const valid = (id, key) => {
        if (!id || typeof key !== 'string' || key.length !== 32) return false;
        const a = Buffer.from(key), b = Buffer.from(keyOf(id));
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    };
    // the internal signature node-media-server checks when auth.publish is on (see BroadcastServer.verifyAuth)
    const nmsSign = (streamPath) => { const exp = Math.floor(Date.now() / 1000) + 60; return `${exp}-${crypto.createHash('md5').update(`${streamPath}-${exp}-${streamSecret}`).digest('hex')}`; };
    const warned = new Map();
    /** The prePublish hook. Returns true when the push is allowed. */
    function check(session) {
        if (!session || typeof session !== 'object' || mode === 'off') return true;
        const streamPath = String(session.streamPath || '');
        const m = /^\/live\/([^/?]+)$/.exec(streamPath);
        const ok = !!m && valid(m[1], String(session.streamQuery?.key || ''));
        if (mode === 'on') session.streamQuery = { ...(session.streamQuery || {}), sign: ok ? nmsSign(streamPath) : 'x-x' };
        if (!ok && Date.now() - (warned.get(streamPath) || 0) > 10 * 60000) {
            warned.set(streamPath, Date.now());
            log.warn(`RTMP push to ${streamPath.slice(0, 60)} from ${session.ip || '?'} without a valid camera key: ${mode === 'on' ? 'refused' : 'allowed for now (RTMP_PUBLISH_AUTH=warn)'}`);
        }
        return ok || mode !== 'on';
    }
    return { mode, keyOf, valid, check, enforce: mode === 'on' };
}

module.exports = { init };
