import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:media_kit/media_kit.dart';
import 'package:media_kit_video/media_kit_video.dart';
import '../../core/api/fleet.dart';
import '../../core/api/models.dart';
import '../../core/l10n/strings.dart';
import '../../core/theme/vg_theme.dart';
import '../../core/widgets/widgets.dart';
import '../auth/auth_controller.dart';
import 'subtitles.dart';

enum LivePhase { idle, requesting, connecting, playing, offline, limit, stopped }

/// A live camera picture. Opening it starts the camera's stream remotely (the officer does nothing),
/// signs the URL, plays the FLV with libmpv and reconnects by itself when the camera restarts its stream.
class LivePlayer extends ConsumerStatefulWidget {
  const LivePlayer({super.key, required this.cameraId, this.onFullscreen, this.compact = false, this.fit = BoxFit.contain, this.autoStart = true});
  final String cameraId;
  final VoidCallback? onFullscreen;
  final bool compact; // smaller overlay for wall tiles
  final BoxFit fit;
  /// false on the Live wall: a camera that is not already streaming waits for a tap ("Start live view") instead of being started remotely just
  /// because its tile came on screen (opening the tab used to start every online officer's camera). A camera that already streams plays at once.
  final bool autoStart;
  @override
  ConsumerState<LivePlayer> createState() => _LivePlayerState();
}

class _LivePlayerState extends ConsumerState<LivePlayer> {
  late final Player _player = Player();
  late final VideoController _video = VideoController(_player);
  final _subs = <StreamSubscription>[];
  Timer? _watchdog;
  LivePhase _phase = LivePhase.requesting;
  bool _listen = false, _opening = false, _asked = false, _userStarted = false;
  int _tries = 0;

  FleetController get _fleet => ref.read(fleetProvider.notifier);
  Camera? get _cam => ref.read(fleetProvider).cams[widget.cameraId];

  @override
  void initState() {
    super.initState();
    _player.setVolume(0);
    _configure();
    _subs.add(_player.stream.width.listen((w) { if ((w ?? 0) > 0 && mounted) { _tries = 0; setState(() => _phase = LivePhase.playing); } }));
    _subs.add(_player.stream.error.listen((e) { if (_fatal(e)) _retrySoon(); }));
    _subs.add(_player.stream.completed.listen((c) { if (c) _retrySoon(); }));
    _subs.add(_fleet.streamUps.where((id) => id == widget.cameraId).listen((_) => _retrySoon(fast: true)));
    _subs.add(_fleet.results.where((r) => r.cameraId == widget.cameraId && !r.ok).listen((r) {
      if (mounted) setState(() => _phase = r.reason == 'live_limit' ? LivePhase.limit : LivePhase.offline);
    }));
    ref.listenManual(fleetProvider.select((s) => s.cams[widget.cameraId]), (prev, next) {
      if (next == null) return;
      if (!next.online) { if (mounted) setState(() => _phase = LivePhase.offline); return; }
      if (next.recording && _phase != LivePhase.playing && !_opening) _open();
      if (!next.recording && prev?.recording == true && mounted) { _player.stop(); setState(() => _phase = LivePhase.stopped); }
      if (next.online && prev?.online == false) _begin();
    });
    WidgetsBinding.instance.addPostFrameCallback((_) => _begin());
  }

  Future<void> _configure() async {
    final p = _player.platform;
    if (p is NativePlayer) { await p.setProperty('profile', 'low-latency'); await p.setProperty('cache', 'no'); }
  }

  void _begin() {
    final c = _cam;
    if (c == null || !c.online) { setState(() => _phase = LivePhase.offline); return; }
    if (c.recording) { _open(); return; }
    if (!widget.autoStart && !_userStarted) { setState(() => _phase = LivePhase.idle); return; }
    if (!_asked) { _asked = true; _fleet.startLive(widget.cameraId); }
    setState(() => _phase = LivePhase.requesting);
    _watchdog?.cancel();
    _watchdog = Timer(const Duration(seconds: 25), () { if (mounted && _phase == LivePhase.requesting) { _asked = false; _begin(); } });
  }

  Future<void> _open() async {
    if (_opening || !mounted) return;
    _opening = true;
    try {
      setState(() => _phase = LivePhase.connecting);
      final s = ref.read(sessionProvider)!;
      final sign = await s.api.streamSign(widget.cameraId);
      await _player.open(Media(s.api.liveUrl(widget.cameraId, sign)), play: true);
      _watchdog?.cancel();
      _watchdog = Timer(const Duration(seconds: 15), () { if (mounted && _phase == LivePhase.connecting) _retrySoon(); });
    } catch (_) {
      _retrySoon();
    } finally {
      _opening = false;
    }
  }

  /// libmpv also reports problems that do not stop the picture (no audio device on a simulator or while a call
  /// holds the audio session, hardware decoder falling back to software). Reconnecting on those made the
  /// stream restart every couple of seconds, so only real stream failures count.
  bool _fatal(String e) {
    if (e.isEmpty) return false;
    final m = e.toLowerCase();
    if (m.contains('audio') || m.contains('no sound') || m.contains('hwaccel') || m.contains('videotoolbox') || m.contains('property not found')) return false;
    return true;
  }

