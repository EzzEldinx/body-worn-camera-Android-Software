import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:path_provider/path_provider.dart';
import 'gps_filter.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;

class CentralConfig {
  // Build-time defaults (--dart-define) ...
  static String serverUrl = const String.fromEnvironment('BWC_SERVER',
      defaultValue: 'https://visionguard.smartwaygroup.com.sa');
  static String cameraId =
      const String.fromEnvironment('BWC_ID', defaultValue: 'BWC-01');
  static String token =
      const String.fromEnvironment('BWC_TOKEN', defaultValue: 'change-me');
  /// This camera's own key for pushing its live stream (the server sends it over the socket, event `push_key`; kept in config.json so a
  /// recording started before the socket is up still has it). Without it a server with RTMP_PUBLISH_AUTH=on refuses the stream.
  static String pushKey = '';

  /// ... overridden per camera by config.json in the app's files folder, which
  /// tools/update-cameras.ps1 writes: {"id": "BWC-05-RIY", "server": "http://...:3000", "token": "..."}.
  /// One APK therefore serves every camera.
  static Future<void> load() async {
    try {
      final dir = await getExternalStorageDirectory();
      if (dir == null) return;
      final f = File('${dir.path}/config.json');
      if (!await f.exists()) return;
      final j = jsonDecode(await f.readAsString());
      if (j is! Map) return;
      if (j['id'] is String && (j['id'] as String).isNotEmpty) cameraId = j['id'] as String;
      if (j['server'] is String && (j['server'] as String).isNotEmpty) serverUrl = j['server'] as String;
      if (j['token'] is String && (j['token'] as String).isNotEmpty) token = j['token'] as String;
      if (j['pushKey'] is String) pushKey = j['pushKey'] as String;
      await _moveToHttps(f, Map<String, dynamic>.from(j));
    } catch (e) {
      debugPrint('config.json ignored: $e');
    }
  }

  /// Cameras provisioned earlier talk to `http://<ip>:3000`. When that is the case, and the HTTPS address built into this app
  /// answers /healthz, switch to it and remember it in config.json. If it does not answer, nothing changes (the old address keeps working).
  static Future<void> _moveToHttps(File f, Map<String, dynamic> j) async {
    const secure = String.fromEnvironment('BWC_SERVER', defaultValue: 'https://visionguard.smartwaygroup.com.sa');
    if (!serverUrl.startsWith('http://') || !secure.startsWith('https://')) return;
    final host = Uri.tryParse(serverUrl)?.host ?? '';
    if (host == '127.0.0.1' || host == 'localhost') return; // a test server reached through `adb reverse`: never moved away
    final c = HttpClient()..connectionTimeout = const Duration(seconds: 6);
    try {
      final r = await (await c.getUrl(Uri.parse('$secure/healthz'))).close().timeout(const Duration(seconds: 8));
      await r.drain<void>();
      if (r.statusCode != 200) return;
      serverUrl = secure;
      j['server'] = secure;
      await f.writeAsString(jsonEncode(j));
      debugPrint('server address moved to $secure');
    } catch (e) {
      debugPrint('https not reachable, keeping $serverUrl ($e)');
    } finally {
      c.close(force: true);
    }
  }

  static String get rtmpUrl =>
      'rtmp://${Uri.parse(serverUrl).host}:1935/live/$cameraId${pushKey.isEmpty ? '' : '?key=$pushKey'}';

  /// Remembers the push key the server sent (only when it changed).
  static Future<void> savePushKey(String key) async {
    if (key == pushKey || !RegExp(r'^[0-9a-f]{32}$').hasMatch(key)) return;
    pushKey = key;
    try {
      final dir = await getExternalStorageDirectory();
      if (dir == null) return;
      final f = File('${dir.path}/config.json');
      final j = await f.exists() ? jsonDecode(await f.readAsString()) : <String, dynamic>{};
      if (j is! Map) return;
      j['pushKey'] = key;
      await f.writeAsString(jsonEncode(j));
    } catch (e) {
      debugPrint('push key not saved: $e');
    }
  }
}

