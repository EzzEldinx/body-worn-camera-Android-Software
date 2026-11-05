import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

final prefsProvider = Provider<SharedPreferences>((ref) => throw UnimplementedError('override in main()'));

@immutable
class Settings {
  const Settings({this.theme = ThemeMode.system, this.language, this.biometric = false});
  final ThemeMode theme;
  final String? language; // 'en' | 'ar' | null = follow the phone
  final bool biometric;
  Settings copyWith({ThemeMode? theme, String? language, bool clearLanguage = false, bool? biometric}) =>
      Settings(theme: theme ?? this.theme, language: clearLanguage ? null : (language ?? this.language), biometric: biometric ?? this.biometric);
}

class SettingsController extends Notifier<Settings> {
  late SharedPreferences _p;
  @override
  Settings build() {
    _p = ref.read(prefsProvider);
    return Settings(
      theme: ThemeMode.values.firstWhere((m) => m.name == _p.getString('theme'), orElse: () => ThemeMode.system),
      language: _p.getString('lang'),
      biometric: _p.getBool('biometric') ?? false,
    );
  }

  void setTheme(ThemeMode m) { _p.setString('theme', m.name); state = state.copyWith(theme: m); }
  void setLanguage(String? l) {
    if (l == null) { _p.remove('lang'); state = state.copyWith(clearLanguage: true); } else { _p.setString('lang', l); state = state.copyWith(language: l); }
  }
  void setBiometric(bool v) { _p.setBool('biometric', v); state = state.copyWith(biometric: v); }
}

final settingsProvider = NotifierProvider<SettingsController, Settings>(SettingsController.new);
