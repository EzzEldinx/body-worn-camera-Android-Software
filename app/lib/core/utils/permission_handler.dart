/// Runtime permission orchestration (camera, mic, location) — Phase 2+.
class PermissionHandler {
  const PermissionHandler();

  Future<bool> ensureRecordingPermissions() async {
    // Implemented with the camera module. Kiosk UI must not depend on this.
    return false;
  }
}
