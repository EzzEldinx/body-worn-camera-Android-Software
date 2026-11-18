# VisionGuard (Smart Way Group BWC): Complete Operations Guide

> Audience: the people who run, support and extend VisionGuard. Commands are given so they can be copied and pasted.
> Last updated: 2026-11-18. Unless stated otherwise, PowerShell commands are run from the project root folder (`C:\Projects\swg-bwc-system`); the Mac and Linux equivalents are `tools/*.sh`.

---

## 1. Overview

```
 [BWC camera x N]  ---- Wi-Fi/4G ---->  [Server]  <---- browser ----  [Dashboard (Smart Way staff + customer companies)]
   app: swg_bwc          socket.io (commands, GPS, chat)         HTTPS (via nginx) -> app on port 3000 inside the server
                         RTMP video  --->  port 1935 --> HTTP-FLV (the dashboard plays it)
```

| Part | Location | How it runs |
|---|---|---|
| **Server + Dashboard** | `server/` (Node.js) | `node server.js`: port **3000** (web), **1935** (RTMP video from the cameras), **8000** (video for the browser). In production it runs in Docker behind nginx and TLS (section 2.1). |
| **Camera app** | `app/` (Flutter, package `com.swg.swg_bwc`) | Installed on each camera (USB, dock or online update). |
| **Owner app** | `client/` (Flutter, iPhone / iPad / Android) | The customer's mobile app. See `MOBILE_APP.md`. |
| **Dock Agent** | `dock-agent/` | Runs on the PC next to the docking station (section 8.4). |
| **Tools** | `tools/` | `update-cameras.ps1`, `publish-build.ps1` / `.sh`, `provision-camera.sh`, `provision-batch.sh`, `health-watch.sh`, `loadtest.js`. |
| **Database** | `server/data/bwc.db` | SQLite, created automatically. |
| **OTA build** | `server/data/updates/app.apk` | The APK that the cameras download. |

Repositories: the private organisation repository (git remote `org`) and the public repository (git remote `origin`). After every commit, push the branch to both.

---

## 2. Running the server

```powershell
cd C:\Projects\swg-bwc-system\server
$env:BWC_TOKEN = "yoursecret"      # the shared camera token (older cameras); see section 14 for per-camera tokens
node server.js
```
- The dashboard is at `http://<server-IP>:3000` when run locally (for example `http://192.168.100.75:3000`).
- **First run only:** the server creates the user `admin` and prints its password in the terminal (or uses `ADMIN_PASSWORD`).
- Change the admin password: `node tools/create-user.js admin <new-password> "Administrator" admin`
- Add a Smart Way staff user: `node tools/create-user.js <user> <password, 8+ characters> "Name" admin` (`admin` = every permission) or `viewer` (view only).
- If the PC restarts, a locally run server does **not** start by itself: start it again (the cameras reconnect on their own).
- Test new work on a test server first, so the real database is never touched: `PORT=3100 DATA_DIR=<empty folder> RTMP_PORT=1936 FLV_PORT=8100 node server.js`

### 2.1 Production server and deployment
- Production runs in Docker (project `visionguard`, folder `/opt/visionguard`, compose files in `deploy/`) behind nginx with TLS, at `https://visionguard.smartwaygroup.com.sa`. Port 3000 is **not** published to the internet (closed 2026-11-18): cameras, Dock Agents, mobile apps and browsers all use the HTTPS domain. RTMP (1935) is open.
- Deploy a new version: pack the repository (`git archive --format=tar.gz -o /tmp/visionguard.tar.gz HEAD`), copy it to the server, unpack it into `/opt/visionguard`, then in `/opt/visionguard/deploy` run `sudo docker compose -p visionguard -f docker-compose.yml -f docker-compose.test.yml up -d --build`.
- Health: `GET /healthz` returns `{"ok":true,...}` (database, free disk, cameras online). The Docker image has a healthcheck; `tools/health-watch.sh --install <url>` installs an outside watcher that alerts when the site stops answering.
- Load test: `tools/loadtest.js` simulates thousands of cameras. Run it only against a throwaway server of your own.
- Backups: see section 11.

---

## 3. Roles and permissions

| User type | Sees | Can do |
|---|---|---|
| **Super admin** (`role=admin`, no company) | **Everything** | Everything: companies, regions, edit/delete cameras, updates, quality, remote start, Admin panel. |
| **Staff viewer** (no company) | All cameras | View and watch live only. |
| **Company user** (created on the Companies page) | **Only their own company's cameras** | Depends on the company's features and the user's own permissions (below). |

**Features and actions.** Smart Way decides, per company, which **features** (Live, Analytics, Docking, Geofencing, ...) and which **actions** (acknowledge alarms, live stream, video quality, **stop recording**, zones, files, delete) the company may use (Admin panel > Companies). This is the company's **ceiling**: a company administrator can give a user only what is inside the ceiling, never more, and cannot do more than the ceiling themselves. A company with no action ticked gets only the everyday actions. Smart Way may need to re-tick actions for existing companies after this rule was introduced.

