import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/l10n/strings.dart';
import '../../core/theme/vg_theme.dart';
import '../../core/widgets/widgets.dart';
import '../../core/api/api.dart';
import '../auth/auth_controller.dart';

/// Profile and access: who you are, your role, and exactly what you may see and do, with the reason for everything you may not
/// (GET /api/me/access, the same card as the web header). Mirrors the web "Profile and access".
class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(sessionProvider);
    final v = context.vg;
    return Scaffold(
      appBar: AppBar(title: Text(context.tr('profile'))),
      body: s == null
          ? const SizedBox.shrink()
          : FutureBuilder<Map>(
              future: s.api.access(),
              builder: (ctx, snap) {
                if (snap.connectionState != ConnectionState.done) return const Center(child: CircularProgressIndicator());
                if (snap.hasError || snap.data == null) return Center(child: Text(context.tr('load_failed')));
                final a = snap.data!;
                final items = [for (final i in (a['items'] as List? ?? const [])) i as Map];
                Widget group(String kind, String title) {
                  final rows = items.where((i) => i['kind'] == kind).toList();
                  return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Padding(padding: const EdgeInsets.fromLTRB(4, 18, 4, 6), child: Text(title.toUpperCase(), style: TextStyle(color: v.mut, fontWeight: FontWeight.w800, fontSize: 11.5, letterSpacing: .8))),
                    for (final i in rows)
                      Builder(builder: (_) {
                        final ok = i['allowed'] == true, key = 'ft_${i['key']}';
                        final label = context.tr(key) == key ? '${i['label']}' : context.tr(key);
                        return ListTile(
                          dense: true,
                          leading: CircleAvatar(radius: 12, backgroundColor: (ok ? v.ok : v.rec).withValues(alpha: .18), child: Icon(ok ? Icons.check_rounded : Icons.close_rounded, size: 15, color: ok ? v.ok : v.rec)),
                          title: Text(label, style: TextStyle(fontWeight: FontWeight.w700, color: ok ? null : v.mut)),
                          subtitle: ok ? null : Text(context.tr('pf_why_${i['why']}'), style: TextStyle(color: v.rec, fontSize: 12)),
                        );
                      }),
                  ]);
                }
                return ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 32), children: [
                  VgCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('${a['name']}', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
                    Text('@${a['username']}${a['company'] != null ? ' · ${a['company']}' : ''}', style: TextStyle(color: v.mut)),
                    const SizedBox(height: 8),
                    Text(context.tr('rc_${a['role']}'), style: TextStyle(color: v.sel, fontWeight: FontWeight.w800)),
                  ])),
                  const SizedBox(height: 12),
                  _MfaCard(session: s),
                  group('feature', context.tr('pf_see')),
                  group('action', context.tr('pf_do')),
                ]);
              },
            ),
    );
  }
}

/// Two-step sign-in (server/mfa.js): status, set-up (the key to type or open in an authenticator app on this device, then a code),
/// the recovery codes shown once, and switching it off with the password and a current code.
class _MfaCard extends StatefulWidget {
  const _MfaCard({required this.session});
  final Session session;
  @override
  State<_MfaCard> createState() => _MfaCardState();
}

class _MfaCardState extends State<_MfaCard> {
  Map? _st, _setup;
  String? _err;
  bool _busy = false;
  final _code = TextEditingController();

  Api get _api => widget.session.api;

  @override
  void initState() { super.initState(); _load(); }
  @override
  void dispose() { _code.dispose(); super.dispose(); }

  Future<void> _load() async {
    try { final st = await _api.mfaStatus(); if (mounted) setState(() { _st = st; _setup = null; _err = null; }); } catch (_) {}
  }

