// Software licence: the pure part, shared by the server (which only VERIFIES) and by Smart Way's own tool tools/license/vg-license.js (which SIGNS).
// No I/O here. A licence is a small JSON document signed with an Ed25519 key that only Smart Way holds; every server carries the matching public key, so a
// licence can be checked offline (a government network does not need internet) and cannot be forged, edited or extended by the customer.
const crypto = require('crypto');

const FORMAT = 'vg-license/1', REQUEST_FORMAT = 'vg-request/1';
const DAY = 86400000;
const TERMS = { '3m': 3, '6m': 6, '12m': 12, '24m': 24, '36m': 36 };   // months
const LIMIT_KEYS = ['cameras', 'users', 'employees', 'companies', 'live'];
const FEATURES = ['reports', 'ai', 'docking', 'checkout', 'mobile'];
const AFTER_EXPIRY = ['restricted', 'locked'];

const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

/** "VG-3F2A-91BC-77D0-E45A-1C2B": a readable fingerprint of an installation's public key. A licence is issued for one of these. */
function installIdOf(publicDer) {
    const h = sha256(publicDer).toString('hex').toUpperCase().slice(0, 20);
    return 'VG-' + h.match(/.{4}/g).join('-');
}
const INSTALL_RE = /^VG-([0-9A-F]{4}-){4}[0-9A-F]{4}$/;

/** Calendar months from a start (UTC), clamped to the last day of a shorter month. */
function addMonths(ts, n) {
    const d = new Date(ts), day = d.getUTCDate();
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return d.getTime();
}
/** A term that starts at 00:00 UTC on its first day ends at 23:59:59.999 on its last day: 12 months from 10 Nov 2026 end on 9 Nov 2027. */
const termEnd = (start, term) => addMonths(start, TERMS[term]) - 1;
const startOfDay = (ts) => { const d = new Date(ts); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };

function makeKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { publicPem: publicKey.export({ type: 'spki', format: 'pem' }), privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
const publicDerOf = (pem) => crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' });
const fingerprintOf = (pem) => installIdOf(publicDerOf(pem));

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
/** The signed content. Anything unknown is refused so a licence means exactly what it says. */
function validatePayload(p) {
    if (!p || typeof p !== 'object') return 'not a licence';
    if (p.v !== 1) return 'unknown licence version';
    if (typeof p.serial !== 'string' || !/^[\w.-]{3,40}$/.test(p.serial)) return 'bad serial';
    if (typeof p.customer !== 'string' || !p.customer.trim() || p.customer.length > 120) return 'bad customer';
    if (p.installId !== '*' && !INSTALL_RE.test(String(p.installId))) return 'bad installation id';
    if (!isInt(p.issued, 0, 4e12) || !isInt(p.start, 0, 4e12) || !isInt(p.expires, 0, 4e12) || p.expires <= p.start) return 'bad dates';
    if (p.graceDays !== undefined && !isInt(p.graceDays, 0, 365)) return 'bad grace period';
    if (p.afterExpiry !== undefined && !AFTER_EXPIRY.includes(p.afterExpiry)) return 'bad after-expiry mode';
    if (p.limits !== undefined) {
        if (!p.limits || typeof p.limits !== 'object') return 'bad limits';
        for (const [k, v] of Object.entries(p.limits)) if (!LIMIT_KEYS.includes(k) || !isInt(v, 0, 1e7)) return `bad limit "${k}"`;
    }
    if (p.features !== undefined && (!Array.isArray(p.features) || p.features.some((f) => !FEATURES.includes(f)))) return 'bad features';
    if (p.term !== undefined && !TERMS[p.term]) return 'bad term';
    return null;
}

/** Sign a payload: -> { format, kid, payload, sig } (what a .vglic file contains). */
function sign(payload, privatePem, kid) {
    const bad = validatePayload(payload);
    if (bad) throw new Error(bad);
    const bytes = Buffer.from(JSON.stringify(payload));
    return { format: FORMAT, kid, payload: b64u(bytes), sig: b64u(crypto.sign(null, bytes, crypto.createPrivateKey(privatePem))) };
}

/** keys = [{ kid, pem }]. -> { ok: true, payload, kid } or { ok: false, code, error }. */
function verify(input, keys) {
    let lic = input;
    if (typeof input === 'string') { try { lic = JSON.parse(input); } catch { return { ok: false, code: 'format', error: 'This is not a VisionGuard licence file.' }; } }
    if (!lic || lic.format !== FORMAT || typeof lic.payload !== 'string' || typeof lic.sig !== 'string') return { ok: false, code: 'format', error: 'This is not a VisionGuard licence file.' };
    const key = (keys || []).find((k) => k.kid === lic.kid) || (keys || []).length === 1 && !lic.kid && keys[0];
    if (!key) return { ok: false, code: 'key', error: 'This licence was signed with a key this server does not know. Update VisionGuard or ask Smart Way.' };
    const bytes = unb64u(lic.payload);
    let good = false;
    try { good = crypto.verify(null, bytes, crypto.createPublicKey(key.pem), unb64u(lic.sig)); } catch { good = false; }
    if (!good) return { ok: false, code: 'signature', error: 'The licence signature is not valid. The file was changed or is not from Smart Way.' };
    let payload; try { payload = JSON.parse(bytes.toString()); } catch { return { ok: false, code: 'format', error: 'The licence is damaged.' }; }
    const bad = validatePayload(payload);
    if (bad) return { ok: false, code: 'format', error: `The licence is not valid (${bad}).` };
    return { ok: true, payload, kid: key.kid };
}

/** A renewal request, signed by the installation's own key, so Smart Way knows which installation asks and that nobody edited the request. */
function makeRequest(payload, privatePem, publicPem) {
    const bytes = Buffer.from(JSON.stringify(payload));
    return { format: REQUEST_FORMAT, payload: b64u(bytes), pub: b64u(publicDerOf(publicPem)), sig: b64u(crypto.sign(null, bytes, crypto.createPrivateKey(privatePem))) };
}
function verifyRequest(input) {
    let req = input;
    if (typeof input === 'string') { try { req = JSON.parse(input); } catch { return { ok: false, error: 'This is not a VisionGuard request file.' }; } }
    if (!req || req.format !== REQUEST_FORMAT || typeof req.payload !== 'string' || typeof req.pub !== 'string' || typeof req.sig !== 'string') return { ok: false, error: 'This is not a VisionGuard request file.' };
    const bytes = unb64u(req.payload), der = unb64u(req.pub);
    let good = false;
    try { good = crypto.verify(null, bytes, crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }), unb64u(req.sig)); } catch { good = false; }
    if (!good) return { ok: false, error: 'The request signature is not valid: the file was changed.' };
    let payload; try { payload = JSON.parse(bytes.toString()); } catch { return { ok: false, error: 'The request is damaged.' }; }
    if (payload.installId !== installIdOf(der)) return { ok: false, error: 'The request does not match its own installation key.' };
    return { ok: true, payload, installId: payload.installId };
}

module.exports = { FORMAT, REQUEST_FORMAT, DAY, TERMS, LIMIT_KEYS, FEATURES, AFTER_EXPIRY, INSTALL_RE, b64u, unb64u, installIdOf, addMonths, termEnd, startOfDay, makeKeyPair, publicDerOf, fingerprintOf, validatePayload, sign, verify, makeRequest, verifyRequest };
