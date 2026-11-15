/* Shared header + session for portal pages. Pages await `portalReady` to get the signed-in user. */
(function () {
  try { document.documentElement.dataset.theme = localStorage.getItem('bwc-theme') || 'light'; } catch (e) { document.documentElement.dataset.theme = 'light'; }

  window.toast = (msg) => {
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.remove(), 2600);
  };

  // Pictures: a profile picture for a user, a logo for a company. The browser shrinks the picture first (256 px), the server checks it again.
  //   avatarInner('user', 12, ts, 'A') -> <img> when there is a picture, otherwise the letter.   pickPicture('user', 12) -> choose a file, shrink, upload.
  window.avatarInner = (kind, id, ts, letter) => (ts ? `<img class="avimg" src="/api/avatar/${kind}/${id}?v=${ts}" alt="">` : String(letter || '?').replace(/[<>&]/g, ''));
  window.pickPicture = (kind, id) => new Promise((resolve, reject) => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp';
    input.onchange = () => {
      const f = input.files && input.files[0]; if (!f) return resolve(false);
      const img = new Image(), url = URL.createObjectURL(f);
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This file is not a picture.')); };
      img.onload = () => {
        URL.revokeObjectURL(url);
        const logo = kind === 'company', max = 256, side = Math.min(img.width, img.height);
        const c = document.createElement('canvas'), x = c.getContext('2d');
        if (logo) { const k = Math.min(1, max / Math.max(img.width, img.height)); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); x.drawImage(img, 0, 0, c.width, c.height); }   // a logo keeps its shape and transparency
        else { c.width = c.height = Math.min(max, side); x.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, c.width, c.height); }   // a person: the middle square
        c.toBlob((b) => fetch(`/api/avatar/${kind}/${id}`, { method: 'PUT', headers: { 'Content-Type': b.type }, body: b })
          .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Upload failed'); resolve(true); }).catch(reject), logo ? 'image/png' : 'image/jpeg', 0.86);
      };
      img.src = url;
    };
    input.click();
  });
  window.removePicture = (kind, id) => fetch(`/api/avatar/${kind}/${id}`, { method: 'DELETE' }).then((r) => { if (!r.ok) throw new Error('Could not remove it'); });
  window.portalReady = fetch('/api/me').then((r) => (r.ok ? r.json() : Promise.reject())).then((me) => {
    const here = location.pathname;
    const has = (f) => !me.features || me.features.includes(f);   // what this person may use (the server enforces it too)
    const link = (href, label) => `<a href="${href}" class="${here === href ? 'on' : ''}">${label}</a>`;
    document.getElementById('top').innerHTML = `
      <a class="brand" href="/analytics.html"><span class="brand-text"><img class="vg-logo logo-light" src="/brand/visionguard-logo-sm.png" alt="VisionGuard"><img class="vg-logo logo-dark" src="/brand/visionguard-logo-light.png" alt="VisionGuard"><small class="pw">Powered by <img class="logo-light" src="/logo-light.png" alt="Smart Way"><img class="logo-dark" src="/logo-dark.png" alt="Smart Way"></small></span></a>
      <nav>
        ${has('analytics') ? link('/analytics.html', 'Analytics') : ''}
        ${has('reports') ? link('/reports.html', 'Reports') : ''}
        ${has('live') ? link('/', 'Live Dashboard') : ''}
        ${has('docks') ? link('/docks.html', 'Docking') : ''}
        ${link('/help.html', 'Support')}
        ${link('/updates.html', 'Updates')}
        ${me.companyId && me.role === 'manager' ? link('/employees.html', 'Employees') : ''}
        ${me.super ? link('/admin.html', 'Admin panel') + link('/license.html', 'License') : ''}
      </nav>
      <div class="hdr-right">
        ${me.company ? `<span class="chip">${me.logoTs ? `<img class="chlogo" src="/api/avatar/company/${me.companyId}?v=${me.logoTs}" alt="">` : ''}${me.company.replace(/[<>&]/g, '')}</span>` : '<span class="chip">Smart Way Group</span>'}
        <button class="hav" id="myPic" title="Change your picture" aria-label="Change your picture">${avatarInner('user', me.id, me.avatarTs, (me.name || '?')[0].toUpperCase())}</button>
        <span class="who">${me.name.replace(/[<>&]/g, '')}</span>
        <button class="icon-btn" id="themeBtn" title="Toggle theme" aria-label="Toggle theme">
          <svg class="ico-moon" viewBox="0 0 24 24" fill="currentColor"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></svg>
          <svg class="ico-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
        </button>
        <button class="btn sm" id="outBtn">Sign out</button>
      </div>`;
    // licence notice under the header: expiring (administrators), expired, limited mode, trial running out
    if (me.company && me.subscription && /reports/.test(location.pathname)) { const m = document.querySelector('main'); if (m) m.insertAdjacentHTML('afterbegin', `<p class="muted" style="margin:0 0 10px;font-size:12px">Subscription until ${new Date(me.subscription.end).toISOString().slice(0, 10)}</p>`); }
    const lic = me.license;
    if (lic && lic.show) {
      const day = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
      const n = lic.daysLeft, plural = Math.abs(n) === 1 ? '' : 's';
      const text = lic.clock ? 'The server clock is behind the last time VisionGuard ran. Correct the clock, or contact Smart Way.'
        : lic.state === 'expiring' ? `Your VisionGuard licence ends in ${n} day${plural} (${day(lic.expires)}). Renew it so there is no gap.`
        : lic.state === 'trial' ? `Trial: ${n} day${plural} left. Request a licence from Smart Way to keep going.`
        : lic.state === 'grace' ? `Your VisionGuard licence has expired. Everything still works until ${day(lic.graceUntil)}; after that the system goes into limited mode.`
        : lic.state === 'locked' ? 'The VisionGuard licence has expired and the system is locked. Ask your administrator to renew it.'
        : 'Limited mode: the VisionGuard licence has expired. Live view, alarms and evidence keep working; new cameras, users, reports and exports are paused.';
      const bad = ['grace', 'restricted', 'locked'].includes(lic.state) || lic.clock;
      const bar = document.createElement('div');
      bar.className = 'licbar ' + (bad ? 'bad' : 'warn');
      bar.innerHTML = `<span>${text}</span>${lic.canManage ? '<a class="btn sm" href="/license.html">Renew</a>' : '<span class="muted">Tell your administrator.</span>'}`;
      document.getElementById('top').insertAdjacentElement('afterend', bar);
    }
    const sub = me.subscription;
    if (sub && sub.show) {
      const d = new Date(sub.end).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }), n = sub.daysLeft;
      const bar = document.createElement('div');
      bar.className = 'licbar ' + (sub.state === 'expired' ? 'bad' : 'warn');
      bar.innerHTML = `<span>${sub.state === 'expired' ? `Your VisionGuard subscription ended on ${d}. Access stops on ${new Date(sub.lockOn).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}. Contact Smart Way to renew it now.` : `Your VisionGuard subscription ends in ${n} day${n === 1 ? '' : 's'} (${d}). Contact Smart Way to renew it so there is no gap.`}</span>`;
      document.getElementById('top').insertAdjacentElement('afterend', bar);
    }
    if (me.staff) fetch('/api/tickets?status=open').then((r) => (r.ok ? r.json() : null)).then((d) => {   // Smart Way support: how many tickets wait for an answer
      const n = d && d.tickets ? d.tickets.length : 0, a = document.querySelector('nav a[href="/help.html"]');
      if (n && a) a.insertAdjacentHTML('beforeend', ` <b style="display:inline-block;min-width:18px;padding:0 5px;margin-left:4px;border-radius:9px;background:var(--rec);color:#fff;font-size:11px;line-height:18px;text-align:center">${n > 99 ? '99+' : n}</b>`);
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
    const html = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const markSeen = (id, keepalive) => fetch('/api/updates/seen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }), keepalive: !!keepalive });
    const paintUpdates = (u) => {
      const a = document.querySelector('nav a[href="/updates.html"]');
      if (!a) return;
      a.querySelectorAll('.beat,.navcount').forEach((x) => x.remove());
      if (u && u.notice) a.insertAdjacentHTML('beforeend', `<span class="beat" title="A new camera update">${HEART}</span>`);
      else if (u && u.waiting > 0) a.insertAdjacentHTML('beforeend', `<span class="navcount" title="Cameras waiting for the docking station">${u.waiting > 99 ? '99+' : u.waiting}</span>`);
    };
    let shownId = null;
    const showNotice = (u) => {
      const n = u && u.notice;
      if (!n || shownId === n.id || document.querySelector('.vgmodal') || location.pathname === '/updates.html') return;
      shownId = n.id;
      const wait = u.waiting || 0, el = document.createElement('div');
      el.className = 'vgmodal'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', n.title);
      el.innerHTML = `<div class="box"><button class="x" data-a="close" aria-label="Close">&times;</button>
        <span class="beat big">${HEART}</span><h2>${html(n.title)}</h2><p>${html(n.body)}</p>
        ${n.bodyAr ? `<p class="ar" lang="ar">${html(n.bodyAr)}</p>` : ''}
        ${wait ? `<span class="wait">${wait} camera${wait === 1 ? '' : 's'} waiting for the docking station</span>` : ''}
        <div class="row"><button class="btn" data-a="close">Close</button><a class="btn pri" href="/updates.html" data-a="open">See my cameras</a></div></div>`;
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
