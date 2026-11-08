#!/usr/bin/env bash
# Mac/Linux version of publish-build.ps1: uploads the latest camera APK to the server as the build every camera should run.
#   tools/publish-build.sh https://your-server [--build]
# Asks for an admin username and password (not stored). Afterwards the Dock Agent installs the build on every docked camera by itself
# (Dashboard > Updates shows which cameras are up to date). --build compiles the APK first (needs JDK 21: JAVA_HOME).
set -euo pipefail
SERVER="${1:?usage: publish-build.sh <server-url> [--build]}"; SERVER="${SERVER%/}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; APK="$ROOT/app/build/app/outputs/flutter-apk/app-release.apk"
if [ "${2:-}" = "--build" ]; then (cd "$ROOT/app/android" && ./gradlew assembleRelease); fi
[ -f "$APK" ] || { echo "APK not found: $APK (run with --build)"; exit 1; }
read -r -p "Admin username: " U; read -r -s -p "Password: " P; echo
JAR="$(mktemp)"; trap 'rm -f "$JAR"' EXIT
code=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" -H 'Content-Type: application/json' -d "$(python3 -c 'import json,sys;print(json.dumps({"username":sys.argv[1],"password":sys.argv[2]}))' "$U" "$P")" "$SERVER/api/login")
[ "$code" = 200 ] || { echo "Login failed ($code)"; exit 1; }
echo "Uploading $(du -h "$APK" | cut -f1) ..."
curl -s -b "$JAR" -X PUT --data-binary @"$APK" "$SERVER/api/admin/update/apk" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("published build", d.get("build","?")[:12]) if d.get("ok") else (print("failed:", d), sys.exit(1))'
