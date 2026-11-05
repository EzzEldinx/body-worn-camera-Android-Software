import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../../hardware/kiosk_channel.dart';

final kioskChannelProvider = Provider<KioskChannel>((ref) {
  return KioskChannel();
});

/// `true` only after lock-task / immersive kiosk was armed successfully.
final kioskControllerProvider =
    NotifierProvider<KioskController, bool>(KioskController.new);

class KioskController extends Notifier<bool> {
  @override
  bool build() => false; // not armed until the native call succeeds

  Future<void> arm() async {
    try {
      await ref.read(kioskChannelProvider).enable();
      state = true;
    } catch (e) {
      debugPrint('Kiosk arm failed: $e');
      state = false;
    }
  }

  /// Leaves lock-task so the operator can return to a normal launcher.
  Future<void> disarm() async {
    await ref.read(kioskChannelProvider).disable();
    state = false;
  }
}
