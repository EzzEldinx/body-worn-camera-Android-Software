// The words of the PDF report (report.js), in English and Arabic. A value that is a function takes the numbers / names of the sentence.
// Arabic counted nouns use ap(n, [one, two, 3-10, 11+]); numbers stay Western digits (as on the website).
const ap = (n, f) => (n === 1 ? f[0] : n === 2 ? f[1] : n >= 3 && n <= 10 ? f[2] : n === 0 ? f[2] : f[3]);
const en1 = (n, one, many) => (n === 1 ? one : many);

const en = {
    titleMulti: 'OPERATIONS REPORT', titleDay: 'DAILY OPERATIONS REPORT', allCompanies: 'All companies',
    badgeMulti: (n, live, clock) => `${n} DAYS${live ? ', LIVE UP TO ' + clock : ', FULL DAYS'}`,
    badgeDay: (live, clock) => (live ? 'LIVE DAY, UP TO ' + clock : 'FULL DAY 00:00 - 23:59'),
    range: (a, b) => `${a}  to  ${b}`,
    period: (multi) => (multi ? 'in this period' : 'today'),
    kActive: 'Active cameras', kSos: 'SOS alarms', kRec: 'Recorded time', kDist: 'Distance covered',
    kActiveSub: (n, o) => `of ${n} · ${o} online now`, kSosSub: (a, s) => `${a} answered · avg ${s}`, kSosNone: (p) => `no emergency ${p}`,
    sessions: (n) => `${n} session${n === 1 ? '' : 's'}`, kDistSub: (ptt, m) => `${ptt} PTT · ${m} messages`,
    fleet: 'Fleet right now', cameras: 'cameras', recording: 'Recording', idle: 'Online, idle', offline: 'Offline',
    byHour: 'Cameras reporting by hour', byHourSub: 'distinct cameras with activity', noDay: 'No activity recorded for this day.', noPeriod: 'No activity recorded in this period.',
    byDay: 'Recorded time by day', byDaySub: 'red = SOS alarms that day',
    sosTitle: 'SOS alarms', sosSub: (n, p) => `${n} ${p}`, sosNone: 'No SOS alarms were raised.', quiet: (multi) => (multi ? 'A quiet period for your fleet.' : 'A quiet day for your fleet.'),
    hTime: 'TIME', hCamera: 'CAMERA', hRegion: 'REGION', hResponse: 'RESPONSE', hStatus: 'STATUS', waiting: 'waiting', acked: 'ACKNOWLEDGED', open: 'OPEN',
    moreAlarms: (n) => `+ ${n} more alarms (see the audit trail)`,
    dayByDay: 'Day by day', days: (n) => `${n} days`, hDay: 'DAY', hActive: 'ACTIVE CAMERAS', hRecorded: 'RECORDED', hDistance: 'DISTANCE', hSos: 'SOS',
    activity: 'Camera activity', nCameras: (n) => `${n} cameras`, hOnline: 'ONLINE', hPtt: 'PTT', hMsgs: 'MSGS',
    custody: 'Camera custody', nCheckouts: (n) => `${n} check-out${n === 1 ? '' : 's'}`, hEmployee: 'EMPLOYEE', hTaken: 'TAKEN', hReturned: 'RETURNED', hTimeOut: 'TIME OUT', stillOut: 'still out',
    moreCheckouts: (n) => `+ ${n} more check-outs`,
    actions: 'Control-room actions', by: (who) => `by ${who}`, moreActions: (n) => `+ ${n} more actions (see the audit trail)`,
    timeline: 'Timeline', nEvents: (n) => `${n} event${n === 1 ? '' : 's'}`, noEvents: 'Events are logged from the moment this version of VisionGuard started recording them.', moreEvents: (n) => `+ ${n} more events`,
    tSos: 'SOS alarm raised', tAck: (who) => `SOS acknowledged by ${who}`, tOn: 'Camera came online', tOff: 'Camera went offline',
    tRec: (a, b, d) => `Recording ${a} - ${b}  (${d})`, tRecOpen: (a) => `Recording since ${a}  (in progress)`, tTaken: (w) => `Camera taken by ${w}`, tReturned: (w) => `Camera returned by ${w}`,
    aLive: 'Live view started remotely', aLiveStop: 'Remote live view stopped', aRecStop: 'Recording stopped from the control room', aQuality: (q) => `Video quality set to ${q}`, aUpdate: 'App update sent',
    dispatcher: 'dispatcher', employee: 'employee',
    footer: 'VisionGuard  |  Powered by Smart Way Group  |  Confidential: for the named company only', generated: (d) => `Generated ${d}`,
    titleInfo: (multi, scope, range) => `VisionGuard ${multi ? 'operations' : 'daily'} report - ${scope} - ${range}`,
    hUnitH: 'h', hUnitM: 'm', unitM: 'm', unitKm: 'km', unitS: 's',
};

