#!/usr/bin/env node
// Smart Way's licence desk (runs on Smart Way's own computer, never on a customer's server).
//   node tools/license/vg-license.js keygen                          one time: create the signing key (keep the private key safe, back it up)
//   node tools/license/vg-license.js issue  --customer "Ministry of X" --term 12m --request req.vgreq [options]
//   node tools/license/vg-license.js renew  VG-2026-000001 --term 12m [--request req.vgreq]    same customer and limits, starts where the old term ends
//   node tools/license/vg-license.js inspect <file.vglic | file.vgreq>
//   node tools/license/vg-license.js list [--soon 90]                who is about to expire: the renewal calendar
//   node tools/license/vg-license.js pubkey                          print the public key line for server/license-pubkey.js
//
// issue options: --limits cameras=300,users=40,employees=800,companies=6,live=40   --features reports,ai,docking,checkout,mobile (default: all)
//                --grace 30 (days after the end the system keeps working)   --after restricted|locked   --start 2026-11-10 (default today)
//                --edition gov   --contact it@customer.gov.sa   --install VG-XXXX-... (instead of --request)   --out file.vglic
// Files live in ~/.visionguard/license (or $VG_LICENSE_DIR): vendor-private.pem (secret!), vendor-public.pem, ledger.jsonl, issued/.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const core = require('../../server/license-core');

const DIR = process.env.VG_LICENSE_DIR || path.join(os.homedir(), '.visionguard', 'license');
const PRIV = path.join(DIR, 'vendor-private.pem'), PUB = path.join(DIR, 'vendor-public.pem'), LEDGER = path.join(DIR, 'ledger.jsonl'), ISSUED = path.join(DIR, 'issued');
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const die = (m) => { console.error('\n  ✗ ' + m + '\n'); process.exit(1); };

function args(argv) {
    const o = { _: [] };
    for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const k = a.slice(2); o[k] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true; } else o._.push(a); }
    return o;
}
const kidOf = (pem) => 'sw-' + crypto.createHash('sha256').update(core.publicDerOf(pem)).digest('hex').slice(0, 8);
function keys() {
    if (!fs.existsSync(PRIV)) die(`No signing key yet. Run:  node tools/license/vg-license.js keygen`);
    const priv = fs.readFileSync(PRIV, 'utf8'), pub = fs.readFileSync(PUB, 'utf8');
    return { priv, pub, kid: kidOf(pub) };
}
const ledger = () => (fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return die(`Cannot read ${file}: ${e.message}`); } }

function parseLimits(s) {
    if (!s || s === true) return undefined;
    const out = {};
    for (const part of String(s).split(',')) { const [k, v] = part.split('='); if (!core.LIMIT_KEYS.includes(k)) die(`Unknown limit "${k}". Use: ${core.LIMIT_KEYS.join(', ')}`); out[k] = Number(v); if (!Number.isInteger(out[k]) || out[k] < 0) die(`Limit ${k} must be a whole number`); }
    return out;
}
const parseFeatures = (s) => (!s || s === true ? undefined : String(s).split(',').map((x) => x.trim()).filter(Boolean));

function cmdKeygen() {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    if (fs.existsSync(PRIV)) die(`A signing key already exists in ${DIR}. Refusing to overwrite it (every installed licence depends on it).`);
    const kp = core.makeKeyPair();
    fs.writeFileSync(PRIV, kp.privatePem, { mode: 0o600 }); fs.writeFileSync(PUB, kp.publicPem);
    console.log(`\n  ✓ Signing key created in ${DIR}\n    key id: ${kidOf(kp.publicPem)}\n\n  KEEP ${PRIV} SECRET and BACK IT UP (two places, offline).`);
    console.log('  Anyone with it can issue licences; if it is lost no renewal can ever be issued for servers already installed.\n');
    cmdPubkey();
}
function cmdPubkey() {
    const { pub, kid } = keys();
    console.log(`  Public key for server/license-pubkey.js:\n\n  { kid: '${kid}', pem: \`${pub.trim()}\` },\n`);
}

function build({ customer, term, installId, start, limits, features, graceDays, afterExpiry, edition, contact, notes }) {
    const { priv, kid } = keys();
    const led = ledger(), year = new Date().getUTCFullYear();
    const serial = `VG-${year}-${String(led.length + 1).padStart(6, '0')}`;
    const payload = { v: 1, serial, customer, installId, issued: Date.now(), start, expires: core.termEnd(start, term), term, graceDays, edition, contact, afterExpiry, limits, features, notes };
    for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
    const lic = core.sign(payload, priv, kid);
    fs.mkdirSync(ISSUED, { recursive: true });
    const file = path.join(ISSUED, `${serial}-${customer.replace(/[^\w]+/g, '_').slice(0, 40)}.vglic`);
    fs.writeFileSync(file, JSON.stringify(lic, null, 2));
    fs.appendFileSync(LEDGER, JSON.stringify({ ...payload, file }) + '\n');
    return { payload, lic, file };
}
function show({ payload: p, file }, out) {
    if (out) fs.copyFileSync(file, out);
    console.log(`\n  ✓ Licence ${p.serial}\n    Customer      ${p.customer}\n    Installation  ${p.installId}\n    Term          ${p.term}   ${iso(p.start)}  →  ${iso(p.expires)}   (+${p.graceDays ?? 30} days grace, then ${p.afterExpiry || 'restricted'})\n    Limits        ${p.limits ? Object.entries(p.limits).map(([k, v]) => `${k}=${v}`).join('  ') : 'none'}\n    Features      ${(p.features || core.FEATURES).join(', ')}\n\n  File: ${out || file}\n  Send this file to the customer's administrator: License page → Install licence.\n`);
}

