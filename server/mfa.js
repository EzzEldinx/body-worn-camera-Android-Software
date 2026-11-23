// Two-step sign-in (MFA). After the password, a person who switched it on also types a 6-digit code from an authenticator app
// (Google Authenticator, Microsoft Authenticator, Authy... standard TOTP, RFC 6238, 30-second steps) or one of 10 one-time recovery codes.
//   * the secret is created by the server, shown once as a QR code / text, and only becomes active after the person proves it with a code;
//   * a code works once (the step that was used is remembered), and the step before and after is accepted for clock drift;
//   * between the password and the code there is a short-lived challenge (5 minutes, 5 tries), never a session;
//   * recovery codes are stored hashed and each works once; an administrator can switch MFA off for someone who lost their phone.
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30, DIGITS = 6, DRIFT = 1, CHALLENGE_MS = 5 * 60 * 1000, CHALLENGE_TRIES = 5, RECOVERY_CODES = 10;

function b32encode(buf) {
    let bits = 0, value = 0, out = '';
    for (const byte of buf) {
        value = (value << 8) | byte; bits += 8;
        while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    return out;
}
function b32decode(str) {
    const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0, value = 0; const out = [];
    for (const ch of clean) {
        value = (value << 5) | B32.indexOf(ch); bits += 5;
        if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
    }
    return Buffer.from(out);
}

/** The code of one 30-second step (HOTP of the step counter, RFC 4226). */
function codeAt(secret, counter) {
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(BigInt(counter));
    const h = crypto.createHmac('sha1', b32decode(secret)).update(msg).digest();
    const o = h[h.length - 1] & 15;
    const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
    return String(n % 10 ** DIGITS).padStart(DIGITS, '0');
}
const counterAt = (now) => Math.floor(now / 1000 / STEP);

/** The step a code belongs to (now, one before or one after), or null. `after` = the last step already used: never accepted again. */
function match(secret, code, now = Date.now(), after = -1) {
    const c = String(code || '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(c) || !secret) return null;
    const t = counterAt(now);
    for (let d = -DRIFT; d <= DRIFT; d++) {
        const step = t + d;
        if (step <= after) continue;
        if (crypto.timingSafeEqual(Buffer.from(codeAt(secret, step)), Buffer.from(c))) return step;
    }
    return null;
}

const newSecret = () => b32encode(crypto.randomBytes(20));
const otpauthUrl = (secret, account, issuer = 'VisionGuard') =>
    `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;
const hashCode = (c) => crypto.createHash('sha256').update(String(c).toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
function newRecoveryCodes() {
    const codes = Array.from({ length: RECOVERY_CODES }, () => { const s = b32encode(crypto.randomBytes(6)).slice(0, 10); return `${s.slice(0, 5)}-${s.slice(5)}`; });
    return { codes, stored: JSON.stringify(codes.map(hashCode)) };
}

/** Database part: columns on users, the challenge table, and the steps of the sign-in. */
function init(db) {
    const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    for (const [col, ddl] of [['mfa_secret', 'TEXT'], ['mfa_pending', 'TEXT'], ['mfa_last', 'INTEGER'], ['mfa_recovery', 'TEXT'], ['mfa_on_ts', 'INTEGER']]) {
        if (!cols.includes(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} ${ddl}`);
    }
    db.exec('CREATE TABLE IF NOT EXISTS mfa_challenges(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, exp INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0)');

    const enabled = (u) => !!(u && u.mfa_secret);

    function challenge(userId, kind, now = Date.now()) {
        db.prepare('DELETE FROM mfa_challenges WHERE exp < ?').run(now);
        const token = crypto.randomBytes(24).toString('hex');
        db.prepare('INSERT INTO mfa_challenges(token,user_id,kind,exp) VALUES(?,?,?,?)').run(token, userId, kind, now + CHALLENGE_MS);
        return token;
    }

    /** Second step: { user } when the code (or a recovery code) is right, else { status, error }. A challenge is used up when it succeeds. */
    function verify(token, code, kind, now = Date.now()) {
        const ch = typeof token === 'string' && db.prepare('SELECT * FROM mfa_challenges WHERE token = ?').get(token);
        if (!ch || ch.kind !== kind || ch.exp < now) return { status: 401, reason: 'mfa_expired' };
        if (ch.tries >= CHALLENGE_TRIES) { db.prepare('DELETE FROM mfa_challenges WHERE token = ?').run(token); return { status: 429, reason: 'mfa_locked' }; }
        db.prepare('UPDATE mfa_challenges SET tries = tries + 1 WHERE token = ?').run(token);
        const u = db.prepare('SELECT * FROM users WHERE id = ?').get(ch.user_id);
        if (!u || !enabled(u) || u.active === 0) return { status: 401, reason: 'mfa_expired' };
        const step = match(u.mfa_secret, code, now, u.mfa_last ?? -1);
        let usedRecovery = false;
        if (step !== null) db.prepare('UPDATE users SET mfa_last = ? WHERE id = ?').run(step, u.id);
        else {
            const list = (() => { try { return JSON.parse(u.mfa_recovery || '[]'); } catch { return []; } })();
            const h = hashCode(code), i = String(code || '').replace(/\s/g, '').length >= 10 ? list.indexOf(h) : -1;
            if (i < 0) return { status: 401, reason: 'mfa_wrong', left: CHALLENGE_TRIES - ch.tries - 1 };
            list.splice(i, 1);
            db.prepare('UPDATE users SET mfa_recovery = ? WHERE id = ?').run(JSON.stringify(list), u.id);
            usedRecovery = true;
        }
        db.prepare('DELETE FROM mfa_challenges WHERE token = ?').run(token);
        return { user: u, usedRecovery, recoveryLeft: usedRecovery ? JSON.parse(db.prepare('SELECT mfa_recovery FROM users WHERE id = ?').get(u.id).mfa_recovery || '[]').length : undefined };
    }

    /** Set-up, step 1: a new secret waiting to be proved (replaces an older pending one). */
    function begin(user) {
        const secret = newSecret();
        db.prepare('UPDATE users SET mfa_pending = ? WHERE id = ?').run(secret, user.id);
        return { secret, url: otpauthUrl(secret, user.username) };
    }
    /** Set-up, step 2: the first code proves the app has the secret; then MFA is on and the recovery codes are shown once. */
    function confirm(userId, code, now = Date.now()) {
        const u = db.prepare('SELECT mfa_pending FROM users WHERE id = ?').get(userId);
        if (!u || !u.mfa_pending) return { status: 400, reason: 'mfa_no_setup' };
        const step = match(u.mfa_pending, code, now);
        if (step === null) return { status: 400, reason: 'mfa_wrong' };
        const rec = newRecoveryCodes();
        db.prepare('UPDATE users SET mfa_secret = mfa_pending, mfa_pending = NULL, mfa_last = ?, mfa_recovery = ?, mfa_on_ts = ? WHERE id = ?').run(step, rec.stored, now, userId);
        return { codes: rec.codes };
    }
    function disable(userId) {
        db.prepare('UPDATE users SET mfa_secret = NULL, mfa_pending = NULL, mfa_last = NULL, mfa_recovery = NULL, mfa_on_ts = NULL WHERE id = ?').run(userId);
        db.prepare('DELETE FROM mfa_challenges WHERE user_id = ?').run(userId);
    }
    function status(userId) {
        const u = db.prepare('SELECT mfa_secret, mfa_recovery, mfa_on_ts FROM users WHERE id = ?').get(userId);
        if (!u) return { enabled: false };
        let left = 0; try { left = JSON.parse(u.mfa_recovery || '[]').length; } catch { /* none */ }
        return { enabled: !!u.mfa_secret, since: u.mfa_on_ts || null, recoveryLeft: u.mfa_secret ? left : 0 };
    }
    return { enabled, challenge, verify, begin, confirm, disable, status };
}

module.exports = { init, codeAt, match, counterAt, b32encode, b32decode, otpauthUrl, STEP };
