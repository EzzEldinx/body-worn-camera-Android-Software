import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/api/fleet.dart';
import '../../core/api/license.dart';
import '../../core/api/models.dart';
import '../../core/l10n/strings.dart';
import '../../core/theme/vg_theme.dart';
import '../../core/widgets/widgets.dart';
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
  StreamSubscription<BatteryAlert>? _batSub;
  Timer? _licTimer;

  @override
  void initState() {
    super.initState();
    _sub = ref.read(fleetProvider.notifier).sosEvents.listen(_onSos);
    _batSub = ref.read(fleetProvider.notifier).batteryEvents.listen(_onBattery);
    _licTimer = Timer.periodic(const Duration(minutes: 30), (_) => ref.invalidate(licenseProvider));
  }

  @override
  void dispose() { _sub?.cancel(); _batSub?.cancel(); _licTimer?.cancel(); super.dispose(); }

  // A camera fell under 20 % (or 10 %): a quieter notice than an SOS, with a shortcut to the Alerts tab.
  void _onBattery(BatteryAlert a) {
    if (!mounted) return;
    final cam = ref.read(fleetProvider).cams[a.cameraId];
    final level = cam?.battery ?? a.value;
    final m = ScaffoldMessenger.of(context);
    HapticFeedback.mediumImpact();
    m.hideCurrentSnackBar();
    m.showSnackBar(SnackBar(
      behavior: SnackBarBehavior.floating, duration: const Duration(seconds: 8),
      backgroundColor: a.critical ? context.vg.rec : const Color(0xFFB87800),
      content: Text(a.isGeo ? '${context.tr(a.kind)}: ${a.zone}  ·  ${cam?.name ?? a.cameraId}' : '${context.tr(a.critical ? 'bat_critical' : 'bat_low')}: ${cam?.name ?? a.cameraId}  ${ltr('$level%')}', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800)),
      action: SnackBarAction(label: context.tr('tab_alerts'), textColor: Colors.white, onPressed: () => widget.shell.goBranch(4)),
    ));
  }

  Future<void> _onSos(Alarm a) async {
    if (!mounted) return;
    final v = context.vg;
    final name = ref.read(fleetProvider).cams[a.cameraId]?.name ?? a.cameraId;
    final m = ScaffoldMessenger.of(context);
    m.clearMaterialBanners();
    m.showMaterialBanner(MaterialBanner(
      backgroundColor: v.rec, elevation: 4, padding: const EdgeInsets.fromLTRB(16, 10, 8, 10),
      leading: const Icon(Icons.sos_rounded, color: Colors.white, size: 30),
      content: Text('${context.tr('sos_from')} $name${ref.read(fleetProvider).alarms.where((x) => x.id == a.id).firstOrNull?.holder != null ? '  ·  ${a.holder}' : ''}', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 16)),
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
    final open = ref.watch(fleetProvider.select((s) => s.openAlarms + s.openAlerts)); // SOS alarms plus low-battery alerts nobody has dismissed
    final items = <(IconData, IconData, String)>[
      (Icons.videocam_outlined, Icons.videocam_rounded, 'tab_fleet'),
      (Icons.map_outlined, Icons.map_rounded, 'tab_map'),
      (Icons.live_tv_outlined, Icons.live_tv_rounded, 'tab_live'),
      (Icons.dock_outlined, Icons.dock_rounded, 'tab_dock'),
      (Icons.notifications_outlined, Icons.notifications_rounded, 'tab_alerts'),
      (Icons.grid_view_outlined, Icons.grid_view_rounded, 'tab_more'),
    ];
    Widget icon(int i, bool sel) {
      final ic = Icon(sel ? items[i].$2 : items[i].$1);
      if (i != 4) return ic;
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
          Expanded(child: Column(children: [Expanded(child: shell), const _LicenseBar()])),
        ]),
      );
    }
    return Scaffold(
      body: shell,
      bottomNavigationBar: Column(mainAxisSize: MainAxisSize.min, children: [
        const _LicenseBar(),
        NavigationBar(
          selectedIndex: shell.currentIndex, onDestinationSelected: go,
          destinations: [for (var i = 0; i < items.length; i++) NavigationDestination(icon: icon(i, false), selectedIcon: icon(i, true), label: context.tr(items[i].$3))],
        ),
      ]),
    );
  }
}

/// The licence notice of a self-hosted server: nothing while all is well, an amber line when the licence is about to end,
/// a red one when it has ended (the server decides, see /api/license/status).
class _LicenseBar extends ConsumerWidget {
  const _LicenseBar();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = ref.watch(licenseProvider).value;
    if (l == null || !l.show) return const SizedBox.shrink();
    final v = context.vg;
    final n = l.daysLeft ?? 0;
    final text = l.clock ? context.tr('lic_clock')
        : l.state == 'expiring' ? context.tr('lic_expiring').replaceAll('{n}', '$n')
        : l.state == 'trial' ? context.tr('lic_trial').replaceAll('{n}', '$n')
        : l.state == 'grace' ? context.tr('lic_grace')
        : l.state == 'locked' ? context.tr('lic_locked')
        : context.tr('lic_limited');
    final color = l.bad ? v.rec : const Color(0xFFB87800);
    return Material(
      color: color,
      child: SafeArea(top: false, child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
        child: Row(children: [
          const Icon(Icons.verified_user_outlined, color: Colors.white, size: 18), const SizedBox(width: 10),
          Expanded(child: Text(l.canManage ? text : '$text ${context.tr('lic_tell')}', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 12.5, height: 1.3))),
        ]),
      )),
    );
  }
}
