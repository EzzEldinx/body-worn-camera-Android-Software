import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/l10n/strings.dart';
import '../../core/theme/vg_theme.dart';
import '../../core/widgets/widgets.dart';
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
                  group('feature', context.tr('pf_see')),
                  group('action', context.tr('pf_do')),
                ]);
              },
            ),
    );
  }
}
