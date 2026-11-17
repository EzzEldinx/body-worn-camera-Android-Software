/* The audit trail in words: what each recorded step means (step.*), the labels of its details (dk.*) and of some values (dv.*).
   The server stores the step as a code; the page writes it in the reader's language: VG.step(action), VG.detail({...}). */
(function (g, d) {
  if (typeof module === 'object' && module.exports) { module.exports = d; return; }
  const VG = g.VG; if (!VG) return;
  VG.add(d);
  const t = VG.t;
  VG.step = (a) => {
    if (VG.has('step.' + a)) return t('step.' + a);
    let m;
    if ((m = /^set_quality_(.+)$/.exec(a))) return t('step.set_quality', { q: m[1] });
    if ((m = /^package_(.+)$/.exec(a))) return t('step.package', { n: m[1] === 'unlimited' ? '∞' : m[1] });
    if ((m = /^recordings_expired_(\d+)$/.exec(a))) return t('step.recordings_expired') + ' (' + m[1] + ')';
    if ((m = /^(update_(?:auto|halted|rolling|resumed|upload|app))_(.+)$/.exec(a)) && VG.has('step.' + m[1])) return t('step.' + m[1]) + ' · ' + m[2];
    if ((m = /^update_(.+)$/.exec(a))) return t('step.update', { what: m[1].replace(/_/g, ' ') });
    return a.replace(/_/g, ' ');
  };
  VG.detail = (detail) => Object.entries(detail || {}).filter(([k, v]) => k !== 'verifiedSha256' && v !== null && v !== undefined && v !== '').map(([k, v]) =>
    `${VG.has('dk.' + k) ? t('dk.' + k) : k}: ${v === true ? t('dk.true') : v === false ? t('dk.false') : VG.has('dv.' + k + '.' + v) ? t('dv.' + k + '.' + v) : v}`).join(' · ');
})(typeof window !== 'undefined' ? window : globalThis, {
  en: {
    'step.remote_record_stop': 'Recording stopped from the control room', 'step.remote_stream_start': 'Live view started', 'step.remote_stream_stop': 'Live view stopped',
    'step.set_quality': 'Quality set to {q}',
    'step.dock_file_copied': 'File copied from the camera to the dock (verified)', 'step.dock_file_choice_cloud': 'Decision: push to cloud', 'step.dock_file_choice_local': 'Decision: keep on dock storage',
    'step.dock_file_uploaded_cloud': 'Uploaded to the cloud (verified)', 'step.dock_file_upload_failed': 'Cloud upload failed',
    'step.dock_file_delete_requested': 'Deletion from camera requested', 'step.dock_file_deleted_from_camera': 'Deleted from the camera', 'step.dock_file_delete_refused': 'Deletion refused (no verified copy)',
    'step.recording_expired': 'Removed from the cloud by retention', 'step.recording_downloaded': 'Recording downloaded', 'step.recordings_expired': 'Old recordings removed from the cloud by retention',
    'step.dock_policy_ask': 'Mode set: Ask me', 'step.dock_policy_auto_cloud': 'Mode set: Automatic · Cloud', 'step.dock_policy_auto_local': 'Mode set: Automatic · Dock storage',
    'step.dock_calibrated': 'Docking station calibrated', 'step.dock_calibration_started': 'Docking station calibration started', 'step.dock_bay_set': 'Docking bay assigned', 'step.dock_bays_arranged': 'Docking bays arranged',
    'step.camera_edited': 'Camera edited', 'step.camera_removed': 'Camera removed', 'step.token_issued': 'Camera token issued', 'step.token_revoked': 'Camera token revoked',
    'step.audit_exported': 'Audit trail exported', 'step.ai_analysis_generated': 'AI analysis generated', 'step.summary_generated': 'Summary generated', 'step.mobile_login': 'Signed in on the mobile app', 'step.login_locked': 'Sign-in locked after too many wrong passwords',
    'step.report_downloaded': 'Report downloaded', 'step.battery_low': 'Battery low (under 20%)', 'step.battery_critical': 'Battery critical (under 10%)', 'step.battery_recovered': 'Battery recovered or charging',
    'step.camera_checkout': 'Camera checked out by an employee', 'step.camera_picked_up': 'Camera left the dock', 'step.camera_returned': 'Camera returned to the dock', 'step.checkout_cancelled': 'Check-out cancelled',
    'step.checkouts_exported': 'Check-outs exported', 'step.checkout_settings': 'Check-out settings changed',
    'step.employee_created': 'Employee account created', 'step.employee_updated': 'Employee updated', 'step.employee_disabled': 'Employee switched off', 'step.employee_enabled': 'Employee switched on', 'step.employee_removed': 'Employee removed',
    'step.user_created': 'Dashboard user created', 'step.user_removed': 'Dashboard user removed', 'step.user_access_set': 'User access changed', 'step.user_role_set': 'User role changed',
    'step.company_features_set': 'Company features changed', 'step.subscription_set': 'Subscription changed', 'step.package': 'Package changed ({n})',
    'step.license_installed': 'Licence installed', 'step.license_renewal_requested': 'Licence renewal requested', 'step.license_warning': 'Licence reminder', 'step.license_camera_refused': 'Camera refused by the licence',
    'step.geofence_created': 'Zone created', 'step.geofence_edited': 'Zone changed', 'step.geofence_removed': 'Zone removed',
    'step.geo_exit': 'Camera left a zone', 'step.geo_enter': 'Camera entered a zone', 'step.checkpoint_missed': 'Checkpoint missed',
    'step.geo_exit_cleared': 'Alert cleared: left a zone', 'step.geo_enter_cleared': 'Alert cleared: entered a zone', 'step.checkpoint_missed_cleared': 'Alert cleared: checkpoint missed',
    'step.ticket_created': 'Support ticket opened', 'step.ticket_reply': 'Reply added to a support ticket', 'step.ticket_answered': 'Support ticket answered', 'step.ticket_open': 'Support ticket reopened',
    'step.ticket_in_progress': 'Support ticket in progress', 'step.ticket_resolved': 'Support ticket resolved', 'step.ticket_closed': 'Support ticket closed',
    'step.update_notice_sent': 'Update notice sent to customers', 'step.update_mode_off': 'Camera update method: off', 'step.update_mode_wifi': 'Camera update method: Wi-Fi only', 'step.update_mode_any': 'Camera update method: any network',
    'step.update_auto': 'Automatic camera update started', 'step.update_halted': 'Camera update halted', 'step.update_rolling': 'Camera update rolling out', 'step.update_resumed': 'Camera update resumed', 'step.update_upload': 'Camera build uploaded', 'step.update_app': 'Camera app published',
    'step.update': 'Update {what}', 'step.other': '{what}',
    'dk.file': 'file', 'dk.size': 'size', 'dk.dock': 'dock', 'dk.duplicate': 'duplicate', 'dk.copiedAndVerified': 'copied and verified', 'dk.verifiedCopyChecked': 'verified copy checked', 'dk.mode': 'mode', 'dk.was': 'was',
    'dk.reason': 'reason', 'dk.employee': 'employee', 'dk.employeeNo': 'employee no.', 'dk.slot': 'slot', 'dk.battery': 'battery', 'dk.endedBy': 'ended by', 'dk.minutesOut': 'minutes out', 'dk.batteryOut': 'battery out', 'dk.batteryIn': 'battery in',
    'dk.note': 'note', 'dk.zone': 'zone', 'dk.zoneId': 'zone id', 'dk.value': 'value', 'dk.name': 'name', 'dk.kind': 'type', 'dk.by': 'by', 'dk.user': 'user', 'dk.role': 'role', 'dk.company': 'company', 'dk.access': 'access', 'dk.features': 'features',
    'dk.end': 'ends', 'dk.lines': 'lines', 'dk.type': 'type', 'dk.from': 'from', 'dk.to': 'to', 'dk.days': 'days', 'dk.scope': 'scope', 'dk.build': 'build', 'dk.title': 'title', 'dk.serial': 'serial', 'dk.customer': 'customer', 'dk.term': 'term',
    'dk.expires': 'expires', 'dk.state': 'state', 'dk.daysLeft': 'days left', 'dk.port': 'port', 'dk.bay': 'bay', 'dk.top': 'top row', 'dk.bottom': 'bottom row', 'dk.attempt': 'attempt', 'dk.ip': 'address', 'dk.id': 'id',
    'dk.holder': 'holder', 'dk.grp': 'group', 'dk.region': 'region', 'dk.removed': 'removed', 'dk.true': 'yes', 'dk.false': 'no', 'dk.level': 'level',
    'dv.level.critical': 'critical', 'dv.level.warning': 'warning', 'dv.mode.ask': 'ask me', 'dv.mode.auto_cloud': 'automatic · cloud', 'dv.mode.auto_local': 'automatic · dock storage',
    'dv.role.admin': 'administrator', 'dv.role.manager': 'administrator', 'dv.role.client': 'operator', 'dv.role.viewer': 'viewer', 'dv.role.officer': 'employee',
    'dv.type.alarms': 'alarms', 'dv.type.fleet': 'fleet', 'dv.type.battery': 'battery', 'dv.type.recordings': 'recordings', 'dv.kind.geo_exit': 'left a zone', 'dv.kind.geo_enter': 'entered a zone', 'dv.kind.checkpoint_missed': 'checkpoint missed',
  },
  ar: {
    'step.remote_record_stop': 'أُوقف التسجيل من غرفة التحكم', 'step.remote_stream_start': 'بدأ البث المباشر', 'step.remote_stream_stop': 'توقف البث المباشر',
    'step.set_quality': 'تم ضبط الجودة على {q}',
    'step.dock_file_copied': 'نُسخ الملف من الكاميرا إلى المحطة (تم التحقق)', 'step.dock_file_choice_cloud': 'القرار: الرفع إلى السحابة', 'step.dock_file_choice_local': 'القرار: الإبقاء على تخزين المحطة',
    'step.dock_file_uploaded_cloud': 'تم الرفع إلى السحابة (تم التحقق)', 'step.dock_file_upload_failed': 'فشل الرفع إلى السحابة',
    'step.dock_file_delete_requested': 'طُلب الحذف من الكاميرا', 'step.dock_file_deleted_from_camera': 'تم الحذف من الكاميرا', 'step.dock_file_delete_refused': 'رُفض الحذف (لا توجد نسخة موثّقة)',
    'step.recording_expired': 'أُزيل من السحابة بسبب مدة الاحتفاظ', 'step.recording_downloaded': 'تم تنزيل التسجيل', 'step.recordings_expired': 'أُزيلت التسجيلات القديمة من السحابة بسبب مدة الاحتفاظ',
    'step.dock_policy_ask': 'تم ضبط الوضع: اسألني', 'step.dock_policy_auto_cloud': 'تم ضبط الوضع: تلقائي · السحابة', 'step.dock_policy_auto_local': 'تم ضبط الوضع: تلقائي · تخزين المحطة',
    'step.dock_calibrated': 'تمت معايرة محطة الإرساء', 'step.dock_calibration_started': 'بدأت معايرة محطة الإرساء', 'step.dock_bay_set': 'تم تعيين خانة في المحطة', 'step.dock_bays_arranged': 'تم ترتيب خانات المحطة',
    'step.camera_edited': 'تم تعديل كاميرا', 'step.camera_removed': 'تمت إزالة كاميرا', 'step.token_issued': 'صدر رمز للكاميرا', 'step.token_revoked': 'أُلغي رمز الكاميرا',
    'step.audit_exported': 'تم تصدير سجل التدقيق', 'step.ai_analysis_generated': 'تم إنشاء تحليل بالذكاء الاصطناعي', 'step.summary_generated': 'تم إنشاء ملخص', 'step.mobile_login': 'تسجيل دخول من التطبيق المحمول', 'step.login_locked': 'قُفل تسجيل الدخول بعد محاولات خاطئة كثيرة',
    'step.report_downloaded': 'تم تنزيل تقرير', 'step.battery_low': 'بطارية منخفضة (أقل من 20%)', 'step.battery_critical': 'بطارية حرجة (أقل من 10%)', 'step.battery_recovered': 'استعادت البطارية مستواها أو قيد الشحن',
    'step.camera_checkout': 'استلم موظف كاميرا', 'step.camera_picked_up': 'غادرت الكاميرا محطة الإرساء', 'step.camera_returned': 'أُعيدت الكاميرا إلى محطة الإرساء', 'step.checkout_cancelled': 'أُلغي الاستلام',
    'step.checkouts_exported': 'تم تصدير عمليات الاستلام', 'step.checkout_settings': 'تم تغيير إعدادات الاستلام',
    'step.employee_created': 'تم إنشاء حساب موظف', 'step.employee_updated': 'تم تحديث بيانات موظف', 'step.employee_disabled': 'تم إيقاف موظف', 'step.employee_enabled': 'تم تفعيل موظف', 'step.employee_removed': 'تمت إزالة موظف',
    'step.user_created': 'تم إنشاء مستخدم للوحة المراقبة', 'step.user_removed': 'تمت إزالة مستخدم للوحة المراقبة', 'step.user_access_set': 'تم تغيير صلاحيات مستخدم', 'step.user_role_set': 'تم تغيير دور مستخدم',
    'step.company_features_set': 'تم تغيير ميزات الشركة', 'step.subscription_set': 'تم تغيير الاشتراك', 'step.package': 'تم تغيير الباقة ({n})',
    'step.license_installed': 'تم تثبيت الترخيص', 'step.license_renewal_requested': 'طُلب تجديد الترخيص', 'step.license_warning': 'تذكير بالترخيص', 'step.license_camera_refused': 'رفض الترخيص تسجيل كاميرا',
    'step.geofence_created': 'تم إنشاء منطقة', 'step.geofence_edited': 'تم تعديل منطقة', 'step.geofence_removed': 'تمت إزالة منطقة',
    'step.geo_exit': 'غادرت كاميرا منطقة', 'step.geo_enter': 'دخلت كاميرا منطقة', 'step.checkpoint_missed': 'فاتت نقطة مرور',
    'step.geo_exit_cleared': 'أُغلق التنبيه: غادرت منطقة', 'step.geo_enter_cleared': 'أُغلق التنبيه: دخلت منطقة', 'step.checkpoint_missed_cleared': 'أُغلق التنبيه: فاتت نقطة مرور',
    'step.ticket_created': 'فُتحت تذكرة دعم', 'step.ticket_reply': 'أُضيف ردّ إلى تذكرة دعم', 'step.ticket_answered': 'تم الرد على تذكرة دعم', 'step.ticket_open': 'أُعيد فتح تذكرة دعم',
    'step.ticket_in_progress': 'تذكرة دعم قيد المعالجة', 'step.ticket_resolved': 'تم حل تذكرة دعم', 'step.ticket_closed': 'أُغلقت تذكرة دعم',
    'step.update_notice_sent': 'أُرسل إشعار التحديث إلى العملاء', 'step.update_mode_off': 'طريقة تحديث الكاميرا: متوقف', 'step.update_mode_wifi': 'طريقة تحديث الكاميرا: واي فاي فقط', 'step.update_mode_any': 'طريقة تحديث الكاميرا: أي شبكة',
    'step.update_auto': 'بدأ التحديث التلقائي للكاميرا', 'step.update_halted': 'أُوقف تحديث الكاميرات', 'step.update_rolling': 'يجري نشر تحديث الكاميرات', 'step.update_resumed': 'استؤنف تحديث الكاميرات', 'step.update_upload': 'تم رفع إصدار الكاميرا', 'step.update_app': 'تم نشر تطبيق الكاميرا',
    'step.update': 'تحديث {what}', 'step.other': '{what}',
    'dk.file': 'الملف', 'dk.size': 'الحجم', 'dk.dock': 'المحطة', 'dk.duplicate': 'مكرر', 'dk.copiedAndVerified': 'نُسخ وتم التحقق', 'dk.verifiedCopyChecked': 'تم فحص النسخة الموثّقة', 'dk.mode': 'الوضع', 'dk.was': 'كان',
    'dk.reason': 'السبب', 'dk.employee': 'الموظف', 'dk.employeeNo': 'رقم الموظف', 'dk.slot': 'الخانة', 'dk.battery': 'البطارية', 'dk.endedBy': 'أنهاه', 'dk.minutesOut': 'دقائق الاستلام', 'dk.batteryOut': 'البطارية عند الاستلام', 'dk.batteryIn': 'البطارية عند الإرجاع',
    'dk.note': 'ملاحظة', 'dk.zone': 'المنطقة', 'dk.zoneId': 'معرّف المنطقة', 'dk.value': 'القيمة', 'dk.name': 'الاسم', 'dk.kind': 'النوع', 'dk.by': 'بواسطة', 'dk.user': 'المستخدم', 'dk.role': 'الدور', 'dk.company': 'الشركة', 'dk.access': 'الصلاحيات', 'dk.features': 'الميزات',
    'dk.end': 'ينتهي', 'dk.lines': 'الأسطر', 'dk.type': 'النوع', 'dk.from': 'من', 'dk.to': 'إلى', 'dk.days': 'الأيام', 'dk.scope': 'النطاق', 'dk.build': 'الإصدار', 'dk.title': 'العنوان', 'dk.serial': 'الرقم التسلسلي', 'dk.customer': 'العميل', 'dk.term': 'المدة',
    'dk.expires': 'ينتهي', 'dk.state': 'الحالة', 'dk.daysLeft': 'الأيام المتبقية', 'dk.port': 'المنفذ', 'dk.bay': 'الخانة', 'dk.top': 'الصف العلوي', 'dk.bottom': 'الصف السفلي', 'dk.attempt': 'المحاولة', 'dk.ip': 'العنوان', 'dk.id': 'المعرّف',
    'dk.holder': 'حامل الكاميرا', 'dk.grp': 'المجموعة', 'dk.region': 'المنطقة', 'dk.removed': 'المحذوف', 'dk.true': 'نعم', 'dk.false': 'لا', 'dk.level': 'المستوى',
    'dv.level.critical': 'حرج', 'dv.level.warning': 'تحذير', 'dv.mode.ask': 'اسألني', 'dv.mode.auto_cloud': 'تلقائي · السحابة', 'dv.mode.auto_local': 'تلقائي · تخزين المحطة',
    'dv.role.admin': 'مدير', 'dv.role.manager': 'مدير', 'dv.role.client': 'مشغّل', 'dv.role.viewer': 'مشاهد', 'dv.role.officer': 'موظف',
    'dv.type.alarms': 'الإنذارات', 'dv.type.fleet': 'الأسطول', 'dv.type.battery': 'البطارية', 'dv.type.recordings': 'التسجيلات', 'dv.kind.geo_exit': 'غادرت منطقة', 'dv.kind.geo_enter': 'دخلت منطقة', 'dv.kind.checkpoint_missed': 'فاتت نقطة مرور',
  },
});
