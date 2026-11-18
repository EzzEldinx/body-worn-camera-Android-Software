import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:maplibre_gl/maplibre_gl.dart';
import '../../core/api/fleet.dart';
import '../../core/api/models.dart';
import '../../core/api/zones.dart';
import '../../core/l10n/strings.dart';
import '../../core/theme/vg_theme.dart';
import '../../core/widgets/widgets.dart';
import '../live/watch.dart';
import 'zone_editor.dart';

/// Live map: same OpenFreeMap style as the web dashboard, one coloured dot per camera. It sits inside the Cameras screen
/// (beside the list on a tablet, behind the list/map switch on a phone), so it has no app bar of its own.
class MapPane extends ConsumerStatefulWidget {
  const MapPane({super.key, this.focusCam});
  final String? focusCam;
  @override
  ConsumerState<MapPane> createState() => _MapPaneState();
}

class _MapPaneState extends ConsumerState<MapPane> {
  MapLibreMapController? _c;
  Timer? _debounce;
  String? _selected;
  bool _fitted = false;
  final _byCircle = <String, String>{}; // circle id -> camera id
  final _bySymbol = <String, String>{}; // label id -> camera id

  @override
  void initState() { super.initState(); _selected = widget.focusCam; }

  @override
  void didUpdateWidget(MapPane old) {
    super.didUpdateWidget(old);
    if (widget.focusCam != null && widget.focusCam != old.focusCam) { _selected = widget.focusCam; _focus(); }
  }

  @override
  void dispose() { _debounce?.cancel(); super.dispose(); }

  String _hex(Color c) => '#${(c.toARGB32() & 0xFFFFFF).toRadixString(16).padLeft(6, '0')}';

  Future<void> _draw() async {
    final c = _c;
    if (c == null) return;
    final cams = ref.read(fleetProvider).cams.values.where((x) => x.hasPosition).toList();
    final v = context.vg;
    final sos = {for (final a in ref.read(fleetProvider).alarms.where((a) => !a.ack)) a.cameraId};
    await c.clearCircles();
    await c.clearSymbols();
    await c.clearFills();
    await c.clearLines();
    _byCircle.clear();
    _bySymbol.clear();
    await _drawZones(c);
    await _drawDraft(c);
    if (cams.isEmpty) return;
    final opts = [
      for (final cam in cams) CircleOptions(
        geometry: LatLng(cam.lat!, cam.lng!), circleRadius: cam.id == _selected ? 12 : (sos.contains(cam.id) ? 11 : 9),
        circleColor: _hex(sos.contains(cam.id) || cam.recording ? v.rec : cam.online ? v.ok : v.off), circleOpacity: cam.gpsFresh ? 1 : .55,
        circleStrokeColor: cam.id == _selected ? _hex(v.sel) : '#FFFFFF', circleStrokeWidth: cam.id == _selected ? 4 : 3,
      ),
    ];
    final made = await c.addCircles(opts, [for (final cam in cams) {'id': cam.id}]);
    for (var i = 0; i < made.length; i++) { _byCircle[made[i].id] = cams[i].id; }
    // The name (and who carries it) floats above every camera, like the pop-up on the web map.
    final labels = await c.addSymbols([
      for (final cam in cams) SymbolOptions(
        geometry: LatLng(cam.lat!, cam.lng!),
        textField: '${cam.name}${cam.battery != null ? '  ${cam.battery}%' : ''}${cam.holder == null ? '' : '\n${cam.holder}'}',
        textSize: 12, textColor: '#0F1B2D', textHaloColor: '#FFFFFF', textHaloWidth: 2.2, textHaloBlur: .4,
        textOffset: const Offset(0, -2.1), textAnchor: 'bottom', fontNames: const ['Noto Sans Bold'], textMaxWidth: 12,
        textJustify: 'center', zIndex: cam.id == _selected ? 1 : 0,
      ),
    ], [for (final cam in cams) {'id': cam.id}]);
    for (var i = 0; i < labels.length; i++) { _bySymbol[labels[i].id] = cams[i].id; }
    if (!_fitted) { _fitted = true; _fitAll(cams); }
    if (widget.focusCam != null && _selected == widget.focusCam) _focus();
  }

