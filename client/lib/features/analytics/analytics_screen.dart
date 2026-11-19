import 'dart:async';
import 'dart:ui' show FontFeature;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/api/api.dart';
import '../../core/l10n/strings.dart';
import '../../core/theme/vg_theme.dart';
import '../../core/widgets/widgets.dart';
import '../auth/auth_controller.dart';

/// The Analytics page of the web dashboard, in the app: the fleet and alarm numbers, what needs attention, the recordings pipeline, the health of every
/// camera and the written summary ("AI insights"). Same server API: /api/analytics, /api/analytics/insights and POST /api/analytics/ai.
class _Data { _Data(this.stats, this.ins); final Map stats, ins; }

final analyticsProvider = FutureProvider.autoDispose<_Data>((ref) async {
  final s = ref.watch(sessionProvider);
  if (s == null) throw StateError('no session');
  final r = await Future.wait([s.api.getJson('/api/analytics'), s.api.getJson('/api/analytics/insights')]);
  final timer = Timer(const Duration(seconds: 30), ref.invalidateSelf);
  ref.onDispose(timer.cancel);
  return _Data(r[0] as Map, r[1] as Map);
});

class AnalyticsScreen extends ConsumerStatefulWidget {
  const AnalyticsScreen({super.key});
  @override
  ConsumerState<AnalyticsScreen> createState() => _AnalyticsScreenState();
}

class _AnalyticsScreenState extends ConsumerState<AnalyticsScreen> {
  String? _ai;
  bool _aiBusy = false, _aiReal = false;
  String? _aiModel, _aiError;

  Future<void> _writeSummary() async {
    final s = ref.read(sessionProvider);
    if (s == null) return;
    setState(() { _aiBusy = true; _aiError = null; });
    try {
      final j = await s.api.postJson('/api/analytics/ai', {'refresh': true}) as Map;
      if (mounted) setState(() { _ai = '${j['text'] ?? ''}'; _aiReal = j['ai'] == true; _aiModel = j['model'] as String?; });
    } on ApiError catch (e) {
      if (mounted) setState(() => _aiError = e.offline ? context.tr('no_server') : e.message);
    } catch (_) {
      if (mounted) setState(() => _aiError = context.tr('an_not_now'));
    }
    if (mounted) setState(() => _aiBusy = false);
  }

