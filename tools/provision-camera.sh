#!/usr/bin/env bash
# Mac/Linux version of "update-cameras.ps1 -Provision" for ONE camera on USB / the dock.
#   tools/provision-camera.sh <adb-serial> <BWC-xx-RIY> <token> [server-url]
#   tools/provision-camera.sh --config-only <adb-serial> <BWC-xx-RIY> <token> [server-url]   (camera already has the app: only write id/token)
# Installs the latest release APK, makes it device owner + Home app (silent updates), writes config.json, starts it.
# The token comes from Dashboard > Companies > Issue (shown once). It is written to the camera only, never to the repo.
set -euo pipefail
ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"; PKG=com.swg.swg_bwc
CONFIG_ONLY=0; [ "${1:-}" = "--config-only" ] && { CONFIG_ONLY=1; shift; }
S="${1:?serial}"; ID="${2:?camera id}"; TOKEN="${3:?token}"; SERVER="${4:-${VG_SERVER:-https://visionguard.smartwaygroup.com.sa}}"
APK="$(cd "$(dirname "$0")/.." && pwd)/app/build/app/outputs/flutter-apk/app-release.apk"
D="/sdcard/Android/data/$PKG/files"
a() { "$ADB" -s "$S" "$@"; }
write_config() {
  python3 -c 'import json,sys; print(json.dumps({"id":sys.argv[1],"server":sys.argv[2],"token":sys.argv[3]}), end="")' "$ID" "$SERVER" "$TOKEN" > /tmp/vgcfg.$$
  a shell mkdir -p "$D"; a push /tmp/vgcfg.$$ "$D/config.json" >/dev/null; rm -f /tmp/vgcfg.$$
}
if [ "$CONFIG_ONLY" = 0 ]; then
  [ -f "$APK" ] || { echo "APK not found: $APK"; exit 1; }
  bat=$(a shell dumpsys battery | grep level | tr -dc 0-9); [ "${bat:-0}" -ge 15 ] || { echo "battery $bat%: charge it first"; exit 1; }
  a install -r -g "$APK" | tail -1
  for p in CAMERA RECORD_AUDIO ACCESS_FINE_LOCATION ACCESS_COARSE_LOCATION READ_EXTERNAL_STORAGE WRITE_EXTERNAL_STORAGE POST_NOTIFICATIONS; do a shell pm grant $PKG android.permission.$p 2>/dev/null || true; done
  a shell appops set $PKG REQUEST_INSTALL_PACKAGES allow || true
  for u in $(a shell pm list users | grep -o 'UserInfo{[0-9]*:Guest' | grep -o '[0-9]*'); do a shell pm remove-user "$u" >/dev/null || true; done
  a shell am force-stop com.android.launcher3 || true
  a shell dumpsys duraspeed addwhitelist $PKG >/dev/null 2>&1 || true
  a shell dpm set-device-owner "$PKG/.BwcAdminReceiver" | head -1
fi
a shell settings put secure location_mode 3 || true   # GPS on
for p in ACCESS_FINE_LOCATION ACCESS_COARSE_LOCATION; do a shell pm grant $PKG android.permission.$p 2>/dev/null || true; done
write_config
a shell am force-stop $PKG; a shell am start -n "$PKG/.MainActivity" >/dev/null; sleep 4
a shell cmd package set-home-activity "$PKG/.HomeAlias" >/dev/null 2>&1 || true
echo "done: $ID on $S -> $SERVER"