function cmdIssue(a) {
    const customer = String(a.customer || '').trim(), term = String(a.term || '');
    if (!customer) die('--customer "Name" is required');
    if (!core.TERMS[term]) die(`--term must be one of ${Object.keys(core.TERMS).join(', ')}`);
    let installId = a.install, req = null;
    if (a.request) {
        const v = core.verifyRequest(readJson(a.request));
        if (!v.ok) die(v.error);
        req = v.payload; installId = v.installId;
        console.log(`\n  Request from ${req.customer || '(new customer)'}  host ${req.host}  usage: ${Object.entries(req.usage || {}).map(([k, x]) => `${k}=${x}`).join(' ')}`);
    }
    if (!installId) die('Give the customer\'s request file (--request file.vgreq) or --install VG-XXXX-XXXX-XXXX-XXXX-XXXX ( "*" = any installation, for testing only)');
    if (installId !== '*' && !core.INSTALL_RE.test(installId)) die('That installation id is not valid');
    const start = a.start ? Date.parse(a.start + 'T00:00:00Z') : core.startOfDay(Date.now());
    if (!Number.isFinite(start)) die('--start must look like 2026-11-10');
    const r = build({ customer, term, installId, start, limits: parseLimits(a.limits), features: parseFeatures(a.features), graceDays: a.grace !== undefined ? Number(a.grace) : undefined,
        afterExpiry: a.after && a.after !== true ? a.after : undefined, edition: a.edition && a.edition !== true ? a.edition : undefined, contact: a.contact && a.contact !== true ? a.contact : undefined });
    show(r, a.out && a.out !== true ? a.out : null);
}

function cmdRenew(a) {
    const serial = a._[1];
    if (!serial) die('Which licence? e.g.  renew VG-2026-000001 --term 12m');
    const old = ledger().filter((l) => l.serial === serial).pop();
    if (!old) die(`No licence ${serial} in the ledger (${LEDGER}).`);
    const term = String(a.term || old.term || '');
    if (!core.TERMS[term]) die(`--term must be one of ${Object.keys(core.TERMS).join(', ')}`);
    let installId = old.installId;
    if (a.request) {
        const v = core.verifyRequest(readJson(a.request));
        if (!v.ok) die(v.error);
        if (old.installId !== '*' && v.installId !== old.installId) console.log(`\n  ! The request comes from ${v.installId}, the old licence was for ${old.installId}. The new licence follows the request (the server was probably reinstalled).`);
        installId = v.installId;
    }
    // a renewal sent in time continues where the old term ends, so no days are lost or doubled; an old one starts today
    const today = core.startOfDay(Date.now()), start = old.expires >= today ? core.startOfDay(old.expires) + core.DAY : today;
    const r = build({ customer: old.customer, term, installId, start, limits: a.limits ? parseLimits(a.limits) : old.limits, features: a.features ? parseFeatures(a.features) : old.features,
        graceDays: a.grace !== undefined ? Number(a.grace) : old.graceDays, afterExpiry: old.afterExpiry, edition: old.edition, contact: old.contact });
    show(r, a.out && a.out !== true ? a.out : null);
}

function cmdInspect(a) {
    const file = a._[1]; if (!file) die('inspect <file>');
    const j = readJson(file);
    if (j.format === core.REQUEST_FORMAT) { const v = core.verifyRequest(j); console.log(v.ok ? '\n  ✓ Request signature valid\n' : `\n  ✗ ${v.error}\n`); if (v.ok) console.log(JSON.stringify(v.payload, null, 2) + '\n'); return; }
    const pub = fs.existsSync(PUB) ? fs.readFileSync(PUB, 'utf8') : null;
    const v = core.verify(j, pub ? [{ kid: kidOf(pub), pem: pub }] : []);
    console.log(v.ok ? '\n  ✓ Signature valid (signed with this desk\'s key)\n' : `\n  ✗ ${v.error}\n`);
    try { console.log(JSON.stringify(JSON.parse(Buffer.from(j.payload, 'base64url').toString()), null, 2) + '\n'); } catch { /* damaged */ }
}

function cmdList(a) {
    const soon = Number(a.soon) || 90, now = Date.now();
    const latest = new Map();
    for (const l of ledger()) latest.set(`${l.customer}|${l.installId}`, l);
    const rows = [...latest.values()].sort((x, y) => x.expires - y.expires);
    if (!rows.length) return console.log('\n  No licences issued yet.\n');
    console.log('\n  Customer                          Serial           Term  Ends        Days  Status');
    for (const l of rows) {
        const d = Math.ceil((l.expires - now) / core.DAY), grace = (l.graceDays ?? 30);
        const st = d > soon ? 'ok' : d >= 0 ? (d <= 30 ? '⚠ renew now' : 'renew soon') : -d <= grace ? '✗ in grace' : '✗ LIMITED MODE';
        console.log(`  ${l.customer.padEnd(33).slice(0, 33)} ${l.serial.padEnd(16)} ${String(l.term || '').padEnd(5)} ${iso(l.expires)}  ${String(d).padStart(4)}  ${st}`);
    }
    console.log('');
}

const a = args(process.argv.slice(2)), cmd = a._[0];
({ keygen: cmdKeygen, pubkey: cmdPubkey, issue: () => cmdIssue(a), renew: () => cmdRenew(a), inspect: () => cmdInspect(a), list: () => cmdList(a) }[cmd] || (() => {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).slice(0, 14).map((l) => l.slice(3)).join('\n'));
}))();
