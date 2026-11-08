#!/usr/bin/env bash
# Installs the VisionGuard Dock Agent as a background service on macOS: it starts at login, restarts if it stops,
# and detects docked cameras by itself (every 15 s). Nothing to click or type after this.
#
#   DOCK_LOCATION=24.65997,46.71219 ./install-macos.sh https://your-server DOCK_TOKEN [dock-id]   (DOCK_LOCATION = where the dock stands)
#   ./install-macos.sh --uninstall
set -euo pipefail
LABEL=com.visionguard.dock-agent
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true; rm -f "$PLIST"; echo "Dock Agent service removed."; exit 0
fi
SERVER="${1:?usage: install-macos.sh <server-url> <dock-token> [dock-id]}"; TOKEN="${2:?missing dock token}"; DOCK_ID="${3:-$(hostname -s)}"
NODE="$(command -v node)" || { echo "Node 22+ is required (brew install node)"; exit 1; }
ADB="${ADB:-$(command -v adb || true)}"; [ -z "$ADB" ] && ADB="$HOME/Library/Android/sdk/platform-tools/adb"
[ -x "$ADB" ] || { echo "adb not found (brew install --cask android-platform-tools)"; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
umask 077   # the plist holds the token: readable by this user only
cat > "$PLIST" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$HERE/agent.js</string><string>--interval</string><string>15</string>
    <string>--latest</string><string>${DOCK_LATEST:-5}</string><string>--since</string><string>${DOCK_SINCE:-today}</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>DOCK_SERVER</key><string>$SERVER</string><key>DOCK_TOKEN</key><string>$TOKEN</string>
    <key>DOCK_ID</key><string>$DOCK_ID</string><key>DOCK_LOCATION</key><string>${DOCK_LOCATION:-}</string><key>ADB</key><string>$ADB</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/visionguard-dock.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/visionguard-dock.log</string>
</dict></plist>
P
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Dock Agent installed and running (dock id: $DOCK_ID). Log: ~/Library/Logs/visionguard-dock.log"
echo "Copy-only: files stay on the cameras. Remove with: $0 --uninstall"
