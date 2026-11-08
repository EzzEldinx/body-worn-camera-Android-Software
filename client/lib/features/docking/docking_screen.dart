import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/api/api.dart';
import '../../core/api/models.dart';
import '../../core/l10n/strings.dart';
import '../../core/theme/vg_theme.dart';
import '../../core/widgets/widgets.dart';
import '../auth/auth_controller.dart';

/// Polls the dock state every second while the screen is open (the Dock Agent reports progress about every 1.5 s).
final dockingProvider = StreamProvider.autoDispose<DockState>((ref) async* {
  final s = ref.watch(sessionProvider);
  if (s == null) return;
  var first = true;
  while (true) {
    try {
      yield await s.api.docks();
      first = false;
    } on ApiError catch (e) {
      if (first || e.unauthorized) rethrow; // after the first good answer a blip just keeps the last picture
    }
    await Future<void>.delayed(const Duration(seconds: 1));
  }
});

class DockingScreen extends ConsumerStatefulWidget {
  const DockingScreen({super.key});
  @override
  ConsumerState<DockingScreen> createState() => _DockingScreenState();
}

class _DockingScreenState extends ConsumerState<DockingScreen> {
  String? _dockId;

  @override
  Widget build(BuildContext context) {
    final v = context.vg;
    final data = ref.watch(dockingProvider);
    return Scaffold(
      appBar: AppBar(title: Text(context.tr('dock_title'))),
      body: data.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => EmptyState(icon: Icons.cloud_off_rounded, title: context.tr('load_failed'), action: OutlinedButton(onPressed: () => ref.invalidate(dockingProvider), child: Text(context.tr('retry')))),
        data: (d) {
          final docks = [...d.docks]..sort((a, b) => b.ts.compareTo(a.ts));
          final dock = docks.where((x) => x.id == _dockId).firstOrNull ?? docks.firstOrNull;
          final cams = dock?.cameras ?? const <DockCam>[];
          final bySlot = {for (final c in cams) c.slot: c};
          final total = math.max(d.slots, bySlot.keys.fold<int>(0, (m, k) => math.max(m, k + 1)));
          final mine = cams.where((c) => c.state != 'other').length;
          final busy = cams.where((c) => c.state == 'offloading').length;
          final width = MediaQuery.sizeOf(context).width;
          final cols = width >= 1100 ? 4 : width >= 700 ? 3 : 2;
          final usedPct = (d.totalBytes != null && d.freeBytes != null && d.totalBytes! > 0) ? ((d.totalBytes! - d.freeBytes!) / d.totalBytes!).clamp(0.0, 1.0) : 0.0;
          return ListView(padding: const EdgeInsets.all(16), children: [
            Text(context.tr('dock_sub'), style: TextStyle(color: v.mut, height: 1.4)),
            const SizedBox(height: 12),
            _AgentPill(dock: dock, enabled: d.enabled),
            const SizedBox(height: 14),
            Row(children: [
              Expanded(child: KpiTile(icon: Icons.dock_rounded, value: '${docks.where((x) => x.status == 'online').length}/${docks.length}', label: context.tr('dock_docks_online'), color: v.blue)),
              const SizedBox(width: 8),
              Expanded(child: KpiTile(icon: Icons.power_rounded, value: '$mine', label: context.tr('dock_docked'), color: v.ok)),
            ]),
            const SizedBox(height: 8),
            Row(children: [
              Expanded(child: KpiTile(icon: Icons.bolt_rounded, value: '$busy', label: context.tr('dock_offloading_now'), color: v.sel)),
              const SizedBox(width: 8),
              Expanded(child: KpiTile(icon: Icons.folder_rounded, value: '${d.todayCount}', label: context.tr('dock_files_today'), color: v.brand)),
            ]),
            if (docks.length > 1) ...[
              const SizedBox(height: 12),
              Wrap(spacing: 8, children: [for (final x in docks) ChoiceChip(label: Text(x.id), selected: x.id == dock?.id, onSelected: (_) => setState(() => _dockId = x.id))]),
            ],
            const SizedBox(height: 14),
            GridView.count(
              crossAxisCount: cols, shrinkWrap: true, physics: const NeverScrollableScrollPhysics(), crossAxisSpacing: 12, mainAxisSpacing: 12, childAspectRatio: cols == 2 ? .56 : .78,
              children: [for (var i = 0; i < total; i++) _Bay(index: i, cam: bySlot[i])],
            ),
            const SizedBox(height: 16),
            VgCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(context.tr('dock_storage'), style: TextStyle(color: v.mut, fontWeight: FontWeight.w800, fontSize: 12, letterSpacing: .8)),
              const SizedBox(height: 10),
              ClipRRect(borderRadius: BorderRadius.circular(99), child: LinearProgressIndicator(value: usedPct, minHeight: 10, backgroundColor: v.raise, color: v.ok)),
              const SizedBox(height: 10),
              Text('${fmtBytes(d.recordingsBytes)} ${context.tr('dock_evidence')} · ${d.recordings} ${context.tr('files')}${d.freeBytes != null ? '  ·  ${fmtBytes(d.freeBytes!)} ${context.tr('dock_free')}' : ''}', style: const TextStyle(fontWeight: FontWeight.w700)),
            ])),
            const SizedBox(height: 12),
            OutlinedButton.icon(onPressed: () => context.push('/recordings'), icon: const Icon(Icons.video_library_outlined), label: Text(context.tr('view_recordings'))),
          ]);
        },
      ),
    );
  }
}

