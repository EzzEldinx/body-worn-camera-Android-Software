import 'dart:io' show Platform;
import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart' as fm;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:latlong2/latlong.dart' as ll;
import 'package:maplibre_gl/maplibre_gl.dart' show LatLng;
import '../../core/api/fleet.dart';
import '../../core/env.dart';
import '../../core/api/zones.dart';
import '../../core/theme/vg_theme.dart';
import 'zone_editor.dart';

/// maplibre_gl has no macOS / Windows / Linux build, so the desktop apps draw the same things (cameras, names, geofence zones, the zone
/// being drawn) with flutter_map on ordinary map tiles. Phones and tablets keep the vector map in map_screen.dart.
const _osmCredit = 'OpenStreetMap contributors'; // a name, not a sentence: it is not translated
bool get useDesktopMap => Platform.isMacOS || Platform.isWindows || Platform.isLinux;

class DesktopMap extends ConsumerStatefulWidget {
  const DesktopMap({super.key, required this.selected, required this.onSelect, required this.controller});
  final String? selected;
  final void Function(String? id) onSelect;
  final fm.MapController controller;
  @override
  ConsumerState<DesktopMap> createState() => _DesktopMapState();
}

class _DesktopMapState extends ConsumerState<DesktopMap> {
  ll.LatLng _p(LatLng p) => ll.LatLng(p.latitude, p.longitude);

  @override
  Widget build(BuildContext context) {
    final v = context.vg;
    final fleet = ref.watch(fleetProvider);
    final cams = fleet.cams.values.where((x) => x.hasPosition).toList();
    final sos = {for (final a in fleet.alarms.where((a) => !a.ack)) a.cameraId};
    final zones = (ref.watch(zonesProvider).value?.zones ?? const <Zone>[]).where((z) => z.active).toList();
    final broken = {for (final a in fleet.alerts.where((a) => a.isGeo)) a.zone};
    final draft = ref.watch(zoneDraftProvider);
    Color colour(Zone z) => broken.contains(z.name) ? v.rec : switch (z.mode) { 'forbidden' => v.rec, 'allowed' => v.ok, 'checkpoint' => v.sel, _ => v.blue };

    final polygons = <fm.Polygon>[
      for (final z in zones)
        fm.Polygon(
          points: [for (final p in z.ring) ll.LatLng(p.lat, p.lng)],
          color: colour(z).withValues(alpha: broken.contains(z.name) ? .30 : .16),
          borderColor: colour(z), borderStrokeWidth: broken.contains(z.name) ? 3.5 : 2.2,
        ),
    ];
    var draftRing = <ll.LatLng>[];
    if (draft != null && draft.pts.isNotEmpty) {
      draftRing = draft.shape == 'circle' && draft.pts.length >= 2
          ? [for (final p in Zone.circlePoints(draft.pts[0].latitude, draft.pts[0].longitude, draft.radius!)) ll.LatLng(p.lat, p.lng)]
          : [for (final p in draft.pts) _p(p)];
      if (draftRing.length >= 3) polygons.add(fm.Polygon(points: draftRing, color: v.brand.withValues(alpha: .18), borderColor: v.brand, borderStrokeWidth: 3));
    }

    return fm.FlutterMap(
      mapController: widget.controller,
      options: fm.MapOptions(
        initialCenter: const ll.LatLng(24.7136, 46.6753), initialZoom: 9, minZoom: 3, maxZoom: 19,
        onTap: (_, point) {
          if (draft != null) { ref.read(zoneDraftProvider.notifier).tap(LatLng(point.latitude, point.longitude)); return; }
          if (widget.selected != null) widget.onSelect(null);
        },
      ),
      children: [
        fm.TileLayer(urlTemplate: kDesktopMapTiles, userAgentPackageName: 'sa.com.smartwaygroup.visionguard', maxZoom: 19),
        fm.PolygonLayer(polygons: polygons),
        if (draft != null && draftRing.length >= 2 && draftRing.length < 3) fm.PolylineLayer(polylines: [fm.Polyline(points: draftRing, color: v.brand, strokeWidth: 3)]),
        fm.MarkerLayer(markers: [
          for (final z in zones)
            fm.Marker(point: ll.LatLng(z.centre.lat, z.centre.lng), width: 140, height: 28, child: IgnorePointer(child: Center(child: _Tag(z.name, colour(z))))),
          if (draft != null) for (final p in draft.pts) fm.Marker(point: _p(p), width: 18, height: 18, child: IgnorePointer(child: _Dot(v.brand, 7, Colors.white))),
          for (final cam in cams)
            fm.Marker(
              point: ll.LatLng(cam.lat!, cam.lng!), width: 170, height: 76, alignment: Alignment.topCenter,
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: () { if (draft == null) widget.onSelect(cam.id); },
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  _Tag('${cam.name}${cam.battery != null ? '  ${cam.battery}%' : ''}${cam.holder == null ? '' : '\n${cam.holder}'}', const Color(0xFF0F1B2D)),
                  const SizedBox(height: 2),
                  Opacity(
                    opacity: cam.gpsFresh ? 1 : .55,
                    child: _Dot(sos.contains(cam.id) || cam.recording ? v.rec : cam.online ? v.ok : v.off, cam.id == widget.selected ? 12 : (sos.contains(cam.id) ? 11 : 9), cam.id == widget.selected ? v.sel : Colors.white, stroke: cam.id == widget.selected ? 4 : 3),
                  ),
                ]),
              ),
            ),
        ]),
        fm.SimpleAttributionWidget(source: Text(_osmCredit)),
      ],
    );
  }
}

class _Dot extends StatelessWidget {
  const _Dot(this.fill, this.r, this.ring, {this.stroke = 3});
  final Color fill, ring;
  final double r, stroke;
  @override
  Widget build(BuildContext context) => Container(width: r * 2 + stroke, height: r * 2 + stroke, decoration: BoxDecoration(color: fill, shape: BoxShape.circle, border: Border.all(color: ring, width: stroke)));
}

class _Tag extends StatelessWidget {
  const _Tag(this.text, this.colour);
  final String text;
  final Color colour;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
        decoration: BoxDecoration(color: Colors.white.withValues(alpha: .88), borderRadius: BorderRadius.circular(6)),
        child: Text(text, textAlign: TextAlign.center, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: colour, fontSize: 12, fontWeight: FontWeight.w700, height: 1.2)),
      );
}
