import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/api/api.dart';
import '../../core/api/models.dart';
import '../../core/l10n/strings.dart';
import '../../core/theme/vg_theme.dart';
import '../../core/widgets/widgets.dart';
import '../auth/auth_controller.dart';

/// The files the dock copied from the cameras, polled every 3 s while the screen is open.
final dockFilesProvider = StreamProvider.autoDispose.family<DockFiles, String>((ref, bucket) async* {
  final s = ref.watch(sessionProvider);
  if (s == null) return;
  var first = true;
  while (true) {
    try {
      yield await s.api.dockFiles(bucket);
      first = false;
    } on ApiError catch (e) {
      if (first || e.unauthorized) rethrow;
    }
    await Future<void>.delayed(const Duration(seconds: 3));
  }
});

/// Docking > Files: choose per file (or in bulk) between "Push to cloud" and "Keep on dock storage", set the automatic mode,
/// and delete from the camera (with a confirmation). Same rules as the web page (Docking > Files).
class DockFilesScreen extends ConsumerStatefulWidget {
  const DockFilesScreen({super.key});
  @override
  ConsumerState<DockFilesScreen> createState() => _DockFilesScreenState();
}

class _DockFilesScreenState extends ConsumerState<DockFilesScreen> {
  String _bucket = 'all';
  final _sel = <int>{};
  bool _busy = false;

  bool get _admin => ref.read(sessionProvider)?.user.role == 'admin';
  Api get _api => ref.read(sessionProvider)!.api;

  Future<void> _run(Future<void> Function() job) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await job();
      HapticFeedback.selectionClick();
      _sel.clear();
      ref.invalidate(dockFilesProvider(_bucket));
    } on ApiError catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.status == 403 ? context.tr('dk_admin_only') : context.tr('load_failed'))));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _confirmDelete(List<DockFile> rows) async {
    final total = rows.fold<int>(0, (a, f) => a + f.size);
    final ok = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        title: Text(context.tr('dk_del_title')),
        content: Text('${rows.length} (${fmtBytes(total)})  ${context.tr('dk_del_body')}'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d, false), child: Text(context.tr('cancel'))),
          FilledButton(style: FilledButton.styleFrom(backgroundColor: context.vg.rec), onPressed: () => Navigator.pop(d, true), child: Text(context.tr('dk_del_yes'))),
        ],
      ),
    );
    if (ok == true) await _run(() => _api.deleteFromCamera(rows.map((f) => f.id).toList()));
  }

  @override
  Widget build(BuildContext context) {
    final v = context.vg;
    final data = ref.watch(dockFilesProvider(_bucket));
    return Scaffold(
      appBar: AppBar(title: Text(context.tr('dk_files'))),
      body: data.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => EmptyState(icon: Icons.cloud_off_rounded, title: context.tr('load_failed'), action: OutlinedButton(onPressed: () => ref.invalidate(dockFilesProvider(_bucket)), child: Text(context.tr('retry')))),
        data: (d) {
          final pick = d.files.where((f) => !f.removed).toList();
          final wide = MediaQuery.sizeOf(context).width >= 700;
          final modes = [
            ('ask', 'dk_ask', 'dk_ask_d', Icons.help_outline_rounded),
            ('auto_cloud', 'dk_auto_cloud', 'dk_auto_cloud_d', Icons.cloud_upload_outlined),
            ('auto_local', 'dk_auto_local', 'dk_auto_local_d', Icons.sd_storage_outlined),
          ];
          Widget modeTile((String, String, String, IconData) m) {
            final on = d.mode == m.$1;
            return Expanded(
              flex: wide ? 1 : 0,
              child: InkWell(
                borderRadius: BorderRadius.circular(14),
                onTap: !_admin || on ? null : () => _run(() => _api.setDockPolicy(m.$1)),
                child: Container(
                  margin: wide ? const EdgeInsetsDirectional.only(end: 8) : const EdgeInsets.only(bottom: 8),
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(borderRadius: BorderRadius.circular(14), border: Border.all(color: on ? v.sel : v.line, width: on ? 2 : 1), color: on ? v.sel.withValues(alpha: .08) : null),
                  child: Row(children: [
                    Icon(m.$4, color: on ? v.sel : v.mut),
                    const SizedBox(width: 10),
                    Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(context.tr(m.$2), style: const TextStyle(fontWeight: FontWeight.w800)),
                      Text(context.tr(m.$3), style: TextStyle(color: v.mut, fontSize: 12, height: 1.3)),
                    ])),
                  ]),
                ),
              ),
            );
          }
          final buckets = [('all', 'dk_all'), ('awaiting', 'dk_waiting'), ('queued', 'dk_queued'), ('local', 'dk_local'), ('cloud', 'dk_cloud'), ('failed', 'dk_failed')];
          return ListView(padding: const EdgeInsets.fromLTRB(16, 12, 16, 120), children: [
            Text(context.tr('dk_files_sub'), style: TextStyle(color: v.mut, height: 1.4)),
            const SizedBox(height: 12),
            VgCard(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(context.tr('dk_policy').toUpperCase(), style: TextStyle(color: v.mut, fontWeight: FontWeight.w800, fontSize: 11.5, letterSpacing: .8)),
                const SizedBox(height: 10),
                wide ? Row(children: [for (final m in modes) modeTile(m)]) : Column(children: [for (final m in modes) modeTile(m)]),
                if (!_admin) Text(context.tr('dk_admin_only'), style: TextStyle(color: v.mut, fontSize: 12)),
              ]),
            ),
            const SizedBox(height: 12),
            SizedBox(
              height: 44,
              child: ListView(scrollDirection: Axis.horizontal, children: [
                for (final b in buckets) Padding(
                  padding: const EdgeInsetsDirectional.only(end: 8),
                  child: ChoiceChip(
                    selected: _bucket == b.$1,
                    label: Text('${context.tr(b.$2)}  ${b.$1 == 'all' ? d.counts.values.fold<int>(0, (a, c) => a + c.n) : d.counts[b.$1]!.n}${b.$1 != 'all' && d.counts[b.$1]!.bytes > 0 ? ' · ${fmtBytes(d.counts[b.$1]!.bytes)}' : ''}'),
                    onSelected: (_) => setState(() { _bucket = b.$1; _sel.clear(); }),
                  ),
                ),
              ]),
            ),
            if (pick.isNotEmpty && _admin) CheckboxListTile(
              dense: true, contentPadding: EdgeInsets.zero, controlAffinity: ListTileControlAffinity.leading,
              value: pick.every((f) => _sel.contains(f.id)), title: Text(context.tr('dk_select_all')),
              onChanged: (on) => setState(() { if (on == true) { _sel.addAll(pick.map((f) => f.id)); } else { _sel.removeAll(pick.map((f) => f.id)); } }),
            ),
            if (d.files.isEmpty) Padding(padding: const EdgeInsets.all(32), child: Center(child: Text(context.tr('dk_none'), style: TextStyle(color: v.mut)))),
            for (final f in d.files) _FileTile(file: f, selected: _sel.contains(f.id), canSelect: _admin && !f.removed, onToggle: () => setState(() { _sel.contains(f.id) ? _sel.remove(f.id) : _sel.add(f.id); })),
          ]);
        },
      ),
      bottomNavigationBar: _sel.isEmpty || !_admin ? null : SafeArea(
        child: Container(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
          decoration: BoxDecoration(color: v.panel, border: Border(top: BorderSide(color: v.line))),
          child: Wrap(spacing: 8, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, alignment: WrapAlignment.end, children: [
            Text('${_sel.length} ${context.tr('dk_selected')}', style: const TextStyle(fontWeight: FontWeight.w800)),
            FilledButton.icon(onPressed: _busy ? null : () => _run(() => _api.chooseDockFiles(_sel.toList(), 'cloud')), icon: const Icon(Icons.cloud_upload_rounded, size: 18), label: Text(context.tr('dk_push_cloud'))),
            OutlinedButton.icon(onPressed: _busy ? null : () => _run(() => _api.chooseDockFiles(_sel.toList(), 'local')), icon: const Icon(Icons.sd_storage_rounded, size: 18), label: Text(context.tr('dk_keep_dock'))),
            OutlinedButton.icon(
              style: OutlinedButton.styleFrom(foregroundColor: v.rec, side: BorderSide(color: v.rec.withValues(alpha: .5))),
              onPressed: _busy ? null : () {
                final rows = (ref.read(dockFilesProvider(_bucket)).value?.files ?? const <DockFile>[]).where((f) => _sel.contains(f.id) && !f.removed).toList();
                if (rows.isNotEmpty) _confirmDelete(rows);
              },
              icon: const Icon(Icons.delete_outline_rounded, size: 18), label: Text(context.tr('dk_delete_cam')),
            ),
          ]),
        ),
      ),
    );
  }
}

