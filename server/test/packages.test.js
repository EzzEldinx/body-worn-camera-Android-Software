const test = require('node:test');
const assert = require('node:assert');
const { PACKAGES, parsePackage, canAddCamera, canGoLive } = require('../packages');

test('packages are 20/60/100/500/1000/3000 cameras', () => {
    assert.deepStrictEqual(PACKAGES.map((p) => p.maxCameras), [20, 60, 100, 500, 1000, 3000]);
    PACKAGES.forEach((p) => assert.ok(p.maxLive >= 1 && p.maxLive <= p.maxCameras));
});
test('parsePackage: unlimited, valid, invalid, live override', () => {
    assert.deepStrictEqual(parsePackage(undefined), { maxCameras: null, maxLive: null });
    assert.deepStrictEqual(parsePackage(60), { maxCameras: 60, maxLive: 20 });
    assert.ok(parsePackage(77).error);
    assert.strictEqual(parsePackage(60, 10).maxLive, 10);
    assert.ok(parsePackage(60, 61).error);
    assert.ok(parsePackage(60, 0).error);
});
test('camera and live caps', () => {
    assert.ok(canAddCamera({ maxCameras: 20 }, 19));
    assert.ok(!canAddCamera({ maxCameras: 20 }, 20));
    assert.ok(canAddCamera({ maxCameras: null }, 9999));
    assert.ok(canGoLive({ maxLive: 8 }, 7));
    assert.ok(!canGoLive({ maxLive: 8 }, 8));
});
