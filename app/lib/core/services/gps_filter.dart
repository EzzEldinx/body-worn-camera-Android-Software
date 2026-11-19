import 'dart:math' as math;

/// One position as the chip reports it, plus what the native side knows about the satellites and the movement of the camera.
class GpsSample {
  const GpsSample({
    required this.lat, required this.lng, required this.accuracy, required this.time,
    this.altitude = 0, this.vertAccuracy = double.nan, this.mocked = false,
    this.satellites, this.meanCn0, this.satelliteInfoFresh = false, this.stillMs = 0,
  });
  final double lat, lng, accuracy, altitude, vertAccuracy;
  final DateTime time;
  final bool mocked;
  final int? satellites;         // satellites the chip used for this fix (null = unknown)
  final double? meanCn0;         // their mean signal, dB-Hz
  final bool satelliteInfoFresh; // the satellite numbers are recent (the callback is alive)
  final int stillMs;             // how long the accelerometer says the camera has lain still (0 = it is moving)
}

enum GpsVerdict { rejected, held, accepted }

class GpsDecision {
  const GpsDecision(this.verdict, this.reason, [this.sample]);
  final GpsVerdict verdict;
  final String? reason;       // why a fix was refused (null when used)
  final GpsSample? sample;    // the position to report (for `held`: the place the camera is kept at)
  bool get weak => reason != null && (reason!.contains('satellite') || reason!.contains('signal') || reason!.contains('accuracy'));
}

/// Decides which positions of the GPS chip are believed. Measured on the real cameras (SDJW-S1) lying on a desk indoors: the chip says
/// "accuracy 1-10 m" with 3-4 satellites at 13-18 dB-Hz (outdoors 8+ at 25-40), altitudes of -120000 m, a vertical accuracy of 47-200 m, speeds of
/// 2-180 m/s, and a position that wanders 300 m, so the claimed accuracy alone cannot be trusted. A fix counts only when
///  * its accuracy is within [goodAccM], its vertical accuracy within [maxVertAccM];
///  * at least [minSatellites] satellites were used with a mean signal of at least [minCn0] dB-Hz (when the native numbers are there);
///  * it is not a jump nobody could make, nor an impossible altitude, nor a mock location.
/// A camera that lies still keeps its place: small wander is ignored, and only [reseatAfter] good fixes in a row far away move it.
class GpsFilter {
  GpsFilter({
    this.goodAccM = 30, this.maxVertAccM = 75, this.minSatellites = 4, this.minCn0 = 20,
    this.maxAge = const Duration(seconds: 20), this.stillAfter = const Duration(seconds: 8), this.reseatAfter = 6,
  });
  final double goodAccM, maxVertAccM, minCn0;
  final int minSatellites, reseatAfter;
  final Duration maxAge, stillAfter;

  GpsSample? last;      // the last position that was reported
  DateTime? lastAt;
  GpsSample? _held;
  int _reseat = 0, _rejected = 0;

  static double metres(double lat1, double lng1, double lat2, double lng2) {
    const r = 6371000.0;
    double rad(double d) => d * math.pi / 180;
    final dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
    final a = math.pow(math.sin(dLat / 2), 2) + math.cos(rad(lat1)) * math.cos(rad(lat2)) * math.pow(math.sin(dLng / 2), 2);
    return 2 * r * math.asin(math.min(1, math.sqrt(a)));
  }

  String? weakReason(GpsSample p) {
    if (p.accuracy > goodAccM) return 'accuracy ${p.accuracy.round()} m';
    if (p.vertAccuracy.isFinite && p.vertAccuracy > maxVertAccM) return 'vertical accuracy ${p.vertAccuracy.round()} m';
    if (p.satelliteInfoFresh) {
      final used = p.satellites ?? 0;
      if (used < minSatellites) return 'only $used satellites';
      if ((p.meanCn0 ?? 0) < minCn0) return 'weak signal ${(p.meanCn0 ?? 0).toStringAsFixed(0)} dB-Hz';
    }
    return null;
  }

  // A chip that has just started can report nonsense with a small "accuracy": an impossible altitude, or a jump no person or vehicle could make
  // since the last good fix. After 8 such fixes in a row the new place is accepted (the old one may have been the wrong one).
  bool _implausible(GpsSample p, DateTime now) {
    var bad = false;
    if (p.altitude != 0 && (p.altitude < -300 || p.altitude > 3500)) bad = true;
    final l = last, at = lastAt;
    if (!bad && l != null && at != null) {
      final dt = now.difference(at).inSeconds;
      if (dt < 180) {
        final m = metres(l.lat, l.lng, p.lat, p.lng);
        if (m > 300 && m / (dt < 1 ? 1 : dt) > 70) bad = true; // faster than 250 km/h
      }
    }
    if (!bad) { _rejected = 0; return false; }
    if (++_rejected > 8) { _rejected = 0; return false; }
    return true;
  }

  GpsDecision judge(GpsSample p, DateTime now) {
    if (p.mocked) return const GpsDecision(GpsVerdict.rejected, 'mock location');
    if (p.accuracy <= 0) return const GpsDecision(GpsVerdict.rejected, 'no accuracy');
    if (now.difference(p.time) > maxAge) return const GpsDecision(GpsVerdict.rejected, 'old fix');
    if (p.lat == 0 && p.lng == 0) return const GpsDecision(GpsVerdict.rejected, 'zero position');
    final weak = weakReason(p);
    if (weak != null) return GpsDecision(GpsVerdict.rejected, weak);
    if (_implausible(p, now)) return const GpsDecision(GpsVerdict.rejected, 'implausible jump or altitude');

    final l = last;
    if (p.stillMs < stillAfter.inMilliseconds) {
      _held = null;
      _reseat = 0;
    } else if (l != null) {
      final held = _held ??= l;
      final d = metres(held.lat, held.lng, p.lat, p.lng);
      if (d <= math.max(25, p.accuracy * 3)) {
        _reseat = 0;
        lastAt = now;
        return GpsDecision(GpsVerdict.held, null, held);
      }
      if (++_reseat < reseatAfter) return const GpsDecision(GpsVerdict.rejected, 'far fix while the camera lies still');
      _held = null;
      _reseat = 0;
    }
    last = p;
    lastAt = now;
    return GpsDecision(GpsVerdict.accepted, null, p);
  }
}
