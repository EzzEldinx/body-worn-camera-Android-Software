import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';

/// Which kind of window the docking station wants on this camera's screen. The words come from the station
/// (dock-agent/screen.js), so they can change without a new camera build; the camera only picks icon and colour from the phase.
enum DockPhase { connected, updating, uploading, done, attention }

@immutable
class DockScreen {
  const DockScreen({
    required this.phase,
    required this.title,
    required this.detail,
    this.current,
    this.total,
    this.percent,
  });

  final DockPhase phase;
  final String title;
  final String detail;

  /// "File 2 of 5": which file the station is copying now, and how many there are.
  final int? current;
  final int? total;

  /// 0-100, or null when the size is not known (the bar then just keeps running).
  final int? percent;

  /// Reads the file the Dock Agent wrote; null when it is not something this version understands.
  static DockScreen? tryParse(String source) {
    try {
      final Object? j = jsonDecode(source);
      if (j is! Map) return null;
      DockPhase? phase;
      for (final DockPhase p in DockPhase.values) {
        if (p.name == j['phase']) phase = p;
      }
      final Object? title = j['title'];
      if (phase == null || title is! String || title.isEmpty) return null;
      int? whole(Object? v) => v is num && v.isFinite ? v.toInt() : null;
      return DockScreen(
        phase: phase,
        title: title,
        detail: j['detail'] is String ? j['detail'] as String : '',
        current: whole(j['current']),
        total: whole(j['total']),
        percent: whole(j['percent'])?.clamp(0, 100),
      );
    } catch (_) {
      return null;
    }
  }

  @override
  bool operator ==(Object other) =>
      other is DockScreen &&
      other.phase == phase &&
      other.title == title &&
      other.detail == detail &&
      other.current == current &&
      other.total == total &&
      other.percent == percent;

  @override
  int get hashCode => Object.hash(phase, title, detail, current, total, percent);
}

/// Watches the file the Dock Agent writes into this app's folder while the camera sits on the docking station
/// and says what it contains. A file older than [maxAge] is ignored, so if the agent stops or the camera is
/// unplugged the window disappears by itself.
class DockSync {
  DockSync({
    Future<Directory?> Function()? folder,
    DateTime Function()? clock,
    this.pollEvery = const Duration(seconds: 1),
    this.maxAge = const Duration(seconds: 15),
  })  : _folder = folder ?? getExternalStorageDirectory,
        _clock = clock ?? DateTime.now;

  static const String fileName = 'dock-status.json';

  final Future<Directory?> Function() _folder;
  final DateTime Function() _clock;
  final Duration pollEvery;
  final Duration maxAge;

  /// What the station wants on the screen right now; null = nothing.
  final ValueNotifier<DockScreen?> screen = ValueNotifier<DockScreen?>(null);

  Timer? _timer;
  File? _file;
  DateTime? _readVersion; // modification time of the version that was read last
  DockScreen? _last;
  bool _busy = false;

  void start() {
    _timer?.cancel();
    _timer = Timer.periodic(pollEvery, (_) => check());
    check();
  }

  /// One look at the file (public so a test can drive it).
  Future<void> check() async {
    if (_busy) return;
    _busy = true;
    try {
      if (_file == null) {
        final Directory? dir = await _folder();
        if (dir == null) return;
        _file = File('${dir.path}/$fileName');
      }
      final File file = _file!;
      final FileStat stat = await file.stat();
      final bool gone = stat.type == FileSystemEntityType.notFound;
      if (gone || _clock().difference(stat.modified).abs() > maxAge) {
        _readVersion = null;
        _last = null;
        _show(null);
        return;
      }
      if (_readVersion != stat.modified) {
        // written since the last look: read it again
        _last = DockScreen.tryParse(await file.readAsString());
        _readVersion = stat.modified;
      }
      _show(_last);
    } catch (e) {
      debugPrint('dock status ignored: $e');
    } finally {
      _busy = false;
    }
  }

  void _show(DockScreen? next) {
    if (screen.value != next) screen.value = next;
  }

  void dispose() {
    _timer?.cancel();
    screen.dispose();
  }
}

final dockSyncProvider = Provider<DockSync>((ref) {
  final DockSync sync = DockSync()..start();
  ref.onDispose(sync.dispose);
  return sync;
});
