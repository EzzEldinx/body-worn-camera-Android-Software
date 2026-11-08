import 'package:flutter/widgets.dart';

/// English + Arabic text. `context.tr('key')` picks the language of the app (RTL is handled by Flutter for Arabic).
const _t = <String, List<String>>{
  // key: [English, Arabic]
  'app': ['VisionGuard', 'VisionGuard'],
  'powered_by': ['Powered by', 'بدعم من'],
  'tab_fleet': ['Cameras', 'الكاميرات'],
  'tab_map': ['Map', 'الخريطة'],
  'tab_live': ['Live', 'مباشر'],
  'tab_alerts': ['Alerts', 'التنبيهات'],
  'tab_more': ['More', 'المزيد'],
  'sign_in': ['Sign in', 'تسجيل الدخول'],
  'sign_in_sub': ['Watch your cameras and receive SOS alerts, anywhere.', 'تابع كاميراتك واستلم نداءات الاستغاثة من أي مكان.'],
  'username': ['Username', 'اسم المستخدم'],
  'password': ['Password', 'كلمة المرور'],
  'sign_out': ['Sign out', 'تسجيل الخروج'],
  'sign_out_ask': ['Sign out of VisionGuard on this device?', 'تسجيل الخروج من VisionGuard على هذا الجهاز؟'],
  'cancel': ['Cancel', 'إلغاء'],
  'retry': ['Retry', 'إعادة المحاولة'],
  'close': ['Close', 'إغلاق'],
  'wrong_login': ['Wrong username or password.', 'اسم المستخدم أو كلمة المرور غير صحيحة.'],
  'too_many': ['Too many attempts. Try again in a few minutes.', 'محاولات كثيرة. حاول مرة أخرى بعد دقائق.'],
  'no_server': ['Cannot reach the server. Check your connection.', 'تعذر الاتصال بالخادم. تحقق من الإنترنت.'],
  'update_needed': ['Please update the app to continue.', 'يرجى تحديث التطبيق للمتابعة.'],
  'maintenance': ['The service is under maintenance. Try again shortly.', 'الخدمة تحت الصيانة. حاول بعد قليل.'],
  'kpi_online': ['Online', 'متصل'],
  'kpi_rec': ['Live', 'مباشر'],
  'kpi_alarms': ['Alarms', 'إنذارات'],
  'kpi_total': ['Cameras', 'الكاميرات'],
  'search_hint': ['Search by name or ID', 'ابحث بالاسم أو المعرف'],
  'f_all': ['All', 'الكل'],
  'f_online': ['Online', 'متصل'],
  'f_rec': ['Recording', 'تسجيل'],
  'f_off': ['Offline', 'غير متصل'],
  'st_online': ['Online', 'متصل'],
  'st_rec': ['Recording', 'جاري التسجيل'],
  'st_off': ['Offline', 'غير متصل'],
  'no_cameras': ['No cameras yet. Turn on a body camera and it appears here automatically.', 'لا توجد كاميرات بعد. شغّل كاميرا الجسم وستظهر هنا تلقائياً.'],
  'no_match': ['No camera matches your search.', 'لا توجد كاميرا مطابقة للبحث.'],
  'unassigned': ['Unassigned', 'غير معيّنة'],
  'last_seen': ['Last seen', 'آخر ظهور'],
  'never': ['no signal yet', 'لا توجد إشارة بعد'],
  'just_now': ['just now', 'الآن'],
  'gps_fix': ['GPS fix', 'تحديد الموقع'],
  'no_gps': ['No GPS fix yet', 'لا يوجد تحديد للموقع بعد'],
  'gps_stale': ['Last known position', 'آخر موقع معروف'],
  'watch_live': ['Watch live', 'مشاهدة مباشرة'],
  'stop_stream': ['Stop stream', 'إيقاف البث'],
  'stream_stopped': ['Stream stopped', 'تم إيقاف البث'],
  'requesting': ['Requesting live view…', 'جارٍ طلب البث المباشر…'],
  'waiting_stream': ['Connecting to the camera…', 'جارٍ الاتصال بالكاميرا…'],
  'cam_offline': ['This camera is offline', 'هذه الكاميرا غير متصلة'],
  'live_limit': ['Live limit of your package reached. Stop another stream first.', 'تم بلوغ حد البث المباشر في باقتك. أوقف بثاً آخر أولاً.'],
  'quality': ['Video quality', 'جودة الفيديو'],
  'quality_note': ['Applies to everyone watching this camera.', 'يؤثر على كل من يشاهد هذه الكاميرا.'],
  'quality_sent': ['Quality change sent', 'تم إرسال تغيير الجودة'],
  'fullscreen': ['Full screen', 'ملء الشاشة'],
  'listen': ['Listen', 'استماع'],
  'mute': ['Mute', 'كتم'],
  'pick_camera': ['Pick a camera to watch', 'اختر كاميرا للمشاهدة'],
  'pick_camera_sub': ['Online cameras can be watched in one tap. The officer does not have to do anything.', 'يمكنك مشاهدة الكاميرات المتصلة بلمسة واحدة، دون أي تدخل من الضابط.'],
  'add_camera': ['Add a camera', 'إضافة كاميرا'],
  'select_camera': ['Select a camera', 'اختر كاميرا'],
  'select_camera_sub': ['Tap a camera in the list to see its status and watch it live.', 'اضغط على كاميرا من القائمة لعرض حالتها ومشاهدتها مباشرة.'],
  'alerts_empty': ['No alarms. An SOS from a body camera appears here instantly.', 'لا توجد إنذارات. أي نداء استغاثة من الكاميرا يظهر هنا فوراً.'],
  'sos': ['SOS', 'استغاثة SOS'],
  'sos_from': ['SOS from', 'استغاثة من'],
  'active': ['Active', 'نشط'],
  'acked': ['Acknowledged', 'تم الاستلام'],
  'ack': ['Acknowledge', 'تأكيد الاستلام'],
  'open_live': ['Open live', 'فتح البث'],
  'show_map': ['Show on map', 'عرض على الخريطة'],
  'open_alert': ['Open', 'فتح'],
  'recordings': ['Recordings', 'التسجيلات'],
  'recordings_sub': ['Verified evidence offloaded from the cameras', 'الأدلة الموثّقة المنقولة من الكاميرات'],
  'no_recordings': ['No recordings yet. They appear here after a camera is docked.', 'لا توجد تسجيلات بعد. تظهر هنا بعد وضع الكاميرا على قاعدة الشحن.'],
  'all_cameras': ['All cameras', 'كل الكاميرات'],
  'settings': ['Settings', 'الإعدادات'],
  'appearance': ['Appearance', 'المظهر'],
  'theme_system': ['System', 'النظام'],
  'theme_light': ['Light', 'فاتح'],
  'theme_dark': ['Dark', 'داكن'],
  'language': ['Language', 'اللغة'],
  'security': ['Security', 'الأمان'],
  'biometric': ['Lock with Face ID / fingerprint', 'القفل بالبصمة أو الوجه'],
  'biometric_sub': ['Ask for it when you come back to the app', 'يُطلب عند العودة إلى التطبيق'],
  'biometric_why': ['Unlock VisionGuard', 'فتح VisionGuard'],
  'biometric_na': ['Not available on this device', 'غير متاح على هذا الجهاز'],
  'locked': ['VisionGuard is locked', 'التطبيق مقفل'],
  'unlock': ['Unlock', 'فتح القفل'],
  'account': ['Account', 'الحساب'],
  'about': ['About', 'حول التطبيق'],
  'version': ['Version', 'الإصدار'],
  'server': ['Server', 'الخادم'],
  'connected': ['Live updates on', 'التحديث المباشر يعمل'],
  'reconnecting': ['Reconnecting…', 'جارٍ إعادة الاتصال…'],
  'role_staff': ['Smart Way staff', 'فريق Smart Way'],
  'role_owner': ['Company account', 'حساب الشركة'],
  'dashboard_web': ['Web dashboard', 'لوحة التحكم على الويب'],
  'speed': ['Speed', 'السرعة'],
  'company': ['Company', 'الشركة'],
  'region': ['Region', 'المنطقة'],
  'status': ['Status', 'الحالة'],
  'position': ['Position', 'الموقع'],
  'load_failed': ['Could not load. Pull to retry.', 'تعذر التحميل. اسحب للتحديث.'],
  'download': ['Download', 'تنزيل'],
  'size': ['Size', 'الحجم'],
  'recorded': ['Recorded', 'وقت التسجيل'],
  'dock_title': ['Docking station', 'قاعدة الشحن والنقل'],
  'dock_sub': ['Cameras on the dock are checked and their recordings copied to the server.', 'تُفحص الكاميرات على القاعدة وتُنقل تسجيلاتها إلى الخادم.'],
  'dock_docks_online': ['Docks online', 'قواعد متصلة'],
  'dock_idle': ['Idle', 'فارغ'],
  'dock_ready': ['Ready', 'جاهزة'],
  'dock_offloading': ['Offloading', 'جارٍ النقل'],
  'dock_synced': ['Synced', 'تم النقل'],
  'dock_error': ['Needs attention', 'تحتاج متابعة'],
  'dock_other': ['In use', 'مستخدمة'],
  'dock_other_sub': ['A camera of another account is docked here.', 'كاميرا تابعة لحساب آخر موضوعة هنا.'],
  'dock_agent_on': ['Dock Agent online', 'برنامج القاعدة متصل'],
  'dock_agent_off': ['Dock Agent offline', 'برنامج القاعدة غير متصل'],
  'dock_none': ['No Dock Agent yet', 'لا يوجد برنامج قاعدة بعد'],
  'dock_none_sub': ['Install the Dock Agent on the PC next to the docking station.', 'ثبّت برنامج القاعدة على الكمبيوتر بجانب قاعدة الشحن.'],
  'dock_storage': ['Server storage', 'مساحة الخادم'],
  'dock_evidence': ['evidence', 'أدلة'],
  'dock_free': ['free', 'متاح'],
  'dock_docked': ['Docked', 'على القاعدة'],
  'dock_files_today': ['Files today', 'ملفات اليوم'],
  'dock_offloading_now': ['Offloading now', 'قيد النقل'],
  'dock_unregistered': ['Unregistered', 'غير مسجلة'],
  'view_recordings': ['View recordings', 'عرض التسجيلات'],
  'files': ['files', 'ملفات'],
};

class Tr {
  static String of(Locale l, String key) {
    final v = _t[key];
    if (v == null) return key;
    return l.languageCode == 'ar' ? v[1] : v[0];
  }
}

extension TrContext on BuildContext {
  bool get isAr => Localizations.localeOf(this).languageCode == 'ar';
  String tr(String key) => Tr.of(Localizations.localeOf(this), key);
}

/// "12 s ago", "5 min ago" ... in the current language.
String agoText(BuildContext c, int? ts) {
  if (ts == null || ts == 0) return c.tr('never');
  final s = ((DateTime.now().millisecondsSinceEpoch - ts) / 1000).round();
  final ar = c.isAr;
  if (s < 5) return c.tr('just_now');
  if (s < 60) return ar ? 'منذ $s ث' : '${s}s ago';
  if (s < 3600) return ar ? 'منذ ${s ~/ 60} د' : '${s ~/ 60} min ago';
  if (s < 86400) return ar ? 'منذ ${s ~/ 3600} س' : '${s ~/ 3600} h ago';
  return ar ? 'منذ ${s ~/ 86400} يوم' : '${s ~/ 86400} d ago';
}
