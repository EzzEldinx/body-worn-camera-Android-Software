/* Live captions shown as subtitles over a stream picture (like subtitles in a film). Used by the dashboard (index.html) and the wall page (wall.html).
   The server only sends `transcript` lines to people who may read them, so a tile can always carry the (empty, hidden) subtitle element.
     VGCap.html(cameraId)  markup to put inside a tile
     VGCap.sync(cameraId)  fill the subtitle of every tile of that camera (call after a tile was drawn again)
     VGCap.line(line)      call for every socket 'transcript' event: {cameraId, text, partial, utt}
   While someone talks the text is a draft that is rewritten every second or so (`partial`); when they pause the final text replaces it.
   It fades out 6 seconds after the last update. */
(function () {
  const HIDE_MS = 6000;
  const css = '.sub{position:absolute;left:0;right:0;bottom:5%;z-index:3;text-align:center;pointer-events:none;padding:0 6%;transition:opacity .35s}'
    + '.sub.off{opacity:0}'
    + '.sub-t{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;width:fit-content;max-width:100%;margin:0 auto;padding:.12em .55em;border-radius:.4em;'
    + 'background:rgba(8,12,20,.72);color:#fff;font-size:clamp(11px,3.4cqw,28px);line-height:1.5;font-weight:600;text-shadow:0 1px 2px rgba(0,0,0,.6)}'
    + '.sub.draft .sub-t{color:#e6ebf5}';
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  const state = new Map();   // cameraId -> { text, draft, t }
  const els = (id) => document.querySelectorAll('.sub[data-cam="' + CSS.escape(id) + '"]');
  function sync(id) {
    const s = state.get(id), fresh = s && Date.now() - s.t < HIDE_MS;
    els(id).forEach((el) => {
      const t = el.firstElementChild;
      if (fresh) { if (t.textContent !== s.text) t.textContent = s.text; el.classList.toggle('draft', !!s.draft); }
      el.classList.toggle('off', !fresh);
    });
  }
  window.VGCap = {
    html: (id) => '<div class="sub off" data-cam="' + String(id).replace(/"/g, '&quot;') + '"><span class="sub-t" dir="auto"></span></div>',
    sync,
    line(l) {
      if (!l || !l.cameraId || !l.text) return;
      state.set(l.cameraId, { text: l.text, draft: !!l.partial, t: Date.now() });
      sync(l.cameraId);
    },
  };
  setInterval(() => { state.forEach((s, id) => { if (Date.now() - s.t >= HIDE_MS) sync(id); }); }, 1000);
})();
