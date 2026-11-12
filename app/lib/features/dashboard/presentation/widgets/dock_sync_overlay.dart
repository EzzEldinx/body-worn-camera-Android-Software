import 'package:flutter/material.dart';

import '../../../../core/services/central_link.dart';
import '../../../../core/services/dock_sync.dart';
import '../../../../core/theme/bwc_tokens.dart';
import 'hud.dart';

Color _tone(DockPhase phase) {
  switch (phase) {
    case DockPhase.connected:
      return Bwc.brand;
    case DockPhase.updating:
      return Bwc.amber;
    case DockPhase.uploading:
      return Bwc.blue;
    case DockPhase.done:
      return Bwc.ok;
    case DockPhase.attention:
      return Bwc.rec;
  }
}

IconData _icon(DockPhase phase) {
  switch (phase) {
    case DockPhase.connected:
      return Icons.usb_rounded;
    case DockPhase.updating:
      return Icons.autorenew_rounded;
    case DockPhase.uploading:
      return Icons.cloud_upload_rounded;
    case DockPhase.done:
      return Icons.check_circle_rounded;
    case DockPhase.attention:
      return Icons.error_outline_rounded;
  }
}

bool _working(DockPhase phase) => phase == DockPhase.connected || phase == DockPhase.updating || phase == DockPhase.uploading;

/// The window the docking station puts on the camera's screen while it checks the camera, updates its software or uploads its recordings.
///
/// Full screen, and it takes the taps (nobody should press anything while the station works). While a recording is running it shrinks
/// to a thin bar that lets every tap through, so the stop and SOS buttons stay free.
class DockSyncOverlay extends StatelessWidget {
  const DockSyncOverlay({super.key, required this.screen, this.compact = false});

  final DockScreen screen;
  final bool compact;

  @override
  Widget build(BuildContext context) => compact ? _thinBar() : _fullScreen();

  Widget _fullScreen() {
    final Color tone = _tone(screen.phase);
    return AbsorbPointer(
      child: Material(
        color: Bwc.bg.withValues(alpha: 0.97),
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(24, 14, 24, 18),
            child: Column(
              children: [
                Image.asset('assets/images/logo_white.png', height: 22, errorBuilder: (_, __, ___) => const SizedBox.shrink()),
                const Spacer(),
                _Badge(phase: screen.phase),
                const SizedBox(height: 26),
                Text(
                  screen.title,
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Bwc.text, fontSize: 21, fontWeight: FontWeight.w800, height: 1.2),
                ),
                if (screen.detail.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  Text(
                    screen.detail,
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: Bwc.muted, fontSize: 14, height: 1.3),
                  ),
                ],
                if (_working(screen.phase)) ...[
                  const SizedBox(height: 22),
                  ClipRRect(
                    borderRadius: BorderRadius.circular(6),
                    child: SizedBox(
                      width: 220,
                      height: 6,
                      child: LinearProgressIndicator(
                        value: screen.percent == null ? null : screen.percent! / 100,
                        backgroundColor: Bwc.line,
                        valueColor: AlwaysStoppedAnimation<Color>(tone),
                      ),
                    ),
                  ),
                  if (screen.percent != null) ...[
                    const SizedBox(height: 8),
                    Text('${screen.percent}%', style: const TextStyle(color: Bwc.muted, fontSize: 12, fontWeight: FontWeight.w700, letterSpacing: 0.8)),
                  ],
                ],
                const Spacer(),
                Text(CentralConfig.cameraId, style: const TextStyle(color: Bwc.muted, fontSize: 11.5, fontWeight: FontWeight.w700, letterSpacing: 1.2)),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _thinBar() {
    final Color tone = _tone(screen.phase);
    final String text = screen.detail.isEmpty ? screen.title : '${screen.title} · ${screen.detail}';
    return Align(
      alignment: const Alignment(0, -0.05),
      child: IgnorePointer(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14),
          child: HudGlass(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(_icon(screen.phase), size: 16, color: tone),
                const SizedBox(width: 8),
                Flexible(
                  child: Text(
                    text,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(color: Bwc.text, fontSize: 12.5, fontWeight: FontWeight.w700),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The round icon in the middle: it turns while the camera is being updated, pulses while the station is busy, and stands still when done.
class _Badge extends StatefulWidget {
  const _Badge({required this.phase});

  final DockPhase phase;

  @override
  State<_Badge> createState() => _BadgeState();
}

class _BadgeState extends State<_Badge> with SingleTickerProviderStateMixin {
  late final AnimationController _anim = AnimationController(vsync: this, duration: const Duration(milliseconds: 1600));

  @override
  void initState() {
    super.initState();
    _sync();
  }

  @override
  void didUpdateWidget(covariant _Badge old) {
    super.didUpdateWidget(old);
    _sync();
  }

  void _sync() {
    if (_working(widget.phase)) {
      if (!_anim.isAnimating) _anim.repeat();
    } else {
      _anim.stop();
    }
  }

  @override
  void dispose() {
    _anim.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final Color tone = _tone(widget.phase);
    Widget icon = Icon(_icon(widget.phase), size: 46, color: tone);
    if (widget.phase == DockPhase.updating) icon = RotationTransition(turns: _anim, child: icon);
    return SizedBox(
      width: 110,
      height: 110,
      child: Stack(
        alignment: Alignment.center,
        children: [
          if (_working(widget.phase))
            AnimatedBuilder(
              animation: _anim,
              builder: (_, __) => Container(
                width: 84 + 26 * _anim.value,
                height: 84 + 26 * _anim.value,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.all(color: tone.withValues(alpha: 0.55 * (1 - _anim.value)), width: 2),
                ),
              ),
            ),
          Container(
            width: 84,
            height: 84,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: tone.withValues(alpha: 0.14),
              border: Border.all(color: tone.withValues(alpha: 0.7), width: 2),
            ),
            child: Center(child: icon),
          ),
        ],
      ),
    );
  }
}
