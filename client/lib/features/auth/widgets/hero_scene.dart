import 'dart:math' as math;
import 'dart:ui' as ui;
import 'package:flutter/material.dart';

const _ink = Color(0xFF07051A), _lilac = Color(0xFFB79CFF), _amber = Color(0xFFFFC857);

/// Backdrop: deep ink, slow aurora, a perspective floor grid that glides toward you and a few drifting particles.
/// No clip-art: depth comes from light, motion and one vanishing point under the viewfinder.
class HeroBackground extends StatelessWidget {
  const HeroBackground({super.key, required this.t, required this.focus});
  final Animation<double> t;
  final Alignment focus; // where the viewfinder sits (the vanishing point is below it)
  @override
  Widget build(BuildContext context) => RepaintBoundary(
        child: AnimatedBuilder(animation: t, builder: (_, _) => CustomPaint(painter: _BgPainter(t.value, focus), size: Size.infinite)),
      );
}

class _BgPainter extends CustomPainter {
  _BgPainter(this.t, this.focus);
  final double t;
  final Alignment focus;
  static final _dots = () { final r = math.Random(3); return List.generate(40, (_) => (r.nextDouble(), r.nextDouble(), .5 + r.nextDouble() * 1.4, r.nextDouble())); }();

  @override
  void paint(Canvas canvas, Size s) {
    final rect = Offset.zero & s;
    canvas.drawRect(rect, Paint()..shader = ui.Gradient.linear(Offset.zero, Offset(0, s.height), const [_ink, Color(0xFF140A3E), Color(0xFF0B1238)], const [0, .55, 1]));
    final c = Offset(s.width * (.5 + focus.x * .5), s.height * (.5 + focus.y * .5));
    // aurora: two soft light pools that breathe
    final a = math.sin(t * math.pi * 2 * 2);
    canvas.drawCircle(c.translate(-s.width * .18, s.height * .06 * a), s.shortestSide * .9, Paint()..shader = ui.Gradient.radial(c, s.shortestSide * .9, [const Color(0x553C22C8), const Color(0x00000000)]));
    canvas.drawCircle(c.translate(s.width * .25, s.height * .22), s.shortestSide * .7, Paint()..shader = ui.Gradient.radial(c.translate(s.width * .25, s.height * .22), s.shortestSide * .7, [const Color(0x2A2F7BFF), const Color(0x00000000)]));
    canvas.drawCircle(Offset(c.dx, s.height * 1.02), s.width * .8, Paint()..shader = ui.Gradient.radial(Offset(c.dx, s.height * 1.02), s.width * .8, [const Color(0x30FFC857), const Color(0x00000000)]));
    // perspective floor
    final hy = s.height * .60, vp = Offset(c.dx, hy);
    final grid = Paint()..strokeWidth = 1..style = PaintingStyle.stroke;
    for (var i = -14; i <= 14; i++) {
      final x = vp.dx + i * s.width * .16;
      grid.shader = ui.Gradient.linear(vp, Offset(x, s.height), [_lilac.withValues(alpha: 0), _lilac.withValues(alpha: .22)]);
      canvas.drawLine(vp, Offset(vp.dx + (x - vp.dx) * 3.2, s.height + 400), grid);
    }
    for (var i = 0; i < 9; i++) {
      final p = ((i + t * 14 % 1) / 9);               // 0 at the horizon, 1 near us
      final y = hy + math.pow(p, 2.1) * (s.height - hy) * 1.15;
      canvas.drawLine(Offset(0, y), Offset(s.width, y), Paint()..strokeWidth = 1..color = _lilac.withValues(alpha: .05 + p * .20));
    }
    canvas.drawRect(Rect.fromLTWH(0, hy - 2, s.width, 2), Paint()..shader = ui.Gradient.linear(Offset(0, hy), Offset(s.width, hy), [const Color(0x00B79CFF), const Color(0x66B79CFF), const Color(0x00B79CFF)], const [0, .5, 1]));
    // horizon fade into the floor so the form stays readable
    canvas.drawRect(Rect.fromLTWH(0, hy, s.width, s.height - hy), Paint()..shader = ui.Gradient.linear(Offset(0, hy), Offset(0, s.height), const [Color(0x00000000), Color(0x9907051A)]));
    // particles
    for (final d in _dots) {
      final y = ((d.$2 - t * (.015 + d.$4 * .03)) % 1) * s.height;
      final al = (.15 + .5 * (.5 + .5 * math.sin((t * 5 + d.$4 * 7) * math.pi))).clamp(0.0, 1.0);
      canvas.drawCircle(Offset(d.$1 * s.width, y), d.$3, Paint()..color = Colors.white.withValues(alpha: al * .5));
    }
  }

