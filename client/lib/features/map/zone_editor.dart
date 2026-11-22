import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:maplibre_gl/maplibre_gl.dart';
import '../../core/api/fleet.dart';
import '../../core/api/zones.dart';
import '../../core/l10n/strings.dart';
import '../../core/theme/vg_theme.dart';
import '../../core/widgets/widgets.dart';
import '../auth/auth_controller.dart';

/// Drawing and editing geofence zones on the map (the web has the same, see server/public/geofence.js).
/// The draft is what the user has tapped so far; the map draws it, the bar below controls it, the form asks for the rest.
class ZoneDraft {
  const ZoneDraft({required this.shape, this.pts = const [], this.editing});
  final String shape;               // circle | polygon
  final List<LatLng> pts;           // circle: centre, then a point on the edge; polygon: the corners
  final Zone? editing;
  ZoneDraft copy({String? shape, List<LatLng>? pts}) => ZoneDraft(shape: shape ?? this.shape, pts: pts ?? this.pts, editing: editing);

  double? get radius => shape == 'circle' && pts.length >= 2 ? metresBetween(pts[0].latitude, pts[0].longitude, pts[1].latitude, pts[1].longitude) : null;

  /// The shape as the server wants it, or an error key.
  ({Map<String, dynamic>? shape, String? error}) toShape() {
    if (shape == 'circle') {
      if (pts.length < 2) return (shape: null, error: 'z_err_circle');
      final r = radius!;
      if (r < 10 || r > 50000) return (shape: null, error: 'z_err_radius');
      return (shape: {'type': 'circle', 'lat': pts[0].latitude, 'lng': pts[0].longitude, 'r': r.round()}, error: null);
    }
    if (pts.length < 3) return (shape: null, error: 'z_err_poly');
    return (shape: {'type': 'polygon', 'pts': [for (final p in pts) [p.latitude, p.longitude]]}, error: null);
  }
}

class ZoneDraftCtl extends Notifier<ZoneDraft?> {
  @override
  ZoneDraft? build() => null;
  void start(String shape, {Zone? editing}) => state = ZoneDraft(shape: shape, editing: editing);
  void setShape(String shape) { if (state != null) state = ZoneDraft(shape: shape, editing: state!.editing); }
  void tap(LatLng p) {
    final d = state;
    if (d == null) return;
    state = d.shape == 'circle' ? d.copy(pts: d.pts.isEmpty ? [p] : [d.pts[0], p]) : d.copy(pts: [...d.pts, p]);
  }
  void undo() { final d = state; if (d != null && d.pts.isNotEmpty) state = d.copy(pts: d.pts.sublist(0, d.pts.length - 1)); }
  void cancel() => state = null;
}

final zoneDraftProvider = NotifierProvider<ZoneDraftCtl, ZoneDraft?>(ZoneDraftCtl.new);

