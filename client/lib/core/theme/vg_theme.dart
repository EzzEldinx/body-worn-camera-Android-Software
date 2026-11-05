import 'package:flutter/material.dart';

/// VisionGuard design tokens. Same values as the control-room dashboard (server/public/portal.css),
/// so the web dashboard and the apps look like one product.
@immutable
class VgColors extends ThemeExtension<VgColors> {
  const VgColors({
    required this.bg, required this.panel, required this.raise, required this.line, required this.lineSoft,
    required this.text, required this.mut, required this.brand, required this.ok, required this.rec,
    required this.off, required this.blue, required this.sel, required this.selInk, required this.accentText,
    required this.hover,
  });

  final Color bg, panel, raise, line, lineSoft, text, mut, brand, ok, rec, off, blue, sel, selInk, accentText, hover;

  static const light = VgColors(
    bg: Color(0xFFE9EEF5), panel: Color(0xFFF8FAFC), raise: Color(0xFFEEF2F8), line: Color(0xFFDAE2EC), lineSoft: Color(0xFFE6ECF3),
    text: Color(0xFF0F1B2D), mut: Color(0xFF62738C), brand: Color(0xFF5E4A9E), ok: Color(0xFF00B87C), rec: Color(0xFFFF3355),
    off: Color(0xFF9AA8BD), blue: Color(0xFF2F7BFF), sel: Color(0xFFFFB300), selInk: Color(0xFF1A1405), accentText: Color(0xFF9A6400),
    hover: Color(0xFFE4EBF5),
  );

  static const dark = VgColors(
    bg: Color(0xFF0B1322), panel: Color(0xFF131E33), raise: Color(0xFF1A2842), line: Color(0xFF273A5B), lineSoft: Color(0xFF1F3050),
    text: Color(0xFFE8EEF7), mut: Color(0xFF8A9BB5), brand: Color(0xFF9B86E0), ok: Color(0xFF2EE6A6), rec: Color(0xFFFF5D77),
    off: Color(0xFF5B6B86), blue: Color(0xFF5AA9FF), sel: Color(0xFFFFC857), selInk: Color(0xFF1A1405), accentText: Color(0xFFFFC857),
    hover: Color(0xFF1A2842),
  );

  /// Amber call-to-action gradient (the "Watch live" / primary buttons of the dashboard).
  LinearGradient get cta => LinearGradient(colors: [sel, const Color(0xFFFF9D00)], begin: Alignment.topLeft, end: Alignment.bottomRight);

  /// Brand strip under the header (purple -> blue -> amber).
  LinearGradient get strip => LinearGradient(colors: [brand, blue, sel]);

  List<BoxShadow> get shadowSm => [BoxShadow(color: const Color(0xFF0F1B2D).withValues(alpha: text.computeLuminance() > .5 ? .35 : .07), blurRadius: 8, offset: const Offset(0, 2))];

  @override
  VgColors copyWith() => this;

  @override
  VgColors lerp(ThemeExtension<VgColors>? other, double t) {
    if (other is! VgColors) return this;
    Color l(Color a, Color b) => Color.lerp(a, b, t)!;
    return VgColors(
      bg: l(bg, other.bg), panel: l(panel, other.panel), raise: l(raise, other.raise), line: l(line, other.line), lineSoft: l(lineSoft, other.lineSoft),
      text: l(text, other.text), mut: l(mut, other.mut), brand: l(brand, other.brand), ok: l(ok, other.ok), rec: l(rec, other.rec),
      off: l(off, other.off), blue: l(blue, other.blue), sel: l(sel, other.sel), selInk: l(selInk, other.selInk),
      accentText: l(accentText, other.accentText), hover: l(hover, other.hover),
    );
  }
}

extension VgContext on BuildContext {
  VgColors get vg => Theme.of(this).extension<VgColors>()!;
  bool get isDark => Theme.of(this).brightness == Brightness.dark;
}

const kRadius = 16.0;

