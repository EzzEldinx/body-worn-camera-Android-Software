import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Cameras on the live wall (one on a phone, up to four on a tablet).
class WatchList extends Notifier<List<String>> {
  @override
  List<String> build() => [];
  void add(String id, {int max = 1}) {
    if (state.contains(id)) return;
    final n = [...state, id];
    state = n.length > max ? n.sublist(n.length - max) : n;
  }
  void remove(String id) => state = state.where((e) => e != id).toList();
  void only(String id) => state = [id];
}

final watchProvider = NotifierProvider<WatchList, List<String>>(WatchList.new);

/// Camera shown in the detail pane on tablets.
class SelectedCam extends Notifier<String?> {
  @override
  String? build() => null;
  void select(String? id) => state = id;
}

final selectedCamProvider = NotifierProvider<SelectedCam, String?>(SelectedCam.new);
