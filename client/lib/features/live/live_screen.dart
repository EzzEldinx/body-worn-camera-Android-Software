import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../auth/auth_controller.dart';
import '../../core/api/fleet.dart';
import '../../core/l10n/strings.dart';
import 'stop_menu.dart';
import '../../core/theme/vg_theme.dart';
import '../../core/widgets/widgets.dart';
import 'live_player.dart';
import 'watch.dart';

/// Cameras for the wall, in order: the ones picked by hand, then recording ones, then the rest online (by name). Closed ones are left out.
List<String> wallOrder(Map<String, dynamic> cams, List<String> picked, Set<String> dismissed) {
  final online = cams.values.where((c) => c.online && !dismissed.contains(c.id)).toList()
    ..sort((a, b) {
      final pa = picked.indexOf(a.id), pb = picked.indexOf(b.id);
      if ((pa >= 0) != (pb >= 0)) return pa >= 0 ? -1 : 1;
      if (pa >= 0) return pa.compareTo(pb);
      if (a.recording != b.recording) return a.recording ? -1 : 1;
      return a.name.compareTo(b.name);
    });
  return [for (final c in online) c.id as String];
}

const _phoneLayouts = [1, 2, 4, 6], _wideLayouts = [1, 4, 6, 9, 16];
int _colsFor(int layout, bool wide) => wide ? const {1: 1, 4: 2, 6: 3, 9: 3, 16: 4}[layout]! : const {1: 1, 2: 1, 4: 2, 6: 2}[layout]!;

/// Live tab: every online camera on one wall. A camera that is not streaming shows "Start live view" (nothing is started just by opening the tab). Layout buttons choose how many at once (a phone: 1, 2, 4, 6; a tablet: 1, 4, 6, 9, 16).
class LiveScreen extends ConsumerWidget {
  const LiveScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final cams = ref.watch(fleetProvider.select((s) => s.cams));
    final wide = MediaQuery.sizeOf(context).width >= 720;
    final options = wide ? _wideLayouts : _phoneLayouts;
    final layout = options.contains(ref.watch(wallLayoutProvider)) ? ref.watch(wallLayoutProvider) : (wide ? 4 : 1);
    final dismissed = ref.watch(dismissedProvider);
    final order = wallOrder(cams, ref.watch(watchProvider), dismissed);
    final pages = (order.length / layout).ceil().clamp(1, 999);
    final page = ref.watch(wallPageProvider).clamp(0, pages - 1);
    final shown = order.skip(page * layout).take(layout).toList();
    final v = context.vg;

    return Scaffold(
      appBar: BrandBar(actions: [
        if (pages > 1) ...[
          IconButton(tooltip: '‹', icon: const Icon(Icons.chevron_left_rounded), onPressed: page > 0 ? () => ref.read(wallPageProvider.notifier).set(page - 1) : null),
          Center(child: Text('${page + 1}/$pages', style: TextStyle(color: v.mut, fontWeight: FontWeight.w700))),
          IconButton(tooltip: '›', icon: const Icon(Icons.chevron_right_rounded), onPressed: page < pages - 1 ? () => ref.read(wallPageProvider.notifier).set(page + 1) : null),
        ],
        PopupMenuButton<int>(
          tooltip: context.tr('wall_layout'), icon: const Icon(Icons.grid_view_rounded, size: 20), initialValue: layout,
          onSelected: (n) { ref.read(wallLayoutProvider.notifier).set(n); ref.read(wallPageProvider.notifier).set(0); },
          itemBuilder: (_) => [for (final n in options) CheckedPopupMenuItem(value: n, checked: n == layout, child: Text('$n'))],
        ),
        if (dismissed.isNotEmpty) IconButton(tooltip: context.tr('show_all'), icon: const Icon(Icons.visibility_rounded, size: 20), onPressed: () => ref.read(dismissedProvider.notifier).clear()),
        if (ref.watch(sessionProvider)?.user.can('wall') ?? true) IconButton(tooltip: context.tr('live_wall'), icon: const Icon(Icons.fit_screen_rounded, size: 20), onPressed: order.isEmpty ? null : () { HapticFeedback.selectionClick(); context.push('/wall'); }),
      ]),
      body: shown.isEmpty
          ? EmptyState(icon: Icons.live_tv_rounded, title: context.tr('no_online_cams'), subtitle: context.tr('no_online_cams_sub'))
          : Padding(padding: const EdgeInsets.all(12), child: _WallGrid(ids: shown, layout: layout, cols: _colsFor(layout, wide))),
    );
  }
}

/// The tiles of a wall; a single camera keeps its 16:9 frame, more are a grid.
class _WallGrid extends StatelessWidget {
  const _WallGrid({required this.ids, required this.layout, required this.cols, this.gap = 12});
  final List<String> ids; final int layout, cols; final double gap;
  @override
  Widget build(BuildContext context) => ids.length == 1
      ? Center(child: AspectRatio(aspectRatio: 16 / 9, child: _Tile(id: ids.first)))
      : GridView.count(crossAxisCount: cols, crossAxisSpacing: gap, mainAxisSpacing: gap, childAspectRatio: 16 / 9, children: [for (final id in ids) _Tile(id: id)]);
}

