import 'dart:math' as math;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../features/auth/auth_controller.dart';

/// A geofence zone as the server sends it (GET /api/geofences). Only what the map needs.
class Zone {
  Zone({required this.id, required this.name, required this.kind, required this.mode, required this.circle, required this.ring, required this.active, required this.critical});
  final int id;
  final String name;
  final String kind;              // zone | checkpoint
  final String mode;              // allowed | forbidden | both | checkpoint | none
  final ({double lat, double lng, double r})? circle;
  final List<({double lat, double lng})> ring;   // the outline: the polygon's corners, or a circle drawn as 64 points
  final bool active, critical;

  factory Zone.fromJson(Map j) {
    final sh = (j['shape'] as Map?) ?? const {};
    final kind = '${j['kind'] ?? 'zone'}';
    final exit = j['onExit'] == true, enter = j['onEnter'] == true;
    final mode = kind == 'checkpoint' ? 'checkpoint' : exit && enter ? 'both' : enter ? 'forbidden' : exit ? 'allowed' : 'none';
    ({double lat, double lng, double r})? circle;
    var ring = <({double lat, double lng})>[];
    if (sh['type'] == 'circle') {
      final lat = (sh['lat'] as num).toDouble(), lng = (sh['lng'] as num).toDouble(), r = (sh['r'] as num).toDouble();
      circle = (lat: lat, lng: lng, r: r);
      ring = circlePoints(lat, lng, r);
    } else if (sh['type'] == 'polygon') {
      ring = [for (final p in (sh['pts'] as List)) _pt(p)];
    }
    return Zone(id: (j['id'] as num).toInt(), name: '${j['name'] ?? ''}', kind: kind, mode: mode, circle: circle, ring: ring, active: j['active'] != false, critical: j['severity'] == 'critical');
  }

  static ({double lat, double lng}) _pt(dynamic p) => p is Map ? (lat: (p['lat'] as num).toDouble(), lng: (p['lng'] as num).toDouble()) : (lat: (p[0] as num).toDouble(), lng: (p[1] as num).toDouble());

  /// A circle of [r] metres as a closed ring of [n] points (good enough at city scale).
  static List<({double lat, double lng})> circlePoints(double lat, double lng, double r, [int n = 64]) {
    const earth = 6371000.0;
    final dLat = r / earth * 180 / math.pi, dLng = r / (earth * math.cos(lat * math.pi / 180)) * 180 / math.pi;
    return [for (var i = 0; i < n; i++) (lat: lat + dLat * math.sin(2 * math.pi * i / n), lng: lng + dLng * math.cos(2 * math.pi * i / n))];
  }

  /// Centre of the outline, where the name is written.
  ({double lat, double lng}) get centre {
    if (circle != null) return (lat: circle!.lat, lng: circle!.lng);
    var la = 0.0, ln = 0.0;
    for (final p in ring) { la += p.lat; ln += p.lng; }
    return (lat: la / ring.length, lng: ln / ring.length);
  }
}

/// The zones of this company (empty when the account has no Geofencing feature or the server is older). Reload with ref.invalidate(zonesProvider).
final zonesProvider = FutureProvider<List<Zone>>((ref) async {
  final session = ref.watch(sessionProvider);
  if (session == null) return const [];
  try {
    final d = await session.api.getJson('/api/geofences') as Map;
    return [for (final z in (d['zones'] as List? ?? const [])) Zone.fromJson(z as Map)].where((z) => z.ring.length >= 3).toList();
  } catch (_) { return const []; }
});
