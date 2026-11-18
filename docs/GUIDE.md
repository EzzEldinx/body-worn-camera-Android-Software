# VisionGuard (Smart Way Group BWC) — Dalil el-sho8l el-kamel

> El dalil da bel Franco (Arabic bel horof el-ingilizi) w el-awamer bel-ingilizi 3shan tet3ammal copy/paste.
> Aakher ta7deeth: 2026-10-15. Kol el-awamer PowerShell men **gozr el-project** (`C:\Projects\swg-bwc-system`) ella law ittzakar 8eir keda.

---

## 1. Nazra 3amma (eh elly 3andak)

```
 [BWC camera x N]  ---- Wi-Fi/4G ---->  [Server (PC)]  <---- browser ----  [Dashboard (el admin + el companies)]
   app: swg_bwc          socket.io (commands, GPS, chat)         port 3000
                         RTMP video  --->  port 1935 --> FLV 8000 (el dashboard beyshoofo)
```

| El-goz2 | Feen | Beyshta8al ezzay |
|---|---|---|
| **Server + Dashboard** | `server/` (Node.js) | `node server.js` — port **3000** (web), **1935** (RTMP video men el-camera), **8000** (video lel browser) |
| **Camera app** | `app/` (Flutter, package `com.swg.swg_bwc`) | beyetnazzel 3al camera (USB aw online) |
| **Tools** | `tools/` | `update-cameras.ps1`, `publish-build.ps1` |
| **El-database** | `server/data/bwc.db` | SQLite, bet-etkawwen lewa7daha |
| **Build el-OTA** | `server/data/updates/app.apk` | el-APK elly el-cameras betenazzelo |

Repo: `https://github.com/EzzEldinx/body-worn-camera-Android-Software` — branches:
- `feature/dashboard-command-center` → el-server + el-dashboard + el-tools (da el-asasi).
- `feature/voice-notes-command-center` → el-camera app (`app/` nested repo, nafs el-remote).

---

## 2. Tashgheel el-server

```powershell
cd C:\Projects\swg-bwc-system\server
$env:BWC_TOKEN = "yoursecret"      # nafs el-token el-mawgood fe cameras.json — lazem yetatabe2
node server.js
```
- El-dashboard: `http://192.168.100.75:3000` (el-IP bta3 el-PC). Law el-IP et8ayyar: 8ayyar `server` fe `cameras.json` w 3awwed el-update lel cameras (khotwat 8).
- **Awwel mara bas**: el-server beya3mel user `admin` w byetba3 el-password fel-terminal (aw `ADMIN_PASSWORD`).
- Taghyeer password el-admin: `node tools/create-user.js admin <password-gedeed> "Administrator" admin`
- User staff gedeed (Smart Way): `node tools/create-user.js <user> <pass 8+> "Esm" admin` (admin = kol el-so2lahat) aw `viewer` (tashoof bas).
- Law el-PC et3amal restart, el-server **mesh** byeshta8al lewa7do — lazem tshaghghalo tany (el-cameras betrga3 betwassal lewa7daha).

---

## 3. El-gazaat wel-so2lahat (Roles)

| Nou3 el-user | Beyshoof eh | Beye3mel eh |
|---|---|---|
| **Super admin** (`role=admin`, mafeesh company) | **kol 7aga** | kol el-so2lahat: companies, regions, edit/delete camera, updates, quality, remote start |
| **Staff viewer** (mafeesh company) | kol el-cameras | shoof + live bas |
| **Company user** (men saf7et Companies) | **cameras el-company bta3to bas** | live, chat, alarms, remote start/stop, quality le cameras bta3to — **mesh** edit/delete/update |

El-company mamnoo3 yeshoof camera/alarm/chat/video bta3t company tanya — el-server beye3mel el-check (mesh el-browser bas). El-video nafso beyetlab b-**sign** (link mo2aqqat) mesh public.

---

## 4. El-companies, el-regions wel-cameras (saf7et **Companies**)

Feen: dashboard > el-eyqona fo2 (bena2 mabna) aw `http://192.168.100.75:3000/admin.html` (super admin bas).

