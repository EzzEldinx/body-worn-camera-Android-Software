# Putting the VisionGuard owner app in the stores

**Status (2026-11-18): the owner app is not in any store yet.** It runs on a registered iPad from a development build (the iOS development profile includes only that iPad and expires 2027-11-08). This guide is for when the store accounts are ready.

The owner/supervisor app (`client/`) is for Google Play and the App Store. The **camera app (`app/`) is not**: it runs as the device owner on the company's cameras and updates itself from the server and the docking stations.

Recommended: distribute **privately** (Apple *Custom App* through Apple Business Manager, Google Play *closed testing* or a managed private app). Review is lighter and it stays under your control.

## What is already prepared
* Plain HTTP is off. Android and iOS refuse it unless a *test* build asks for it (see "Test builds").
* Android is signed with an upload key when `android/key.properties` exists. A store bundle (`.aab`) cannot be built without it.
* `ios/Runner/PrivacyInfo.xcprivacy` (Apple's privacy manifest) is part of the project.
* The privacy policy page (English and Arabic) is `https://<your server>/privacy.html` (public, no sign-in). Use that address in both stores. Have it checked by your legal adviser.
* `client/tool/release_guard.sh https://<your server>` checks all of this and fails if something is wrong.

## What only you can provide
| | |
|---|---|
| **HTTPS address** | done: `https://visionguard.smartwaygroup.com.sa` (the stores refuse plain HTTP). See `DEPLOYMENT.md` |
| **Apple** | an Apple Developer account, an App Store Connect record for bundle id `sa.com.smartwaygroup.visionguard`, a distribution certificate (Xcode: Runner > Signing, your team) |
| **Google** | the Play Console app with the same application id, *Play App Signing* on |
| **Push (optional)** | a Firebase project: `google-services.json` in `android/app/`, `GoogleService-Info.plist` in `ios/Runner/`, and an APNs key uploaded to Firebase |
| **Listing** | name, descriptions (English and Arabic), icon 1024 px, screenshots (phone and tablet), support email |
| **For the reviewers** | a demo account (a company user with a few cameras) and a line saying that accounts are created by a company administrator, not in the app |

## Android: the upload key (once)
```bash
cd client/android
keytool -genkeypair -v -storetype JKS -keystore ~/.visionguard/visionguard-owner-upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000
```
Keep the `.jks` file and its passwords in **two safe places** (losing it means asking Google to reset the key). Then create `android/key.properties` (it is never committed):
```
storeFile=/Users/<you>/.visionguard/visionguard-owner-upload.jks
storePassword=...
keyAlias=upload
keyPassword=...
```

## Build for the stores
```bash
cd client
tool/release_guard.sh https://your-domain          # must say: release guard: OK
flutter build appbundle --release --dart-define=VG_SERVER=https://your-domain    # Android -> build/app/outputs/bundle/release/app-release.aab
flutter build ipa --release --dart-define=VG_SERVER=https://your-domain          # iOS -> build/ios/ipa/*.ipa, upload with Xcode Organizer or Transporter
```
Raise the number after `+` in `pubspec.yaml` (`version: 1.0.1+2`) for every upload.

## Test builds (plain HTTP to a test server)
```bash
ORG_GRADLE_PROJECT_allowHttp=true flutter build apk --release --target-platform android-arm64 --dart-define=VG_SERVER=http://<test-server>:3000
tool/ios-allow-http.sh on      # iOS test build; run `tool/ios-allow-http.sh off` afterwards
```
Never upload these. The release guard fails while the iOS exception is on.

## Store answers (to review before submitting)
* **Data collected** (Apple privacy label / Google Data safety): name and user id of the signed-in person, linked to the person, used only for the app's functions; no tracking, no ads, no third-party sharing. Camera data shown in the app belongs to the person's company.
* **Permissions:** Android asks for internet and biometrics only; iOS for Face ID (unlock).
* **Content rating:** no violent, sexual or user-generated social content; business tool.
* **Encryption:** the app uses standard HTTPS only (answer "standard encryption, exempt" on Apple's export question).
