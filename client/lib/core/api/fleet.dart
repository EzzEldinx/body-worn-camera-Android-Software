import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;
import '../../features/auth/auth_controller.dart';
import 'models.dart';

class StreamResult {
  StreamResult(this.cameraId, this.ok, this.reason, this.action);
  final String cameraId, action;
  final bool ok;
  final String? reason; // offline | live_limit
}

@immutable
class FleetState {
  const FleetState({this.cams = const {}, this.alarms = const [], this.connected = false, this.loaded = false});
  final Map<String, Camera> cams;
  final List<Alarm> alarms;
  final bool connected, loaded;

  int get online => cams.values.where((c) => c.online).length;
  int get streaming => cams.values.where((c) => c.recording).length;
  int get openAlarms => alarms.where((a) => !a.ack).length;

  FleetState copy({Map<String, Camera>? cams, List<Alarm>? alarms, bool? connected, bool? loaded}) =>
      FleetState(cams: cams ?? this.cams, alarms: alarms ?? this.alarms, connected: connected ?? this.connected, loaded: loaded ?? this.loaded);
}

/// One socket.io connection (same events as the web dashboard) that keeps the fleet and the alarms live.
class FleetController extends Notifier<FleetState> {
  io.Socket? _s;
  final _sos = StreamController<Alarm>.broadcast();
  final _results = StreamController<StreamResult>.broadcast();
  final _streamUp = StreamController<String>.broadcast();

  Stream<Alarm> get sosEvents => _sos.stream;
  Stream<StreamResult> get results => _results.stream;
  Stream<String> get streamUps => _streamUp.stream;

  @override
  FleetState build() {
    final session = ref.watch(sessionProvider);
    ref.onDispose(() { _s?.dispose(); _s = null; });
    if (session == null) return const FleetState();
    _connect(session);
    return const FleetState();
  }

  void _connect(Session session) {
    final s = io.io(
      session.server,
      io.OptionBuilder().setTransports(['websocket']).setAuth({'session': session.token}).setExtraHeaders({'Cookie': 'sid=${session.token}'}).disableAutoConnect().enableReconnection().setReconnectionDelay(1000).setReconnectionDelayMax(8000).build(),
    );
    _s = s;
    s.onConnect((_) => state = state.copy(connected: true));
    s.onDisconnect((_) => state = state.copy(connected: false));
    s.onConnectError((e) { if ('$e'.contains('unauthorized')) ref.read(authProvider.notifier).logout(); });
    s.on('dashboard_snapshot', (d) {
      final m = d as Map;
      state = state.copy(
        cams: {for (final c in (m['cams'] as List)) '${(c as Map)['cameraId']}': Camera.fromJson(c)},
        alarms: (m['alarms'] as List).map((a) => Alarm.fromJson(a as Map)).toList(),
        loaded: true, connected: true,
      );
    });
    s.on('dashboard_cam', (d) { final c = Camera.fromJson(d as Map); state = state.copy(cams: {...state.cams, c.id: c}); });
    s.on('dashboard_cam_removed', (d) { final id = '${(d as Map)['cameraId']}'; state = state.copy(cams: {...state.cams}..remove(id)); });
    s.on('dashboard_sos', (d) { final a = Alarm.fromJson(d as Map); state = state.copy(alarms: [a, ...state.alarms.where((x) => x.id != a.id)]); _sos.add(a); });
    s.on('dashboard_alarm_ack', (d) {
      final id = ((d as Map)['id'] as num).toInt();
      state = state.copy(alarms: [for (final a in state.alarms) a.id == id ? a.acked() : a]);
    });
    s.on('remote_stream_result', (d) { final m = d as Map; _results.add(StreamResult('${m['cameraId']}', m['ok'] == true, m['reason'] as String?, '${m['action'] ?? ''}')); });
    s.on('stream_up', (d) => _streamUp.add('${(d as Map)['cameraId']}'));
    s.connect();
  }

  // The officer does nothing: the camera starts or stops its stream on this command.
  void startLive(String id) => _s?.emit('remote_stream', {'cameraId': id, 'action': 'start'});
  void stopLive(String id) => _s?.emit('remote_stream', {'cameraId': id, 'action': 'stop'});
  void setQuality(String id, String q) => _s?.emit('set_quality', {'cameraId': id, 'quality': q});
  void ack(int id) {
    _s?.emit('ack_alarm', id);
    state = state.copy(alarms: [for (final a in state.alarms) a.id == id ? a.acked() : a]);
  }
}

final fleetProvider = NotifierProvider<FleetController, FleetState>(FleetController.new);
