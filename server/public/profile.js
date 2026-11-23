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
      <h4>${esc(VG.t('pf.mfa'))}</h4><div id="pfMfa" class="pf-mfa"></div>
      <h4>${esc(VG.t('pf.see'))}</h4>${rows('feature')}<h4>${esc(VG.t('pf.do'))}</h4>${rows('action')}
      <div class="pf-f">${window.pickPicture ? `<button class="btn" data-a="pic">${esc(VG.t('pf.pic'))}</button>` : ''}<button class="btn pri" data-a="x">${esc(VG.t('pf.close'))}</button></div></div>`;
    m.addEventListener('click', (e) => {
      if (e.target === m) return close();
      const b = e.target.closest('button[data-a]'); if (!b) return;
      if (b.dataset.a === 'pic') window.pickPicture('user', a.id).then((ok) => { if (ok) location.reload(); }).catch(() => {});
      else close();
    });
    document.body.appendChild(m);
    mfaBox(m.querySelector('#pfMfa'));
    document.addEventListener('keydown', function k(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', k); } });
    m.querySelector('button[data-a="x"]').focus();
  }
  // Two-step sign-in (server/mfa.js): status, set-up with a QR code and the recovery codes (shown once), and switching it off.
  const post = (u, body) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
    .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.status); return j; });
  async function mfaBox(el) {
    if (!el) return;
    const st = await fetch('/api/me/mfa').then((r) => r.json()).catch(() => null);
    if (!st) { el.textContent = ''; return; }
    const day = (t) => new Date(t).toISOString().slice(0, 10);
    el.innerHTML = `<p class="pf-intro">${esc(st.enabled ? VG.t('pf.mfa.on', { date: day(st.since || Date.now()), n: st.recoveryLeft }) : VG.t('pf.mfa.off'))}</p>
      <div class="pf-f" style="justify-content:flex-start;margin-top:6px"><button class="btn ${st.enabled ? '' : 'pri'}" data-m="${st.enabled ? 'off' : 'on'}">${esc(VG.t(st.enabled ? 'pf.mfa.off.b' : 'pf.mfa.setup'))}</button></div><div class="pf-mfa-w"></div>`;
    const w = el.querySelector('.pf-mfa-w'), err = (e) => `<p class="pf-mfa-err" role="alert">${esc(e.message)}</p>`;
    el.querySelector('button[data-m]').onclick = async (ev) => {
      ev.currentTarget.disabled = true;
      if (st.enabled) {
        w.innerHTML = `<p class="pf-intro">${esc(VG.t('pf.mfa.offAsk'))}</p><input type="password" class="pf-in" id="pfPw" autocomplete="current-password" placeholder="${esc(VG.t('pf.mfa.pw'))}">
          <input class="pf-in" id="pfOc" inputmode="numeric" autocomplete="one-time-code" maxlength="6" dir="ltr" placeholder="${esc(VG.t('pf.mfa.code'))}">
          <div class="pf-f" style="justify-content:flex-start"><button class="btn pri" id="pfOff">${esc(VG.t('pf.mfa.off.b'))}</button><button class="btn" id="pfCan">${esc(VG.t('pf.mfa.cancel'))}</button></div><div class="pf-e"></div>`;
        w.querySelector('#pfCan').onclick = () => mfaBox(el);
        w.querySelector('#pfOff').onclick = () => post('/api/me/mfa/disable', { password: w.querySelector('#pfPw').value, code: w.querySelector('#pfOc').value.trim() })
          .then(() => mfaBox(el), (e) => { w.querySelector('.pf-e').innerHTML = err(e); });
        return;
      }
      let s;
      try { s = await post('/api/me/mfa/setup'); } catch (e) { w.innerHTML = err(e); return; }
      w.innerHTML = `<p class="pf-intro">${esc(VG.t('pf.mfa.scan'))}</p>${s.qr ? `<div class="pf-qr">${s.qr}</div>` : ''}
        <p class="pf-key"><b>${esc(VG.t('pf.mfa.key'))}:</b> <code dir="ltr">${esc(s.secret.replace(/(.{4})/g, '$1 ').trim())}</code></p>
        <input class="pf-in" id="pfC" inputmode="numeric" autocomplete="one-time-code" maxlength="6" dir="ltr" placeholder="${esc(VG.t('pf.mfa.code'))}">
        <div class="pf-f" style="justify-content:flex-start"><button class="btn pri" id="pfOk">${esc(VG.t('pf.mfa.confirm'))}</button><button class="btn" id="pfCan">${esc(VG.t('pf.mfa.cancel'))}</button></div><div class="pf-e"></div>`;
      w.querySelector('#pfC').focus();
      w.querySelector('#pfCan').onclick = () => mfaBox(el);
      w.querySelector('#pfOk').onclick = () => post('/api/me/mfa/enable', { code: w.querySelector('#pfC').value.trim() }).then((r) => {
        w.innerHTML = `<p class="pf-intro"><b>${esc(VG.t('pf.mfa.done'))}</b></p><pre class="pf-codes" dir="ltr">${esc(r.recoveryCodes.join('\n'))}</pre>
          <div class="pf-f" style="justify-content:flex-start"><button class="btn pri" id="pfCp">${esc(VG.t('pf.mfa.copy'))}</button></div>`;
        el.querySelector('button[data-m]').remove();
        w.querySelector('#pfCp').onclick = (e) => { navigator.clipboard?.writeText(r.recoveryCodes.join('\n')).then(() => { e.target.textContent = VG.t('pf.mfa.copied'); }); };
      }, (e) => { w.querySelector('.pf-e').innerHTML = err(e); });
    };
  }

  window.vgProfile = { open, close };
})();
