import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:visionguard_client/core/api/api.dart';
import 'package:visionguard_client/core/api/models.dart';
import 'package:visionguard_client/core/l10n/strings.dart';

void main() {
  test('camera state comes from the server flags', () {
    final rec = Camera.fromJson({'cameraId': 'BWC-1', 'online': true, 'recording': true, 'ts': 1});
    final on = Camera.fromJson({'cameraId': 'BWC-2', 'online': true, 'ts': 1});
    final off = Camera.fromJson({'cameraId': 'BWC-3'});
    expect([rec.state, on.state, off.state], [CamState.rec, CamState.online, CamState.off]);
    expect(rec.name, 'BWC-1'); // no custom name -> the id
    expect(off.hasPosition, isFalse);
  });

  test('a GPS fix older than two minutes is "last known"', () {
    final now = DateTime.now().millisecondsSinceEpoch;
    expect(Camera.fromJson({'cameraId': 'a', 'lat': 1, 'lng': 2, 'fixTs': now}).gpsFresh, isTrue);
    expect(Camera.fromJson({'cameraId': 'a', 'lat': 1, 'lng': 2, 'fixTs': now - 130000}).gpsFresh, isFalse);
    expect(Camera.fromJson({'cameraId': 'a', 'lat': 1, 'lng': 2}).gpsFresh, isFalse);
  });

  test('alarms and recordings parse and acknowledge', () {
    final a = Alarm.fromJson({'id': 3, 'cameraId': 'x', 'ts': 9, 'ack': false, 'lat': 24.7, 'lng': 46.6});
    expect(a.ack, isFalse);
    expect(a.acked().ack, isTrue);
    final r = Recording.fromJson({'id': 1, 'cameraId': 'x', 'filename': 'VID_1.mp4', 'size': 5, 'uploadedTs': 7, 'sha256': 'ab'});
    expect(r.isVideo, isTrue);
    expect(r.ts, 7);
  });

  test('every text exists in English and Arabic', () {
    // Tr.of returns the key itself when it is missing; check both languages resolve to real text.
    for (final key in ['app', 'tab_fleet', 'sign_in', 'watch_live', 'sos_from', 'alerts_empty', 'live_limit', 'biometric']) {
      expect(Tr.of(const Locale('en'), key), isNot(key));
      expect(Tr.of(const Locale('ar'), key), isNot(key));
    }
    expect(Tr.of(const Locale('ar'), 'sign_in'), isNot(Tr.of(const Locale('en'), 'sign_in')));
  });

  test('API errors tell offline from unauthorized', () {
    expect(ApiError(401, 'x').unauthorized, isTrue);
    expect(ApiError(0, 'x').offline, isTrue);
    expect(ApiError(500, 'x').unauthorized, isFalse);
  });

  test('the live URL is same-origin on the dashboard port', () {
    expect(Api('http://h:3000').liveUrl('BWC 1', 'ab-cd'), 'http://h:3000/live/BWC%201.flv?sign=ab-cd');
  });
}
