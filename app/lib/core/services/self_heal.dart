import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';

/// The native camera plugin can lose its method channel while the preview keeps running; every recording or live
/// command then fails with MissingPluginException until the process restarts. This restarts the app by itself
/// (the kiosk Home app is relaunched by Android), at most 3 times in 10 minutes so a real fault cannot loop.
class SelfHeal {
  static bool isPluginLost(Object e) => e is MissingPluginException || '$e'.contains('MissingPluginException');

  static const _max = 3;
  static const _window = Duration(minutes: 10);

  static Future<File> _file() async => File('${(await getApplicationSupportDirectory()).path}/self_heal.json');

  /// Pure rule: may we restart again, given the restarts so far?
  @visibleForTesting
  static bool mayRestart(List<int> restartsMs, int nowMs) => restartsMs.where((t) => nowMs - t < _window.inMilliseconds).length < _max;

  /// Returns true when it restarted the app (the call does not return in that case).
  static Future<bool> restartIfPluginLost(Object error, {required String where, void Function(String)? report}) async {
    if (!isPluginLost(error)) return false;
    return restartNow(where: where, report: report);
  }

  /// Restarts the app unless it already did 3 times in 10 minutes (a real fault must not loop). Used when the camera stalls again and again.
  static Future<bool> restartNow({required String where, void Function(String)? report}) async {
    final now = DateTime.now().millisecondsSinceEpoch;
    List<int> times = [];
    try {
      final f = await _file();
      if (await f.exists()) times = (jsonDecode(await f.readAsString()) as List).map((e) => (e as num).toInt()).toList();
    } catch (_) {}
    if (!mayRestart(times, now)) {
      report?.call('Camera problem ($where) and the restart limit is reached');
      return false;
    }
    report?.call('Camera problem ($where): restarting the app');
    try {
      final recent = times.where((t) => now - t < _window.inMilliseconds).toList()..add(now);
      await (await _file()).writeAsString(jsonEncode(recent));
    } catch (_) {}
    await Future<void>.delayed(const Duration(milliseconds: 900)); // let the toast and the status update go out
    exit(1);
  }
}
