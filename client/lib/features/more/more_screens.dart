import 'dart:math';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../core/api/api.dart';
import '../../core/l10n/strings.dart';
import '../../core/theme/vg_theme.dart';
import '../../core/widgets/widgets.dart';
import '../auth/auth_controller.dart';

/// What the web dashboard has beyond the live view, in the app: Reports, Check-out (who carries which camera), Team (a company's users and employees)
/// and the Admin panel (Smart Way: companies and their subscriptions). Same server API as the web pages.

String _pw() { const c = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; final r = Random.secure(); return List.generate(12, (_) => c[r.nextInt(c.length)]).join(); }
String _day(DateTime d) => '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
String _dateOf(int? ts) => ts == null ? '-' : _day(DateTime.fromMillisecondsSinceEpoch(ts));
void _say(BuildContext c, String m) => ScaffoldMessenger.of(c).showSnackBar(SnackBar(content: Text(m)));
Future<void> _guard(BuildContext c, Future<void> Function() f) async { try { await f(); } on ApiError catch (e) { if (c.mounted) _say(c, e.offline ? c.tr('no_server') : e.message); } }

/// A small form in a dialog: returns the typed values, or null when cancelled.
Future<List<String>?> _form(BuildContext context, String title, List<String> labels, {List<String>? initial}) {
  final ctl = [for (var i = 0; i < labels.length; i++) TextEditingController(text: initial != null && i < initial.length ? initial[i] : '')];
  return showDialog<List<String>>(context: context, builder: (c) => AlertDialog(
    title: Text(title),
    content: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, children: [for (var i = 0; i < labels.length; i++) TextField(controller: ctl[i], decoration: InputDecoration(labelText: labels[i]), autocorrect: false)])),
    actions: [TextButton(onPressed: () => Navigator.pop(c), child: Text(c.tr('cancel'))), FilledButton(onPressed: () => Navigator.pop(c, [for (final x in ctl) x.text.trim()]), child: Text(c.tr('ok')))],
  ));
}

Future<bool> _confirm(BuildContext context, String text) async => await showDialog<bool>(context: context, builder: (c) => AlertDialog(content: Text(text),
    actions: [TextButton(onPressed: () => Navigator.pop(c, false), child: Text(c.tr('cancel'))), FilledButton(onPressed: () => Navigator.pop(c, true), child: Text(c.tr('ok')))])) ?? false;

// ---------------------------------------------------------------- Reports
class ReportsScreen extends ConsumerStatefulWidget {
  const ReportsScreen({super.key});
  @override
  ConsumerState<ReportsScreen> createState() => _ReportsState();
}

class _ReportsState extends ConsumerState<ReportsScreen> {
  DateTimeRange _range = DateTimeRange(start: DateTime.now().subtract(const Duration(days: 6)), end: DateTime.now());
  // key, icon, path, needs dates, dates as milliseconds (audit, check-outs)
  static const _reports = [
    ('rp_ops', Icons.picture_as_pdf_rounded, '/api/report', true, false),
    ('rp_sos', Icons.sos_rounded, '/api/reports/alarms.csv', true, false),
    ('rp_fleet', Icons.videocam_rounded, '/api/reports/fleet.csv', false, false),
    ('rp_bat', Icons.battery_alert_rounded, '/api/reports/battery.csv', true, false),
    ('rp_rec', Icons.video_library_rounded, '/api/reports/recordings.csv', true, false),
    ('rp_shift', Icons.badge_rounded, '/api/assignments/export.csv', true, true),
    ('rp_audit', Icons.verified_user_rounded, '/api/audit/export.csv', true, true),
  ];

  Future<void> _open((String, IconData, String, bool, bool) r) async {
    final s = ref.read(sessionProvider);
    if (s == null) return;
    final days = _range.end.difference(_range.start).inDays + 1;
    if (r.$4 && days > 92) { _say(context, context.tr('rp_max')); return; }
    final q = <String, String>{};
    if (r.$4) {
      if (r.$5) {
        q['from'] = '${DateTime(_range.start.year, _range.start.month, _range.start.day).millisecondsSinceEpoch}';
        q['to'] = '${DateTime(_range.end.year, _range.end.month, _range.end.day).add(const Duration(days: 1)).millisecondsSinceEpoch}';
      } else { q['from'] = _day(_range.start); q['to'] = _day(_range.end); q['tz'] = '${DateTime.now().timeZoneOffset.inMinutes * -1}'; }
    }
    await _guard(context, () async {
      final link = await s.api.downloadLink(Uri(path: r.$3, queryParameters: q.isEmpty ? null : q).toString());
      await launchUrl(Uri.parse(link), mode: LaunchMode.externalApplication);
    });
  }

