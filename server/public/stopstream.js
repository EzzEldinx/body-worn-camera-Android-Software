// The "Stop" menu of a camera's picture: a dashboard tile, a tile of the live wall window, and the camera panel.
// Three different things can be meant, so the menu says which one it is about to do:
//   * close the window only          (nothing changes on the camera),
//   * stop a live view the control room started   (the camera ends the recording it began for that view),
//   * stop a recording the OFFICER started        (only for people with "Stop a recording"; the camera must be new enough;
//                                                  never while an SOS of that camera is unanswered; the officer is told).
// The server decides in the end (see the remote_stream handler in server.js): this only asks and explains.
(function () {
  const TXT = {
    en: {
      title: (n) => `Stop ${n}?`,
      remote: 'This live view was started from the control room. Stopping it ends the stream and the recording the camera began for it.',
      officer: (n) => `${n} is recording. The officer started this recording. Stopping it ends the video file and the live stream, and the officer is told.`,
      idle: 'Nothing is streaming from this camera.', offline: 'This camera is offline.',
      noRight: 'You are not allowed to stop an officer\'s recording.',
      needsUpdate: 'This camera must be updated before it can be stopped from here. Put it on the docking station.',
      btnRemote: 'Stop streaming', btnOfficer: 'Stop recording and streaming', btnWindow: 'Close window only', btnClose: 'Close window', btnCancel: 'Cancel',
      sent: 'Stop sent to the camera',
      reasons: {
        live_limit: 'Live-stream limit of your package reached', offline: 'Camera is offline',
        needs_update: 'This camera must be updated before it can be stopped from here', sos_open: 'An SOS from this camera is still open. Acknowledge it first',
        not_allowed: 'You are not allowed to stop an officer\'s recording', not_recording: 'This camera is not recording',
      },
    },
    ar: {
      title: (n) => `إيقاف ${n}؟`,
      remote: 'بدأ هذا البث من غرفة التحكم. إيقافه ينهي البث والتسجيل الذي بدأته الكاميرا من أجله.',
      officer: (n) => `${n} تسجّل الآن. الضابط هو من بدأ هذا التسجيل. إيقافه ينهي ملف الفيديو والبث المباشر، وسيُبلَّغ الضابط.`,
      idle: 'لا يوجد بث من هذه الكاميرا.', offline: 'الكاميرا غير متصلة.',
      noRight: 'ليست لديك صلاحية إيقاف تسجيل الضابط.',
      needsUpdate: 'يجب تحديث هذه الكاميرا قبل إيقافها من هنا. ضعها على محطة الإرساء.',
      btnRemote: 'إيقاف البث', btnOfficer: 'إيقاف التسجيل والبث', btnWindow: 'إغلاق النافذة فقط', btnClose: 'إغلاق النافذة', btnCancel: 'إلغاء',
      sent: 'تم إرسال أمر الإيقاف إلى الكاميرا',
      reasons: {
        live_limit: 'تم الوصول للحد الأقصى للبث المباشر في باقتك', offline: 'الكاميرا غير متصلة',
        needs_update: 'يجب تحديث هذه الكاميرا قبل إيقافها من هنا', sos_open: 'هناك نداء SOS مفتوح من هذه الكاميرا. أكّده أولاً',
        not_allowed: 'ليست لديك صلاحية إيقاف تسجيل الضابط', not_recording: 'هذه الكاميرا لا تسجّل الآن',
      },
    },
  };
  const tx = (lang) => TXT[lang === 'ar' ? 'ar' : 'en'];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let onKey = null;

  function close() {
    document.getElementById('vgsModal')?.remove();
    if (onKey) { document.removeEventListener('keydown', onKey, true); onKey = null; }
  }

  // o = { id, cam, name, lang, socket, canEndRecording, onCloseWindow }
  //   cam = the dashboard's record of the camera (online, recording, remote, caps); name = what to call it (plain text)
  function open(o) {
    close();
    const L = tx(o.lang), cam = o.cam || {}, id = o.id || cam.cameraId, name = esc(o.name || id);
    const kind = cam.remote ? 'remote' : cam.recording ? 'officer' : cam.online === false ? 'offline' : 'idle';
    const mayEnd = !!o.canEndRecording, canObey = Array.isArray(cam.caps) && cam.caps.includes('remote-stop');
    let body = '', stop = '';
    if (kind === 'remote') {
      body = `<p>${L.remote}</p>`;
      stop = `<button class="danger" data-a="stop">${L.btnRemote}</button>`;
    } else if (kind === 'officer') {
      body = `<p>${L.officer(name)}</p>`;
      if (!mayEnd) body += `<p class="note">${L.noRight}</p>`;
      else if (!canObey) body += `<p class="warn">${L.needsUpdate}</p>`;
      if (mayEnd) stop = `<button class="danger" data-a="stop"${canObey ? '' : ' disabled'}>${L.btnOfficer}</button>`;
    } else body = `<p>${kind === 'offline' ? L.offline : L.idle}</p>`;

    const m = document.createElement('div');
    m.className = 'vgs-modal'; m.id = 'vgsModal'; m.dir = o.lang === 'ar' ? 'rtl' : 'ltr';
    m.innerHTML = `<div class="vgs-card" role="dialog" aria-modal="true" aria-labelledby="vgsT"><h3 id="vgsT">${L.title(name)}</h3>${body}
      <div class="vgs-acts">${stop}<button data-a="window">${stop ? L.btnWindow : L.btnClose}</button><button data-a="cancel">${L.btnCancel}</button></div></div>`;
    m.addEventListener('click', (e) => {
      if (e.target === m) return close();
      const b = e.target.closest('button[data-a]'); if (!b || b.disabled) return;
      if (b.dataset.a === 'stop') {
        // the same command the "Stop remote stream" button has always sent; for an officer's recording it also says so on purpose
        o.socket.emit('remote_stream', kind === 'officer' ? { cameraId: id, action: 'stop', recording: true } : { cameraId: id, action: 'stop' });
      } else if (b.dataset.a === 'window' && o.onCloseWindow) o.onCloseWindow();
      close();
    });
    document.body.appendChild(m);
    onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    (m.querySelector('button:not([disabled])') || m).focus();
  }

  // the words for an answer of the server to a remote_stream command that was refused (anything unknown reads as "offline", as before)
  const reason = (code, lang) => tx(lang).reasons[code] || tx(lang).reasons.offline;
  window.vgStop = { open, close, reason, sentText: (lang) => tx(lang).sent };
})();
