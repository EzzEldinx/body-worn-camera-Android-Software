// Languages: English and Arabic must always have the same words.
//   * every dictionary has the same keys in both languages, and the same {placeholders} in each text
//   * every API error text written in the server's source has an Arabic form (so a new error cannot slip through untranslated)
//   * the Arabic answer of the API is chosen by the language the page or the app asked for
// Run: node --test test/i18n.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const i18n = require('../i18n');

const VG = i18n.VG;
const pub = path.join(__dirname, '..', 'public', 'i18n');
const dicts = { 'public/i18n.js (shared words)': { en: { ...VG.D.en }, ar: { ...VG.D.ar } }, 'lang/texts.js': require('../lang/texts.js') };
for (const f of fs.readdirSync(pub).filter((x) => x.endsWith('.js'))) dicts['public/i18n/' + f] = require(path.join(pub, f));

const holes = (v) => [...new Set([...(typeof v === 'string' ? v : Object.values(v).join(' ')).matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort().join(',');
const text = (v) => (typeof v === 'string' ? v : v.other);

for (const [name, d] of Object.entries(dicts)) {
    test(`${name}: both languages have the same keys and the same placeholders`, () => {
        const en = Object.keys(d.en), ar = Object.keys(d.ar);
        assert.deepStrictEqual(en.filter((k) => !(k in d.ar)), [], 'in English but not in Arabic');
        assert.deepStrictEqual(ar.filter((k) => !(k in d.en)), [], 'in Arabic but not in English');
        for (const k of en) {
            assert.ok(text(d.en[k]) !== undefined && text(d.ar[k]) !== undefined, `${k}: a plural text needs an "other" form`);
            for (const form of typeof d.ar[k] === 'string' ? [d.ar[k]] : Object.values(d.ar[k])) assert.strictEqual(holes(form) === '' || holes(form).split(',').every((h) => holes(d.en[k]).split(',').includes(h)), true, `${k}: Arabic uses a {placeholder} English does not have`);
            assert.strictEqual(holes(text(d.en[k])), holes(text(d.ar[k])), `${k}: the {placeholders} differ between English and Arabic`);
        }
    });
}

test('every error text in the server source has an Arabic form', () => {
    const dir = path.join(__dirname, '..');
    const missing = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        for (const m of src.matchAll(/\berror:\s*'((?:[^'\\]|\\.)*)'/g)) { const msg = m[1].replace(/\\'/g, "'"); if (!i18n.known(msg)) missing.push(`${f}: ${msg}`); }
    }
    assert.deepStrictEqual(missing, []);
});

test('the language of a request: ?lang, the cookie, X-Lang, then Accept-Language', () => {
    assert.strictEqual(i18n.langOf({ headers: {}, query: {} }), 'en');
    assert.strictEqual(i18n.langOf({ headers: { cookie: 'a=1; vglang=ar' }, query: {} }), 'ar');
    assert.strictEqual(i18n.langOf({ headers: { 'x-lang': 'ar' }, query: {} }), 'ar');
    assert.strictEqual(i18n.langOf({ headers: { 'accept-language': 'ar-SA,en;q=0.8' }, query: {} }), 'ar');
    assert.strictEqual(i18n.langOf({ headers: { cookie: 'vglang=ar' }, query: { lang: 'en' } }), 'en');
});

test('API errors come back in Arabic only when Arabic was asked for', () => {
    assert.strictEqual(i18n.error('en', 'Wrong username or password.'), 'Wrong username or password.');
    assert.strictEqual(i18n.error('ar', 'Wrong username or password.'), 'اسم المستخدم أو كلمة المرور غير صحيحة.');
    assert.match(i18n.error('ar', 'Employee number 0147 is already used in this company.'), /0147/);
    assert.strictEqual(i18n.error('ar', 'something a person typed'), 'something a person typed');
});

test('texts with a count use the plural forms of the language', () => {
    assert.strictEqual(VG.t('common.nDays', { n: 2 }, 'ar'), 'يومان');
    assert.strictEqual(VG.t('common.nDays', { n: 5 }, 'ar'), '⁨5⁩ أيام'.replace(/⁨|⁩/g, ''));
    assert.strictEqual(VG.t('common.nDays', { n: 1 }, 'en'), '1 day');
    assert.strictEqual(i18n.tr('ar', 'ins.sos.title', { n: 3 }), '3 إنذارات SOS بانتظار تأكيد الاستلام');
});
