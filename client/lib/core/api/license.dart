import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../features/auth/auth_controller.dart';
import 'models.dart';

/// The licence notice of this server (null when the server needs no licence, or when it cannot be read). Refreshed by the app shell.
final licenseProvider = FutureProvider<LicenseInfo?>((ref) async {
  final session = ref.watch(sessionProvider);
  if (session == null) return null;
  try { return await session.api.licenseStatus(); } catch (_) { return null; } // an older server has no licence endpoint: no notice
});
