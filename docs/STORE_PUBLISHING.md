# Putting the VisionGuard owner app in the stores

Last updated: 2026-11-23

## Status (2026-11-23)
Version **1.1.0 (3)** is uploaded to both stores **for testing only**. Nothing is public: the public release waits for the company's approval.

| | Done | Still to do |
|---|---|---|
| **Google Play** (Smart Way's organisation account) | App `sa.com.smartwaygroup.visionguard` created, Play App Signing on (Google keeps the app signing key, our upload key is accepted), bundle 1.1.0 (3) rolled out to **internal testing** with a testers list | Store listing and the *App content* forms (privacy policy, app access with the demo account, ads, content rating, target audience, data safety). Then a production release when approved |
| **Apple** (team `PJX4KFYXFK`) | App Store Connect record, build 1.1.0 (3) uploaded from Xcode (Organizer > Distribute App), TestFlight **internal testing** works on an iPhone; an **external group** was sent to Beta App Review so it can get a public link | Turn on the public link after the review. The App Store page: version 1.1.0, screenshots, texts, App Privacy, age rating, the demo account in App Review Information. Do **not** press *Add for Review* before approval |
| **Both** | Listing text, screenshots, icon, privacy page, release guard | A demo account (demo company with a few cameras) on the production server for the reviewers; Firebase for push (optional) |

Testers: Google needs Google (Gmail) accounts in the testers list; a company e-mail that is not a Google account is refused. Apple's public TestFlight link works for anyone with an iPhone, and the app still needs a VisionGuard account to sign in.

## Steps (for reference)
1. **Accounts:** Smart Way's Apple Developer Program and Google Play Console accounts.
2. **Google:** create the app `sa.com.smartwaygroup.visionguard`, turn on *Play App Signing*, upload `client/build/app/outputs/bundle/release/app-release.aab` (rebuild with the command below first), paste the listing from `STORE_LISTING.md`, the images from `client/store/`, the Data safety answers below; internal or closed testing first.
3. **Apple:** in App Store Connect create the app with bundle id `sa.com.smartwaygroup.visionguard`; in Xcode pick the team for Runner > Signing; archive and upload (Xcode Organizer, or `flutter build ipa --release` and Transporter); paste the listing, the screenshots and the App Privacy answers below; choose *Custom App* (private) or public.
4. **Both:** create the demo account for the reviewers on the production server and put it in the review notes. Type its password only into the store forms, never into documents or chat.

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
Raise the number after `+` in `pubspec.yaml` (now `version: 1.1.0+3`) for every upload.

The upload key was made with `client/tool/make-upload-key.sh` (it asks for the password in the terminal and writes `android/key.properties`). Back up `~/.visionguard/visionguard-owner-upload.jks` and its password in two safe places.

## Test builds (plain HTTP to a test server)
```bash
ORG_GRADLE_PROJECT_allowHttp=true flutter build apk --release --target-platform android-arm64 --dart-define=VG_SERVER=http://<test-server>:3000
tool/ios-allow-http.sh on      # iOS test build; run `tool/ios-allow-http.sh off` afterwards
```
Never upload these. The release guard fails while the iOS exception is on.

## Store answers (to review before submitting)
* **Data collected** (Apple privacy label / Google Data safety), all linked to the person, used only for the app's functions, not used for tracking, not shared with third parties, sent over HTTPS, stored on the company's VisionGuard server:
  * Name and user id of the signed-in person (*Contact info: Name* / *Identifiers: User ID*).
  * **Audio:** voice notes the user records for an officer (*Audio data: Voice or sound recordings*). Only while the user holds the record button.
  * **User content:** chat messages and support tickets (*Other user content* / *Messages: Other in-app messages*).
  * Camera data shown in the app belongs to the person's company and is not collected from the phone.
* **Permissions:** Android: internet, biometrics, microphone (voice notes). iOS: Face ID (unlock), microphone (voice notes). The app never uses the phone's location, contacts or photos.
* **Content rating:** no violent, sexual or user-generated social content; business tool.
* **Encryption:** the app uses standard HTTPS only (answer "standard encryption, exempt" on Apple's export question).
