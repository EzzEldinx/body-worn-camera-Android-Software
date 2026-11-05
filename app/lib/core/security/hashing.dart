import 'dart:io';

import 'package:crypto/crypto.dart';

/// SHA-256 helpers for evidence files. Wired in the storage feature (Phase 3).
class EvidenceHasher {
  EvidenceHasher._();

  /// Streams [file] so large 4K recordings are not loaded entirely into RAM.
  static Future<String> sha256File(File file) async {
    final digest = await sha256.bind(file.openRead()).first;
    return digest.toString();
  }

  static String sha256Bytes(List<int> bytes) => sha256.convert(bytes).toString();
}
