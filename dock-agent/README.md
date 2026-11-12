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