**Every person can see their own access:** the **Profile and access** button (top bar; mobile app: More > Profile and access) shows the role, the company and exactly which features and actions the account has.

A company can never see another company's camera, alarm, chat or video. The server enforces this on every request (not only the browser). Video itself needs a signed, time-limited link; it is never public.

---

## 4. Companies, regions and cameras (the **Companies** page)

Where: dashboard > the building icon at the top, or `/admin.html` (super admin only).

1. **New company:** type the name > Add company.
2. **A user for the company:** inside the company card enter a username and password (8+ characters; the **Generate** button helps) > Add user. The password is shown **once**: Copy it and give it to the customer. (Reset password and Remove user are available.)
3. **Regions** (Riyadh, Jeddah, Dammam ...): the **Regions** card > type a name > Add. (Removing a region leaves its cameras as "No region".)
4. **Camera to company and region:** the **Camera assignment** table: choose the company and region from the drop-downs; they save immediately.
5. **Delete a camera:** the ✕ next to the camera, or **Remove all offline cameras** (asks for confirmation and lists the names).

### What happens when you delete a camera
- The camera disappears from the dashboard.
- It does **not** stay away (even if its GPS or heartbeat is still running). It returns when the camera **starts recording**, sends an **SOS** or uses **PTT**: it then appears again as a new camera (nothing has to be done in the dashboard).

---

## 5. The daily dashboard (`/`)

