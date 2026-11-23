# VisionGuard app (iPhone, iPad, Android and Mac)

Last updated: 2026-11-23

For **owners and supervisors**: open the app, see every camera of the company, watch any camera live and get SOS alerts on a locked phone, without asking the control-room supervisor. Same accounts, same companies and same permissions as the web dashboard.

Code: `client/` (Flutter, one codebase for iPhone, iPad, Android phone, Android tablet and Mac). Server API: `server/server.js` (`/api/mobile/*`), `server/push.js`.

## 1. How it is connected

```
 iPhone / iPad / Android  ──HTTPS──►  VisionGuard server  ◄── RTMP ──  body cameras
   │  login, recordings, stream signature     │
   │  socket.io: fleet, SOS, commands         │  node-media-server (FLV)
   └─ live video: GET /live/<camera>.flv?sign=…  (same port as the dashboard)
```

* **Same users.** The owner signs in with the account that the admin created in *Companies*. A company user only ever sees that company's cameras, alarms and recordings (the server enforces it, the app cannot bypass it).
* **Token login.** `POST /api/mobile/login` returns a 30-day bearer token. The app keeps it in the iOS Keychain / Android Keystore. `Authorization: Bearer …` works on every API the web uses, and the socket accepts `auth: { session }`. Logout deletes the token on the server.
* **Real time.** One socket.io connection gives the fleet snapshot, camera changes, SOS and acknowledgements (`dashboard_snapshot`, `dashboard_cam`, `dashboard_sos`, `dashboard_alarm_ack`, `stream_up`, `remote_stream_result`).
* **Live without asking the officer.** The app emits `remote_stream {cameraId, action}`, exactly like the dashboard; the camera starts streaming by itself. Every start/stop is written to the audit log with the username. The package live-limit (`max_live`) applies. On the **Live** tab only the cameras the user picked (*Watch live* on a card or the map) start by themselves; every other online camera shows a *Start live view* button, so opening the tab never starts the whole fleet.
* **Push.** The app registers its FCM token (`POST /api/mobile/push`). On SOS the server notifies the camera's company users and Smart Way staff (`server/push.js`, FCM HTTP v1, high priority; time-sensitive on iOS). It stays off until `FCM_SERVICE_ACCOUNT` is set; the open app still gets SOS through the socket.

* **Battery and alerts.** Every camera shows its battery (live from the camera, or read on the dock) with a bolt while charging. Under 20 % and not charging the server raises a *low battery* alert (`dashboard_alert` / `dashboard_alert_resolved` over the socket, `alerts` in the snapshot, `ack_alert` to dismiss): the Alerts tab lists it above the SOS alarms, a notice appears wherever the user is, and a push notice goes out when FCM is configured.
* **Who carries the camera.** The holder shows with the employee number (and *reserved / carrying*); an SOS shows who carried the camera when it was pressed.
* **Licence notice.** `GET /api/license/status` (and `license` in `/api/mobile/config`): the app shows an amber / red line above the tab bar when the licence is ending or ended (see LICENSING.md).

## 2. Decisions

| Topic | Choice | Why |
|---|---|---|
| Framework | Flutter | The team already ships Flutter (camera app); one code base for 4 form factors. |
| Live player | `media_kit` (libmpv) | Plays HTTP-FLV natively on iOS and Android. AVPlayer cannot play FLV and iPhone Safari lacks the browser APIs the web player needs. |
| Map | `maplibre_gl` + OpenFreeMap style on phones and tablets; `flutter_map` on the Mac | Same style and data as the web dashboard. `maplibre_gl` has no desktop build. |
| State / routing | Riverpod + go_router | Testable, no global state. |
| Bundle id | `sa.com.smartwaygroup.visionguard` | Reverse of the company domain. Confirm before the first store upload; it cannot change later. |
| Distribution | Today: **TestFlight** (internal testers, and an external group with a public link after Beta App Review) and **Google Play internal testing**. Public store, Custom App or unlisted: decided by management before release | The app is for paying customers; nothing goes to the public store without that decision. |
| Languages | English + Arabic (RTL) | All text goes through `context.tr(key)`. |

## 3. Features by phase

**v1 (built)**
Sign in (+ Face ID / fingerprint lock) · Fleet list with live status, search and filters · Camera detail (status, GPS fix ± accuracy, quality picker) · **Live viewer** (one tap, full screen, 2×2 wall on tablets) · Map with live positions · Alerts (SOS banner, vibration, acknowledge) · Recordings (evidence from the docking station, play/download) · Settings (theme, language, security, account) · Light/dark, English/Arabic.

**v1.1 (built, version 1.1.0)** Mac app · Chat tab with voice notes, an unread badge and a banner when an officer writes · Geofence zones on the map, drawn and edited in the app · Live captions · Analytics · Stop menu · Profile and access · Play and download.

**Still open** Push notifications (needs Firebase) · Share a live link with an expiry · Daily report PDF in the app · Server-side transcoding to a phone-friendly bitrate (cellular data saver) · Offline cache of the last fleet state.

## 4. Experience and styling

* **Phone:** bottom bar *Cameras · Live · Docking · Alerts · Chat · More* (the map is a switch in the Cameras screen). **Tablet (≥ 720 px):** navigation rail; the Cameras screen becomes list + detail, the Live screen a 2×2 wall. **Landscape** live view hides everything but the video and a glass control bar.
* **Look:** the dashboard tokens (`client/lib/core/theme/vg_theme.dart` mirrors `server/public/portal.css`): purple brand, amber call-to-action gradient, status colours (green online, red recording/SOS, grey offline), brand strip under the header, glass overlays on video, 16 px radius cards, tabular numbers. Light and dark.
* **SOS** is the loudest thing in the app: red banner from the top, heavy haptic, alert sound, badge on the tab; one tap opens the camera live.
* **Arabic:** full RTL (Flutter mirrors layouts), Arabic strings reviewed by the team before store release. Map and video are never mirrored.
* **Accessibility:** 44 px touch targets, status is never colour-only (icon + text), dynamic text size respected.

