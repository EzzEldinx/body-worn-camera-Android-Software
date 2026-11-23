# Camera app signing and migration

Last updated: 2026-11-18 (reviewed 2026-11-23: still current)

The camera app (`com.swg.swg_bwc`) is the **device owner** and Home app of each body camera. Android only accepts an update
signed with the **same key** as the installed app, and a device owner cannot be uninstalled. So the signing key is the
most important secret of the camera fleet: **if it is lost, no camera can ever be updated without re-provisioning it.**

## The release key
* File: `~/.visionguard/camera-release.jks` on the build Mac (outside the repository, git-ignored). Alias `visionguard-camera`.
* Password: macOS Keychain item `visionguard-camera-keystore` (also in `app/android/key.properties`, git-ignored).
* **Back it up now** into the company vault (the .jks file AND the password). Without a copy, a lost Mac means a lost fleet.
* Build: `cd app/android && JAVA_HOME=<JDK 17 or 21> ./gradlew assembleRelease` signs with it when `key.properties` exists (tested with JDK 17; `flutter build` itself may pick a newer Java and fail, so use gradle directly). Publish the APK with `tools/publish-build.sh https://visionguard.smartwaygroup.com.sa`.
  Certificate SHA-256: `c6c2776a8e5e3430c10428a636edbfef6eed4668d05d07ceac067f482e7161fb`.

## Cameras installed with the old (debug) key
These cannot be updated. All current cameras already run the release-signed app; keep this procedure for any camera still found on the old key. Migration on a `userdebug` camera (USB, `adb root`), one camera at a time:
1. Stop any recording/live on the camera. Back up `/sdcard/Android/data/com.swg.swg_bwc/files` (`adb pull`) and verify SHA-256.
2. `adb root`, back up `/data/system/device_owner_2.xml` and `device_policies.xml`.
3. `stop`; delete `device_owner_2.xml`; replace `device_policies.xml` with an empty `<policies setup-complete="true" provisioning-state="0"/>`; `start`.
4. `pm uninstall com.swg.swg_bwc`; `adb install -g app-release.apk`.
5. `dpm set-device-owner com.swg.swg_bwc/.BwcAdminReceiver`.
6. Start `com.swg.swg_bwc/.MainActivity` once (it enables its Home entry), `cmd package set-home-activity com.swg.swg_bwc/.HomeAlias`.
7. Push the saved `config.json` to `/sdcard/Android/data/com.swg.swg_bwc/files/`, then `am crash com.swg.swg_bwc` and confirm it relaunches by itself.

New cameras: provision with the release APK from the start (`tools/provision-camera.sh` or `tools/provision-batch.sh` on a Mac, `tools/update-cameras.ps1 -Provision` on Windows; see GUIDE section 9); they are then updatable over the air.
