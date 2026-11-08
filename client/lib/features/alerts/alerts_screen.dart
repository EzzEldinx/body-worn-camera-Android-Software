import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/api/fleet.dart';
import '../../core/api/models.dart';
import '../../core/l10n/strings.dart';
import '../../core/theme/vg_theme.dart';
import '../../core/widgets/widgets.dart';
import '../live/watch.dart';

class AlertsScreen extends ConsumerWidget {
  const AlertsScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(fleetProvider);
    final wide = MediaQuery.sizeOf(context).width >= 720;
    return Scaffold(
      appBar: BrandBar(title: context.tr('tab_alerts')),
      body: s.alarms.isEmpty
          ? EmptyState(icon: Icons.notifications_none_rounded, title: context.tr('alerts_empty'))
          : ListView.builder(
              padding: const EdgeInsets.all(16),
              itemCount: s.alarms.length,
              itemBuilder: (_, i) => Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: AlarmCard(alarm: s.alarms[i], cam: s.cams[s.alarms[i].cameraId], wide: wide),
              ),
            ),
    );
  }
}

class AlarmCard extends ConsumerWidget {
  const AlarmCard({super.key, required this.alarm, required this.cam, this.wide = false});
  final Alarm alarm;
  final Camera? cam;
  final bool wide;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final v = context.vg;
    final open = !alarm.ack;
    final color = open ? v.rec : v.off;
    final name = cam?.name ?? alarm.cameraId;
    return VgCard(
      border: open ? v.rec.withValues(alpha: .6) : null, glow: open ? v.rec : null,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Container(width: 42, height: 42, decoration: BoxDecoration(color: color.withValues(alpha: .14), shape: BoxShape.circle), child: Icon(Icons.sos_rounded, color: color)),
          const SizedBox(width: 12),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${context.tr('sos_from')} $name', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 15.5, color: open ? v.text : v.mut)),
            const SizedBox(height: 2),
            Text('${agoText(context, alarm.ts)}  ·  ${when(alarm.ts)}', style: TextStyle(color: v.mut, fontSize: 12.5)),
          ])),
          StatusPill(label: context.tr(open ? 'active' : 'acked'), color: color, pulse: open),
        ]),
        const SizedBox(height: 12),
        Wrap(spacing: 8, runSpacing: 8, children: [
          if (open) CtaButton(compact: true, label: context.tr('ack'), icon: Icons.check_rounded, onTap: () { HapticFeedback.mediumImpact(); ref.read(fleetProvider.notifier).ack(alarm.id); }),
          if (cam?.online ?? false) OutlinedButton.icon(
            onPressed: () { ref.read(watchProvider.notifier).add(alarm.cameraId, max: wide ? 4 : 1); context.push('/watch/${alarm.cameraId}'); },
            icon: const Icon(Icons.play_circle_outline_rounded), label: Text(context.tr('open_live')),
          ),
          if (alarm.lat != null && alarm.lng != null) OutlinedButton.icon(
            onPressed: () => context.go('/map?cam=${alarm.cameraId}'),
            icon: const Icon(Icons.place_outlined), label: Text(context.tr('show_map')),
          ),
        ]),
      ]),
    );
  }
}
