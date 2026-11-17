/* VisionGuard languages (English / Arabic, left-to-right / right-to-left).
 *
 * One small engine for every page, and for the server (Node loads this same file to write the texts it produces itself).
 *
 *   Page:    <script src="/i18n.js"></script> in <head>, then the page's own words: <script src="/i18n/<page>.js"></script>
 *   Static:  <h1 data-i18n="an.title">Analytics</h1>    data-i18n-html (markup), data-i18n-ph (placeholder), data-i18n-title, data-i18n-aria, data-i18n-alt
 *   Script:  VG.t('an.title')   VG.t('common.nCameras', { n: 3 })   VG.h(...) is the same but escapes the values for innerHTML
 *   Dates:   VG.date(ts)  VG.time(ts)  VG.dateTime(ts)  VG.ago(ts)  VG.num(n)  VG.bytes(b)  (digits stay 0-9 in both languages)
 *
 * The choice is kept in localStorage 'bwc-lang' (the login page has always used that key) and in the cookie 'vglang', so the server
 * can answer in the same language. Another open window (the live wall) follows a change through the 'storage' event.
 * A page that can redraw itself calls VG.onLang(fn); a page that cannot is simply reloaded.
 */
(function (root, factory) {
  const VG = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = VG; else root.VG = VG;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';
  const LANGS = ['en', 'ar'], KEY = 'bwc-lang', COOKIE = 'vglang';
  const browser = typeof document !== 'undefined';
  const D = { en: {}, ar: {} };
  const listeners = [];
  const LOCALE = { en: 'en-GB', ar: 'ar-SA-u-ca-gregory-nu-latn' };   // Gregorian dates and Latin digits in Arabic: camera ids, phone numbers and times read the same in both

  function stored() {
    if (!browser) return null;
    try { const v = localStorage.getItem(KEY); if (LANGS.includes(v)) return v; } catch (e) { /* storage blocked */ }
    const m = /(?:^|;\s*)vglang=(\w+)/.exec(document.cookie || ''); if (m && LANGS.includes(m[1])) return m[1];
    try { const v = localStorage.getItem('vg-station-lang'); if (LANGS.includes(v)) return v; } catch (e) { /* ignore */ }
    return null;
  }
  const guess = () => (browser && /^ar\b/i.test((navigator.languages && navigator.languages[0]) || navigator.language || '') ? 'ar' : 'en');
  let lang = browser ? (stored() || guess()) : 'en';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const bdi = (s) => `<bdi>${esc(s)}</bdi>`;

  const rules = {};
  const plural = (l, n) => (rules[l] || (rules[l] = new Intl.PluralRules(l))).select(Number(n));

  /** The text for `key` in `l` (default: the page language). A value can be a string, or { zero, one, two, few, many, other } picked by params.n.
   *  {name} is replaced by params.name. In Arabic a text value is wrapped in an isolate so an English camera id cannot scramble the sentence around it. */
  function t(key, params, l, safe) {
    l = l || lang;
    let v = D[l] && D[l][key];
    if (v === undefined) v = D.en[key];
    if (v === undefined) return key;
    if (v && typeof v === 'object') v = v[plural(l, params && params.n)] ?? v.other ?? '';
    if (!params) return v;
    return v.replace(/\{(\w+)\}/g, (m, k) => {
      let x = params[k]; if (x === undefined || x === null) return m;
      if (typeof x === 'number') return String(x);
      x = String(x); if (safe) x = esc(x);
      return l === 'ar' ? '⁨' + x + '⁩' : x;
    });
  }
  const h = (key, params, l) => t(key, params, l, true);
  const has = (key) => D.en[key] !== undefined;

  function add(dict) {
    for (const l of LANGS) if (dict[l]) Object.assign(D[l], dict[l]);
    return VG;
  }

  // ---------- formatting ----------
  const locale = (l) => LOCALE[l || lang];
  const dfCache = {};
  const num = (n, opts) => (n == null || n === '' || isNaN(n) ? '–' : new Intl.NumberFormat(locale(), opts).format(n));
  const df = (opts) => { const k = lang + JSON.stringify(opts); return dfCache[k] || (dfCache[k] = new Intl.DateTimeFormat(locale(), { hourCycle: 'h23', ...opts })); };
  const ms = (ts) => (ts instanceof Date ? ts : new Date(typeof ts === 'string' && /^\d+$/.test(ts) ? Number(ts) : ts));
  const date = (ts, o) => (ts ? df(o || { day: 'numeric', month: 'short', year: 'numeric' }).format(ms(ts)) : '–');
  const time = (ts, o) => (ts ? df(o || { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(ms(ts)) : '–');
  const dateTime = (ts, o) => (ts ? df(o || { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(ms(ts)) : '–');
  const iso = (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : '–');   // 2026-11-17: the same in both languages
  const rtfs = {};
  /** "5 minutes ago" / "قبل 5 دقائق" (the language's own plural forms come from Intl). */
  function ago(ts, style) {
    if (!ts) return t('common.never');
    const s = Math.round((Date.now() - ms(ts).getTime()) / 1000), a = Math.abs(s);
    const [v, u] = a < 60 ? [s, 'second'] : a < 3600 ? [Math.round(s / 60), 'minute'] : a < 86400 ? [Math.round(s / 3600), 'hour'] : [Math.round(s / 86400), 'day'];
    const k = lang + (style || 'long');
    return (rtfs[k] || (rtfs[k] = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto', style: style || 'long' }))).format(-v, u);
  }
  /** 5s ago / 3m ago / 2h ago: for dense lists. */
  function agoShort(ts) {
    if (!ts) return t('common.noSignal');
    const s = Math.max(0, Math.round((Date.now() - ms(ts).getTime()) / 1000));
    return s < 60 ? t('common.agoS', { n: s }) : s < 3600 ? t('common.agoM', { n: Math.floor(s / 60) }) : s < 86400 ? t('common.agoH', { n: Math.floor(s / 3600) }) : t('common.agoD', { n: Math.floor(s / 86400) });
  }
  /** A length of time, compact: 45s / 3m / 1.5h (Arabic: 45 ث / 3 د / 1.5 س). */
  function dur(sec) {
    if (sec == null) return '–';
    const u = (n, unit) => new Intl.NumberFormat(locale(), { style: 'unit', unit, unitDisplay: 'narrow', maximumFractionDigits: 1 }).format(n);
    return sec < 60 ? u(sec, 'second') : sec < 3600 ? u(Math.round(sec / 60), 'minute') : u(+(sec / 3600).toFixed(1), 'hour');
  }
  /** "12 MB" read left to right in both languages (inside an Arabic line the number and its unit would swap places without the isolate). */
  const ltr = (s) => (lang === 'ar' ? '\u2066' + s + '\u2069' : String(s));
  const bytes = (b) => { b = Number(b) || 0; return ltr(b >= 1e12 ? (b / 1e12).toFixed(2) + ' TB' : b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? Math.round(b / 1e6) + ' MB' : Math.round(b / 1e3) + ' KB'); };
  const list = (a) => new Intl.ListFormat(locale(), { style: 'long', type: 'conjunction' }).format(a);

  // ---------- the page ----------
  const ATTRS = [['data-i18n-ph', 'placeholder'], ['data-i18n-title', 'title'], ['data-i18n-aria', 'aria-label'], ['data-i18n-alt', 'alt'], ['data-i18n-value', 'value']];
  function apply(scope) {
    if (!browser) return;
    const r = scope || document;
    const each = (sel, fn) => { if (r.matches && r.matches(sel)) fn(r); r.querySelectorAll(sel).forEach(fn); };
    each('[data-i18n]', (el) => { const k = el.getAttribute('data-i18n'); if (has(k)) el.textContent = t(k); });
    each('[data-i18n-html]', (el) => { const k = el.getAttribute('data-i18n-html'); if (has(k)) el.innerHTML = t(k); });
    for (const [a, prop] of ATTRS) each('[' + a + ']', (el) => { const k = el.getAttribute(a); if (has(k)) el.setAttribute(prop, t(k)); });
    document.querySelectorAll('.vg-lang').forEach(syncSwitch);
  }
  function paintRoot() {
    const e = document.documentElement; e.lang = lang; e.dir = lang === 'ar' ? 'rtl' : 'ltr';
    if (document.body) document.body.dir = e.dir;   // the live dashboard keeps its own dir on <body>
  }
  function remember(l) {
    try { localStorage.setItem(KEY, l); } catch (e) { /* ignore */ }
    try { document.cookie = `${COOKIE}=${l}; Path=/; Max-Age=31536000; SameSite=Lax`; } catch (e) { /* ignore */ }
  }
  function setLang(l, fromOtherWindow) {
    if (!LANGS.includes(l) || l === lang) return;
    lang = l;
    if (!fromOtherWindow) remember(l);
    paintRoot(); apply();
    if (listeners.length) listeners.forEach((fn) => { try { fn(l); } catch (e) { console.error(e); } });
    else location.reload();   // a page with no redraw code is simply loaded again in the new language
  }
  const onLang = (fn) => { listeners.push(fn); };

  const switchHTML = () => `<div class="vg-lang" role="group" data-i18n-aria="common.language" aria-label="${esc(t('common.language'))}"><button type="button" data-lang="ar" lang="ar">عربي</button><button type="button" data-lang="en" lang="en">EN</button></div>`;
  function syncSwitch(el) { el.querySelectorAll('[data-lang]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === lang))); }
  /** Puts the language switch into `el` (a selector or an element) and wires it. */
  function mountSwitch(el) {
    el = typeof el === 'string' ? document.querySelector(el) : el;
    if (!el) return;
    el.innerHTML = switchHTML();
    el.querySelector('.vg-lang').addEventListener('click', (e) => { const b = e.target.closest('[data-lang]'); if (b) setLang(b.dataset.lang); });
    syncSwitch(el);
  }

  if (browser) {
    paintRoot();
    if (stored() !== lang) remember(lang);   // the server learns the language even before the first click
    const ready = () => { paintRoot(); apply(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();
    window.addEventListener('storage', (e) => { if (e.key === KEY && LANGS.includes(e.newValue)) setLang(e.newValue, true); });
  }

  const VG = { t, h, has, add, esc, bdi, ltr, apply, setLang, onLang, switchHTML, mountSwitch, locale, num, date, time, dateTime, iso, ago, agoShort, dur, bytes, list, plural, LANGS, D,
    get lang() { return lang; }, get dir() { return lang === 'ar' ? 'rtl' : 'ltr'; }, get rtl() { return lang === 'ar'; } };

  // ---------- words every page shares ----------
  add({
    en: {
      'common.language': 'Language',
      'common.brand': 'VisionGuard',
      'nav.analytics': 'Analytics', 'nav.reports': 'Reports', 'nav.live': 'Live Dashboard', 'nav.docks': 'Docking', 'nav.support': 'Support', 'nav.updates': 'Updates',
      'nav.employees': 'Employees', 'nav.admin': 'Admin panel', 'nav.license': 'License', 'nav.companies': 'Companies', 'nav.menu': 'Menu',
      'hdr.smartway': 'Smart Way Group', 'hdr.poweredBy': 'Powered by', 'hdr.changePic': 'Change your picture', 'hdr.theme': 'Toggle theme', 'hdr.signOut': 'Sign out',
      'hdr.newUpdate': 'A new camera update', 'hdr.waitingDock': 'Cameras waiting for the docking station',
      'common.save': 'Save', 'common.saveChanges': 'Save changes', 'common.cancel': 'Cancel', 'common.close': 'Close', 'common.delete': 'Delete', 'common.edit': 'Edit', 'common.add': 'Add',
      'common.remove': 'Remove', 'common.search': 'Search', 'common.loading': 'Loading…', 'common.noData': 'No data yet.', 'common.yes': 'Yes', 'common.no': 'No', 'common.ok': 'OK',
      'common.back': 'Back', 'common.retry': 'Try again', 'common.refresh': 'Refresh', 'common.copy': 'Copy', 'common.download': 'Download', 'common.upload': 'Upload', 'common.send': 'Send',
      'common.show': 'Show', 'common.hide': 'Hide', 'common.all': 'All', 'common.none': 'None', 'common.optional': 'optional', 'common.unknown': 'Unknown', 'common.dash': '–',
      'common.online': 'Online', 'common.offline': 'Offline', 'common.recording': 'Recording', 'common.never': 'never', 'common.noSignal': 'no signal yet', 'common.now': 'now',
      'common.failed': 'Something went wrong. Try again.', 'common.notAvailable': 'Not available right now.', 'common.couldNotSave': 'Could not save.', 'common.saved': 'Saved.',
      'common.agoS': '{n}s ago', 'common.agoM': '{n}m ago', 'common.agoH': '{n}h ago', 'common.agoD': '{n}d ago',
      'common.nCameras': { one: '{n} camera', other: '{n} cameras' },
      'common.nDays': { one: '{n} day', other: '{n} days' },
      'common.nHours': { one: '{n} hour', other: '{n} hours' },
      'common.nMinutes': { one: '{n} minute', other: '{n} minutes' },
      'common.nUsers': { one: '{n} user', other: '{n} users' },
      'common.nFiles': { one: '{n} file', other: '{n} files' },
      'common.nLines': { one: '{n} line', other: '{n} lines' },
      'common.nCompanies': { one: '{n} company', other: '{n} companies' },
      'common.nEntries': { one: '{n} entry', other: '{n} entries' },
      // licence and subscription notices under the header
      'lic.clock': 'The server clock is behind the last time VisionGuard ran. Correct the clock, or contact Smart Way.',
      'lic.expiring': 'Your VisionGuard licence ends in {days} ({date}). Renew it so there is no gap.',
      'lic.trial': 'Trial: {days} left. Request a licence from Smart Way to keep going.',
      'lic.grace': 'Your VisionGuard licence has expired. Everything still works until {date}; after that the system goes into limited mode.',
      'lic.locked': 'The VisionGuard licence has expired and the system is locked. Ask your administrator to renew it.',
      'lic.restricted': 'Limited mode: the VisionGuard licence has expired. Live view, alarms and evidence keep working; new cameras, users, reports and exports are paused.',
      'lic.renew': 'Renew', 'lic.tellAdmin': 'Tell your administrator.',
      'sub.until': 'Subscription until {date}',
      'sub.ended': 'Your VisionGuard subscription ended on {date}. Access stops on {lock}. Contact Smart Way to renew it now.',
      'sub.ending': 'Your VisionGuard subscription ends in {days} ({date}). Contact Smart Way to renew it so there is no gap.',
      // the notice about a new camera update
      'upd.waitingN': { one: '{n} camera waiting for the docking station', other: '{n} cameras waiting for the docking station' },
      'upd.see': 'See my cameras',
      'pic.notPicture': 'This file is not a picture.', 'pic.uploadFailed': 'Upload failed', 'pic.removeFailed': 'Could not remove it',
    },
    ar: {
      'common.language': 'اللغة',
      'common.brand': 'VisionGuard',
      'nav.analytics': 'التحليلات', 'nav.reports': 'التقارير', 'nav.live': 'لوحة المراقبة المباشرة', 'nav.docks': 'محطات الإرساء', 'nav.support': 'الدعم', 'nav.updates': 'التحديثات',
      'nav.employees': 'الموظفون', 'nav.admin': 'لوحة الإدارة', 'nav.license': 'الترخيص', 'nav.companies': 'الشركات', 'nav.menu': 'القائمة',
      'hdr.smartway': 'مجموعة سمارت واي', 'hdr.poweredBy': 'بدعم من', 'hdr.changePic': 'تغيير صورتك', 'hdr.theme': 'تبديل المظهر', 'hdr.signOut': 'تسجيل الخروج',
      'hdr.newUpdate': 'تحديث جديد للكاميرات', 'hdr.waitingDock': 'كاميرات بانتظار محطة الإرساء',
      'common.save': 'حفظ', 'common.saveChanges': 'حفظ التغييرات', 'common.cancel': 'إلغاء', 'common.close': 'إغلاق', 'common.delete': 'حذف', 'common.edit': 'تعديل', 'common.add': 'إضافة',
      'common.remove': 'إزالة', 'common.search': 'بحث', 'common.loading': 'جارٍ التحميل…', 'common.noData': 'لا توجد بيانات بعد.', 'common.yes': 'نعم', 'common.no': 'لا', 'common.ok': 'موافق',
      'common.back': 'رجوع', 'common.retry': 'حاول مرة أخرى', 'common.refresh': 'تحديث', 'common.copy': 'نسخ', 'common.download': 'تنزيل', 'common.upload': 'رفع', 'common.send': 'إرسال',
      'common.show': 'عرض', 'common.hide': 'إخفاء', 'common.all': 'الكل', 'common.none': 'لا شيء', 'common.optional': 'اختياري', 'common.unknown': 'غير معروف', 'common.dash': '–',
      'common.online': 'متصل', 'common.offline': 'غير متصل', 'common.recording': 'جاري التسجيل', 'common.never': 'أبداً', 'common.noSignal': 'لا توجد إشارة بعد', 'common.now': 'الآن',
      'common.failed': 'حدث خطأ ما. حاول مرة أخرى.', 'common.notAvailable': 'غير متاح حالياً.', 'common.couldNotSave': 'تعذّر الحفظ.', 'common.saved': 'تم الحفظ.',
      'common.agoS': 'قبل {n} ث', 'common.agoM': 'قبل {n} د', 'common.agoH': 'قبل {n} س', 'common.agoD': 'قبل {n} ي',
      'common.nCameras': { zero: '{n} كاميرا', one: 'كاميرا واحدة', two: 'كاميرتان', few: '{n} كاميرات', many: '{n} كاميرا', other: '{n} كاميرا' },
      'common.nDays': { zero: '{n} يوم', one: 'يوم واحد', two: 'يومان', few: '{n} أيام', many: '{n} يوماً', other: '{n} يوم' },
      'common.nHours': { zero: '{n} ساعة', one: 'ساعة واحدة', two: 'ساعتان', few: '{n} ساعات', many: '{n} ساعة', other: '{n} ساعة' },
      'common.nMinutes': { zero: '{n} دقيقة', one: 'دقيقة واحدة', two: 'دقيقتان', few: '{n} دقائق', many: '{n} دقيقة', other: '{n} دقيقة' },
      'common.nUsers': { zero: '{n} مستخدم', one: 'مستخدم واحد', two: 'مستخدمان', few: '{n} مستخدمين', many: '{n} مستخدماً', other: '{n} مستخدم' },
      'common.nFiles': { zero: '{n} ملف', one: 'ملف واحد', two: 'ملفان', few: '{n} ملفات', many: '{n} ملفاً', other: '{n} ملف' },
      'common.nLines': { zero: '{n} سطر', one: 'سطر واحد', two: 'سطران', few: '{n} أسطر', many: '{n} سطراً', other: '{n} سطر' },
      'common.nCompanies': { zero: '{n} شركة', one: 'شركة واحدة', two: 'شركتان', few: '{n} شركات', many: '{n} شركة', other: '{n} شركة' },
      'common.nEntries': { zero: '{n} إدخال', one: 'إدخال واحد', two: 'إدخالان', few: '{n} إدخالات', many: '{n} إدخالاً', other: '{n} إدخال' },
      'lic.clock': 'ساعة الخادم متأخرة عن آخر تشغيل لـ VisionGuard. صحّح الساعة أو تواصل مع سمارت واي.',
      'lic.expiring': 'ينتهي ترخيص VisionGuard خلال {days} ({date}). جدّده حتى لا يحدث انقطاع.',
      'lic.trial': 'فترة تجريبية: تبقّى {days}. اطلب ترخيصاً من سمارت واي للاستمرار.',
      'lic.grace': 'انتهى ترخيص VisionGuard. كل شيء ما زال يعمل حتى {date}، وبعدها يدخل النظام في الوضع المحدود.',
      'lic.locked': 'انتهى ترخيص VisionGuard وتم قفل النظام. اطلب من مدير النظام تجديده.',
      'lic.restricted': 'الوضع المحدود: انتهى ترخيص VisionGuard. يستمر البث المباشر والإنذارات والأدلة، بينما تتوقف الكاميرات والمستخدمون والتقارير والتصدير الجديدة.',
      'lic.renew': 'تجديد', 'lic.tellAdmin': 'أبلغ مدير النظام.',
      'sub.until': 'الاشتراك حتى {date}',
      'sub.ended': 'انتهى اشتراكك في VisionGuard بتاريخ {date}. يتوقف الوصول في {lock}. تواصل مع سمارت واي لتجديده الآن.',
      'sub.ending': 'ينتهي اشتراكك في VisionGuard خلال {days} ({date}). تواصل مع سمارت واي لتجديده حتى لا يحدث انقطاع.',
      'upd.waitingN': { zero: '{n} كاميرا بانتظار محطة الإرساء', one: 'كاميرا واحدة بانتظار محطة الإرساء', two: 'كاميرتان بانتظار محطة الإرساء', few: '{n} كاميرات بانتظار محطة الإرساء', many: '{n} كاميرا بانتظار محطة الإرساء', other: '{n} كاميرا بانتظار محطة الإرساء' },
      'upd.see': 'عرض كاميراتي',
      'pic.notPicture': 'هذا الملف ليس صورة.', 'pic.uploadFailed': 'فشل الرفع', 'pic.removeFailed': 'تعذّرت الإزالة',
    },
  });
  return VG;
});
