import 'dart:convert';

import 'package:crypto/crypto.dart';

import '../constants/app_constants.dart';

/// Validates the Hidden Admin Door PIN without the widget knowing the secret.
///
/// Comparison is done on SHA-256 digests so the PIN is not inlined next to UI
/// logic. This is *not* a substitute for hardware-backed keystore storage;
/// rotate [AppConstants.defaultAdminPin] before field deployment.
class PinValidator {
  PinValidator({String? expectedPin})
      : _expectedDigest = sha256
            .convert(utf8.encode(expectedPin ?? AppConstants.defaultAdminPin))
            .bytes;

  final List<int> _expectedDigest;

  /// Returns true only when [candidate] matches the configured admin PIN.
  bool validate(String candidate) {
    if (candidate.isEmpty) {
      return false;
    }
    final digest = sha256.convert(utf8.encode(candidate)).bytes;
    return _constantTimeEquals(digest, _expectedDigest);
  }

  /// Avoids leaking PIN length / match position via short-circuit comparison.
  bool _constantTimeEquals(List<int> a, List<int> b) {
    if (a.length != b.length) {
      return false;
    }
    var diff = 0;
    for (var i = 0; i < a.length; i++) {
      diff |= a[i] ^ b[i];
    }
    return diff == 0;
  }
}
