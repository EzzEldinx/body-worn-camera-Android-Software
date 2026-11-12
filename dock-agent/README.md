# VisionGuard Dock Agent

Runs on the PC next to the docking station. Pulls recordings from every camera over USB, verifies them
(SHA-256 on the camera, on the PC and again on the server), uploads them, and optionally deletes them from the camera.

```bash
# server side: set DOCK_TOKEN in server/.env
DOCK_SERVER=https://visionguard.example.com DOCK_TOKEN=<token> node agent.js --once            # copy only
DOCK_SERVER=... DOCK_TOKEN=... node agent.js --delete --interval 30                              # keep running, free camera space
```
Needs Node 22+ and `adb` (set `ADB=/path/to/adb` if it is not in PATH). Files modified in the last minute are never touched.
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
*needs attention*. The words come from the agent ([`screen.js`](screen.js)), the camera only chooses icon and colour. A file older than 15 seconds is
ignored, so the window disappears by itself when the agent stops or the camera is unplugged; while the camera is recording the window shrinks to a
thin bar. `--no-screen` turns it off. Cameras that run an older app build ignore the file (their update to a build that has the window is silent).

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
