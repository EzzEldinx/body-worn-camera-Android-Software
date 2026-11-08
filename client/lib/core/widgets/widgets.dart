import 'package:flutter/material.dart';
import '../api/models.dart';
import '../l10n/strings.dart';
import '../theme/vg_theme.dart';

Color stateColor(BuildContext c, CamState s) => switch (s) { CamState.rec => c.vg.rec, CamState.online => c.vg.ok, CamState.off => c.vg.off };
String stateLabel(BuildContext c, CamState s) => c.tr(switch (s) { CamState.rec => 'st_rec', CamState.online => 'st_online', CamState.off => 'st_off' });

/// Brand wordmark that follows the theme (dark logo on light, light logo on dark).
class VgLogo extends StatelessWidget {
  const VgLogo({super.key, this.height = 30});
  final double height;
  @override
  Widget build(BuildContext context) => Image.asset(context.isDark ? 'assets/brand/visionguard-logo-light.png' : 'assets/brand/visionguard-logo-sm.png', height: height, fit: BoxFit.contain);
}

class VgCard extends StatelessWidget {
  const VgCard({super.key, required this.child, this.padding = const EdgeInsets.all(16), this.onTap, this.border, this.glow});
  final Widget child;
  final EdgeInsetsGeometry padding;
  final VoidCallback? onTap;
  final Color? border, glow;
  @override
  Widget build(BuildContext context) {
    final v = context.vg;
    return Container(
      decoration: BoxDecoration(
        color: v.panel, borderRadius: BorderRadius.circular(kRadius), border: Border.all(color: border ?? v.line),
        boxShadow: glow != null ? [BoxShadow(color: glow!.withValues(alpha: .35), blurRadius: 18, spreadRadius: 0)] : v.shadowSm,
      ),
      child: Material(
        color: Colors.transparent,
        child: InkWell(borderRadius: BorderRadius.circular(kRadius), onTap: onTap, child: Padding(padding: padding, child: child)),
      ),
    );
  }
}

/// Status dot with a soft glow; pulses while the camera is recording.
class StatusDot extends StatefulWidget {
  const StatusDot({super.key, required this.color, this.pulse = false, this.size = 12});
  final Color color;
  final bool pulse;
  final double size;
  @override
  State<StatusDot> createState() => _StatusDotState();
}

class _StatusDotState extends State<StatusDot> with SingleTickerProviderStateMixin {
  late final AnimationController _a = AnimationController(vsync: this, duration: const Duration(milliseconds: 1400));
  @override
  void initState() { super.initState(); if (widget.pulse) _a.repeat(); }
  @override
  void didUpdateWidget(StatusDot o) { super.didUpdateWidget(o); if (widget.pulse && !_a.isAnimating) { _a.repeat(); } else if (!widget.pulse) { _a.stop(); } }
  @override
  void dispose() { _a.dispose(); super.dispose(); }
  @override
  Widget build(BuildContext context) => AnimatedBuilder(
        animation: _a,
        builder: (_, _) => Container(
          width: widget.size, height: widget.size,
          decoration: BoxDecoration(shape: BoxShape.circle, color: widget.color, boxShadow: [
            BoxShadow(color: widget.color.withValues(alpha: widget.pulse ? .55 * (1 - _a.value) : .35), blurRadius: 2 + (widget.pulse ? 14 * _a.value : 4), spreadRadius: widget.pulse ? 6 * _a.value : 1),
          ]),
        ),
      );
}

class StatusPill extends StatelessWidget {
  const StatusPill({super.key, required this.label, required this.color, this.pulse = false});
  final String label;
  final Color color;
  final bool pulse;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        decoration: BoxDecoration(color: color.withValues(alpha: .14), borderRadius: BorderRadius.circular(99)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          StatusDot(color: color, pulse: pulse, size: 7),
          const SizedBox(width: 6),
          Text(label, style: TextStyle(color: color, fontWeight: FontWeight.w800, fontSize: 11.5, letterSpacing: .3)),
        ]),
      );
}

class KpiTile extends StatelessWidget {
  const KpiTile({super.key, required this.icon, required this.value, required this.label, required this.color, this.hot = false});
  final IconData icon;
  final String value, label;
  final Color color;
  final bool hot;
  @override
  Widget build(BuildContext context) {
    final v = context.vg;
    return VgCard(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      border: hot ? color.withValues(alpha: .6) : null, glow: hot ? color : null,
      child: Row(children: [
        Container(width: 38, height: 38, decoration: BoxDecoration(color: color.withValues(alpha: .15), borderRadius: BorderRadius.circular(12)), child: Icon(icon, color: color, size: 20)),
        const SizedBox(width: 10),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
          Text(value, style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800, height: 1, color: hot ? color : v.text, fontFeatures: const [FontFeature.tabularFigures()])),
          const SizedBox(height: 3),
          Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 11, color: v.mut, fontWeight: FontWeight.w700, letterSpacing: .3)),
        ])),
      ]),
    );
  }
}

