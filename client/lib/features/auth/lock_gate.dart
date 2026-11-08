import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:local_auth/local_auth.dart';
import '../../core/l10n/strings.dart';
import '../../core/settings.dart';
import '../../core/theme/vg_theme.dart';
import '../../core/widgets/widgets.dart';
import 'auth_controller.dart';

/// With "Lock with Face ID / fingerprint" on, the app asks for it on launch and when you come back after 30 seconds away.
class LockGate extends ConsumerStatefulWidget {
  const LockGate({super.key, required this.child});
  final Widget child;
  @override
  ConsumerState<LockGate> createState() => _LockGateState();
}

class _LockGateState extends ConsumerState<LockGate> with WidgetsBindingObserver {
  final _auth = LocalAuthentication();
  bool _locked = false, _busy = false;
  DateTime? _away;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _locked = ref.read(settingsProvider).biometric;
  }

  @override
  void dispose() { WidgetsBinding.instance.removeObserver(this); super.dispose(); }

  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (s == AppLifecycleState.paused) _away = DateTime.now();
    if (s == AppLifecycleState.resumed && ref.read(settingsProvider).biometric && _away != null && DateTime.now().difference(_away!) > const Duration(seconds: 30)) {
      setState(() => _locked = true);
      _unlock();
    }
  }

  Future<void> _unlock() async {
    if (_busy) return;
    _busy = true;
    final reason = context.tr('biometric_why');
    try {
      if (!await _auth.isDeviceSupported()) { if (mounted) setState(() => _locked = false); return; }
      final ok = await _auth.authenticate(localizedReason: reason);
      if (ok && mounted) setState(() => _locked = false);
    } catch (_) {
      // stay locked; the user can tap Unlock
    } finally {
      _busy = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final signedIn = ref.watch(sessionProvider) != null;
    final lock = _locked && signedIn && ref.watch(settingsProvider).biometric;
    if (lock) WidgetsBinding.instance.addPostFrameCallback((_) => _unlock());
    return Stack(children: [
      widget.child,
      if (lock) Positioned.fill(child: Material(
        color: context.vg.bg,
        child: Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
          const VgLogo(height: 44),
          const SizedBox(height: 28),
          Icon(Icons.lock_rounded, size: 40, color: context.vg.mut),
          const SizedBox(height: 12),
          Text(context.tr('locked'), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 17)),
          const SizedBox(height: 22),
          CtaButton(label: context.tr('unlock'), icon: Icons.fingerprint_rounded, onTap: _unlock),
        ])),
      )),
    ]);
  }
}