  // Geofence zones (read only): a soft fill and an outline in the colour of the rule, red while a camera is breaking it, with the name in the middle.
  Future<void> _drawZones(MapLibreMapController c) async {
    final zones = (ref.read(zonesProvider).value?.zones ?? const <Zone>[]).where((z) => z.active).toList();
    if (zones.isEmpty) return;
    final v = context.vg;
    final broken = {for (final a in ref.read(fleetProvider).alerts.where((a) => a.isGeo)) a.zone};
    Color colour(Zone z) => broken.contains(z.name) ? v.rec : switch (z.mode) { 'forbidden' => v.rec, 'allowed' => v.ok, 'checkpoint' => v.sel, _ => v.blue };
    for (final z in zones) {
      final pts = [for (final p in z.ring) LatLng(p.lat, p.lng)];
      final hot = broken.contains(z.name);
      await c.addFill(FillOptions(geometry: [pts], fillColor: _hex(colour(z)), fillOpacity: hot ? .30 : .16, fillOutlineColor: _hex(colour(z))));
      await c.addLine(LineOptions(geometry: [...pts, pts.first], lineColor: _hex(colour(z)), lineWidth: hot ? 3.5 : 2.2, lineOpacity: .95));
    }
    await c.addSymbols([
      for (final z in zones) SymbolOptions(
        geometry: LatLng(z.centre.lat, z.centre.lng), textField: z.name, textSize: 12, textColor: _hex(colour(z)), textHaloColor: '#FFFFFF', textHaloWidth: 2,
        fontNames: const ['Noto Sans Bold'], textMaxWidth: 10, textJustify: 'center',
      ),
    ]);
  }

  // The zone being drawn: its corners, or its centre and radius, in the brand colour.
  Future<void> _drawDraft(MapLibreMapController c) async {
    final d = ref.read(zoneDraftProvider);
    if (d == null || d.pts.isEmpty) return;
    final col = _hex(context.vg.brand);
    List<LatLng> ring = d.pts;
    if (d.shape == 'circle' && d.pts.length >= 2) ring = [for (final p in Zone.circlePoints(d.pts[0].latitude, d.pts[0].longitude, d.radius!)) LatLng(p.lat, p.lng)];
    if (ring.length >= 3) await c.addFill(FillOptions(geometry: [ring], fillColor: col, fillOpacity: .18, fillOutlineColor: col));
    if (ring.length >= 2) await c.addLine(LineOptions(geometry: d.shape == 'polygon' && ring.length >= 3 ? [...ring, ring.first] : (d.shape == 'circle' && ring.length > 2 ? [...ring, ring.first] : ring), lineColor: col, lineWidth: 3, lineOpacity: .95));
    await c.addCircles([for (final p in d.pts) CircleOptions(geometry: p, circleRadius: 7, circleColor: col, circleStrokeColor: '#FFFFFF', circleStrokeWidth: 3)]);
  }

  void _fitAll(List<Camera> cams) {
    if (cams.length == 1) { _c?.animateCamera(CameraUpdate.newLatLngZoom(LatLng(cams.first.lat!, cams.first.lng!), 14)); return; }
    final lats = cams.map((e) => e.lat!), lngs = cams.map((e) => e.lng!);
    _c?.animateCamera(CameraUpdate.newLatLngBounds(
      LatLngBounds(southwest: LatLng(lats.reduce((a, b) => a < b ? a : b), lngs.reduce((a, b) => a < b ? a : b)), northeast: LatLng(lats.reduce((a, b) => a > b ? a : b), lngs.reduce((a, b) => a > b ? a : b))),
      left: 60, right: 60, top: 80, bottom: 160,
    ));
  }

