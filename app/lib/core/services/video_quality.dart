import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';
import 'package:rtmp_broadcaster/rtmp_broadcaster.dart' show ResolutionPreset;

/// Capture/stream quality. The control room can change it live (weak network = lower quality).
/// The camera supports 720p / 1080p / 4K at 30 fps; the lower steps save bandwidth.
enum VideoQuality {
  p240('240p', ResolutionPreset.low, 400 * 1024),
  p480('480p', ResolutionPreset.medium, 1000 * 1024),
  p720('720p', ResolutionPreset.high, 2000 * 1024),   // ~0.9 GB per recorded hour
  p1080('1080p', ResolutionPreset.veryHigh, 3500 * 1024), // was 5 Mbps = 2.3 GB/h
  p2160('4k', ResolutionPreset.ultraHigh, 12000 * 1024);

  const VideoQuality(this.id, this.preset, this.bitrate);

  final String id; // value used on the wire and in the dashboard
  final ResolutionPreset preset;
  final int bitrate; // bits per second for the RTMP stream / recording

  static const VideoQuality defaultQuality = VideoQuality.p1080; // the best the camera offers reliably (4K failed in the field)

  /// The control room can pick only these; 240p and 4K are no longer offered (they caused failures, saved
  /// 'auto' means "decide from the network").
  static const String autoId = 'auto';
  static const List<VideoQuality> selectable = [p480, p720, p1080];

  /// Auto policy: Wi-Fi/ethernet carries 1080p, mobile data gets 720p. The recording on the camera itself is always made at this quality.
  static VideoQuality forNetwork({required bool fast}) => fast ? p1080 : p720;

  static VideoQuality? fromId(Object? id) {
    for (final q in values) {
      if (q.id == id) return q;
    }
    return null;
  }

  static Future<File> _file() async =>
      File('${(await getApplicationSupportDirectory()).path}/quality.json');

  /// What the control room last chose: a fixed quality or auto. Old files saved with 240p/4K fall back to 720p.
  static Future<({bool auto, VideoQuality fixed})> loadSetting() async {
    try {
      final f = await _file();
      if (await f.exists()) {
        final id = (jsonDecode(await f.readAsString()) as Map)['quality'];
        if (id == autoId) return (auto: true, fixed: defaultQuality);
        final q = fromId(id);
        if (q != null && selectable.contains(q)) return (auto: false, fixed: q);
      }
    } catch (_) {}
    return (auto: true, fixed: defaultQuality); // first start: automatic
  }

  static Future<void> saveSetting({required bool auto, required VideoQuality fixed}) async {
    try {
      await (await _file()).writeAsString(jsonEncode({'quality': auto ? autoId : fixed.id}));
    } catch (_) {}
  }

  Future<void> save() async {
    try {
      await (await _file()).writeAsString(jsonEncode({'quality': id}));
    } catch (_) {}
  }
}