class ChatGroup {
  final String id;
  final String name;
  ChatGroup({required this.id, required this.name});
}

class ChatMessage {
  final String chatType;
  final String targetId;
  final String senderName;
  final String text;
  final int ts;
  final bool mine;
  final String? audio; // data:audio/...;base64,... for voice notes

  ChatMessage({
    required this.chatType,
    required this.targetId,
    required this.senderName,
    required this.text,
    required this.ts,
    required this.mine,
    this.audio,
  });
}

class CentralLink {
  /// What this camera app can do for the server, reported with the status. 'update-net': it keeps an update to Wi-Fi when told to (see
  /// AppUpdater); the server only updates a "Wi-Fi only" camera over the network when it knows this.
  /// 'remote-stop': it ends a recording the officer started when the control room asks for exactly that (see remoteCommands 'stop_force');
  /// the server only sends that to a camera that reports it.
  static const List<String> capabilities = <String>['update-net', 'remote-stop'];

  // Who carries this camera (told by the server after the employee took it at the check-out station) and the server's clock.
  final ValueNotifier<Map<String, dynamic>?> assignment = ValueNotifier(null);
  int clockOffsetMs = 0; // server time minus this device's clock: the stamp on the picture is right even if the device clock is wrong
  DateTime get serverNow => DateTime.now().add(Duration(milliseconds: clockOffsetMs));

  /// The company this camera belongs to, told by the server together with the assignment (empty until the first message).
  String company = '';

  /// What is written into the picture, bottom right: date and time, camera ID, employee ID, GPS position and the company.
  String stampText() {
    String two(int n) => n.toString().padLeft(2, '0');
    final t = serverNow;
    final a = assignment.value;
    final who = a == null ? 'NO USER' : 'USER ${(a['employeeNo'] ?? '').toString().isNotEmpty ? a['employeeNo'] : a['username']}';
    final p = _last, at = _lastFixAt;
    final gps = (p != null && at != null && DateTime.now().difference(at) < const Duration(seconds: 120))
        ? 'GPS ${p.latitude.toStringAsFixed(5)}, ${p.longitude.toStringAsFixed(5)}'
        : 'GPS NO FIX';
    return '${t.year}-${two(t.month)}-${two(t.day)} ${two(t.hour)}:${two(t.minute)}:${two(t.second)}\n'
        'CAM ${CentralConfig.cameraId}  $who\n'
        '$gps${company.isEmpty ? '' : '\n$company'}';
  }

  static const _device = MethodChannel('com.swg.bwc/device');
  int? _lastBat;
  bool? _lastChg;
  DateTime? _lastBatAt;

  /// The camera's own battery, shown on its own screen at all times and reported to the dashboard (under 20 % and not charging raises an alert there).
  final ValueNotifier<({int level, bool charging})?> battery = ValueNotifier(null);
  Timer? _batTimer;

  Future<void> _sendBattery() async {
    try {
      final m = await _device.invokeMapMethod<String, dynamic>('battery');
      final level = m?['level'] as int?;
      if (level == null || level < 0) return;
      final charging = m?['charging'] == true, now = DateTime.now();
      battery.value = (level: level, charging: charging);
      if (!_online) return;
      if (level == _lastBat && charging == _lastChg && _lastBatAt != null && now.difference(_lastBatAt!) < const Duration(seconds: 120)) return;
      _lastBat = level; _lastChg = charging; _lastBatAt = now;
      _socket!.emit('camera_battery', {'cameraId': CentralConfig.cameraId, 'battery': level, 'charging': charging});
    } catch (_) {/* no battery information on this device */}
  }
  io.Socket? _socket;
  StreamSubscription<Position>? _gpsSub;
  Timer? _heartbeat;
  Position? _last;

  final _msgs = StreamController<String>.broadcast();
  Stream<String> get messages => _msgs.stream;

