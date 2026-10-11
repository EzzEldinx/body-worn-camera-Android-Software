import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;

/// Set at build time, e.g.
/// flutter run --dart-define=BWC_SERVER=http://192.168.100.75:3000
///             --dart-define=BWC_ID=BWC-01 --dart-define=BWC_TOKEN=secret
class CentralConfig {
  static const serverUrl = String.fromEnvironment('BWC_SERVER',
      defaultValue: 'http://192.168.100.75:3000');
  static const cameraId =
      String.fromEnvironment('BWC_ID', defaultValue: 'BWC-01');
  static const token =
      String.fromEnvironment('BWC_TOKEN', defaultValue: 'change-me');

  /// Stream key = camera ID, so the dashboard plays /live/<cameraId>.flv
  static String get rtmpUrl =>
      'rtmp://${Uri.parse(serverUrl).host}:1935/live/$cameraId';
}

/// Owns the socket and the GPS stream so any screen can report to the
/// control room (recording state, SOS) through [centralLinkProvider].
class CentralLink {
  io.Socket? _socket;
  StreamSubscription<Position>? _gpsSub;
  Timer? _heartbeat;
  Position? _last;

  final _msgs = StreamController<String>.broadcast();
  Stream<String> get messages => _msgs.stream; // feedback for the officer
  bool _pendingSos = false;
  int? _myAlarm;

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
        if (_pendingSos) _sendSos(); // an SOS raised while offline goes out now
      })
      ..onDisconnect((_) => debugPrint('Disconnected from central server'))
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

    // GPS runs independently of the socket, so it starts even if the
    // server is down at launch.
    _startGps();
  }

  bool get _online => _socket?.connected == true;

  void _sendGps(Position p) {
    if (!_online) return; // don't queue stale fixes while offline
    _socket!.emit('camera_gps_update', {
      'cameraId': CentralConfig.cameraId,
      'lat': p.latitude,
      'lng': p.longitude,
    });
  }

  Future<void> _startGps() async {
    if (!await Geolocator.isLocationServiceEnabled()) {
      debugPrint('Location services are disabled.');
      return;
    }
    var perm = await Geolocator.checkPermission();
    if (perm == LocationPermission.denied) {
      perm = await Geolocator.requestPermission();
    }
    if (perm == LocationPermission.denied ||
        perm == LocationPermission.deniedForever) {
      debugPrint('Location permission not granted.');
      return;
    }

    await _gpsSub?.cancel(); // never stack listeners
    _gpsSub = Geolocator.getPositionStream(
      locationSettings: AndroidSettings(
        accuracy: LocationAccuracy.high,
        distanceFilter: 2,
        intervalDuration: const Duration(seconds: 5),
        // This device has no Google Play Services, so use Android's own
        // LocationManager instead of the fused provider.
        forceLocationManager: true,
      ),
    ).listen((p) {
      _last = p;
      _sendGps(p);
    });

    // Keep-alive: a stationary officer still shows as online.
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

  /// Returns true if sent now; otherwise it is queued and sent on reconnect.
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
  }
}

final centralLinkProvider = Provider<CentralLink>((ref) {
  final link = CentralLink()..start();
  ref.onDispose(link.dispose);
  return link;
});