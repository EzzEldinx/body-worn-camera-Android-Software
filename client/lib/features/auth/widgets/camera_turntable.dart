import 'dart:math' as math;
import 'package:flutter/material.dart';

/// The real body camera, alive: it floats and sways, a light sweep glides across its body, and every few seconds it turns
/// to the next angle (3D flip-fade). All the photos are transparent cut-outs with the Smart Way logo on the back plate.
class CameraTurntable extends StatefulWidget {
  const CameraTurntable({super.key, required this.t, required this.box, this.enter});
  final Animation<double> t;     // the login's 0..1 loop (14 s)
  final Animation<double>? enter; // 0..1 entrance
  final Size box;
  static const views = ['front_a', 'top_a', 'front_b', 'top_b', 'back_a', 'back_b'];
  @override
  State<CameraTurntable> createState() => _CameraTurntableState();
}

class _CameraTurntableState extends State<CameraTurntable> {
  static const _hold = 3.0, _swap = .9; // seconds per angle, seconds of transition
  late final Stopwatch _clock = Stopwatch()..start();
  bool _warmed = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_warmed) return;
    _warmed = true;
    for (final v in CameraTurntable.views) { precacheImage(AssetImage('assets/camera/$v.png'), context); }
  }

  Widget _photo(String v, {double fadeIn = 1, double turn = 0, double side = 1}) {
    final w = widget.box.width, h = widget.box.height;
    return Opacity(
      opacity: fadeIn.clamp(0, 1),
      child: Transform(
        alignment: Alignment.center,
        transform: Matrix4.identity()..setEntry(3, 2, .0012)..rotateY(turn * side)..scaleByDouble(1 - turn.abs() * .12, 1 - turn.abs() * .12, 1, 1),
        child: Image.asset('assets/camera/$v.png', width: w, height: h, fit: BoxFit.contain, filterQuality: FilterQuality.medium, gaplessPlayback: true),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final reduce = MediaQuery.of(context).disableAnimations;
    return AnimatedBuilder(
      animation: Listenable.merge([widget.t, if (widget.enter != null) widget.enter!]),
      builder: (_, _) {
        final secs = reduce ? 0.0 : _clock.elapsedMilliseconds / 1000.0;
        const n = 6;
        final slot = _hold + _swap;
        final idx = (secs / slot).floor() % n, next = (idx + 1) % n;
        final p = secs % slot;
        final k = p < _hold ? 0.0 : Curves.easeInOutCubic.transform(((p - _hold) / _swap).clamp(0, 1));
        final loop = widget.t.value * math.pi * 2;
        final float = math.sin(loop * 7) * 7;                  // slow bob (7 cycles / 14 s)
        final sway = math.sin(loop * 3) * .06;                 // gentle yaw
        final tilt = math.cos(loop * 5) * .025;
        final e = widget.enter == null ? 1.0 : Curves.easeOutBack.transform(widget.enter!.value.clamp(0, 1));
        final sweep = (widget.t.value * 7 % 1);                // light sweep, once per bob

        final stack = Stack(alignment: Alignment.center, children: [
          if (k < 1) _photo(CameraTurntable.views[idx], fadeIn: 1 - k, turn: -k * 1.1),
          if (k > 0) _photo(CameraTurntable.views[next], fadeIn: k, turn: (1 - k) * 1.1),
        ]);
        // light sweep only over the camera's own pixels (srcATop keeps the transparent background clear)
        final shiny = ShaderMask(
          blendMode: BlendMode.srcATop,
          shaderCallback: (r) => LinearGradient(
            begin: Alignment(-1.6 + sweep * 3.6, -1), end: Alignment(-.9 + sweep * 3.6, 1),
            colors: const [Color(0x00FFFFFF), Color(0x33FFFFFF), Color(0x00FFFFFF)], stops: const [0, .5, 1],
          ).createShader(r),
          child: stack,
        );
        return Opacity(
          opacity: e.clamp(0, 1),
          child: Transform.translate(
            offset: Offset(0, float + (1 - e) * 40),
            child: Transform(
              alignment: Alignment.center,
              transform: Matrix4.identity()..setEntry(3, 2, .001)..rotateY(sway)..rotateZ(tilt)..scaleByDouble(.9 + .1 * e, .9 + .1 * e, 1, 1),
              child: SizedBox(width: widget.box.width, height: widget.box.height, child: shiny),
            ),
          ),
        );
      },
    );
  }
}
