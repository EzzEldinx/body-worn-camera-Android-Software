import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/api/fleet.dart';
import '../auth/auth_controller.dart';

/// The chat history of this run of the app (the server relays messages, it does not keep them; the web dashboard works the same way).
/// Messages sent from this account are added here when they are sent; the server's echo of them is ignored.
class ChatController extends Notifier<List<ChatMessage>> {
  final _incoming = StreamController<ChatMessage>.broadcast();
  /// A message from an officer arrived (for a notice wherever the user is).
  Stream<ChatMessage> get incoming => _incoming.stream;

  @override
  List<ChatMessage> build() {
    final session = ref.watch(sessionProvider);
    if (session == null) return const [];
    final sub = ref.read(fleetProvider.notifier).chatEvents.listen((m) {
      if (m.senderId.toUpperCase() == 'ADMIN') return; // sent from the control room (this app or a web dashboard): shown when it was sent
      state = [...state, m].length > 500 ? [...state, m].sublist(1) : [...state, m];
      _incoming.add(m);
    });
    ref.onDispose(sub.cancel);
    return const [];
  }

  void send({required String chatType, required String target, required String text, String? audio, required String senderName}) {
    ref.read(fleetProvider.notifier).sendChat(chatType: chatType, target: target, message: text, audio: audio);
    state = [...state, ChatMessage(chatType: chatType, target: target, sender: senderName, text: text, ts: DateTime.now().millisecondsSinceEpoch, mine: true, audio: audio, senderId: 'ADMIN')];
  }
}

final chatProvider = NotifierProvider<ChatController, List<ChatMessage>>(ChatController.new);

/// How many messages from officers arrived since the chat screen was last open (for a badge).
class ChatUnread extends Notifier<int> {
  @override
  int build() {
    final sub = ref.read(chatProvider.notifier).incoming.listen((_) => state = state + 1);
    ref.onDispose(sub.cancel);
    return 0;
  }
  void clear() => state = 0;
}

final chatUnreadProvider = NotifierProvider<ChatUnread, int>(ChatUnread.new);

/// Which thread the Chat tab should show: a camera id, 'ALL' for the broadcast, or null (keep what is open). Set by a notice or by the camera panel.
class ChatFocus extends Notifier<String?> {
  @override
  String? build() => null;
  void show(String? target) => state = target;
}

final chatFocusProvider = NotifierProvider<ChatFocus, String?>(ChatFocus.new);
