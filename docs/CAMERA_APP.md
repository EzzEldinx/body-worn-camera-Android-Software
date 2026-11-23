# Camera app (`app/`)

Last updated: 2026-11-23

Flutter app for the body-worn camera (model SDJW-S1, Android 10), package `com.swg.swg_bwc`, shown as **VisionGuard**. It is the camera's **device owner** and **Home app**: it starts by itself, updates itself and cannot be uninstalled by the wearer.

Using the camera in the field and the screen layout: `GUIDE.md` section 7. Provisioning a camera: `GUIDE.md` sections 8 and 9. Signing: `CAMERA_SIGNING.md`. Employee stamp: `CHECKOUT.md` section 5.

## Configuration
One APK serves every camera. Per camera, a `config.json` in the app's files folder (`/sdcard/Android/data/com.swg.swg_bwc/files/config.json`) holds:
```json
{"id": "BWC-05-RIY", "server": "https://visionguard.smartwaygroup.com.sa", "token": "<the camera's own token>"}
```
The provisioning tools write it (`tools/provision-camera.sh`, `tools/provision-batch.sh`, `tools/update-cameras.ps1`). Build-time defaults exist (`--dart-define=BWC_SERVER`, `BWC_ID`, `BWC_TOKEN`); the file overrides them. A camera still set to `http://<ip>:3000` moves itself to the HTTPS domain at start-up when the domain answers `/healthz`.

Capabilities the camera announces to the server: `update-net` (network updates) and `remote-stop` (the control room may stop its recording).

## Live stream key
After the camera signs in, the server sends it its own publish key over the socket (`push_key`). The camera keeps it with its configuration and adds `?key=<key>` to its RTMP address. When the server runs the RTMPS front door it also sends `rtmpsPort`; the camera then pushes encrypted to `rtmps://<domain>:<port>/live/<id>?key=...` (only when its server address is the HTTPS domain, because the certificate is for it), and remembers the port in `config.json`. Production refuses a push without it (`RTMP_PUBLISH_AUTH=on`, `DEPLOYMENT.md` section 3.0), so a camera on a build older than this, or a freshly flashed one, cannot stream until it has the current build.

## GPS: which positions are believed
The camera's GPS lies indoors: it reports "accuracy 1-10 m" with only 3-4 weak satellites, impossible altitudes, and positions that wander hundreds of metres. `lib/core/services/gps_filter.dart` therefore accepts a fix only when:
* its accuracy is within 30 m and its vertical accuracy within 75 m;
* at least 4 satellites were used with a mean signal of at least 20 dB-Hz (read natively by `GnssQuality.kt`);
* it is not an impossible jump (over 250 km/h) or altitude from a cold chip.

A camera that lies still (accelerometer) keeps its place: small wander is ignored, and only 6 good fixes in a row far away move it. The server applies the same idea again: a report with fewer than 4 satellites or a mean signal under 18 dB-Hz updates the camera's status but not its position. The camera logs `GPS:` and `GPS-sky:` lines (read them over adb: `adb logcat | grep -E "GPS:|GPS-sky:"`). Positions are sent about every second while the fix is good. Tests: `app/test/gps_filter_test.dart`.

## Run on a connected device (development)
```bash
cd app
flutter pub get
flutter run -d <adb-serial> --dart-define=BWC_SERVER=https://visionguard.smartwaygroup.com.sa \
            --dart-define=BWC_ID=BWC-01 --dart-define=BWC_TOKEN=<token>
```
On a Mac without the Android Studio defaults, use `--android-skip-build-dependency-validation` if Flutter complains about build dependencies. A camera that is already the device owner can only be updated with an APK signed by the release key (`CAMERA_SIGNING.md`), so development runs are for test devices.

## Release build and publish
```bash
cd app/android
JAVA_HOME=<JDK 17 or 21> ./gradlew assembleRelease           # signs with the release key when key.properties exists
cd ../.. && tools/publish-build.sh https://visionguard.smartwaygroup.com.sa   # asks for an admin login
```
Cameras then take the build from the docking station or over the network (`GUIDE.md` sections 8.3 and 8.4). Bump the version only if you need to tell builds apart by number; the server identifies a build by its SHA-256.

## Tests
```bash
cd app && flutter test
```