/// The "Zones" button on the map and, while drawing, the bar with the instructions.
class ZoneTools extends ConsumerWidget {
  const ZoneTools({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final data = ref.watch(zonesProvider).value;
    final draft = ref.watch(zoneDraftProvider);
    final user = ref.watch(sessionProvider)?.user;
    if (data == null || !data.canEdit) return const SizedBox.shrink();
    if (draft == null) {
      return Positioned(
        top: 10, left: 10,
        child: Material(
          color: context.vg.panel, borderRadius: BorderRadius.circular(99), elevation: 2,
          child: InkWell(
            borderRadius: BorderRadius.circular(99),
            onTap: () => _openList(context, ref, user?.companyId != null),
            child: Padding(padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10), child: Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(Icons.layers_outlined, size: 20, color: context.vg.brand), const SizedBox(width: 8),
              Text(context.tr('z_zones'), style: const TextStyle(fontWeight: FontWeight.w800)),
            ])),
          ),
        ),
      );
    }
    final v = context.vg;
    final hint = draft.shape == 'circle'
        ? (draft.pts.isEmpty ? context.tr('z_hint_c1') : context.tr('z_hint_c2').replaceAll('{m}', '${(draft.radius ?? 0).round()}'))
        : context.tr('z_hint_p').replaceAll('{n}', '${draft.pts.length}');
    final ctl = ref.read(zoneDraftProvider.notifier);
    return Positioned(
      left: 10, right: 10, top: 10,
      child: VgCard(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(child: SegmentedButton<String>(
            segments: [ButtonSegment(value: 'circle', label: Text(context.tr('z_circle')), icon: const Icon(Icons.circle_outlined)), ButtonSegment(value: 'polygon', label: Text(context.tr('z_polygon')), icon: const Icon(Icons.pentagon_outlined))],
            selected: {draft.shape}, showSelectedIcon: false, onSelectionChanged: (s) => ctl.setShape(s.first),
          )),
        ]),
        const SizedBox(height: 8),
        Text(hint, style: TextStyle(color: v.mut, fontWeight: FontWeight.w600)),
        const SizedBox(height: 8),
        Row(children: [
          TextButton(onPressed: ctl.cancel, child: Text(context.tr('z_cancel'))),
          TextButton(onPressed: draft.pts.isEmpty ? null : ctl.undo, child: Text(context.tr('z_undo'))),
          const Spacer(),
          CtaButton(compact: true, label: context.tr('z_next'), icon: Icons.arrow_forward_rounded, onTap: () {
            final r = draft.toShape();
            if (r.shape == null) { ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(context.tr(r.error!)))); return; }
            showZoneForm(context, ref, zone: draft.editing, shape: r.shape!);
          }),
        ]),
      ])),
    );
  }

  void _openList(BuildContext context, WidgetRef ref, bool canCreate) {
    showModalBottomSheet<void>(
      context: context, isScrollControlled: true, showDragHandle: true,
      builder: (_) => Consumer(builder: (ctx, ref, _) {
        final zones = ref.watch(zonesProvider).value?.zones ?? const <Zone>[];
        final v = ctx.vg;
        return SafeArea(child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(ctx).height * .7),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Padding(padding: const EdgeInsets.fromLTRB(20, 0, 20, 8), child: Text(ctx.tr('z_zones'), style: const TextStyle(fontWeight: FontWeight.w900, fontSize: 20))),
            if (!canCreate) Padding(padding: const EdgeInsets.fromLTRB(20, 0, 20, 8), child: Text(ctx.tr('z_staff'), style: TextStyle(color: v.mut))),
            if (zones.isEmpty) Padding(padding: const EdgeInsets.all(20), child: Text(ctx.tr('z_none'), style: TextStyle(color: v.mut))),
            Flexible(child: ListView(shrinkWrap: true, children: [
              for (final z in zones) ListTile(
                leading: Icon(z.kind == 'checkpoint' ? Icons.flag_outlined : Icons.fence_outlined, color: z.active ? v.brand : v.off),
                title: Text(z.name, style: const TextStyle(fontWeight: FontWeight.w800)),
                subtitle: Text(ctx.tr(_modeKey(z.mode)), style: TextStyle(color: v.mut)),
                trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                  IconButton(icon: const Icon(Icons.edit_outlined), onPressed: canCreate ? () {
                    Navigator.pop(ctx);
                    final shape = z.raw['shape'] as Map;
                    showZoneForm(context, ref, zone: z, shape: Map<String, dynamic>.from(shape));
                  } : null),
                  IconButton(icon: Icon(Icons.delete_outline, color: canCreate ? v.rec : v.off), onPressed: canCreate ? () => _confirmDelete(ctx, ref, z) : null),
                ]),
              ),
            ])),
            if (canCreate) Padding(padding: const EdgeInsets.all(16), child: SizedBox(width: double.infinity, child: CtaButton(label: ctx.tr('z_new'), icon: Icons.add_rounded, onTap: () {
              Navigator.pop(ctx);
              ref.read(zoneDraftProvider.notifier).start('circle');
            }))),
          ]),
        ));
      }),
    );
  }

  Future<void> _confirmDelete(BuildContext context, WidgetRef ref, Zone z) async {
    final ok = await showDialog<bool>(context: context, builder: (c) => AlertDialog(
      content: Text(c.tr('z_delete_q').replaceAll('{n}', z.name)),
      actions: [TextButton(onPressed: () => Navigator.pop(c, false), child: Text(c.tr('z_cancel'))), TextButton(onPressed: () => Navigator.pop(c, true), child: Text(c.tr('z_delete'), style: TextStyle(color: c.vg.rec)))],
    ));
    if (ok != true) return;
    final session = ref.read(sessionProvider);
    try {
      await session!.api.deleteJson('/api/geofences/${z.id}');
      ref.invalidate(zonesProvider);
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(context.tr('z_deleted'))));
    } catch (e) {
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }
}

String _modeKey(String mode) => switch (mode) { 'forbidden' => 'z_t_forbidden', 'both' => 'z_t_both', 'checkpoint' => 'z_t_check', _ => 'z_t_allowed' };