1. **Company gedeeda**: ektob el-esm > Add company.
2. **User le el-company**: gowwa kart el-company > username + password (8+ a7ruf, fee zorar **Generate**) > Add user. El-password byezhar **marra wa7da** — e3mel Copy w edeeh lel-3ameel. (Reset password / Remove user mawgoodeen.)
3. **Regions** (Riyadh, Jeddah, Dammam ...): kart **Regions** > ektob el-esm > Add. (X 3ala region = el-cameras betba2a "No region".)
4. **Camera → company + region**: gadwal **Camera assignment**: e5tar el-company w el-region men el-dropdowns, bey7fezo fawran.
5. **Delete camera**: ✕ gamb el-camera, aw **Remove all offline cameras** (beyes2al confirm w beyewarreek el-asma2).

### Delete camera — bey7sal eh?
- El-camera betetshal men el-dashboard.
- **Matergaash lewa7daha** (7ata law fel-awqat el-GPS/heartbeat shaghal). Betergaa3 bas lama el-camera **te3mel Record** (start video) aw **SOS** aw **PTT** — wa2tha betzhar tany wa7da gedeeda (mesh lazem te3mel 7aga fel-dashboard).

---

## 5. El-dashboard el-yawmi (`/`)

### El-qa2ema el-yemeen (el-cameras)
- **Region tabs** fo2 (All / Riyadh / Jeddah / Dammam / No region) — gamb kol tab "online/total".
- Gowwa kol tab: **companies** (collapsible) w 3ala-ha el-cameras. (El-company el-wa7da mesh betshoof headers.)
- Search + filter (All / Online / Recording).
- **▶** = **Watch live**: law el-camera online w mesh bet-record, **beyebda2ha el-stream benafsoh** (el-officer maye3rafsh). Law kanet bet-record asln beyofta7 el-video.
- Idas 3ala camera → panel taht el-map: eltaf el-esm, el-company/region, **Watch live**, **Follow**, **Edit**, **Video quality**, **Stop remote stream** (aw **Stop recording…** lel-recording el-officer).

### El-Live wall
- 1 / 2×2 / 3×3 tiles. Kol tile: esm + **REC/WAITING**, **Listen** (sawt), **Fill/Fit**, **Expand** (theater), ✕.
- **Fit** (default) = el-sora kamla; **Fill** = tekabber w tet2ass. El-camera bet-ba3at sora **tool (9:16)** → fel-Expand beyetgheir shakl el-shasha 3ala hasab el-sora.
- Law el-camera online bas mesh bet-record: el-tile beyewarreek "Waiting…" w zorar **Start live view**.

### Remote control (men el-dashboard le-camera wa7da)
| 3ayez | E3mel |
|---|---|
| Ebda2 live | ▶ aw **Start live view** |
| Wa2af el-stream aw el-recording | Zorar **■ Stop** 3ala sorat el-camera (aw **Stop recording…** fel panel taht el-map). Beyes2alak ta2ref eh bezabt: **Stop streaming** lel-live elly ent bada2to, aw **Stop recording and streaming** lel-recording elly el-**officer** bada2o. El-tany byehtag el-so2la **Stop a recording** (el-company manager w Smart Way staff 3andohom, el-baqi yet3eti), el-camera tekoon 3andaha el app el-gedeed (betqool `remote-stop`), w mayekoonsh fee SOS lel-camera lessa meganakshe ack (sa3tein, `STOPREC_SOS_GUARD_MS`). El-officer beyetwarrah "Recording stopped by the control room" 3ala el-camera w el-file beyet7fez. Beyetsagel fel-audit (`remote_record_stop`). |
| E2fel el-window bas | Zorar **✕** 3ala el-sora (aw **Close window only** fel menu): el-camera betkammel zay ma heyya w mafeesh 7aga betetghayyar 3aleha |
| Ghayyar el-gawda | panel > **Video quality**: 240p / 480p / 720p / **1080p (default)** / 4K |
| Kalem el-officer | PTT / chat / voice note men el-chat panel |

