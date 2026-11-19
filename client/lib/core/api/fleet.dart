import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;
import '../../features/auth/auth_controller.dart';
import 'api.dart';
import 'models.dart';
import 'zones.dart';

class StreamResult {
  StreamResult(this.cameraId, this.ok, this.reason, this.action);
  final String cameraId, action;
  final bool ok;
  final String? reason; // offline | live_limit | not_allowed | not_recording | needs_update | sos_open
}

/// One piece of live captions: a draft while somebody still talks (`partial`) or the final text of a sentence.
class CaptionLine {
  CaptionLine({required this.cameraId, required this.text, required this.partial, required this.utt, this.id = 0, this.ts = 0, this.lang});
  final String cameraId, text;
  final bool partial;
  final int utt, id, ts;
  final String? lang;
  factory CaptionLine.fromJson(Map j) => CaptionLine(
        cameraId: '${j['cameraId']}', text: '${j['text'] ?? ''}', partial: j['partial'] == true, utt: (j['utt'] as num?)?.toInt() ?? 0,
        id: (j['id'] as num?)?.toInt() ?? 0, ts: (j['ts'] as num?)?.toInt() ?? 0, lang: j['lang'] as String?,
      );
}

/// A chat message between the control room (the app counts as one) and the officers' cameras.
class ChatMessage {
  ChatMessage({required this.chatType, required this.target, required this.sender, required this.text, required this.ts, required this.mine, this.audio, this.senderId = ''});
  final String chatType, target, sender, text, senderId; // chatType: PUBLIC | PRIVATE | GROUP; target: ALL or a camera id
  final int ts;
  final bool mine;
  final String? audio; // data:audio/...;base64,...
  factory ChatMessage.fromJson(Map j, {required bool mine}) => ChatMessage(
        chatType: '${j['chatType'] ?? 'PUBLIC'}', target: '${j['targetId'] ?? 'ALL'}', sender: '${j['senderName'] ?? j['senderId'] ?? ''}', senderId: '${j['senderId'] ?? ''}',
        text: '${j['message'] ?? ''}', ts: (j['timestamp'] as num?)?.toInt() ?? DateTime.now().millisecondsSinceEpoch, mine: mine, audio: j['audio'] is String ? j['audio'] as String : null,
      );
  bool get isVoice => audio != null;
}

@immutable
class FleetState {
  const FleetState({this.cams = const {}, this.alarms = const [], this.alerts = const [], this.connected = false, this.loaded = false, this.error});
  final Map<String, Camera> cams;
  final List<Alarm> alarms;
  final List<BatteryAlert> alerts; // low-battery alerts that are still open
  final bool connected, loaded;
  final String? error; // why the live connection is not up (shown next to "Reconnecting")

  int get online => cams.values.where((c) => c.online).length;
  int get streaming => cams.values.where((c) => c.recording).length;
  int get openAlarms => alarms.where((a) => !a.ack).length;
  int get openAlerts => alerts.where((a) => !a.ack).length;
  int get lowBattery => cams.values.where((c) => c.lowBattery).length;

  FleetState copy({Map<String, Camera>? cams, List<Alarm>? alarms, List<BatteryAlert>? alerts, bool? connected, bool? loaded, String? error, bool clearError = false}) =>
      FleetState(cams: cams ?? this.cams, alarms: alarms ?? this.alarms, alerts: alerts ?? this.alerts, connected: connected ?? this.connected, loaded: loaded ?? this.loaded, error: clearError ? null : (error ?? this.error));
}

/// One socket.io connection (same events as the web dashboard) that keeps the fleet and the alarms live.
class FleetController extends Notifier<FleetState> {
  io.Socket? _s;
  final _sos = StreamController<Alarm>.broadcast();
  final _battery = StreamController<BatteryAlert>.broadcast();
  final _results = StreamController<StreamResult>.broadcast();
  final _streamUp = StreamController<String>.broadcast();

  Stream<Alarm> get sosEvents => _sos.stream;
  Stream<BatteryAlert> get batteryEvents => _battery.stream; // a camera fell under 20 % (or under 10 %)
  Stream<StreamResult> get results => _results.stream;
  Stream<String> get streamUps => _streamUp.stream;
  final _captions = StreamController<CaptionLine>.broadcast();
  Stream<CaptionLine> get captions => _captions.stream; // live captions of a streaming camera (only sent to people who may read them)
  final _chat = StreamController<ChatMessage>.broadcast();
  Stream<ChatMessage> get chatEvents => _chat.stream;

  @override
  FleetState build() {
    final session = ref.watch(sessionProvider);
    ref.onDispose(() { _s?.clearListeners(); _s?.dispose(); _s = null; });   // detach first: a handler must not touch state while the provider is being disposed
    if (session == null) return const FleetState();
    _connect(session);
    return const FleetState();
  }

