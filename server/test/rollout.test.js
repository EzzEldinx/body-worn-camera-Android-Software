// Automatic updates over the network for remote cameras: the canary, the careful rollout, and every reason a camera is NOT asked.
const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const rollout = require('../rollout');

const OLD = 'a'.repeat(64), NEW = 'b'.repeat(64), NEWER = 'c'.repeat(64);
const MIN = 60_000;

function make(config = {}) {
    const clock = { t: 1_000_000_000 };
    const cams = new Map(), sent = [], audits = [];
    let meta = { build: NEW, size: 56_000_000 }, docked = new Map();
    const eng = rollout.create({
        db: new DatabaseSync(':memory:'), cams, latest: () => meta, now: () => clock.t, docked: () => docked,
        send: (id, payload) => { sent.push({ id, ...payload }); cams.get(id).update = { state: 'queued', ts: clock.t, auto: true }; },   // what the server does
        audit: (who, action, cam, detail) => audits.push({ who, action, cam, detail }),
        config: { proveMs: 5 * MIN, canaryMs: 30 * MIN, parallel: 2, ...config },
    });
    const add = (id, extra = {}) => cams.set(id, { cameraId: id, online: true, recording: false, appBuild: OLD, updateMode: 'any', battery: 80, charging: false, caps: ['update-net'], ...extra });
    const asked = () => sent.map((s) => s.id);
    // the camera installs the build and comes back
    const updated = (id) => Object.assign(cams.get(id), { appBuild: meta.build, buildTs: clock.t, onlineSince: clock.t, update: { state: 'done', ts: clock.t } });
    return { eng, cams, sent, audits, clock, add, asked, updated, docked: (m) => { docked = m; }, build: (m) => { meta = m; } };
}

test('cameras that are not set to update over the network are never asked (the docking station updates them)', () => {
    const h = make();
    h.add('A', { updateMode: 'off' }); h.add('B', { updateMode: undefined });
    h.eng.publish({ build: NEW, size: 1 }); h.eng.tick();
    assert.deepStrictEqual(h.asked(), []);
});

test('the first camera is the canary: nobody else is asked until it has proven the build', () => {
    const h = make();
    h.add('A', { battery: 60 }); h.add('B', { battery: 95 }); h.add('C', { battery: 40 });
    h.eng.publish({ build: NEW, size: 56_000_000 });
    assert.deepStrictEqual(h.asked(), ['B'], 'the fullest battery leads');
    assert.deepStrictEqual({ build: h.sent[0].build, auto: h.sent[0].auto, net: h.sent[0].net, force: h.sent[0].force }, { build: NEW, auto: true, net: 'any', force: false });
    h.clock.t += 10 * MIN; h.eng.tick();
    assert.deepStrictEqual(h.asked(), ['B'], 'still waiting');
    assert.strictEqual(h.eng.status().state, 'proving');
    assert.strictEqual(h.eng.status().canary, 'B');
});

test('once the canary has run the new build for a few minutes the others follow, a few at a time', () => {
    const h = make({ parallel: 2 });
    for (const id of ['A', 'B', 'C', 'D', 'E']) h.add(id, { battery: id === 'A' ? 99 : 80 });
    h.eng.publish({ build: NEW, size: 1 });
    assert.deepStrictEqual(h.asked(), ['A']);
    h.updated('A');
    h.clock.t += 4 * MIN; h.eng.tick();
    assert.deepStrictEqual(h.asked(), ['A'], 'four minutes is not enough');
    h.clock.t += 2 * MIN; h.eng.tick();
    assert.strictEqual(h.eng.status().state, 'rolling');
    assert.deepStrictEqual(h.asked(), ['A', 'B', 'C'], 'two at a time');
    h.updated('B'); h.clock.t += MIN; h.eng.tick();
    assert.deepStrictEqual(h.asked(), ['A', 'B', 'C', 'D'], 'a place is free again');
    h.updated('C'); h.updated('D'); h.eng.tick();
    assert.deepStrictEqual(h.asked(), ['A', 'B', 'C', 'D', 'E']);
    h.updated('E');
    assert.strictEqual(h.eng.status().current, 5);
});

test('a camera updated on a docking station proves the build: no canary is needed', () => {
    const h = make();
    h.add('dockcam', { updateMode: 'off' }); h.add('far', {});
    h.eng.publish({ build: NEW, size: 1 });
    // the canary was chosen (far) because nothing had proven the build yet
    assert.deepStrictEqual(h.asked(), ['far']);
    const g = make();
    g.add('dockcam', { updateMode: 'off' });
    g.eng.publish({ build: NEW, size: 1 });
    g.updated('dockcam'); g.clock.t += 6 * MIN;
    g.add('far', {});
    g.eng.tick();
    assert.strictEqual(g.eng.status().state, 'rolling');
    assert.deepStrictEqual(g.asked(), ['far'], 'asked at once');
});

