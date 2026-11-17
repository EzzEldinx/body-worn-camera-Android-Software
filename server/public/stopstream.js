// The "Stop" menu of a camera's picture: a dashboard tile, a tile of the live wall window, and the camera panel.
// Three different things can be meant, so the menu says which one it is about to do:
//   * close the window only          (nothing changes on the camera),
//   * stop a live view the control room started   (the camera ends the recording it began for that view),
//   * stop a recording the OFFICER started        (only for people with "Stop a recording"; the camera must be new enough;
//                                                  never while an SOS of that camera is unanswered; the officer is told).
// The server decides in the end (see the remote_stream handler in server.js): this only asks and explains.
(function () {
  // The words are in i18n/stopstream.js (English and Arabic); the language is the page's (VG.lang). `name` is already escaped HTML.
  const t = (k, p) => VG.t(k, p);
  const tx = () => ({
    title: (n) => t('ss.title', { name: n }), remote: t('ss.remote'), officer: (n) => t('ss.officer', { name: n }), idle: t('ss.idle'), offline: t('ss.offline'), noRight: t('ss.noRight'), needsUpdate: t('ss.needsUpdate'),
    btnRemote: t('ss.btnRemote'), btnOfficer: t('ss.btnOfficer'), btnWindow: t('ss.btnWindow'), btnClose: t('ss.btnClose'), btnCancel: t('ss.btnCancel'), sent: t('ss.sent'),
  });
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
    const L = tx(), cam = o.cam || {}, id = o.id || cam.cameraId, name = esc(o.name || id);
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
    m.className = 'vgs-modal'; m.id = 'vgsModal'; m.dir = VG.dir;
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
  const reason = (code) => (VG.has('ss.r.' + code) ? t('ss.r.' + code) : t('ss.r.offline'));
  window.vgStop = { open, close, reason, sentText: () => t('ss.sent') };
})();
