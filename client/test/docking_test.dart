import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:visionguard_client/core/api/models.dart';
import 'package:visionguard_client/core/theme/vg_theme.dart';
import 'package:visionguard_client/features/docking/docking_screen.dart';

DockState sample() => DockState.fromJson({
      'slots': 8, 'enabled': true,
      'storage': {'recordings': 49, 'recordingsBytes': 4100000000, 'todayCount': 10, 'todayBytes': 680000000, 'totalBytes': 926000000000, 'freeBytes': 396000000000},
      'docks': [
        {'id': 'dock-1', 'ts': DateTime.now().millisecondsSinceEpoch, 'online': true, 'agent': '1.1', 'mode': 'copy', 'cameras': [
          {'slot': 0, 'state': 'offloading', 'cameraId': 'BWC-06-RIY', 'battery': 84, 'storageFreeMb': 12400, 'files': 33, 'progress': {'index': 7, 'total': 33, 'file': 'VID_1762345678901.mp4', 'bytesDone': 1450000000, 'bytesTotal': 3500000000}},
          {'slot': 1, 'state': 'synced', 'cameraId': 'BWC-07-RIY', 'battery': 97, 'storageFreeMb': 30100, 'files': 16, 'synced': 16, 'lastSyncTs': DateTime.now().millisecondsSinceEpoch},
          {'slot': 2, 'state': 'error', 'cameraId': 'X', 'battery': 12, 'message': 'hash differs after USB copy'},
          {'slot': 3, 'state': 'other'},
        ]},
      ],
    });

void main() {
  for (final size in [const Size(390, 844), const Size(834, 1194)]) {
    testWidgets('docking page lays out without overflow at ${size.width.toInt()} px', (t) async {
      t.view.physicalSize = size * 2; t.view.devicePixelRatio = 2;
      addTearDown(t.view.reset);
      await t.pumpWidget(ProviderScope(
        overrides: [dockingProvider.overrideWith((ref) => Stream.value(sample()))],
        child: MaterialApp(theme: buildTheme(Brightness.light), home: const DockingScreen()),
      ));
      await t.pump(const Duration(milliseconds: 200));
      expect(t.takeException(), isNull);
      expect(find.text('BWC-06-RIY'), findsOneWidget);
      expect(find.text('21%'), findsNothing); // 1.45/3.5 GB = 41%
      expect(find.text('41%'), findsOneWidget);
    });
  }
}