const ar = {
    titleMulti: 'تقرير العمليات', titleDay: 'تقرير العمليات اليومي', allCompanies: 'كل الشركات',
    badgeMulti: (n, live, clock) => `${n} ${ap(n, ['يوم', 'يومان', 'أيام', 'يوماً'])}${live ? '، مباشر حتى ' + clock : '، أيام كاملة'}`,
    badgeDay: (live, clock) => (live ? 'يوم مباشر حتى ' + clock : 'يوم كامل 00:00 - 23:59'),
    range: (a, b) => `من ${a} إلى ${b}`,
    period: (multi) => (multi ? 'في هذه الفترة' : 'اليوم'),
    kActive: 'الكاميرات النشطة', kSos: 'إنذارات SOS', kRec: 'مدة التسجيل', kDist: 'المسافة المقطوعة',
    kActiveSub: (n, o) => `من ${n} · ${o} متصلة الآن`, kSosSub: (a, s) => `رُدّ ${a} · متوسط ${s}`, kSosNone: (p) => `لا طوارئ ${p}`,
    sessions: (n) => `${n} ${ap(n, ['جلسة', 'جلستان', 'جلسات', 'جلسة'])}`, kDistSub: (ptt, m) => `${ptt} PTT · ${m} ${ap(m, ['رسالة', 'رسالتان', 'رسائل', 'رسالة'])}`,
    fleet: 'الأسطول الآن', cameras: 'كاميرا', recording: 'تسجّل', idle: 'متصلة فقط', offline: 'غير متصلة',
    byHour: 'الكاميرات النشطة حسب الساعة', byHourSub: 'عدد الكاميرات التي سجّلت نشاطاً', noDay: 'لا يوجد نشاط مسجّل لهذا اليوم.', noPeriod: 'لا يوجد نشاط مسجّل في هذه الفترة.',
    byDay: 'مدة التسجيل حسب اليوم', byDaySub: 'الأحمر = إنذارات SOS في ذلك اليوم',
    sosTitle: 'إنذارات SOS', sosSub: (n, p) => `${n} ${p}`, sosNone: 'لم يُرفع أي إنذار SOS.', quiet: (multi) => (multi ? 'فترة هادئة لأسطولك.' : 'يوم هادئ لأسطولك.'),
    hTime: 'الوقت', hCamera: 'الكاميرا', hRegion: 'المنطقة', hResponse: 'زمن الاستجابة', hStatus: 'الحالة', waiting: 'بانتظار الرد', acked: 'تم الرد', open: 'مفتوح',
    moreAlarms: (n) => `+ ${n} ${ap(n, ['إنذار آخر', 'إنذاران آخران', 'إنذارات أخرى', 'إنذاراً آخر'])} (راجع سجل التدقيق)`,
    dayByDay: 'يوماً بيوم', days: (n) => `${n} ${ap(n, ['يوم', 'يومان', 'أيام', 'يوماً'])}`, hDay: 'اليوم', hActive: 'الكاميرات النشطة', hRecorded: 'المسجّل', hDistance: 'المسافة', hSos: 'SOS',
    activity: 'نشاط الكاميرات', nCameras: (n) => `${n} ${ap(n, ['كاميرا', 'كاميرتان', 'كاميرات', 'كاميرا'])}`, hOnline: 'الاتصال', hPtt: 'PTT', hMsgs: 'الرسائل',
    custody: 'عهدة الكاميرات', nCheckouts: (n) => `${n} ${ap(n, ['عملية استلام', 'عمليتا استلام', 'عمليات استلام', 'عملية استلام'])}`, hEmployee: 'الموظف', hTaken: 'وقت الاستلام', hReturned: 'وقت الإرجاع', hTimeOut: 'المدة', stillOut: 'لم تُرجع بعد',
    moreCheckouts: (n) => `+ ${n} ${ap(n, ['عملية استلام أخرى', 'عمليتا استلام أخريان', 'عمليات استلام أخرى', 'عملية استلام أخرى'])}`,
    actions: 'إجراءات غرفة التحكم', by: (who) => `بواسطة ${who}`, moreActions: (n) => `+ ${n} ${ap(n, ['إجراء آخر', 'إجراءان آخران', 'إجراءات أخرى', 'إجراءً آخر'])} (راجع سجل التدقيق)`,
    timeline: 'الجدول الزمني', nEvents: (n) => `${n} ${ap(n, ['حدث', 'حدثان', 'أحداث', 'حدثاً'])}`, noEvents: 'تُسجَّل الأحداث منذ بدء هذه النسخة من VisionGuard بتسجيلها.', moreEvents: (n) => `+ ${n} ${ap(n, ['حدث آخر', 'حدثان آخران', 'أحداث أخرى', 'حدثاً آخر'])}`,
    tSos: 'رُفع إنذار SOS', tAck: (who) => `تم الرد على SOS بواسطة ${who}`, tOn: 'اتصلت الكاميرا', tOff: 'انقطع اتصال الكاميرا',
    tRec: (a, b, d) => `تسجيل ${a} - ${b}  (${d})`, tRecOpen: (a) => `تسجيل منذ ${a}  (جارٍ)`, tTaken: (w) => `استلم الكاميرا ${w}`, tReturned: (w) => `أعاد الكاميرا ${w}`,
    aLive: 'بدء بث مباشر عن بُعد', aLiveStop: 'إيقاف البث المباشر عن بُعد', aRecStop: 'إيقاف التسجيل من غرفة التحكم', aQuality: (q) => `ضبط جودة الفيديو على ${q}`, aUpdate: 'إرسال تحديث التطبيق',
    dispatcher: 'المشغّل', employee: 'موظف',
    footer: 'VisionGuard  |  بدعم من مجموعة سمارت واي  |  سري: للشركة المذكورة فقط', generated: (d) => `أُنشئ في ${d}`,
    titleInfo: (multi, scope, range) => `تقرير ${multi ? 'العمليات' : 'العمليات اليومي'} VisionGuard - ${scope} - ${range}`,
    hUnitH: 'س', hUnitM: 'د', unitM: 'م', unitKm: 'كم', unitS: 'ث',
};

const MON_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const DAY_AR = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
module.exports = { en, ar, MON_AR, DAY_AR };
