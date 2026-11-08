import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/api/api.dart';
import '../../core/env.dart';
import '../../core/l10n/strings.dart';
import '../../core/settings.dart';
import '../../core/theme/vg_theme.dart';
import '../../core/widgets/widgets.dart';
import 'auth_controller.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});
  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _user = TextEditingController(), _pass = TextEditingController();
  String _server = kDefaultServer;
  bool _busy = false, _hide = true;
  String? _error;

  @override
  void dispose() { _user.dispose(); _pass.dispose(); super.dispose(); }

  Future<void> _submit() async {
    if (_busy || _user.text.trim().isEmpty || _pass.text.isEmpty) return;
    setState(() { _busy = true; _error = null; });
    try {
      await ref.read(authProvider.notifier).login(_user.text, _pass.text, server: _server);
    } on ApiError catch (e) {
      if (!mounted) return;
      setState(() => _error = context.tr(switch (e.status) { 401 => 'wrong_login', 429 => 'too_many', 0 => 'no_server', _ => 'no_server' }));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
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

  @override
  Widget build(BuildContext context) {
    final v = context.vg;
    final st = ref.watch(settingsProvider);
    final lang = st.language ?? (context.isAr ? 'ar' : 'en');
    return Scaffold(
      backgroundColor: const Color(0xFF0E1B45),
      body: Container(
        decoration: const BoxDecoration(gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [Color(0xFF1B1442), Color(0xFF0E1B45)])),
        child: Stack(children: [
          Positioned(top: -120, right: -80, child: _glow(const Color(0xFF2F7BFF), 340)),
          Positioned(bottom: -140, left: -100, child: _glow(const Color(0xFF7C5CFF), 380)),
          SafeArea(
            child: Center(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(22),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 440),
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                    GestureDetector(onLongPress: _editServer, child: Image.asset('assets/brand/visionguard-logo-light.png', height: 52)),
                    const SizedBox(height: 10),
                    Text(context.tr('sign_in_sub'), textAlign: TextAlign.center, style: const TextStyle(color: Color(0xCCE8EEF7), height: 1.45, fontSize: 14.5)),
                    const SizedBox(height: 26),
                    Container(
                      padding: const EdgeInsets.all(22),
                      decoration: BoxDecoration(color: v.panel, borderRadius: BorderRadius.circular(24), boxShadow: const [BoxShadow(color: Color(0x66000000), blurRadius: 40, offset: Offset(0, 18))]),
                      child: AutofillGroup(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                        Text(context.tr('sign_in'), style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
                        const SizedBox(height: 18),
                        TextField(controller: _user, autofillHints: const [AutofillHints.username], textInputAction: TextInputAction.next, autocorrect: false, enableSuggestions: false,
                            decoration: InputDecoration(labelText: context.tr('username'), prefixIcon: const Icon(Icons.person_outline_rounded))),
                        const SizedBox(height: 12),
                        TextField(controller: _pass, obscureText: _hide, autofillHints: const [AutofillHints.password], onSubmitted: (_) => _submit(),
                            decoration: InputDecoration(labelText: context.tr('password'), prefixIcon: const Icon(Icons.lock_outline_rounded),
                                suffixIcon: IconButton(icon: Icon(_hide ? Icons.visibility_outlined : Icons.visibility_off_outlined), onPressed: () => setState(() => _hide = !_hide)))),
                        if (_error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Row(children: [
                          Icon(Icons.error_outline_rounded, color: v.rec, size: 18), const SizedBox(width: 8), Expanded(child: Text(_error!, style: TextStyle(color: v.rec, fontWeight: FontWeight.w600))),
                        ])),
                        const SizedBox(height: 20),
                        CtaButton(label: context.tr('sign_in'), onTap: _submit, loading: _busy),
                      ])),
                    ),
                    const SizedBox(height: 22),
                    SegmentedButton<String>(
                      showSelectedIcon: false, selected: {lang},
                      segments: const [ButtonSegment(value: 'en', label: Text('English')), ButtonSegment(value: 'ar', label: Text('العربية'))],
                      onSelectionChanged: (s) => ref.read(settingsProvider.notifier).setLanguage(s.first),
                      style: ButtonStyle(foregroundColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? const Color(0xFF1A1405) : Colors.white70), backgroundColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? const Color(0xFFFFC857) : Colors.white10), side: const WidgetStatePropertyAll(BorderSide(color: Colors.white24))),
                    ),
                    const SizedBox(height: 18),
                    Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                      Text('${context.tr('powered_by')}  ', style: const TextStyle(color: Colors.white54, fontSize: 12)),
                      Image.asset('assets/brand/smartway-dark.png', height: 14),
                    ]),
                  ]),
                ),
              ),
            ),
          ),
        ]),
      ),
    );
  }

  Widget _glow(Color c, double size) => Container(width: size, height: size, decoration: BoxDecoration(shape: BoxShape.circle, gradient: RadialGradient(colors: [c.withValues(alpha: .45), c.withValues(alpha: 0)])));
}
