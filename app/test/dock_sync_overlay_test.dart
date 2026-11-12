import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:swg_bwc/core/services/dock_sync.dart';
import 'package:swg_bwc/features/dashboard/presentation/widgets/dock_sync_overlay.dart';

/// The overlay sits on top of a button, like it sits on top of the camera controls.
Future<void> show(WidgetTester tester, DockScreen screen, {bool compact = false, VoidCallback? onUnderTap}) {
  return tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Stack(
          children: [
            Center(child: ElevatedButton(onPressed: onUnderTap ?? () {}, child: const Text('under'))),
            Positioned.fill(child: DockSyncOverlay(screen: screen, compact: compact)),
          ],
        ),
      ),
    ),
  );
}

void main() {
  const DockScreen uploading = DockScreen(
    phase: DockPhase.uploading,
    title: 'Uploading recordings',
    detail: 'File 2 of 5',
    current: 2,
    total: 5,
    percent: 48,
  );

  testWidgets('uploading: the title, the file count, the bar and the percentage', (tester) async {
    await show(tester, uploading);
    expect(find.text('Uploading recordings'), findsOneWidget);
    expect(find.text('File 2 of 5'), findsOneWidget);
    expect(find.text('48%'), findsOneWidget);
    final LinearProgressIndicator bar = tester.widget(find.byType(LinearProgressIndicator));
    expect(bar.value, closeTo(0.48, 0.001));
    expect(find.byIcon(Icons.cloud_upload_rounded), findsOneWidget);
  });

  testWidgets('a bar of unknown size keeps running instead of showing a number', (tester) async {
    await show(tester, const DockScreen(phase: DockPhase.updating, title: 'Updating the camera software', detail: 'Please wait. Do not unplug the camera.'));
    final LinearProgressIndicator bar = tester.widget(find.byType(LinearProgressIndicator));
    expect(bar.value, isNull);
    expect(find.textContaining('%'), findsNothing);
    expect(find.text('Please wait. Do not unplug the camera.'), findsOneWidget);
  });

  testWidgets('done and attention have no bar', (tester) async {
    await show(tester, const DockScreen(phase: DockPhase.done, title: 'All done', detail: 'Camera software updated'));
    expect(find.text('All done'), findsOneWidget);
    expect(find.byType(LinearProgressIndicator), findsNothing);
    expect(find.byIcon(Icons.check_circle_rounded), findsOneWidget);

    await show(tester, const DockScreen(phase: DockPhase.attention, title: 'Needs attention', detail: 'App update failed'));
    expect(find.byType(LinearProgressIndicator), findsNothing);
    expect(find.byIcon(Icons.error_outline_rounded), findsOneWidget);
  });

  testWidgets('the full window takes the taps: nothing under it can be pressed while the station works', (tester) async {
    int taps = 0;
    await show(tester, uploading, onUnderTap: () => taps++);
    await tester.tap(find.text('under'), warnIfMissed: false);
    expect(taps, 0);
  });

  testWidgets('while recording it is a thin bar that lets every tap through', (tester) async {
    int taps = 0;
    await show(tester, uploading, compact: true, onUnderTap: () => taps++);
    expect(find.text('Uploading recordings · File 2 of 5'), findsOneWidget);
    expect(find.byType(LinearProgressIndicator), findsNothing);
    await tester.tap(find.text('under'));
    expect(taps, 1);
  });
}
