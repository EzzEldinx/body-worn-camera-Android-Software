// The public keys this server accepts licences from. They can only VERIFY: Smart Way's private signing key stays on Smart Way's own computer
// (tools/license/vg-license.js). To rotate the key, add the new one here, ship the update, then issue licences with it.
const fs = require('fs');

const BUILT_IN = [
    { kid: 'sw-8a40c1ed', pem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAZykeN5OJRQ7/gXJgyr+ZrDJLcUsIg1tBfpL4Gaw++8c=
-----END PUBLIC KEY-----
` },
];

function keys(env = process.env) {
    // Only the automated tests may swap the key (they sign with a throw-away key); a running server never trusts anything but the built-in ones.
    if (env.NODE_TEST_CONTEXT && env.LICENSE_PUBKEY_FILE) return [{ kid: 'test', pem: fs.readFileSync(env.LICENSE_PUBKEY_FILE, 'utf8') }];
    return BUILT_IN;
}
module.exports = { keys, BUILT_IN };
