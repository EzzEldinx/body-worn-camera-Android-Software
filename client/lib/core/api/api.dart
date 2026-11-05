import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;
import 'models.dart';

class ApiError implements Exception {
  ApiError(this.status, this.message);
  final int status; // 0 = no connection
  final String message;
  bool get unauthorized => status == 401;
  bool get offline => status == 0;
  @override
  String toString() => message;
}

/// The server's HTTP API (same endpoints as the web dashboard, plus /api/mobile/*). Auth: `Authorization: Bearer TOKEN`.
class Api {
  Api(this.server, {this.token});
  final String server;
  final String? token;

  Map<String, String> get headers => {'content-type': 'application/json', if (token != null) 'authorization': 'Bearer $token'};

  Future<dynamic> _send(Future<http.Response> Function() call) async {
    http.Response r;
    try {
      r = await call().timeout(const Duration(seconds: 15));
    } on TimeoutException {
      throw ApiError(0, 'timeout');
    } catch (_) {
      throw ApiError(0, 'offline');
    }
    dynamic body;
    try { body = r.body.isEmpty ? {} : jsonDecode(r.body); } catch (_) { body = {}; }
    if (r.statusCode >= 200 && r.statusCode < 300) return body;
    throw ApiError(r.statusCode, (body is Map ? body['error'] : null)?.toString() ?? 'HTTP ${r.statusCode}');
  }

  Uri _u(String p, [Map<String, String>? q]) => Uri.parse(server + p).replace(queryParameters: q);
  Future<dynamic> _get(String p, [Map<String, String>? q]) => _send(() => http.get(_u(p, q), headers: headers));
  Future<dynamic> _post(String p, [Object? body]) => _send(() => http.post(_u(p), headers: headers, body: jsonEncode(body ?? {})));

  Future<Map> config() async => (await _get('/api/mobile/config')) as Map;

  /// Returns {token, expiresAt, user}.
  Future<Map> login(String username, String password) async => (await _post('/api/mobile/login', {'username': username, 'password': password})) as Map;
  Future<void> logout() async { try { await _post('/api/mobile/logout'); } catch (_) {} }
  Future<User> me() async => User.fromJson((await _get('/api/me')) as Map);

  /// Short-lived signature for the live URL (the server only grants it for cameras this user may see).
  Future<String> streamSign(String cameraId) async => ((await _get('/api/stream/${Uri.encodeComponent(cameraId)}')) as Map)['sign'] as String;
  String liveUrl(String cameraId, String sign) => '$server/live/${Uri.encodeComponent(cameraId)}.flv?sign=$sign';

  Future<List<Recording>> recordings({String? camera, String? type}) async {
    final j = await _get('/api/recordings', {'camera': ?camera, 'type': ?type}) as Map;
    return (j['recordings'] as List).map((e) => Recording.fromJson(e as Map)).toList();
  }
  String recordingUrl(int id) => '$server/api/recordings/$id/file';

  Future<void> registerPush(String pushToken, String platform) => _post('/api/mobile/push', {'token': pushToken, 'platform': platform});
}
