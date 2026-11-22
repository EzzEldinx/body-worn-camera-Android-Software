// English and Arabic: every text the screens ask for exists in both languages, and no screen writes an English text of its own.
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final table = File('lib/core/l10n/strings.dart').readAsStringSync();
  final entries = RegExp(r"'([A-Za-z0-9_]+)':\s*\[\s*'((?:[^'\\]|\\.)*)'\s*,\s*'((?:[^'\\]|\\.)*)'\s*\]").allMatches(table).toList();
  final keys = {for (final m in entries) m.group(1)!};

  test('every key has an English and an Arabic text', () {
    expect(entries.length, greaterThan(250));
    for (final m in entries) {
      expect(m.group(2)!.trim(), isNotEmpty, reason: '${m.group(1)}: English is empty');
      expect(m.group(3)!.trim(), isNotEmpty, reason: '${m.group(1)}: Arabic is empty');
      if (m.group(1) != 'app') {
        final ar = m.group(3)!;
        final hasArabic = RegExp(r'[؀-ۿ]').hasMatch(ar);
        final onlyLatinWords = !hasArabic && RegExp(r'[A-Za-z]{4,}').hasMatch(ar);
        expect(onlyLatinWords, isFalse, reason: '${m.group(1)}: the Arabic text is English');
      }
    }
  });

  test('every tr(key) in the screens is in the table', () {
    final missing = <String>[];
    for (final f in Directory('lib').listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart') && !f.path.endsWith('strings.dart'))) {
      for (final m in RegExp(r"""\btr\(\s*['"]([A-Za-z0-9_]+)['"]""").allMatches(f.readAsStringSync())) {
        if (!keys.contains(m.group(1))) missing.add('${f.path}: ${m.group(1)}');
      }
    }
    expect(missing, isEmpty);
  });

  test('no screen has an English text of its own in a Text(...)', () {
    final found = <String>[];
    for (final f in Directory('lib').listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart') && !f.path.endsWith('strings.dart'))) {
      for (final m in RegExp(r"""Text\(\s*(?:const\s+)?['"]([^'"$]*[A-Za-z]{3,}[^'"$]*)['"]""").allMatches(f.readAsStringSync())) {
        if (m.group(1) != 'English') found.add('${f.path}: ${m.group(1)}');   // "English" is the name of the language in the language picker
      }
    }
    expect(found, isEmpty);
  });
}
