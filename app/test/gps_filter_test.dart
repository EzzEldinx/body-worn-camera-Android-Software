// The GPS filter, with numbers measured on the real cameras (SDJW-S1): indoors the chip reports a good-looking accuracy with weak satellites.
import 'package:flutter_test/flutter_test.dart';
import 'package:swg_bwc/core/services/gps_filter.dart';

GpsSample fix(double lat, double lng, {double acc = 5, int sats = 9, double cn0 = 32, int still = 0, double alt = 600, double vAcc = 12, DateTime? at}) =>
    GpsSample(lat: lat, lng: lng, accuracy: acc, time: at ?? DateTime.now(), altitude: alt, vertAccuracy: vAcc, satellites: sats, meanCn0: cn0, satelliteInfoFresh: true, stillMs: still);

void main() {
  const lat = 24.66, lng = 46.712;
  final now = DateTime.now();

  test('indoor fixes with a good-looking accuracy are refused (3-4 weak satellites, big vertical accuracy)', () {
    final f = GpsFilter();
    // the real samples: hAcc 10 / 3 sats / 13 dB-Hz; hAcc 9 / 3 sats / 15; hAcc 3 / 8 sats / 14; hAcc 9 / 5 sats / 20 with altitude -120272
    expect(f.judge(fix(24.661785, 46.714397, acc: 10, sats: 3, cn0: 13, vAcc: 51), now).verdict, GpsVerdict.rejected);
    expect(f.judge(fix(24.659853, 46.71262, acc: 9, sats: 3, cn0: 15, vAcc: 127), now).verdict, GpsVerdict.rejected);
    expect(f.judge(fix(24.66008, 46.712103, acc: 3, sats: 8, cn0: 14, vAcc: 47), now).reason, contains('signal'));
    expect(f.judge(fix(25.142362, 46.626392, acc: 9, sats: 5, cn0: 20, alt: -120272, vAcc: 167), now).verdict, GpsVerdict.rejected);
    expect(f.last, isNull, reason: 'nothing was believed, so no position is reported');
  });

  test('an open-sky fix is accepted', () {
    final f = GpsFilter();
    final d = f.judge(fix(lat, lng, acc: 4, sats: 10, cn0: 34, vAcc: 9), now);
    expect(d.verdict, GpsVerdict.accepted);
    expect(d.sample!.lat, lat);
  });

  test('without satellite numbers (old native part) only the accuracy rules apply', () {
    final f = GpsFilter();
    final s = GpsSample(lat: lat, lng: lng, accuracy: 8, time: now, vertAccuracy: 10);
    expect(f.judge(s, now).verdict, GpsVerdict.accepted);
    expect(GpsFilter().judge(GpsSample(lat: lat, lng: lng, accuracy: 45, time: now), now).reason, contains('accuracy'));
  });

  test('a camera that lies still keeps its place while the chip wanders', () {
    final f = GpsFilter();
    expect(f.judge(fix(lat, lng, still: 0), now).verdict, GpsVerdict.accepted);
    // 12 m to 20 m of wander, camera on a desk for 10 s or more
    for (final dLat in [0.00006, -0.00008, 0.0001, -0.00012, 0.00015]) {
      final d = f.judge(fix(lat + dLat, lng, still: 12000), now);
      expect(d.verdict, GpsVerdict.held);
      expect(d.sample!.lat, lat, reason: 'it stays where it was');
    }
  });

  test('a camera that is carried follows the fixes', () {
    final f = GpsFilter();
    f.judge(fix(lat, lng), now);
    final d = f.judge(fix(lat + 0.00005, lng, still: 0), now.add(const Duration(seconds: 1)));
    expect(d.verdict, GpsVerdict.accepted);
    expect(d.sample!.lat, lat + 0.00005);
  });

  test('a still camera is moved by six good fixes in a row far away, not by one', () {
    final f = GpsFilter();
    f.judge(fix(lat, lng), now);
    for (var i = 0; i < 5; i++) {
      expect(f.judge(fix(lat + 0.002, lng, still: 20000), now.add(Duration(seconds: i + 1))).verdict, GpsVerdict.rejected, reason: 'fix ${i + 1} of 6');
    }
    final d = f.judge(fix(lat + 0.002, lng, still: 20000), now.add(const Duration(seconds: 6)));
    expect(d.verdict, GpsVerdict.accepted);
    expect(d.sample!.lat, lat + 0.002);
  });

  test('a jump no vehicle could make is refused, an old fix and a mock location too', () {
    final f = GpsFilter();
    f.judge(fix(lat, lng), now);
    expect(f.judge(fix(lat + 0.5, lng), now.add(const Duration(seconds: 1))).verdict, GpsVerdict.rejected);
    expect(GpsFilter().judge(fix(lat, lng, at: now.subtract(const Duration(seconds: 40))), now).reason, 'old fix');
    expect(GpsFilter().judge(GpsSample(lat: lat, lng: lng, accuracy: 3, time: now, mocked: true), now).reason, 'mock location');
  });

  test('distance helper is right', () {
    expect(GpsFilter.metres(24.66, 46.712, 24.66, 46.712), 0);
    expect(GpsFilter.metres(24.66, 46.712, 24.661, 46.712), closeTo(111, 2));
  });
}
