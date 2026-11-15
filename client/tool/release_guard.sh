#!/usr/bin/env bash
# Run before every store build (from the client folder):  tool/release_guard.sh https://your-domain
# Fails while the app could still talk plain HTTP, is not set up to be signed for the store, or lacks Apple's privacy file.
set -u
bad=0
fail() { echo "FAIL: $1"; bad=1; }
if grep -q "NSAllowsArbitraryLoads" ios/Runner/Info.plist 2>/dev/null; then fail "ios/Runner/Info.plist allows plain HTTP (run tool/ios-allow-http.sh off)"; fi
if grep -q 'usesCleartextTraffic="true"' android/app/src/main/AndroidManifest.xml 2>/dev/null; then fail "AndroidManifest.xml allows plain HTTP"; fi
if [ -n "${ORG_GRADLE_PROJECT_allowHttp:-}" ]; then fail "ORG_GRADLE_PROJECT_allowHttp is set in this shell: the Android build would allow plain HTTP"; fi
if grep -rn "178\.162\.235" lib 2>/dev/null | grep -v "^lib/core/env.dart" | grep -q .; then fail "a test server address is hard-coded outside lib/core/env.dart"; fi
[ -f ios/Runner/PrivacyInfo.xcprivacy ] || fail "ios/Runner/PrivacyInfo.xcprivacy is missing (Apple requires it)"
[ -f android/key.properties ] || fail "android/key.properties is missing: no upload key, the store bundle cannot be signed (see STORE.md)"
if [ "${1:-}" != "" ]; then case "$1" in https://*) ;; *) fail "the server address must start with https:// (got: $1)";; esac; else echo "note: pass the server address to check it, e.g. tool/release_guard.sh https://visionguard.example.com"; fi
[ $bad = 0 ] && echo "release guard: OK"
exit $bad
