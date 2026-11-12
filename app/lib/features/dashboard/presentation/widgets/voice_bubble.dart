import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';

/// Play/pause + progress bar for a Base64 `data:audio/...` voice note.
class VoiceBubble extends StatefulWidget {
  const VoiceBubble({super.key, required this.dataUri, required this.color});

  final String dataUri;
  final Color color;

  @override
  State<VoiceBubble> createState() => _VoiceBubbleState();
}

class _VoiceBubbleState extends State<VoiceBubble> {
  static _VoiceBubbleState? _current; // only one note plays at a time

  final AudioPlayer _player = AudioPlayer();
  final List<StreamSubscription<dynamic>> _subs = [];
  Uint8List? _bytes;
  String _mime = 'audio/mp4';
  bool _playing = false;
  bool _failed = false;
  Duration _pos = Duration.zero;
  Duration _total = Duration.zero;

  @override
  void initState() {
    super.initState();
    _decode();
    _subs.addAll([
      _player.onPlayerStateChanged.listen((s) {
        if (mounted) setState(() => _playing = s == PlayerState.playing);
      }),
      _player.onPositionChanged.listen((p) {
        if (mounted) setState(() => _pos = p);
      }),
      _player.onDurationChanged.listen((d) {
        if (mounted) setState(() => _total = d);
      }),
      _player.onPlayerComplete.listen((_) {
        if (mounted) setState(() => _pos = Duration.zero);
      }),
    ]);
  }

  void _decode() {
    try {
      final comma = widget.dataUri.indexOf(',');
      final head = widget.dataUri.substring(0, comma);
      final m = RegExp(r'data:([^;,]+)').firstMatch(head)?.group(1);
      if (m != null) _mime = m == 'audio/m4a' ? 'audio/mp4' : m;
      _bytes = base64Decode(widget.dataUri.substring(comma + 1));
    } catch (_) {
      _failed = true;
    }
  }

  Future<void> _toggle() async {
    if (_failed || _bytes == null) return;
    try {
      if (_playing) {
        await _player.pause();
        return;
      }
      if (_current != this) await _current?._player.pause();
      _current = this;
      if (_player.state == PlayerState.paused) {
        await _player.resume();
      } else {
        await _player.play(BytesSource(_bytes!, mimeType: _mime));
      }
    } catch (e) {
      debugPrint('Voice playback error: $e');
      if (mounted) setState(() => _failed = true);
    }
  }

  String _fmt(Duration d) =>
      '${d.inMinutes}:${(d.inSeconds % 60).toString().padLeft(2, '0')}';

  @override
  void dispose() {
    if (_current == this) _current = null;
    for (final s in _subs) {
      s.cancel();
    }
    _player.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final progress = _total.inMilliseconds == 0
        ? 0.0
        : (_pos.inMilliseconds / _total.inMilliseconds).clamp(0.0, 1.0);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        GestureDetector(
          onTap: _toggle,
          child: Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(color: widget.color, shape: BoxShape.circle),
            child: Icon(
              _failed ? Icons.error_outline : (_playing ? Icons.pause : Icons.play_arrow),
              color: const Color(0xFF1A1405),
              size: 22,
            ),
          ),
        ),
        const SizedBox(width: 10),
        SizedBox(
          width: 110,
          child: ClipRRect(
            borderRadius: BorderRadius.circular(2),
            child: LinearProgressIndicator(
              value: progress,
              minHeight: 4,
              color: widget.color,
              backgroundColor: Colors.white24,
            ),
          ),
        ),
        const SizedBox(width: 8),
        Text(
          _failed ? 'Error' : _fmt(_playing || _pos > Duration.zero ? _pos : _total),
          style: const TextStyle(color: Colors.white70, fontSize: 12),
        ),
      ],
    );
  }
}
