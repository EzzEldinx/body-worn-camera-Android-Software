import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:local_auth/local_auth.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../core/l10n/strings.dart';
import '../../core/settings.dart';
import '../../core/theme/vg_theme.dart';
import '../../core/widgets/widgets.dart';
import '../auth/auth_controller.dart';

class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final st = ref.watch(settingsProvider);
    final c = ref.read(settingsProvider.notifier);
    final session = ref.watch(sessionProvider)!;
    final v = context.vg;
    final lang = st.language ?? (context.isAr ? 'ar' : 'en');

    Widget seg<T>(T value, List<(T, String)> items, void Function(T) onChange) => SegmentedButton<T>(
          showSelectedIcon: false, selected: {value},
          segments: [for (final i in items) ButtonSegment(value: i.$1, label: Text(i.$2))],
          onSelectionChanged: (s) => onChange(s.first),
          style: ButtonStyle(visualDensity: VisualDensity.comfortable, backgroundColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? v.sel : v.raise), foregroundColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? v.selInk : v.mut)),
        );

    return Scaffold(
      appBar: AppBar(title: Text(context.tr('settings'))),
      body: ListView(padding: const EdgeInsets.fromLTRB(16, 4, 16, 32), children: [
        SectionTitle(context.tr('account')),
        VgCard(child: Row(children: [
          CircleAvatar(radius: 24, backgroundColor: v.brand.withValues(alpha: .18), child: Text(session.user.name.isEmpty ? '?' : session.user.name.characters.first.toUpperCase(), style: TextStyle(color: v.brand, fontWeight: FontWeight.w800, fontSize: 18))),
          const SizedBox(width: 14),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(session.user.name, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
            Text(session.user.company ?? context.tr('role_staff'), style: TextStyle(color: v.mut)),
          ])),
        ])),
        SectionTitle(context.tr('appearance')),
        VgCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          seg<ThemeMode>(st.theme, [(ThemeMode.system, context.tr('theme_system')), (ThemeMode.light, context.tr('theme_light')), (ThemeMode.dark, context.tr('theme_dark'))], c.setTheme),
          const SizedBox(height: 14),
          Text(context.tr('language'), style: TextStyle(color: v.mut, fontWeight: FontWeight.w700, fontSize: 12.5)),
          const SizedBox(height: 8),
          seg<String>(lang, const [('en', 'English'), ('ar', 'العربية')], c.setLanguage),
        ])),
        SectionTitle(context.tr('security')),
        VgCard(padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4), child: SwitchListTile(
          contentPadding: EdgeInsets.zero, value: st.biometric,
          title: Text(context.tr('biometric'), style: const TextStyle(fontWeight: FontWeight.w700)), subtitle: Text(context.tr('biometric_sub')),
          onChanged: (on) async {
            if (on) {
              final reason = context.tr('biometric_why'), na = context.tr('biometric_na');
              final messenger = ScaffoldMessenger.of(context);
              final auth = LocalAuthentication();
              final ok = await auth.isDeviceSupported() && await auth.authenticate(localizedReason: reason);
              if (!ok) { messenger.showSnackBar(SnackBar(content: Text(na))); return; }
            }
            c.setBiometric(on);
          },
        )),
        SectionTitle(context.tr('about')),
        VgCard(child: Column(children: [
          FutureBuilder<PackageInfo>(future: PackageInfo.fromPlatform(), builder: (_, s) => _kv(context.tr('version'), s.data == null ? '' : '${s.data!.version} (${s.data!.buildNumber})')),
          _kv(context.tr('server'), session.server.replaceFirst(RegExp(r'^https?://'), '')),
          const SizedBox(height: 4),
          Row(mainAxisAlignment: MainAxisAlignment.center, children: [
            Text('${context.tr('powered_by')}  ', style: TextStyle(color: v.mut, fontSize: 12)),
            Image.asset(context.isDark ? 'assets/brand/smartway-dark.png' : 'assets/brand/smartway-light.png', height: 14),
          ]),
        ])),
        const SizedBox(height: 22),
        OutlinedButton.icon(
          style: OutlinedButton.styleFrom(foregroundColor: v.rec, side: BorderSide(color: v.rec.withValues(alpha: .6)), padding: const EdgeInsets.symmetric(vertical: 14), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14))),
          icon: const Icon(Icons.logout_rounded), label: Text(context.tr('sign_out')),
          onPressed: () async {
            final yes = await showDialog<bool>(context: context, builder: (d) => AlertDialog(
              content: Text(context.tr('sign_out_ask')),
              actions: [TextButton(onPressed: () => Navigator.pop(d, false), child: Text(context.tr('cancel'))), TextButton(onPressed: () => Navigator.pop(d, true), child: Text(context.tr('sign_out'), style: TextStyle(color: v.rec)))],
            ));
            if (yes == true) await ref.read(authProvider.notifier).logout();
          },
        ),
      ]),
    );
  }

  Widget _kv(String k, String v) => Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Row(children: [Text(k, style: const TextStyle(fontWeight: FontWeight.w600)), const Spacer(), Flexible(child: Text(v, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700)))]));
}

