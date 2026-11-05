#!/usr/bin/env bash
# Run before every store build: fails if the app is still allowed to talk plain HTTP.
set -u
bad=0
if grep -q "NSAllowsArbitraryLoads" ios/Runner/Info.plist 2>/dev/null; then echo "FAIL: ios/Runner/Info.plist still allows arbitrary (HTTP) loads"; bad=1; fi
if grep -q 'usesCleartextTraffic="true"' android/app/src/main/AndroidManifest.xml 2>/dev/null; then echo "FAIL: AndroidManifest.xml still allows cleartext traffic"; bad=1; fi
if grep -rn "178\.162\.235" lib 2>/dev/null | grep -v "^lib/core/env.dart" | grep -q .; then echo "FAIL: a test server address is hard-coded outside lib/core/env.dart"; bad=1; fi
[ $bad = 0 ] && echo "release guard: OK"
exit $bad