  @override
  Widget build(BuildContext context) {
    final data = ref.watch(analyticsProvider);
    final user = ref.watch(sessionProvider)?.user;
    final v = context.vg;
    return Scaffold(
      appBar: AppBar(title: Text(context.tr('analytics')), actions: [IconButton(onPressed: () => ref.invalidate(analyticsProvider), icon: const Icon(Icons.refresh_rounded))]),
      body: data.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => EmptyState(icon: Icons.cloud_off_rounded, title: e is ApiError && e.offline ? context.tr('no_server') : '$e'),
        data: (d) {
          final f = d.stats['fleet'] as Map, a = d.stats['alarms'] as Map, ins = d.ins;
          final pipe = ins['pipeline'] as Map, rec = ins['recordings'] as Map, bat = ins['battery'] as Map, shifts = ins['shifts'] as Map?;
          final score = ins['score'] as num?;
          final days = [for (final x in (a['days'] as List)) (x['day'] as String, (x['count'] as num).toInt())];
          final hours = [for (final x in ((ins['alarms'] as Map)['byHour'] as List)) ((x['hour'] as num).toInt(), (x['count'] as num).toInt())];
          final health = (ins['health'] as List).cast<Map>();
          final insights = (ins['insights'] as List).cast<Map>();
          final total = (f['total'] as num).toInt();
          String sec(num? s) => s == null ? '-' : s < 60 ? '${s.round()} s' : '${(s / 60).floor()} m ${(s % 60).round()} s';
          Color sev(String s) => switch (s) { 'critical' => v.rec, 'warning' => v.sel, 'good' => v.ok, _ => v.blue };
          return RefreshIndicator(
            onRefresh: () async => ref.refresh(analyticsProvider.future),
            child: ListView(padding: const EdgeInsets.all(14), children: [
              Text(user?.name ?? '', style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
              Text([(d.stats['scope'] as Map)['company'] ?? 'Smart Way', '$total ${context.tr('an_cameras')}'].join(' · '), style: TextStyle(color: v.mut)),
              const SizedBox(height: 14),
              Wrap(spacing: 10, runSpacing: 10, children: [
                _Stat(label: context.tr('an_online'), value: '${f['online']} / $total', color: v.ok, frac: total == 0 ? 0 : (f['online'] as num) / total),
                _Stat(label: context.tr('an_recording'), value: '${f['recording']}', color: v.rec, frac: total == 0 ? 0 : (f['recording'] as num) / total),
                _Stat(label: context.tr('an_open_sos'), value: '${a['open']}', color: v.sel, frac: (a['total'] as num) == 0 ? 0 : (a['open'] as num) / (a['total'] as num), sub: '${a['total']} ${context.tr('an_in30')}'),
                _Stat(label: context.tr('an_avg_resp'), value: sec(a['avgResponseSec'] as num?), color: v.blue, frac: a['avgResponseSec'] == null ? 0 : 1 - ((a['avgResponseSec'] as num).clamp(0, 300) / 300)),
                if (score != null) _Stat(label: context.tr('an_health'), value: '$score%', color: score >= 80 ? v.ok : score >= 50 ? v.sel : v.rec, frac: score / 100),
                _Stat(label: context.tr('an_low_bat'), value: '${bat['low']}', color: (bat['critical'] as num) > 0 ? v.rec : (bat['low'] as num) > 0 ? v.sel : v.ok, frac: (bat['known'] as num) == 0 ? 0 : (bat['low'] as num) / (bat['known'] as num)),
                if (shifts != null) _Stat(label: context.tr('an_duty'), value: '${shifts['out']} / ${shifts['total']}', color: v.blue, frac: (shifts['total'] as num) == 0 ? 0 : (shifts['out'] as num) / (shifts['total'] as num)),
              ]),
              const SizedBox(height: 16),
              if (insights.isNotEmpty) ...[
                _Title(context.tr('an_attention')),
                for (final i in insights) Padding(padding: const EdgeInsets.only(bottom: 8), child: VgCard(border: sev('${i['severity']}').withValues(alpha: .6), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('${i['title']}', style: TextStyle(fontWeight: FontWeight.w800, color: sev('${i['severity']}'))),
                  if ('${i['detail'] ?? ''}'.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 3), child: Text('${i['detail']}', style: TextStyle(color: v.mut, height: 1.35))),
                ]))),
              ],
              if (user?.can('ai') ?? false) ...[
                const SizedBox(height: 8),
                _Title(context.tr('an_ai')),
                VgCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  if (_ai != null) ...[
                    Text(_aiReal ? context.tr('an_ai_by').replaceAll('{model}', _aiModel ?? '') : context.tr('an_ai_auto'), style: TextStyle(color: v.mut, fontSize: 12)),
                    const SizedBox(height: 6),
                    SelectableText(_ai!, style: const TextStyle(height: 1.5)),
                    const SizedBox(height: 10),
                  ],
                  if (_aiError != null) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(_aiError!, style: TextStyle(color: v.rec))),
                  CtaButton(compact: true, label: _aiBusy ? context.tr('an_analysing') : context.tr('an_write'), icon: Icons.auto_awesome_rounded, onTap: _aiBusy ? null : _writeSummary),
                ])),
              ],
              const SizedBox(height: 16),
              _Title(context.tr('an_sos7')),
              VgCard(child: _Bars(values: [for (final d in days) d.$2], labels: [for (final d in days) d.$1], color: v.rec)),
              const SizedBox(height: 12),
              _Title(context.tr('an_sos_hour')),
              VgCard(child: _Bars(values: [for (final h in hours) h.$2], labels: [for (final h in hours) h.$1 % 6 == 0 ? '${h.$1}' : ''], color: v.sel, height: 70)),
              const SizedBox(height: 12),
              _Title(context.tr('an_pipeline')),
              VgCard(child: Column(children: [
                _Row(context.tr('an_p_waiting'), (pipe['awaiting'] as Map)['n'], v.sel),
                _Row(context.tr('an_p_queued'), (pipe['queued'] as Map)['n'], v.blue),
                _Row(context.tr('an_p_local'), (pipe['local'] as Map)['n'], v.brand),
                _Row(context.tr('an_p_cloud'), (pipe['cloud'] as Map)['n'], v.ok),
                _Row(context.tr('an_p_failed'), (pipe['failed'] as Map)['n'], v.rec),
                const Divider(height: 18),
                Align(alignment: AlignmentDirectional.centerStart, child: Text('${context.tr('an_rec14')}: ${rec['last14']}', style: TextStyle(color: v.mut))),
              ])),
              const SizedBox(height: 12),
              _Title(context.tr('an_cam_health')),
              VgCard(child: Column(children: [
                for (final h in health) Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: Row(children: [
                  StatusDot(color: h['recording'] == true ? v.rec : h['online'] == true ? v.ok : v.off),
                  const SizedBox(width: 10),
                  Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('${h['name']}', style: const TextStyle(fontWeight: FontWeight.w700)),
                    if (h['holder'] != null) Text('${h['holder']}', style: TextStyle(color: v.mut, fontSize: 12)),
                    if ((h['flags'] as List).isNotEmpty) Wrap(spacing: 6, children: [for (final fl in (h['flags'] as List)) Text(context.tr('an_flag_$fl'), style: TextStyle(color: fl == 'unstable' ? v.sel : fl == 'no_gps' ? v.blue : v.rec, fontSize: 12, fontWeight: FontWeight.w700))]),
                  ])),
                  if (h['battery'] != null) Text('${h['battery']}%', style: TextStyle(color: (h['flags'] as List).contains('low_battery') ? v.rec : v.mut, fontWeight: FontWeight.w700)),
                  const SizedBox(width: 12),
                  Text('SOS ${h['alarms30d']}', style: TextStyle(color: v.mut, fontSize: 12)),
                ])),
              ])),
              const SizedBox(height: 12),
              Builder(builder: (c) {
                final au = ins['audit'] as Map;
                final ok = au['ok'] == true;
                return Text(ok ? context.tr('an_verified').replaceAll('{n}', '${au['checked']}') : context.tr('an_broken'), style: TextStyle(color: ok ? v.ok : v.rec, fontWeight: FontWeight.w700, fontSize: 12.5));
              }),
              const SizedBox(height: 24),
            ]),
          );
        },
      ),
    );
  }
}