test('a camera that keeps losing its connection does not prove anything', () => {
    const h = make();
    h.add('flaky', { updateMode: 'off' });
    h.eng.publish({ build: NEW, size: 1 });
    h.updated('flaky'); h.clock.t += 20 * MIN;
    h.cams.get('flaky').onlineSince = h.clock.t - MIN;   // it just reconnected: it was offline a minute ago
    h.add('far', {}); h.eng.tick();
    assert.strictEqual(h.eng.status().state, 'proving');
});

test('every reason a camera is not asked', () => {
    const h = make({ parallel: 20 });
    h.add('canary', {});
    h.eng.publish({ build: NEW, size: 1 });
    h.updated('canary'); h.clock.t += 6 * MIN;
    const cases = {
        offline: { online: false }, recording: { recording: true }, live: { remote: true }, flat: { battery: 10 }, 'no-build': { appBuild: undefined },
        'wifi-old-app': { updateMode: 'wifi', caps: [] }, 'wifi-no-caps': { updateMode: 'wifi', caps: undefined }, current: { appBuild: NEW },
        busy: { update: { state: 'downloading', ts: h.clock.t } }, docked: {},
    };
    for (const [id, extra] of Object.entries(cases)) h.add(id, extra);
    h.docked(new Map([['docked', {}]]));
    h.eng.tick();
    assert.deepStrictEqual(h.asked().filter((id) => id !== 'canary'), [], 'none of them');
    // and the ones that are fine
    h.add('charging-flat', { battery: 5, charging: true }); h.add('wifi-ok', { updateMode: 'wifi' }); h.add('normal', {});
    h.cams.set('stale-busy', { cameraId: 'stale-busy', online: true, appBuild: OLD, updateMode: 'any', battery: 80, update: { state: 'downloading', ts: h.clock.t - 31 * MIN } });
    h.eng.tick();
    assert.deepStrictEqual(h.asked().filter((id) => id !== 'canary').sort(), ['charging-flat', 'normal', 'stale-busy', 'wifi-ok']);
    assert.strictEqual(h.eng.why(h.cams.get('flat')), 'battery');
    assert.strictEqual(h.eng.why(h.cams.get('wifi-old-app')), 'needs-app');
    assert.strictEqual(h.eng.why(h.cams.get('docked')), 'docked');
});

test('a download that fails is retried later with growing pauses, and not for ever', () => {
    const h = make({ parallel: 5 });
    h.add('A', { updateMode: 'off' }); h.add('far', {});
    h.eng.publish({ build: NEW, size: 1 });
    h.updated('A'); h.clock.t += 6 * MIN; h.eng.tick();   // far is asked (attempt 1)
    const pauses = [10, 30, 120, 360];
    for (const [i, p] of pauses.entries()) {
        const before = h.asked().length;
        h.cams.get('far').update = { state: 'failed', error: 'download failed (HTTP 502)', ts: h.clock.t };
        h.eng.progress('far', 'failed', 'download failed (HTTP 502)');
        h.clock.t += p * MIN - 1000; h.eng.tick();
        assert.strictEqual(h.asked().length, before, `still waiting after ${p} minutes - 1 s (attempt ${i + 1})`);
        h.clock.t += 2000; h.eng.tick();
        assert.strictEqual(h.asked().length, before + 1, `asked again after ${p} minutes`);
    }
    h.cams.get('far').update = { state: 'failed', error: 'SocketException: connection reset', ts: h.clock.t };
    h.eng.progress('far', 'failed', 'SocketException: connection reset');
    h.clock.t += 24 * 60 * MIN; h.eng.tick();
    assert.strictEqual(h.eng.why(h.cams.get('far')), 'gave-up', 'five attempts are enough');
});

test('a canary that cannot download hands the lead to another camera', () => {
    const h = make();
    h.add('A', { battery: 90 }); h.add('B', { battery: 70 });
    h.eng.publish({ build: NEW, size: 1 });
    assert.deepStrictEqual(h.asked(), ['A']);
    h.cams.get('A').update = { state: 'failed', error: 'download failed (HTTP 500)', ts: h.clock.t };
    h.eng.progress('A', 'failed', 'download failed (HTTP 500)');
    h.eng.tick();
    assert.deepStrictEqual(h.asked(), ['A', 'B']);
    assert.strictEqual(h.eng.status().canary, 'B');
});

test('a canary whose install is refused stops the whole rollout until an administrator resumes it', () => {
    const h = make({ parallel: 5 });
    h.add('A', { battery: 90 }); h.add('B', {}); h.add('C', {});
    h.eng.publish({ build: NEW, size: 1 });
    h.cams.get('A').update = { state: 'failed', error: 'INSTALL_FAILED_VERSION_DOWNGRADE', ts: h.clock.t };
    h.eng.progress('A', 'failed', 'INSTALL_FAILED_VERSION_DOWNGRADE');
    const s = h.eng.status();
    assert.strictEqual(s.state, 'halted'); assert.match(s.note, /A refused the new build/);
    h.clock.t += 60 * MIN; h.eng.tick(); h.eng.seen('B');
    assert.deepStrictEqual(h.asked(), ['A'], 'nothing more is sent');
    assert.ok(h.audits.some((a) => /^update_halted_/.test(a.action)));
    assert.strictEqual(h.eng.resume('admin'), true);
    assert.strictEqual(h.eng.status().state, 'rolling');
    h.eng.tick();
    assert.deepStrictEqual(h.asked().slice(1).sort(), ['B', 'C'], 'after the administrator looked it goes on, but not with the camera that refused');
    assert.strictEqual(h.eng.why(h.cams.get('A')), 'refused');
});

