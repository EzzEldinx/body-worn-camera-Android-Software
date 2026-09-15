import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../../hardware/kiosk_channel.dart';

final kioskChannelProvider = Provider<KioskChannel>((ref) {
  return KioskChannel();
});

/// `true` while lock-task / immersive kiosk is armed on the device.
final kioskControllerProvider =
    NotifierProvider<KioskController, bool>(KioskController.new);

class KioskController extends Notifier<bool> {
  @override
  bool build() => true;

  Future<void> arm() async {
    await ref.read(kioskChannelProvider).enable();
    state = true;
  }

  /// Leaves lock-task so the operator can return to a normal launcher.
  Future<void> disarm() async {
    await ref.read(kioskChannelProvider).disable();
    state = false;
  }
}