  /// Commands from the control room that the officer does not have to act on ('start' / 'stop' live stream).
  final _remote = StreamController<String>.broadcast();
  Stream<String> get remoteCommands => _remote.stream;

  /// 'update_app' commands: {build, size, force}.
  final _update = StreamController<Map<String, dynamic>>.broadcast();
  Stream<Map<String, dynamic>> get updateCommands => _update.stream;

  /// Build id (SHA-256 of the installed APK), reported to the dashboard so it knows who is outdated.
  String? appBuild;

  /// Progress of a remote update: downloading / installing / waiting / failed / done.
  void sendUpdate(String state, {int? pct, String? error}) {
    if (!_online) return;
    _socket!.emit('camera_update', {
      'cameraId': CentralConfig.cameraId,
      'state': state,
      if (pct != null) 'pct': pct,
      if (error != null) 'error': error,
    });
  }

  /// Re-sends the status (e.g. once the build id has been computed).
  void refreshStatus() => _emitStatus();

  /// Quality changes requested by the control room ('240p' | '480p' | '720p' | '1080p' | '4k').
  final _quality = StreamController<String>.broadcast();
  Stream<String> get qualityCommands => _quality.stream;
  bool _pendingSos = false;
  int? _myAlarm;

  final ValueNotifier<bool> connected = ValueNotifier(false); // link to the control room
  final ValueNotifier<bool> gpsFix = ValueNotifier(false);
  final ValueNotifier<List<ChatMessage>> chatMessages = ValueNotifier([]);
  final ValueNotifier<List<ChatGroup>> chatGroups = ValueNotifier([]);
  final ValueNotifier<Map<String, int>> unreadByChat = ValueNotifier({});
  String? _activeChatKey;

  void openChat(String key) {
    _activeChatKey = key;
    final map = Map<String, int>.from(unreadByChat.value);
    map[key] = 0;
    unreadByChat.value = map;
  }

  void closeChat() {
    _activeChatKey = null;
  }

  bool sendChat(String type, String target, String text, {String? audio}) {
    if (!_online) return false;
    final targetId = (type == 'PUBLIC') ? 'ALL' : target;

    _socket!.emit('send_message', {
      'chatType': type,
      'targetId': targetId,
      'message': text,
      if (audio != null) 'audio': audio,
    });

    final newItem = ChatMessage(
      chatType: type,
      targetId: target,
      senderName: CentralConfig.cameraId,
      text: text,
      ts: DateTime.now().millisecondsSinceEpoch,
      mine: true,
      audio: audio,
    );
    chatMessages.value = [...chatMessages.value, newItem];
    return true;
  }

  // 👈 دالة توافقية عشان أي استدعاء قديم لـ sendChatMessage يشتغل عادي
  bool sendChatMessage({
    required String chatType,
    required String targetId,
    required String message,
  }) {
    return sendChat(chatType, targetId, message);
  }

