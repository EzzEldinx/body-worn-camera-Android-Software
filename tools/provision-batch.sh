#!/usr/bin/env bash
# Set up MANY new cameras in a row: plug each one in (USB or dock), and this script gives it the next free name, issues its own token and installs everything.
#   tools/provision-batch.sh [--server https://visionguard.smartwaygroup.com.sa] [--prefix BWC-] [--suffix -RIY] [--start N] [--watch] [--dry-run]
# - Without --watch it handles every new camera plugged in right now, then stops. With --watch it keeps waiting for the next one (Ctrl+C to finish).
# - A camera that already has the app and a config.json is left alone (never gets a second token). A camera is named BWC-nn-RIY with nn = the next number
#   after the highest one on the server (or --start). Names already on the server are never reused (that would rotate a working camera's token).
# - Asks for an admin username and password (not stored). Tokens are never printed or saved; a list "serial,id,date" is kept in ~/.visionguard-provisioned.csv.
# Needs: adb, python3, curl, the release APK built (tools/provision-camera.sh installs it), USB debugging ON and "Allow" tapped on each camera.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"; PKG=com.swg.swg_bwc
SERVER="https://visionguard.smartwaygroup.com.sa"; PREFIX="BWC-"; SUFFIX="-RIY"; START=""; WATCH=0; DRY=0
while [ $# -gt 0 ]; do case "$1" in
  --server) SERVER="${2:?}"; shift 2;; --prefix) PREFIX="${2?}"; shift 2;; --suffix) SUFFIX="${2?}"; shift 2;;
  --start) START="${2:?}"; shift 2;; --watch) WATCH=1; shift;; --dry-run) DRY=1; shift;;
  -h|--help) sed -n 2,9p "$0"; exit 0;; *) echo "unknown option $1"; exit 2;; esac; done
SERVER="${SERVER%/}"; LOG="$HOME/.visionguard-provisioned.csv"
[ -x "$ADB" ] || ADB="$(command -v adb || true)"; [ -n "$ADB" ] || { echo "adb not found (set ADB=...)"; exit 1; }

read -r -p "Admin username: " U; read -r -s -p "Password: " P; echo
JAR="$(mktemp)"; trap 'rm -f "$JAR"' EXIT
code=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" -H 'Content-Type: application/json' \
  -d "$(python3 -c 'import json,sys;print(json.dumps({"username":sys.argv[1],"password":sys.argv[2]}))' "$U" "$P")" "$SERVER/api/login")
unset P
[ "$code" = 200 ] || { echo "Login failed ($code)"; exit 1; }

# ids that exist on the server -> the next free number
next_number() {
  curl -s -b "$JAR" "$SERVER/api/admin/update" | python3 -c '
import json,re,sys
pre,suf,start=sys.argv[1],sys.argv[2],sys.argv[3]
ids=[c["id"] for c in json.load(sys.stdin).get("cameras",[])]
rx=re.compile("^"+re.escape(pre)+r"(\d+)"+re.escape(suf)+"$")
nums=[int(m.group(1)) for i in ids for m in [rx.match(i)] if m]
n=max(nums)+1 if nums else 1
if start: n=max(n,int(start))
print(n)' "$PREFIX" "$SUFFIX" "$START"
}
exists_on_server() {   # $1 = id
  curl -s -b "$JAR" "$SERVER/api/admin/update" | python3 -c 'import json,sys; print("yes" if sys.argv[1] in [c["id"] for c in json.load(sys.stdin).get("cameras",[])] else "no")' "$1"
}
NEXT="$(next_number)"; [ -n "$NEXT" ] || { echo "could not read the camera list from the server"; exit 1; }
echo "Next free camera name: ${PREFIX}$(printf '%02d' "$NEXT")${SUFFIX}"
declare -a DONE=()
seen() { case " ${DONE[*]:-} " in *" $1 "*) return 0;; esac; return 1; }

handle() {   # $1 = adb serial
  local s="$1" a="$ADB -s $1" id token has cfg
  has=$($a shell pm list packages "$PKG" 2>/dev/null | tr -d '\r' | grep -c "package:$PKG\$")
  cfg=$($a shell "[ -f /sdcard/Android/data/$PKG/files/config.json ] && echo yes || echo no" 2>/dev/null | tr -d '\r')
  if [ "$has" = 1 ] && [ "$cfg" = yes ]; then
    echo "[$s] already set up ($($a shell cat /sdcard/Android/data/$PKG/files/config.json | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id","?"))' 2>/dev/null)): left alone"; return 0
  fi
  id="${PREFIX}$(printf '%02d' "$NEXT")${SUFFIX}"
  if [ "$(exists_on_server "$id")" = yes ]; then NEXT=$((NEXT+1)); id="${PREFIX}$(printf '%02d' "$NEXT")${SUFFIX}"; fi
  if [ "$DRY" = 1 ]; then echo "[$s] would become $id"; NEXT=$((NEXT+1)); return 0; fi
  echo "[$s] new camera -> $id"
  token=$(curl -s -b "$JAR" -X POST "$SERVER/api/admin/cameras/$id/token" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("token") or "")' 2>/dev/null)
  [ -n "$token" ] || { echo "[$s] could not get a token for $id (licence limit? not an admin?). Skipped."; return 1; }
  if "$HERE/provision-camera.sh" "$s" "$id" "$token" "$SERVER"; then
    echo "$s,$id,$(date +%F)" >> "$LOG"; echo "[$s] OK: $id is ready. Set its company, region and holder in the dashboard."; NEXT=$((NEXT+1))
  else
    echo "[$s] FAILED while installing $id (the token was issued; running this script again gives the camera a new one)."; return 1
  fi
}

round() {
  local out s st
  out=$($ADB devices | tail -n +2 | tr -d '\r')
  while read -r s st; do
    [ -n "$s" ] || continue
    if [ "$st" = unauthorized ]; then seen "U$s" || { echo "[$s] tap \"Allow\" for USB debugging on the camera screen"; DONE+=("U$s"); }; continue; fi
    [ "$st" = device ] || continue
    seen "$s" && continue
    handle "$s"; DONE+=("$s")
  done <<< "$out"
}
round
if [ "$WATCH" = 1 ]; then echo "Waiting for the next camera (Ctrl+C to finish)..."; while true; do sleep 4; round; done; fi
echo "Done."
