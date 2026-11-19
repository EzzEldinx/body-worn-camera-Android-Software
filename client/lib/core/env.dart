/// Build-time configuration:  flutter run --dart-define=VG_SERVER=https://visionguard.smartwaygroup.com.sa
/// Until the domain and TLS are live, test builds talk to the test server over plain HTTP.
const String kDefaultServer = String.fromEnvironment('VG_SERVER', defaultValue: 'https://visionguard.smartwaygroup.com.sa');
const String kAppVersionFallback = '1.0.0';

/// Map pictures for the desktop apps (macOS / Windows / Linux), where the vector map of the phones is not available. The default is the public OpenStreetMap
/// server, fine for a few people (see https://operations.osmfoundation.org/policies/tiles). For many users build with  --dart-define=VG_MAP_TILES=https://your-tile-server/{z}/{x}/{y}.png
const String kDesktopMapTiles = String.fromEnvironment('VG_MAP_TILES', defaultValue: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
