/// Tunable kiosk and device constants. No UI widgets should hardcode these.
class AppConstants {
  AppConstants._();

  /// MethodChannel used by Dart to arm / disarm Android lock-task + immersive UI.
  static const String kioskChannelName = 'com.swg.bwc/kiosk';

  /// EventChannel that streams raw hardware key events from MainActivity.
  static const String hardwareKeyChannelName = 'com.swg.bwc/hardware_keys';

  /// Hidden Admin Door: consecutive taps required on the branded logo/name.
  static const int adminTapCount = 7;

  /// Window in which all admin taps must occur before the counter resets.
  static const Duration adminTapWindow = Duration(seconds: 3);

  /// Default factory PIN. Rotate this on first deploy via MDM / device owner.
  static const String defaultAdminPin = '1234';

  /// Maximum PIN length shown in the dialog.
  static const int adminPinMaxLength = 8;

  static const String evidenceDirectoryName = 'bwc_evidence';
}
