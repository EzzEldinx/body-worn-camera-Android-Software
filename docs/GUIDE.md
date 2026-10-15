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
- Idas 3ala camera → panel taht el-map: eltaf el-esm, el-company/region, **Watch live**, **Follow**, **Edit**, **Video quality**, **Stop remote stream**.

### El-Live wall
- 1 / 2×2 / 3×3 tiles. Kol tile: esm + **REC/WAITING**, **Listen** (sawt), **Fill/Fit**, **Expand** (theater), ✕.
- **Fit** (default) = el-sora kamla; **Fill** = tekabber w tet2ass. El-camera bet-ba3at sora **tool (9:16)** → fel-Expand beyetgheir shakl el-shasha 3ala hasab el-sora.
- Law el-camera online bas mesh bet-record: el-tile beyewarreek "Waiting…" w zorar **Start live view**.

### Remote control (men el-dashboard le-camera wa7da)
| 3ayez | E3mel |
|---|---|
| Ebda2 live | ▶ aw **Start live view** |
| Wa2af el-stream | **Stop remote stream** (bas lel-stream elly ent bada2to — recording el-officer mesh beyetwa2af) |
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
- EN/AR + light/dark men fo2 (bet-etzakar).

---

## 6. Saf7et el-Analytics (`/analytics.html`)
Betefta7 ba3d el-login. Gauges (online / recording / open alarms / avg response), donuts (fleet status, alarms, cameras by company aw group), SOS 7 ayyam, flow chart (Camera → Server → Control room). Betet-gadded kol 10 sawani. Zorar **Open Live Dashboard**.
El-company beshoof arqamha bas.

---

### 6.b El-PDF report el-yawmi
Fe saf7et el-Analytics, kart **Daily report**: e5tar el-yawm (el-default el-nahar-da) > **Download PDF**. (El-Smart Way admin yeqdar ye5tar **company** aw "All companies"; el-company beteshoof bta3tha bas.)
El-report feeh: banner b-gradient, 4 KPI (cameras active, SOS, recorded time, distance), donut el-cameras, chart el-nashat 3ala el-sa3at, gadwal el-SOS (wa2t el-response), gadwal kol camera (online/recorded/distance/PTT/messages), control-room actions w timeline (kol recording fe sater wa7ed bel-moddah).
- Endpoint: `/api/report?date=YYYY-MM-DD&company=<id>` (el-company el-user mesh betetghayyar: bey-shoof bta3to bas).
- El-events (online/offline, recording, PTT, messages) betetsagal **men wa2t el-ta7deeth da** — el-ayyam abl keda feeha SOS + GPS + control-room actions bas.
- Arabic fe asma2 el-companies/cameras bet-etshal fel-PDF (el-font latin bas): esta5dem asma2 englizi.

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

---

## 9. Camera gedeeda (BWC gedeed men el-shirka) — step by step
1. Charge el-camera (el-battery el-wetia beteb2a 8-15% law sebta).
2. Ta2akkad en **USB debugging** shaghal 3ala el-camera (el-cameras elly shaghalnaha kolaha kanet shaghala; law camera gedeeda mesh bet-zhar fe `-List` yebqa el-setting dee heyya el-sabab).
3. `.\tools\update-cameras.ps1 -List` → e3mel serial.
4. `.\tools\update-cameras.ps1 -Provision -Serial <SERIAL> -Id BWC-xx-RIY`
5. Efta7 el-dashboard — el-camera betzhar online ba3d sawani. **Companies** page: e5tar el-company + el-region.
6. Ta2akkad: ▶ → el-live beyeshta8al.

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
- El-server **HTTP** (mesh HTTPS) 3ala el-shabaka el-dakhliya. Lel-internet el-mafto7: HTTPS + VPN.
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
