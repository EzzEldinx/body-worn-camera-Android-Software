import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';
import 'package:rtmp_broadcaster/rtmp_broadcaster.dart' show ResolutionPreset;

/// Capture/stream quality. The control room can change it live (weak network = lower quality).
/// The camera supports 720p / 1080p / 4K at 30 fps; the lower steps save bandwidth.
enum VideoQuality {
  p240('240p', ResolutionPreset.low, 400 * 1024),
  p480('480p', ResolutionPreset.medium, 1000 * 1024),
  p720('720p', ResolutionPreset.high, 2500 * 1024),
  p1080('1080p', ResolutionPreset.veryHigh, 5000 * 1024),
  p2160('4k', ResolutionPreset.ultraHigh, 12000 * 1024);

  const VideoQuality(this.id, this.preset, this.bitrate);

  final String id; // value used on the wire and in the dashboard
  final ResolutionPreset preset;
  final int bitrate; // bits per second for the RTMP stream / recording

  static const VideoQuality defaultQuality = VideoQuality.p1080;

  static VideoQuality? fromId(Object? id) {
    for (final q in values) {
      if (q.id == id) return q;
    }
    return null;
  }

  static Future<File> _file() async =>
      File('${(await getApplicationSupportDirectory()).path}/quality.json');

  static Future<VideoQuality> load() async {
    try {
      final f = await _file();
      if (await f.exists()) {
        return fromId((jsonDecode(await f.readAsString()) as Map)['quality']) ?? defaultQuality;
      }
    } catch (_) {}
    return defaultQuality;
  }

  Future<void> save() async {
    try {
      await (await _file()).writeAsString(jsonEncode({'quality': id}));
    } catch (_) {}
  }
}
