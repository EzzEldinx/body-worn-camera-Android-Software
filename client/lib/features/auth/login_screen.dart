import 'dart:math' as math;
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/api/api.dart';
import '../../core/env.dart';
import '../../core/l10n/strings.dart';
import '../../core/settings.dart';
import '../../core/theme/vg_theme.dart';
import '../../core/widgets/widgets.dart';
import 'auth_controller.dart';
import 'widgets/camera_turntable.dart';
import 'widgets/hero_scene.dart';

/// Sign-in. Concept "Aperture": the screen is a camera viewfinder. The iris breathes while you type, the card is
/// glass over a moving perspective floor, a wrong password shakes the card, and a correct one opens the iris wide
/// before the app appears. The real camera (assets/camera/*, logo printed on it) floats over the hero and turns through its angles.
class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});
  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> with TickerProviderStateMixin {
  final _user = TextEditingController(), _pass = TextEditingController();
  late final AnimationController _t = AnimationController(vsync: this, duration: const Duration(seconds: 14));
  late final AnimationController _enter = AnimationController(vsync: this, duration: const Duration(milliseconds: 1600))..forward();
  late final AnimationController _burst = AnimationController(vsync: this, duration: const Duration(milliseconds: 760));
  late final AnimationController _shake = AnimationController(vsync: this, duration: const Duration(milliseconds: 460));
  String _server = kDefaultServer;
  bool _busy = false, _hide = true, _started = false;
  String? _error;

  @override
  void initState() {
    super.initState();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;
    if (MediaQuery.of(context).disableAnimations) { _t.value = .3; _enter.value = 1; } else { _t.repeat(); }
  }

  @override
  void dispose() { _t.dispose(); _enter.dispose(); _burst.dispose(); _shake.dispose(); _user.dispose(); _pass.dispose(); super.dispose(); }

  Future<void> _submit() async {
    if (_busy || _user.text.trim().isEmpty || _pass.text.isEmpty) return;
    FocusScope.of(context).unfocus();
    setState(() { _busy = true; _error = null; });
    final notifier = ref.read(authProvider.notifier);
    try {
      final session = await notifier.authenticate(_user.text, _pass.text, server: _server);
      HapticFeedback.heavyImpact();
      await _burst.forward();                 // the iris opens wide...
      notifier.commit(session);               // ...and the app appears
    } on MfaNeeded catch (m) {
      final session = await _askCode(notifier, m);
      if (session == null || !mounted) return;
      HapticFeedback.heavyImpact();
      await _burst.forward();
      notifier.commit(session);
    } on ApiError catch (e) {
      if (!mounted) return;
      HapticFeedback.vibrate();
      _shake.forward(from: 0);
      setState(() => _error = context.tr(switch (e.status) { 401 => 'wrong_login', 429 => 'too_many', _ => 'no_server' }));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Two-step sign-in: asks for the code until it is right, the challenge runs out, or the person cancels.
  Future<Session?> _askCode(AuthController notifier, MfaNeeded m) async {
    String? err;
    while (mounted) {
      final c = TextEditingController();
      final code = await showDialog<String>(context: context, barrierDismissible: false, builder: (d) => AlertDialog(
        title: Text(context.tr('mfa_title')),
        content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(context.tr('mfa_enter')),
          const SizedBox(height: 12),
          TextField(controller: c, autofocus: true, keyboardType: TextInputType.visiblePassword, textInputAction: TextInputAction.done, autofillHints: const [AutofillHints.oneTimeCode],
            textDirection: TextDirection.ltr, decoration: InputDecoration(hintText: context.tr('mfa_code'), errorText: err, errorMaxLines: 3), onSubmitted: (v) => Navigator.pop(d, v)),
          const SizedBox(height: 8),
          Text(context.tr('mfa_recovery_hint'), style: const TextStyle(fontSize: 12)),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d), child: Text(context.tr('cancel'))),
          FilledButton(onPressed: () => Navigator.pop(d, c.text), child: Text(context.tr('mfa_verify'))),
        ],
      ));
      if (code == null || code.trim().isEmpty) return null;
      try {
        return await notifier.authenticateMfa(m, code);
      } on ApiError catch (e) {
        if (!mounted) return null;
        HapticFeedback.vibrate();
        if (e.status != 401 || e.offline) { setState(() => _error = e.offline ? context.tr('no_server') : e.message); return null; }
        err = e.message;   // wrong code (the server's words, in the app's language): try again
      }
    }
    return null;
  }

  // Hidden: long-press the logo to point the app at another server (staging, on-premise customers).
  Future<void> _editServer() async {
    final c = TextEditingController(text: _server);
    final r = await showDialog<String>(context: context, builder: (d) => AlertDialog(
      title: Text(context.tr('server')),
      content: TextField(controller: c, keyboardType: TextInputType.url, autocorrect: false, decoration: const InputDecoration(hintText: 'https://…')),
      actions: [TextButton(onPressed: () => Navigator.pop(d), child: Text(context.tr('cancel'))), TextButton(onPressed: () => Navigator.pop(d, c.text.trim()), child: const Text('OK'))],
    ));
    if (r != null && r.startsWith('http')) setState(() => _server = r);
  }

  Widget _in(Widget child, double from, double to, {Offset slide = const Offset(0, .10)}) {
    final a = CurvedAnimation(parent: _enter, curve: Interval(from, to, curve: Curves.easeOutCubic));
    return FadeTransition(opacity: a, child: SlideTransition(position: Tween(begin: slide, end: Offset.zero).animate(a), child: child));
  }

  @override
  Widget build(BuildContext context) {
    final size = MediaQuery.sizeOf(context);
    final kb = MediaQuery.viewInsetsOf(context).bottom > 0;
    final wide = size.width >= 860;
    final lang = ref.watch(settingsProvider).language ?? (context.isAr ? 'ar' : 'en');
    final hero = wide ? math.min(size.height * .56, 440.0) : math.min(size.width * .66, size.height * .27);

    final heroWidget = Stack(alignment: Alignment.center, clipBehavior: Clip.none, children: [
      ApertureHero(t: _t, burst: _burst, size: hero),
      Positioned(
        bottom: -hero * .02,
        child: CameraTurntable(t: _t, enter: _enter, box: Size(hero * .78, hero * .78)),
      ),
    ]);

    final brand = Column(mainAxisSize: MainAxisSize.min, children: [
      GestureDetector(onLongPress: _editServer, child: Image.asset('assets/brand/visionguard-logo-light.png', height: wide ? 52 : 40)),
      const SizedBox(height: 14),
      Text(context.tr('sign_in_sub'), textAlign: TextAlign.center, style: const TextStyle(color: Color(0xB3E8EEF7), height: 1.5, fontSize: 14)),
    ]);

    final form = AutofillGroup(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
      Text(context.tr('welcome_back'), style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w800, letterSpacing: -.4, color: Colors.white)),
      const SizedBox(height: 4),
      Text(context.tr('sign_in_hint'), style: const TextStyle(fontSize: 13, color: Color(0x99E8EEF7), fontWeight: FontWeight.w600, letterSpacing: .2)),
      const SizedBox(height: 20),
      TextField(controller: _user, autofillHints: const [AutofillHints.username], textInputAction: TextInputAction.next, autocorrect: false, enableSuggestions: false, style: const TextStyle(color: Colors.white), decoration: _dec(context.tr('username'), Icons.person_outline_rounded)),
      const SizedBox(height: 12),
      TextField(controller: _pass, obscureText: _hide, autofillHints: const [AutofillHints.password], onSubmitted: (_) => _submit(), style: const TextStyle(color: Colors.white),
          decoration: _dec(context.tr('password'), Icons.lock_outline_rounded).copyWith(suffixIcon: IconButton(color: Colors.white60, icon: Icon(_hide ? Icons.visibility_outlined : Icons.visibility_off_outlined), onPressed: () => setState(() => _hide = !_hide)))),
      AnimatedSize(duration: const Duration(milliseconds: 220), curve: Curves.easeOutCubic, child: _error == null ? const SizedBox(width: double.infinity) : Padding(padding: const EdgeInsets.only(top: 14), child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(color: const Color(0x33FF3355), borderRadius: BorderRadius.circular(12), border: Border.all(color: const Color(0x66FF5D77))),
        child: Row(children: [const Icon(Icons.error_outline_rounded, color: Color(0xFFFF8CA0), size: 18), const SizedBox(width: 8), Expanded(child: Text(_error!, style: const TextStyle(color: Color(0xFFFFB3C0), fontWeight: FontWeight.w600, fontSize: 13)))]),
      ))),
      const SizedBox(height: 22),
      CtaButton(label: _busy ? context.tr('authenticating') : context.tr('sign_in'), onTap: _submit, loading: _busy),
    ]));

    final card = AnimatedBuilder(
      animation: _shake,
      builder: (_, child) => Transform.translate(offset: Offset(math.sin(_shake.value * math.pi * 6) * 12 * (1 - _shake.value), 0), child: child),
      child: _GlassCard(glow: _error != null ? const Color(0xFFFF3355) : null, child: Theme(data: buildTheme(Brightness.dark), child: form)),
    );

    final footer = Column(mainAxisSize: MainAxisSize.min, children: [
      SegmentedButton<String>(
        showSelectedIcon: false, selected: {lang},
        segments: const [ButtonSegment(value: 'en', label: Text('English')), ButtonSegment(value: 'ar', label: Text('العربية'))],
        onSelectionChanged: (s) => ref.read(settingsProvider.notifier).setLanguage(s.first),
        style: ButtonStyle(visualDensity: VisualDensity.compact, foregroundColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? const Color(0xFF1A1405) : Colors.white70), backgroundColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? const Color(0xFFFFC857) : Colors.white10), side: const WidgetStatePropertyAll(BorderSide(color: Colors.white24))),
      ),
      const SizedBox(height: 14),
      Row(mainAxisAlignment: MainAxisAlignment.center, children: [
        Text('${context.tr('powered_by')}  ', style: const TextStyle(color: Colors.white54, fontSize: 12)),
        Image.asset('assets/brand/smartway-dark.png', height: 14),
      ]),
    ]);

    return Scaffold(
      backgroundColor: const Color(0xFF07051A),
      resizeToAvoidBottomInset: true,
      body: Stack(fit: StackFit.expand, children: [
        HeroBackground(t: _t, focus: wide ? const Alignment(-.5, -.1) : const Alignment(0, -.45)),
        SafeArea(
          child: wide
              ? Row(children: [
                  Expanded(child: Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
                    _in(heroWidget, 0, .75, slide: const Offset(0, .14)),
                    const SizedBox(height: 34),
                    _in(brand, .25, .9),
                  ]))),
                  SizedBox(width: 480, child: Center(child: SingleChildScrollView(padding: const EdgeInsets.all(28), child: Column(mainAxisSize: MainAxisSize.min, children: [
                    _in(card, .35, 1, slide: const Offset(.06, 0)),
                    const SizedBox(height: 22),
                    _in(footer, .6, 1),
                  ])))),
                ])
              : SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(22, 16, 22, 16),
                  child: Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 440), child: Column(mainAxisSize: MainAxisSize.min, children: [
                    if (!kb) ...[_in(heroWidget, 0, .75, slide: const Offset(0, .14)), const SizedBox(height: 26)],
                    if (!kb) _in(brand, .22, .85),
                    SizedBox(height: kb ? 8 : 18),
                    _in(card, .35, 1),
                    const SizedBox(height: 20),
                    _in(footer, .6, 1),
                  ])))),
        ),
        // success flash: the iris opened, everything washes to light for a beat
        IgnorePointer(child: AnimatedBuilder(animation: _burst, builder: (_, _) => ColoredBox(color: Colors.white.withValues(alpha: Curves.easeIn.transform(math.max(0, _burst.value - .55) / .45) * .85)))),
      ]),
    );
  }

  InputDecoration _dec(String label, IconData icon) => InputDecoration(
        labelText: label, prefixIcon: Icon(icon, color: Colors.white60), filled: true, fillColor: Colors.white.withValues(alpha: .07),
        labelStyle: const TextStyle(color: Colors.white60),
        enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: BorderSide(color: Colors.white.withValues(alpha: .16))),
        focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: const BorderSide(color: Color(0xFFFFC857), width: 1.6)),
      );
}

class _GlassCard extends StatelessWidget {
  const _GlassCard({required this.child, this.glow});
  final Widget child;
  final Color? glow;
  @override
  Widget build(BuildContext context) => ClipRRect(
        borderRadius: BorderRadius.circular(28),
        child: BackdropFilter(
          filter: ui.ImageFilter.blur(sigmaX: 20, sigmaY: 20),
          child: Container(
            padding: const EdgeInsets.fromLTRB(24, 26, 24, 24),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(28),
              border: Border.all(color: (glow ?? Colors.white).withValues(alpha: glow == null ? .20 : .55)),
              gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [Colors.white.withValues(alpha: .14), Colors.white.withValues(alpha: .04)]),
              boxShadow: [BoxShadow(color: (glow ?? const Color(0xFF3C22C8)).withValues(alpha: .35), blurRadius: 50, offset: const Offset(0, 22))],
            ),
            child: child,
          ),
        ),
      );
}
