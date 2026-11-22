// The language of the words the server itself produces for people: API errors, push notifications, e-mails, the written analysis.
// The same engine the pages use (public/i18n.js) runs here, with the server-only dictionary in lang/texts.js.
//
//   langOf(req)            'ar' or 'en': ?lang=, the cookie the pages set, the X-Lang header, then Accept-Language
//   error(lang, text)      an API error text in Arabic (the English text itself stays the contract for the apps and the dock agent)
//   tr(lang, key, params)  a server text by key
const VG = require('./public/i18n.js');
VG.add(require('./lang/texts.js'));
const { ERRORS, PATTERNS } = require('./lang/errors.js');

const norm = (v) => (typeof v === 'string' && /^ar/i.test(v.trim()) ? 'ar' : 'en');

function langOf(req) {
    const q = req.query && req.query.lang;
    if (q === 'ar' || q === 'en') return q;
    const c = /(?:^|;\s*)vglang=(\w+)/.exec((req.headers && req.headers.cookie) || '');
    if (c && (c[1] === 'ar' || c[1] === 'en')) return c[1];
    const x = req.headers && req.headers['x-lang'];
    if (x) return norm(String(x));
    return norm(String((req.headers && req.headers['accept-language']) || '').split(',')[0]);
}

/** The Arabic form of one of the server's English messages; anything it does not know (free text a person typed, a system message) is left as it is. */
function error(lang, text) {
    if (lang !== 'ar' || typeof text !== 'string') return text;
    if (Object.prototype.hasOwnProperty.call(ERRORS, text)) return ERRORS[text];
    for (const [re, build] of PATTERNS) { const m = re.exec(text); if (m) return build(...m); }
    return text;
}
/** Is this English message covered by the dictionary? (used by the test that reads the server's source) */
const known = (text) => error('ar', text) !== text;

/** Express middleware: sets req.lang and answers `error`, `note` and the skipped rows of an import in that language. */
function middleware(req, res, next) {
    req.lang = langOf(req);
    if (req.lang !== 'en') {
        const json = res.json;
        res.json = function (body) {
            if (body && typeof body === 'object' && !Array.isArray(body)) {
                let b = null;
                for (const k of ['error', 'note', 'reason', 'problem']) if (typeof body[k] === 'string') { const v = error(req.lang, body[k]); if (v !== body[k]) (b = b || { ...body })[k] = v; }
                if (Array.isArray(body.skipped)) (b = b || { ...body }).skipped = body.skipped.map((s) => (s && typeof s.reason === 'string' ? { ...s, reason: error(req.lang, s.reason) } : s));
                if (b) body = b;
            }
            return json.call(this, body);
        };
    }
    next();
}

const tr = (lang, key, params) => VG.t(key, params, lang === 'ar' ? 'ar' : 'en');
module.exports = { VG, langOf, error, known, middleware, tr, norm };
