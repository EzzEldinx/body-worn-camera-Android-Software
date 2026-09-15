/// OSD / overlay timestamps. Keep formatting locale-stable for evidence.
class DateFormatter {
  DateFormatter._();

  /// `YYYY-MM-DD HH:mm:ss` in local time — used on the kiosk status overlay.
  static String overlayStamp(DateTime dateTime) {
    String two(int n) => n.toString().padLeft(2, '0');
    return '${dateTime.year}-${two(dateTime.month)}-${two(dateTime.day)} '
        '${two(dateTime.hour)}:${two(dateTime.minute)}:${two(dateTime.second)}';
  }
}
