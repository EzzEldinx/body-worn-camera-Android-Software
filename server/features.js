// What a company can use (set by Smart Way per company) and what each of its users may use (set by the company's administrator).
//   company.features : JSON list, or NULL = everything (companies created before this existed keep all they had)
//   user.perms       : JSON list, or NULL = everything the company has. Administrators always get everything the company has.
//   what a person can do = the company's features AND their own permissions. Smart Way staff always have everything.
// SOS alarms, battery alerts and the Support page are safety/service functions: they are never switched off.
const FEATURES = [
    { key: 'live', group: 'Watching', label: 'Live dashboard & map', hint: 'See cameras on the map and watch them live' },
    { key: 'wall', group: 'Watching', label: 'Live wall', hint: 'Many cameras on one screen, full screen', needs: ['live'] },
    { key: 'talk', group: 'Watching', label: 'Voice & chat', hint: 'Talk to cameras, send messages and voice notes', needs: ['live'] },
    { key: 'recordings', group: 'Evidence', label: 'Recordings & downloads', hint: 'Browse and download recordings from the docking stations' },
    { key: 'docks', group: 'Evidence', label: 'Docking stations', hint: 'See the docks, their slots and the files on them' },
    { key: 'analytics', group: 'Insight', label: 'Analytics', hint: 'Statistics, battery, activity and trends' },
    { key: 'ai', group: 'Insight', label: 'AI insights', hint: 'Plain-language summary of what happened', needs: ['analytics'] },
    { key: 'reports', group: 'Insight', label: 'Reports & exports', hint: 'PDF report and CSV downloads' },
    { key: 'checkout', group: 'Team', label: 'Employee check-out', hint: 'Employees take and return cameras at the station' },
];
// What a person may DO (the features above are what they may SEE). `def` = the roles that get it when nobody has chosen otherwise (Viewers never act: their account is read only).
const ACTIONS = [
    { key: 'ack', group: 'Alarms', label: 'Handle alarms', hint: 'Acknowledge SOS alarms and battery alerts', def: ['client'] },
    { key: 'stream', group: 'Watching', label: 'Start & stop live', hint: 'Switch a camera\'s live stream on or off from the dashboard', def: ['client'], needs: ['live'] },
    { key: 'quality', group: 'Watching', label: 'Change video quality', hint: 'Set a camera to 480p, 720p or 1080p', def: ['client'], needs: ['live'] },
    { key: 'files', group: 'Evidence', label: 'Decide on recordings', hint: 'Choose to keep or move recordings that are on the docks', def: ['client'], needs: ['docks'] },
    { key: 'delete', group: 'Evidence', label: 'Delete files', hint: 'Delete recordings from cameras. This cannot be undone', def: [], needs: ['docks'] },
].map((a) => ({ ...a, kind: 'action' }));
FEATURES.forEach((f) => { f.kind = 'feature'; });
const ALL = [...FEATURES, ...ACTIONS];
const KEYS = FEATURES.map((f) => f.key), ACTION_KEYS = ACTIONS.map((a) => a.key);
const needsOf = Object.fromEntries(ALL.map((f) => [f.key, f.needs || []]));

// Any input -> a clean list of known keys, with what each one needs added back (Live wall without Live dashboard is meaningless).
function clean(list) {
    const set = new Set((Array.isArray(list) ? list : []).filter((k) => needsOf[k]));
    for (const k of [...set]) if (needsOf[k].some((n) => !set.has(n))) set.delete(k);
    return ALL.map((f) => f.key).filter((k) => set.has(k));
}
const parse = (text) => { if (text === null || text === undefined || text === '') return null; try { const v = JSON.parse(text); return Array.isArray(v) ? clean(v) : null; } catch { return null; } };
const store = (list) => (list === null ? null : JSON.stringify(clean(list)));

// raw = { staff, manager, role, companyFeatures (text|null), perms (text|null) } -> everything this person may use or do
//   features: the company's AND the person's own; actions: what the person was given (nothing chosen = the role's default). Administrators: all of it.
const defaultsFor = (role) => ACTIONS.filter((a) => a.def.includes(role)).map((a) => a.key);
function effective({ staff, manager, role, companyFeatures, perms }) {
    if (staff) return ALL.map((f) => f.key);
    const company = parse(companyFeatures) || [...KEYS];
    if (manager) return clean([...company, ...ACTION_KEYS]);
    const own = parse(perms);
    if (!own) return clean([...company, ...defaultsFor(role)]);
    return clean(own.filter((k) => ACTION_KEYS.includes(k) || company.includes(k)));
}

// Which part of the system needs which feature (checked on the server, so a hidden button cannot be bypassed).
const API_RULES = [
    [/^\/api\/stream\//, 'live'], [/^\/live\//, 'live'],
    [/^\/api\/analytics\/ai$/, 'ai'], [/^\/api\/analytics/, 'analytics'],
    [/^\/api\/(report$|reports\/|audit\/export)/, 'reports'],
    [/^\/api\/docks$/, 'docks'], [/^\/api\/dock\/files/, 'recordings'],
    [/^\/api\/employees/, 'checkout'], [/^\/api\/alerts\/[^/]+\/ack$/, 'ack'],
];
const PAGE_RULES = { '/': 'live', '/index.html': 'live', '/wall.html': 'wall', '/analytics.html': 'analytics', '/reports.html': 'reports', '/docks.html': 'docks' };
const ruleFor = (p) => (API_RULES.find(([re]) => re.test(p)) || [])[1] || null;

module.exports = { FEATURES, ACTIONS, ALL, KEYS, ACTION_KEYS, defaultsFor, clean, parse, store, effective, ruleFor, PAGE_RULES };