  @override
  Widget build(BuildContext context) {
    final v = context.vg;
    return Scaffold(
      appBar: AppBar(title: Text(context.tr('reports'))),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        VgCard(onTap: () async { final r = await showDateRangePicker(context: context, firstDate: DateTime(2024), lastDate: DateTime.now(), initialDateRange: _range); if (r != null) setState(() => _range = r); },
          child: Row(children: [Icon(Icons.date_range_rounded, color: v.brand), const SizedBox(width: 12), Expanded(child: Text('${_day(_range.start)}  →  ${_day(_range.end)}', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16))), Text(context.tr('rp_pick'), style: TextStyle(color: v.mut))])),
        const SizedBox(height: 6),
        Padding(padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 6), child: Text(context.tr('rp_note'), style: TextStyle(color: v.mut, fontSize: 12.5, height: 1.4))),
        for (final r in _reports) Padding(padding: const EdgeInsets.only(top: 10), child: VgCard(onTap: () => _open(r), child: Row(children: [
          Container(width: 44, height: 44, decoration: BoxDecoration(color: v.sel.withValues(alpha: .15), borderRadius: BorderRadius.circular(13)), child: Icon(r.$2, color: v.sel)),
          const SizedBox(width: 14),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(context.tr(r.$1), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15.5)), Text(r.$3.contains('/report?') || r.$3 == '/api/report' ? 'PDF' : 'CSV (Excel)', style: TextStyle(color: v.mut, fontSize: 12))])),
          Icon(Icons.download_rounded, color: v.mut),
        ]))),
      ]),
    );
  }
}

// ---------------------------------------------------------------- Check-out
final _shiftsProvider = FutureProvider.autoDispose<Map>((ref) async {
  final s = ref.watch(sessionProvider);
  if (s == null) return {};
  return (await s.api.getJson('/api/assignments', {'status': 'all', 'limit': '150'})) as Map;
});