  void _retrySoon({bool fast = false}) {
    if (!mounted || _phase == LivePhase.offline || _phase == LivePhase.stopped) return;
    _tries++;
    _watchdog?.cancel();
    _watchdog = Timer(Duration(milliseconds: fast ? 400 : (_tries * 1500).clamp(1500, 6000)), () {
      if (!mounted) return;
      if (_cam?.recording ?? false) { _open(); } else { _begin(); }
    });
  }

  @override
  void dispose() {
    _watchdog?.cancel();
    for (final s in _subs) { s.cancel(); }
    _player.dispose();
    super.dispose();
  }

  void _toggleListen() {
    HapticFeedback.selectionClick();
    setState(() => _listen = !_listen);
    _player.setVolume(_listen ? 100 : 0);
  }

  @override
  Widget build(BuildContext context) {
    final cam = ref.watch(fleetProvider.select((s) => s.cams[widget.cameraId]));
    final playing = _phase == LivePhase.playing;
    final status = switch (_phase) {
      LivePhase.idle => context.tr('tap_to_start'),
      LivePhase.requesting => context.tr('requesting'),
      LivePhase.connecting => context.tr('waiting_stream'),
      LivePhase.offline => context.tr('cam_offline'),
      LivePhase.limit => context.tr('live_limit'),
      LivePhase.stopped => context.tr('stream_stopped'),
      LivePhase.playing => '',
    };
    return ClipRRect(
      borderRadius: BorderRadius.circular(widget.compact ? 12 : kRadius),
      child: Container(
        color: const Color(0xFF0A111D),
        child: Stack(fit: StackFit.expand, children: [
          Video(controller: _video, controls: NoVideoControls, fit: widget.fit, fill: const Color(0xFF0A111D)),
          if (playing) Positioned(left: 10, right: 10, bottom: widget.compact ? 46 : 18, child: Subtitles(cameraId: widget.cameraId, compact: widget.compact)),
          if (!playing) _Status(text: status, phase: _phase, onRetry: () { _userStarted = true; _asked = false; _tries = 0; _begin(); }),
          Positioned(
            left: 8, right: 8, top: 8,
            child: Container(
              padding: const EdgeInsets.all(5),
              decoration: BoxDecoration(color: const Color(0xB30A101C), borderRadius: BorderRadius.circular(12), border: Border.all(color: const Color(0x2EFFFFFF))),
              child: Row(children: [
                Expanded(child: Padding(padding: const EdgeInsets.symmetric(horizontal: 6), child: Text(cam?.name ?? widget.cameraId, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 13)))),
                if (playing) StatusPill(label: context.tr('live_pill'), color: const Color(0xFFFF5D77), pulse: true),
                const SizedBox(width: 4),
                _OverlayBtn(icon: _listen ? Icons.volume_up_rounded : Icons.volume_off_rounded, on: _listen, onTap: _toggleListen),
                if (widget.onFullscreen != null) _OverlayBtn(icon: Icons.fullscreen_rounded, onTap: widget.onFullscreen!),
              ]),
            ),
          ),
        ]),
      ),
    );
  }
}

class _OverlayBtn extends StatelessWidget {
  const _OverlayBtn({required this.icon, required this.onTap, this.on = false});
  final IconData icon;
  final VoidCallback onTap;
  final bool on;
  @override
  Widget build(BuildContext context) => InkResponse(
        onTap: onTap, radius: 22,
        child: Container(
          width: 34, height: 34, margin: const EdgeInsetsDirectional.only(start: 4),
          decoration: BoxDecoration(color: on ? const Color(0x592EE6A6) : const Color(0x1AFFFFFF), borderRadius: BorderRadius.circular(9), border: Border.all(color: on ? const Color(0xB32EE6A6) : const Color(0x24FFFFFF))),
          child: Icon(icon, size: 19, color: Colors.white),
        ),
      );
}

class _Status extends StatelessWidget {
  const _Status({required this.text, required this.phase, required this.onRetry});
  final String text;
  final LivePhase phase;
  final VoidCallback onRetry;
  @override
  Widget build(BuildContext context) {
    final busy = phase == LivePhase.requesting || phase == LivePhase.connecting;
    return Container(
      color: const Color(0xFF0A111D),
      padding: const EdgeInsets.fromLTRB(20, 56, 20, 16),
      child: Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          if (busy) const SizedBox(width: 30, height: 30, child: CircularProgressIndicator(strokeWidth: 2.4, color: Color(0xFFFFC857)))
          else if (phase == LivePhase.idle) const Icon(Icons.play_circle_outline_rounded, color: Color(0xFF8FA2BF), size: 34)
          else Icon(phase == LivePhase.offline ? Icons.videocam_off_rounded : Icons.info_outline_rounded, color: const Color(0xFF8FA2BF), size: 34),
          const SizedBox(height: 12),
          Text(text, textAlign: TextAlign.center, style: const TextStyle(color: Color(0xFF8FA2BF), fontSize: 13.5, height: 1.4)),
          if (!busy && phase != LivePhase.offline) Padding(padding: const EdgeInsets.only(top: 12), child: phase == LivePhase.idle
              ? CtaButton(compact: true, label: context.tr('start_live_view'), icon: Icons.play_arrow_rounded, onTap: onRetry)
              : CtaButton(compact: true, label: context.tr('retry'), icon: Icons.refresh_rounded, onTap: onRetry)),
        ]),
      ),
    );
  }
}
