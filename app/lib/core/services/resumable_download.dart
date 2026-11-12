import 'dart:async';
import 'dart:io';

/// The download was stopped on purpose (for example the Wi-Fi it was allowed to use went away). What was received is kept: the next try goes on from there.
class DownloadPaused implements Exception {
  const DownloadPaused(this.reason);

  final String reason;

  @override
  String toString() => 'download paused: $reason';
}

/// Downloads [uri] into [part] and goes on where an earlier try stopped (HTTP Range), so a weak or interrupted link never has to start again
/// from zero. Returns when [part] holds the whole file; throws when the link breaks (what arrived stays in [part]) or when [stillAllowed] says no.
///
/// [expectedSize] is the size of the whole file when it is known; the download is only accepted when exactly that many bytes are there.
/// The error texts start with "download" on purpose: the server reads those as a network problem (try again later), not as a refused build.
Future<void> downloadResumable({
  required Uri uri,
  required File part,
  Map<String, String> headers = const <String, String>{},
  int? expectedSize,
  void Function(int received, int total)? onProgress,
  Future<bool> Function()? stillAllowed,
  Duration connectTimeout = const Duration(seconds: 15),
  Duration idleTimeout = const Duration(seconds: 30),
  Duration checkEvery = const Duration(seconds: 3),
}) async {
  int have = await part.exists() ? await part.length() : 0;
  if (expectedSize != null && have > expectedSize) {
    await part.delete();
    have = 0;
  }
  if (expectedSize != null && have == expectedSize) return; // complete from an earlier try

  final HttpClient client = HttpClient()..connectionTimeout = connectTimeout;
  try {
    final HttpClientRequest req = await client.getUrl(uri);
    headers.forEach(req.headers.set);
    if (have > 0) req.headers.set(HttpHeaders.rangeHeader, 'bytes=$have-');
    final HttpClientResponse res = await req.close().timeout(idleTimeout);
    if (res.statusCode == 416) {
      await part.delete(); // the server does not agree with what we hold: begin again next time
      throw const HttpException('download failed (HTTP 416): starting again');
    }
    if (res.statusCode != 200 && res.statusCode != 206) {
      await res.drain<void>();
      throw HttpException('download failed (HTTP ${res.statusCode})');
    }
    final bool resumed = res.statusCode == 206 && have > 0;
    if (!resumed) have = 0; // the server sent everything again: start the file over
    final int total = expectedSize ?? (res.contentLength > 0 ? have + res.contentLength : 0);
    final IOSink sink = part.openWrite(mode: resumed ? FileMode.append : FileMode.write);
    int got = have;
    DateTime lastCheck = DateTime.now();
    try {
      await for (final List<int> chunk in res.timeout(idleTimeout)) {
        sink.add(chunk);
        got += chunk.length;
        onProgress?.call(got, total);
        if (stillAllowed != null && DateTime.now().difference(lastCheck) >= checkEvery) {
          lastCheck = DateTime.now();
          if (!await stillAllowed()) throw const DownloadPaused('the network it may use is gone');
        }
      }
    } finally {
      await sink.close();
    }
    if (total > 0 && got != total) throw HttpException('download stopped at $got of $total bytes');
  } finally {
    client.close(force: true);
  }
}
