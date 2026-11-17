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

  /// The language of the app ('en' | 'ar'). It goes with every request, so the server answers in it: error texts, and the language of the push notifications of this phone.
  static String language = 'en';

  // The token goes both ways: as a bearer (new servers) and as the session cookie (servers that predate /api/mobile).
  Map<String, String> get headers => {'content-type': 'application/json', 'x-lang': language, 'accept-language': language, if (token != null) ...{'authorization': 'Bearer $token', 'cookie': 'sid=$token'}};

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
  Future<dynamic> _put(String p, [Object? body]) => _send(() => http.put(_u(p), headers: headers, body: jsonEncode(body ?? {})));
  Future<dynamic> _post(String p, [Object? body]) => _send(() => http.post(_u(p), headers: headers, body: jsonEncode(body ?? {})));

  Future<Map> config() async => (await _get('/api/mobile/config')) as Map;

  /// Returns {token, expiresAt, user}.
  Future<Map> login(String username, String password) async {
    try {
      return (await _post('/api/mobile/login', {'username': username, 'password': password})) as Map;
    } on ApiError catch (e) {
      if (e.status != 404) rethrow;
    }
    // Older server without the mobile API: use the web login and keep its session cookie as the token.
    http.Response r;
    try {
      r = await http.post(_u('/api/login'), headers: {'content-type': 'application/json', 'x-lang': language, 'accept-language': language}, body: jsonEncode({'username': username, 'password': password})).timeout(const Duration(seconds: 15));
    } catch (_) {
      throw ApiError(0, 'offline');
    }
    if (r.statusCode != 200) {
      String msg = 'HTTP ${r.statusCode}';
      try { msg = (jsonDecode(r.body) as Map)['error']?.toString() ?? msg; } catch (_) {}
      throw ApiError(r.statusCode, msg);
    }
    final sid = RegExp(r'sid=([0-9a-f]+)').firstMatch(r.headers['set-cookie'] ?? '')?.group(1);
    if (sid == null) throw ApiError(500, 'no session');
    final user = await Api(server, token: sid).me();
    return {'token': sid, 'expiresAt': DateTime.now().millisecondsSinceEpoch + 7 * 86400000, 'user': user.toJson()};
  }
  Future<void> logout() async { try { await _post('/api/mobile/logout'); } catch (_) {} }
  Future<User> me() async => User.fromJson((await _get('/api/me')) as Map);
  // generic calls for the screens that mirror the web pages (Reports, Check-out, Team, Admin panel)
  Future<dynamic> getJson(String p, [Map<String, String>? q]) => _get(p, q);
  Future<dynamic> postJson(String p, [Object? b]) => _post(p, b);
  Future<dynamic> putJson(String p, [Object? b]) => _put(p, b);
  Future<dynamic> patchJson(String p, Object b) => _send(() => http.patch(_u(p), headers: headers, body: jsonEncode(b)));
  Future<dynamic> deleteJson(String p) => _send(() => http.delete(_u(p), headers: headers));
  /// A one-use link (two minutes) the browser can open to download a report, since a browser cannot send our login header.
  Future<String> downloadLink(String path) async => server + (((await _post('/api/dl', {'path': path})) as Map)['url'] as String);
  Future<LicenseInfo> licenseStatus() async => LicenseInfo.fromJson((await _get('/api/license/status')) as Map);

  /// Short-lived signature for the live URL (the server only grants it for cameras this user may see).
  Future<String> streamSign(String cameraId) async => ((await _get('/api/stream/${Uri.encodeComponent(cameraId)}')) as Map)['sign'] as String;
  String liveUrl(String cameraId, String sign) => '$server/live/${Uri.encodeComponent(cameraId)}.flv?sign=$sign';

  Future<List<Recording>> recordings({String? camera, String? type}) async {
    final j = await _get('/api/recordings', {'camera': ?camera, 'type': ?type}) as Map;
    return (j['recordings'] as List).map((e) => Recording.fromJson(e as Map)).toList();
  }
  String recordingUrl(int id) => '$server/api/recordings/$id/file';

  Future<DockState> docks() async => DockState.fromJson((await _get('/api/docks')) as Map);

  Future<DockFiles> dockFiles(String bucket) async => DockFiles.fromJson((await _get('/api/dock/files', {'state': bucket})) as Map);
  Future<void> chooseDockFiles(List<int> ids, String choice) => _post('/api/dock/files/choose', {'ids': ids, 'choice': choice});
  Future<void> deleteFromCamera(List<int> ids) => _post('/api/dock/files/delete-from-camera', {'ids': ids});
  Future<void> setDockPolicy(String mode) => _put('/api/admin/dock/policy', {'mode': mode});

  Future<List<Ticket>> tickets() async => [for (final t in ((await _get('/api/tickets')) as Map)['tickets'] as List) Ticket.fromJson(t as Map)];
  Future<Ticket> ticket(int id) async => Ticket.fromJson((await _get('/api/tickets/$id')) as Map);
  Future<Map> createTicket({required String subject, required String category, required String priority, required String description, String? cameraId}) async =>
      (await _post('/api/tickets', {'subject': subject, 'category': category, 'priority': priority, 'description': description, 'cameraId': ?cameraId})) as Map;
  Future<void> replyTicket(int id, String body) => _post('/api/tickets/$id/messages', {'body': body});
  Future<void> setTicketStatus(int id, String status) => _post('/api/tickets/$id/status', {'status': status});

  Future<void> registerPush(String pushToken, String platform) => _post('/api/mobile/push', {'token': pushToken, 'platform': platform, 'lang': language});
}
