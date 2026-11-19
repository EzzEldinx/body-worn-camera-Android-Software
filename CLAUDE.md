# VisionGuard (Smart Way body-worn cameras)

Cameras (SDJW-S1, Android 10, kiosk app) -> server (Node) -> dashboard (web) and owner app (Flutter: iPhone, iPad, Android, Mac). Docking stations copy recordings off the cameras (Dock Agent on a Mac). Docs start at `docs/README.md`.

## Layout
- `server/` Node 22, Express 5, node:sqlite, socket.io, node-media-server. Web dashboard in `server/public/` (plain HTML/JS, texts in `server/public/i18n/`, English + Arabic). Tests: `cd server && npm test`.
- `app/` the CAMERA app (Flutter, package `swg_bwc`, device owner, kiosk). Native Kotlin in `app/android/app/src/main/kotlin/com/swg/swg_bwc/`. Camera plugin in `app/packages/rtmp_broadcaster/` (has its own AGENTS.md: commit only when asked, no AI mentions there).
- `client/` the OWNER/supervisor app (Flutter: iOS, Android, macOS). Texts in `client/lib/core/l10n/strings.dart` (every text in English and Arabic; `flutter test` fails on a missing or hard-coded text).
- `dock-agent/` Node agent on the Mac that reads USB cameras. `transcriber/` Whisper sidecar for live captions. `deploy/` Docker compose files.

## Rules
- After EVERY commit push the branch to BOTH remotes: `git push org <branch>` (private org repo) then `git push origin <branch>` (PUBLIC repo). The public repo means: never commit server IPs, passwords, tokens, keystores, customer data, `cameras.json`, databases or build output.
- Conventional commits (`feat:`, `fix:`, `docs:`...). Commit only when asked. Documentation changes go in the same commit as the code.
- The user writes Franco-Arabic (Egyptian): answer in Arabic script, technical terms in English.
- Never type or repeat passwords, passphrases or API keys: give the command and let the user type secrets in the terminal. If the user pastes one into the chat, tell them to change it.
- Do not log into the real server with the user's account. Test against a local server: `PORT=3999 DATA_DIR=<tmp dir> ADMIN_PASSWORD=<test> BWC_TOKEN=camtoken RTMP_PORT=1939 FLV_PORT=8939 node server.js` with pretend cameras (a socket.io script that emits `camera_status` and `camera_gps_update`). Kill test processes by PID or name, never by port (`lsof -ti :PORT` also kills the app being tested).
- Waiting for a build: do not trust an old log file that already contains "done". Compare the installed APK's md5 with the built one (`adb pull` the installed `base.apk`).

## Commands
- Server tests: `cd server && npm test`. Client: `cd client && flutter analyze lib && flutter test`. Camera app: `cd app && flutter test`.
- Run the owner app on the Mac: `cd client && flutter run -d macos --dart-define=VG_SERVER=http://127.0.0.1:3999` (HTTPS domain is the default). A rebuilt debug build asks for keychain access once: `security delete-generic-password -s flutter_secure_storage_service` before relaunching.
- Owner app builds: `flutter build apk --release` (Android), `flutter run -d <ipad id> --release` (iPad, team PJX4KFYXFK), `flutter build macos`.
- Camera app build: `cd app/android && JAVA_HOME=/opt/homebrew/Cellar/openjdk@17/17.0.18/libexec/openjdk.jdk/Contents/Home ./gradlew assembleRelease`, then the user publishes it: `tools/publish-build.sh https://<server domain>` (asks for the admin login). The Dock Agent then installs it on docked cameras.
- Testing a camera build over USB: `kill -STOP <dock agent pid>` first (it reinstalls the published build), `kill -CONT` after. adb is at `~/Library/Android/sdk/platform-tools/adb`. Serials map: `...192`=BWC-01, `...135`=02, `...240`=03, `...221`=04, `...212`=05, `...468`=06. The Android tablet (Huawei, serial `5DJBB25A16200293`) runs the owner app, package `sa.com.smartwaygroup.visionguard`.
- Server deploy (the user types the passphrase and sudo password): `git archive --format=tar.gz -o /tmp/vg-deploy.tgz HEAD server deploy transcriber`, `scp` it to the server, then `sudo tar -xzf ... -C /opt/visionguard && cd /opt/visionguard/deploy && sudo docker compose -p visionguard -f docker-compose.yml -f docker-compose.test.yml -f docker-compose.transcribe.yml up -d --build`. See `docs/DEPLOYMENT.md`.

## Things learned the hard way
- Camera GPS indoors lies (accuracy 1-10 m with 3-4 weak satellites): positions are filtered in `app/lib/core/services/gps_filter.dart`. Details in `docs/CAMERA_APP.md` and the project memory.
- Camera opens 16:9 only at 1920x1080 and 1280x720; 480p is sent at 1280x720.
- The camera's logcat is flooded by microphone errors: `grep -vE "read error|Error -38"`.
- macOS: `maplibre_gl` has no desktop build; the Mac app uses `flutter_map` (`client/lib/features/map/desktop_map.dart`).