class MoreScreen extends ConsumerWidget {
  const MoreScreen({super.key, required this.onOpen});
  final void Function(String route) onOpen;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider)!;
    final v = context.vg;
    Widget tile(IconData icon, Color color, String title, String? sub, VoidCallback onTap) => Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: VgCard(onTap: onTap, child: Row(children: [
            Container(width: 44, height: 44, decoration: BoxDecoration(color: color.withValues(alpha: .14), borderRadius: BorderRadius.circular(13)), child: Icon(icon, color: color)),
            const SizedBox(width: 14),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(title, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15.5)), if (sub != null) Text(sub, style: TextStyle(color: v.mut, fontSize: 12.5))])),
            Icon(Icons.chevron_right_rounded, color: v.mut),
          ])),
        );
    return Scaffold(
      appBar: BrandBar(title: context.tr('tab_more')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        VgCard(child: Row(children: [
          CircleAvatar(radius: 26, backgroundColor: v.brand.withValues(alpha: .18), child: Text(session.user.name.isEmpty ? '?' : session.user.name.characters.first.toUpperCase(), style: TextStyle(color: v.brand, fontWeight: FontWeight.w800, fontSize: 20))),
          const SizedBox(width: 14),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(session.user.name, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 17)),
            Text(session.user.company ?? context.tr('role_staff'), style: TextStyle(color: v.mut)),
          ])),
        ])),
        const SizedBox(height: 16),
        if (session.user.can('recordings')) tile(Icons.video_library_rounded, v.blue, context.tr('recordings'), context.tr('recordings_sub'), () => onOpen('/recordings')),
        tile(Icons.settings_rounded, v.brand, context.tr('settings'), null, () => onOpen('/settings')),
        if (session.user.can('docks')) tile(Icons.dock_rounded, v.ok, context.tr('dock_title'), context.tr('dock_sub'), () => onOpen('/docking')),
        if (session.user.can('reports')) tile(Icons.assessment_rounded, v.sel, context.tr('reports'), context.tr('reports_sub'), () => onOpen('/reports')),
        if (session.user.can('checkout')) tile(Icons.badge_rounded, v.brand, context.tr('checkout'), context.tr('checkout_sub'), () => onOpen('/checkout')),
        if (session.user.role == 'manager' && session.user.companyId != null) tile(Icons.groups_rounded, v.blue, context.tr('team'), context.tr('team_sub'), () => onOpen('/team')),
        if (session.user.superAdmin) tile(Icons.admin_panel_settings_rounded, v.rec, context.tr('admin_panel'), context.tr('admin_sub'), () => onOpen('/admin')),
        tile(Icons.support_agent_rounded, v.rec, context.tr('support'), context.tr('support_sub'), () => onOpen('/support')),
        tile(Icons.dashboard_rounded, v.sel, context.tr('dashboard_web'), null, () => launchUrl(Uri.parse(session.server), mode: LaunchMode.externalApplication)),
      ]),
    );
  }
}
