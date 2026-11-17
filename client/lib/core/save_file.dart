import 'dart:io';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';
import '../features/auth/auth_controller.dart';
import 'l10n/strings.dart';

/// Download a recording (video or photo) from the server and hand it to the system share sheet, where the person chooses
/// "Save Video", "Save to Files", AirDrop, ... : the file lands on the phone or the iPad. Needs the file to be in the cloud (it is fetched from the server).
Future<void> saveRecording(BuildContext context, Session s, int id, String filename) async {
  final box = context.findRenderObject() as RenderBox?;
  final origin = box != null ? box.localToGlobal(Offset.zero) & box.size : const Rect.fromLTWH(0, 0, 10, 10);   // the iPad share sheet needs an anchor
  final messenger = ScaffoldMessenger.of(context);
  messenger.showSnackBar(SnackBar(duration: const Duration(minutes: 5), content: Row(children: [const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)), const SizedBox(width: 12), Text(context.tr('downloading'))])));
  try {
    final dir = await getTemporaryDirectory();
    final file = File('${dir.path}/${filename.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_')}');
    final client = HttpClient();
    final req = await client.getUrl(Uri.parse(s.api.recordingUrl(id)));
    req.headers.set('authorization', 'Bearer ${s.token}');
    final res = await req.close();
    if (res.statusCode != 200) throw HttpException('${res.statusCode}');
    final sink = file.openWrite();
    await res.pipe(sink);
    client.close();
    messenger.hideCurrentSnackBar();
    await Share.shareXFiles([XFile(file.path)], sharePositionOrigin: origin);
  } catch (_) {
    messenger.hideCurrentSnackBar();
    messenger.showSnackBar(SnackBar(content: Text(context.tr('download_failed'))));
  }
}