  @override
  bool shouldRepaint(_BgPainter o) => o.t != t;
}

/// The hero: a real-looking camera iris inside a viewfinder with a live HUD. [burst] 0..1 opens the iris wide (sign-in success).
class ApertureHero extends StatelessWidget {
  const ApertureHero({super.key, required this.t, required this.burst, required this.size, this.signal = 'VG-01'});
  final Animation<double> t, burst;
  final double size;
  final String signal;
  @override
  Widget build(BuildContext context) => RepaintBoundary(
        child: SizedBox(width: size, height: size, child: CustomPaint(painter: _AperturePainter(t, burst, signal))),
      );
}

class _AperturePainter extends CustomPainter {
  _AperturePainter(this.t, this.burst, this.signal) : super(repaint: Listenable.merge([t, burst]));
  final Animation<double> t, burst;
  final String signal;

  void _text(Canvas c, String s, Offset at, {Alignment a = Alignment.topLeft, double alpha = .6, double size = 10, Color color = Colors.white}) {
    final tp = TextPainter(text: TextSpan(text: s, style: TextStyle(color: color.withValues(alpha: alpha), fontSize: size, fontWeight: FontWeight.w700, letterSpacing: 1.4, fontFeatures: const [FontFeature.tabularFigures()])), textDirection: TextDirection.ltr)..layout();
    tp.paint(c, Offset(at.dx - tp.width * (a.x + 1) / 2, at.dy - tp.height * (a.y + 1) / 2));
  }

