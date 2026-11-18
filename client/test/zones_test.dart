import 'package:flutter_test/flutter_test.dart';
import 'package:visionguard_client/core/api/zones.dart';

void main() {
  test('a circle becomes a 64-point outline around its centre', () {
    final z = Zone.fromJson({'id': 1, 'name': 'Gate', 'kind': 'zone', 'onExit': true, 'onEnter': false, 'active': true,
      'shape': {'type': 'circle', 'lat': 24.7, 'lng': 46.7, 'r': 200}});
    expect(z.mode, 'allowed');
    expect(z.ring.length, 64);
    expect(z.centre.lat, closeTo(24.7, 1e-9));
    final north = z.ring.map((p) => p.lat).reduce((a, b) => a > b ? a : b);
    expect((north - 24.7) * 111320, closeTo(200, 3));   // 200 m is about 0.0018 degrees of latitude
  });
  test('a polygon keeps its corners and the mode follows the rule', () {
    final z = Zone.fromJson({'id': 2, 'name': 'Yard', 'kind': 'zone', 'onExit': false, 'onEnter': true, 'severity': 'critical',
      'shape': {'type': 'polygon', 'pts': [[24.0, 46.0], [24.0, 46.1], [24.1, 46.05]]}});
    expect(z.mode, 'forbidden');
    expect(z.critical, true);
    expect(z.ring.length, 3);
  });
  test('a checkpoint and a both-ways zone', () {
    expect(Zone.fromJson({'id': 3, 'name': 'P', 'kind': 'checkpoint', 'shape': {'type': 'circle', 'lat': 1, 'lng': 1, 'r': 50}}).mode, 'checkpoint');
    expect(Zone.fromJson({'id': 4, 'name': 'B', 'kind': 'zone', 'onExit': true, 'onEnter': true, 'shape': {'type': 'circle', 'lat': 1, 'lng': 1, 'r': 50}}).mode, 'both');
  });
}