### The right-hand list (cameras)
- **Region tabs** at the top (All / Riyadh / Jeddah / Dammam / No region), each with "online/total".
- Inside a tab: **companies** (collapsible), each with its cameras. (A user with a single company does not see the headers.)
- Search and filter (All / Online / Recording).
- **▶** = **Watch live**: if the camera is online and not recording, **it starts streaming by itself** (the officer does not notice). If it was already recording, the video simply opens.
- Click a camera for a panel under the map: name, company/region, **Watch live**, **Follow**, **Edit**, **Video quality**, **Stop remote stream** (or **Stop recording...** for an officer's recording).

### The Live wall
- 1 / 2x2 / 3x3 tiles. Each tile: name, **REC/WAITING**, **Listen** (sound), **Fill/Fit**, **Expand** (theatre), ✕.
- **Fit** (default) shows the whole picture; **Fill** enlarges and crops. The camera sends a **portrait (9:16)** picture, so in Expand the screen shape follows the picture.
- If a camera is online but not recording, its tile shows "Waiting..." and a **Start live view** button.

### Remote control (from the dashboard, to one camera)
| I want to | Do this |
|---|---|
| Start live | ▶ or **Start live view** |
| Stop the stream or the recording | The **■ Stop** button on the camera picture (or **Stop recording...** in the panel under the map). It asks what exactly you want to stop: **Stop streaming** for a live view you started, or **Stop recording and streaming** for a recording the **officer** started. The second needs the **Stop a recording** permission (company managers and Smart Way staff have it; others can be given it), a camera on the new app (it reports `remote-stop`), and no SOS from that camera that is still unanswered (2 hours, `STOPREC_SOS_GUARD_MS`). The officer sees "Recording stopped by the control room" on the camera and the file is kept. It is written to the audit trail (`remote_record_stop`). |
| Close the window only | The **✕** button on the picture (or **Close window only** in the menu): the camera carries on exactly as before and nothing changes on it. |
| Change the quality | Panel > **Video quality**: auto / 480p / 720p / 1080p (the list stays open while you choose) |
| Talk to the officer | PTT / chat / voice note from the chat panel |

- Changing the quality during a live stream restarts it, about **3.5 seconds** (a small gap).
- A camera on 1080p sends about **4.8 Mbps** (estimate for one camera); if the network is weak, use 720p or 480p.
- Every remote command (start / stop / quality / update) is written to the `audit` table (who, when, which camera).

### Alarms (SOS)
- The officer presses **SOS for 2 seconds**: an alarm appears on the dashboard with a sound, and the camera is raised on the wall (if it is recording; if not, press ▶ on it).
- An administrator clicks the alarm to acknowledge it. The time between the SOS and the acknowledgement is recorded and shown in Analytics as "Avg response".

### Chat and voice notes
- Tabs: **Public** (the whole company) and **Private** (one camera). The microphone button records and sends a voice note.
- A company sees only its own chat; a **Staff broadcast** (Public, from Smart Way staff) reaches everyone.

### Theme and language
- Light and dark mode are remembered. The language switch (**عربي | EN**) is in the header of **every** page (Dashboard, Analytics, Reports, Docking, Support, Updates, Employees, Admin, License, Live wall, Login, Station, Privacy). See the next section.

### English / Arabic on the whole website
- **Choice:** the chosen language is remembered in the browser (`localStorage` key `bwc-lang` plus the cookie `vglang`) and applies to every page, including the login page and the Live wall window (if you change the language on one page, the other open windows follow). The first time, the site opens in Arabic if the browser is Arabic, otherwise in English.
- **Arabic is right to left:** the whole page is mirrored (menu, tables, forms, charts, the flow diagram). Digits are Western (0-9), dates are Gregorian and the clock is 24 h in both languages. Camera IDs and units (MB, GB) stay Latin.
- **Where the words live:** `server/public/i18n.js` (the engine and shared words), `server/public/i18n/<page>.js` (each page, English and Arabic with the same keys), `server/lang/errors.js` (API replies), `server/lang/texts.js` (insights, the written analysis, push notices, e-mails). **A new text is a new key in both languages**: the test `server/test/i18n.test.js` fails if a key exists in one language and not the other, or if the server has a new error without a translation.
- **The server answers in the user's language:** the browser sends the cookie `vglang`; the mobile app sends the header `x-lang`. API errors, the written analysis, push notifications (each device in its own language) and support e-mails (in the language of the person who wrote the ticket, or `SUPPORT_EMAIL_LANG=en|ar` in `.env` so the support desk always receives one language) follow it.
- **Deliberately not translated:** CSV exports (headers and codes stay English for Excel and the audit hashes), the browser's own date pickers, and anything people typed (company names, notices...).

---

## 6. The Analytics page (`/analytics.html`)
Opens after login. Gauges (online / recording / open alarms / average response), donuts (fleet status, alarms, cameras by company or group), SOS for 7 days, a flow chart (Camera > Server > Control room). It refreshes every 10 seconds. The **Open Live Dashboard** button goes back to the map. A company sees only its own numbers.

### 6.b The PDF report (one day, or any range up to 92 days)
Analytics > the **Reports** card: pick **From** and **To** (or a shortcut: Today, Yesterday, Last 7 days, Last 30 days, This month, Last month) > **Download PDF**. Smart Way administrators can pick a **company** or "All companies"; a company only gets its own.
The report has: a banner, 4 KPIs (active cameras, SOS, recorded time, distance), the fleet donut, **activity by hour** (one day) or **recorded time by day with the SOS count** (several days), the SOS table with response times, a **Day by day** table (several days), **Camera custody** (who took which camera, when, how long, from the check-out station), camera activity, control-room actions and a timeline. Days are cut in **your own time zone** (the browser sends it).
* Endpoint: `/api/report?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=<minutes>&company=<id>` (the old `?date=` still means one day). Every download is written to the audit trail.
* Events (online/offline, recording, PTT, messages) are logged **from the moment of that update**; earlier days have SOS, GPS and control-room actions only.
* **Arabic PDF:** with the website in Arabic the report is downloaded in Arabic (the language comes from the same switch; `?lang=ar` forces it): right to left, mirrored layout, Arabic month and day names, Arabic names kept. In the English report Arabic names are still dropped (Latin font). Arabic font: DejaVu Sans in `server/fonts/` (licence file beside it; `server/report.js` does the mirroring and the Arabic/number ordering, words in `server/lang/report-text.js`). A nicer Arabic font (Noto Naskh, Cairo) can replace the two files if wanted.

---

## 7. The camera app (SWG-BWC-04)

**Screen:** full-screen picture with a HUD: logo, `LINK` (the connection to the server), `GPS`, camera name, REAR/FRONT, quality (1080P), clock, **REC timer**.
**Side buttons:** chat, crop (wide/full), torch, **night vision** (moon), switch camera.
**Bottom:** zoom, photo, **REC** (white, red inner circle; a square while recording), **SOS** (2 seconds), **PTT** (hold).

- **Night vision** (the moon button) does three things together: the **IR-cut** motor, the **IR LEDs** and a **black-and-white** picture. Under artificial light the picture gets a little darker (the lens sees infrared).
- **Switch camera:** the device allows only **one open camera at a time**. The old app froze after the first switch (the old camera was still open). Fixed and tested: 4 switches in a row work.
- **Camera ID, server and token** are not inside the app. Each camera has a `config.json` (`/sdcard/Android/data/com.swg.swg_bwc/files/config.json`) written by the provisioning scripts. One APK serves every camera.
- **GPS:** the chip shows a yellow "GPS..." when there is no fix (usually indoors) and a green "GPS" when there is one.
- **Recording:** every video is recorded on the camera itself (folder `SWG_BWC`) and streamed live to the server. The quality is the same for both.
- **Address:** a camera still set to `http://<ip>:3000` switches itself to the HTTPS domain at start-up when the domain answers (section 8.3k).

---

## 8. Updating the cameras (the important part)

> An old camera (from before the OTA update) does not accept online updates: **the first time it needs USB** (or the docking station). After that it updates online.

### 8.1 A new camera / the first time, by USB (or the dock)
1. Connect the camera or the dock to the laptop. Check:
   ```powershell
   .\tools\update-cameras.ps1 -List
   ```
   (If the serial shows, it works. The dock **shows the cameras on USB**: try it with 4 cameras at once.)
2. One new camera (new ID):
   ```powershell
   .\tools\update-cameras.ps1 -Provision -Serial <SERIAL> -Id BWC-08-RIY
   ```
   - `-Id` is saved in `cameras.json` for next time.
   - `-Provision` = the one-time setup (below).
3. **The docking station / several cameras at once** (updates everything connected, up to 10 in parallel):
   ```powershell
   .\tools\update-cameras.ps1 -SkipBuild -Provision
   ```
   Cameras not in `cameras.json` are skipped and their names listed (so you can add the ID).
4. Update one camera only: `... -Serial <SERIAL>` (the serial from `-List`).
5. Flags: `-SkipBuild` (reuse the latest APK), `-Parallel 5` (cameras at once), `-Unprovision` (undo).

On a Mac use `tools/provision-camera.sh` and `tools/provision-batch.sh` (sections 9.1 and 9.2).

### 8.2 Provisioning (`-Provision`): what exactly does it do?
1. Removes the empty **Guest user** (Android refuses device owner when another user exists).
2. Makes the app **Device Owner**: installs become **silent** (no "Install" on the screen).
3. Makes the app the **Home app**: Android starts it again after an update, crash or reboot.
4. **Stops** the original launcher (so it does not come back).
5. Adds the app to the **DuraSpeed whitelist** (the MediaTek limiter).

If the camera has an account on it, Android may refuse; the script tells you.
**Undo:** `.\tools\update-cameras.ps1 -Unprovision` (adb only) puts the camera back as it was.

### 8.3 Online updates (OTA): the everyday way
1. After any change to the camera app:
   ```powershell
   .\tools\publish-build.ps1
   ```
   (builds and uploads to the server; asks for an admin username and password. `-SkipBuild` if the build is ready.)
2. Dashboard > **Updates** (`/updates.html`):
   - A camera with an old build is marked **Outdated**.
   - **Update all outdated**, or choose cameras (filter by region or company) > **Update selected**.
   - "Update even while recording" if you do not want to wait.
3. On the camera: **Downloading %** > **Installing** > restarts by itself > **Up to date** (about 9 seconds, all cameras together).
4. A camera that is recording waits for the recording to end (unless "even while recording" is ticked).
5. If it says **Failed**, the reason is written next to it (internet / checksum / install).

The build identifier is the SHA-256 of the APK. The camera sends its build to the server on every connection.

### 8.3a Telling customers about an update, and cameras that are far from a dock
**The customer's side is one thing: put the cameras on the docking station.** After you publish a build, open **Updates**:
1. **Tell your customers**: edit the message (English and Arabic are filled in) and press **Notify all users**. Publishing alone tells nobody, so a test build never troubles a customer.
2. Every user of every company gets a window with a Close button, once, and a **heart beats on their Updates tab** until they have seen it. After that the tab shows how many cameras still wait for the dock. Smart Way staff send the notice, they are not its audience.
3. A company's Updates page shows **only its own cameras**: "11 of 14 are up to date", which ones wait for the docking station and what each is doing. The client has nothing to press.

**Cameras that are not near a dock** (their employee works remotely): Docking > Registered (or Updates > Cameras), column **Updates**: *Docking station only* (default), *Over Wi-Fi*, *Over Wi-Fi and SIM*. For many cameras at once, select them on the Updates page and use *Network updates for the selected cameras*, or the menu at the top of Registered.
* When you publish, the server updates these cameras by itself, **carefully**. First ONE camera (the canary). The rest follow, three at a time, once a camera has run the new build for 5 minutes (a camera updated on a docking station counts as proof). If the first camera refuses the build or never comes back, or two cameras refuse it, everything **stops**, the page says why, and nothing more is sent until you press **Resume**. *Pause automatic updates* stops it by hand. A remote camera that got a broken build has no dock to be rescued on: this is why.
* A camera is asked only when it is online, not recording or live, not on a dock (the dock updates it in seconds) and has at least 30 % battery or is charging. A failed download is retried after 10 min, 30 min, 2 h and 6 h; a camera that refuses the build is not asked again and the client's page tells them to use the dock.
* *Over Wi-Fi*: the camera never touches the SIM, also when the Wi-Fi goes away halfway (what arrived is kept and the download goes on when Wi-Fi is back). It needs the newest camera app: put such a camera on a docking station once; until then the page says "needs the newest app first". *Over Wi-Fi and SIM* uses mobile data, about 55 MB per camera and update.
* The update installs without anybody touching the camera (it is the device owner). Tried on a real camera: Wi-Fi off = waiting for Wi-Fi, Wi-Fi on = download, Wi-Fi lost at 30 % = paused, then it went on, silent install, back on the new build.

Settings (environment): `ROLLOUT_PROVE_MS` (default 5 min), `ROLLOUT_CANARY_MS` (30 min), `ROLLOUT_PARALLEL` (3), `ROLLOUT_MIN_BATTERY` (30). Code: `server/updates.js`, `server/rollout.js`, `app/lib/core/services/app_updater.dart`. API for the apps: `GET /api/updates`, `GET /api/updates/badge`, `POST /api/updates/seen`.

### 8.3b Recording size (camera app 2026-11)
Recordings are 720p H.264 at 2 Mbps (about **0.9 GB per hour**; before: 1080p at 5.2 Mbps = 2.3 GB/h). 1080p, if chosen, is capped at 3.5 Mbps. A recording is cut into files of **10 minutes** (about 150 MB each): the camera and the live stream keep running and the next file starts on the next key frame, so at most about one second can sit at a boundary (measured under 1 s on a real camera). Small files upload, retry and expire independently.
Publish a new build from a Mac: `tools/publish-build.sh https://visionguard.smartwaygroup.com.sa --build`.

### 8.3c Push to cloud or keep on the dock (Docking > Files)
The Dock Agent no longer uploads everything. It **copies** each camera's videos and photos to the dock PC (folder `~/VisionGuard-Dock/<camera>/`, or `DOCK_STORAGE`), verifies them by SHA-256, and lists them under **Docking > Files**. For each file, or a whole selection:
* **Push to cloud**: the agent uploads it from the dock (one at a time, within seconds, even if the camera has been taken away);
* **Keep on dock storage**: it stays on the dock PC (it can still be pushed to the cloud later).

Above the list, **What should happen to new files?** sets the automatic behaviour (administrators): *Ask me* (default), *Automatic · Cloud*, *Automatic · Dock storage*. Upload quality is *Original* for now (lower qualities for the cloud copy come later). The *Files* tab shows how many files wait for a choice.

### 8.3d The audit trail (Analytics > Audit trail)
Every step of every file is recorded by the server: **copied to the dock**, **who decided** cloud or dock storage (or *auto*), **uploaded to the cloud** (verified), **deletion from the camera requested / done / refused**, retention removals, downloads, mode changes, camera edits and token changes. The record is **append-only** (the database itself refuses to edit or delete a line) and **hash-chained** (each line carries the SHA-256 of the line before it), so a removed or changed line breaks the chain and *Verify now* shows where. Filter by camera, user, date or kind, open one file's *History* from Docking > Files, or *Export CSV* (with the seals) for external archiving. Keep a copy of the *latest seal* value somewhere else: it also proves the whole log was not rewritten.
Limit: someone with full control of the server's disk can still destroy it entirely; the seal copy and the CSV exports are the protection against that.

### 8.3e Analytics insights and the written analysis
Analytics shows what needs attention (low battery, cameras offline, files waiting, failed uploads, unacknowledged SOS, storage running out, slower alarm response, unusual SOS counts, broken audit trail), the evidence pipeline, trends and a camera-health table. *Written analysis* gives an automatic summary; with `ANTHROPIC_API_KEY` in the server `.env` it becomes an AI-written briefing (numbers and camera names only).

### 8.3f Help & Support (Help in the top menu)
Quick answers, and **tickets**: a customer opens a ticket (subject, topic, priority, optional camera), follows the conversation and can reply or close it; a company administrator sees the company's tickets; Smart Way staff see and answer all of them and set the status (open, in progress, resolved, closed). A customer's reply reopens a resolved ticket. Every ticket action is in the audit trail. New tickets and customer replies are e-mailed to **sdpt@smart-way.com.sa** when the server has `SMTP_HOST` (see `.env.example`); without it they are stored and answered on the page.

### 8.3g Battery on every camera, and the low-battery alert
Every camera shows its **battery wherever it is**: the camera reports its own (live) and the dock adds its USB reading while it charges. The dashboard list, the map bubble, the live-wall tiles, the info panel, Analytics (*Low battery* gauge, Camera health) and the mobile apps all show it, with a bolt when it is charging.
**Under 20 % and not charging** raises an alert: an amber line in the Alarms list (with *Dismiss*), a soft beep, a *Low battery* chip in the header, a push notice (when push is configured) and an Insights line. **Under 10 %** it becomes critical and rings again even if it was dismissed. The alert clears by itself when the camera charges or is back above 25 % (so 19-21 % does not flap). Change the levels with `BATTERY_LOW` / `BATTERY_CRITICAL`. Cameras report with `camera_battery {cameraId, battery, charging}` (camera app update, see CHECKOUT.md section 5).

### 8.3g-2 Geofencing (zones on the map)
Draw an area on the dashboard map and get an alert when a camera leaves it, enters it, or does not pass by in time.
* **Where:** the **Geofences** button on the map (top right). **+ New zone**, pick *Circle* (click the centre, move out, click again) or *Polygon* (click each corner, **Finish**), then fill in the form. The size of a circle can be typed in metres.
* **Four kinds:** *Allowed area* (alert when a camera leaves it), *Forbidden area* (alert when it enters), *Both ways*, and *Checkpoint* (a camera must pass by at least every N minutes; no visit = alert, for patrol rounds).
* **Who and when:** all cameras of the company, or chosen cameras, groups or regions; every day, or chosen days and a time window (22:00 to 06:00 runs overnight). *Urgent* makes the alert red and loud.
* **What you see:** the alert appears in the Alarms list (with a beep and a notice), on the Alerts tab of the mobile app, and as a push notice on a locked phone. The zone turns red on the map until the camera is back in line; the alert then closes by itself. *Dismiss* only acknowledges it. The Geofences panel also lists the last 7 days.
* **Each camera on its own:** in the zone's edit dialog, the section *Each camera on its own* lists the company's cameras. Every camera can follow the zone ("Same as the zone"), be left out ("Not watched here"), or get its own rule: *Allowed*, *Forbidden*, *Both ways* or *Checkpoint*. The ⚙ button opens that camera's own urgency, its own checkpoint interval and its own days and hours. So in one zone one camera can be allowed, another forbidden, another a checkpoint, and another left out. A camera with a rule of its own is watched even when the zone's "Which cameras" does not include it. The type *No default rule* makes the zone watch only the cameras you set there.
* **Calm by design:** a change of side counts only after about 15 seconds and two fixes, a fix closer to the edge than its own accuracy is ignored, "left the zone" needs the camera to have been inside first, and a camera on a docking station is not judged. Tunable with `GEOFENCE_DEBOUNCE_MS` and `GEOFENCE_GRACE_MS` (grace after a checkpoint is due, default 2 minutes).
* **Who may:** everyone with the *Geofencing* feature can see zones; managers (and users given *Manage zones*) can draw, edit and delete. Zones are per company; Smart Way staff pick the company when they draw one. Every change is in the audit log (`geofence_created`, `geofence_edited`, `geofence_removed`, `geo_exit`, `geo_enter`, `checkpoint_missed`).
* **In the mobile app** the same zones show on the map, and managers can draw, edit and delete them (Cameras > map > Zones); per-camera rules are changed on the web.
* Limits: 200 zones per company, 100 corners per polygon, radius 10 m to 50 km. Zones follow the device clock of the person who draws them for the time zone (Riyadh = +3).

### 8.3h The live wall on a second screen
Live Dashboard > Live wall: **4x4** layout, **Full screen**, and **Open in its own window** (the icon with the arrow). The new window is a clean wall (`/wall.html`): drag it onto the extended screen and press **Full screen** (or F). With two screens Chrome asks once to place it on the other one automatically. Inside the wall: **drag a picture onto another to swap them**, drag a camera from the dashboard list onto a tile, *Add camera*, *Fill with live*, layouts 1 / 2x2 / 3x2 / 3x3 / 4x4 (keys 1-4), expand one tile (the arrows), listen, fit/crop. An SOS puts that camera on the wall and turns its tile red. While the wall window is open, the cameras you pick on the dashboard appear there, so the main screen keeps the map and alarms. The wall remembers its layout.

### 8.3i Employees and camera check-out
Each employee has a username and password; at the **check-out station** (`/station.html`) the system gives them a ready camera and lights its bay; the camera stamps date/time, camera ID and the employee ID. Full guide: **CHECKOUT.md**.

### 8.3j Licence (self-hosted customers)
Customers who run VisionGuard on their own server need a licence you issue (3, 6, 12, 24 or 36 months) and renew; the system degrades gently (grace, then limited mode, safety never stops). Full guide: **LICENSING.md**; page **License** (administrators).

### 8.3k Newer features (2026-11)
* **Profile and access** (button in the top bar; mobile app: More > Profile and access): shows the user's role, company and exactly which features and actions the account has. Answers "why can't I see this button?".
* **What a company administrator can do is capped by Smart Way** (section 3).
* **Stop recording** (Live dashboard, the Stop button on a recording camera): ends an officer's recording from the control room (section 5). The cross only closes the viewing window.
* **Dock storage per company** (Docking > Settings): each company has its own "ask me / cloud / keep on dock" policy and its own folder. "Choose folder" browses the dock computer through the Dock Agent (restart the Dock Agent after updating it; on a Mac: `launchctl kickstart -k gui/$(id -u)/com.visionguard.dock-agent`, and `launchctl bootout` / `bootstrap` after editing its `.plist`). The folder path is hidden from customers.
* **Owner app:** play and download recordings and dock files (save to Photos or Files, AirDrop), role-aware buttons.
* **Cameras use HTTPS.** The camera app moves itself from `http://<ip>:3000` to `https://visionguard.smartwaygroup.com.sa` at start-up when the domain answers `/healthz`, and rewrites its `config.json`. New cameras are provisioned with the domain by default. The Dock Agent uses the domain too (`DOCK_SERVER`).
* **Health and load:** `/healthz`, a Docker healthcheck, `tools/health-watch.sh` (outside watcher) and `tools/loadtest.js` (3000 pretend cameras, only against a throwaway server).

### 8.4 The docking station updates the cameras by itself (Dock Agent 1.6)
Publish the new camera app once (`tools/publish-build.ps1`, or Dashboard > Updates). From then on, every camera that is put on the dock is checked **the moment it is docked** (within a couple of seconds, before its recordings are copied) and then again every cycle (about 30 s):
* installed app = latest build -> nothing happens;
* older build -> the agent installs the latest one over USB (only when the camera is **not recording**, and it is powered by the dock or has **>= 20% battery**; change the level with `DOCK_UPDATE_MIN_BATTERY`), then starts the app. The bay shows *Updating app*;
* camera signed with an older key -> **"needs migration"** (see CAMERA_SIGNING.md); nothing is changed on it;
* camera without the app -> "provision this camera first" (needs its camera id and token, section 9).

Every cycle the agent also makes sure **GPS is ready** on each docked camera (location switched on, location permission granted) and fixes it if not, and again right after every install.
Switch off with `--no-update`; `--update-only` updates apps without copying recordings.

**On the camera's own screen** a window tells whoever docked it what the station is doing, so nobody unplugs it halfway: *Docking station - connected*, *Updating the camera software - do not unplug*, *Uploading recordings - file 2 of 5* with a bar, *All done* (a few seconds), or *Needs attention* with the reason. It only shows work that really happens (a camera whose recordings are already safe just says it is up to date), it never covers the screen of a camera that is recording (a thin bar instead), and it disappears by itself if the agent stops or the camera is unplugged. The agent writes a small file (`dock-status.json`, see `dock-agent/screen.js`) into the camera app's folder over USB and the camera app shows it. A camera shows the window once it runs a build that includes this feature: the update to that build is silent, every update after it shows the window. `--no-screen` switches it off.

---

## 9. A new camera (a new BWC from the manufacturer): step by step
1. Charge the camera (battery at 8-15 % if it was left).
2. Make sure **USB debugging** is on (every camera used so far had it on; if a new camera does not appear in `-List`, this setting is the reason).
3. `.\tools\update-cameras.ps1 -List` and note the serial.
4. `.\tools\update-cameras.ps1 -Provision -Serial <SERIAL> -Id BWC-xx-RIY`
5. Open the dashboard: the camera appears online after a few seconds. On the **Companies** page choose its company and region.
6. Check: ▶ and the live view works.

### 9.1 Adding a camera from a Mac (no PowerShell)
1. Dashboard > Companies > **Issue** for the new camera id (for example `BWC-08-RIY`): copy the token (shown once).
2. Charge the camera to 15 % or more, plug it into the dock or USB (USB debugging on). `adb devices` shows its serial.
3. `tools/provision-camera.sh <serial> BWC-08-RIY <token>` (installs the app, device owner and Home app, writes id, token and the HTTPS server address).
   A camera that already runs the new app and only needs a token: `tools/provision-camera.sh --config-only <serial> <id> <token>`.
4. Within seconds it shows *Link* on the camera screen and online on the dashboard; set its company, region and holder there.

### 9.2 Many new cameras in a row (`tools/provision-batch.sh`)
`tools/provision-batch.sh --watch` asks for an admin login once, then for each new camera you plug in (USB or dock, USB debugging on, "Allow" tapped on the camera) it picks the next free name (`BWC-07-RIY`, ...), issues its own token, installs the app and writes the HTTPS address. Press Ctrl+C when you are done; without `--watch` it handles the cameras plugged in now and stops.
* A camera that already has the app and a `config.json` is never touched, and names already on the server are never reused (that would replace a working camera's token).
* Tokens are not printed or saved; `~/.visionguard-provisioned.csv` lists serial, name and date.
* `--dry-run` shows the names without changing anything; `--prefix`, `--suffix`, `--start` change the naming; `--help` shows the options.
* Afterwards set company, region and holder in the dashboard.

---

## 10. Common problems

| Symptom | Likely cause | Fix |
|---|---|---|
| Camera offline in the dashboard | App not running / no Wi-Fi / wrong token | Open the app (on provisioned cameras the camera app is the Home app); check that the token in `cameras.json` equals the server token (or the camera's own token). |
| ▶ shows no live | The camera is offline | The `LINK` chip on the camera; the dashboard says "Camera is offline". |
| Live is laggy or slow | High quality and a weak network | Video quality > 720p or 480p. |
| Picture mirrored or small | A 9:16 stream on a 16:9 screen | Expand (portrait screen) or Fit. |
| Front camera upside down on the camera's own screen | (fixed in build 2026-10-15) the app rotated it by 180 degrees | Update the camera. |
| Switch camera does not work | (fixed) if it happens: restart the app | `adb shell am force-stop com.swg.swg_bwc` and open it. |
| Update: "Failed: checksum" | The uploaded APK differs from the file on the server | Run `publish-build.ps1` (or `.sh`) again. |
| Update: the camera does not start again | Not provisioned | `-Provision` by USB (once). |
| `-Provision`: "NOT enabled: ... several users" | Guest user | The script removes it; if still there: `adb shell pm list users`. |
| `-Provision`: "... accounts" | An account on the camera | Remove the account first. |
| The dock does not show the cameras | The dock only charges / copies data | Online update works without the dock. |
| "Failed to start" (server) | Port 3000 is busy | `Get-NetTCPConnection -LocalPort 3000` and stop the old node process. |
| A button is missing for a user | The company or the user has no such permission | Open **Profile and access** for that user; Smart Way ticks actions per company (section 3). |

Server log (local run): `%TEMP%\bwc-server.log` if it was started in a hidden window. In production: `sudo docker compose -p visionguard logs --tail 200` (run in `/opt/visionguard/deploy`).

---

## 11. Security and limits

- **Per-camera tokens** are in use (section 14). The old shared token (`BWC_TOKEN`) still works until `ALLOW_SHARED_TOKEN=false` is set; do that once every camera has its own token.
- Cameras, Dock Agents, the mobile apps and browsers reach the server over **HTTPS** (the domain). Plain HTTP port 3000 is not published. **RTMP video (port 1935) is not encrypted yet**, and publishing to it is not yet checked with the camera token (follow-up, section 14).
- **Backup:** a backup must cover `server/data/` (`bwc.db`, `.wal`, `.shm`, `updates/`, recordings) and `cameras.json`, and be kept **outside the server** (another machine or an object store) with a restore test. Do not rely on a backup service that nobody has tested: check the last successful backup date and try a restore.
- `cameras.json` contains tokens: it is never committed to git (ignored).
- Provisioning cannot easily be reversed except with `-Unprovision` (or a factory reset).
- Company administrators exist: a customer's administrator manages their own users inside the ceiling Smart Way set for the company (section 3).
- The Dock Agent (`dock-agent/`) runs on the PC next to the docking station and copies the recordings to it (section 8.4). Only copy-only mode is used unless deletion is explicitly enabled.
- Test new work on a test server first, so the real database is never touched (section 2).

---

## 12. Quick commands (cheat sheet)

```powershell
# the server (local run)
cd server; $env:BWC_TOKEN="yoursecret"; node server.js

# the cameras
.\tools\update-cameras.ps1 -List                              # what is connected
.\tools\update-cameras.ps1 -SkipBuild -Provision             # the dock / all cameras
.\tools\update-cameras.ps1 -SkipBuild -Serial KS16255032500468
.\tools\update-cameras.ps1 -Provision -Serial <S> -Id BWC-08-RIY
.\tools\update-cameras.ps1 -Unprovision                      # undo
.\tools\publish-build.ps1                                    # build and upload for the OTA
```

```bash
# Mac / Linux
tools/publish-build.sh https://visionguard.smartwaygroup.com.sa --build
tools/provision-camera.sh <serial> BWC-08-RIY <token>
tools/provision-batch.sh --watch
```

The audit (who did what):
```powershell
cd server; node -e "const {db}=require('./db');console.log(db.prepare('SELECT datetime(ts/1000,\'unixepoch\',\'localtime\') t,username,action,camera_id FROM audit ORDER BY id DESC LIMIT 30').all())"
```

---

## 13. Prompts you can give the assistant (copy and paste)

Add this sentence at the start of a prompt when the session is new: *"Open `docs/GUIDE.md` and read the memory before you start."*

**Docking station / several cameras**
- `I connected the docking station to the laptop. Run -List and update every camera that appears (give the new ones the IDs BWC-08 and BWC-09) and tell me the result for each camera.`
- `Update the cameras on the dock in parallel, provision them, and show me each one's battery.`

**One camera**
- `Update only the camera with serial <SERIAL> (USB) and name it BWC-0X-RIY.`
- `Camera BWC-05-RIY does not update online. Find out why and update it.`

**Online update**
- `I changed the camera app. Build it, publish it to the server, run Update all outdated, follow the progress and tell me which cameras succeeded.`
- `Update online only the cameras of the Riyadh region.`

**Cameras and the dashboard**
- `Add a new camera named BWC-0X and assign it to company X and region Dammam.`
- `Create a new company named <name> with a user <user>, give me the password and assign cameras BWC-04 and BWC-05.`
- `Clean up the dashboard: show me the cameras that are offline and have not been seen for a day, and I will tell you which to remove.`
- `Live from BWC-04 is laggy. Measure the bitrate and suggest the right quality.`

**The camera app**
- `Build a new feature in the camera app: <description>. Build it, update one camera, and test it there without asking me to test it.`
- `Night vision does not work on camera X. Look at the logcat.`

**General work**
- `Work on the normal branch, commit and push to both remotes, and give me the pull request link (gh may not be available).`
- `Run the full tests on a test server before you change anything on the real one.`
- `Give me the status summary: what works and what is still open.`

> Tip: tell the assistant the **definition of done**: "test on a real camera and show me a screenshot or log", so that it verifies instead of saying "done".

---

## 14. Per-camera tokens (security)

- Every camera has its own token. The server stores only its hash; the token is shown **once**.
- Dashboard > Companies > the cameras table > **Issue / Rotate**: it returns `{"id":..., "token":...}`. Put it in `cameras.json` under `"tokens": {"BWC-04-RIY": "<token>"}` and run `update-cameras.ps1` (it writes it into `config.json` on the camera). On a Mac, `provision-camera.sh` and `provision-batch.sh` do this for you.
- A camera with its own token **cannot act as another camera** (the server refuses any event naming another camera).
- Rotating a token disconnects the old camera immediately; the old token stops working.
- The old shared token (`BWC_TOKEN`) still works until the migration is finished: when every camera has its own token, run the server with `ALLOW_SHARED_TOKEN=false`.
- Still open: RTMP publishing itself is not yet checked with the token (follow-up).
