import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/api/fleet.dart';
import '../../core/api/models.dart';
import '../../core/l10n/strings.dart';
import '../../core/theme/vg_theme.dart';
import '../../core/widgets/widgets.dart';
import '../auth/auth_controller.dart';
import '../live/stop_menu.dart';
import '../live/subtitles.dart';
import '../live/live_player.dart';
import '../live/watch.dart';

/// Everything about one camera. On a phone it is a page; on a tablet it is the right-hand pane.
class CameraDetailView extends ConsumerStatefulWidget {
  const CameraDetailView({super.key, required this.cameraId, this.embedded = false});
  final String cameraId;
  final bool embedded; // tablet pane: live plays inline instead of opening full screen
  @override
  ConsumerState<CameraDetailView> createState() => _CameraDetailViewState();
}

class _CameraDetailViewState extends ConsumerState<CameraDetailView> {
  bool _inline = false;

  @override
  void didUpdateWidget(CameraDetailView old) {
    super.didUpdateWidget(old);
    if (old.cameraId != widget.cameraId) _inline = false;
  }

  @override
  Widget build(BuildContext context) {
    final v = context.vg;
    final cam = ref.watch(fleetProvider.select((s) => s.cams[widget.cameraId]));
    final alarm = ref.watch(fleetProvider.select((s) => s.alarms.where((a) => a.cameraId == widget.cameraId && !a.ack).firstOrNull));
    final fleet = ref.read(fleetProvider.notifier);
    if (cam == null) return EmptyState(icon: Icons.videocam_off_rounded, title: context.tr('cam_offline'));
    final color = stateColor(context, cam.state);
    final gps = !cam.hasPosition ? context.tr('no_gps')
        : '${ltr('${cam.lat!.toStringAsFixed(5)}, ${cam.lng!.toStringAsFixed(5)}')}${cam.gpsFresh && cam.atDock ? '  ·  ${context.tr('at_dock')}' : cam.gpsFresh && cam.acc != null ? '  ${ltr('(±${cam.acc!.round()} m)')}' : '  ·  ${context.tr('gps_stale')}'}';
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Row(children: [
          Expanded(child: Text(cam.name, style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w800, letterSpacing: -.3))),
          StatusPill(label: stateLabel(context, cam.state), color: color, pulse: cam.recording),
        ]),
        if (cam.name != cam.id) Padding(padding: const EdgeInsets.only(top: 2), child: Text(cam.id, style: TextStyle(color: v.mut, fontWeight: FontWeight.w600))),
        const SizedBox(height: 16),
        if (alarm != null) ...[
          VgCard(
            border: v.rec, glow: v.rec,
            child: Row(children: [
              Icon(Icons.sos_rounded, color: v.rec, size: 30),
              const SizedBox(width: 12),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('${context.tr('sos_from')} ${cam.name}', style: TextStyle(color: v.rec, fontWeight: FontWeight.w800)),
                Text(agoText(context, alarm.ts), style: TextStyle(color: v.mut, fontSize: 12.5)),
              ])),
              CtaButton(compact: true, label: context.tr('ack'), onTap: () => fleet.ack(alarm.id)),
            ]),
          ),
          const SizedBox(height: 14),
        ],
        AspectRatio(
          aspectRatio: 16 / 9,
          child: _inline && cam.online
              ? LivePlayer(cameraId: cam.id, onFullscreen: () => context.push('/watch/${cam.id}'))
              : _Poster(cam: cam, onWatch: () { if (widget.embedded) { setState(() => _inline = true); } else { context.push('/watch/${cam.id}'); } }),
        ),
        if (stoppable(cam)) ...[
          const SizedBox(height: 10),
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: OutlinedButton.icon(
              onPressed: () async { if (await showStopMenu(context, ref, cam.id) && mounted) setState(() => _inline = false); },
              icon: const Icon(Icons.stop_circle_outlined), label: Text(context.tr('stop_stream')),
              style: OutlinedButton.styleFrom(foregroundColor: v.rec, side: BorderSide(color: v.rec.withValues(alpha: .6)), shape: const StadiumBorder()),
            ),
          ),
        ],
        if (ref.watch(sessionProvider)?.user.can('talk') ?? false) ...[
          const SizedBox(height: 10),
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: OutlinedButton.icon(onPressed: () => context.push('/chat?cam=${Uri.encodeComponent(cam.id)}'), icon: const Icon(Icons.forum_rounded), label: Text(context.tr('chat_message_btn')), style: OutlinedButton.styleFrom(shape: const StadiumBorder())),
          ),
        ],
        if ((ref.watch(sessionProvider)?.user.can('transcribe') ?? false) && cam.online) ...[const SizedBox(height: 14), CaptionsBox(cameraId: cam.id)],
        if (!cam.hasPosition) Padding(
          padding: const EdgeInsets.only(top: 14),
          child: VgCard(child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Icon(Icons.location_off_rounded, color: v.sel), const SizedBox(width: 12),
            Expanded(child: Text(context.tr('no_gps_why'), style: TextStyle(color: v.mut, height: 1.4, fontSize: 13))),
          ])),
        ),
        SectionTitle(context.tr('status')),
        VgCard(padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6), child: Column(children: [
          _Row(context.tr('last_seen'), agoText(context, cam.ts)),
          if (cam.holder != null) _Row(context.tr('holder'), '${cam.holder}${cam.holderNo != null ? '  ·  ${cam.holderNo}' : ''}${cam.custody == 'reserved' ? '  ·  ${context.tr('holder_reserved')}' : cam.custody == 'in_use' ? '  ·  ${context.tr('holder_carrying')}' : ''}'),
          if (cam.battery != null) _Row(context.tr('battery'), '${cam.charging ? '⚡ ' : ''}${ltr('${cam.battery}%')}  ·  ${_batteryNote(context, cam)}'),
          _Row(context.tr('position'), gps),
          if (cam.speed != null && cam.speed! > 0.5) _Row(context.tr('speed'), '${(cam.speed! * 3.6).round()} km/h'),
          _Row(context.tr('company'), cam.company ?? context.tr('unassigned')),
          if (cam.region != null) _Row(context.tr('region'), cam.region!),
        ])),
        if (cam.online) ...[
          SectionTitle(context.tr('quality')),
          VgCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Wrap(spacing: 8, runSpacing: 8, children: [
              for (final q in const ['auto', '480p', '720p', '1080p'])
                ChoiceChip(
                  label: Text(q == 'auto' ? context.tr('quality_auto') : q), selected: (cam.qualityAuto ? 'auto' : cam.quality) == q, showCheckmark: false,
                  onSelected: (_) { fleet.setQuality(cam.id, q); ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(context.tr('quality_sent')))); },
                ),
            ]),
            const SizedBox(height: 10),
            Text(cam.qualityAuto ? '${context.tr('quality_auto_note')}${cam.quality != null ? ' (${cam.quality})' : ''}' : context.tr('quality_note'), style: TextStyle(color: v.mut, fontSize: 12.5)),
          ])),
        ],
        const SizedBox(height: 16),
        Row(children: [
          if (cam.hasPosition) Expanded(child: OutlinedButton.icon(onPressed: () { showOnMap(ref, cam.id); if (!widget.embedded) context.go('/fleet'); }, icon: const Icon(Icons.map_outlined), label: Text(context.tr('show_map')))),
          if (cam.hasPosition) const SizedBox(width: 10),
          Expanded(child: OutlinedButton.icon(onPressed: () => context.push('/recordings?cam=${cam.id}'), icon: const Icon(Icons.video_library_outlined), label: Text(context.tr('recordings')))),
        ]),
      ],
    );
  }
}

