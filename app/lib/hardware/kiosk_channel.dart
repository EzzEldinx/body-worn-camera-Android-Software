import 'package:flutter/services.dart';

import '../core/constants/app_constants.dart';

/// Thin Dart facade over Android kiosk APIs.
///
/// Flutter cannot consume the system Home key. [enable] asks MainActivity to
/// enter lock-task + immersive sticky; [disable] reverses that before exit.
class KioskChannel {
  KioskChannel({MethodChannel? channel})
      : _channel = channel ??
            const MethodChannel(AppConstants.kioskChannelName);

  final MethodChannel _channel;

  Future<void> enable() async {
    await _channel.invokeMethod<void>('enableKiosk');
  }

  Future<void> disable() async {
    await _channel.invokeMethod<void>('disableKiosk');
  }
}