ThemeData buildTheme(Brightness b) {
  final c = b == Brightness.dark ? VgColors.dark : VgColors.light;
  final scheme = ColorScheme(
    brightness: b, primary: c.brand, onPrimary: Colors.white, secondary: c.sel, onSecondary: c.selInk,
    error: c.rec, onError: Colors.white, surface: c.panel, onSurface: c.text, surfaceContainerHighest: c.raise,
    outline: c.line, outlineVariant: c.lineSoft,
  );
  final base = ThemeData(brightness: b, useMaterial3: true, colorScheme: scheme);
  final text = base.textTheme.apply(bodyColor: c.text, displayColor: c.text);
  OutlineInputBorder border(Color col, [double w = 1]) => OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: col, width: w));
  return base.copyWith(
    extensions: [c],
    scaffoldBackgroundColor: c.bg,
    canvasColor: c.panel,
    dividerColor: c.line,
    textTheme: text,
    splashFactory: InkSparkle.splashFactory,
    appBarTheme: AppBarTheme(
      backgroundColor: c.panel, foregroundColor: c.text, elevation: 0, scrolledUnderElevation: 0, centerTitle: false,
      titleTextStyle: text.titleLarge?.copyWith(fontWeight: FontWeight.w800, letterSpacing: .2),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: c.panel, indicatorColor: c.sel.withValues(alpha: .22), height: 68,
      labelTextStyle: WidgetStateProperty.resolveWith((s) => TextStyle(fontSize: 11.5, fontWeight: s.contains(WidgetState.selected) ? FontWeight.w800 : FontWeight.w600, color: s.contains(WidgetState.selected) ? c.text : c.mut)),
      iconTheme: WidgetStateProperty.resolveWith((s) => IconThemeData(size: 25, color: s.contains(WidgetState.selected) ? c.text : c.mut)),
    ),
    navigationRailTheme: NavigationRailThemeData(
      backgroundColor: c.panel, indicatorColor: c.sel.withValues(alpha: .22),
      selectedIconTheme: IconThemeData(color: c.text), unselectedIconTheme: IconThemeData(color: c.mut),
      selectedLabelTextStyle: TextStyle(color: c.text, fontWeight: FontWeight.w800, fontSize: 12),
      unselectedLabelTextStyle: TextStyle(color: c.mut, fontWeight: FontWeight.w600, fontSize: 12),
    ),
    cardTheme: CardThemeData(color: c.panel, elevation: 0, margin: EdgeInsets.zero, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(kRadius), side: BorderSide(color: c.line))),
    inputDecorationTheme: InputDecorationTheme(
      filled: true, fillColor: c.raise, contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 15),
      border: border(c.line), enabledBorder: border(c.line), focusedBorder: border(c.sel, 1.6), errorBorder: border(c.rec),
      hintStyle: TextStyle(color: c.mut), labelStyle: TextStyle(color: c.mut),
    ),
    chipTheme: ChipThemeData(
      backgroundColor: c.raise, selectedColor: c.sel, side: BorderSide(color: c.line), shape: const StadiumBorder(),
      labelStyle: TextStyle(color: c.mut, fontWeight: FontWeight.w700, fontSize: 13),
      secondaryLabelStyle: TextStyle(color: c.selInk, fontWeight: FontWeight.w800, fontSize: 13), showCheckmark: false,
    ),
    dividerTheme: DividerThemeData(color: c.lineSoft, space: 1, thickness: 1),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating, backgroundColor: c.text, contentTextStyle: TextStyle(color: c.bg, fontWeight: FontWeight.w600),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
    ),
    bottomSheetTheme: BottomSheetThemeData(backgroundColor: c.panel, surfaceTintColor: Colors.transparent, shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24)))),
    dialogTheme: DialogThemeData(backgroundColor: c.panel, surfaceTintColor: Colors.transparent, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20))),
    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? c.selInk : c.mut),
      trackColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? c.sel : c.raise),
      trackOutlineColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? Colors.transparent : c.line),
    ),
  );
}