## 5. Security

* Tokens only in Keychain/Keystore; screen shows the lock if the app is idle > 30 s and biometrics are on.
* **HTTPS is mandatory for store builds.** Test builds use plain HTTP only against a local test server; the default server is the HTTPS domain. Before any store build: domain + TLS live, then run `client/tool/release_guard.sh` (fails if cleartext traffic is still allowed).
* Server side: login rate-limit (same as web), per-user company scoping on every endpoint and socket room, signed short-lived stream URLs, audit log for login and live start/stop, token revoked on logout.
* Privacy: remote live view of a body camera is a sensitive capability. It is limited to authorised company users, logged with who/when, and the customer contract must cover it (the stores ask for a privacy policy URL and the data-use declarations).
* Later: certificate pinning, device list with remote revoke, per-user permission matrix (owner / supervisor / viewer).

## 6. Live video notes

* A camera has **one** uplink stream, shared by every viewer (PC, phone). Changing quality changes it for everyone, so the quality picker says so.
* 1080p ≈ 6 Mbps ≈ 2.7 GB/hour on cellular. The app shows a cellular warning; real data-saving needs server transcoding (v2).
* Leaving the viewer does **not** stop the camera (other people may be watching). A visible *Stop stream* button ends it; a server-side "stop after N idle minutes" is planned.

## 7. Testing on the two tablets

* **Android tablet:** enable developer mode, connect by USB, `cd client && flutter run -d <id>` (the default server is `https://visionguard.smartwaygroup.com.sa`; override with `--dart-define=VG_SERVER=...`).
* **iPad:** needs Xcode signing (team `PJX4KFYXFK`), or install the TestFlight build. Open `client/ios/Runner.xcworkspace`, pick the team, run on the iPad.
* Test matrix: login/logout, wrong password, airplane mode and reconnect, Arabic + dark mode, SOS while the app is open / in background / locked (push), live on Wi-Fi and on cellular, rotate, split-screen on the tablets, 2 cameras at once, company user vs staff user (visibility).

## 8. Stores

Smart Way's Apple and Google accounts are in use; version 1.1.0 (3) is uploaded to both for testing. Still open: Firebase for push, and the release decision. Full steps and status: `STORE_PUBLISHING.md`; listing text: `STORE_LISTING.md`.

## 9. Status (2026-11-23)

**Version 1.1.0 (build 3): the app has every function of the web dashboard, on Android, iOS and the Mac.**

New in 1.1.0:
* **Mac app** (`client/macos`, bundle id `sa.com.smartwaygroup.visionguard`): the same screens and the same server. The map is drawn with `flutter_map` because `maplibre_gl` has no desktop build (cameras, names, geofence zones and the zone editor work the same; the picture comes from OpenStreetMap by default, set `--dart-define=VG_MAP_TILES=https://.../{z}/{x}/{y}.png` for a tile server of your own). Run: `cd client && flutter run -d macos` (or `flutter build macos --release`). The token is kept in the file-based keychain; a debug build that was rebuilt asks once for access to it, a build signed with the team certificate does not.
* **Stop menu** like the web (`showStopMenu`): close the window only, stop a live view started from the control room, or end a recording the officer started (needs *Stop a recording* and a camera that reports `remote-stop`; refused while an SOS is open; the answer of the server is shown).
* **Live captions** (*Live captions* permission): subtitles over every live picture (a draft while someone talks, the final text at the pause, fading after 6 s) and a *Live captions* box on the camera panel with the last sentences (`GET /api/transcripts/:id`).
* **Chat and voice notes** (*Voice & chat*): More > *Chat with officers*, or *Message* on a camera: everybody or one camera, text and voice notes (recorded as AAC, played in the app), a notice when an officer writes.
* **Analytics** (*Analytics*, *AI insights*): fleet and SOS numbers, what needs attention, SOS per day and per hour, the recordings pipeline, camera health, audit seal and the written summary.

Since then (same version 1.1.0):
* **Chat tab** (between Alerts and More) with an unread badge; a banner over any screen when an officer writes, and a tap opens that conversation.
* **Live tab** no longer starts cameras by itself (section 1).
* **In testing:** iOS build 1.1.0 (3) in TestFlight, Android bundle 1.1.0 (3) in Google Play internal testing.
* **Two-step sign-in** (after build 3, not in the stores yet): the code step after the password (`POST /api/mobile/login` answers `{mfa, challenge}`, then `POST /api/mobile/login/mfa`), and More > Profile and access > Two-step sign-in to turn it on or off. Tested on the iPhone simulator against a local server.

Also in the app (earlier): Profile and access, role-aware screens, play and download, English and Arabic with full RTL, the map inside Cameras, geofence zones drawn and edited in the app.

**Tests:** `cd client && flutter test` (all pass), plus the server tests.

**Verified on devices:** the Android app on the Huawei tablet and on a phone installed from Google Play, the iPad, and the iPhone build from TestFlight.

**Not verified yet (needs hardware or accounts):** push notifications (needs Firebase), Face ID on a device, subtitles and live FLV from a real camera for long sessions, voice notes from the app played by a real camera.

**Not done:** public release on the App Store and Google Play (waiting for the company's approval), and the Mac App Store (see `STORE_PUBLISHING.md`).

Next: the items still open in section 3 (push, share a live link, daily report PDF), then the public release once it is approved.
