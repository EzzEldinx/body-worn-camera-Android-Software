# Camera app (`app/`)

Flutter app for the body-worn camera (model SDJW-S1, Android 10), package `com.swg.swg_bwc`, shown as **VisionGuard**. It is the camera's **device owner** and **Home app**: it starts by itself, updates itself and cannot be uninstalled by the wearer.

Using the camera in the field and the screen layout: `GUIDE.md` section 7. Provisioning a camera: `GUIDE.md` sections 8 and 9. Signing: `CAMERA_SIGNING.md`. Employee stamp: `CHECKOUT.md` section 5.

## Configuration
One APK serves every camera. Per camera, a `config.json` in the app's files folder (`/sdcard/Android/data/com.swg.swg_bwc/files/config.json`) holds:
```json
{"id": "BWC-05-RIY", "server": "https://visionguard.smartwaygroup.com.sa", "token": "<the camera's own token>"}
```
The provisioning tools write it (`tools/provision-camera.sh`, `tools/provision-batch.sh`, `tools/update-cameras.ps1`). Build-time defaults exist (`--dart-define=BWC_SERVER`, `BWC_ID`, `BWC_TOKEN`); the file overrides them. A camera still set to `http://<ip>:3000` moves itself to the HTTPS domain at start-up when the domain answers `/healthz`.

Capabilities the camera announces to the server: `update-net` (network updates) and `remote-stop` (the control room may stop its recording).

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
