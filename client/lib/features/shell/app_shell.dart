import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/api/fleet.dart';
import '../../core/api/models.dart';
import '../../core/l10n/strings.dart';
import '../../core/theme/vg_theme.dart';
import '../live/watch.dart';

/// Bottom bar on phones, navigation rail on tablets. Also shows the SOS banner wherever the user is.
class AppShell extends ConsumerStatefulWidget {
  const AppShell({super.key, required this.shell});
  final StatefulNavigationShell shell;
  @override
  ConsumerState<AppShell> createState() => _AppShellState();
}

class _AppShellState extends ConsumerState<AppShell> {
  StreamSubscription<Alarm>? _sub;

  @override
  void initState() {
    super.initState();
    _sub = ref.read(fleetProvider.notifier).sosEvents.listen(_onSos);
  }

  @override
  void dispose() { _sub?.cancel(); super.dispose(); }

  Future<void> _onSos(Alarm a) async {
    if (!mounted) return;
    final v = context.vg;
    final name = ref.read(fleetProvider).cams[a.cameraId]?.name ?? a.cameraId;
    final m = ScaffoldMessenger.of(context);
    m.clearMaterialBanners();
    m.showMaterialBanner(MaterialBanner(
      backgroundColor: v.rec, elevation: 4, padding: const EdgeInsets.fromLTRB(16, 10, 8, 10),
      leading: const Icon(Icons.sos_rounded, color: Colors.white, size: 30),
      content: Text('${context.tr('sos_from')} $name', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 16)),
      actions: [
        TextButton(
          onPressed: () {
            m.hideCurrentMaterialBanner();
            final wide = MediaQuery.sizeOf(context).width >= 720;
            ref.read(watchProvider.notifier).add(a.cameraId, max: wide ? 4 : 1);
            context.push('/watch/${a.cameraId}');
          },
          child: Text(context.tr('open_live'), style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800)),
        ),
        TextButton(onPressed: m.hideCurrentMaterialBanner, child: Text(context.tr('close'), style: const TextStyle(color: Colors.white70))),
      ],
    ));
    for (var i = 0; i < 3; i++) { HapticFeedback.heavyImpact(); await Future.delayed(const Duration(milliseconds: 220)); }
    SystemSound.play(SystemSoundType.alert);
  }

  @override
  Widget build(BuildContext context) {
    final shell = widget.shell;
    final wide = MediaQuery.sizeOf(context).width >= 720;
    final open = ref.watch(fleetProvider.select((s) => s.openAlarms));
    final items = <(IconData, IconData, String)>[
      (Icons.videocam_outlined, Icons.videocam_rounded, 'tab_fleet'),
      (Icons.map_outlined, Icons.map_rounded, 'tab_map'),
      (Icons.live_tv_outlined, Icons.live_tv_rounded, 'tab_live'),
      (Icons.notifications_outlined, Icons.notifications_rounded, 'tab_alerts'),
      (Icons.grid_view_outlined, Icons.grid_view_rounded, 'tab_more'),
    ];
    Widget icon(int i, bool sel) {
      final ic = Icon(sel ? items[i].$2 : items[i].$1);
      if (i != 3) return ic;
      return Badge(label: Text('$open'), isLabelVisible: open > 0, backgroundColor: context.vg.rec, child: ic);
    }
    void go(int i) { HapticFeedback.selectionClick(); shell.goBranch(i, initialLocation: i == shell.currentIndex); }

    if (wide) {
      return Scaffold(
        body: Row(children: [
          NavigationRail(
            selectedIndex: shell.currentIndex, onDestinationSelected: go, labelType: NavigationRailLabelType.all,
            leading: Padding(padding: const EdgeInsets.fromLTRB(0, 16, 0, 12), child: Image.asset('assets/brand/visionguard-mark.png', height: 38)),
            destinations: [for (var i = 0; i < items.length; i++) NavigationRailDestination(icon: icon(i, false), selectedIcon: icon(i, true), label: Text(context.tr(items[i].$3)))],
          ),
          VerticalDivider(width: 1, color: context.vg.line),
          Expanded(child: shell),
        ]),
      );
    }
    return Scaffold(
      body: shell,
      bottomNavigationBar: NavigationBar(
        selectedIndex: shell.currentIndex, onDestinationSelected: go,
        destinations: [for (var i = 0; i < items.length; i++) NavigationDestination(icon: icon(i, false), selectedIcon: icon(i, true), label: context.tr(items[i].$3))],
      ),
    );
  }
}
