import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:path_provider/path_provider.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;

class CentralConfig {
  // Build-time defaults (--dart-define) ...
  static String serverUrl = const String.fromEnvironment('BWC_SERVER',
      defaultValue: 'https://visionguard.smartwaygroup.com.sa');
  static String cameraId =
      const String.fromEnvironment('BWC_ID', defaultValue: 'BWC-01');
  static String token =
      const String.fromEnvironment('BWC_TOKEN', defaultValue: 'change-me');

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
    } catch (e) {
      debugPrint('config.json ignored: $e');
    }
  }

  static String get rtmpUrl =>
      'rtmp://${Uri.parse(serverUrl).host}:1935/live/$cameraId';
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
  static const List<String> capabilities = <String>['update-net'];

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
        if (a == 'start' || a == 'stop') _remote.add(a as String);
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
  static const double _maxAccuracyM = 2000;
  static const Duration _maxFixAge = Duration(seconds: 20);
  DateTime? _lastFixAt;
  final ValueNotifier<double?> gpsAccuracy = ValueNotifier(null); // metres of the last accepted fix

  void _onFix(Position p) {
    final now = DateTime.now();
    final fixTime = p.timestamp;
    final age = now.difference(fixTime);
    final bad = p.isMocked || age > _maxFixAge || p.accuracy <= 0 || p.accuracy > _maxAccuracyM ||
        (p.latitude == 0 && p.longitude == 0);
    if (bad) {
      // keep the last good fix for the heartbeat, but do not let a poor one replace it
      gpsAccuracy.value = p.accuracy > 0 ? p.accuracy : null;
      if (_lastFixAt == null || now.difference(_lastFixAt!) > const Duration(seconds: 45)) gpsFix.value = false;
      return;
    }
    _last = p;
    _lastFixAt = now;
    gpsFix.value = true;
    gpsAccuracy.value = p.accuracy;
    _sendGps(p);
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
    });
  }

  Timer? _gpsRetry;

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