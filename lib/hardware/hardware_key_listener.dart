import 'package:flutter/services.dart';

import '../core/constants/app_constants.dart';

/// One hardware key event forwarded from MainActivity.dispatchKeyEvent.
class HardwareKeyEvent {
  const HardwareKeyEvent({
    required this.keyCode,
    required this.scanCode,
    required this.action,
    required this.repeatCount,
  });

  factory HardwareKeyEvent.fromMap(Map<dynamic, dynamic> map) {
    return HardwareKeyEvent(
      keyCode: map['keyCode'] as int? ?? -1,
      scanCode: map['scanCode'] as int? ?? -1,
      action: map['action'] as int? ?? -1,
      repeatCount: map['repeatCount'] as int? ?? 0,
    );
  }

  /// Android KeyEvent keyCode (e.g. KEYCODE_CAMERA = 27).
  final int keyCode;

  /// Raw scan code from getevent (0x12d / 0x12e live on SWG-BWC-04).
  final int scanCode;

  /// 0 = down, 1 = up (android.view.KeyEvent).
  final int action;

  final int repeatCount;

  bool get isDown => action == 0;
}

/// Streams KEY_CAMERA / KEY_MUTE / OEM scan codes. Bound in the camera phase.
class HardwareKeyListener {
  HardwareKeyListener({EventChannel? channel})
      : _channel = channel ??
            const EventChannel(AppConstants.hardwareKeyChannelName);

  final EventChannel _channel;

  Stream<HardwareKeyEvent> get events =>
      _channel.receiveBroadcastStream().map((dynamic event) {
        return HardwareKeyEvent.fromMap(event as Map<dynamic, dynamic>);
      });
}