  void _focus() {
    final cam = ref.read(fleetProvider).cams[_selected];
    if (cam != null && cam.hasPosition) _c?.animateCamera(CameraUpdate.newLatLngZoom(LatLng(cam.lat!, cam.lng!), 15));
  }

  void _schedule() { _debounce?.cancel(); _debounce = Timer(const Duration(milliseconds: 700), _draw); }

  @override
  Widget build(BuildContext context) {
    ref.listen(fleetProvider.select((s) => s.cams), (_, _) => _schedule());
    ref.listen(zonesProvider, (_, _) => _schedule());
    ref.listen(zoneDraftProvider, (_, _) => _draw());
    final drawing = ref.watch(zoneDraftProvider) != null;
    ref.listen(fleetProvider.select((s) => s.alerts), (_, _) => _schedule());
    final v = context.vg;
    final cam = ref.watch(fleetProvider.select((s) => s.cams[_selected]));
    return ClipRect(
      child: Stack(children: [
        MapLibreMap(
          styleString: 'https://tiles.openfreemap.org/styles/liberty',
          initialCameraPosition: const CameraPosition(target: LatLng(24.7136, 46.6753), zoom: 9),
          compassEnabled: false, attributionButtonPosition: AttributionButtonPosition.bottomLeft,
          onMapCreated: (c) {
            _c = c;
            c.onSymbolTapped.add((sym) { if (ref.read(zoneDraftProvider) != null) return; final id = _bySymbol[sym.id]; if (id != null) { setState(() => _selected = id); _draw(); } });
            c.onCircleTapped.add((circle) { if (ref.read(zoneDraftProvider) != null) return; final id = _byCircle[circle.id]; if (id != null) { setState(() => _selected = id); _draw(); } });
          },
          onStyleLoadedCallback: _draw,
          onMapClick: (_, ll) {
            if (ref.read(zoneDraftProvider) != null) { ref.read(zoneDraftProvider.notifier).tap(ll); return; }
            if (_selected != null) { setState(() => _selected = null); _draw(); }
          },
        ),
        const ZoneTools(),
        if (cam != null && !drawing)
          Positioned(
            left: 12, right: 12, bottom: 12,
            child: VgCard(
              child: Row(children: [
                StatusDot(color: stateColor(context, cam.state), pulse: cam.recording),
                const SizedBox(width: 12),
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                  Text(cam.name, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
                  if (cam.holder != null) Text('${cam.holder}${cam.holderNo != null ? '  ·  ${cam.holderNo}' : ''}', style: TextStyle(color: v.mut, fontSize: 13.5, fontWeight: FontWeight.w600)),
                  if (cam.battery != null) Text('${cam.charging ? '⚡ ' : ''}${ltr('${cam.battery}%')}', style: TextStyle(color: cam.lowBattery ? v.rec : v.mut, fontSize: 12.5, fontWeight: FontWeight.w800)),
                  Text('${stateLabel(context, cam.state)} · ${agoText(context, cam.fixTs ?? cam.ts)}', style: TextStyle(color: v.mut, fontSize: 12.5)),
                ])),
                TextButton(onPressed: () => context.push('/camera/${cam.id}'), child: Text(context.tr('open_alert'))),
                if (cam.online) CtaButton(compact: true, label: context.tr('watch_live'), icon: Icons.play_arrow_rounded, onTap: () {
                  final wide = MediaQuery.sizeOf(context).width >= 720;
                  ref.read(watchProvider.notifier).add(cam.id, max: wide ? 4 : 1);
                  context.push('/watch/${cam.id}');
                }),
              ]),
            ),
          ),
        Positioned(
          top: 10, right: 10,
          child: Material(
            color: v.panel, shape: const CircleBorder(), elevation: 2,
            child: IconButton(icon: const Icon(Icons.center_focus_strong_rounded), tooltip: context.tr('fit_all'), onPressed: () => _fitAll(ref.read(fleetProvider).cams.values.where((x) => x.hasPosition).toList())),
          ),
        ),
      ]),
    );
  }
}
