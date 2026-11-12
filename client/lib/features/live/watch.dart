import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Cameras on the live wall: as many as the chosen layout holds (see WallLayout).
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
  /// The layout got smaller: keep the most recently added cameras.
  void trim(int max) { if (state.length > max) state = state.sublist(state.length - max); }
}

final watchProvider = NotifierProvider<WatchList, List<String>>(WatchList.new);

/// Camera shown in the detail pane on tablets.
class SelectedCam extends Notifier<String?> {
  @override
  String? build() => null;
  void select(String? id) => state = id;
}

final selectedCamProvider = NotifierProvider<SelectedCam, String?>(SelectedCam.new);

/// How many cameras the live wall shows at once. A phone offers 1, 2, 4 or 6; a tablet 1, 4, 6, 9 or 16 (the same choices as the web wall).
class WallLayout extends Notifier<int> {
  @override
  int build() => 4;
  void set(int n) { state = n; ref.read(watchProvider.notifier).trim(n); }
}

final wallLayoutProvider = NotifierProvider<WallLayout, int>(WallLayout.new);

/// Cameras the user closed on the wall; they stay out of the automatic fill until "show all".
class Dismissed extends Notifier<Set<String>> {
  @override
  Set<String> build() => {};
  void add(String id) => state = {...state, id};
  void addAll(Iterable<String> ids) => state = {...state, ...ids};
  void clear() => state = {};
}

final dismissedProvider = NotifierProvider<Dismissed, Set<String>>(Dismissed.new);

/// Which page of the wall is showing when there are more online cameras than the layout holds.
class WallPage extends Notifier<int> {
  @override
  int build() => 0;
  void set(int n) => state = n;
}

final wallPageProvider = NotifierProvider<WallPage, int>(WallPage.new);