  Future<void> _run(Future<void> Function() f) async {
    setState(() { _busy = true; _err = null; });
    try { await f(); } on ApiError catch (e) { if (mounted) setState(() => _err = e.offline ? context.tr('no_server') : e.message); }
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _confirm() => _run(() async {
        final r = await _api.mfaEnable(_code.text.trim());
        final codes = [for (final c in (r['recoveryCodes'] as List? ?? const [])) '$c'];
        _code.clear();
        if (!mounted) return;
        await showDialog<void>(context: context, barrierDismissible: false, builder: (d) => AlertDialog(
          title: Text(context.tr('mfa_title')),
          content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(context.tr('mfa_done')),
            const SizedBox(height: 12),
            SelectableText(codes.join('\n'), textDirection: TextDirection.ltr, style: const TextStyle(fontFamily: 'monospace', fontSize: 15, height: 1.6)),
          ]),
          actions: [
            TextButton(onPressed: () => Clipboard.setData(ClipboardData(text: codes.join('\n'))), child: Text(context.tr('mfa_copy'))),
            FilledButton(onPressed: () => Navigator.pop(d), child: Text(context.tr('close'))),
          ],
        ));
        await _load();
      });

  Future<void> _turnOff() async {
    final pw = TextEditingController(), code = TextEditingController();
    final go = await showDialog<bool>(context: context, builder: (d) => AlertDialog(
      title: Text(context.tr('mfa_off_title')),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        Text(context.tr('mfa_off_ask')),
        TextField(controller: pw, obscureText: true, decoration: InputDecoration(labelText: context.tr('password'))),
        TextField(controller: code, keyboardType: TextInputType.number, textDirection: TextDirection.ltr, decoration: InputDecoration(labelText: context.tr('mfa_code'))),
      ]),
      actions: [
        TextButton(onPressed: () => Navigator.pop(d, false), child: Text(context.tr('cancel'))),
        FilledButton(onPressed: () => Navigator.pop(d, true), child: Text(context.tr('mfa_off_btn'))),
      ],
    ));
    if (go == true) await _run(() async { await _api.mfaDisable(pw.text, code.text.trim()); await _load(); });
  }

  @override
  Widget build(BuildContext context) {
    final v = context.vg, st = _st;
    if (st == null) return const SizedBox.shrink();
    final on = st['enabled'] == true;
    final since = st['since'] is num ? DateTime.fromMillisecondsSinceEpoch((st['since'] as num).toInt()).toIso8601String().substring(0, 10) : '';
    final setup = _setup;
    return VgCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        Icon(on ? Icons.verified_user_rounded : Icons.shield_outlined, color: on ? v.ok : v.mut),
        const SizedBox(width: 8),
        Expanded(child: Text(context.tr('mfa_title'), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16))),
      ]),
      const SizedBox(height: 6),
      Text(on ? context.tr('mfa_on').replaceAll('{date}', since).replaceAll('{n}', '${st['recoveryLeft'] ?? 0}') : context.tr('mfa_off'), style: TextStyle(color: v.mut)),
      if (setup != null) ...[
        const SizedBox(height: 12),
        Text(context.tr('mfa_scan')),
        const SizedBox(height: 8),
        SelectableText((setup['secret'] as String? ?? '').replaceAllMapped(RegExp(r'.{4}'), (m) => '${m[0]} ').trim(),
            textDirection: TextDirection.ltr, style: const TextStyle(fontFamily: 'monospace', fontSize: 15, fontWeight: FontWeight.w700)),
        const SizedBox(height: 8),
        Wrap(spacing: 8, children: [
          OutlinedButton.icon(onPressed: () => launchUrl(Uri.parse('${setup['url']}'), mode: LaunchMode.externalApplication), icon: const Icon(Icons.open_in_new_rounded, size: 18), label: Text(context.tr('mfa_open_app'))),
          OutlinedButton.icon(onPressed: () => Clipboard.setData(ClipboardData(text: '${setup['secret']}')), icon: const Icon(Icons.copy_rounded, size: 18), label: Text(context.tr('mfa_copy_key'))),
        ]),
        const SizedBox(height: 8),
        TextField(controller: _code, keyboardType: TextInputType.number, textDirection: TextDirection.ltr, maxLength: 6, decoration: InputDecoration(labelText: context.tr('mfa_code'), counterText: '')),
      ],
      if (_err != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_err!, style: TextStyle(color: v.rec, fontWeight: FontWeight.w600))),
      const SizedBox(height: 10),
      Row(children: [
        if (on) OutlinedButton(onPressed: _busy ? null : _turnOff, child: Text(context.tr('mfa_off_btn')))
        else if (setup == null) FilledButton(onPressed: _busy ? null : () => _run(() async { final r = await _api.mfaSetup(); if (mounted) setState(() => _setup = r); }), child: Text(context.tr('mfa_on_btn')))
        else ...[
          FilledButton(onPressed: _busy ? null : _confirm, child: Text(context.tr('mfa_confirm'))),
          const SizedBox(width: 8),
          TextButton(onPressed: _busy ? null : () => setState(() { _setup = null; _err = null; }), child: Text(context.tr('cancel'))),
        ],
      ]),
    ]));
  }
}