/// Amber call-to-action (the dashboard's primary button).
class CtaButton extends StatelessWidget {
  const CtaButton({super.key, required this.label, required this.onTap, this.icon, this.compact = false, this.loading = false});
  final String label;
  final VoidCallback? onTap;
  final IconData? icon;
  final bool compact, loading;
  @override
  Widget build(BuildContext context) {
    final v = context.vg;
    final enabled = onTap != null && !loading;
    return Opacity(
      opacity: enabled ? 1 : .55,
      child: Container(
        decoration: BoxDecoration(gradient: v.cta, borderRadius: BorderRadius.circular(compact ? 12 : 14), boxShadow: [BoxShadow(color: const Color(0xFFFFB300).withValues(alpha: .38), blurRadius: 14, offset: const Offset(0, 5))]),
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            borderRadius: BorderRadius.circular(compact ? 12 : 14),
            onTap: enabled ? onTap : null,
            child: Padding(
              padding: EdgeInsets.symmetric(horizontal: compact ? 14 : 22, vertical: compact ? 10 : 15),
              child: Row(mainAxisSize: MainAxisSize.min, mainAxisAlignment: MainAxisAlignment.center, children: [
                if (loading) SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2.4, color: v.selInk))
                else if (icon != null) Icon(icon, size: 20, color: v.selInk),
                if (loading || icon != null) const SizedBox(width: 8),
                Text(label, style: TextStyle(color: v.selInk, fontWeight: FontWeight.w800, fontSize: compact ? 14 : 16)),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

/// Small section header with the dashboard's gradient tick.
class SectionTitle extends StatelessWidget {
  const SectionTitle(this.text, {super.key, this.trailing});
  final String text;
  final Widget? trailing;
  @override
  Widget build(BuildContext context) {
    final v = context.vg;
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 18, 4, 10),
      child: Row(children: [
        Container(width: 4, height: 15, decoration: BoxDecoration(borderRadius: BorderRadius.circular(2), gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [v.sel, v.brand]))),
        const SizedBox(width: 9),
        Expanded(child: Text(text.toUpperCase(), style: TextStyle(color: v.mut, fontWeight: FontWeight.w800, fontSize: 12, letterSpacing: 1))),
        ?trailing,
      ]),
    );
  }
}

class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.icon, required this.title, this.subtitle, this.action});
  final IconData icon;
  final String title;
  final String? subtitle;
  final Widget? action;
  @override
  Widget build(BuildContext context) {
    final v = context.vg;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(width: 76, height: 76, decoration: BoxDecoration(shape: BoxShape.circle, color: v.raise, border: Border.all(color: v.line)), child: Icon(icon, size: 34, color: v.mut)),
          const SizedBox(height: 18),
          Text(title, textAlign: TextAlign.center, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800)),
          if (subtitle != null) ...[const SizedBox(height: 8), Text(subtitle!, textAlign: TextAlign.center, style: TextStyle(color: v.mut, height: 1.45))],
          if (action != null) ...[const SizedBox(height: 18), action!],
        ]),
      ),
    );
  }
}

/// Branded top bar: logo, optional actions and the purple-blue-amber strip.
class BrandBar extends StatelessWidget implements PreferredSizeWidget {
  const BrandBar({super.key, this.title, this.actions});
  final String? title;
  final List<Widget>? actions;
  @override
  Size get preferredSize => const Size.fromHeight(60);
  @override
  Widget build(BuildContext context) {
    final v = context.vg;
    return Container(
      decoration: BoxDecoration(color: v.panel, boxShadow: v.shadowSm),
      child: SafeArea(
        bottom: false,
        child: Stack(children: [
          SizedBox(
            height: 58,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Row(children: [
                if (title == null) const VgLogo(height: 28) else Text(title!, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
                const Spacer(),
                ...?actions,
              ]),
            ),
          ),
          Positioned(left: 0, right: 0, bottom: 0, child: Container(height: 2, decoration: BoxDecoration(gradient: v.strip))),
        ]),
      ),
    );
  }
}

/// Keeps numbers, dates and coordinates in reading order inside Arabic (RTL) text.
String ltr(String s) => '\u2066$s\u2069';
String two(int n) => n.toString().padLeft(2, '0');
String when(int ts) {
  final d = DateTime.fromMillisecondsSinceEpoch(ts);
  return ltr('${d.year}-${two(d.month)}-${two(d.day)}  ${two(d.hour)}:${two(d.minute)}');
}
String fmtBytes(int b) {
  if (b >= 1e9) return ltr('${(b / 1e9).toStringAsFixed(1)} GB');
  if (b >= 1e6) return ltr('${(b / 1e6).round()} MB');
  return ltr('${(b / 1e3).round()} KB');
}
