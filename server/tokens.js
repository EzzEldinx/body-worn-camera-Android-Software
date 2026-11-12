// Per-camera device tokens. Only a SHA-256 hash is stored; the token is shown once when issued.
const crypto = require('crypto');
const issueToken = () => 'bwc_' + crypto.randomBytes(24).toString('hex');
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const safeEqual = (a, b) => {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};
module.exports = { issueToken, hashToken, safeEqual };
