import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import 'core/constants/app_colors.dart';
import 'core/constants/app_strings.dart';
import 'features/dashboard/presentation/providers/kiosk_controller.dart';
import 'features/dashboard/presentation/screens/kiosk_dashboard_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Hide status / nav bars from the Flutter side. Android lock-task is the
  // real Home-key guard and is armed after the first frame.
  await SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
  await SystemChrome.setPreferredOrientations(const [
    DeviceOrientation.portraitUp,
    DeviceOrientation.landscapeLeft,
    DeviceOrientation.landscapeRight,
  ]);

  runApp(const ProviderScope(child: SwgBwcApp()));
}

class SwgBwcApp extends ConsumerStatefulWidget {
  const SwgBwcApp({super.key});

  @override
  ConsumerState<SwgBwcApp> createState() => _SwgBwcAppState();
}

class _SwgBwcAppState extends ConsumerState<SwgBwcApp>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) => _armKiosk());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed &&
        ref.read(kioskControllerProvider)) {
      _armKiosk();
    }
  }

  Future<void> _armKiosk() async {
    await WakelockPlus.enable();
    await SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
    await ref.read(kioskControllerProvider.notifier).arm();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: AppStrings.appTitle,
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: AppColors.background,
        colorScheme: const ColorScheme.dark(
          primary: AppColors.accent,
          surface: AppColors.surface,
        ),
        useMaterial3: true,
      ),
      home: const KioskDashboardScreen(),
    );
  }
}
