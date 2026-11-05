import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:swg_bwc/features/dashboard/presentation/widgets/hidden_admin_door.dart';

void main() {
  testWidgets('Hidden Admin Door opens after 7 taps', (tester) async {
    var unlocked = false;
    await tester.pumpWidget(
      MaterialApp(
        home: HiddenAdminDoor(
          onUnlocked: () => unlocked = true,
          child: const Text('SWG'),
        ),
      ),
    );

    for (var i = 0; i < 6; i++) {
      await tester.tap(find.text('SWG'));
      await tester.pump();
    }
    expect(unlocked, isFalse);

    await tester.tap(find.text('SWG'));
    await tester.pump();
    expect(unlocked, isTrue);
  });
}