  void start() {
    _batTimer?.cancel();
    _sendBattery();
    _batTimer = Timer.periodic(const Duration(seconds: 15), (_) => _sendBattery());
    _socket = io.io(
      CentralConfig.serverUrl,
      io.OptionBuilder()
          .setTransports(['websocket'])
          .setAuth({'token': CentralConfig.token})
          .enableAutoConnect()
          .build(),
    );

    _socket!
      ..onConnect((_) {
        connected.value = true;
        _emitStatus();
        _sendBattery();
        debugPrint('Connected to central server');
        _socket!.emit('register', {
          'id': CentralConfig.cameraId,
          'type': 'bwc',
        });
        if (_pendingSos) _sendSos();
      })
      ..onDisconnect((_) {
        connected.value = false;
        debugPrint('Disconnected from central server');
      })

      ..on('receive_message', (d) {
        if (d is Map) {
          final senderId = (d['senderId'] ?? '').toString();
          final myId = CentralConfig.cameraId;

          // 👈 منع التكرار: لو الرسالة من نفس الكاميرا (سواء BWC-01 أو BWC-01-RIY) نطنشها لأننا أضفناها محلياً
          if (senderId == myId || senderId.startsWith(myId) || myId.startsWith(senderId)) {
            return;
          }

          final chatType = d['chatType'] ?? 'PUBLIC';
          final senderName = d['senderName'] ?? (senderId.isEmpty ? 'Control Room' : senderId);
          final text = d['message'] ?? '';
          final audio = d['audio'] is String && (d['audio'] as String).isNotEmpty ? d['audio'] as String : null;
          final ts = (d['timestamp'] as num?)?.toInt() ?? DateTime.now().millisecondsSinceEpoch;

          String targetId = d['targetId'] ?? 'ALL';
          if (chatType == 'PUBLIC') {
            targetId = 'all';
          } else if (chatType == 'PRIVATE') {
            targetId = CentralConfig.cameraId;
          }

          final msg = ChatMessage(
            chatType: chatType,
            targetId: targetId,
            senderName: senderName,
            text: text,
            ts: ts,
            mine: false,
            audio: audio,
          );

          chatMessages.value = [...chatMessages.value, msg];
          _msgs.add('$senderName: $text');

          final chatKey = '$chatType:$targetId';
          if (_activeChatKey != chatKey) {
            final map = Map<String, int>.from(unreadByChat.value);
            map[chatKey] = (map[chatKey] ?? 0) + 1;
            unreadByChat.value = map;
          }
        }
      })
      
      ..on('assignment', (d) {
        if (d is! Map) return;
        final st = (d['serverTime'] as num?)?.toInt();
        if (st != null) clockOffsetMs = st - DateTime.now().millisecondsSinceEpoch;
        if (d['company'] is String) company = d['company'] as String;
        assignment.value = d['active'] == true ? Map<String, dynamic>.from(d) : null;
      })
      ..on('update_app', (d) {
        if (d is Map) _update.add(Map<String, dynamic>.from(d));
      })
      ..on('set_quality', (d) {
        final q = d is Map ? d['quality'] : null;
        if (q is String) _quality.add(q);
      })
      ..on('remote_stream', (d) {
        final a = d is Map ? d['action'] : null;
        if (a == 'stop' && d is Map && d['force'] == true) {
          _remote.add('stop_force'); // the control room ends a recording the officer started, on purpose
        } else if (a == 'start' || a == 'stop') {
          _remote.add(a as String);
        }
      })
      ..on('push_key', (d) {
        if (d is Map && d['key'] is String && (d['cameraId'] == null || d['cameraId'] == CentralConfig.cameraId)) CentralConfig.savePushKey(d['key'] as String);
      })
      ..on('join_group', (d) {
        if (d is Map && d['groupId'] != null) {
          final gId = d['groupId'].toString();
          final current = List<ChatGroup>.from(chatGroups.value);
          if (!current.any((g) => g.id == gId)) {
            current.add(ChatGroup(id: gId, name: 'Group $gId'));
            chatGroups.value = current;
          }
        }
      })
      ..on('dashboard_sos', (d) {
        if (d is Map && d['cameraId'] == CentralConfig.cameraId) {
          _myAlarm = (d['id'] as num?)?.toInt();
          _msgs.add('SOS received by the control room');
        }
      })
      ..on('dashboard_alarm_ack', (d) {
        if (d is Map && _myAlarm != null && (d['id'] as num?)?.toInt() == _myAlarm) {
          _msgs.add('SOS acknowledged by a dispatcher');
        }
      });

    _startGps();
  }

  bool get _online => _socket?.connected == true;

