#!/usr/bin/env bash
# TEST builds only: let the iOS app talk plain HTTP (for example to a test server reached by IP address).
#   tool/ios-allow-http.sh on     add the exception
#   tool/ios-allow-http.sh off    remove it again (do this before a store build; tool/release_guard.sh fails while it is on)
set -eu
P="$(cd "$(dirname "$0")/.." && pwd)/ios/Runner/Info.plist"
case "${1:-}" in
  on)  /usr/libexec/PlistBuddy -c "Delete :NSAppTransportSecurity" "$P" 2>/dev/null || true
       /usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity dict" -c "Add :NSAppTransportSecurity:NSAllowsArbitraryLoads bool true" "$P"
       echo "iOS test build: plain HTTP is now allowed. Run '$0 off' before a store build." ;;
  off) /usr/libexec/PlistBuddy -c "Delete :NSAppTransportSecurity" "$P" 2>/dev/null || true
       echo "iOS: plain HTTP is not allowed (store setting)." ;;
  *)   echo "usage: $0 on|off"; exit 2 ;;
esac
