import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/api/fleet.dart';
import '../../core/l10n/strings.dart';
import '../../core/theme/vg_theme.dart';
import '../../core/widgets/widgets.dart';
import 'live_player.dart';
import 'watch.dart';

/// Live tab: one camera on a phone, a 2x2 wall on a tablet.
class LiveScreen extends ConsumerWidget {
  const LiveScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final watching = ref.watch(watchProvider);
    final cams = ref.watch(fleetProvider.select((s) => s.cams));
    final wide = MediaQuery.sizeOf(context).width >= 720;
    final shown = watching.where(cams.containsKey).toList();
    final online = cams.values.where((c) => c.online && !shown.contains(c.id)).toList()..sort((a, b) => a.name.compareTo(b.name));
    final v = context.vg;

    Widget picker = online.isEmpty ? const SizedBox.shrink() : SizedBox(
      height: 46,
      child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 16), children: [
        for (final c in online) Padding(
          padding: const EdgeInsetsDirectional.only(end: 8),
          child: ActionChip(
            avatar: StatusDot(color: stateColor(context, c.state), size: 9), label: Text(c.name),
            onPressed: () { HapticFeedback.selectionClick(); ref.read(watchProvider.notifier).add(c.id, max: wide ? 4 : 1); },
          ),
        ),
      ]),
    );

    return Scaffold(
      appBar: BrandBar(actions: [if (shown.isNotEmpty) TextButton.icon(onPressed: () { for (final id in shown) { ref.read(watchProvider.notifier).remove(id); } }, icon: const Icon(Icons.close_rounded, size: 18), label: Text(context.tr('close')))]),
      body: shown.isEmpty
          ? ListView(padding: const EdgeInsets.fromLTRB(0, 0, 0, 24), children: [
              SizedBox(height: 300, child: EmptyState(icon: Icons.live_tv_rounded, title: context.tr('pick_camera'), subtitle: context.tr('pick_camera_sub'))),
              if (online.isNotEmpty) ...[Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: SectionTitle(context.tr('f_online'))), picker],
            ])
          : Column(children: [
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: wide
                      ? GridView.count(
                          crossAxisCount: shown.length == 1 ? 1 : 2, crossAxisSpacing: 12, mainAxisSpacing: 12, childAspectRatio: 16 / 9,
                          children: [for (final id in shown) _Tile(id: id)],
                        )
                      : Center(child: AspectRatio(aspectRatio: 16 / 9, child: _Tile(id: shown.first))),
                ),
              ),
              if (picker is! SizedBox) Padding(padding: const EdgeInsets.only(bottom: 12), child: picker),
              if (!wide) Container(height: 1, color: v.line),
            ]),
    );
  }
}

class _Tile extends ConsumerWidget {
  const _Tile({required this.id});
  final String id;
  @override
  Widget build(BuildContext context, WidgetRef ref) => Stack(children: [
        Positioned.fill(child: LivePlayer(key: ValueKey('live-$id'), cameraId: id, compact: true, onFullscreen: () => context.push('/watch/$id'))),
        PositionedDirectional(
          end: 8, bottom: 8,
          child: Material(
            color: const Color(0xB30A101C), shape: const StadiumBorder(side: BorderSide(color: Color(0x2EFFFFFF))),
            child: InkWell(
              customBorder: const StadiumBorder(),
              onTap: () { ref.read(fleetProvider.notifier).stopLive(id); ref.read(watchProvider.notifier).remove(id); },
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
