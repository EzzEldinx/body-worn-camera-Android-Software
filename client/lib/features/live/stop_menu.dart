import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/api/fleet.dart';
import '../../core/api/models.dart';
import '../../core/l10n/strings.dart';
import '../auth/auth_controller.dart';

/// What "Stop" on a camera's picture means (the web dashboard asks the same, see server/public/stopstream.js):
///   * close the window only            (nothing changes on the camera),
///   * stop a live view the control room started   (the camera ends the recording it began for that view),
///   * stop a recording the OFFICER started        (only with "Stop a recording"; the camera must be new enough; never while an SOS is unanswered).
/// The server decides in the end; this only asks and explains. Returns true when the picture should be closed.
Future<bool> showStopMenu(BuildContext context, WidgetRef ref, String id) async {
  final cam = ref.read(fleetProvider).cams[id];
  final user = ref.read(sessionProvider)?.user;
  final mayEnd = user?.can('stoprec') ?? false;
  final canObey = cam?.caps.contains('remote-stop') ?? false;
  final kind = cam == null || !cam.online ? 'offline' : cam.remote ? 'remote' : cam.recording ? 'officer' : 'idle';
  final name = cam?.name ?? id;
  final choice = await showDialog<String>(
    context: context,
    builder: (c) => AlertDialog(
      title: Text(c.tr('ss_title').replaceAll('{name}', name)),
      content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(switch (kind) { 'remote' => c.tr('ss_remote'), 'officer' => c.tr('ss_officer').replaceAll('{name}', name), 'offline' => c.tr('ss_offline'), _ => c.tr('ss_idle') }),
        if (kind == 'officer' && !mayEnd) Padding(padding: const EdgeInsets.only(top: 10), child: Text(c.tr('ss_no_right'), style: TextStyle(color: Theme.of(c).hintColor))),
        if (kind == 'officer' && mayEnd && !canObey) Padding(padding: const EdgeInsets.only(top: 10), child: Text(c.tr('ss_needs_update'), style: const TextStyle(color: Color(0xFFE0A100)))),
      ]),
      actions: [
        TextButton(onPressed: () => Navigator.pop(c), child: Text(c.tr('ss_cancel'))),
        TextButton(onPressed: () => Navigator.pop(c, 'window'), child: Text(kind == 'remote' || (kind == 'officer' && mayEnd) ? c.tr('ss_window_only') : c.tr('ss_close_window'))),
        if (kind == 'remote') FilledButton(style: FilledButton.styleFrom(backgroundColor: const Color(0xFFE5334F)), onPressed: () => Navigator.pop(c, 'stop'), child: Text(c.tr('ss_btn_remote'))),
        if (kind == 'officer' && mayEnd) FilledButton(style: FilledButton.styleFrom(backgroundColor: const Color(0xFFE5334F)), onPressed: canObey ? () => Navigator.pop(c, 'end') : null, child: Text(c.tr('ss_btn_officer'))),
      ],
    ),
  );
  if (choice == null) return false;
  if (choice == 'window') return true;
  final fleet = ref.read(fleetProvider.notifier);
  final answer = fleet.results.where((r) => r.cameraId == id && r.action == 'stop').first.timeout(const Duration(seconds: 6), onTimeout: () => StreamResult(id, true, null, 'stop'));
  if (choice == 'end') { fleet.endRecording(id); } else { fleet.stopLive(id); }
  final r = await answer;
  if (context.mounted) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(r.ok ? context.tr('ss_sent') : context.tr('ss_r_${r.reason ?? 'offline'}'))));
  }
  return r.ok;
}

/// True when this camera can be stopped from the app in some way (a live view, or an officer's recording).
bool stoppable(Camera? c) => c != null && c.online && (c.remote || c.recording);
