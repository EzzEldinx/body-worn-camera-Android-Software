import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'core/api/models.dart';
import 'core/widgets/widgets.dart';
import 'features/alerts/alerts_screen.dart';
import 'features/auth/auth_controller.dart';
import 'features/auth/login_screen.dart';
import 'features/docking/docking_screen.dart';
import 'features/fleet/camera_detail.dart';
import 'features/fleet/fleet_screen.dart';
import 'features/live/live_screen.dart';
import 'features/map/map_screen.dart';
import 'features/recordings/recordings_screen.dart';
import 'features/settings/settings_screen.dart';
import 'features/shell/app_shell.dart';

final _rootKey = GlobalKey<NavigatorState>();

final routerProvider = Provider<GoRouter>((ref) {
  final refresh = ValueNotifier<int>(0);
  ref.listen(authProvider, (_, _) => refresh.value++);
  ref.onDispose(refresh.dispose);

  return GoRouter(
    navigatorKey: _rootKey, initialLocation: '/fleet', refreshListenable: refresh,
    redirect: (context, state) {
      final auth = ref.read(authProvider);
      final loc = state.matchedLocation;
      if (auth.isLoading) return loc == '/splash' ? null : '/splash';
      if (auth.value == null) return loc == '/login' ? null : '/login';
      if (loc == '/login' || loc == '/splash') return '/fleet';
      return null;
    },
    routes: [
      GoRoute(path: '/splash', builder: (_, _) => const Scaffold(body: Center(child: VgLogo(height: 44)))),
      GoRoute(path: '/login', builder: (_, _) => const LoginScreen()),
      StatefulShellRoute.indexedStack(
        builder: (_, _, shell) => AppShell(shell: shell),
        branches: [
          StatefulShellBranch(routes: [GoRoute(path: '/fleet', builder: (_, _) => const FleetScreen())]),
          StatefulShellBranch(routes: [GoRoute(path: '/map', builder: (_, s) => MapScreen(focusCam: s.uri.queryParameters['cam']))]),
          StatefulShellBranch(routes: [GoRoute(path: '/live', builder: (_, _) => const LiveScreen())]),
          StatefulShellBranch(routes: [GoRoute(path: '/dock', builder: (_, _) => const DockingScreen())]),
          StatefulShellBranch(routes: [GoRoute(path: '/alerts', builder: (_, _) => const AlertsScreen())]),
          StatefulShellBranch(routes: [GoRoute(path: '/more', builder: (c, _) => MoreScreen(onOpen: (r) => c.push(r)))]),
        ],
      ),
      GoRoute(path: '/camera/:id', builder: (_, s) => Scaffold(appBar: AppBar(), body: CameraDetailView(cameraId: s.pathParameters['id']!))),
      GoRoute(path: '/watch/:id', builder: (_, s) => LiveFullscreen(cameraId: s.pathParameters['id']!)),
      GoRoute(path: '/recordings', builder: (_, s) => RecordingsScreen(camera: s.uri.queryParameters['cam'])),
      GoRoute(path: '/recordings/play', builder: (_, s) => RecordingPlayerPage(recording: s.extra! as Recording)),
      GoRoute(path: '/docking', builder: (_, _) => const DockingScreen()),
      GoRoute(path: '/settings', builder: (_, _) => const SettingsScreen()),
    ],
  );
});