/// Every online camera on one full-screen wall (opened by the wall button on the Live tab). Same layout and page as the tab; each tile still has its own full-screen button.
class LiveWallFullscreen extends ConsumerStatefulWidget {
  const LiveWallFullscreen({super.key});
  @override
  ConsumerState<LiveWallFullscreen> createState() => _LiveWallFullscreenState();
}

class _LiveWallFullscreenState extends ConsumerState<LiveWallFullscreen> {
  @override
  void initState() {
    super.initState();
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
    SystemChrome.setPreferredOrientations(DeviceOrientation.values);
  }

  @override
  void dispose() {
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final cams = ref.watch(fleetProvider.select((s) => s.cams));
    final wide = MediaQuery.sizeOf(context).width >= 720;
    final options = wide ? _wideLayouts : _phoneLayouts;
    final layout = options.contains(ref.watch(wallLayoutProvider)) ? ref.watch(wallLayoutProvider) : (wide ? 4 : 1);
    final order = wallOrder(cams, ref.watch(watchProvider), ref.watch(dismissedProvider));
    final pages = (order.length / layout).ceil().clamp(1, 999);
    final page = ref.watch(wallPageProvider).clamp(0, pages - 1);
    final shown = order.skip(page * layout).take(layout).toList();
    Widget round(IconData icon, String tip, VoidCallback? onTap) => Material(
        color: const Color(0xB30A101C), shape: const CircleBorder(side: BorderSide(color: Color(0x2EFFFFFF))),
        child: IconButton(icon: Icon(icon, color: Colors.white), tooltip: tip, onPressed: onTap));
    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(children: [
        Positioned.fill(child: SafeArea(child: Padding(padding: const EdgeInsets.all(6), child: shown.isEmpty ? const SizedBox.shrink() : _WallGrid(ids: shown, layout: layout, cols: _colsFor(layout, wide), gap: 6)))),
        SafeArea(child: Align(alignment: AlignmentDirectional.bottomStart, child: Padding(padding: const EdgeInsets.all(14), child: Row(mainAxisSize: MainAxisSize.min, children: [
          round(Icons.close_rounded, context.tr('close'), () => context.pop()),
          if (pages > 1) ...[
            const SizedBox(width: 8), round(Icons.chevron_left_rounded, '‹', page > 0 ? () => ref.read(wallPageProvider.notifier).set(page - 1) : null),
            Padding(padding: const EdgeInsets.symmetric(horizontal: 8), child: Text('${page + 1}/$pages', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700))),
            round(Icons.chevron_right_rounded, '›', page < pages - 1 ? () => ref.read(wallPageProvider.notifier).set(page + 1) : null),
          ],
        ])))),
      ]),
    );
  }
}

class _Tile extends ConsumerWidget {
  const _Tile({required this.id});
  final String id;
  @override
  Widget build(BuildContext context, WidgetRef ref) => Stack(children: [
        // only a camera somebody picked (Watch live on its card or the map) starts by itself; the rest wait for a tap on the tile
        Positioned.fill(child: LivePlayer(key: ValueKey('live-$id'), cameraId: id, compact: true, autoStart: ref.watch(watchProvider).contains(id), onFullscreen: () => context.push('/watch/$id'))),
        PositionedDirectional(
          end: 8, bottom: 8,
          child: Material(
            color: const Color(0xB30A101C), shape: const StadiumBorder(side: BorderSide(color: Color(0x2EFFFFFF))),
            child: InkWell(
              customBorder: const StadiumBorder(),
              onTap: () async {
                if (await showStopMenu(context, ref, id)) { ref.read(watchProvider.notifier).remove(id); ref.read(dismissedProvider.notifier).add(id); }
              },
              child: Padding(padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7), child: Row(mainAxisSize: MainAxisSize.min, children: [
                const Icon(Icons.stop_circle_outlined, size: 17, color: Color(0xFFFF5D77)),
                const SizedBox(width: 6),
                Text(context.tr('stop_stream'), style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 12)),
              ])),
            ),
          ),
        ),
      ]);
}

/// Full-screen viewer (rotates freely, hides the system bars).
class LiveFullscreen extends ConsumerStatefulWidget {
  const LiveFullscreen({super.key, required this.cameraId});
  final String cameraId;
  @override
  ConsumerState<LiveFullscreen> createState() => _LiveFullscreenState();
}

class _LiveFullscreenState extends ConsumerState<LiveFullscreen> {
  @override
  void initState() {
    super.initState();
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
    SystemChrome.setPreferredOrientations(DeviceOrientation.values);
  }

  @override
  void dispose() {
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
    SystemChrome.setPreferredOrientations(DeviceOrientation.values);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        backgroundColor: Colors.black,
        body: Stack(children: [
          Positioned.fill(child: SafeArea(child: LivePlayer(cameraId: widget.cameraId, fit: BoxFit.contain))),
          SafeArea(child: Align(
            alignment: AlignmentDirectional.bottomStart,
            child: Padding(padding: const EdgeInsets.all(14), child: Material(
              color: const Color(0xB30A101C), shape: const CircleBorder(side: BorderSide(color: Color(0x2EFFFFFF))),
              child: IconButton(icon: const Icon(Icons.close_rounded, color: Colors.white), tooltip: context.tr('close'), onPressed: () => context.pop()),
            )),
          )),
        ]),
      );
}