  // A position is only reported when it is a REAL, recent, accurate fix. Before, the last value was re-sent
  // every 10 s forever (even a stale one the GPS chip remembered from another city), which put cameras
  // kilometres away from where they really were.
  // Indoors / on a dock the chip often returns a rough fix (100-1000 m). Report it with its accuracy so the dashboard
  // can show the camera and "±N m" instead of nothing; stale or zero fixes are still rejected below.
  DateTime? _lastFixAt;
  final ValueNotifier<double?> gpsAccuracy = ValueNotifier(null); // metres of the last accepted fix

  // What the chip cannot tell by itself (see GnssQuality.kt and gps_filter.dart): satellites used and their signal strength, and whether the
  // camera lies still. Indoors the chip claims "accuracy 1-10 m" with 3-4 weak satellites while the position wanders hundreds of metres.
  final GpsFilter _filter = GpsFilter();
  final ValueNotifier<bool> gpsWeak = ValueNotifier(false); // true while the chip has a position but it is not trustworthy (indoors, no sky)
  Map<String, dynamic> _gnssInfo = const {};
  bool _fixBusy = false;

  DateTime _gpsLogAt = DateTime.fromMillisecondsSinceEpoch(0);
  void _logGps(String m) { // one line every 10 s (adb logcat -s flutter), to see why a position was or was not used
    final now = DateTime.now();
    if (now.difference(_gpsLogAt) < const Duration(seconds: 10)) return;
    _gpsLogAt = now;
    // ignore: avoid_print
    print('GPS: $m');
  }

  Future<Map<String, dynamic>> _gnss() async {
    try {
      final m = await _device.invokeMethod('gnssQuality');
      return m is Map ? m.map((k, v) => MapEntry('$k', v)) : const {};
    } catch (_) {
      return const {};
    }
  }

  void _onFix(Position p) {
    if (_fixBusy) return; // fixes come every second; one that arrives while the last is still being judged is dropped
    _fixBusy = true;
    _judgeFix(p).whenComplete(() => _fixBusy = false);
  }

  Future<void> _judgeFix(Position p) async {
    final now = DateTime.now();
    final q = await _gnss();
    _gnssInfo = q;
    final age = (q['statusAgeMs'] as num?)?.toInt() ?? -1;
    final sample = GpsSample(
      lat: p.latitude, lng: p.longitude, accuracy: p.accuracy, time: p.timestamp, altitude: p.altitude, vertAccuracy: p.altitudeAccuracy,
      mocked: p.isMocked, satellites: (q['used'] as num?)?.toInt(), meanCn0: (q['meanCn0'] as num?)?.toDouble(),
      satelliteInfoFresh: age >= 0 && age < 10000, stillMs: (q['stillMs'] as num?)?.toInt() ?? 0,
    );
    final d = _filter.judge(sample, now);
    gpsWeak.value = d.weak && !p.isMocked;
    _logGps('${d.verdict.name}${d.reason == null ? '' : ' (${d.reason})'}: acc ${p.accuracy.round()} m, sats ${q['used']}, cn0 ${(q['meanCn0'] as num?)?.toStringAsFixed(0)}, still ${q['stillMs']} ms');
    if (d.verdict == GpsVerdict.rejected) {
      // keep the last good fix for the heartbeat, but do not let a poor one replace it
      gpsAccuracy.value = p.accuracy > 0 ? p.accuracy : null;
      if (_lastFixAt == null || now.difference(_lastFixAt!) > const Duration(seconds: 45)) gpsFix.value = false;
      return;
    }
    final s = d.sample!;
    _last = Position(latitude: s.lat, longitude: s.lng, timestamp: now, accuracy: s.accuracy, altitude: s.altitude, altitudeAccuracy: s.vertAccuracy.isFinite ? s.vertAccuracy : 0,
        heading: p.heading, headingAccuracy: p.headingAccuracy, speed: p.speed, speedAccuracy: p.speedAccuracy);
    _lastFixAt = now;
    gpsFix.value = true;
    gpsAccuracy.value = s.accuracy;
    _sendGps(_last!);   // a held position goes out again with a fresh time, so the dashboard shows it live and not "last known"
  }