/// The form after the shape is drawn: name, when to alert, which cameras, days and hours. [zone] is null for a new zone.
Future<void> showZoneForm(BuildContext context, WidgetRef ref, {Zone? zone, required Map<String, dynamic> shape}) {
  return showModalBottomSheet<void>(
    context: context, isScrollControlled: true, showDragHandle: true, useSafeArea: true,
    builder: (_) => _ZoneForm(zone: zone, shape: shape, outer: ref),
  );
}

class _ZoneForm extends ConsumerStatefulWidget {
  const _ZoneForm({required this.zone, required this.shape, required this.outer});
  final Zone? zone;
  final Map<String, dynamic> shape;
  final WidgetRef outer;
  @override
  ConsumerState<_ZoneForm> createState() => _ZoneFormState();
}

class _ZoneFormState extends ConsumerState<_ZoneForm> {
  late final TextEditingController _name;
  late final TextEditingController _every;
  String _type = 'allowed';
  bool _urgent = false, _active = true, _allDay = true, _busy = false, _allCams = true;
  final _days = <int>{0, 1, 2, 3, 4, 5, 6};
  final _cams = <String>{};
  TimeOfDay _from = const TimeOfDay(hour: 8, minute: 0), _to = const TimeOfDay(hour: 17, minute: 0);
  String? _error;

  @override
  void initState() {
    super.initState();
    final z = widget.zone;
    final raw = z?.raw ?? const {};
    _name = TextEditingController(text: z?.name ?? '');
    _every = TextEditingController(text: '${(raw['everyMin'] as num?)?.toInt() ?? 30}');
    if (z != null) {
      _type = z.mode == 'none' ? 'allowed' : z.mode;
      _urgent = z.critical; _active = z.active;
      final scope = (raw['scope'] as Map?) ?? const {'type': 'all'};
      _allCams = scope['type'] == 'all';
      if (!_allCams && scope['type'] == 'cameras') _cams.addAll([for (final i in (scope['ids'] as List)) '$i']);
      final d = raw['days'];
      if (d is List) { _days..clear()..addAll([for (final x in d) (x as num).toInt()]); }
      final f = raw['from'], t = raw['to'];
      if (f is String && t is String && f.isNotEmpty && t.isNotEmpty) { _allDay = false; _from = _parse(f); _to = _parse(t); }
    }
  }

  @override
  void dispose() { _name.dispose(); _every.dispose(); super.dispose(); }

  TimeOfDay _parse(String s) { final p = s.split(':'); return TimeOfDay(hour: int.tryParse(p[0]) ?? 0, minute: int.tryParse(p.length > 1 ? p[1] : '0') ?? 0); }
  String _hhmm(TimeOfDay t) => '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

  Future<void> _save() async {
    final c = context;
    if (_name.text.trim().isEmpty) { setState(() => _error = c.tr('z_err_name')); return; }
    if (_days.isEmpty) { setState(() => _error = c.tr('z_err_days')); return; }
    if (!_allCams && _cams.isEmpty) { setState(() => _error = c.tr('z_err_cams')); return; }
    final every = int.tryParse(_every.text.trim());
    if (_type == 'checkpoint' && (every == null || every < 5 || every > 720)) { setState(() => _error = c.tr('z_err_every')); return; }
    final z = widget.zone;
    final body = <String, dynamic>{
      if (z != null) ...Map<String, dynamic>.from(z.raw),   // what this form does not show (per-camera rules ...) goes back unchanged
      'name': _name.text.trim(),
      'kind': _type == 'checkpoint' ? 'checkpoint' : 'zone',
      'shape': widget.shape,
      'onExit': _type == 'allowed' || _type == 'both',
      'onEnter': _type == 'forbidden' || _type == 'both',
      if (_type == 'checkpoint') 'everyMin': every,
      'severity': _urgent ? 'critical' : 'warning',
      'scope': _allCams ? {'type': 'all'} : {'type': 'cameras', 'ids': _cams.toList()},
      'days': (_days.toList()..sort()),
      'from': _allDay ? null : _hhmm(_from),
      'to': _allDay ? null : _hhmm(_to),
      'active': _active,
      if (z == null) 'tz': DateTime.now().timeZoneOffset.inMinutes,
    };
    setState(() { _busy = true; _error = null; });
    final nav = Navigator.of(context), sm = ScaffoldMessenger.of(context);
    final msg = context.tr(z == null ? 'z_created' : 'z_saved');
    try {
      final api = ref.read(sessionProvider)!.api;
      if (z == null) { await api.postJson('/api/geofences', body); } else { await api.putJson('/api/geofences/${z.id}', body); }
      ref.invalidate(zonesProvider);
      widget.outer.read(zoneDraftProvider.notifier).cancel();
      nav.pop();
      sm.showSnackBar(SnackBar(content: Text(msg)));
    } catch (e) {
      if (mounted) setState(() { _busy = false; _error = '$e'.replaceFirst('Exception: ', ''); });
    }
  }

