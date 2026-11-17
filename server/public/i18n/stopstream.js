/* The Stop menu of a camera's picture (stopstream.js). Keys: ss.* */
(function (g, d) { if (typeof module === 'object' && module.exports) module.exports = d; else if (g.VG) g.VG.add(d); })(typeof window !== 'undefined' ? window : globalThis, {
  en: {
    'ss.title': 'Stop {name}?', 'ss.remote': 'This live view was started from the control room. Stopping it ends the stream and the recording the camera began for it.',
    'ss.officer': '{name} is recording. The officer started this recording. Stopping it ends the video file and the live stream, and the officer is told.',
    'ss.idle': 'Nothing is streaming from this camera.', 'ss.offline': 'This camera is offline.', 'ss.noRight': 'You are not allowed to stop an officer\'s recording.',
    'ss.needsUpdate': 'This camera must be updated before it can be stopped from here. Put it on the docking station.',
    'ss.btnRemote': 'Stop streaming', 'ss.btnOfficer': 'Stop recording and streaming', 'ss.btnWindow': 'Close window only', 'ss.btnClose': 'Close window', 'ss.btnCancel': 'Cancel', 'ss.sent': 'Stop sent to the camera',
    'ss.r.live_limit': 'Live-stream limit of your package reached', 'ss.r.offline': 'Camera is offline', 'ss.r.needs_update': 'This camera must be updated before it can be stopped from here',
    'ss.r.sos_open': 'An SOS from this camera is still open. Acknowledge it first', 'ss.r.not_allowed': 'You are not allowed to stop an officer\'s recording', 'ss.r.not_recording': 'This camera is not recording',
  },
  ar: {
    'ss.title': 'إيقاف {name}؟', 'ss.remote': 'بدأ هذا البث من غرفة التحكم. إيقافه ينهي البث والتسجيل الذي بدأته الكاميرا من أجله.',
    'ss.officer': '{name} تسجّل الآن. الضابط هو من بدأ هذا التسجيل. إيقافه ينهي ملف الفيديو والبث المباشر، وسيُبلَّغ الضابط.',
    'ss.idle': 'لا يوجد بث من هذه الكاميرا.', 'ss.offline': 'الكاميرا غير متصلة.', 'ss.noRight': 'ليست لديك صلاحية إيقاف تسجيل الضابط.',
    'ss.needsUpdate': 'يجب تحديث هذه الكاميرا قبل إيقافها من هنا. ضعها على محطة الإرساء.',
    'ss.btnRemote': 'إيقاف البث', 'ss.btnOfficer': 'إيقاف التسجيل والبث', 'ss.btnWindow': 'إغلاق النافذة فقط', 'ss.btnClose': 'إغلاق النافذة', 'ss.btnCancel': 'إلغاء', 'ss.sent': 'تم إرسال أمر الإيقاف إلى الكاميرا',
    'ss.r.live_limit': 'تم الوصول للحد الأقصى للبث المباشر في باقتك', 'ss.r.offline': 'الكاميرا غير متصلة', 'ss.r.needs_update': 'يجب تحديث هذه الكاميرا قبل إيقافها من هنا',
    'ss.r.sos_open': 'هناك إنذار SOS مفتوح من هذه الكاميرا. أكّده أولاً', 'ss.r.not_allowed': 'ليست لديك صلاحية إيقاف تسجيل الضابط', 'ss.r.not_recording': 'هذه الكاميرا لا تسجّل الآن',
  },
});