- Taghyeer el-quality ma3a stream sha8al = restart 3al 7ala ~**3.5 sanya** (fee gap sghayyar).
- El-camera 3ala 1080p bet-ba3at ~**4.8 Mbps** (it2ees 3ala camera wa7da); law el-shabaka da3eefa: 720p aw 480p.
- Kol amr remote (start/stop/quality/update) bey-etsagal fe gadwal `audit` (meen, emta, ayya camera).

### Alarms (SOS)
- Officer by-doos **SOS 2 sawani** → alarm bey-zhar fel-dashboard + sawt + el-camera betetrafa3 3al wall (law betsagel). Law mesh betsagel, e3mel ▶ 3alehaa.
- El-admin by-doos 3al alarm = acknowledge. El-wa2t ben el-SOS wel-acknowledge beyetsagel w beyezhar fe analytics ka "Avg response".

### Chat wel voice notes
- Tabs: **Public** (kol el-company), **Private** (el-camera) — zorar mic = voice note (record → send).
- El-company beshoof chat bta3ha bas; **Staff broadcast** (Public men staff) beywasal lel-kol.

### El-lugha wel-theme
- EN/AR + light/dark men fo2 (bet-etzakar). Zorar el-lugha (**عربي | EN**) maw3ood fel header fi **kol** saf7a (el-Dashboard, Analytics, Reports, Docking, Support, Updates, Employees, Admin, License, Live wall, Login, el-Station, Privacy) — shof el-section ta7t.

