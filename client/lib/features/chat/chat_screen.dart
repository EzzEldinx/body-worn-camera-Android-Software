import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' show FontFeature;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:media_kit/media_kit.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';
import '../../core/api/fleet.dart';
import '../../core/l10n/strings.dart';
import '../../core/theme/vg_theme.dart';
import '../../core/widgets/widgets.dart';
import '../auth/auth_controller.dart';
import 'chat_controller.dart';

/// Talk to the officers: a message (or a voice note) to everybody, or to one camera. Same as the dashboard's chat panel ("Voice & chat").
class ChatScreen extends ConsumerStatefulWidget {
  const ChatScreen({super.key, this.camera, this.embedded = false});
  final String? camera; // open the private thread of this camera
  final bool embedded;  // inside the Chat tab: no back arrow, and the shell (not this screen) clears the unread count
  @override
  ConsumerState<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends ConsumerState<ChatScreen> {
  final _text = TextEditingController();
  final _scroll = ScrollController();
  final _rec = AudioRecorder();
  String? _camera; // null = everybody
  bool _recording = false;
  DateTime? _recStart;

  @override
  void initState() {
    super.initState();
    _camera = widget.camera;
    final focus = ref.read(chatFocusProvider); // the tab is built the first time it is opened, after a notice has already said which thread to show
    if (focus != null) {
      _camera = focus == 'ALL' ? null : focus;
      WidgetsBinding.instance.addPostFrameCallback((_) => ref.read(chatFocusProvider.notifier).show(null));
    }
    if (!widget.embedded) WidgetsBinding.instance.addPostFrameCallback((_) => ref.read(chatUnreadProvider.notifier).clear());
  }

  @override
  void dispose() { _text.dispose(); _scroll.dispose(); _rec.dispose(); super.dispose(); }

  void _send({String? audio}) {
    final text = audio != null ? '[Voice Note]' : _text.text.trim();
    if (text.isEmpty) return;
    final user = ref.read(sessionProvider)?.user;
    ref.read(chatProvider.notifier).send(chatType: _camera == null ? 'PUBLIC' : 'PRIVATE', target: _camera ?? 'ALL', text: text, audio: audio, senderName: user?.name ?? 'Control Room');
    _text.clear();
    _toEnd();
  }

  void _toEnd() => WidgetsBinding.instance.addPostFrameCallback((_) { if (_scroll.hasClients) _scroll.animateTo(_scroll.position.maxScrollExtent + 120, duration: const Duration(milliseconds: 200), curve: Curves.easeOut); });

  Future<void> _toggleRecord() async {
    if (_recording) {
      final path = await _rec.stop();
      final secs = DateTime.now().difference(_recStart ?? DateTime.now()).inMilliseconds;
      setState(() => _recording = false);
      if (path == null) return;
      final f = File(path);
      final bytes = await f.readAsBytes();
      try { await f.delete(); } catch (_) {}
      if (secs < 700 || bytes.isEmpty) return; // a tap by mistake
      _send(audio: 'data:audio/mp4;base64,${base64Encode(bytes)}');
      return;
    }
    try {
      if (!await _rec.hasPermission()) { if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(context.tr('chat_no_mic')))); return; }
      final dir = await getTemporaryDirectory();
      await _rec.start(const RecordConfig(encoder: AudioEncoder.aacLc, bitRate: 32000, sampleRate: 22050, numChannels: 1), path: '${dir.path}/vg-note-${DateTime.now().millisecondsSinceEpoch}.m4a');
      _recStart = DateTime.now();
      setState(() => _recording = true);
    } catch (_) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(context.tr('chat_no_mic'))));
    }
  }

  @override
  Widget build(BuildContext context) {
    final v = context.vg;
    final all = ref.watch(chatProvider);
    final cams = ref.watch(fleetProvider.select((s) => s.cams));
    final user = ref.watch(sessionProvider)?.user;
    final canSend = user != null && user.can('talk') && user.role != 'viewer';
    final msgs = all.where((m) => _camera == null ? m.chatType == 'PUBLIC' : (m.chatType == 'PRIVATE' && m.target == _camera)).toList();
    ref.listen(chatProvider, (_, _) { if (!widget.embedded) ref.read(chatUnreadProvider.notifier).clear(); _toEnd(); });
    ref.listen(chatFocusProvider, (_, t) {
      if (t == null) return;
      setState(() => _camera = t == 'ALL' ? null : t);
      ref.read(chatFocusProvider.notifier).show(null);
      _toEnd();
    });
    final ids = cams.keys.toList()..sort();
    return Scaffold(
      appBar: AppBar(title: Text(context.tr('chat')), automaticallyImplyLeading: !widget.embedded),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
          child: Row(children: [
            Expanded(child: DropdownButtonFormField<String?>(
              initialValue: _camera, isExpanded: true,
              decoration: InputDecoration(labelText: context.tr('chat_to'), border: const OutlineInputBorder(), isDense: true),
              items: [
                DropdownMenuItem<String?>(value: null, child: Text(context.tr('chat_all'))),
                for (final id in ids) DropdownMenuItem<String?>(value: id, child: Text(cams[id]!.name == id ? id : '${cams[id]!.name}  ·  $id')),
              ],
              onChanged: (x) => setState(() => _camera = x),
            )),
          ]),
        ),
        Expanded(
          child: msgs.isEmpty
              ? EmptyState(icon: Icons.chat_bubble_outline_rounded, title: context.tr('chat_empty'))
              : ListView.builder(controller: _scroll, padding: const EdgeInsets.all(12), itemCount: msgs.length, itemBuilder: (c, i) => _Bubble(m: msgs[i], showSender: _camera == null)),
        ),
        SafeArea(
          top: false,
          child: Container(
            padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
            decoration: BoxDecoration(color: v.panel, border: Border(top: BorderSide(color: v.line))),
            child: !canSend
                ? Padding(padding: const EdgeInsets.all(8), child: Text(context.tr('chat_read_only'), style: TextStyle(color: v.mut)))
                : Row(children: [
                    IconButton.filledTonal(
                      tooltip: context.tr('chat_voice'), onPressed: _toggleRecord,
                      style: _recording ? IconButton.styleFrom(backgroundColor: v.rec, foregroundColor: Colors.white) : null,
                      icon: Icon(_recording ? Icons.stop_rounded : Icons.mic_rounded),
                    ),
                    const SizedBox(width: 8),
                    Expanded(child: TextField(
                      controller: _text, minLines: 1, maxLines: 4, textInputAction: TextInputAction.send, onSubmitted: (_) => _send(), enabled: !_recording,
                      decoration: InputDecoration(hintText: _recording ? context.tr('chat_recording') : context.tr('chat_type'), border: const OutlineInputBorder(), isDense: true),
                    )),
                    const SizedBox(width: 8),
                    IconButton.filled(tooltip: context.tr('chat_send'), onPressed: _recording ? null : _send, icon: const Icon(Icons.send_rounded)),
                  ]),
          ),
        ),
      ]),
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble({required this.m, required this.showSender});
  final ChatMessage m;
  final bool showSender;
  @override
  Widget build(BuildContext context) {
    final v = context.vg;
    final time = DateTime.fromMillisecondsSinceEpoch(m.ts);
    final hm = '${time.hour.toString().padLeft(2, '0')}:${time.minute.toString().padLeft(2, '0')}';
    return Align(
      alignment: m.mine ? AlignmentDirectional.centerEnd : AlignmentDirectional.centerStart,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 6),
        constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * .78),
        decoration: BoxDecoration(color: m.mine ? v.brand.withValues(alpha: .18) : v.panel, borderRadius: BorderRadius.circular(14), border: Border.all(color: m.mine ? v.brand.withValues(alpha: .4) : v.line)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
          if (!m.mine && (showSender || m.sender.isNotEmpty)) Text(m.sender, style: TextStyle(color: v.sel, fontWeight: FontWeight.w800, fontSize: 12.5)),
          if (m.isVoice) VoiceBubble(dataUrl: m.audio!) else Text(m.text, style: const TextStyle(fontSize: 15, height: 1.35)),
          const SizedBox(height: 2),
          Align(alignment: AlignmentDirectional.centerEnd, child: Text(hm, style: TextStyle(color: v.mut, fontSize: 11))),
        ]),
      ),
    );
  }
}