  void _sendGps(Position p) {
    if (!_online) return;
    _socket!.emit('camera_gps_update', {
      'cameraId': CentralConfig.cameraId,
      'lat': p.latitude,
      'lng': p.longitude,
      'acc': p.accuracy,
      'fixTs': (_lastFixAt ?? DateTime.now()).millisecondsSinceEpoch,
      if (p.speed.isFinite && p.speed >= 0) 'speed': p.speed,
      // for the diagnosis on the server: how good the fix was (satellites used, their mean signal in dB-Hz) and whether the camera lies still
      if (_gnssInfo['used'] != null) 'sats': _gnssInfo['used'],
      if (_gnssInfo['meanCn0'] != null) 'cn0': ((_gnssInfo['meanCn0'] as num) * 10).round() / 10,
      if (_gnssInfo['stillMs'] != null) 'still': (_gnssInfo['stillMs'] as num) >= _filter.stillAfter.inMilliseconds,
    });
  }

  Timer? _gpsRetry;
  Timer? _assistTimer;
  Timer? _gpsWatchdog;
  DateTime _gpsStartedAt = DateTime.now();

  // A GPS chip can get stuck: it lists no satellites, its clock stops, and it never produces a fix, for hours, with a clear sky (seen on a real
  // camera: 83 minutes without a fix; switching the location off and on made it fix within 10 minutes). If no fix has come for 15 minutes, stop
  // the location stream for a few seconds and start it again, which makes Android restart the chip. Not sooner: a normal cold start can take
  // 10 minutes and a restart would throw that progress away.
  static const Duration _stuckAfter = Duration(minutes: 15);
  void _armGpsWatchdog() {
    _gpsWatchdog?.cancel();
    _gpsWatchdog = Timer.periodic(const Duration(minutes: 1), (_) async {
      final now = DateTime.now();
      final g = await _gnss(); // once a minute, so the log shows the sky the chip sees even when it makes no fix (indoors)
      // ignore: avoid_print
      print('GPS-sky: used ${g['used']} of ${g['visible']} satellites, mean ${(g['meanCn0'] as num?)?.toStringAsFixed(1)} dB-Hz, best ${(g['maxCn0'] as num?)?.toStringAsFixed(1)}, still ${g['stillMs']} ms');
      final since = _lastFixAt ?? _gpsStartedAt;
      if (now.difference(since) < _stuckAfter || now.difference(_gpsStartedAt) < _stuckAfter) return;
      await _gpsSub?.cancel();
      _gpsSub = null;
      await Future.delayed(const Duration(seconds: 5));
      _startGps(); // subscribes again (and gives the chip the time again)
    });
  }

  Future<void> _assistGps() async {
    try { await _device.invokeMethod('gpsAssist'); } catch (_) {}
  }

  // Location can be switched off (or the permission missing) when the app starts, e.g. a camera whose location
  // setting was never enabled. Before, that meant no position until the next reboot; now we keep trying.
  void _retryGpsSoon() {
    _gpsRetry?.cancel();
    _gpsRetry = Timer(const Duration(seconds: 20), _startGps);
  }