### El-lugha (English / Arabic) fel website kolo
- **El-ekhtiyar**: el-lugha elly teekhtarha bet-etzakar fel browser (`localStorage` esm-ha `bwc-lang` + cookie `vglang`) w betetnaffez 3ala kol el-sfa7at, 7ata el-login w el-Live wall window (law ghayart el-lugha men saf7a, el-windows el-tanya btelha2). El-awwal marra: law el-browser 3araby yefta7 Arabic, ella yefta7 English.
- **El-3araby RTL**: el-saf7a kolha bet-enqeleb (el-menu, el-gadawel, el-forms, el-charts, el-flow diagram). El-ar2am bel-ingilizi (0-9) w el-tawareekh Gregorian w el-sa3a 24h fel lughatein. El-camera IDs w el-units (MB, GB) bet-fdal Latin.
- **El-kalam fein?** `server/public/i18n.js` (el-engine + el-kalam el-moshtarak), `server/public/i18n/<page>.js` (kalam kol saf7a, EN + AR bel nafs el-keys), `server/lang/errors.js` (rodood el-API), `server/lang/texts.js` (el-insights, el-written analysis, el-push, el-emails). **Text gedeed** = key gedeed fel **lughatein** (el-test `server/test/i18n.test.js` yefshal law key fi lugha w mesh fel tanya, aw law fi error gedeed fel server bela tarjama).
- **El-server beyrod bel-lugha**: el-browser by-ib3at cookie `vglang`; el-app el-mobile by-ib3at header `x-lang`. El-API errors, el-written analysis, el-push notifications (kol gehaz bel-lugha bta3to) w el-support emails (bel-lugha bta3et elly katab el-ticket, aw `SUPPORT_EMAIL_LANG=en|ar` fel `.env` 3ashan el-desk yestalem bel-lugha el-sabta).
- **Mesh metargam (3amdan)**: el-CSV exports (headers w codes bel-ingilizi 3ashan Excel w el-audit hashes), el-date pickers (shakl el-browser nafso), w ay kalam katabo el-nas (asma' el-companies, el-notices...).

---

## 6. Saf7et el-Analytics (`/analytics.html`)
Betefta7 ba3d el-login. Gauges (online / recording / open alarms / avg response), donuts (fleet status, alarms, cameras by company aw group), SOS 7 ayyam, flow chart (Camera → Server → Control room). Betet-gadded kol 10 sawani. Zorar **Open Live Dashboard**.
El-company beshoof arqamha bas.

---

### 6.b The PDF report (one day, or any range up to 92 days)
Analytics > card **Reports**: pick **From** and **To** (or a shortcut: Today, Yesterday, Last 7 days, Last 30 days, This month, Last month) > **Download PDF**. Smart Way administrators can pick a **company** or "All companies"; a company only gets its own.
The report has: banner, 4 KPIs (active cameras, SOS, recorded time, distance), the fleet donut, **activity by hour** (one day) or **recorded time by day with the SOS count** (several days), the SOS table with response times, a **Day by day** table (several days), **Camera custody** (who took which camera, when, how long, from the check-out station), camera activity, control-room actions and a timeline. Days are cut in **your own time zone** (the browser sends it).
* Endpoint: `/api/report?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=<minutes>&company=<id>` (the old `?date=` still means one day). Every download is written to the audit trail.
* Events (online/offline, recording, PTT, messages) are logged **from the moment of that update**; earlier days have SOS + GPS + control-room actions only.
* **Arabic PDF:** with the website in Arabic the report is downloaded in Arabic (the language comes from the same switch; `?lang=ar` forces it): right to left, mirrored layout, Arabic month and day names, Arabic names kept. In the English report Arabic names are still dropped (Latin font). Arabic font: DejaVu Sans in `server/fonts/` (licence file beside it; `server/report.js` does the mirroring and the Arabic/number ordering, words in `server/lang/report-text.js`). A nicer Arabic font (Noto Naskh, Cairo) can replace the two files if wanted.

---

## 7. El-camera app (SWG-BWC-04)

**El-shasha**: sora full-screen + HUD: logo, `LINK` (el-ittisal bel-server), `GPS`, esm el-camera, REAR/FRONT, el-gawda (1080P), el-sa3a, **REC timer**.
**Zorar el-safahat**: chat · crop (wide/full) · torch · **night vision** (hilal) · switch camera.
**Taht**: zoom · photo · **REC** (abyad, el-mo3arra3 ahmar; moraba3 wa2t el-record) · **SOS** (2 sawani) · **PTT** (maskooh).

- **Night vision** (zorar el-hilal): beyeshta8al 3 7agat sawa: motor el-**IR-cut** + **IR LEDs** + sora **abyad w eswed**. Ta7t el-tayyar el-ta2ees: el-sora bet2oll shwaya (el-lens beyshoof el-infrared).
- **Switch camera**: el-gehaz mesh beyesma7 ghair b-camera **wa7da maftoo7a fel-wa2t**. El-app el-adeem kan beyefsha ba3d awwel switch (el-camera el-adeema kanet batba2a maftoo7a). Etsala7 w ekhtabarto: 4 switches wara ba3d byeshta8alo.
- **ID el-camera + server + token**: mesh gowwa el-app. Kol camera feha `config.json` (`/sdcard/Android/data/com.swg.swg_bwc/files/config.json`) beyetkatib men `cameras.json` bel-script (khotwa 8).
- **GPS**: el-chip beyeb2a "GPS..." bel-asfar lama mafeesh fix (3adatan gowwa el-mabna), "GPS" akhdar lama yedhar.
- **El-recording**: kol video beyetsagel 3ala el-camera nafsaha (`SWG_BWC` folder) + beyetba3at live lel-server. El-gawda nafsaha lel-itnein.

---

## 8. Tahdeeth el-cameras (el-7aga el-mohemma)

> El-camera el-adeema (abl el-OTA) mesh hateqbal update online — **awwel marra lazem USB** (aw el-docking station). Ba3d keda online.

### 8.1 El-camera el-gedeeda / awwel marra — b-USB (aw el-dock)
1. Wassel el-camera/el-dock bel-laptop. Check:
   ```powershell
   .\tools\update-cameras.ps1 -List
   ```
   (law zahar el-serial = tamam. El-dock elly ma3ana **beyewarri el-cameras 3ala el-USB**: etgarrab m3 4 cameras marra wa7da.)
2. Camera wa7da gedeeda (ID gedeed):
   ```powershell
   .\tools\update-cameras.ps1 -Provision -Serial <SERIAL> -Id BWC-08-RIY
   ```
   - `-Id` beyetsagel fe `cameras.json` lel-marrat el-gaya.
   - `-Provision` = el-setup el-marra el-wa7da (te7t).
3. **El-docking station / kaza camera marra wa7da** (bey-update kol el-mawgood, ta7t 10 b-parallel):
   ```powershell
   .\tools\update-cameras.ps1 -SkipBuild -Provision
   ```
   El-cameras elly mesh fe `cameras.json` beyetgahalo w beyetsayyal esmo3ha (3ashan tdeef el-ID).
4. Update camera wa7da bas: `... -Serial <SERIAL>` (el-serial men `-List`).
5. Flags: `-SkipBuild` (3awwed el-APK el-ekhir), `-Parallel 5` (3adad el-camerat sawa), `-Unprovision` (te7t).

### 8.2 Provisioning (`-Provision`) — beye3mel eh bel-zabt?
1. Beyemsa7 el-**Guest user** el-fady (Android bey-refod device owner law fee user tany).
2. Beyegh3al el-app **Device Owner** → el-install bey-ba2a **sa2et** (mafeesh "Install" 3al shasha).
3. Beyegh3al el-app **Home app** → Android byeshaghalo men gedeed ba3d el-update/crash/reboot.
4. **Beyewa2af** el-launcher el-asli (3shan ma-yerga3sh heyya).
5. Beyedaf el-app lel-**DuraSpeed whitelist** (el-limiter bta3 MediaTek).

Law el-camera 3aleha account → mumken yerfod; el-script beyeqolak.
**El-ta3ameel**: `.\tools\update-cameras.ps1 -Unprovision` (adb bas) beyerga3 el-camera zay ma kanet.

### 8.3 Tahdeeth online (el-OTA) — el-tareeqa el-yawmiya
1. Ba3d ay ta3deel fel-camera app:
   ```powershell
   .\tools\publish-build.ps1
   ```
   (build + upload lel-server; beyes2al el-admin username/password. `-SkipBuild` law el-build gahez.)
2. Dashboard > **Updates** (`/updates.html`):
   - el-camera el-3andaha build adeem btetsamma **Outdated**.
   - **Update all outdated** aw e5tar cameras (filter region/company) > **Update selected**.
   - "Update even while recording" = law mesh 3ayz teantazer.
3. El-camera: **Downloading %** → **Installing** → betet-restart wa7daha → **Up to date** (~9 sawani, kol el-cameras sawa).
4. Law camera betsagel: betestanna yekhallas el-record (ella law 3mal tick "even while recording").
5. Law **Failed** — el-sabab beyetktab 7awaleha (internet / checksum / install).

El-build identifier = SHA-256 lel-APK. El-camera beteb3at el-build bta3ha lel-server 3and kol ittisal.

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
Publish a new build from a Mac: `tools/publish-build.sh https://server --build`.

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
* Limits: 200 zones per company, 100 corners per polygon, radius 10 m to 50 km. Zones follow the device clock of the person who draws them for the time zone (Riyadh = +3).

### 8.3h The live wall on a second screen
Live Dashboard > Live wall: **4x4** layout, **Full screen**, and **Open in its own window** (the icon with the arrow). The new window is a clean wall (`/wall.html`): drag it onto the extended screen and press **Full screen** (or F). With two screens Chrome asks once to place it on the other one automatically. Inside the wall: **drag a picture onto another to swap them**, drag a camera from the dashboard list onto a tile, *Add camera*, *Fill with live*, layouts 1 / 2x2 / 3x2 / 3x3 / 4x4 (keys 1-4), expand one tile (the arrows), listen, fit/crop. An SOS puts that camera on the wall and turns its tile red. While the wall window is open, the cameras you pick on the dashboard appear there, so the main screen keeps the map and alarms. The wall remembers its layout.

### 8.3i Employees and camera check-out
Each employee has a username and password; at the **check-out station** (`/station.html`) the system gives them a ready camera and lights its bay; the camera stamps date/time, camera ID and the employee ID. Full guide: **CHECKOUT.md**.

### 8.3j Licence (self-hosted customers)
Customers who run VisionGuard on their own server need a licence you issue (3, 6, 12, 24 or 36 months) and renew; the system degrades gently (grace, then limited mode, safety never stops). Full guide: **LICENSING.md**; page **License** (administrators).

### 8.3k Newer features (2026-11)
* **Profile and access** (button in the top bar; mobile app: More > Profile and access): shows the user's role, company and exactly which features and actions the account has. Answers "why can't I see this button?".
* **What a company administrator can do is capped by Smart Way.** In Admin panel > Companies, Smart Way ticks the features AND the actions (stop recording, zones, files, delete...) for each company. A company without a tick for an action cannot give it to anyone, even its own administrator. Without any action ticked a company gets only the everyday actions. After this change a company may need its actions ticked again.
* **Stop recording** (Live dashboard, the Stop button on a recording camera): ends an officer's recording from the control room. Needs the `stoprec` permission, a camera build that reports `remote-stop`, no open SOS in the last 2 h; it is audited (`remote_record_stop`). The cross only closes the viewing window.
* **Dock storage per company** (Docking > Settings): each company has its own "ask me / cloud / keep on dock" policy and its own folder. "Choose folder" browses the dock computer through the Dock Agent (restart the Dock Agent after updating it: `launchctl kickstart -k gui/$(id -u)/com.visionguard.dock-agent`). The folder path is hidden from customers.
* **Owner app:** play and download recordings and dock files (save to Photos or Files, AirDrop), role-aware buttons.
* **Cameras use HTTPS.** The camera app moves itself from `http://<ip>:3000` to `https://visionguard.smartwaygroup.com.sa` at start-up when the domain answers `/healthz`, and rewrites its `config.json`. New cameras are provisioned with the domain by default. Once every camera shows the new build, port 3000 can be closed.
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

## 9. Camera gedeeda (BWC gedeed men el-shirka) — step by step
1. Charge el-camera (el-battery el-wetia beteb2a 8-15% law sebta).
2. Ta2akkad en **USB debugging** shaghal 3ala el-camera (el-cameras elly shaghalnaha kolaha kanet shaghala; law camera gedeeda mesh bet-zhar fe `-List` yebqa el-setting dee heyya el-sabab).
3. `.\tools\update-cameras.ps1 -List` → e3mel serial.
4. `.\tools\update-cameras.ps1 -Provision -Serial <SERIAL> -Id BWC-xx-RIY`
5. Efta7 el-dashboard — el-camera betzhar online ba3d sawani. **Companies** page: e5tar el-company + el-region.
6. Ta2akkad: ▶ → el-live beyeshta8al.

### 9.1 Adding a camera from a Mac (no PowerShell)
1. Dashboard > Companies > **Issue** for the new camera id (e.g. `BWC-08-RIY`): copy the token (shown once).
2. Charge the camera to 15%+, plug it into the dock/USB (USB debugging on). `adb devices` shows its serial.
3. `tools/provision-camera.sh <serial> BWC-08-RIY <token>` (installs the app, device owner + Home app, writes id/token/server).
   A camera that already runs the new app and only needs a token: `tools/provision-camera.sh --config-only <serial> <id> <token>`.
4. Within seconds it shows *Link* on the camera screen and online on the dashboard; set its company, region and holder there.

### 9.2 Many new cameras in a row (`tools/provision-batch.sh`)
`tools/provision-batch.sh --watch` asks for an admin login once, then for each new camera you plug in (USB or dock, USB debugging on, "Allow" tapped) it picks the next free name (`BWC-07-RIY`, ...), issues its own token, installs the app and writes the HTTPS address. A camera that already has the app and a `config.json` is never touched. Names already on the server are never reused. Tokens are not printed or saved; `~/.visionguard-provisioned.csv` lists serial, name, date. `--dry-run` shows the names without changing anything; `--prefix/--suffix/--start` change the naming. Afterwards set company, region and holder in the dashboard.

---

## 10. Moshkelat sha2e3a

| El-3ard | El-sabab el-mo7tamal | El-7al |
|---|---|---|
| El-camera offline fel-dashboard | el-app mesh shaghal / mafeesh Wi-Fi / el-token ghalat | efta7 el-app (el-camera app = Home app fel-provisioned); check `cameras.json` token = `BWC_TOKEN` |
| ▶ mafeesh live | el-camera offline | ✓ chip "LINK" 3al-camera; el-dashboard beyeqollak "Camera is offline" |
| Live beyetla3 lag/3alay | gawda 3alya + shabaka da3eefa | Video quality → 720p/480p |
| El-sora ma3akoosa/soghayyara | stream tool 9:16 3ala shasha 16:9 | Expand (shasha el-mehwar el-tawel) aw Fit |
| Front camera maqloob 3ala shashet el-camera nafsaha | (etsala7 fe build 2026-10-15) el-app kan beyla2eeha 180° | e3mel update lel-camera |
| Switch camera ma-byeshta8alsh | (etsala7) law ranna: restart el-app | `adb shell am force-stop com.swg.swg_bwc` + efta7 |
| Update: "Failed: checksum" | el-APK atba3at b2a 8eir el-mawgood | e3mel `publish-build.ps1` tany |
| Update: el-camera mesh betrga3 teshta8al | mesh provisioned | `-Provision` b USB (marra) |
| `-Provision`: "NOT enabled: ... several users" | Guest user | el-script beyemsa7o ta2eeyan; law lessa: `adb shell pm list users` |
| `-Provision`: "... accounts" | account 3ala el-camera | emsa7 el-account el-awwal |
| El-dock mesh bey-zhar el-cameras | el-dock charge/data bas | el-update online (mesh lazem el-dock) |
| "Failed to start" el-server | port 3000 mashghool | `Get-NetTCPConnection -LocalPort 3000` w e2fel el-node el-adeem |

Logs el-server: `%TEMP%\bwc-server.log` law ba3d-et fel-hidden window.

---

## 11. Amn (Security) w 7udood

- Cameras kolaha b-**token wa7ed** (`BWC_TOKEN`). Camera mokhtaraqa te2dar te-act ka camera tanya. (El-7al el-mostaqbal: token le kol camera.)
- El-cameras wel-dashboard bet-etasel bel-domain 3ala HTTPS (el-camera app bet-7awwel nafsaha). Port 3000 yetaffel ba3d ma kol el-cameras tet7awwel. Lel-internet el-mafto7: HTTPS + VPN.
- **Backup**: e2fel el-server w en2el `server/data/` (bwc.db + .wal + .shm + updates/) w `cameras.json`.
- `cameras.json` feeh el-token — mesh bey-etraf3 3ala git (ignored).
- Provisioning mesh sahl yet-3ayyar 3akso men 8eir `-Unprovision` (aw factory reset).
- Mafeesh "company admin" (el-3ameel yedeer el-users bta3to) lessa.
- El-dock software (bta3 el-sherka el-mosana3a) mesh ma3roof — el-data offload bta3o mesh mowasal bel-app.
- Test: el-sho8l el-gedeed el-mohem etgarrab abl 3ala server tagrobi (`PORT=3100 DATA_DIR=<folder fady> RTMP_PORT=1936 FLV_PORT=8100 node server.js`) 3ashan matetkharbash el-database el-asliya.

---

## 12. Awamer sarie3a (cheat sheet)

```powershell
# el-server
cd server; $env:BWC_TOKEN="yoursecret"; node server.js

# el-cameras
.\tools\update-cameras.ps1 -List                              # eh el-mowaslin
.\tools\update-cameras.ps1 -SkipBuild -Provision             # el-dock/koll el-cameras
.\tools\update-cameras.ps1 -SkipBuild -Serial KS16255032500468
.\tools\update-cameras.ps1 -Provision -Serial <S> -Id BWC-08-RIY
.\tools\update-cameras.ps1 -Unprovision                      # te7t
.\tools\publish-build.ps1                                    # build + upload lel-OTA
```

El-audit (meen 3amal eh):
```powershell
cd server; node -e "const {db}=require('./db');console.log(db.prepare('SELECT datetime(ts/1000,\'unixepoch\',\'localtime\') t,username,action,camera_id FROM audit ORDER BY id DESC LIMIT 30').all())"
```

---

## 13. El-prompts elly te2dar tedeehalee (copy/paste)

Edef el-gomla dee fi awwel el-prompt law el-session gedeeda: *"Efta7 `docs/GUIDE.md` w eqra el-memory abl ma tebda2."*

**Docking station / kaza camera**
- `Wassalt el-docking station bel-laptop. E3mel -List w e3mel update le kol el-cameras elly zaharet (el-gedeeda dedeha IDs BWC-08 w BWC-09) w a2olly el-natee2a le kol camera.`
- `Update el-cameras el-fel-dock b-parallel w e3mel Provision w warrini el-battery le kol wa7da.`

**Camera wa7da**
- `Update camera el-serial bta3ha <SERIAL> bas (USB) w khalleha BWC-0X-RIY.`
- `Camera BWC-05-RIY mesh betet-update online. Eshoof leh w e3mel update.`

**Online update**
- `Ana 3addelt el-camera app. E3mel build w publish lel-server w e3mel Update all outdated w betabe3 el-progress wa2olly meen nagah.`
- `Update online le cameras region Riyadh bas.`

**Camera / dashboard**
- `Ed-delo camera gedeeda esmaha BWC-0X w e5talaf company X w region Dammam.`
- `E3mel company gedeeda esmaha <esm> w user <user> w edeeni el-password w assign cameras BWC-04 w BWC-05.`
- `Nazzaf el-dashboard: warreeni el-cameras elly offline w mesh etshafet men yom, w ana a2olak emsa7 meen.`
- `El-camera BWC-04 el-live beyetla3 lag. E2ees el-bitrate w a2tare7 el-gawda el-monaseba.`

**Camera app**
- `E3mel feature gedeeda fel-camera app: <wasf>. E3mel build, update 3ala camera wa7da, w garrab 3alehaa 8eir ma te2olli test-ha ana.`
- `Night vision mesh beyeshta8al 3ala camera X — eshoof el-logcat.`

**Sho8l 3am**
- `Eshta8al 3ala el-branch el-3adi, e3mel commit w push, w edeeni link el-PR (el-gh mesh mawgood).`
- `E3mel test shamel 3ala server tagrobi abl ma te3mel ay ta3deel 3ala el-asli.`
- `Edeeni khalaset el-7ala: eh elly shaghal w eh elly lessa.`

> Nasiha: 2ool leya **el-"definition of done"**: "e3mel test 3ala camera 7a2ee2ya w warreeni screenshot/log" — 3ashan a7aqeq 8eir ma a2ool "tamam".

---

## 14. Per-camera tokens (amn)

- Kol camera 3andaha token khas beha. El-server beyekhzen el-hash bas; el-token byezhar **marra wa7da**.
- Dashboard > Companies > gadwal el-cameras > zorar **Issue / Rotate**: beyetla3 `{"id":..., "token":...}` — hatto fe `cameras.json` taht `"tokens": {"BWC-04-RIY": "<token>"}` w e3mel `update-cameras.ps1` (beyektebo fe config.json 3ala el-camera).
- Camera b-token khas **mayenfa3sh te-act ka camera tanya** (el-server beyerfod ay event beyesmy camera tanya).
- Rotate beyefsel el-camera el-adeem fawran; el-token el-adeem beyetwaqqaf.
- El-token el-moshtarak el-adeem (`BWC_TOKEN`) lessa byeshta8al le-ghayat ma te2fel el-migration: lama kol el-cameras tekhod token khas, shaghghal el-server b `ALLOW_SHARED_TOKEN=false`.
- Lessa: el-RTMP publish nafso lessa mesh monta3ad bel-token (follow-up).
