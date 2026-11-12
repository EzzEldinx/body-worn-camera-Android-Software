import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:swg_bwc/core/services/app_updater.dart';
import 'package:swg_bwc/core/services/resumable_download.dart';

UpdateWait gate(
  Map<String, dynamic> cmd, {
  bool recording = false,
  bool onWifi = true,
  int? battery = 80,
  bool charging = false,
}) =>
    AppUpdater.gate(cmd: cmd, recording: recording, onWifi: onWifi, battery: battery, charging: charging);

void main() {
  group('when an update order may start', () {
    test('an order from the Updates page goes over whatever network there is, even with a flat battery', () {
      expect(gate(<String, dynamic>{'build': 'x'}, onWifi: false, battery: 3), UpdateWait.none);
    });

    test('nothing cuts a recording, unless the order is forced', () {
      expect(gate(<String, dynamic>{'build': 'x'}, recording: true), UpdateWait.recording);
      expect(gate(<String, dynamic>{'build': 'x', 'auto': true, 'net': 'any'}, recording: true), UpdateWait.recording);
      expect(gate(<String, dynamic>{'build': 'x', 'force': true}, recording: true), UpdateWait.none);
    });

    test('an automatic order told Wi-Fi only waits for Wi-Fi and never uses the SIM', () {
      final Map<String, dynamic> cmd = <String, dynamic>{'build': 'x', 'auto': true, 'net': 'wifi'};
      expect(gate(cmd, onWifi: false), UpdateWait.wifi);
      expect(gate(cmd, onWifi: true), UpdateWait.none);
    });

    test('an automatic order allowed on any network does not mind', () {
      expect(gate(<String, dynamic>{'build': 'x', 'auto': true, 'net': 'any'}, onWifi: false), UpdateWait.none);
    });

    test('an automatic order waits for the battery unless the camera charges', () {
      final Map<String, dynamic> cmd = <String, dynamic>{'build': 'x', 'auto': true, 'net': 'any'};
      expect(gate(cmd, battery: 19), UpdateWait.battery);
      expect(gate(cmd, battery: 20), UpdateWait.none);
      expect(gate(cmd, battery: 5, charging: true), UpdateWait.none);
      expect(gate(cmd, battery: null), UpdateWait.none, reason: 'no reading: do not hold the update for ever');
    });
  });

  group('a download that goes on where it stopped', () {
    late Directory dir;
    late File part;
    late Uint8List data;
    HttpServer? server;
    final List<String> ranges = <String>[];

    setUp(() {
      dir = Directory.systemTemp.createTempSync('download_test');
      part = File('${dir.path}/update.part');
      data = Uint8List.fromList(List<int>.generate(300000, (int i) => (i * 7 + i ~/ 256) & 0xff));
      ranges.clear();
    });

    tearDown(() async {
      await server?.close(force: true);
      server = null;
      dir.deleteSync(recursive: true);
    });

    /// A small file server with Range support. [cutFirst]: the first request is cut after that many bytes (a link that breaks).
    Future<Uri> serve({int? cutFirst, bool ignoreRange = false, int? status}) async {
      int requests = 0;
      final HttpServer s = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server = s;
      s.listen((HttpRequest req) async {
        requests++;
        final String? range = req.headers.value(HttpHeaders.rangeHeader);
        ranges.add(range ?? '');
        if (status != null) {
          req.response.statusCode = status;
          await req.response.close();
          return;
        }
        int start = 0;
        if (range != null && !ignoreRange) {
          start = int.parse(RegExp(r'bytes=(\d+)-').firstMatch(range)!.group(1)!);
          if (start >= data.length) {
            req.response.statusCode = 416;
            await req.response.close();
            return;
          }
          req.response.statusCode = 206;
        }
        final Uint8List body = Uint8List.sublistView(data, start);
        if (cutFirst != null && requests == 1) {
          // promise the whole file, send part of it and hang up: the way a weak link breaks
          final Socket socket = await req.response.detachSocket(writeHeaders: false);
          socket.write('HTTP/1.1 200 OK\r\ncontent-length: ${body.length}\r\n\r\n');
          socket.add(Uint8List.sublistView(body, 0, cutFirst));
          await socket.flush();
          socket.destroy();
          return;
        }
        req.response.contentLength = body.length;
        for (int i = 0; i < body.length; i += 20000) {
          req.response.add(Uint8List.sublistView(body, i, i + 20000 > body.length ? body.length : i + 20000));
          await req.response.flush(); // several pieces, like a real link
          await Future<void>.delayed(const Duration(milliseconds: 8));
        }
        await req.response.close();
      });
      return Uri.parse('http://127.0.0.1:${s.port}/api/update/apk');
    }

    test('a whole download, with its progress', () async {
      final Uri uri = await serve();
      final List<int> seen = <int>[];
      await downloadResumable(uri: uri, part: part, expectedSize: data.length, onProgress: (int got, int total) => seen.add(got * 100 ~/ total));
      expect(part.readAsBytesSync(), data);
      expect(seen.last, 100);
      expect(ranges, <String>['']);
    });

    test('the camera sends its token to the server', () async {
      final HttpServer s = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server = s;
      String? token;
      s.listen((HttpRequest req) async {
        token = req.headers.value('x-bwc-token');
        req.response.add(data);
        await req.response.close();
      });
      await downloadResumable(uri: Uri.parse('http://127.0.0.1:${s.port}/x'), part: part, headers: <String, String>{'x-bwc-token': 'secret'});
      expect(token, 'secret');
      expect(part.readAsBytesSync(), data, reason: 'no expected size: the whole body is taken');
    });

    test('a link that breaks leaves what arrived, and the next try asks only for the rest', () async {
      final Uri uri = await serve(cutFirst: 120000);
      await expectLater(downloadResumable(uri: uri, part: part, expectedSize: data.length), throwsA(anything));
      expect(part.lengthSync(), 120000, reason: 'kept');
      await downloadResumable(uri: uri, part: part, expectedSize: data.length);
      expect(ranges, <String>['', 'bytes=120000-']);
      expect(part.readAsBytesSync(), data, reason: 'the pieces fit together');
    });

    test('a server that ignores Range sends everything again, and the file is started over, not doubled', () async {
      part.writeAsBytesSync(data.sublist(0, 1000));
      final Uri uri = await serve(ignoreRange: true);
      await downloadResumable(uri: uri, part: part, expectedSize: data.length);
      expect(part.readAsBytesSync(), data);
    });

    test('a download that is stopped on purpose keeps its bytes and can go on later', () async {
      final Uri uri = await serve();
      await expectLater(
        downloadResumable(uri: uri, part: part, expectedSize: data.length, stillAllowed: () async => false, checkEvery: Duration.zero),
        throwsA(isA<DownloadPaused>()),
      );
      expect(part.existsSync(), isTrue);
      expect(part.lengthSync(), lessThan(data.length));
      await downloadResumable(uri: uri, part: part, expectedSize: data.length);
      expect(part.readAsBytesSync(), data);
    });

    test('a file that is already complete asks for nothing', () async {
      part.writeAsBytesSync(data);
      final Uri uri = await serve();
      await downloadResumable(uri: uri, part: part, expectedSize: data.length);
      expect(ranges, isEmpty);
    });

    test('a leftover that is longer than the file is thrown away and the file is fetched whole', () async {
      part.writeAsBytesSync(Uint8List(data.length + 50));
      final Uri uri = await serve();
      await downloadResumable(uri: uri, part: part, expectedSize: data.length);
      expect(part.readAsBytesSync(), data);
      expect(ranges, <String>['']);
    });

    test('a server error is a network problem the server will retry (the text says "download")', () async {
      final Uri uri = await serve(status: 503);
      await expectLater(
        downloadResumable(uri: uri, part: part, expectedSize: data.length),
        throwsA(predicate((Object e) => e.toString().contains('download failed (HTTP 503)'))),
      );
    });

    test('fewer bytes than the published size is a failed download, not a finished one', () async {
      final Uri uri = await serve();
      await expectLater(
        downloadResumable(uri: uri, part: part, expectedSize: data.length + 10),
        throwsA(predicate((Object e) => e.toString().contains('download stopped'))),
      );
    });
  });
}
