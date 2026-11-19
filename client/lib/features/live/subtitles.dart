import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/api/fleet.dart';
import '../../core/l10n/strings.dart';
import '../../core/theme/vg_theme.dart';
import '../../core/widgets/widgets.dart';
import '../auth/auth_controller.dart';

/// Live captions shown as subtitles over a camera's picture (like subtitles in a film). The server only sends them to people who
/// may read them ("Live captions"), so a picture can always carry this (empty, invisible) widget.
/// While somebody talks the text is a draft that is rewritten every second or so; when they pause the final text replaces it.
/// It fades out 6 seconds after the last update.
class Subtitles extends ConsumerStatefulWidget {
  const Subtitles({super.key, required this.cameraId, this.compact = false});
  final String cameraId;
  final bool compact;
  @override
  ConsumerState<Subtitles> createState() => _SubtitlesState();
}

class _SubtitlesState extends ConsumerState<Subtitles> {
  static const _hide = Duration(seconds: 6);
  StreamSubscription<CaptionLine>? _sub;
  Timer? _timer;
  String _text = '';
  bool _draft = false, _shown = false;

  @override
  void initState() {
    super.initState();
    _sub = ref.read(fleetProvider.notifier).captions.where((l) => l.cameraId == widget.cameraId && l.text.trim().isNotEmpty).listen((l) {
      _timer?.cancel();
      _timer = Timer(_hide, () { if (mounted) setState(() => _shown = false); });
      setState(() { _text = l.text.trim(); _draft = l.partial; _shown = true; });
    });
  }

  @override
  void dispose() { _sub?.cancel(); _timer?.cancel(); super.dispose(); }

  @override
  Widget build(BuildContext context) => IgnorePointer(
        child: AnimatedOpacity(
          opacity: _shown ? 1 : 0, duration: const Duration(milliseconds: 350),
          child: Center(child: Container(
            padding: EdgeInsets.symmetric(horizontal: widget.compact ? 8 : 12, vertical: 3),
            decoration: BoxDecoration(color: const Color(0xB80C1018), borderRadius: BorderRadius.circular(8)),
            child: Text(_text, maxLines: 2, overflow: TextOverflow.ellipsis, textAlign: TextAlign.center, textDirection: _dir(_text),
                style: TextStyle(color: _draft ? const Color(0xFFE6EBF5) : Colors.white, fontSize: widget.compact ? 12 : 17, height: 1.45, fontWeight: FontWeight.w600)),
          )),
        ),
      );

  // Arabic and English captions mix: the direction follows the first letter.
  TextDirection _dir(String s) {
    for (final r in s.runes) {
      if (r >= 0x0600 && r <= 0x06FF) return TextDirection.rtl;
      if ((r >= 0x41 && r <= 0x5A) || (r >= 0x61 && r <= 0x7A)) return TextDirection.ltr;
    }
    return TextDirection.ltr;
  }
}

/// A box on the camera panel with the sentences the camera heard (newest at the bottom): the history from the server, then live lines.
/// Shown only to people who have "Live captions"; says so when the server has no captions service.
class CaptionsBox extends ConsumerStatefulWidget {
  const CaptionsBox({super.key, required this.cameraId});
  final String cameraId;
  @override
  ConsumerState<CaptionsBox> createState() => _CaptionsBoxState();
}

class _CaptionsBoxState extends ConsumerState<CaptionsBox> {
  final _lines = <CaptionLine>[];
  String _draft = '';
  bool _enabled = true, _loaded = false;
  StreamSubscription<CaptionLine>? _sub;

  @override
  void initState() { super.initState(); _load(); _listen(); }

  @override
  void didUpdateWidget(CaptionsBox old) {
    super.didUpdateWidget(old);
    if (old.cameraId != widget.cameraId) { _sub?.cancel(); _lines.clear(); _draft = ''; _loaded = false; _load(); _listen(); }
  }

  @override
  void dispose() { _sub?.cancel(); super.dispose(); }

  void _listen() {
    _sub = ref.read(fleetProvider.notifier).captions.where((l) => l.cameraId == widget.cameraId).listen((l) {
      setState(() {
        if (l.partial) { _draft = l.text; return; }
        _draft = '';
        _lines.add(l);
        if (_lines.length > 60) _lines.removeAt(0);
      });
    });
  }

  Future<void> _load() async {
    final id = widget.cameraId;
    try {
      final d = await ref.read(sessionProvider)!.api.getJson('/api/transcripts/${Uri.encodeComponent(id)}', {'limit': '30'}) as Map;
      if (!mounted || id != widget.cameraId) return;
      setState(() {
        _enabled = d['enabled'] != false;
        _lines.insertAll(0, [for (final l in (d['lines'] as List? ?? const [])) CaptionLine.fromJson(l as Map)]);
        _loaded = true;
      });
    } catch (_) { if (mounted) setState(() => _loaded = true); }
  }

  @override
  Widget build(BuildContext context) {
    final v = context.vg;
    final shown = _lines.length > 8 ? _lines.sublist(_lines.length - 8) : _lines;
    return VgCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [Icon(Icons.closed_caption_rounded, size: 20, color: v.brand), const SizedBox(width: 8), Text(context.tr('cap_title'), style: const TextStyle(fontWeight: FontWeight.w800))]),
        const SizedBox(height: 8),
        if (!_enabled) Text(context.tr('cap_off'), style: TextStyle(color: v.mut))
        else if (!_loaded) const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
        else if (shown.isEmpty && _draft.isEmpty) Text(context.tr('cap_wait'), style: TextStyle(color: v.mut))
        else ...[
          for (final l in shown) Padding(padding: const EdgeInsets.only(bottom: 4), child: Text(l.text, textDirection: _dirOf(l.text), style: const TextStyle(height: 1.4))),
          if (_draft.isNotEmpty) Text(_draft, textDirection: _dirOf(_draft), style: TextStyle(height: 1.4, color: v.mut, fontStyle: FontStyle.italic)),
        ],
      ]),
    );
  }

  TextDirection _dirOf(String s) {
    for (final r in s.runes) {
      if (r >= 0x0600 && r <= 0x06FF) return TextDirection.rtl;
      if ((r >= 0x41 && r <= 0x5A) || (r >= 0x61 && r <= 0x7A)) return TextDirection.ltr;
    }
    return TextDirection.ltr;
  }
}