class _FileTile extends StatelessWidget {
  const _FileTile({required this.file, required this.selected, required this.canSelect, required this.onToggle});
  final DockFile file;
  final bool selected, canSelect;
  final VoidCallback onToggle;
  @override
  Widget build(BuildContext context) {
    final v = context.vg;
    final (label, color) = switch (file.bucket) {
      'awaiting' => (context.tr('dk_waiting'), v.sel),
      'queued' => (context.tr('dk_queued'), v.sel),
      'local' => (context.tr('dk_local'), v.blue),
      'cloud' => (context.tr('dk_cloud'), v.ok),
      _ => (context.tr('dk_failed'), v.rec),
    };
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: VgCard(
        padding: const EdgeInsets.fromLTRB(8, 10, 12, 10),
        onTap: canSelect ? onToggle : null,
        child: Row(children: [
          if (canSelect) Checkbox(value: selected, onChanged: (_) => onToggle()) else const SizedBox(width: 12),
          Icon(file.isVideo ? Icons.videocam_rounded : Icons.photo_rounded, color: v.mut, size: 22),
          const SizedBox(width: 10),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(file.cameraId, style: const TextStyle(fontWeight: FontWeight.w800)),
            Text('${file.filename}  ·  ${fmtBytes(file.size)}', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: v.mut, fontSize: 12)),
            if (file.bucket == 'cloud') Text('${context.tr('dk_uploaded')} · ${when(file.updatedTs ?? file.addedTs ?? 0)}', style: TextStyle(color: v.mut, fontSize: 11.5))
            else if (file.bucket == 'local') Text('${context.tr('dk_saved_dock')} · ${when(file.updatedTs ?? file.addedTs ?? 0)}', style: TextStyle(color: v.mut, fontSize: 11.5)),
            if (file.message != null && file.message!.isNotEmpty) Text(file.message!, style: TextStyle(color: v.rec, fontSize: 11.5)),
            if (file.removed) Text(context.tr('dk_removed'), style: TextStyle(color: v.mut, fontSize: 11.5, fontWeight: FontWeight.w700))
            else if (file.camDelete) Text(context.tr('dk_removal_queued'), style: TextStyle(color: v.mut, fontSize: 11.5)),
          ])),
          StatusPill(label: label, color: color),
        ]),
      ),
    );
  }
}
