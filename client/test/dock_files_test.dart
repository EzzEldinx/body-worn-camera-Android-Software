import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:visionguard_client/core/api/models.dart';
import 'package:visionguard_client/core/theme/vg_theme.dart';
import 'package:visionguard_client/features/docking/dock_files_screen.dart';

DockFiles sample() => DockFiles.fromJson({
      'policy': {'mode': 'ask'},
      'counts': {'awaiting': {'n': 2, 'bytes': 1700000000}, 'cloud': {'n': 13, 'bytes': 770000000}},
      'files': [
        {'id': 1, 'cameraId': 'BWC-05-RIY', 'filename': 'VID_1794124133348.mp4', 'size': 1500000000, 'bucket': 'awaiting'},
        {'id': 2, 'cameraId': 'BWC-04-RIY', 'filename': 'VID_1794138241577.mp4', 'size': 134000000, 'bucket': 'awaiting', 'message': 'a long failure message that must wrap and not overflow the row on a phone'},
        {'id': 3, 'cameraId': 'BWC-01-RIY', 'filename': 'IMG_1794138281778.jpg', 'size': 1500000, 'bucket': 'cloud', 'camDeletedTs': 1794150000000},
      ],
    });

void main() {
  for (final size in [const Size(390, 844), const Size(834, 1194)]) {
    testWidgets('dock files page lays out without overflow at ${size.width.toInt()} px', (t) async {
      t.view.physicalSize = size * 2; t.view.devicePixelRatio = 2;
      addTearDown(t.view.reset);
      await t.pumpWidget(ProviderScope(
        overrides: [dockFilesProvider.overrideWith((ref, bucket) => Stream.value(sample()))],
        child: MaterialApp(theme: buildTheme(Brightness.light), home: const DockFilesScreen()),
      ));
      await t.pump(const Duration(milliseconds: 200));
      expect(t.takeException(), isNull);
      expect(find.text('BWC-05-RIY'), findsOneWidget);
      expect(find.text('Removed from camera', skipOffstage: false), findsOneWidget);
    });
  }
  test('counts and flags are parsed', () {
    final d = sample();
    expect(d.counts['awaiting']!.n, 2); expect(d.counts['failed']!.n, 0);
    expect(d.files.last.removed, isTrue); expect(d.files.first.removed, isFalse);
  });
}