class CheckoutScreen extends ConsumerWidget {
  const CheckoutScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final v = context.vg;
    final data = ref.watch(_shiftsProvider);
    return Scaffold(
      appBar: AppBar(title: Text(context.tr('checkout'))),
      body: RefreshIndicator(
        onRefresh: () async => ref.refresh(_shiftsProvider.future),
        child: data.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (e, _) => ListView(children: [EmptyState(icon: Icons.cloud_off_rounded, title: context.tr('load_failed'))]),
          data: (d) {
            final list = (d['assignments'] as List? ?? const []).cast<Map>();
            final open = list.where((a) => a['status'] == 'reserved' || a['status'] == 'in_use').toList(), past = list.where((a) => !open.contains(a)).toList();
            final canManage = d['canManage'] == true;
            Widget row(Map a) {
              final st = '${a['status']}';
              final color = st == 'in_use' ? v.ok : st == 'reserved' ? v.sel : v.off;
              return Padding(padding: const EdgeInsets.only(bottom: 10), child: VgCard(child: Row(children: [
                Icon(Icons.badge_rounded, color: color), const SizedBox(width: 12),
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('${a['name']}${a['employeeNo'] != null ? '  ·  ${a['employeeNo']}' : ''}', style: const TextStyle(fontWeight: FontWeight.w800)),
                  Text('${a['cameraName']}  ·  ${context.tr('co_$st')}  ·  ${_dateOf((a['pickedTs'] ?? a['issuedTs']) as int?)}', style: TextStyle(color: v.mut, fontSize: 12.5)),
                ])),
                if (canManage && open.contains(a)) TextButton(onPressed: () => _guard(context, () async {
                  if (!await _confirm(context, context.tr('co_return_ask'))) return;
                  await ref.read(sessionProvider)!.api.postJson('/api/assignments/${a['id']}/end', {});
                  ref.invalidate(_shiftsProvider);
                }), child: Text(context.tr('co_return'))),
              ])));
            }
            if (list.isEmpty) return ListView(children: [EmptyState(icon: Icons.badge_outlined, title: context.tr('co_none'))]);
            return ListView(padding: const EdgeInsets.all(16), children: [
              if (open.isNotEmpty) SectionTitle(context.tr('co_now')), ...open.map(row),
              if (past.isNotEmpty) SectionTitle(context.tr('co_history')), ...past.map(row),
            ]);
          },
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------- Team (a company's administrators)
final _teamProvider = FutureProvider.autoDispose<Map>((ref) async {
  final s = ref.watch(sessionProvider);
  if (s == null) return {};
  final u = (await s.api.getJson('/api/company/users')) as Map, e = (await s.api.getJson('/api/employees')) as Map;
  return {'users': u['users'], 'employees': e['employees']};
});

class TeamScreen extends ConsumerWidget {
  const TeamScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final v = context.vg;
    final api = ref.read(sessionProvider)?.api;
    final data = ref.watch(_teamProvider);
    void again() => ref.invalidate(_teamProvider);
    Future<void> creds(String name, String login, String pw) => showDialog(context: context, builder: (c) => AlertDialog(title: Text(name), content: SelectableText('${c.tr('username')}: $login\n${c.tr('password')}: $pw\n\n${c.tr('tm_once')}'), actions: [TextButton(onPressed: () => Navigator.pop(c), child: Text(c.tr('close')))]));
    return Scaffold(
      appBar: AppBar(title: Text(context.tr('team'))),
      body: data.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => ListView(children: [EmptyState(icon: Icons.lock_outline_rounded, title: context.tr('tm_admin_only'))]),
        data: (d) {
          final users = (d['users'] as List).cast<Map>(), emps = (d['employees'] as List).cast<Map>();
          const roles = ['manager', 'client', 'viewer'];
          return ListView(padding: const EdgeInsets.all(16), children: [
            SectionTitle(context.tr('tm_users')),
            for (final u in users) Padding(padding: const EdgeInsets.only(bottom: 10), child: VgCard(child: Row(children: [
              CircleAvatar(backgroundColor: v.brand.withValues(alpha: .18), child: Text('${u['username']}'[0].toUpperCase())), const SizedBox(width: 12),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text('${u['username']}', style: const TextStyle(fontWeight: FontWeight.w800)), Text('${u['name']}', style: TextStyle(color: v.mut, fontSize: 12.5))])),
              DropdownButton<String>(value: roles.contains(u['role']) ? '${u['role']}' : 'client', underline: const SizedBox(), items: [for (final r in roles) DropdownMenuItem(value: r, child: Text(context.tr('role_$r')))],
                onChanged: (r) => _guard(context, () async { await api!.patchJson('/api/company/users/${u['id']}', {'role': r}); again(); })),
              PopupMenuButton<String>(onSelected: (a) => _guard(context, () async {
                if (a == 'pw') { final pw = _pw(); await api!.postJson('/api/company/users/${u['id']}/password', {'password': pw}); await creds('${u['username']}', '${u['username']}', pw); }
                if (a == 'del' && await _confirm(context, context.tr('tm_remove_ask'))) { await api!.deleteJson('/api/company/users/${u['id']}'); again(); }
              }), itemBuilder: (_) => [PopupMenuItem(value: 'pw', child: Text(context.tr('tm_reset'))), PopupMenuItem(value: 'del', child: Text(context.tr('tm_remove')))]),
            ]))),
            CtaButton(compact: true, label: context.tr('tm_add_user'), icon: Icons.person_add_alt_1_rounded, onTap: () async {
              final f = await _form(context, context.tr('tm_add_user'), [context.tr('username'), context.tr('tm_name')]);
              if (f == null || f[0].isEmpty) return;
              final pw = _pw();
              await _guard(context, () async { await api!.postJson('/api/company/users', {'username': f[0], 'name': f[1], 'password': pw, 'role': 'client'}); again(); await creds(f[0], f[0], pw); });
            }),
            SectionTitle(context.tr('tm_emps')),
            for (final e in emps) Padding(padding: const EdgeInsets.only(bottom: 10), child: VgCard(child: Row(children: [
              Icon(Icons.badge_rounded, color: e['active'] == true ? v.ok : v.off), const SizedBox(width: 12),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('${e['name']}${e['holding'] != null ? '  ·  ${e['holding']}' : ''}', style: TextStyle(fontWeight: FontWeight.w800, color: e['active'] == true ? null : v.mut)),
                Text('${e['employeeNo'] != null ? '${e['employeeNo']}  ·  ' : ''}${e['username']}', style: TextStyle(color: v.mut, fontSize: 12.5)),
              ])),
              PopupMenuButton<String>(onSelected: (a) => _guard(context, () async {
                if (a == 'pw') { final pw = _pw(); await api!.postJson('/api/employees/${e['id']}/password', {'password': pw}); await creds('${e['name']}', '${e['username']}', pw); }
                if (a == 'tog') { await api!.patchJson('/api/employees/${e['id']}', {'active': e['active'] != true}); again(); }
                if (a == 'del' && await _confirm(context, context.tr('tm_remove_ask'))) { await api!.deleteJson('/api/employees/${e['id']}'); again(); }
              }), itemBuilder: (_) => [PopupMenuItem(value: 'pw', child: Text(context.tr('tm_reset'))), PopupMenuItem(value: 'tog', child: Text(context.tr(e['active'] == true ? 'tm_off' : 'tm_on'))), PopupMenuItem(value: 'del', child: Text(context.tr('tm_remove')))]),
            ]))),
            CtaButton(compact: true, label: context.tr('tm_add_emp'), icon: Icons.badge_rounded, onTap: () async {
              final f = await _form(context, context.tr('tm_add_emp'), [context.tr('tm_name'), context.tr('tm_number')]);
              if (f == null || f[0].isEmpty) return;
              await _guard(context, () async {
                final r = (await api!.postJson('/api/employees', {'employees': [{'name': f[0], 'employeeNo': f[1]}]})) as Map;
                again();
                final c = (r['created'] as List).cast<Map>(), sk = (r['skipped'] as List).cast<Map>();
                if (c.isNotEmpty) { await creds('${c[0]['name']}', '${c[0]['username']}', '${c[0]['password']}'); } else if (sk.isNotEmpty && context.mounted) { _say(context, '${sk[0]['reason']}'); }
              });
            }),
          ]);
        },
      ),
    );
  }
}

