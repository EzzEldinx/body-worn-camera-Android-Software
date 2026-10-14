import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

import 'package:swg_bwc/core/services/central_link.dart';
import '../widgets/voice_bubble.dart';

/// Chat for the officer: Control room (private), Public channel and any groups
/// the dispatchers put this camera in. Quick replies make typing optional.
class ChatScreen extends ConsumerStatefulWidget {
  const ChatScreen({super.key});

  @override
  ConsumerState<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends ConsumerState<ChatScreen> {
  static const Color _bgTop = Color(0xFF0F1828);
  static const Color _bgBottom = Color(0xFF1B2D4A);
  static const Color _panel = Color(0xFF1D2C47);
  static const Color _line = Color(0xFF2A3B5A);
  static const Color _amber = Color(0xFFFFC857);
  static const Color _blue = Color(0xFF5AA9FF);
  static const Color _red = Color(0xFFFF5D73);
  static const Color _muted = Color(0xFF8A9BB5);

  static const List<String> _quick = [
    'Copy',
    'Need backup',
    'On my way',
    'All clear',
    'Repeat please',
  ];

  final TextEditingController _input = TextEditingController();
  final ScrollController _scroll = ScrollController();
  late final CentralLink _link;

  // Voice Note Recorder variables
  late final AudioRecorder _audioRecorder;
  bool _isRecording = false;

  String _type = 'PRIVATE';
  String _target = CentralConfig.cameraId;

  String get _key => '$_type:$_target';

  @override
  void initState() {
    super.initState();
    _audioRecorder = AudioRecorder();
    _link = ref.read(centralLinkProvider);
    // Deferred: openChat notifies listeners, which is illegal during build.
    WidgetsBinding.instance.addPostFrameCallback((_) => _link.openChat(_key));
    _link.chatMessages.addListener(_onMessages);
    _toBottom();
  }

  @override
  void dispose() {
    _audioRecorder.dispose();
    _link.chatMessages.removeListener(_onMessages);
    _link.closeChat();
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _onMessages() {
    _link.openChat(_key); // a message that arrives in the open chat is read
    _toBottom();
  }

  void _toBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scroll.hasClients) return;
      _scroll.animateTo(
        _scroll.position.maxScrollExtent,
        duration: const Duration(milliseconds: 180),
        curve: Curves.easeOut,
      );
    });
  }

  void _select(String type, String target) {
    setState(() {
      _type = type;
      _target = target;
    });
    _link.openChat(_key);
    _toBottom();
  }

  void _send(String text) {
    final t = text.trim();
    if (t.isEmpty) return;
    if (_link.sendChat(_type, _target, t)) {
      _input.clear();
      HapticFeedback.selectionClick();
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('No connection. The message was not sent.')),
      );
    }
    _toBottom();
  }

  /// Tap to start, tap again to stop and send the voice note.
  Future<void> _toggleRecording() async {
    try {
      if (_isRecording) {
        final path = await _audioRecorder.stop();
        if (mounted) setState(() => _isRecording = false);
        if (path == null) return;

        final file = File(path);
        if (!await file.exists()) return;
        final bytes = await file.readAsBytes();
        await file.delete();

        final sent = _link.sendChat(
          _type,
          _target,
          '[Voice Note]',
          audio: 'data:audio/mp4;base64,${base64Encode(bytes)}',
        );
        if (!mounted) return;
        if (sent) {
          HapticFeedback.mediumImpact();
        } else {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('No connection. The voice note was not sent.')),
          );
        }
        _toBottom();
      } else if (await _audioRecorder.hasPermission()) {
        final dir = await getTemporaryDirectory();
        final path = '${dir.path}/voice_${DateTime.now().millisecondsSinceEpoch}.m4a';
        await _audioRecorder.start(const RecordConfig(encoder: AudioEncoder.aacLc), path: path);
        if (mounted) setState(() => _isRecording = true);
        HapticFeedback.lightImpact();
      }
    } catch (e) {
      debugPrint('Voice note error: $e');
      if (mounted) setState(() => _isRecording = false);
    }
  }

  String _time(int ts) {
    final d = DateTime.fromMillisecondsSinceEpoch(ts);
    return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  }

  String _title(List<ChatGroup> groups) {
    if (_type == 'PUBLIC') return 'Public channel';
    if (_type == 'PRIVATE') return 'Control room';
    for (final g in groups) {
      if (g.id == _target) return g.name;
    }
    return 'Group';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _bgTop,
      body: Container(
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [_bgTop, _bgBottom],
          ),
        ),
        child: SafeArea(
          child: Column(
            children: [
              _header(),
              _chips(),
              Expanded(child: _messages()),
              _quickReplies(),
              _composer(),
            ],
          ),
        ),
      ),
    );
  }

  Widget _header() {
    return ValueListenableBuilder<List<ChatGroup>>(
      valueListenable: _link.chatGroups,
      builder: (context, groups, _) => Padding(
        padding: const EdgeInsets.fromLTRB(4, 4, 12, 0),
        child: Row(
          children: [
            IconButton(
              icon: const Icon(Icons.arrow_back, color: Colors.white),
              tooltip: 'Back to camera',
              onPressed: () => Navigator.of(context).pop(),
            ),
            Expanded(
              child: Text(
                _title(groups),
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w700),
              ),
            ),
            Text(CentralConfig.cameraId, style: const TextStyle(color: _muted, fontSize: 12)),
          ],
        ),
      ),
    );
  }

  Widget _chips() {
    return ValueListenableBuilder<List<ChatGroup>>(
      valueListenable: _link.chatGroups,
      builder: (context, groups, _) => ValueListenableBuilder<Map<String, int>>(
        valueListenable: _link.unreadByChat,
        builder: (context, unread, _) {
          final items = <(String, String, String)>[
            ('PRIVATE', CentralConfig.cameraId, 'Control room'),
            ('PUBLIC', 'all', 'Public'),
            for (final g in groups) ('GROUP', g.id, g.name),
          ];
          return SizedBox(
            height: 48,
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              children: [
                for (final it in items)
                  _chip(it.$1, it.$2, it.$3, unread['${it.$1}:${it.$2}'] ?? 0),
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _chip(String type, String target, String label, int unread) {
    final on = _type == type && _target == target;
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: GestureDetector(
        onTap: () => _select(type, target),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: on ? _amber : _panel,
            borderRadius: BorderRadius.circular(20),
            border: Border.all(color: on ? _amber : _line),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                label,
                style: TextStyle(
                  color: on ? const Color(0xFF1A1405) : Colors.white,
                  fontWeight: FontWeight.w600,
                  fontSize: 14,
                ),
              ),
              if (unread > 0)
                Container(
                  margin: const EdgeInsets.only(left: 6),
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                  decoration: BoxDecoration(color: _red, borderRadius: BorderRadius.circular(10)),
                  child: Text('$unread', style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.w700)),
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _messages() {
    return ValueListenableBuilder<List<ChatMessage>>(
      valueListenable: _link.chatMessages,
      builder: (context, all, _) {
        final list = all.where((m) => m.chatType == _type && m.targetId == _target).toList();
        if (list.isEmpty) {
          return const Center(
            child: Padding(
              padding: EdgeInsets.all(24),
              child: Text(
                'No messages yet.\nUse a quick reply or type below.',
                textAlign: TextAlign.center,
                style: TextStyle(color: _muted, fontSize: 15, height: 1.5),
              ),
            ),
          );
        }
        final maxW = MediaQuery.of(context).size.width * 0.78;
        return ListView.builder(
          controller: _scroll,
          padding: const EdgeInsets.symmetric(vertical: 8),
          itemCount: list.length,
          itemBuilder: (context, i) {
            final m = list[i];
            return Align(
              alignment: m.mine ? Alignment.centerRight : Alignment.centerLeft,
              child: Container(
                constraints: BoxConstraints(maxWidth: maxW),
                margin: const EdgeInsets.symmetric(vertical: 4, horizontal: 12),
                padding: const EdgeInsets.fromLTRB(12, 8, 12, 6),
                decoration: BoxDecoration(
                  color: m.mine ? _blue.withValues(alpha: 0.30) : _panel,
                  borderRadius: BorderRadius.only(
                    topLeft: const Radius.circular(14),
                    topRight: const Radius.circular(14),
                    bottomLeft: Radius.circular(m.mine ? 14 : 3),
                    bottomRight: Radius.circular(m.mine ? 3 : 14),
                  ),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (!m.mine)
                      Text(m.senderName, style: const TextStyle(color: _amber, fontSize: 12, fontWeight: FontWeight.w700)),
                    if (m.audio != null)
                      VoiceBubble(dataUri: m.audio!, color: _amber)
                    else
                      Text(m.text, style: const TextStyle(color: Colors.white, fontSize: 16, height: 1.3)),
                    const SizedBox(height: 2),
                    Align(
                      alignment: Alignment.centerRight,
                      child: Text(_time(m.ts), style: const TextStyle(color: _muted, fontSize: 11)),
                    ),
                  ],
                ),
              ),
            );
          },
        );
      },
    );
  }

  Widget _quickReplies() {
    return SizedBox(
      height: 44,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
        children: [
          for (final q in _quick)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: GestureDetector(
                onTap: () => _send(q),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 14),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: _panel,
                    borderRadius: BorderRadius.circular(18),
                    border: Border.all(color: _blue.withValues(alpha: 0.6)),
                  ),
                  child: Text(q, style: const TextStyle(color: _blue, fontSize: 14, fontWeight: FontWeight.w600)),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _composer() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 4, 12, 10),
      child: Row(
        children: [
          // 🎤 زرار المايك بتصميم واتساب وتنبيه بصري عند التسجيل
          GestureDetector(
            onTap: _toggleRecording,
            child: Container(
              width: 48,
              height: 48,
              decoration: BoxDecoration(
                color: _isRecording ? _red : _panel,
                shape: BoxShape.circle,
                border: Border.all(color: _isRecording ? _red : _line),
              ),
              child: Icon(
                _isRecording ? Icons.mic : Icons.mic_none,
                color: _isRecording ? Colors.white : _muted,
                size: 22,
              ),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: TextField(
              controller: _input,
              style: const TextStyle(color: Colors.white, fontSize: 16),
              textInputAction: TextInputAction.send,
              onSubmitted: _send,
              maxLength: 500,
              decoration: InputDecoration(
                counterText: '',
                hintText: _isRecording ? 'Recording voice note...' : 'Write a message',
                hintStyle: TextStyle(color: _isRecording ? _red : _muted),
                filled: true,
                fillColor: _panel,
                contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(24),
                  borderSide: const BorderSide(color: _line),
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(24),
                  borderSide: const BorderSide(color: _line),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(24),
                  borderSide: const BorderSide(color: _amber),
                ),
              ),
            ),
          ),
          const SizedBox(width: 8),
          GestureDetector(
            onTap: () => _send(_input.text),
            child: Container(
              width: 48,
              height: 48,
              decoration: const BoxDecoration(color: _amber, shape: BoxShape.circle),
              child: const Icon(Icons.send, color: Color(0xFF1A1405), size: 22),
            ),
          ),
        ],
      ),
    );
  }
}