test('two cameras refusing the build halt a rollout that was already running', () => {
    const h = make({ parallel: 9 });
    h.add('A', {}); h.add('B', {}); h.add('C', {}); h.add('D', {}); h.add('dock', { updateMode: 'off' });
    h.eng.publish({ build: NEW, size: 1 });
    h.updated('dock'); h.clock.t += 6 * MIN; h.eng.tick();
    assert.strictEqual(h.eng.status().state, 'rolling');
    h.eng.progress('B', 'failed', 'INSTALL_FAILED_OLDER_SDK');
    assert.strictEqual(h.eng.status().state, 'rolling', 'one refusal is a phone problem');
    h.eng.progress('C', 'failed', 'INSTALL_FAILED_OLDER_SDK');
    assert.strictEqual(h.eng.status().state, 'halted');
});

test('an administrator can pause the automatic updates', () => {
    const h = make();
    h.add('A', {});
    h.eng.publish({ build: NEW, size: 1 });
    assert.strictEqual(h.eng.halt('admin', 'Wait for the customer'), true);
    h.eng.progress('A', 'failed', 'whatever');
    assert.strictEqual(h.eng.status().state, 'halted'); assert.strictEqual(h.eng.status().note, 'Wait for the customer');
});

test('a canary that installed the build and never came back halts the rollout; one that never got as far does not', () => {
    const lost = make();
    lost.add('A', {}); lost.add('B', {});
    lost.eng.publish({ build: NEW, size: 1 });
    lost.cams.get('A').update = { state: 'installing', ts: lost.clock.t };
    lost.clock.t += 31 * MIN; lost.eng.tick();
    assert.strictEqual(lost.eng.status().state, 'halted'); assert.match(lost.eng.status().note, /did not come back/);

    const slow = make();
    slow.add('A', { battery: 90 }); slow.add('B', { battery: 50 });
    slow.eng.publish({ build: NEW, size: 1 });
    slow.cams.get('A').update = { state: 'downloading', ts: slow.clock.t };
    slow.cams.get('A').online = false;
    slow.clock.t += 31 * MIN; slow.eng.tick();
    assert.strictEqual(slow.eng.status().state, 'proving', 'it was only the network');
    assert.deepStrictEqual(slow.asked(), ['A', 'B'], 'another camera leads');
});

test('a camera that connects later is asked at its turn, not before', () => {
    const h = make();
    h.add('A', {});
    h.eng.publish({ build: NEW, size: 1 });
    h.add('late', { online: false });
    h.cams.get('late').online = true;
    h.eng.seen('late');
    assert.deepStrictEqual(h.asked(), ['A'], 'the canary is still out: wait');
    h.updated('A'); h.clock.t += 6 * MIN; h.eng.tick();
    h.cams.set('later', { cameraId: 'later', online: true, appBuild: OLD, updateMode: 'any', battery: 90, caps: [] });
    h.eng.seen('later');
    assert.ok(h.asked().includes('later'), 'rolling: asked the moment it shows up');
});

test('a new build starts its own rollout from the beginning', () => {
    const h = make();
    h.add('A', {}); h.add('B', {});
    h.eng.publish({ build: NEW, size: 1 });
    h.updated('A'); h.clock.t += 6 * MIN; h.eng.tick();
    assert.strictEqual(h.eng.status().state, 'rolling');
    h.build({ build: NEWER, size: 1 });
    h.eng.publish({ build: NEWER, size: 1 });
    assert.strictEqual(h.eng.status().build, NEWER);
    assert.strictEqual(h.eng.status().state, 'proving', 'proved for the old build, not for this one');
});

test('the administrator sees how it stands', () => {
    const h = make({ parallel: 1 });
    h.add('A', {}); h.add('B', {}); h.add('C', { updateMode: 'off' }); h.add('D', { appBuild: NEW });
    h.eng.publish({ build: NEW, size: 1 });
    const s = h.eng.status();
    assert.deepStrictEqual({ remote: s.remote, current: s.current, updating: s.updating, waiting: s.waiting, failed: s.failed }, { remote: 3, current: 1, updating: 1, waiting: 1, failed: 0 });
});

test('what counts as the network\'s fault', () => {
    for (const e of ['download failed (HTTP 502)', 'SocketException: Connection reset by peer', 'TimeoutException after 0:00:15', 'download is corrupt (checksum differs)', 'HandshakeException']) assert.strictEqual(rollout.isNetworkFailure(e), true, e);
    for (const e of ['INSTALL_FAILED_UPDATE_INCOMPATIBLE', 'INSTALL_FAILED_INSUFFICIENT_STORAGE', 'install failed', '']) assert.strictEqual(rollout.isNetworkFailure(e), false, e);
});
