import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../core/api/api.dart';
import '../../core/api/models.dart';
import '../../core/l10n/strings.dart';
import '../../core/theme/vg_theme.dart';
import '../../core/widgets/widgets.dart';
import '../auth/auth_controller.dart';

const kSupportEmail = 'sdpt@smart-way.com.sa';
const _cats = ['question', 'camera', 'docking', 'live', 'alerts', 'account', 'app', 'other'];
const _pris = ['normal', 'low', 'high', 'urgent'];

final ticketsProvider = FutureProvider.autoDispose<List<Ticket>>((ref) async {
  final s = ref.watch(sessionProvider);
  if (s == null) return const [];
  return s.api.tickets();
});

Color _stColor(VgColors v, String s) => switch (s) { 'open' => v.sel, 'in_progress' => v.blue, 'resolved' => v.ok, _ => v.off };

/// Help & Support in the app: the same tickets as the web page (every account has it; Smart Way staff see and answer all of them).
class SupportScreen extends ConsumerWidget {
  const SupportScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final v = context.vg;
    final data = ref.watch(ticketsProvider);
    return Scaffold(
      appBar: AppBar(title: Text(context.tr('support'))),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () async { if (await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => const NewTicketScreen())) == true) ref.invalidate(ticketsProvider); },
        icon: const Icon(Icons.add_rounded), label: Text(context.tr('sp_new')),
      ),
      body: RefreshIndicator(
        onRefresh: () async => ref.refresh(ticketsProvider.future),
        child: data.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (e, _) => ListView(children: [EmptyState(icon: Icons.cloud_off_rounded, title: context.tr('load_failed'))]),
          data: (list) => ListView(padding: const EdgeInsets.fromLTRB(16, 12, 16, 100), children: [
            Text(context.tr('support_sub'), style: TextStyle(color: v.mut, height: 1.4)),
            const SizedBox(height: 6),
            InkWell(
              onTap: () => launchUrl(Uri.parse('mailto:$kSupportEmail'), mode: LaunchMode.externalApplication),
              child: Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: Text('${context.tr('sp_email')} $kSupportEmail', style: TextStyle(color: v.brand, fontWeight: FontWeight.w700))),
            ),
            const SizedBox(height: 8),
            if (list.isEmpty) Padding(padding: const EdgeInsets.all(32), child: Center(child: Text(context.tr('sp_none'), style: TextStyle(color: v.mut)))),
            for (final t in list) Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: VgCard(
                onTap: () async { await Navigator.of(context).push(MaterialPageRoute(builder: (_) => TicketScreen(id: t.id))); ref.invalidate(ticketsProvider); },
                child: Row(children: [
                  Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(t.subject, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w800)),
                    Text('${t.ref} · ${agoText(context, t.updated)}${t.by != null ? ' · ${t.by}' : ''}${t.replies > 0 ? ' · ${t.replies}' : ''}', style: TextStyle(color: v.mut, fontSize: 12)),
                  ])),
                  const SizedBox(width: 8),
                  StatusPill(label: context.tr('st_${t.status}'), color: _stColor(v, t.status)),
                ]),
              ),
            ),
          ]),
        ),
      ),
    );
  }
}

class NewTicketScreen extends ConsumerStatefulWidget {
  const NewTicketScreen({super.key});
  @override
  ConsumerState<NewTicketScreen> createState() => _NewTicketScreenState();
}

class _NewTicketScreenState extends ConsumerState<NewTicketScreen> {
  final _sub = TextEditingController(), _desc = TextEditingController();
  String _cat = 'question', _pri = 'normal';
  bool _busy = false;
  String? _error;

  @override
  void dispose() { _sub.dispose(); _desc.dispose(); super.dispose(); }

