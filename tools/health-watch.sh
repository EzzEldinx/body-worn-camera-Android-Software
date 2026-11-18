#!/usr/bin/env bash
# Watches the VisionGuard server from outside: every minute it asks /healthz; two failures in a row = a macOS notification
# (and a message to HEALTH_WEBHOOK, a Slack/Teams incoming-webhook URL, if you set one), and again when it is back.
#   tools/health-watch.sh https://visionguard.smartwaygroup.com.sa
# To keep it running: tools/health-watch.sh --install https://visionguard.smartwaygroup.com.sa   (a launchd service; --uninstall removes it)
set -u
LABEL=com.visionguard.health-watch; PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
if [ "${1:-}" = "--uninstall" ]; then launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null; rm -f "$PLIST"; echo "health watch removed"; exit 0; fi
if [ "${1:-}" = "--install" ]; then
  URL="${2:?usage: --install <server-url>}"; SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array><string>/bin/bash</string><string>$SELF</string><string>$URL</string></array>
<key>EnvironmentVariables</key><dict><key>HEALTH_WEBHOOK</key><string>${HEALTH_WEBHOOK:-}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>
P
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null; launchctl bootstrap "gui/$(id -u)" "$PLIST"; echo "health watch installed for $URL"; exit 0
fi
URL="${1:?usage: health-watch.sh <server-url>}"; URL="${URL%/}"; fails=0; down=0
say() { echo "$(date '+%H:%M:%S') $1"; osascript -e "display notification \"$1\" with title \"VisionGuard\"" 2>/dev/null
  [ -n "${HEALTH_WEBHOOK:-}" ] && curl -s -m 10 -H 'Content-Type: application/json' -d "{\"text\":\"VisionGuard: $1\"}" "$HEALTH_WEBHOOK" >/dev/null; }
while true; do
  code=$(curl -s -m 10 -o /tmp/vg-health.json -w '%{http_code}' "$URL/healthz" || echo 000)
  if [ "$code" = 200 ]; then fails=0; [ "$down" = 1 ] && { down=0; say "the server is back ($(tr -d '\n' </tmp/vg-health.json | cut -c1-120))"; }
  else fails=$((fails+1)); if [ "$fails" -ge 2 ] && [ "$down" = 0 ]; then down=1; say "the server does not answer healthy (HTTP $code)"; fi; fi
  sleep 60
done
