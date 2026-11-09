import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:visionguard_client/core/api/models.dart';
import 'package:visionguard_client/core/theme/vg_theme.dart';
import 'package:visionguard_client/features/support/support_screen.dart';

void main() {
  test('tickets are parsed with their conversation', () {
    final t = Ticket.fromJson({'id': 3, 'ref': 'VG-00003', 'subject': 'Camera offline', 'status': 'in_progress', 'priority': 'urgent', 'category': 'camera', 'updated': 1,
      'messages': [{'author': 'Ahmed', 'staff': false, 'body': 'help', 'ts': 1}, {'author': 'Support', 'staff': true, 'body': 'looking', 'ts': 2}]});
    expect(t.messages.length, 2); expect(t.messages.last.staff, isTrue); expect(t.status, 'in_progress');
  });
  for (final size in [const Size(390, 844), const Size(834, 1194)]) {
    testWidgets('support list lays out without overflow at ${size.width.toInt()} px', (t) async {
      t.view.physicalSize = size * 2; t.view.devicePixelRatio = 2;
      addTearDown(t.view.reset);
      await t.pumpWidget(ProviderScope(
        overrides: [ticketsProvider.overrideWith((ref) async => [
          Ticket(id: 1, ref: 'VG-00001', subject: 'A very long subject that must wrap onto a second line instead of overflowing the card on a phone', status: 'open', priority: 'high', category: 'camera', updated: DateTime.now().millisecondsSinceEpoch, replies: 2, by: 'ahmed'),
          Ticket(id: 2, ref: 'VG-00002', subject: 'Docking', status: 'resolved', priority: 'low', category: 'docking', updated: 1),
        ])],
        child: MaterialApp(theme: buildTheme(Brightness.light), home: const SupportScreen()),
      ));
      await t.pump(const Duration(milliseconds: 300));
      expect(t.takeException(), isNull);
      expect(find.text('VG-00002 · ', findRichText: false, skipOffstage: false), findsNothing);
      expect(find.textContaining('VG-00001'), findsOneWidget);
    });
  }
}