  @override
  void paint(Canvas canvas, Size s) {
    final time = t.value, b = Curves.easeInOutCubic.transform(burst.value);
    final c = s.center(Offset.zero);
    final R = s.width * .40;
    final open = ((.40 + .07 * math.sin(time * math.pi * 2 * 7)) * (1 - b) + 1.0 * b).clamp(0.0, 1.0);

    // glow under everything
    canvas.drawCircle(c, R * (1.25 + b * .6), Paint()..shader = ui.Gradient.radial(c, R * (1.25 + b * .6), [Color.lerp(const Color(0x667A52FF), const Color(0xAAFFC857), b)!, const Color(0x00000000)]));

    // dial: 72 ticks that turn slowly
    canvas.save();
    canvas.translate(c.dx, c.dy);
    canvas.rotate(time * math.pi * 2 * .5);
    for (var i = 0; i < 72; i++) {
      final a = i / 72 * math.pi * 2, major = i % 6 == 0;
      final r1 = R * 1.12, r2 = r1 + (major ? 12 : 6);
      canvas.drawLine(Offset(math.cos(a) * r1, math.sin(a) * r1), Offset(math.cos(a) * r2, math.sin(a) * r2), Paint()..strokeWidth = major ? 1.6 : 1..color = _lilac.withValues(alpha: major ? .6 : .26));
    }
    canvas.restore();
    // ring with an amber comet travelling around it
    canvas.drawCircle(c, R * 1.04, Paint()..style = PaintingStyle.stroke..strokeWidth = 1.2..color = _lilac.withValues(alpha: .35));
    canvas.save();
    canvas.translate(c.dx, c.dy);
    canvas.rotate(-time * math.pi * 2 * 3);
    canvas.drawArc(Rect.fromCircle(center: Offset.zero, radius: R * 1.04), 0, math.pi * .55, false, Paint()..style = PaintingStyle.stroke..strokeWidth = 3..strokeCap = StrokeCap.round..shader = ui.Gradient.sweep(Offset.zero, [_amber.withValues(alpha: 0), _amber], const [0, 1], TileMode.clamp, 0, math.pi * .55));
    canvas.restore();

    // iris: 8 blades around an octagonal opening that twists as it opens
    const n = 8;
    final ro = R * .98, ri = R * (.10 + .66 * open), twist = (1 - open) * .62 + time * .0;
    Offset on(int k) => c + Offset(math.cos(k / n * math.pi * 2 - math.pi / 2), math.sin(k / n * math.pi * 2 - math.pi / 2)) * ro;
    Offset inn(int k) => c + Offset(math.cos(k / n * math.pi * 2 - math.pi / 2 + twist), math.sin(k / n * math.pi * 2 - math.pi / 2 + twist)) * ri;
    canvas.save();
    canvas.clipPath(Path()..addOval(Rect.fromCircle(center: c, radius: ro)));
    for (var k = 0; k < n; k++) {
      final p = Path()..moveTo(on(k).dx, on(k).dy)..lineTo(on(k + 1).dx, on(k + 1).dy)..lineTo(inn(k + 1).dx, inn(k + 1).dy)..lineTo(inn(k).dx, inn(k).dy)..close();
      final shade = .5 + .5 * math.sin(k * 1.9 + 1);
      canvas.drawPath(p, Paint()..shader = ui.Gradient.linear(on(k), inn(k), [Color.lerp(const Color(0xFF3A2A9A), const Color(0xFF1D1260), shade)!, const Color(0xFF0B0724)]));
      canvas.drawPath(p, Paint()..style = PaintingStyle.stroke..strokeWidth = 1.1..color = Colors.white.withValues(alpha: .13));
    }
    canvas.restore();
    // pupil: what the camera sees
    final pr = ri * .985;
    canvas.drawCircle(c, pr, Paint()..shader = ui.Gradient.radial(c.translate(-pr * .2, -pr * .25), pr * 1.25, [const Color(0xFF6A4DFF), const Color(0xFF1B1155), const Color(0xFF05030F)], const [0, .5, 1]));
    canvas.drawCircle(c.translate(-pr * .32, -pr * .34), pr * .13, Paint()..color = Colors.white.withValues(alpha: .8));
    canvas.drawCircle(c, pr, Paint()..style = PaintingStyle.stroke..strokeWidth = 2..color = Color.lerp(_lilac.withValues(alpha: .6), _amber, b)!);

    // viewfinder brackets
    final f = s.width * .5 - 4, len = s.width * .075, bp = Paint()..style = PaintingStyle.stroke..strokeWidth = 2.2..strokeCap = StrokeCap.round..color = Colors.white.withValues(alpha: .75);
    for (final sx in [-1.0, 1.0]) {
      for (final sy in [-1.0, 1.0]) {
        final corner = c + Offset(sx * f, sy * f);
        canvas.drawLine(corner, corner + Offset(-sx * len, 0), bp);
        canvas.drawLine(corner, corner + Offset(0, -sy * len), bp);
      }
    }
    // scan line
    final sy = c.dy - f + ((time * 3) % 1) * f * 2;
    canvas.drawRect(Rect.fromLTWH(c.dx - f, sy - 1, f * 2, 2), Paint()..shader = ui.Gradient.linear(Offset(c.dx - f, sy), Offset(c.dx + f, sy), [_lilac.withValues(alpha: 0), _lilac.withValues(alpha: .5 * (1 - b)), _lilac.withValues(alpha: 0)], const [0, .5, 1]));
    // HUD
    final blink = .35 + .65 * (.5 + .5 * math.sin(time * math.pi * 2 * 14));
    canvas.drawCircle(c + Offset(-f + 8, -f - 14), 3.4, Paint()..color = const Color(0xFFFF5D77).withValues(alpha: blink)..maskFilter = const MaskFilter.blur(BlurStyle.normal, 2));
    _text(canvas, 'REC', c + Offset(-f + 16, -f - 14), a: Alignment.centerLeft, alpha: .8);
    final secs = (time * 14).floor();
    _text(canvas, '00:00:${secs.toString().padLeft(2, '0')}', c + Offset(f, -f - 14), a: Alignment.centerRight);
    _text(canvas, '24.7136°N  46.6753°E', c + Offset(-f, f + 14), a: Alignment.centerLeft, alpha: .45);
    _text(canvas, signal, c + Offset(f, f + 14), a: Alignment.centerRight, alpha: .45);
  }

  @override
  bool shouldRepaint(_AperturePainter o) => false;
}