  Future<void> _pick(bool from) async {
    final t = await showTimePicker(context: context, initialTime: from ? _from : _to);
    if (t != null) setState(() => from ? _from = t : _to = t);
  }

  @override
  Widget build(BuildContext context) {
    final v = context.vg;
    final cams = ref.watch(fleetProvider).cams.values.toList()..sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
    final z = widget.zone;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: ListView(padding: const EdgeInsets.fromLTRB(20, 0, 20, 24), shrinkWrap: true, children: [
        Text(context.tr(z == null ? 'z_new' : 'z_edit'), style: const TextStyle(fontWeight: FontWeight.w900, fontSize: 20)),
        const SizedBox(height: 14),
        TextField(controller: _name, maxLength: 60, decoration: InputDecoration(labelText: context.tr('z_name'))),
        if (z != null) Align(alignment: AlignmentDirectional.centerStart, child: TextButton.icon(
          icon: const Icon(Icons.draw_outlined),
          label: Text(context.tr('z_redraw')),
          onPressed: () { Navigator.pop(context); widget.outer.read(zoneDraftProvider.notifier).start((widget.shape['type'] as String), editing: z); },
        )),
        const SizedBox(height: 6),
        Text(context.tr('z_type'), style: TextStyle(color: v.mut, fontWeight: FontWeight.w800)),
        RadioGroup<String>(
          groupValue: _type, onChanged: (x) => setState(() => _type = x ?? _type),
          child: Column(children: [for (final t in const ['allowed', 'forbidden', 'both', 'checkpoint']) RadioListTile<String>(value: t, dense: true, title: Text(context.tr(_modeKey(t))))]),
        ),
        if (_type == 'checkpoint') TextField(controller: _every, keyboardType: TextInputType.number, decoration: InputDecoration(labelText: context.tr('z_every'))),
        SwitchListTile(contentPadding: EdgeInsets.zero, value: _urgent, onChanged: (x) => setState(() => _urgent = x), title: Text(context.tr('z_urgent'))),
        const SizedBox(height: 4),
        Text(context.tr('z_cams'), style: TextStyle(color: v.mut, fontWeight: FontWeight.w800)),
        SegmentedButton<bool>(
          segments: [ButtonSegment(value: true, label: Text(context.tr('z_all_cams'))), ButtonSegment(value: false, label: Text(context.tr('z_some_cams')))],
          selected: {_allCams}, showSelectedIcon: false, onSelectionChanged: (s) => setState(() => _allCams = s.first),
        ),
        if (!_allCams) Wrap(spacing: 8, children: [for (final c in cams) FilterChip(label: Text(c.name), selected: _cams.contains(c.id), onSelected: (on) => setState(() => on ? _cams.add(c.id) : _cams.remove(c.id)))]),
        const SizedBox(height: 10),
        Text(context.tr('z_days'), style: TextStyle(color: v.mut, fontWeight: FontWeight.w800)),
        Wrap(spacing: 8, children: [for (var d = 0; d < 7; d++) FilterChip(label: Text(context.tr('z_d$d')), selected: _days.contains(d), onSelected: (on) => setState(() => on ? _days.add(d) : _days.remove(d)))]),
        SwitchListTile(contentPadding: EdgeInsets.zero, value: _allDay, onChanged: (x) => setState(() => _allDay = x), title: Text(context.tr('z_allday'))),
        if (!_allDay) Row(children: [
          Expanded(child: OutlinedButton(onPressed: () => _pick(true), child: Text('${context.tr('z_from')} ${_hhmm(_from)}'))),
          const SizedBox(width: 10),
          Expanded(child: OutlinedButton(onPressed: () => _pick(false), child: Text('${context.tr('z_to')} ${_hhmm(_to)}'))),
        ]),
        SwitchListTile(contentPadding: EdgeInsets.zero, value: _active, onChanged: (x) => setState(() => _active = x), title: Text(context.tr('z_active'))),
        if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(_error!, style: TextStyle(color: v.rec, fontWeight: FontWeight.w700))),
        Row(children: [
          TextButton(onPressed: _busy ? null : () { widget.outer.read(zoneDraftProvider.notifier).cancel(); Navigator.pop(context); }, child: Text(context.tr('z_cancel'))),
          const Spacer(),
          CtaButton(label: context.tr('z_save'), icon: Icons.check_rounded, loading: _busy, onTap: _busy ? null : _save),
        ]),
      ]),
    );
  }
}