/// Play / pause for a voice note (a `data:audio/...;base64,...` value); the sound is written to a temporary file first.
class VoiceBubble extends StatefulWidget {
  const VoiceBubble({super.key, required this.dataUrl});
  final String dataUrl;
  @override
  State<VoiceBubble> createState() => _VoiceBubbleState();
}

class _VoiceBubbleState extends State<VoiceBubble> {
  Player? _p;
  bool _playing = false;
  Duration _pos = Duration.zero, _dur = Duration.zero;
  final _subs = <StreamSubscription>[];

  Future<void> _toggle() async {
    if (_p == null) {
      final comma = widget.dataUrl.indexOf(',');
      if (comma < 0) return;
      final bytes = base64Decode(widget.dataUrl.substring(comma + 1));
      final head = widget.dataUrl.substring(0, comma).toLowerCase();
      final ext = head.contains('webm') ? 'webm' : head.contains('ogg') ? 'ogg' : head.contains('wav') ? 'wav' : head.contains('mpeg') ? 'mp3' : 'm4a';
      final dir = await getTemporaryDirectory();
      final f = File('${dir.path}/vg-voice-${widget.dataUrl.hashCode}.$ext');
      await f.writeAsBytes(bytes, flush: true);
      final p = Player();
      _subs.add(p.stream.playing.listen((x) { if (mounted) setState(() => _playing = x); }));
      _subs.add(p.stream.position.listen((x) { if (mounted) setState(() => _pos = x); }));
      _subs.add(p.stream.duration.listen((x) { if (mounted) setState(() => _dur = x); }));
      _subs.add(p.stream.completed.listen((c) { if (c) { p.seek(Duration.zero); p.pause(); } }));
      await p.open(Media(f.path), play: false);
      _p = p;
    }
    await _p!.playOrPause();
  }

  @override
  void dispose() { for (final s in _subs) { s.cancel(); } _p?.dispose(); super.dispose(); }

  String _fmt(Duration d) => '${d.inMinutes}:${(d.inSeconds % 60).toString().padLeft(2, '0')}';

  @override
  Widget build(BuildContext context) {
    final v = context.vg;
    final frac = _dur.inMilliseconds == 0 ? 0.0 : (_pos.inMilliseconds / _dur.inMilliseconds).clamp(0.0, 1.0);
    return Row(mainAxisSize: MainAxisSize.min, children: [
      IconButton.filled(onPressed: _toggle, icon: Icon(_playing ? Icons.pause_rounded : Icons.play_arrow_rounded), style: IconButton.styleFrom(backgroundColor: v.sel, foregroundColor: Colors.black)),
      const SizedBox(width: 8),
      SizedBox(width: 130, child: LinearProgressIndicator(value: frac, color: v.sel, backgroundColor: v.line, minHeight: 4, borderRadius: BorderRadius.circular(4))),
      const SizedBox(width: 8),
      Text(_fmt(_dur == Duration.zero ? Duration.zero : (_playing || _pos > Duration.zero ? _pos : _dur)), style: TextStyle(color: v.mut, fontSize: 12, fontFeatures: const [FontFeature.tabularFigures()])),
    ]);
  }
}
