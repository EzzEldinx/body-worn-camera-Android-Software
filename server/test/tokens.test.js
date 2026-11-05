const test = require('node:test');
const assert = require('node:assert');
const { issueToken, hashToken, safeEqual } = require('../tokens');

test('tokens are unique, prefixed and hashed deterministically', () => {
    const a = issueToken(), b = issueToken();
    assert.notStrictEqual(a, b);
    assert.match(a, /^bwc_[0-9a-f]{48}$/);
    assert.strictEqual(hashToken(a), hashToken(a));
    assert.notStrictEqual(hashToken(a), hashToken(b));
    assert.strictEqual(hashToken(a).length, 64);
});
test('safeEqual compares in constant time and handles length mismatch', () => {
    assert.ok(safeEqual('abc', 'abc'));
    assert.ok(!safeEqual('abc', 'abd'));
    assert.ok(!safeEqual('abc', 'abcd'));
});
