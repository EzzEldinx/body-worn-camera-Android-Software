import 'package:flutter/material.dart';
import '../../core/api/models.dart';
import '../../core/l10n/strings.dart';
import '../../core/theme/vg_theme.dart';
import '../../core/widgets/widgets.dart';

class CameraTile extends StatelessWidget {
  const CameraTile({super.key, required this.cam, required this.onTap, required this.onWatch, this.selected = false, this.sos = false});
  final Camera cam;
  final bool selected, sos;
  final VoidCallback onTap, onWatch;

  @override
  Widget build(BuildContext context) {
    final v = context.vg;
    final color = sos ? v.rec : stateColor(context, cam.state);
    final gps = cam.hasPosition
        ? (cam.gpsFresh ? 'GPS ±${(cam.acc ?? 0).round()} m' : context.tr('gps_stale'))
        : context.tr('no_gps');
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: VgCard(
        onTap: onTap,
        padding: const EdgeInsets.fromLTRB(12, 12, 10, 12),
        border: sos ? v.rec : (selected ? v.sel : null),
        glow: sos ? v.rec : (selected ? v.sel : null),
        child: Row(children: [
          Container(
            width: 48, height: 48,
            decoration: BoxDecoration(shape: BoxShape.circle, color: color.withValues(alpha: .13), border: Border.all(color: color.withValues(alpha: .5), width: 1.6)),
            child: Stack(alignment: Alignment.center, children: [
              Icon(sos ? Icons.sos_rounded : Icons.videocam_rounded, color: color, size: 24),
              if (cam.state != CamState.off) PositionedDirectional(end: 2, top: 2, child: StatusDot(color: color, pulse: cam.recording || sos, size: 10)),
            ]),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Flexible(child: Text(cam.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15.5))),
                if (sos) ...[const SizedBox(width: 8), StatusPill(label: context.tr('sos'), color: v.rec, pulse: true)],
              ]),
              const SizedBox(height: 3),
              Text('${stateLabel(context, cam.state)}  ·  ${agoText(context, cam.ts)}', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: v.mut, fontSize: 12.5, fontWeight: FontWeight.w600)),
              const SizedBox(height: 2),
              Row(children: [
                Flexible(child: Text(gps, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: v.mut.withValues(alpha: .8), fontSize: 12))),
                if (cam.battery != null) ...[
                  const SizedBox(width: 8),
                  Icon(cam.battery! < 20 ? Icons.battery_alert_rounded : Icons.battery_full_rounded, size: 14, color: cam.battery! < 20 ? v.rec : v.mut),
                  const SizedBox(width: 2),
                  Text(ltr('${cam.battery}%'), style: TextStyle(fontSize: 12, fontWeight: FontWeight.w800, color: cam.battery! < 20 ? v.rec : v.mut)),
                ],
              ]),
            ]),
          ),
          const SizedBox(width: 8),
          _WatchButton(enabled: cam.online, onTap: onWatch),
        ]),
      ),
    );
  }
}

class _WatchButton extends StatelessWidget {
  const _WatchButton({required this.enabled, required this.onTap});
  final bool enabled;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final v = context.vg;
    return Semantics(
      button: true, label: context.tr('watch_live'), enabled: enabled,
      child: GestureDetector(
        onTap: enabled ? onTap : null,
        child: Container(
          width: 46, height: 46,
          decoration: BoxDecoration(shape: BoxShape.circle, gradient: enabled ? v.cta : null, color: enabled ? null : v.raise, border: enabled ? null : Border.all(color: v.line),
            boxShadow: enabled ? [BoxShadow(color: const Color(0xFFFFB300).withValues(alpha: .38), blurRadius: 12, offset: const Offset(0, 4))] : null),
          child: Icon(Icons.play_arrow_rounded, size: 28, color: enabled ? v.selInk : v.off),
        ),
      ),
    );
  }
}