// ---------------------------------------------------------------- Admin panel (Smart Way)
final _adminProvider = FutureProvider.autoDispose<Map>((ref) async {
  final s = ref.watch(sessionProvider);
  if (s == null) return {};
  return (await s.api.getJson('/api/admin/companies')) as Map;
});

class AdminScreen extends ConsumerWidget {
  const AdminScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final v = context.vg;
    final api = ref.read(sessionProvider)?.api;
    final data = ref.watch(_adminProvider);
    void again() => ref.invalidate(_adminProvider);
    return Scaffold(
      appBar: AppBar(title: Text(context.tr('admin_panel'))),
      floatingActionButton: FloatingActionButton.extended(icon: const Icon(Icons.add_rounded), label: Text(context.tr('ad_add')), onPressed: () async {
        final f = await _form(context, context.tr('ad_add'), [context.tr('ad_name')]);
        if (f == null || f[0].length < 2) return;
        await _guard(context, () async { await api!.postJson('/api/admin/companies', {'name': f[0]}); again(); });
      }),
      body: data.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => ListView(children: [EmptyState(icon: Icons.lock_outline_rounded, title: context.tr('dk_admin_only'))]),
        data: (d) => ListView(padding: const EdgeInsets.fromLTRB(16, 16, 16, 90), children: [
          for (final c in (d['companies'] as List).cast<Map>()) Padding(padding: const EdgeInsets.only(bottom: 10), child: VgCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Expanded(child: Text('${c['name']}', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16))),
              PopupMenuButton<String>(icon: const Icon(Icons.more_vert_rounded), onSelected: (a) => _guard(context, () async {
                if (a == 'date') { final p = await showDatePicker(context: context, firstDate: DateTime(2024), lastDate: DateTime(2040), initialDate: DateTime.now().add(const Duration(days: 30))); if (p == null) return; await api!.putJson('/api/admin/companies/${c['id']}/subscription', {'end': _day(p)}); }
                else if (a == 'clear') { await api!.putJson('/api/admin/companies/${c['id']}/subscription', {'clear': true}); }
                else if (a == 'del') { if (!await _confirm(context, context.tr('ad_delete_ask'))) return; await api!.deleteJson('/api/admin/companies/${c['id']}'); }
                else { await api!.putJson('/api/admin/companies/${c['id']}/subscription', {'months': int.parse(a)}); }
                again();
              }), itemBuilder: (_) => [
                for (final m in const [1, 3, 6, 12, 24, 36]) PopupMenuItem(value: '$m', child: Text(context.tr('ad_extend').replaceAll('{n}', '$m'))),
                PopupMenuItem(value: 'date', child: Text(context.tr('ad_date'))), PopupMenuItem(value: 'clear', child: Text(context.tr('ad_no_end'))), PopupMenuItem(value: 'del', child: Text(context.tr('ad_delete'))),
              ]),
            ]),
            Text('${(c['users'] as List).where((u) => (u as Map)['role'] != 'officer').length} ${context.tr('ad_users')}  ·  ${(c['users'] as List).where((u) => (u as Map)['role'] == 'officer').length} ${context.tr('tm_emps')}', style: TextStyle(color: v.mut, fontSize: 12.5)),
            const SizedBox(height: 8),
            Builder(builder: (_) {
              final sub = c['subscription'] as Map?;
              final st = sub == null ? 'none' : '${sub['state']}';
              final color = st == 'locked' ? v.rec : st == 'expired' ? v.rec : st == 'expiring' ? v.sel : st == 'active' ? v.ok : v.off;
              return StatusPill(label: sub == null ? context.tr('ad_no_end') : st == 'locked' ? '${context.tr('ad_locked')} ${_dateOf(c['subEnd'] as int?)}' : '${context.tr('ad_until')} ${_dateOf(c['subEnd'] as int?)} · ${sub['daysLeft']}', color: color);
            }),
          ]))),
        ]),
      ),
    );
  }
}