/// Where the battery figure comes from: the camera itself (live), or the dock it sits on, or the last time it was read.
String _batteryNote(BuildContext context, Camera c) {
  final age = c.batteryTs == null ? null : DateTime.now().millisecondsSinceEpoch - c.batteryTs!;
  if (c.batterySrc == 'camera' && age != null && age < 300000) return context.tr('battery_live');
  if (c.batterySrc == 'dock') return '${context.tr('battery_dock')}, ${agoText(context, c.batteryTs)}';
  return '${context.tr('battery_last')} ${agoText(context, c.batteryTs)}';
}

class _Row extends StatelessWidget {
  const _Row(this.k, this.v);
  final String k, v;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 11),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          SizedBox(width: 104, child: Text(k, style: TextStyle(color: context.vg.mut, fontWeight: FontWeight.w600))),
          Expanded(child: Text(v, style: const TextStyle(fontWeight: FontWeight.w700))),
        ]),
      );
}

class _Poster extends StatelessWidget {
  const _Poster({required this.cam, required this.onWatch});
  final Camera cam;
  final VoidCallback onWatch;
  @override
  Widget build(BuildContext context) {
    final v = context.vg;
    return ClipRRect(
      borderRadius: BorderRadius.circular(kRadius),
      child: Container(
        decoration: const BoxDecoration(gradient: RadialGradient(center: Alignment(0, -.6), radius: 1.3, colors: [Color(0xFF1B2C4B), Color(0xFF0A111D)])),
        child: Center(
          child: cam.online
              ? Column(mainAxisSize: MainAxisSize.min, children: [
                  CtaButton(label: context.tr('watch_live'), icon: Icons.play_arrow_rounded, onTap: onWatch),
                  const SizedBox(height: 10),
                  Text(context.tr('pick_camera_sub'), textAlign: TextAlign.center, style: const TextStyle(color: Color(0xFF8FA2BF), fontSize: 12)),
                ])
              : Column(mainAxisSize: MainAxisSize.min, children: [
                  Icon(Icons.videocam_off_rounded, color: v.off, size: 36),
                  const SizedBox(height: 8),
                  Text(context.tr('cam_offline'), style: const TextStyle(color: Color(0xFF8FA2BF))),
                ]),
        ),
      ),
    );
  }
}
