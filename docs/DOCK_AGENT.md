# VisionGuard Dock Agent

Last updated: 2026-11-23

Code: `dock-agent/` (Node.js 22, `adb`). Tests: `node --test dock-agent/test/*.test.js`.

Runs on the PC next to the docking station. Pulls recordings from every camera over USB, verifies them
(SHA-256 on the camera, on the PC and again on the server), uploads them, and optionally deletes them from the camera.

```bash
# server side: set DOCK_TOKEN in server/.env
DOCK_SERVER=https://visionguard.smartwaygroup.com.sa DOCK_TOKEN=<token> node agent.js --once            # copy only
DOCK_SERVER=... DOCK_TOKEN=... node agent.js --delete --interval 30                              # keep running, free camera space
```
Needs Node 22+ and `adb` (set `ADB=/path/to/adb` if it is not in PATH). Files modified in the last minute are never touched.
Only cameras are handled: a USB device counts when its model is a known camera model (`DOCK_MODELS`, default `SDJW`) or it has the camera app installed. A phone or tablet plugged into the same computer (for example for app testing) is ignored.
Recordings appear in the dashboard API at `/api/recordings` (company users only see their own cameras).

## The moment a camera is docked

1. **Within a couple of seconds** the agent sees the camera and the camera's own screen says *Docking station: connected*.
2. **The camera app is brought up to date first**: if the build on the camera differs from the one published on the server, the latest one is installed
   over USB (not while the camera is recording; the camera must be powered by the dock or have `DOCK_UPDATE_MIN_BATTERY`, default 20 %).
   An update takes seconds; copying recordings can take minutes, so it comes first.
3. **Recordings are copied** and, as the dashboard policy says, pushed to the cloud.
4. The camera says *All done* for a few seconds. Nothing is shown for work that does not happen: a camera that is already up to date and has nothing
   new just says so once.

## On the camera's screen

While the agent works on a camera it writes `dock-status.json` into the camera app's folder (`/sdcard/Android/data/com.swg.swg_bwc/files/`)
every few seconds, and the camera app shows it as a window: *connected*, *updating (do not unplug)*, *uploading, file 2 of 5*, *all done*,
*needs attention*. The words come from the agent ([`dock-agent/screen.js`](../dock-agent/screen.js)), the camera only chooses icon and colour. A file older than 15 seconds is
ignored, so the window disappears by itself when the agent stops or the camera is unplugged; while the camera is recording the window shrinks to a
thin bar. `--no-screen` turns it off. Cameras that run an older app build ignore the file (their update to a build that has the window is silent).

## Running it all the time on a Mac
`dock-agent/install-macos.sh` installs the agent as a launchd service that starts at login, restarts if it stops and detects docked cameras by itself:
```bash
DOCK_LOCATION=<lat>,<lng> dock-agent/install-macos.sh https://visionguard.smartwaygroup.com.sa <DOCK_TOKEN> [dock-id]
dock-agent/install-macos.sh --uninstall
```
The service is `com.visionguard.dock-agent` (plist in `~/Library/LaunchAgents/`, log in `~/Library/Logs/visionguard-dock.log`). After updating the agent code restart it with `launchctl kickstart -k gui/$(id -u)/com.visionguard.dock-agent`. After **editing the plist** (for example a new `DOCK_SERVER`), reload it fully: `launchctl bootout gui/$(id -u) <plist>` then `launchctl bootstrap gui/$(id -u) <plist>` (`kickstart` alone does not re-read it).

## Storage folders and "Choose folder"
Each company has its own policy and folder for kept files (Docking > Settings, GUIDE section 8.3k). The agent keeps each camera's files in `<root>/<camera>/`, where the root is the folder chosen for the camera's company (default `~/VisionGuard-Dock`, or `DOCK_STORAGE`). **Choose folder** in the dashboard lets an administrator browse the dock computer through the agent (it polls every 1.5 s; it can browse the home folder, the storage root, `/Volumes` and any folder in `DOCK_BROWSE_ROOTS`) and move the storage there; the agent keeps a `.roots.json` so earlier files stay found. The folder path is hidden from customers. The agent must be a version that has this feature (restart it after updating).

## Options

| | |
|---|---|
| `--once` | one cycle, then exit |
| `--interval N` | seconds between cycles (default 30; a newly docked camera does not wait for it) |
| `--delete` | remove a recording from the camera once it is safe where the user wanted it |
| `--report-only` | show the docks on the dashboard, touch nothing |
| `--no-update` / `--update-only` | never update the camera app / only update it, copy nothing |
| `--no-screen` | do not show the window on the camera |
| `--latest N`, `--since today`, `--only`, `--limit`, `--smallest`, `--dry-run` | narrow what is copied (tests, first rollout) |

## Tests

```bash
node --test dock-agent/test/*.test.js
```