class _AgentPill extends StatelessWidget {
  const _AgentPill({required this.dock, required this.enabled});
  final Dock? dock;
  final bool enabled;
  @override
  Widget build(BuildContext context) {
    final v = context.vg;
    final st = dock?.status ?? 'none';
    final color = st == 'online' ? v.ok : st == 'connecting' ? v.sel : v.off;
    final label = context.tr(switch (st) { 'online' => 'dock_agent_on', 'connecting' => 'dock_agent_connecting', 'offline' => 'dock_agent_off', _ => 'dock_none' });
    return Align(
      alignment: AlignmentDirectional.centerStart,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        StatusPill(label: dock == null ? label : '$label · ${dock!.id} · ${agoText(context, dock!.ts)}', color: color, pulse: st != 'offline' && st != 'none'),
        if (dock == null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(context.tr('dock_none_sub'), style: TextStyle(color: v.mut, fontSize: 12.5))),
      ]),
    );
  }
}

class _Bay extends StatelessWidget {
  const _Bay({required this.index, required this.cam});
  final int index;
  final DockCam? cam;

  @override
  Widget build(BuildContext context) {
    final v = context.vg;
    final c = cam;
    final state = c == null ? 'idle' : c.state;
    final color = switch (state) { 'offloading' => v.sel, 'synced' => v.ok, 'error' => v.rec, 'connected' => v.blue, _ => v.off };
    final label = context.tr(switch (state) { 'idle' => 'dock_idle', 'offloading' => 'dock_offloading', 'synced' => 'dock_synced', 'error' => 'dock_error', 'other' => 'dock_other', _ => 'dock_ready' });
    final n = '${index + 1}'.padLeft(2, '0');
    final pct = c?.progress ?? 0.0;
    final center = switch (state) {
      'idle' => Text(context.tr('dock_idle'), style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700, color: v.mut, fontFamily: 'serif')),
      'offloading' => Column(mainAxisSize: MainAxisSize.min, children: [Text('${(pct * 100).round()}%', style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800)), Text('${c?.index ?? 0}/${c?.total ?? 0}', style: TextStyle(color: v.mut, fontSize: 11, fontWeight: FontWeight.w700))]),
      'synced' => Icon(Icons.check_rounded, size: 40, color: color),
      'error' => Icon(Icons.warning_amber_rounded, size: 38, color: color),
      'other' => Icon(Icons.power_rounded, size: 34, color: color),
      _ => Icon(Icons.power_rounded, size: 34, color: color),
    };
    final low = (c?.battery ?? 100) < 20;
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 12),
      decoration: BoxDecoration(
        color: v.panel, borderRadius: BorderRadius.circular(20), border: Border.all(color: color.withValues(alpha: state == 'idle' ? .2 : .5)),
        boxShadow: state == 'offloading' || state == 'error' ? [BoxShadow(color: color.withValues(alpha: .3), blurRadius: 16)] : v.shadowSm,
      ),
      child: Column(children: [
        Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
          Text(n, style: TextStyle(color: v.mut, fontWeight: FontWeight.w800, letterSpacing: 1.2, fontSize: 11)),
          Flexible(child: StatusPill(label: label, color: color, pulse: state == 'offloading')),
        ]),
        const Spacer(),
        SizedBox(width: 104, height: 104, child: CustomPaint(painter: _Ring(pct: pct, color: color, track: color.withValues(alpha: .18)), child: Center(child: center))),
        const Spacer(),
        if (state == 'idle') const SizedBox(height: 40)
        else if (state == 'other') Text(context.tr('dock_other_sub'), textAlign: TextAlign.center, style: TextStyle(color: v.mut, fontSize: 11.5))
        else ...[
          Text(c?.cameraId ?? context.tr('dock_unregistered'), maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
          const SizedBox(height: 6),
          Wrap(alignment: WrapAlignment.center, spacing: 6, runSpacing: 4, children: [
            if (c?.battery != null) _Chip(Icons.battery_5_bar_rounded, '${c!.battery}%', low ? v.rec : null),
            if (c?.storageFreeMb != null) _Chip(Icons.sd_storage_rounded, fmtBytes(c!.storageFreeMb! * 1000000)),
            if (c?.files != null) _Chip(Icons.insert_drive_file_outlined, '${c!.files}'),
          ]),
          if (state == 'offloading' && c?.file != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(c!.file!, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: v.mut, fontSize: 10.5))),
          if (state == 'synced') Padding(padding: const EdgeInsets.only(top: 6), child: Text('${c?.synced ?? 0} ${context.tr('files')} · ${agoText(context, c?.lastSyncTs)}', style: TextStyle(color: v.mut, fontSize: 11))),
          if (state == 'error') Padding(padding: const EdgeInsets.only(top: 6), child: Text(c?.message ?? '', maxLines: 2, textAlign: TextAlign.center, overflow: TextOverflow.ellipsis, style: TextStyle(color: v.rec, fontSize: 11))),
        ],
      ]),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip(this.icon, this.text, [this.color]);
  final IconData icon;
  final String text;
  final Color? color;
  @override
  Widget build(BuildContext context) {
    final v = context.vg;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
      decoration: BoxDecoration(color: v.raise, borderRadius: BorderRadius.circular(99), border: Border.all(color: color?.withValues(alpha: .5) ?? v.lineSoft)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [Icon(icon, size: 12, color: color ?? v.mut), const SizedBox(width: 3), Text(text, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: color))]),
    );
  }
}

class _Ring extends CustomPainter {
  _Ring({required this.pct, required this.color, required this.track});
  final double pct;
  final Color color, track;
  @override
  void paint(Canvas canvas, Size size) {
    final r = Rect.fromCircle(center: size.center(Offset.zero), radius: size.width / 2 - 6);
    final base = Paint()..style = PaintingStyle.stroke..strokeWidth = 9..color = track;
    canvas.drawArc(r, 0, math.pi * 2, false, base);
    if (pct > 0) {
      canvas.drawArc(r, -math.pi / 2, math.pi * 2 * pct.clamp(0.0, 1.0), false, Paint()..style = PaintingStyle.stroke..strokeWidth = 9..strokeCap = StrokeCap.round..color = color);
    }
  }
  @override
  bool shouldRepaint(_Ring o) => o.pct != pct || o.color != color;
}
