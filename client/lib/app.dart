import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'core/settings.dart';
import 'core/theme/vg_theme.dart';
import 'features/auth/lock_gate.dart';
import 'router.dart';

class VgApp extends ConsumerWidget {
  const VgApp({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final st = ref.watch(settingsProvider);
    return MaterialApp.router(
      title: 'VisionGuard',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      themeMode: st.theme,
      locale: st.language == null ? null : Locale(st.language!),
      supportedLocales: const [Locale('en'), Locale('ar')],
      localizationsDelegates: const [GlobalMaterialLocalizations.delegate, GlobalWidgetsLocalizations.delegate, GlobalCupertinoLocalizations.delegate],
      routerConfig: ref.watch(routerProvider),
      builder: (context, child) => LockGate(child: child ?? const SizedBox.shrink()),
    );
  }
}
