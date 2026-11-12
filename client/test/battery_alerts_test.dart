import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:visionguard_client/core/api/fleet.dart';
import 'package:visionguard_client/core/api/models.dart';
import 'package:visionguard_client/core/theme/vg_theme.dart';
import 'package:visionguard_client/features/alerts/alerts_screen.dart';

/// A fleet that never opens a socket: the screens only read its state.
class FakeFleet extends FleetController {
  FakeFleet(this.initial);
  final FleetState initial;
  @override
  FleetState build() => initial;
}

Camera cam(Map<String, dynamic> j) => Camera.fromJson({'cameraId': 'BWC-01', ...j});

void main() {
  group('battery', () {
    test('every camera shows its own battery, with where it came from and whether it charges', () {
      final c = cam({'battery': 83, 'batteryTs': 1000, 'batterySrc': 'camera', 'charging': false});
      expect(c.battery, 83); expect(c.batterySrc, 'camera'); expect(c.charging, isFalse); expect(c.lowBattery, isFalse);
      expect(cam({'battery': 64, 'batterySrc': 'dock', 'charging': true}).charging, isTrue);
      expect(cam({}).battery, isNull);
    });

    test('low means under 20 % and not charging', () {
      expect(cam({'battery': 19}).lowBattery, isTrue);
      expect(cam({'battery': 20}).lowBattery, isFalse);
      expect(cam({'battery': 5, 'charging': true}).lowBattery, isFalse, reason: 'on a charger it is being dealt with');
      expect(cam({}).lowBattery, isFalse);
    });

    test('an alert is parsed and can be acknowledged', () {
      final a = BatteryAlert.fromJson({'id': 4, 'cameraId': 'BWC-03', 'level': 'critical', 'value': 7, 'ts': 123, 'ack': false});
      expect(a.critical, isTrue); expect(a.value, 7); expect(a.ack, isFalse);
      final b = a.acked();
      expect(b.ack, isTrue); expect(b.id, 4); expect(b.cameraId, 'BWC-03'); expect(b.critical, isTrue);
    });

    test('alerts are ordered: open first, critical first, newest first', () {
      BatteryAlert al(int id, String level, int ts, bool ack) => BatteryAlert(id: id, cameraId: 'C$id', level: level, value: 10, ts: ts, ack: ack);
      final out = batteryOrder([al(1, 'warning', 100, false), al(2, 'critical', 50, true), al(3, 'critical', 10, false), al(4, 'warning', 200, false)]);
      expect(out.map((a) => a.id), [3, 4, 1, 2]);
    });

    test('the fleet counts low batteries and unacknowledged alerts', () {
      final s = FleetState(
        cams: {'a': cam({'cameraId': 'a', 'battery': 12}), 'b': cam({'cameraId': 'b', 'battery': 12, 'charging': true}), 'c': cam({'cameraId': 'c', 'battery': 80})},
        alerts: [BatteryAlert(id: 1, cameraId: 'a', level: 'warning', value: 12, ts: 1, ack: false), BatteryAlert(id: 2, cameraId: 'x', level: 'warning', value: 15, ts: 1, ack: true)],
      );
      expect(s.lowBattery, 1); expect(s.openAlerts, 1);
    });
  });

  group('who carries the camera', () {
    test('employee number and custody come from the check-out station', () {
      final c = cam({'holder': ' Ahmed Hassan ', 'holderNo': '0147', 'custody': 'in_use'});
      expect(c.holder, 'Ahmed Hassan'); expect(c.holderNo, '0147'); expect(c.custody, 'in_use');
      expect(cam({'holderNo': '  '}).holderNo, isNull);
    });

    test('an SOS remembers who carried the camera', () {
      final a = Alarm.fromJson({'id': 1, 'cameraId': 'BWC-01', 'ts': 5, 'ack': false, 'holder': 'Ahmed Hassan', 'holderNo': '0147'});
      expect(a.holder, 'Ahmed Hassan'); expect(a.holderNo, '0147');
      expect(a.acked().holder, 'Ahmed Hassan', reason: 'acknowledging keeps the name');
      expect(Alarm.fromJson({'id': 2, 'cameraId': 'x', 'ts': 5, 'ack': false}).holder, isNull);
    });
  });

  test('the licence notice is parsed', () {
    final l = LicenseInfo.fromJson({'state': 'grace', 'show': true, 'daysLeft': -5, 'canManage': true});
    expect(l.show, isTrue); expect(l.bad, isTrue); expect(l.canManage, isTrue);
    expect(LicenseInfo.fromJson({'state': 'expiring', 'show': true, 'daysLeft': 12}).bad, isFalse);
    expect(LicenseInfo.fromJson({'state': 'off', 'show': false}).show, isFalse);
    expect(LicenseInfo.fromJson({'state': 'valid', 'clock': true, 'show': true}).bad, isTrue);
  });

  for (final size in [const Size(390, 844), const Size(834, 1194)]) {
    testWidgets('the Alerts tab lists a low battery above the SOS alarms at ${size.width.toInt()} px', (t) async {
      t.view.physicalSize = size * 2; t.view.devicePixelRatio = 2;
      addTearDown(t.view.reset);
      final state = FleetState(
        cams: {'BWC-03': cam({'cameraId': 'BWC-03', 'name': 'BWC-03', 'battery': 17, 'online': true}), 'BWC-04': cam({'cameraId': 'BWC-04', 'name': 'BWC-04', 'battery': 8, 'online': false})},
        alarms: [Alarm(id: 1, cameraId: 'BWC-03', ts: DateTime.now().millisecondsSinceEpoch, ack: false, holder: 'Ahmed Hassan', holderNo: '0147')],
        alerts: [
          BatteryAlert(id: 5, cameraId: 'BWC-03', level: 'warning', value: 17, ts: DateTime.now().millisecondsSinceEpoch, ack: false),
          BatteryAlert(id: 6, cameraId: 'BWC-04', level: 'critical', value: 8, ts: DateTime.now().millisecondsSinceEpoch, ack: false),
        ],
        loaded: true, connected: true,
      );
      await t.pumpWidget(ProviderScope(
        overrides: [fleetProvider.overrideWith(() => FakeFleet(state))],
        child: MaterialApp(theme: buildTheme(Brightness.light), home: const AlertsScreen()),
      ));
      await t.pump(const Duration(milliseconds: 200));
      expect(t.takeException(), isNull);
      expect(find.textContaining('Battery critical'), findsOneWidget);
      expect(find.textContaining('Low battery'), findsOneWidget);
      expect(find.textContaining('SOS from'), findsOneWidget);
      expect(find.textContaining('Ahmed Hassan'), findsOneWidget, reason: 'the SOS says who carried the camera');
      expect(find.textContaining('#0147'), findsOneWidget);
      // critical (BWC-04) comes before warning (BWC-03), both before the SOS
      double y(String s) => t.getTopLeft(find.textContaining(s).first).dy;
      expect(y('Battery critical'), lessThan(y('Low battery')));
      expect(y('Low battery'), lessThan(y('SOS from')));
      expect(find.text('Dismiss'), findsNWidgets(2));
    });
  }
}
