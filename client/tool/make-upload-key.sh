#!/usr/bin/env bash
# Creates the Android UPLOAD key of the owner app (once) and android/key.properties, asking for the password in the terminal.
# The password is never shown, never put in a file other than key.properties (chmod 600, git-ignored) and never sent anywhere.
#   tool/make-upload-key.sh
# Keep ~/.visionguard/visionguard-owner-upload.jks and its password in TWO safe places: with Play App Signing a lost upload key can be reset
# by Google, but it takes days.
set -euo pipefail
cd "$(dirname "$0")/.."
KS="$HOME/.visionguard/visionguard-owner-upload.jks"
PROPS="android/key.properties"
if [ -f "$KS" ]; then echo "An upload key already exists: $KS (not replaced)."; else
  mkdir -p "$HOME/.visionguard" && chmod 700 "$HOME/.visionguard"
  read -r -s -p "Choose a password for the upload key (at least 8 characters): " P1; echo
  read -r -s -p "Type it again: " P2; echo
  [ "$P1" = "$P2" ] || { echo "The two passwords differ. Nothing was created."; exit 1; }
  [ ${#P1} -ge 8 ] || { echo "Too short. Nothing was created."; exit 1; }
  export VG_KS_PASS="$P1"   # through the environment, not the command line (other programs can read command lines)
  keytool -genkeypair -storetype PKCS12 -keystore "$KS" -alias upload -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass:env VG_KS_PASS -keypass:env VG_KS_PASS -dname "CN=VisionGuard, O=Smart Way Group, L=Riyadh, C=SA" >/dev/null
  chmod 600 "$KS"
  umask 077
  printf 'storeFile=%s\nstorePassword=%s\nkeyAlias=upload\nkeyPassword=%s\n' "$KS" "$P1" "$P1" > "$PROPS"
  unset P1 P2 VG_KS_PASS
  echo "Upload key created: $KS"
  echo "Settings written: client/$PROPS (git-ignored, only you can read it)"
fi
if [ ! -f "$PROPS" ]; then echo "$PROPS is missing: write it by hand (see docs/STORE_PUBLISHING.md)."; exit 1; fi
VG_KS_PASS="$(sed -n 's/^storePassword=//p' "$PROPS")" keytool -list -v -keystore "$KS" -storepass:env VG_KS_PASS -alias upload 2>/dev/null | grep -iE "fingerprint|SHA-256" | head -2
echo "Back these up now: $KS and its password."