class _Title extends StatelessWidget {
  const _Title(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(text, style: TextStyle(fontWeight: FontWeight.w800, fontSize: 13.5, letterSpacing: .3, color: context.vg.mut)));
}

class _Stat extends StatelessWidget {
  const _Stat({required this.label, required this.value, required this.color, required this.frac, this.sub});
  final String label, value;
  final Color color;
  final double frac;
  final String? sub;
  @override
  Widget build(BuildContext context) => SizedBox(
        width: 158,
        child: VgCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label, style: TextStyle(color: context.vg.mut, fontSize: 12, fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          Text(value, style: TextStyle(fontSize: 24, fontWeight: FontWeight.w800, color: color, fontFeatures: const [FontFeature.tabularFigures()])),
          const SizedBox(height: 6),
          LinearProgressIndicator(value: frac.clamp(0.0, 1.0).toDouble(), color: color, backgroundColor: context.vg.line, minHeight: 4, borderRadius: BorderRadius.circular(4)),
          if (sub != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text(sub!, style: TextStyle(color: context.vg.mut, fontSize: 11))),
        ])),
      );
}

class _Bars extends StatelessWidget {
  const _Bars({required this.values, required this.labels, required this.color, this.height = 110});
  final List<int> values;
  final List<String> labels;
  final Color color;
  final double height;
  @override
  Widget build(BuildContext context) {
    final max = values.fold<int>(1, (m, x) => x > m ? x : m);
    return Directionality(
      textDirection: TextDirection.ltr,
      child: SizedBox(height: height + 34, child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
        for (var i = 0; i < values.length; i++) Expanded(child: Column(mainAxisAlignment: MainAxisAlignment.end, children: [
          Text(values[i] == 0 ? '' : '${values[i]}', style: TextStyle(fontSize: 10.5, color: context.vg.mut, fontWeight: FontWeight.w700)),
          Container(margin: const EdgeInsets.symmetric(horizontal: 2), height: (values[i] / max * height).clamp(3, height).toDouble(), decoration: BoxDecoration(color: values[i] == 0 ? context.vg.line : color, borderRadius: BorderRadius.circular(3))),
          const SizedBox(height: 4),
          Text(labels[i], style: TextStyle(fontSize: 10.5, color: context.vg.mut)),
        ])),
      ])),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row(this.label, this.n, this.color);
  final String label;
  final dynamic n;
  final Color color;
  @override
  Widget build(BuildContext context) => Padding(padding: const EdgeInsets.symmetric(vertical: 5), child: Row(children: [
        Container(width: 10, height: 10, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
        const SizedBox(width: 10),
        Expanded(child: Text(label)),
        Text('$n', style: const TextStyle(fontWeight: FontWeight.w800)),
      ]));
}
