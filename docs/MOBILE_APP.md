# VisionGuard mobile app (iOS + Android)

For **owners and supervisors**: open the app, see every camera of the company, watch any camera live and get SOS alerts on a locked phone, without asking the control-room supervisor. Same accounts, same companies and same permissions as the web dashboard.

Code: `client/` (Flutter, one codebase for iPhone, iPad, Android phone and Android tablet). Server API: `server/server.js` (`/api/mobile/*`), `server/push.js`.

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
* **Live without asking the officer.** The app emits `remote_stream {cameraId, action}`, exactly like the dashboard; the camera starts streaming by itself. Every start/stop is written to the audit log with the username. The package live-limit (`max_live`) applies.
* **Push.** The app registers its FCM token (`POST /api/mobile/push`). On SOS the server notifies the camera's company users and Smart Way staff (`server/push.js`, FCM HTTP v1, high priority; time-sensitive on iOS). It stays off until `FCM_SERVICE_ACCOUNT` is set; the open app still gets SOS through the socket.

* **Battery and alerts.** Every camera shows its battery (live from the camera, or read on the dock) with a bolt while charging. Under 20 % and not charging the server raises a *low battery* alert (`dashboard_alert` / `dashboard_alert_resolved` over the socket, `alerts` in the snapshot, `ack_alert` to dismiss): the Alerts tab lists it above the SOS alarms, a notice appears wherever the user is, and a push notice goes out when FCM is configured.
* **Who carries the camera.** The holder shows with the employee number (and *reserved / carrying*); an SOS shows who carried the camera when it was pressed.
* **Licence notice.** `GET /api/license/status` (and `license` in `/api/mobile/config`): the app shows an amber / red line above the tab bar when the licence is ending or ended (see LICENSING.md).

## 2. Decisions

| Topic | Choice | Why |
|---|---|---|
| Framework | Flutter | The team already ships Flutter (camera app); one code base for 4 form factors. |
| Live player | `media_kit` (libmpv) | Plays HTTP-FLV natively on iOS and Android. AVPlayer cannot play FLV and iPhone Safari lacks the browser APIs the web player needs. |
| Map | `maplibre_gl` + OpenFreeMap style | Same style and data as the web dashboard. |
| State / routing | Riverpod + go_router | Testable, no global state. |
| Bundle id | `sa.com.smartwaygroup.visionguard` | Reverse of the company domain. Confirm before the first store upload; it cannot change later. |
| Distribution | App Store **Custom App (Apple Business Manager)** / **Unlisted**, Google Play **closed → production** | The app is for paying customers only; this avoids public-store review friction and keeps it off public search. |
| Languages | English + Arabic (RTL) | All text goes through `context.tr(key)`. |

## 3. Features by phase

**v1 (built)**
Sign in (+ Face ID / fingerprint lock) · Fleet list with live status, search and filters · Camera detail (status, GPS fix ± accuracy, quality picker) · **Live viewer** (one tap, full screen, 2×2 wall on tablets) · Map with live positions · Alerts (SOS banner, vibration, acknowledge) · Recordings (evidence from the docking station, play/download) · Settings (theme, language, security, account) · Light/dark, English/Arabic.

**v1.1** Push notifications (needs Firebase) · Chat and push-to-talk with officers · Share a live link with an expiry · Daily report PDF.

**v2** Server-side transcoding to a phone-friendly bitrate (cellular data saver) · Geofences and schedules · Offline cache of the last fleet state.

## 4. Experience and styling

* **Phone:** bottom bar *Cameras · Live · Docking · Alerts · More* (the map is a switch in the Cameras screen). **Tablet (≥ 720 px):** navigation rail; the Cameras screen becomes list + detail, the Live screen a 2×2 wall. **Landscape** live view hides everything but the video and a glass control bar.
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
* **iPad:** needs Xcode signing (a free Apple ID works for 7-day builds; TestFlight needs the paid Apple Developer account). Open `client/ios/Runner.xcworkspace`, pick the team, run on the iPad.
* Test matrix: login/logout, wrong password, airplane mode and reconnect, Arabic + dark mode, SOS while the app is open / in background / locked (push), live on Wi-Fi and on cellular, rotate, split-screen on the tablets, 2 cameras at once, company user vs staff user (visibility).

## 8. Store checklist (later)

Apple Developer Program (US$99/yr, organisation account needs a D-U-N-S number) · Google Play Console (US$25 once, organisation verification) · Firebase project (FCM + APNs key) · domain with TLS · privacy policy URL · app icon 1024 px, screenshots (iPhone 6.9", iPad 13", Android phone/tablet), description EN/AR · demo account for Apple review · remove `NSAllowsArbitraryLoads` and `usesCleartextTraffic` (`client/tool/release_guard.sh` checks this). Full steps: `STORE_PUBLISHING.md`; listing text: `STORE_LISTING.md`.

## 9. Status (2026-11-18)

**Running:** the app runs on a registered iPad (development build; the iOS development profile includes only that iPad and expires 2027-11-08) and was verified on iPad Pro 11" and iPhone simulators. An iPhone needs its device added to the profile and Developer Mode switched on, then a rebuild while it is connected.

**Done since v1:**
* **Profile and access** (More): the role, the company and exactly what the account may do (`GET /api/me/access`), and the role shown on the More screen.
* **Role-aware screens:** Docking > Files and Recordings follow the real permissions (files, delete); buttons that the account may not use are not offered.
* **Play and download:** recordings and dock files can be played in the app and downloaded (share sheet: Save to Photos or Files, AirDrop) with `share_plus` and `path_provider`.
* **English and Arabic** with full right-to-left layout; the server answers in the app's language (`x-lang`).
* **The map is inside Cameras** (there is no Map tab any more): on a tablet it fills the right-hand pane until a camera is selected (a camera's *Show on map* returns to it); on a phone the map/list button in the top bar switches between the list and the map. From an alarm, *Show on map* also opens it on that camera.
* **Geofence zones on the map** (read only): the zones drawn on the web show on the app's map (green allowed, red forbidden, blue both ways, amber checkpoint; red and thicker while a camera is breaking the rule) and follow changes by themselves. Drawing and editing zones is done on the web for now.
* Stop recording and live wall controls follow the same permissions as the web (the `stoprec` action).

**Tests:** 29 app tests pass (`cd client && flutter test`), plus the server tests.

**Not verified yet (needs hardware or accounts):** push notifications (needs Firebase), Face ID on a device, the Android build on a real tablet, live FLV from a real camera inside the app for long sessions.

**Not done:** publishing to the App Store / Google Play (see `STORE_PUBLISHING.md`; the app is not in any store).

Next: the v1.1 items in section 3, then the store accounts.
