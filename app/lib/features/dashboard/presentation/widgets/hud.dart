import 'dart:async';
import 'dart:ui';

import 'package:flutter/material.dart';

import '../../../../core/theme/bwc_tokens.dart';

/// Translucent container used for every control drawn over the live camera picture.
class HudGlass extends StatelessWidget {
  const HudGlass({super.key, required this.child, this.padding = EdgeInsets.zero, this.radius = 999, this.tint, this.borderColor});

  final Widget child;
  final EdgeInsets padding;
  final double radius;
  final Color? tint;
  final Color? borderColor;

  @override
  Widget build(BuildContext context) {
    // No blur: a BackdropFilter over the live camera surface made every frame very expensive on this device.
    // A darker translucent fill gives the same readability for free.
    return Container(
      padding: padding,
      decoration: BoxDecoration(
        color: tint ?? Bwc.glass,
        borderRadius: BorderRadius.circular(radius),
        border: Border.all(color: borderColor ?? Bwc.glassLine),
      ),
      child: child,
    );
  }
}

/// Small status chip: optional glowing dot + label.
class HudChip extends StatelessWidget {
  const HudChip(this.label, {super.key, this.dot, this.color = Bwc.text});

  final String label;
  final Color? dot;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return HudGlass(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (dot != null) ...[
            Container(
              width: 8,
              height: 8,
              decoration: BoxDecoration(color: dot, shape: BoxShape.circle, boxShadow: [BoxShadow(color: dot!.withValues(alpha: 0.8), blurRadius: 6)]),
            ),
            const SizedBox(width: 6),
          ],
          Text(label, style: TextStyle(color: color, fontSize: 11.5, fontWeight: FontWeight.w700, letterSpacing: 0.8)),
        ],
      ),
    );
  }
}

/// Round glass icon button (side rail).
class HudIconButton extends StatelessWidget {
  const HudIconButton({super.key, required this.icon, required this.onTap, this.color = Bwc.text, this.active = false, this.size = 46});

  final IconData icon;
  final VoidCallback onTap;
  final Color color;
  final bool active;
  final double size;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          boxShadow: active ? [BoxShadow(color: color.withValues(alpha: 0.55), blurRadius: 14)] : null,
        ),
        child: HudGlass(
          tint: active ? color.withValues(alpha: 0.32) : null,
          borderColor: active ? color : null,
          child: Icon(icon, color: color, size: size * 0.48),
        ),
      ),
    );
  }
}

/// Wall clock for the top bar.
class HudClock extends StatefulWidget {
  const HudClock({super.key});

  @override
  State<HudClock> createState() => _HudClockState();
}

class _HudClockState extends State<HudClock> {
  late DateTime _now = DateTime.now();
  Timer? _t;

  @override
  void initState() {
    super.initState();
    _t = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() => _now = DateTime.now());
    });
  }

  @override
  void dispose() {
    _t?.cancel();
    super.dispose();
  }

  String _two(int v) => v.toString().padLeft(2, '0');

  @override
  Widget build(BuildContext context) {
    return Text(
      '${_now.year}-${_two(_now.month)}-${_two(_now.day)}  ${_two(_now.hour)}:${_two(_now.minute)}:${_two(_now.second)}',
      style: const TextStyle(color: Bwc.text, fontSize: 12, fontWeight: FontWeight.w600, letterSpacing: 0.5, fontFeatures: [FontFeature.tabularFigures()], shadows: [Shadow(blurRadius: 6, color: Colors.black)]),
    );
  }
}
