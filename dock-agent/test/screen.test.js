// What the camera's own screen says while it sits on the docking station. Run: node --test dock-agent/test
const test = require('node:test');
const assert = require('node:assert');
const { create, encode, writeCommand, clearCommand, FILE, T } = require('../screen');

const idle = { state: 'synced' };

test('a camera that has just been docked says "connected" until the first check is done', () => {
    const s = create();
    assert.strictEqual(s.view('A', idle, 1000).phase, 'connected');
    assert.strictEqual(s.view('A', idle, 3000).phase, 'connected', 'still checking');
});

test('nothing to do: "up to date" for a few seconds, then the screen goes back to normal', () => {
    const s = create();
    s.view('A', idle, 1000);
    const v = s.view('A', { ...idle, check: 'current' }, 2000);
    assert.deepStrictEqual([v.phase, v.title, v.detail], ['done', 'All done', 'Everything is up to date']);
    assert.strictEqual(s.view('A', { ...idle, check: 'current' }, 2000 + T.upToDate - 1).phase, 'done');
    assert.strictEqual(s.view('A', { ...idle, check: 'current' }, 2000 + T.upToDate + 1), null);
    assert.strictEqual(s.view('A', { ...idle, check: 'current' }, 60_000), null, 'and it stays quiet on every later cycle');
});

test('a check that ended with a reason to wait (battery, recording) shows nothing at all', () => {
    const s = create();
    s.view('A', idle, 1000);
    assert.strictEqual(s.view('A', { ...idle, check: 'other' }, 2000), null);
});

test('the "connected" window never stays longer than a few seconds, even if the check never reports', () => {
    const s = create();
    s.view('A', idle, 0);
    assert.strictEqual(s.view('A', idle, T.checkMax + 1), null);
});

test('updating: the camera is told not to be unplugged, then "software updated" is shown and fades', () => {
    const s = create();
    s.view('A', idle, 0);
    const u = s.view('A', { state: 'updating' }, 1000);
    assert.deepStrictEqual([u.phase, u.title], ['updating', 'Updating the camera software']);
    assert.match(u.detail, /Do not unplug/);
    const d = s.view('A', { state: 'connected', message: 'Camera app updated', check: 'other' }, 9000);
    assert.deepStrictEqual([d.phase, d.detail], ['done', 'Camera software updated']);
    assert.strictEqual(s.view('A', idle, 9000 + T.done + 1), null);
});

test('uploading: file x of y, and the bar moves inside a big file from the bytes copied so far', () => {
    const s = create();
    s.view('A', idle, 0);
    const p = { index: 2, total: 5, file: 'VID_1.mp4', bytesDone: 300, bytesTotal: 1000 };
    const v = s.view('A', { state: 'offloading', progress: p, partBytes: 200 }, 1000);
    assert.deepStrictEqual([v.phase, v.title, v.detail, v.current, v.total, v.percent], ['uploading', 'Uploading recordings', 'File 2 of 5', 2, 5, 50]);
    assert.strictEqual(s.view('A', { state: 'offloading', progress: { ...p, bytesDone: 1000 }, partBytes: 0 }, 2000).percent, 99, 'never 100 % before it is finished');
    assert.strictEqual(s.view('A', { state: 'offloading', progress: { ...p, bytesTotal: 0 } }, 3000).percent, null, 'unknown size: the bar just runs');
    assert.strictEqual(s.view('A', { state: 'offloading', progress: { index: 1, total: 1, bytesTotal: 10 } }, 4000).detail, 'Please wait. Do not unplug the camera.');
    assert.strictEqual(s.view('A', idle, 5000).detail, 'Recordings uploaded');
});

test('update and upload in one visit say both', () => {
    const s = create();
    s.view('A', idle, 0);
    s.view('A', { state: 'updating' }, 1000);
    s.view('A', { state: 'offloading', progress: { index: 1, total: 2, bytesTotal: 1 } }, 2000);
    assert.strictEqual(s.view('A', idle, 3000).detail, 'Software updated and recordings uploaded');
});

test('an error is shown once for a few seconds, a different error is shown again', () => {
    const s = create();
    s.view('A', idle, 0);
    const e = s.view('A', { state: 'error', message: 'App update failed: no space' }, 1000);
    assert.deepStrictEqual([e.phase, e.title, e.detail], ['attention', 'Needs attention', 'App update failed: no space']);
    assert.strictEqual(s.view('A', { state: 'error', message: 'App update failed: no space' }, 1000 + T.attention).phase, 'attention');
    assert.strictEqual(s.view('A', { state: 'error', message: 'App update failed: no space' }, 1000 + T.attention + 1), null, 'no nagging');
    assert.strictEqual(s.view('A', { state: 'error', message: 'Camera app needs migration' }, 40_000).detail, 'Camera app needs migration');
    assert.strictEqual(s.view('A', { state: 'error', message: 'x'.repeat(300) }, 90_000).detail.length, 90, 'a long message fits the screen');
});

test('cameras do not influence each other, and a camera that left the dock starts again when it returns', () => {
    const s = create();
    s.view('A', idle, 0); s.view('B', idle, 0);
    s.view('A', { state: 'updating' }, 1000);
    assert.strictEqual(s.view('B', { ...idle, check: 'other' }, 1500), null);
    assert.strictEqual(s.view('A', { state: 'updating' }, 2000).phase, 'updating');
    s.forget('B');
    assert.strictEqual(s.view('B', idle, 30_000).phase, 'connected');
});

test('the file for the camera is a single safe shell command and the text survives intact', () => {
    const v = { phase: 'attention', title: 'Needs attention', detail: `it's "bad" $(rm -rf /) ; \`x\` \\ and ... é` };
    const body = encode(v, 123);
    const cmd = writeCommand('/sdcard/Android/data/com.swg.swg_bwc/files', body);
    assert.match(cmd, /^echo [A-Za-z0-9+/=]+ \| base64 -d > \/sdcard\/.+\/\.dock-status\.tmp && mv \/sdcard\/.+\/\.dock-status\.tmp \/sdcard\/.+\/dock-status\.json$/);
    const b64 = /^echo (\S+) /.exec(cmd)[1];
    assert.deepStrictEqual(JSON.parse(Buffer.from(b64, 'base64').toString()), { v: 1, ...v, ts: 123 });
    assert.strictEqual(clearCommand('/d'), `rm -f /d/${FILE}`);
});
