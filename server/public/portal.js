/* Shared header + session for portal pages. Pages await `portalReady` to get the signed-in user.
   The words come from /i18n.js (load it first); the English / Arabic switch lives in this header. */
(function () {
  try { document.documentElement.dataset.theme = localStorage.getItem('bwc-theme') || 'light'; } catch (e) { document.documentElement.dataset.theme = 'light'; }
  const VG = window.VG, t = VG.t;

  window.toast = (msg) => {
    const el = document.createElement('div'); el.className = 'toast'; el.textContent = msg;
    document.body.appendChild(el); setTimeout(() => el.remove(), 2600);
  };

  // Pictures: a profile picture for a user, a logo for a company. The browser shrinks the picture first (256 px), the server checks it again.
  //   avatarInner('user', 12, ts, 'A') -> <img> when there is a picture, otherwise the letter.   pickPicture('user', 12) -> choose a file, shrink, upload.
  window.avatarInner = (kind, id, ts, letter) => (ts ? `<img class="avimg" src="/api/avatar/${kind}/${id}?v=${ts}" alt="">` : String(letter || '?').replace(/[<>&]/g, ''));
  window.pickPicture = (kind, id) => new Promise((resolve, reject) => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp';
    input.onchange = () => {
      const f = input.files && input.files[0]; if (!f) return resolve(false);
      const img = new Image(), url = URL.createObjectURL(f);
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(t('pic.notPicture'))); };
      img.onload = () => {
        URL.revokeObjectURL(url);
        const logo = kind === 'company', max = 256, side = Math.min(img.width, img.height);
        const c = document.createElement('canvas'), x = c.getContext('2d');
        if (logo) { const k = Math.min(1, max / Math.max(img.width, img.height)); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); x.drawImage(img, 0, 0, c.width, c.height); }   // a logo keeps its shape and transparency
        else { c.width = c.height = Math.min(max, side); x.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, c.width, c.height); }   // a person: the middle square
        c.toBlob((b) => fetch(`/api/avatar/${kind}/${id}`, { method: 'PUT', headers: { 'Content-Type': b.type }, body: b })
          .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || t('pic.uploadFailed')); resolve(true); }).catch(reject), logo ? 'image/png' : 'image/jpeg', 0.86);
      };
      img.src = url;
    };
    input.click();
  });
  window.removePicture = (kind, id) => fetch(`/api/avatar/${kind}/${id}`, { method: 'DELETE' }).then((r) => { if (!r.ok) throw new Error(t('pic.removeFailed')); });
  window.portalReady = fetch('/api/me').then((r) => (r.ok ? r.json() : Promise.reject())).then((me) => {
    const here = location.pathname;
    const has = (f) => !me.features || me.features.includes(f);   // what this person may use (the server enforces it too)
    const link = (href, label) => `<a href="${href}" class="${here === href ? 'on' : ''}">${label}</a>`;
    document.getElementById('top').innerHTML = `
      <button class="icon-btn menu-btn" id="menuBtn" type="button" aria-expanded="false" aria-controls="mainNav" aria-label="${VG.esc(t('nav.menu'))}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
      <a class="brand" href="/analytics.html"><span class="brand-text"><img class="vg-logo logo-light" src="/brand/visionguard-logo-sm.png" alt="VisionGuard"><img class="vg-logo logo-dark" src="/brand/visionguard-logo-light.png" alt="VisionGuard"><small class="pw">${t('hdr.poweredBy')} <img class="logo-light" src="/logo-light.png" alt="Smart Way"><img class="logo-dark" src="/logo-dark.png" alt="Smart Way"></small></span></a>
      <nav id="mainNav" aria-label="${VG.esc(t('nav.menu'))}">
        ${has('analytics') ? link('/analytics.html', t('nav.analytics')) : ''}
        ${has('reports') ? link('/reports.html', t('nav.reports')) : ''}
        ${has('live') ? link('/', t('nav.live')) : ''}
        ${has('docks') ? link('/docks.html', t('nav.docks')) : ''}
        ${link('/help.html', t('nav.support'))}
        ${link('/updates.html', t('nav.updates'))}
        ${me.companyId && me.role === 'manager' ? link('/employees.html', t('nav.employees')) : ''}
        ${me.super ? link('/admin.html', t('nav.admin')) + link('/license.html', t('nav.license')) : ''}
      </nav>
      <div class="hdr-right">
        ${me.company ? `<span class="chip">${me.logoTs ? `<img class="chlogo" src="/api/avatar/company/${me.companyId}?v=${me.logoTs}" alt="">` : ''}${me.company.replace(/[<>&]/g, '')}</span>` : `<span class="chip">${t('hdr.smartway')}</span>`}
        <button class="hav" id="myPic" title="${VG.esc(t('hdr.changePic'))}" aria-label="${VG.esc(t('hdr.changePic'))}">${avatarInner('user', me.id, me.avatarTs, (me.name || '?')[0].toUpperCase())}</button>
        <span class="who">${me.name.replace(/[<>&]/g, '')}</span>
        <span id="langSlot"></span>
        <button class="icon-btn" id="themeBtn" title="${VG.esc(t('hdr.theme'))}" aria-label="${VG.esc(t('hdr.theme'))}">
          <svg class="ico-moon" viewBox="0 0 24 24" fill="currentColor"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></svg>
          <svg class="ico-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
        </button>
        <button class="btn sm" id="outBtn" aria-label="${VG.esc(t('hdr.signOut'))}"><svg class="out-ico flip" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg><span>${t('hdr.signOut')}</span></button>
      </div>`;
    VG.mountSwitch('#langSlot');
    // The header fits itself: when it does not fit, first the company and the name go, then the menu folds into the button (also on a phone).
    const top = document.getElementById('top'), over = () => top.scrollWidth > top.clientWidth + 1;
    const fit = () => { top.classList.remove('slim', 'compact', 'menu-open'); if (over()) { top.classList.add('slim'); if (over()) top.classList.add('compact'); } };
    fit(); window.addEventListener('resize', fit); window.addEventListener('load', fit);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
    top.querySelectorAll('img').forEach((im) => { if (!im.complete) im.addEventListener('load', fit); });
    const menu = document.getElementById('menuBtn'), shut = () => { top.classList.remove('menu-open'); menu.setAttribute('aria-expanded', 'false'); };
    menu.onclick = (e) => { e.stopPropagation(); const on = top.classList.toggle('menu-open'); menu.setAttribute('aria-expanded', String(on)); };
    document.addEventListener('click', (e) => { if (!e.target.closest('#mainNav')) shut(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') shut(); });
    // licence notice under the header: expiring (administrators), expired, limited mode, trial running out
    if (me.company && me.subscription && /reports/.test(location.pathname)) { const m = document.querySelector('main'); if (m) m.insertAdjacentHTML('afterbegin', `<p class="muted" style="margin:0 0 10px;font-size:12px">${VG.h('sub.until', { date: VG.iso(me.subscription.end) })}</p>`); }
    const lic = me.license;
    if (lic && lic.show) {
      const n = lic.daysLeft, days = t('common.nDays', { n: Math.abs(n) });
      const text = lic.clock ? t('lic.clock')
        : lic.state === 'expiring' ? t('lic.expiring', { days, date: VG.date(lic.expires) })
        : lic.state === 'trial' ? t('lic.trial', { days })
        : lic.state === 'grace' ? t('lic.grace', { date: VG.date(lic.graceUntil) })
        : lic.state === 'locked' ? t('lic.locked')
        : t('lic.restricted');
      const bad = ['grace', 'restricted', 'locked'].includes(lic.state) || lic.clock;
      const bar = document.createElement('div');
      bar.className = 'licbar ' + (bad ? 'bad' : 'warn');
      bar.innerHTML = `<span>${VG.esc(text)}</span>${lic.canManage ? `<a class="btn sm" href="/license.html">${t('lic.renew')}</a>` : `<span class="muted">${t('lic.tellAdmin')}</span>`}`;
      document.getElementById('top').insertAdjacentElement('afterend', bar);
    }
    const sub = me.subscription;
    if (sub && sub.show) {
      const d = VG.date(sub.end), n = sub.daysLeft;
      const bar = document.createElement('div');
      bar.className = 'licbar ' + (sub.state === 'expired' ? 'bad' : 'warn');
      bar.innerHTML = `<span>${VG.esc(sub.state === 'expired' ? t('sub.ended', { date: d, lock: VG.date(sub.lockOn, { day: 'numeric', month: 'short' }) }) : t('sub.ending', { days: t('common.nDays', { n }), date: d }))}</span>`;
      document.getElementById('top').insertAdjacentElement('afterend', bar);
    }
    if (me.staff) fetch('/api/tickets?status=open').then((r) => (r.ok ? r.json() : null)).then((d) => {   // Smart Way support: how many tickets wait for an answer
      const n = d && d.tickets ? d.tickets.length : 0, a = document.querySelector('nav a[href="/help.html"]');
      if (n && a) a.insertAdjacentHTML('beforeend', ` <b class="navbadge">${n > 99 ? '99+' : n}</b>`);
    }).catch(() => {});
    document.getElementById('themeBtn').onclick = () => {
      const n = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = n; try { localStorage.setItem('bwc-theme', n); } catch (e) { }
      window.dispatchEvent(new Event('themechange'));
    };
    document.getElementById('myPic').onclick = () => pickPicture('user', me.id).then((ok) => { if (ok) location.reload(); }).catch((e) => toast(e.message));
    document.getElementById('outBtn').onclick = () => fetch('/api/logout', { method: 'POST' }).then(() => { location.href = '/login.html'; });

    // Updates. A heart beats on the tab (and a window opens once) until the person has seen the notice about a new camera update; after that
    // the tab shows how many cameras still wait for the docking station. Nothing here asks the client to do anything but dock the cameras.
    const HEART = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
    const html = VG.esc;
    const markSeen = (id, keepalive) => fetch('/api/updates/seen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }), keepalive: !!keepalive });
    const paintUpdates = (u) => {
      const a = document.querySelector('nav a[href="/updates.html"]');
      if (!a) return;
      a.querySelectorAll('.beat,.navcount').forEach((x) => x.remove());
      if (u && u.notice) a.insertAdjacentHTML('beforeend', `<span class="beat" title="${VG.esc(t('hdr.newUpdate'))}">${HEART}</span>`);
      else if (u && u.waiting > 0) a.insertAdjacentHTML('beforeend', `<span class="navcount" title="${VG.esc(t('hdr.waitingDock'))}">${u.waiting > 99 ? '99+' : u.waiting}</span>`);
    };
    let shownId = null;
    const showNotice = (u) => {
      const n = u && u.notice;
      if (!n || shownId === n.id || document.querySelector('.vgmodal') || location.pathname === '/updates.html') return;
      shownId = n.id;
      // the notice is written in English and in Arabic by Smart Way: show the one that matches the page, the other as a second paragraph
      const ar = VG.lang === 'ar', first = ar && n.bodyAr ? n.bodyAr : n.body, second = n.bodyAr && n.body ? (ar ? n.body : n.bodyAr) : '';
      const wait = u.waiting || 0, el = document.createElement('div');
      el.className = 'vgmodal'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', n.title);
      el.innerHTML = `<div class="box"><button class="x" data-a="close" aria-label="${VG.esc(t('common.close'))}">&times;</button>
        <span class="beat big">${HEART}</span><h2>${html(n.title)}</h2><p>${html(first)}</p>
        ${second ? `<p lang="${ar ? 'en' : 'ar'}" dir="${ar ? 'ltr' : 'rtl'}" class="alt">${html(second)}</p>` : ''}
        ${wait ? `<span class="wait">${VG.esc(t('upd.waitingN', { n: wait }))}</span>` : ''}
        <div class="row"><button class="btn" data-a="close">${t('common.close')}</button><a class="btn pri" href="/updates.html" data-a="open">${t('upd.see')}</a></div></div>`;
      const onKey = (e) => { if (e.key === 'Escape') close(); };
      const close = () => { el.remove(); document.removeEventListener('keydown', onKey); markSeen(n.id).then(() => paintUpdates({ notice: null, waiting: wait })).catch(() => { }); };
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-a]');
        if (!b) return;
        if (b.dataset.a === 'open') { markSeen(n.id, true); return; }   // the link takes the person to the Updates page
        close();
      });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(el);
      el.querySelector('.btn.pri').focus();
    };
    window.refreshUpdatesBadge = () => fetch('/api/updates/badge').then((r) => (r.ok ? r.json() : null)).then((u) => { if (u) { paintUpdates(u); showNotice(u); } }).catch(() => { });
    paintUpdates(me.updates); showNotice(me.updates);
    setInterval(() => { if (!document.hidden) window.refreshUpdatesBadge(); }, 120000);   // a notice sent while the page is open shows up within two minutes
    return me;
  }).catch(() => { location.href = '/login.html'; return new Promise(() => { }); });
})();
