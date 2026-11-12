import 'dart:async';
import 'dart:io';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';

import 'central_link.dart';
import 'resumable_download.dart';

/// Why an update does not start yet.
enum UpdateWait { none, recording, wifi, battery }

/// Remote updates: the control room sends 'update_app'; this downloads the APK from the server (going on where an interrupted download stopped),
/// checks its SHA-256 and hands it to Android's PackageInstaller. Progress is reported back so the dashboard can show it.
///
/// An order from the server's automatic updates (`auto`) is careful: it never cuts a recording, never uses mobile data when it was told Wi-Fi only
/// (`net: 'wifi'`, also not when the Wi-Fi goes away halfway: what was received is kept and the download goes on when Wi-Fi is back), and waits for
/// the battery. An order given by hand from the Updates page (no `auto`) goes over whatever network there is; `force` also ignores a recording.
class AppUpdater {
  AppUpdater({required this.link, required this.isRecording, Future<bool> Function()? onWifi}) : _onWifi = onWifi ?? _wifiNow;

  static const MethodChannel _ch = MethodChannel('com.swg.bwc/update');

  /// An automatic update waits while the battery is below this and the camera is not charging.
  static const int minBattery = 20;

  final CentralLink link;
  final bool Function() isRecording;
  final Future<bool> Function() _onWifi;

  Map<String, dynamic>? _pending;
  bool _busy = false;
  String? _lastWait;
  Timer? _wait;
  StreamSubscription<Map<String, dynamic>>? _sub;

  static Future<bool> _wifiNow() async {
    try {
      final List<ConnectivityResult> r = await Connectivity().checkConnectivity();
      return r.contains(ConnectivityResult.wifi) || r.contains(ConnectivityResult.ethernet);
    } catch (_) {
      return false;
    }
  }

  /// Whether an update order may start right now, and if not what it waits for. Pure, so it can be tested.
  static UpdateWait gate({
    required Map<String, dynamic> cmd,
    required bool recording,
    required bool onWifi,
    required int? battery,
    required bool charging,
  }) {
    if (recording && cmd['force'] != true) return UpdateWait.recording; // never cut an officer's recording for an update
    if (cmd['auto'] == true) {
      if (cmd['net'] == 'wifi' && !onWifi) return UpdateWait.wifi; // told Wi-Fi only: never the SIM
      if (battery != null && battery < minBattery && !charging) return UpdateWait.battery;
    }
    return UpdateWait.none;
  }

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
      _lastWait = null;
      _tryRun();
    });
  }

  void dispose() {
    _sub?.cancel();
    _wait?.cancel();
  }

  Future<void> _tryRun() async {
    final Map<String, dynamic>? cmd = _pending;
    if (cmd == null || _busy) return;
    final ({int level, bool charging})? bat = link.battery.value;
    final UpdateWait wait = gate(
      cmd: cmd,
      recording: isRecording(),
      onWifi: cmd['net'] == 'wifi' ? await _onWifi() : true,
      battery: bat?.level,
      charging: bat?.charging ?? false,
    );
    if (!identical(_pending, cmd) || _busy) return; // an order came in (or one started) while the network was being asked
    if (wait != UpdateWait.none) {
      _announceWait(wait);
      _wait ??= Timer.periodic(const Duration(seconds: 10), (_) => _tryRun());
      return;
    }
    _wait?.cancel();
    _wait = null;
    _lastWait = null;
    _pending = null;
    _run(cmd);
  }

  void _announceWait(UpdateWait wait) {
    final String state = wait == UpdateWait.wifi
        ? 'waiting_wifi'
        : wait == UpdateWait.battery
            ? 'waiting_battery'
            : 'waiting';
    if (_lastWait == state) return; // say it once, not every ten seconds
    _lastWait = state;
    link.sendUpdate(state);
  }

  Future<void> _run(Map<String, dynamic> cmd) async {
    _busy = true;
    try {
      final String expected = (cmd['build'] as String?) ?? '';
      final Directory dir = await getTemporaryDirectory();
      final File part = File('${dir.path}/update-${expected.isEmpty ? 'latest' : expected.substring(0, 12)}.part');
      _forgetOldDownloads(dir, keep: part);

      link.sendUpdate('downloading', pct: 0);
      int lastPct = -5;
      final bool wifiOnly = cmd['auto'] == true && cmd['net'] == 'wifi';
      await downloadResumable(
        uri: Uri.parse('${CentralConfig.serverUrl}/api/update/apk'),
        part: part,
        headers: <String, String>{'x-bwc-token': CentralConfig.token},
        expectedSize: (cmd['size'] as num?)?.toInt(),
        onProgress: (got, total) {
          final int pct = total > 0 ? (got * 100 ~/ total) : 0;
          if (pct >= lastPct + 5) {
            lastPct = pct;
            link.sendUpdate('downloading', pct: pct);
          }
        },
        stillAllowed: wifiOnly ? _onWifi : null,
      );

      // hashed natively: the pure-Dart hash took ~30 s for a 53 MB file
      final String? digest = await _ch.invokeMethod<String>('sha256', <String, String>{'path': part.path});
      if (expected.isNotEmpty && digest != expected) {
        await part.delete(); // what we hold is damaged: the next try starts clean
        throw 'download is corrupt (checksum differs)';
      }
      final File apk = File('${dir.path}/update.apk');
      if (await apk.exists()) await apk.delete();
      final File ready = await part.rename(apk.path);

      link.sendUpdate('installing');
      await _ch.invokeMethod<void>('installApk', <String, String>{'path': ready.path});
    } on DownloadPaused {
      // the Wi-Fi went away: keep what arrived and go on when it is back
      _pending = cmd;
      _announceWait(UpdateWait.wifi);
      _wait ??= Timer.periodic(const Duration(seconds: 10), (_) => _tryRun());
    } catch (e) {
      debugPrint('update failed: $e');
      link.sendUpdate('failed', error: '$e');
    } finally {
      _busy = false;
    }
  }

  /// Half-finished downloads of an older build are of no use.
  void _forgetOldDownloads(Directory dir, {required File keep}) {
    try {
      for (final FileSystemEntity f in dir.listSync()) {
        if (f is File && f.path != keep.path && RegExp(r'/update-[^/]*\.part$').hasMatch(f.path)) f.deleteSync();
      }
    } catch (_) {/* nothing to tidy */}
  }
}
