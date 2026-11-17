// Push notifications for the mobile apps (Firebase Cloud Messaging HTTP v1: it delivers to Android and, through APNs, to iOS).
// Off until FCM_SERVICE_ACCOUNT points at the Firebase service-account JSON; without it SOS still reaches every open app over the socket.
const crypto = require('crypto');
const fs = require('fs');
const i18n = require('./i18n');

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const b64u = (b) => Buffer.from(b).toString('base64url');

// Signed OAuth assertion (RS256) that Google exchanges for a short-lived access token.
function jwtAssertion(sa, now = Math.floor(Date.now() / 1000)) {
    const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const body = b64u(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
    const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(sa.private_key, 'base64url');
    return `${head}.${body}.${sig}`;
}

// What the phone shows (title/body) plus the data the app uses to open the right screen.
function buildMessage(token, platform, alarm, label, lang = 'en') {
    const T = (key, params) => i18n.tr(lang, key, params);
    const where = alarm.lat != null && alarm.lng != null ? `${alarm.lat.toFixed(4)}, ${alarm.lng.toFixed(4)}` : T('push.noGps');
    const msg = {
        token,
        notification: { title: T('push.sosTitle', { label }), body: T('push.sosBody', { label, where }) },
        data: { type: 'sos', alarmId: String(alarm.id), cameraId: alarm.cameraId, ts: String(alarm.ts) },
    };
    if (platform === 'android') msg.android = { priority: 'HIGH', notification: { channel_id: 'sos', sound: 'default', default_vibrate_timings: true } };
    else msg.apns = { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default', 'interruption-level': 'time-sensitive' } } };
    return msg;
}

function createPush({ db, env = process.env, fetchImpl = fetch, log = console }) {
    let sa = null;
    if (env.FCM_SERVICE_ACCOUNT) {
        try { sa = JSON.parse(fs.readFileSync(env.FCM_SERVICE_ACCOUNT, 'utf8')); } catch (e) { log.warn(`push disabled: cannot read FCM_SERVICE_ACCOUNT (${e.message})`); }
    }
    let access = null; // { token, exp }
    async function accessToken() {
        if (access && access.exp > Date.now() + 60_000) return access.token;
        const r = await fetchImpl('https://oauth2.googleapis.com/token', {
            method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwtAssertion(sa) }),
        });
        const j = await r.json();
        if (!r.ok || !j.access_token) throw new Error(`token exchange failed (${r.status})`);
        access = { token: j.access_token, exp: Date.now() + (j.expires_in || 3000) * 1000 };
        return access.token;
    }

    // Everyone who may see this camera: its company's users, plus Smart Way staff.
    let hasLang = null;   // push_devices.lang (the language the app is in) exists once the server has migrated the table
    const langCol = () => (hasLang === null ? (hasLang = db.prepare('PRAGMA table_info(push_devices)').all().some((c) => c.name === 'lang')) : hasLang) ? 'd.lang' : 'NULL';
    const recipients = (companyId) => db.prepare(`SELECT d.token, d.platform, ${langCol()} AS lang FROM push_devices d JOIN users u ON u.id = d.user_id
        WHERE u.company_id IS NULL ${companyId ? 'OR u.company_id = ?' : ''}`).all(...(companyId ? [companyId] : []));

    async function notifyAlarm(alarm, companyId) {
        if (!sa) return { sent: 0, skipped: 'push not configured' };
        const label = db.prepare('SELECT COALESCE(NULLIF(name, \'\'), id) AS n FROM cameras WHERE id = ?').get(alarm.cameraId)?.n || alarm.cameraId;
        let sent = 0;
        try {
            const bearer = await accessToken();
            for (const d of recipients(companyId)) {
                const r = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
                    method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
                    body: JSON.stringify({ message: buildMessage(d.token, d.platform, alarm, label, d.lang) }),
                });
                if (r.ok) sent++;
                else if (r.status === 404 || r.status === 400) db.prepare('DELETE FROM push_devices WHERE token = ?').run(d.token); // app was uninstalled
            }
        } catch (e) { log.warn(`push failed: ${e.message}`); }
        return { sent };
    }
    // A less urgent notice than an SOS (e.g. low battery): no siren-style channel, normal priority.
    async function notifyAlert(alert, label, companyId) {
        if (!sa) return { sent: 0, skipped: 'push not configured' };
        let sent = 0;
        try {
            const bearer = await accessToken();
            for (const d of recipients(companyId)) {
                const r = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
                    method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
                    body: JSON.stringify({ message: buildAlertMessage(d.token, d.platform, alert, label, d.lang) }),
                });
                if (r.ok) sent++;
                else if (r.status === 404 || r.status === 400) db.prepare('DELETE FROM push_devices WHERE token = ?').run(d.token);
            }
        } catch (e) { log.warn(`push failed: ${e.message}`); }
        return { sent };
    }
    return { enabled: () => !!sa, notifyAlarm, notifyAlert };
}

// Low-battery notice: "BWC-03 battery is 18%".
function buildAlertMessage(token, platform, alert, label, lang = 'en') {
    const T = (key, params) => i18n.tr(lang, key, params);
    const critical = alert.level === 'critical';
    const geo = { geo_exit: 'geoExit', geo_enter: 'geoEnter', checkpoint_missed: 'checkpoint' }[alert.kind];
    if (geo) {
        const m = {
            token,
            notification: { title: T(`push.${geo}Title`, { label }), body: T(`push.${geo}Body`, { label, zone: alert.zone }) },
            data: { type: 'geofence', alertId: String(alert.id), cameraId: alert.cameraId, kind: alert.kind, level: alert.level, ts: String(alert.ts) },
        };
        if (platform === 'android') m.android = { priority: critical ? 'HIGH' : 'NORMAL', notification: { channel_id: 'alerts' } };
        else m.apns = { headers: { 'apns-priority': critical ? '10' : '5' }, payload: { aps: { sound: 'default' } } };
        return m;
    }
    const msg = {
        token,
        notification: { title: T(critical ? 'push.batCriticalTitle' : 'push.batLowTitle', { label }), body: T('push.batBody', { label, value: alert.value }) },
        data: { type: 'battery', alertId: String(alert.id), cameraId: alert.cameraId, level: alert.level, ts: String(alert.ts) },
    };
    if (platform === 'android') msg.android = { priority: critical ? 'HIGH' : 'NORMAL', notification: { channel_id: 'alerts' } };
    else msg.apns = { headers: { 'apns-priority': critical ? '10' : '5' }, payload: { aps: { sound: 'default' } } };
    return msg;
}

module.exports = { createPush, buildMessage, buildAlertMessage, jwtAssertion };
