import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:swg_bwc/core/services/dock_sync.dart';

void main() {
  group('DockScreen.tryParse', () {
    test('reads what the Dock Agent writes', () {
      final DockScreen? s = DockScreen.tryParse(
        '{"v":1,"phase":"uploading","title":"Uploading recordings","detail":"File 2 of 5","current":2,"total":5,"percent":48,"ts":1}',
      );
      expect(
        s,
        const DockScreen(phase: DockPhase.uploading, title: 'Uploading recordings', detail: 'File 2 of 5', current: 2, total: 5, percent: 48),
      );
    });

    test('a bar without a known size and a missing detail are fine', () {
      final DockScreen? s = DockScreen.tryParse('{"phase":"updating","title":"Updating the camera software","percent":null}');
      expect(s?.phase, DockPhase.updating);
      expect(s?.percent, isNull);
      expect(s?.detail, '');
    });

    test('a percentage outside 0-100 is pulled back into range', () {
      expect(DockScreen.tryParse('{"phase":"uploading","title":"x","percent":250}')?.percent, 100);
      expect(DockScreen.tryParse('{"phase":"uploading","title":"x","percent":-5}')?.percent, 0);
    });

    test('refuses what it does not understand', () {
      expect(DockScreen.tryParse(''), isNull);
      expect(DockScreen.tryParse('not json'), isNull);
      expect(DockScreen.tryParse('[1,2]'), isNull);
      expect(DockScreen.tryParse('{"phase":"dancing","title":"x"}'), isNull, reason: 'a phase from a newer station');
      expect(DockScreen.tryParse('{"phase":"done"}'), isNull, reason: 'no title');
      expect(DockScreen.tryParse('{"phase":"done","title":""}'), isNull);
    });
  });

  group('DockSync', () {
    late Directory dir;
    late DateTime now;
    late DockSync sync;

    File statusFile() => File('${dir.path}/${DockSync.fileName}');

    /// What the Dock Agent does: write the file (it carries its own modification time).
    void agentWrites(String json, {DateTime? at}) {
      statusFile().writeAsStringSync(json);
      statusFile().setLastModifiedSync(at ?? now);
    }

    setUp(() {
      dir = Directory.systemTemp.createTempSync('dock_sync_test');
      now = DateTime(2026, 11, 12, 14);
      sync = DockSync(folder: () async => dir, clock: () => now);
    });

    tearDown(() {
      sync.dispose();
      dir.deleteSync(recursive: true);
    });

    test('says nothing while there is no file', () async {
      await sync.check();
      expect(sync.screen.value, isNull);
    });

    test('shows a fresh file and follows it when the agent writes a new one', () async {
      agentWrites('{"phase":"connected","title":"Docking station","detail":"Connected."}');
      await sync.check();
      expect(sync.screen.value?.phase, DockPhase.connected);

      now = now.add(const Duration(seconds: 2));
      agentWrites('{"phase":"updating","title":"Updating the camera software"}');
      await sync.check();
      expect(sync.screen.value?.phase, DockPhase.updating);
      expect(sync.screen.value?.title, 'Updating the camera software');
    });

    test('the window disappears by itself when the agent stops writing (or the camera is unplugged)', () async {
      agentWrites('{"phase":"uploading","title":"Uploading recordings"}');
      await sync.check();
      expect(sync.screen.value, isNotNull);

      now = now.add(const Duration(seconds: 14));
      await sync.check();
      expect(sync.screen.value, isNotNull, reason: 'still within the allowed age');

      now = now.add(const Duration(seconds: 2));
      await sync.check();
      expect(sync.screen.value, isNull);
    });

    test('removing the file takes the window away at once', () async {
      agentWrites('{"phase":"done","title":"All done"}');
      await sync.check();
      expect(sync.screen.value, isNotNull);

      statusFile().deleteSync();
      await sync.check();
      expect(sync.screen.value, isNull);
    });

    test('a file it cannot read is ignored, and the next good one is shown', () async {
      agentWrites('this is not json');
      await sync.check();
      expect(sync.screen.value, isNull);

      now = now.add(const Duration(seconds: 1));
      agentWrites('{"phase":"attention","title":"Needs attention","detail":"App update failed"}');
      await sync.check();
      expect(sync.screen.value?.phase, DockPhase.attention);
    });

    test('an old file that is written again shows again', () async {
      agentWrites('{"phase":"done","title":"All done"}', at: now.subtract(const Duration(minutes: 5)));
      await sync.check();
      expect(sync.screen.value, isNull, reason: 'left over from long ago');

      agentWrites('{"phase":"done","title":"All done"}');
      await sync.check();
      expect(sync.screen.value, isNotNull);
    });
  });
}
