# VisionGuard — Smart Way Group Body-Worn Camera Platform

Fleet management for body-worn cameras (BWC): live video, GPS tracking, SOS alarms,
push-to-talk chat, multi-company tenancy, analytics and over-the-air updates.

```
 BWC camera (Flutter app)  --socket.io / RTMP-->  Server (Node.js)  <--HTTPS--  Dashboard (browser)
```

| Path | Description |
|---|---|
| `server/` | Node.js 22+ server and web dashboard (Express, socket.io, node-media-server, SQLite) |
| `app/` | Flutter camera app (`com.swg.swg_bwc`) |
| `tools/` | PowerShell fleet tools (USB/dock update, OTA publish) |
| `docs/` | Operations guide (`GUIDE.md`) and legacy notes |

## Quick start (server)

```bash
cd server
npm ci
cp ../.env.example .env   # then edit values
BWC_TOKEN=change-me node server.js
```

Dashboard: <http://localhost:3000> locally, <https://visionguard.smartwaygroup.com.sa> in production (see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)). On first run an `admin` user is created and its
password is printed once (or taken from `ADMIN_PASSWORD`).

Try it without hardware: `BWC_TOKEN=change-me node tools/simulate.js 4`.

Run tests: `npm test` (inside `server/`).

## Camera app

```bash
cd app
flutter pub get
flutter run --dart-define=BWC_SERVER=http://<server-ip>:3000 \
            --dart-define=BWC_ID=BWC-01 --dart-define=BWC_TOKEN=<token>
```

## Documentation
- Operations guide: [docs/GUIDE.md](docs/GUIDE.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) · Security: [SECURITY.md](SECURITY.md)

© Smart Way Group. All rights reserved.