  Future<void> _send() async {
    if (_sub.text.trim().length < 3 || _desc.text.trim().length < 10) { setState(() => _error = context.tr('sp_short')); return; }
    setState(() { _busy = true; _error = null; });
    try {
      await ref.read(sessionProvider)!.api.createTicket(subject: _sub.text.trim(), category: _cat, priority: _pri, description: _desc.text.trim());
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(context.tr('sp_sent'))));
      Navigator.of(context).pop(true);
    } on ApiError catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final v = context.vg;
    Widget drop(String label, String value, List<String> items, String Function(String) text, ValueChanged<String> on) => DropdownButtonFormField<String>(
          initialValue: value, isExpanded: true, decoration: InputDecoration(labelText: label),
          items: [for (final i in items) DropdownMenuItem(value: i, child: Text(text(i)))], onChanged: (x) => on(x ?? value));
    return Scaffold(
      appBar: AppBar(title: Text(context.tr('sp_new'))),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        TextField(controller: _sub, maxLength: 120, decoration: InputDecoration(labelText: context.tr('sp_subject'))),
        const SizedBox(height: 8),
        drop(context.tr('sp_about'), _cat, _cats, (c) => context.tr('cat_$c'), (x) => setState(() => _cat = x)),
        const SizedBox(height: 12),
        drop(context.tr('sp_priority'), _pri, _pris, (p) => context.tr('pr_$p'), (x) => setState(() => _pri = x)),
        const SizedBox(height: 12),
        TextField(controller: _desc, maxLines: 7, maxLength: 4000, decoration: InputDecoration(labelText: context.tr('sp_describe'), alignLabelWithHint: true)),
        if (_error != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(_error!, style: TextStyle(color: v.rec))),
        const SizedBox(height: 12),
        FilledButton(onPressed: _busy ? null : _send, child: Padding(padding: const EdgeInsets.symmetric(vertical: 12), child: Text(context.tr('sp_send')))),
      ]),
    );
  }
}

class TicketScreen extends ConsumerStatefulWidget {
  const TicketScreen({super.key, required this.id});
  final int id;
  @override
  ConsumerState<TicketScreen> createState() => _TicketScreenState();
}

class _TicketScreenState extends ConsumerState<TicketScreen> {
  final _reply = TextEditingController();
  Ticket? _t;
  bool _busy = false, _failed = false;

  @override
  void initState() { super.initState(); _load(); }
  @override
  void dispose() { _reply.dispose(); super.dispose(); }

  Api get _api => ref.read(sessionProvider)!.api;
  Future<void> _load() async {
    try { final t = await _api.ticket(widget.id); if (mounted) setState(() { _t = t; _failed = false; }); }
    catch (_) { if (mounted) setState(() => _failed = true); }
  }

  Future<void> _send() async {
    final body = _reply.text.trim();
    if (body.length < 2 || _busy) return;
    setState(() => _busy = true);
    try { await _api.replyTicket(widget.id, body); _reply.clear(); await _load(); } catch (_) {} finally { if (mounted) setState(() => _busy = false); }
  }

  @override
  Widget build(BuildContext context) {
    final v = context.vg;
    final t = _t;
    final staff = ref.watch(sessionProvider)?.user.staff == true;
    return Scaffold(
      appBar: AppBar(title: Text(t?.ref ?? context.tr('support'))),
      body: t == null
          ? (_failed ? EmptyState(icon: Icons.cloud_off_rounded, title: context.tr('load_failed'), action: OutlinedButton(onPressed: _load, child: Text(context.tr('retry')))) : const Center(child: CircularProgressIndicator()))
          : Column(children: [
              Expanded(child: ListView(padding: const EdgeInsets.all(16), children: [
                Text(t.subject, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
                const SizedBox(height: 8),
                Wrap(spacing: 8, children: [
                  StatusPill(label: context.tr('st_${t.status}'), color: _stColor(v, t.status)),
                  StatusPill(label: context.tr('pr_${t.priority}'), color: t.priority == 'urgent' ? v.rec : v.blue),
                  if (t.cameraId != null) StatusPill(label: t.cameraId!, color: v.off),
                ]),
                const SizedBox(height: 12),
                for (final m in t.messages) Container(
                  margin: const EdgeInsets.only(bottom: 10), padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(color: m.staff ? v.brand.withValues(alpha: .09) : v.panel, borderRadius: BorderRadius.circular(12), border: Border.all(color: m.staff ? v.brand.withValues(alpha: .3) : v.line)),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('${m.author}${m.staff ? ' · ${context.tr('sp_staff')}' : ''} · ${when(m.ts)}', style: TextStyle(color: v.mut, fontSize: 11.5, fontWeight: FontWeight.w700)),
                    const SizedBox(height: 4),
                    Text(m.body, style: const TextStyle(height: 1.5)),
                  ]),
                ),
                if (t.status == 'closed') Text(context.tr('sp_closed_hint'), style: TextStyle(color: v.mut)),
                if (!staff && t.status != 'closed') Align(alignment: AlignmentDirectional.centerStart, child: TextButton(onPressed: () async { await _api.setTicketStatus(t.id, 'closed'); await _load(); }, child: Text(context.tr('sp_close')))),
              ])),
              SafeArea(child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 6, 12, 8),
                child: Row(children: [
                  Expanded(child: TextField(controller: _reply, minLines: 1, maxLines: 4, decoration: InputDecoration(hintText: context.tr('sp_reply')))),
                  IconButton.filled(onPressed: _busy ? null : _send, icon: const Icon(Icons.send_rounded)),
                ]),
              )),
            ]),
    );
  }
}
