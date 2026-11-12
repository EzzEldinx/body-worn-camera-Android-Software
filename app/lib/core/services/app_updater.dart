import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';

import 'central_link.dart';

/// Remote updates: the control room sends 'update_app'; this downloads the APK from the server, checks its
/// SHA-256 and hands it to Android's PackageInstaller. Progress is reported back so the dashboard can show it.
class AppUpdater {
  AppUpdater({required this.link, required this.isRecording});

  static const MethodChannel _ch = MethodChannel('com.swg.bwc/update');

  final CentralLink link;
  final bool Function() isRecording;

  Map<String, dynamic>? _pending;
  bool _busy = false;
  Timer? _wait;
  StreamSubscription<Map<String, dynamic>>? _sub;

  /// SHA-256 of the installed APK (the "build id"), or null if it cannot be read.
  static Future<String?> readBuild() async {
    try {
      return await _ch.invokeMethod<String>('getAppBuild');
    } catch (e) {
      debugPrint('build id unavailable: $e');
      return null;
    }
  }

  void start() {
    _ch.setMethodCallHandler((call) async {
      if (call.method == 'installResult') {
        final m = Map<String, dynamic>.from(call.arguments as Map);
        final status = m['status'] as String? ?? 'failed';
        if (status == 'failed') link.sendUpdate('failed', error: m['message'] as String? ?? 'install failed');
        if (status == 'pending_user') link.sendUpdate('installing', error: 'tap Install on the camera');
        // success: the system restarts the app and the new build reports itself as "up to date"
      }
    });
    _sub = link.updateCommands.listen((cmd) {
      _pending = cmd;
      _tryRun();
    });
  }

  void dispose() {
    _sub?.cancel();
    _wait?.cancel();
  }

  void _tryRun() {
    final cmd = _pending;
    if (cmd == null || _busy) return;
    if (isRecording() && cmd['force'] != true) {
      link.sendUpdate('waiting'); // never cut an officer's recording for an update
      _wait ??= Timer.periodic(const Duration(seconds: 5), (_) => _tryRun());
      return;
    }
    _wait?.cancel();
    _wait = null;
    _pending = null;
    _run(cmd);
  }

  Future<void> _run(Map<String, dynamic> cmd) async {
    _busy = true;
    try {
      final expected = (cmd['build'] as String?) ?? '';
      final dir = await getTemporaryDirectory();
      final file = File('${dir.path}/update.apk');
      if (await file.exists()) await file.delete();

      link.sendUpdate('downloading', pct: 0);
      final client = HttpClient()..connectionTimeout = const Duration(seconds: 15);
      final req = await client.getUrl(Uri.parse('${CentralConfig.serverUrl}/api/update/apk'));
      req.headers.set('x-bwc-token', CentralConfig.token);
      final res = await req.close();
      if (res.statusCode != 200) throw 'download failed (HTTP ${res.statusCode})';
      final total = res.contentLength > 0 ? res.contentLength : (cmd['size'] as num?)?.toInt() ?? 0;
      var got = 0;
      var lastPct = -1;
      final sink = file.openWrite();
      await for (final chunk in res) {
        sink.add(chunk);
        got += chunk.length;
        final pct = total > 0 ? (got * 100 ~/ total) : 0;
        if (pct >= lastPct + 5) {
          lastPct = pct;
          link.sendUpdate('downloading', pct: pct);
        }
      }
      await sink.close();
      client.close();

      // hashed natively: the pure-Dart hash took ~30 s for a 53 MB file
      final digest = await _ch.invokeMethod<String>('sha256', {'path': file.path});
      if (expected.isNotEmpty && digest != expected) throw 'download is corrupt (checksum differs)';

      link.sendUpdate('installing');
      await _ch.invokeMethod('installApk', {'path': file.path});
    } catch (e) {
      debugPrint('update failed: $e');
      link.sendUpdate('failed', error: '$e');
    } finally {
      _busy = false;
    }
  }
}
