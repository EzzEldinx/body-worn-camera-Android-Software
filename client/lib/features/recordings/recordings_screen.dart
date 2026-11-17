import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:media_kit/media_kit.dart';
import '../../core/save_file.dart';
import 'package:media_kit_video/media_kit_video.dart';
import '../../core/api/api.dart';
import '../../core/api/fleet.dart';
import '../../core/api/models.dart';
import '../../core/l10n/strings.dart';
import '../../core/theme/vg_theme.dart';
import '../../core/widgets/widgets.dart';
import '../auth/auth_controller.dart';

final recordingsProvider = FutureProvider.autoDispose.family<List<Recording>, String?>((ref, cam) async {
  final s = ref.watch(sessionProvider);
  if (s == null) return [];
  return s.api.recordings(camera: cam);
});

class RecordingsScreen extends ConsumerStatefulWidget {
  const RecordingsScreen({super.key, this.camera});
  final String? camera;
  @override
  ConsumerState<RecordingsScreen> createState() => _RecordingsScreenState();
}

class _RecordingsScreenState extends ConsumerState<RecordingsScreen> {
  String? _cam;
  @override
  void initState() { super.initState(); _cam = widget.camera; }

  @override
  Widget build(BuildContext context) {
    final v = context.vg;
    final cams = ref.watch(fleetProvider.select((s) => s.cams));
    final data = ref.watch(recordingsProvider(_cam));
    return Scaffold(
      appBar: AppBar(title: Text(context.tr('recordings'))),
      body: Column(children: [
        SizedBox(
          height: 56,
          child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.fromLTRB(16, 10, 16, 6), children: [
            Padding(padding: const EdgeInsetsDirectional.only(end: 8), child: ChoiceChip(label: Text(context.tr('all_cameras')), selected: _cam == null, onSelected: (_) => setState(() => _cam = null))),
            for (final c in cams.values) Padding(padding: const EdgeInsetsDirectional.only(end: 8), child: ChoiceChip(label: Text(c.name), selected: _cam == c.id, onSelected: (_) => setState(() => _cam = c.id))),
          ]),
        ),
        Expanded(
          child: data.when(
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (e, _) => EmptyState(icon: Icons.cloud_off_rounded, title: context.tr('load_failed'), action: OutlinedButton(onPressed: () => ref.invalidate(recordingsProvider(_cam)), child: Text(context.tr('retry')))),
            data: (list) => list.isEmpty
                ? EmptyState(icon: Icons.video_library_outlined, title: context.tr('no_recordings'))
                : RefreshIndicator(
                    onRefresh: () async => ref.refresh(recordingsProvider(_cam).future),
                    child: ListView.builder(
                      padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
                      itemCount: list.length,
                      itemBuilder: (_, i) {
                        final r = list[i];
                        return Padding(
                          padding: const EdgeInsets.only(bottom: 10),
                          child: VgCard(
                            onTap: () => context.push('/recordings/play', extra: r),
                            child: Row(children: [
                              Container(width: 46, height: 46, decoration: BoxDecoration(color: v.blue.withValues(alpha: .14), borderRadius: BorderRadius.circular(13)), child: Icon(r.isVideo ? Icons.play_circle_fill_rounded : Icons.image_rounded, color: v.blue)),
                              const SizedBox(width: 12),
                              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                Text(cams[r.cameraId]?.name ?? r.cameraId, style: const TextStyle(fontWeight: FontWeight.w800)),
                                Text('${when(r.ts)}  ·  ${fmtBytes(r.size)}', style: TextStyle(color: v.mut, fontSize: 12.5)),
                              ])),
                              Builder(builder: (bctx) => IconButton(tooltip: context.tr('download'), icon: Icon(Icons.download_rounded, color: v.mut), onPressed: () => saveRecording(bctx, ref.read(sessionProvider)!, r.id, r.filename))),
                              Icon(Icons.chevron_right_rounded, color: v.mut),
                            ]),
                          ),
                        );
                      },
                    ),
                  ),
          ),
        ),
      ]),
    );
  }
}

class RecordingPlayerPage extends ConsumerStatefulWidget {
  const RecordingPlayerPage({super.key, required this.recording});
  final Recording recording;
  @override
  ConsumerState<RecordingPlayerPage> createState() => _RecordingPlayerPageState();
}

class _RecordingPlayerPageState extends ConsumerState<RecordingPlayerPage> {
  Player? _player;
  VideoController? _video;

  @override
  void initState() {
    super.initState();
    final s = ref.read(sessionProvider)!;
    if (widget.recording.isVideo) {
      _player = Player();
      _video = VideoController(_player!);
      _player!.open(Media(s.api.recordingUrl(widget.recording.id), httpHeaders: {'authorization': 'Bearer ${s.token}'}));
    }
  }

  @override
  void dispose() { _player?.dispose(); super.dispose(); }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(sessionProvider)!;
    final r = widget.recording;
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(backgroundColor: Colors.black, foregroundColor: Colors.white, title: Text(r.cameraId, style: const TextStyle(color: Colors.white)), actions: [Builder(builder: (bctx) => IconButton(tooltip: context.tr('download'), icon: const Icon(Icons.download_rounded), onPressed: () => saveRecording(bctx, s, r.id, r.filename)))]),
      body: SafeArea(
        child: Column(children: [
          Expanded(child: Center(child: r.isVideo ? Video(controller: _video!) : Image.network(s.api.recordingUrl(r.id), headers: {'authorization': 'Bearer ${s.token}'}, fit: BoxFit.contain))),
          Padding(padding: const EdgeInsets.all(14), child: Text('${when(r.ts)}  ·  ${fmtBytes(r.size)}\nSHA-256 ${r.sha256.substring(0, 16)}…', textAlign: TextAlign.center, style: const TextStyle(color: Color(0xFF8FA2BF), fontSize: 12.5, height: 1.5))),
        ]),
      ),
    );
  }
}

// ApiError is imported so a failed load can be told apart from an empty list in the future.
// ignore: unused_element
typedef _Unused = ApiError;
