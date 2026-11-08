import 'dart:convert';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import '../../core/api/api.dart';
import '../../core/api/models.dart';
import '../../core/env.dart';

class Session {
  Session({required this.server, required this.token, required this.user});
  final String server, token;
  final User user;
  Api get api => Api(server, token: token);
}

const _store = FlutterSecureStorage();

/// Holds the signed-in session. The token lives in the Keychain (iOS) / Keystore (Android), never in plain preferences.
class AuthController extends AsyncNotifier<Session?> {
  @override
  Future<Session?> build() async {
    final token = await _store.read(key: 'vg_token');
    if (token == null) return null;
    final server = await _store.read(key: 'vg_server') ?? kDefaultServer;
    User? cached;
    try { cached = User.fromJson(jsonDecode(await _store.read(key: 'vg_user') ?? '') as Map); } catch (_) {}
    try {
      final me = await Api(server, token: token).me(); // is the session still valid?
      await _store.write(key: 'vg_user', value: jsonEncode(me.toJson()));
      return Session(server: server, token: token, user: me);
    } on ApiError catch (e) {
      if (e.unauthorized) { await _clear(); return null; }
      if (cached != null) return Session(server: server, token: token, user: cached); // offline: open with the last known account
      return null;
    }
  }

  /// Checks the credentials and returns the session without publishing it, so the sign-in screen can play its
  /// success animation before the app switches screens. Call [commit] afterwards.
  Future<Session> authenticate(String username, String password, {String? server}) async {
    final base = (server ?? kDefaultServer).replaceAll(RegExp(r'/+$'), '');
    final j = await Api(base).login(username.trim(), password);
    final user = User.fromJson(j['user'] as Map);
    await _store.write(key: 'vg_token', value: j['token'] as String);
    await _store.write(key: 'vg_server', value: base);
    await _store.write(key: 'vg_user', value: jsonEncode(user.toJson()));
    return Session(server: base, token: j['token'] as String, user: user);
  }

  void commit(Session s) => state = AsyncData(s);

  Future<void> login(String username, String password, {String? server}) async => commit(await authenticate(username, password, server: server));

  Future<void> logout() async {
    final s = state.value;
    if (s != null) await s.api.logout();
    await _clear();
    state = const AsyncData(null);
  }

  Future<void> _clear() async {
    await _store.delete(key: 'vg_token');
    await _store.delete(key: 'vg_user');
  }
}

final authProvider = AsyncNotifierProvider<AuthController, Session?>(AuthController.new);
final sessionProvider = Provider<Session?>((ref) => ref.watch(authProvider).value);
