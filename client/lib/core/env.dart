/// Build-time configuration:  flutter run --dart-define=VG_SERVER=https://visionguard.smartwaygroup.com.sa
/// Until the domain and TLS are live, test builds talk to the test server over plain HTTP.
const String kDefaultServer = String.fromEnvironment('VG_SERVER', defaultValue: 'https://visionguard.smartwaygroup.com.sa');
const String kAppVersionFallback = '1.0.0';
