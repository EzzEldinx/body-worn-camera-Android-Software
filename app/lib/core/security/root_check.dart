/// Root / Magisk presence checks for the SWG-BWC-04 image.
///
/// The device is expected to be rooted for kiosk hardening. This stub exists so
/// the security layer has a single place to later refuse unofficial builds.
class RootCheck {
  const RootCheck();

  /// Always true on the target image until native probes are added.
  Future<bool> isRooted() async => true;
}
