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

/// The map lives inside the Cameras screen. [focus] is the camera the map should centre on; [open] is the phone's list/map switch.
class MapFocus extends Notifier<String?> {
  @override
  String? build() => null;
  void set(String? id) => state = id;
}
final mapFocusProvider = NotifierProvider<MapFocus, String?>(MapFocus.new);

class MapOpen extends Notifier<bool> {
  @override
  bool build() => false;
  void set(bool v) => state = v;
}
final mapOpenProvider = NotifierProvider<MapOpen, bool>(MapOpen.new);

/// Show a camera on the map (from an alarm or from the detail view): back to the Cameras screen with the map on that camera.
void showOnMap(WidgetRef ref, String cameraId) {
  ref.read(selectedCamProvider.notifier).select(null);
  ref.read(mapFocusProvider.notifier).set(cameraId);
  ref.read(mapOpenProvider.notifier).set(true);
}

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
