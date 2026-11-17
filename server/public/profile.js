// "My profile and access": who the signed-in person is, their role, and exactly what they may see and do, with the reason for everything they may not.
// Opened from the picture in the header of every page: vgProfile.open(). The facts come from GET /api/me/access (server/server.js).
(function () {
  const VG = window.VG;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ready = () => new Promise((res) => {   // the names of the features live in /i18n/features.js
    const need = [VG.has('ft.live.l') ? null : '/i18n/features.js', VG.has('pf.title') ? null : '/i18n/profile.js'].filter(Boolean);
    if (!need.length) return res();
    let n = need.length; need.forEach((u) => { const s = document.createElement('script'); s.src = u; s.onload = s.onerror = () => { if (!--n) res(); }; document.head.appendChild(s); });
  });
  const close = () => document.getElementById('pfModal')?.remove();

  async function open(extra) {
    close();
    const [a] = await Promise.all([fetch('/api/me/access').then((r) => (r.ok ? r.json() : Promise.reject())), ready()]);
    const nm = (f) => (VG.has('ft.' + f.key + '.l') ? VG.t('ft.' + f.key + '.l') : f.label), hint = (f) => (VG.has('ft.' + f.key + '.h') ? VG.t('ft.' + f.key + '.h') : f.hint);
    const grp = (g) => (VG.has('ft.g.' + g) ? VG.t('ft.g.' + g) : g);
    const rows = (kind) => {
      const by = new Map();
      a.items.filter((f) => f.kind === kind).forEach((f) => { if (!by.has(f.group)) by.set(f.group, []); by.get(f.group).push(f); });
      return [...by].map(([g, list]) => `<div class="pf-g">${esc(grp(g))}</div>` + list.map((f) => `<div class="pf-r ${f.allowed ? 'ok' : 'no'}"><i aria-hidden="true">${f.allowed ? '✓' : '✕'}</i>
        <div><b>${esc(nm(f))}</b><small>${esc(hint(f))}</small>${f.allowed ? '' : `<small class="why">${esc(VG.t('pf.why.' + f.why))}</small>`}</div><span class="sr">${esc(VG.t(f.allowed ? 'pf.yes' : 'pf.no'))}</span></div>`).join('')).join('');
    };
    const m = document.createElement('div');
    m.id = 'pfModal'; m.className = 'pf-modal'; m.dir = VG.dir;
    m.innerHTML = `<div class="pf-card" role="dialog" aria-modal="true" aria-labelledby="pfT">
      <div class="pf-h"><span class="pf-av">${window.avatarInner ? window.avatarInner('user', a.id, extra && extra.avatarTs, (a.name || '?')[0].toUpperCase()) : esc((a.name || '?')[0].toUpperCase())}</span>
        <div><h3 id="pfT">${esc(a.name)}</h3><small>@${esc(a.username)}${a.company ? ' · ' + esc(a.company) : ''}</small></div>
        <span class="pf-role">${esc(VG.t('pf.role.' + a.role))}</span></div>
      <p class="pf-intro">${esc(VG.t('pf.intro.' + a.role, { company: a.company || '' }))}${a.subscription ? ' ' + esc(VG.t('pf.sub', { date: VG.iso ? VG.iso(a.subscription.end) : new Date(a.subscription.end).toISOString().slice(0, 10) })) : ''}</p>
      <h4>${esc(VG.t('pf.see'))}</h4>${rows('feature')}<h4>${esc(VG.t('pf.do'))}</h4>${rows('action')}
      <div class="pf-f">${window.pickPicture ? `<button class="btn" data-a="pic">${esc(VG.t('pf.pic'))}</button>` : ''}<button class="btn pri" data-a="x">${esc(VG.t('pf.close'))}</button></div></div>`;
    m.addEventListener('click', (e) => {
      if (e.target === m) return close();
      const b = e.target.closest('button[data-a]'); if (!b) return;
      if (b.dataset.a === 'pic') window.pickPicture('user', a.id).then((ok) => { if (ok) location.reload(); }).catch(() => {});
      else close();
    });
    document.body.appendChild(m);
    document.addEventListener('keydown', function k(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', k); } });
    m.querySelector('button[data-a="x"]').focus();
  }
  window.vgProfile = { open, close };
})();