  Future<void> _startGps() async {
    if (!await Geolocator.isLocationServiceEnabled()) { gpsFix.value = false; _retryGpsSoon(); return; }
    var perm = await Geolocator.checkPermission();
    if (perm == LocationPermission.denied) {
      perm = await Geolocator.requestPermission();
    }
    if (perm == LocationPermission.denied ||
        perm == LocationPermission.deniedForever) { gpsFix.value = false; _retryGpsSoon(); return; }

    await _gpsSub?.cancel();
    _gpsSub = Geolocator.getPositionStream(
      locationSettings: AndroidSettings(
        accuracy: LocationAccuracy.best, // GPS + BeiDou/GLONASS, not network guesses
        distanceFilter: 0,
        intervalDuration: const Duration(seconds: 1),
        forceLocationManager: true,
        // A foreground service of type "location" with a wake lock. Without it Android treats the app as a background app as soon as the
        // screen is off: location updates are throttled to a few per hour and arrive in batches, so a camera that is carried with its screen
        // off looked frozen for minutes and geofence alerts came late or never. (Measured on a real camera: 559 of 9765 minutes in the foreground.)
        foregroundNotificationConfig: const ForegroundNotificationConfig(
          notificationTitle: 'VisionGuard',
          notificationText: 'Camera location is on',
          notificationChannelName: 'Camera location',
          notificationIcon: AndroidResource(name: 'ic_stat_location', defType: 'drawable'), // the project has no mipmap launcher icon: Android refuses a notification without a valid icon and the app crashed
          enableWakeLock: true,
          enableWifiLock: true,
          setOngoing: true,
        ),
      ),
    ).listen(_onFix);

    // The chip's clock is wrong after a long time without a fix: give it the time and the assistance data now, and again every few minutes
    // while there is still no fix (a camera that sat on a dock indoors needed 10-30 minutes to get its first fix without this).
    _gpsStartedAt = DateTime.now();
    _armGpsWatchdog();
    _assistGps();
    _assistTimer?.cancel();
    _assistTimer = Timer.periodic(const Duration(minutes: 3), (_) { if (!gpsFix.value) _assistGps(); });

    _heartbeat?.cancel();
    _heartbeat = Timer.periodic(const Duration(seconds: 10), (_) {
      _sendBattery();
      // repeat the last GOOD fix only while it is still recent; after that the camera says nothing about
      // position and the dashboard shows "no GPS fix" instead of a stale point
      final p = _last, at = _lastFixAt;
      if (p != null && at != null && DateTime.now().difference(at) < const Duration(seconds: 45)) {
        _sendGps(p);
      } else {
        gpsFix.value = false;
      }
    });
  }

  // Last known status, re-sent on every (re)connect so the dashboard sees the camera as online
  // immediately, not only after the first GPS fix.
  /// true = the camera chooses its own quality from the network; null = not known yet
  bool? qualityAuto;
  bool _statusRecording = false;
  String? _statusQuality;
  bool? _statusRemote;

  void sendStatus({required bool recording, String? quality, bool? remote}) {
    _statusRecording = recording;
    _statusQuality = quality ?? _statusQuality;
    _statusRemote = remote;
    _emitStatus();
  }

  void _emitStatus() {
    if (!_online) return;
    _socket!.emit('camera_status', {
      'cameraId': CentralConfig.cameraId,
      'recording': _statusRecording,
      if (_statusQuality != null) 'quality': _statusQuality,
      if (qualityAuto != null) 'qualityAuto': qualityAuto,
      if (_statusRemote != null) 'remote': _statusRemote,
      if (appBuild != null) 'build': appBuild,
      'caps': capabilities,
    });
  }

  bool emitSos() {
    _pendingSos = true;
    if (!_online) return false;
    _sendSos();
    return true;
  }

  void _sendSos() {
    _pendingSos = false;
    _socket!.emit('camera_sos', {
      'cameraId': CentralConfig.cameraId,
      'lat': _last?.latitude,
      'lng': _last?.longitude,
    });
  }

  void sendPtt(bool active) {
    if (!_online) return;
    _socket!.emit('camera_ptt', {'cameraId': CentralConfig.cameraId, 'active': active});
  }

  void dispose() {
    _gpsRetry?.cancel();
    _heartbeat?.cancel();
    _batTimer?.cancel();
    _assistTimer?.cancel();
    _gpsWatchdog?.cancel();
    _gpsSub?.cancel();
    _socket?.dispose();
    _msgs.close();
    _remote.close();
    _quality.close();
    _update.close();
    chatMessages.dispose();
    chatGroups.dispose();
    unreadByChat.dispose();
  }
}

final centralLinkProvider = Provider<CentralLink>((ref) {
  final link = CentralLink()..start();
  ref.onDispose(link.dispose);
  return link;
});