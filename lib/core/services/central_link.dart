import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;

class CentralConfig {
  static const serverUrl = String.fromEnvironment('BWC_SERVER',
      defaultValue: 'http://192.168.100.75:3000');
  static const cameraId =
      String.fromEnvironment('BWC_ID', defaultValue: 'BWC-01');
  static const token =
      String.fromEnvironment('BWC_TOKEN', defaultValue: 'change-me');

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
  io.Socket? _socket;
  StreamSubscription<Position>? _gpsSub;
  Timer? _heartbeat;
  Position? _last;

  final _msgs = StreamController<String>.broadcast();
  Stream<String> get messages => _msgs.stream;
  bool _pendingSos = false;
  int? _myAlarm;

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
        debugPrint('Connected to central server');
        _socket!.emit('register', {
          'id': CentralConfig.cameraId,
          'type': 'bwc',
        });
        if (_pendingSos) _sendSos();
      })
      ..onDisconnect((_) => debugPrint('Disconnected from central server'))

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

  void _sendGps(Position p) {
    if (!_online) return;
    _socket!.emit('camera_gps_update', {
      'cameraId': CentralConfig.cameraId,
      'lat': p.latitude,
      'lng': p.longitude,
    });
  }

  Future<void> _startGps() async {
    if (!await Geolocator.isLocationServiceEnabled()) return;
    var perm = await Geolocator.checkPermission();
    if (perm == LocationPermission.denied) {
      perm = await Geolocator.requestPermission();
    }
    if (perm == LocationPermission.denied ||
        perm == LocationPermission.deniedForever) return;

    await _gpsSub?.cancel();
    _gpsSub = Geolocator.getPositionStream(
      locationSettings: AndroidSettings( // 👈 شلنا كلمة const هنا
        accuracy: LocationAccuracy.high,
        distanceFilter: 2,
        intervalDuration: const Duration(seconds: 5),
        forceLocationManager: true,
      ),
    ).listen((p) {
      _last = p;
      _sendGps(p);
    });

    _heartbeat?.cancel();
    _heartbeat = Timer.periodic(const Duration(seconds: 10), (_) {
      final p = _last;
      if (p != null) _sendGps(p);
    });
  }

  void sendStatus({required bool recording}) {
    if (!_online) return;
    _socket!.emit('camera_status',
        {'cameraId': CentralConfig.cameraId, 'recording': recording});
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
    _heartbeat?.cancel();
    _gpsSub?.cancel();
    _socket?.dispose();
    _msgs.close();
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