  void _connect(Session session) {
    // forceNew: never reuse an earlier connection, it would keep the previous account's session token
    final s = io.io(
      session.server,
      io.OptionBuilder().setTransports(['websocket']).enableForceNew().setAuth({'session': session.token}).setQuery({'session': session.token}).setExtraHeaders({'Cookie': 'sid=${session.token}', 'Authorization': 'Bearer ${session.token}'}).disableAutoConnect().enableReconnection().setReconnectionDelay(1000).setReconnectionDelayMax(8000).build(),
    );
    _s = s;
    s.onConnect((_) => state = state.copy(connected: true, clearError: true));
    s.onDisconnect((_) => state = state.copy(connected: false));
    // A refused socket handshake must not by itself throw the user back to the sign-in page: ask the server whether the session is really
    // invalid (HTTP 401) and only then sign out. Anything else (network, a restart, a busy server) just reconnects.
    s.onConnectError((e) async {
      state = state.copy(connected: false, error: '$e'.replaceAll(RegExp(r'\s+'), ' ').trim());
      if (!'$e'.contains('unauthorized')) return;
      try { await session.api.me(); } on ApiError catch (x) { if (x.unauthorized) ref.read(authProvider.notifier).logout(); } catch (_) {}
    });
    s.on('dashboard_snapshot', (d) {
      final m = d as Map;
      state = state.copy(
        cams: {for (final c in (m['cams'] as List)) '${(c as Map)['cameraId']}': Camera.fromJson(c)},
        alarms: (m['alarms'] as List).map((a) => Alarm.fromJson(a as Map)).toList(),
        alerts: ((m['alerts'] as List?) ?? const []).map((a) => BatteryAlert.fromJson(a as Map)).toList(),
        loaded: true, connected: true,
      );
    });
    s.on('dashboard_cam', (d) { final c = Camera.fromJson(d as Map); state = state.copy(cams: {...state.cams, c.id: c}); });
    s.on('dashboard_cam_removed', (d) { final id = '${(d as Map)['cameraId']}'; state = state.copy(cams: {...state.cams}..remove(id), alerts: state.alerts.where((a) => a.cameraId != id).toList()); });
    s.on('dashboard_alert', (d) {
      final a = BatteryAlert.fromJson(d as Map);
      final was = state.alerts.where((x) => x.id == a.id).firstOrNull;
      state = state.copy(alerts: [a, ...state.alerts.where((x) => x.id != a.id)]);
      if (was == null || (a.critical && !was.critical)) _battery.add(a); // new, or it just got worse (an acknowledgement alone is silent)
    });
    s.on('dashboard_alert_resolved', (d) { final id = ((d as Map)['id'] as num).toInt(); state = state.copy(alerts: state.alerts.where((a) => a.id != id).toList()); });
    s.on('dashboard_sos', (d) { final a = Alarm.fromJson(d as Map); state = state.copy(alarms: [a, ...state.alarms.where((x) => x.id != a.id)]); _sos.add(a); });
    s.on('dashboard_alarm_ack', (d) {
      final id = ((d as Map)['id'] as num).toInt();
      state = state.copy(alarms: [for (final a in state.alarms) a.id == id ? a.acked() : a]);
    });
    s.on('remote_stream_result', (d) { final m = d as Map; _results.add(StreamResult('${m['cameraId']}', m['ok'] == true, m['reason'] as String?, '${m['action'] ?? ''}')); });
    s.on('stream_up', (d) => _streamUp.add('${(d as Map)['cameraId']}'));
    s.on('transcript', (d) { if (d is Map) _captions.add(CaptionLine.fromJson(d)); });
    s.on('receive_message', (d) { if (d is Map) _chat.add(ChatMessage.fromJson(d, mine: false)); });
    s.on('geofences_changed', (_) => ref.invalidate(zonesProvider)); // a zone was drawn, edited or removed on the web: the map follows
    s.connect();
  }

  // The officer does nothing: the camera starts or stops its stream on this command.
  void startLive(String id) => _s?.emit('remote_stream', {'cameraId': id, 'action': 'start'});
  void stopLive(String id) => _s?.emit('remote_stream', {'cameraId': id, 'action': 'stop'});
  /// Ends a recording the OFFICER started (needs the "Stop a recording" permission and a camera that can obey; the officer is told and the file is saved).
  void endRecording(String id) => _s?.emit('remote_stream', {'cameraId': id, 'action': 'stop', 'recording': true});
  /// Chat with the officers. `target` is 'ALL' for everybody, or a camera id for a private message; `audio` is a data:audio/... URL (a voice note).
  void sendChat({required String chatType, required String target, required String message, String? audio}) =>
      _s?.emit('send_message', {'chatType': chatType, 'targetId': target, 'message': message, if (audio != null) 'audio': audio});
  void setQuality(String id, String q) => _s?.emit('set_quality', {'cameraId': id, 'quality': q});
  void ackAlert(int id) {
    _s?.emit('ack_alert', id);
    state = state.copy(alerts: [for (final a in state.alerts) a.id == id ? a.acked() : a]);
  }
  void ack(int id) {
    _s?.emit('ack_alarm', id);
    state = state.copy(alarms: [for (final a in state.alarms) a.id == id ? a.acked() : a]);
  }
}

final fleetProvider = NotifierProvider<FleetController, FleetState>(FleetController.new);
