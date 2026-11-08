import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/api/fleet.dart';
import '../../core/api/models.dart';
import '../../core/l10n/strings.dart';
import '../../core/theme/vg_theme.dart';
import '../../core/widgets/widgets.dart';
import '../live/watch.dart';
import 'camera_detail.dart';
import 'camera_tile.dart';

enum FleetFilter { all, online, rec, off }

class FleetScreen extends ConsumerStatefulWidget {
  const FleetScreen({super.key});
  @override
  ConsumerState<FleetScreen> createState() => _FleetScreenState();
}

class _FleetScreenState extends ConsumerState<FleetScreen> {
  String _q = '';
  FleetFilter _f = FleetFilter.all;

  List<Camera> _visible(FleetState s) {
    final sosIds = {for (final a in s.alarms.where((a) => !a.ack)) a.cameraId};
    final list = s.cams.values.where((c) {
      if (_q.isNotEmpty && !('${c.name} ${c.id}'.toLowerCase().contains(_q.toLowerCase()))) return false;
      return switch (_f) { FleetFilter.all => true, FleetFilter.online => c.online, FleetFilter.rec => c.recording, FleetFilter.off => !c.online };
    }).toList();
    int rank(Camera c) => sosIds.contains(c.id) ? 0 : c.recording ? 1 : c.online ? 2 : 3;
    list.sort((a, b) => rank(a) != rank(b) ? rank(a).compareTo(rank(b)) : a.name.toLowerCase().compareTo(b.name.toLowerCase()));
    return list;
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(fleetProvider);
    final selected = ref.watch(selectedCamProvider);
    final wide = MediaQuery.sizeOf(context).width >= 900;
    final list = _visible(s);
    final sosIds = {for (final a in s.alarms.where((a) => !a.ack)) a.cameraId};

    Widget listPane = CustomScrollView(slivers: [
      SliverPadding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 0),
        sliver: SliverToBoxAdapter(
          child: Row(children: [
            Expanded(child: KpiTile(icon: Icons.wifi_rounded, value: '${s.online}', label: context.tr('kpi_online'), color: context.vg.ok)),
            const SizedBox(width: 8),
            Expanded(child: KpiTile(icon: Icons.sensors_rounded, value: '${s.streaming}', label: context.tr('kpi_rec'), color: context.vg.rec)),
            const SizedBox(width: 8),
            Expanded(child: KpiTile(icon: Icons.notifications_active_rounded, value: '${s.openAlarms}', label: context.tr('kpi_alarms'), color: context.vg.sel, hot: s.openAlarms > 0)),
          ]),
        ),
      ),
      SliverPadding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
        sliver: SliverToBoxAdapter(
          child: Column(children: [
            TextField(
              onChanged: (t) => setState(() => _q = t.trim()),
              decoration: InputDecoration(hintText: context.tr('search_hint'), prefixIcon: Icon(Icons.search_rounded, color: context.vg.mut)),
              textInputAction: TextInputAction.search,
            ),
            const SizedBox(height: 10),
            SingleChildScrollView(scrollDirection: Axis.horizontal, child: Row(children: [
              for (final f in FleetFilter.values) Padding(
                padding: const EdgeInsetsDirectional.only(end: 8),
                child: ChoiceChip(
                  label: Text(context.tr(switch (f) { FleetFilter.all => 'f_all', FleetFilter.online => 'f_online', FleetFilter.rec => 'f_rec', FleetFilter.off => 'f_off' })),
                  selected: _f == f, onSelected: (_) => setState(() => _f = f),
                ),
              ),
            ])),
          ]),
        ),
      ),
      if (!s.loaded)
        const SliverFillRemaining(hasScrollBody: false, child: Center(child: CircularProgressIndicator()))
      else if (list.isEmpty)
        SliverFillRemaining(hasScrollBody: false, child: EmptyState(icon: Icons.videocam_off_outlined, title: context.tr(s.cams.isEmpty ? 'no_cameras' : 'no_match')))
      else
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
          sliver: SliverList.builder(
            itemCount: list.length,
            itemBuilder: (_, i) {
              final c = list[i];
              return CameraTile(
                cam: c, sos: sosIds.contains(c.id), selected: wide && selected == c.id,
                onTap: () { if (wide) { ref.read(selectedCamProvider.notifier).select(c.id); } else { context.push('/camera/${c.id}'); } },
                onWatch: () { ref.read(watchProvider.notifier).add(c.id, max: wide ? 4 : 1); if (wide) { ref.read(selectedCamProvider.notifier).select(c.id); } else { context.push('/watch/${c.id}'); } },
              );
            },
          ),
        ),
    ]);

    return Scaffold(
      appBar: BrandBar(actions: [_ConnDot(connected: s.connected)]),
      body: wide
          ? Row(children: [
              SizedBox(width: 400, child: listPane),
              VerticalDivider(width: 1, color: context.vg.line),
              Expanded(child: selected == null
                  ? EmptyState(icon: Icons.touch_app_outlined, title: context.tr('select_camera'), subtitle: context.tr('select_camera_sub'))
                  : CameraDetailView(key: ValueKey(selected), cameraId: selected, embedded: true)),
            ])
          : listPane,
    );
  }
}

class _ConnDot extends StatelessWidget {
  const _ConnDot({required this.connected});
  final bool connected;
  @override
  Widget build(BuildContext context) {
    final v = context.vg;
    return Tooltip(
      message: context.tr(connected ? 'connected' : 'reconnecting'),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(color: (connected ? v.ok : v.sel).withValues(alpha: .14), borderRadius: BorderRadius.circular(99)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          StatusDot(color: connected ? v.ok : v.sel, pulse: !connected, size: 8),
          const SizedBox(width: 6),
          Text(context.tr(connected ? 'connected' : 'reconnecting'), style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w800, color: connected ? v.ok : v.accentText)),
        ]),
      ),
    );
  }
}
