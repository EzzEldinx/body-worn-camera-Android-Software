/* Shared header + session for portal pages. Pages await `portalReady` to get the signed-in user. */
(function () {
  try { document.documentElement.dataset.theme = localStorage.getItem('bwc-theme') || 'light'; } catch (e) { document.documentElement.dataset.theme = 'light'; }

  window.toast = (msg) => {
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.remove(), 2600);
  };

  window.portalReady = fetch('/api/me').then((r) => (r.ok ? r.json() : Promise.reject())).then((me) => {
    const here = location.pathname;
    const link = (href, label) => `<a href="${href}" class="${here === href ? 'on' : ''}">${label}</a>`;
    document.getElementById('top').innerHTML = `
      <a class="brand" href="/analytics.html"><span class="brand-text"><img class="vg-logo logo-light" src="/brand/visionguard-logo-sm.png" alt="VisionGuard"><img class="vg-logo logo-dark" src="/brand/visionguard-logo-light.png" alt="VisionGuard"><small class="pw">Powered by <img class="logo-light" src="/logo-light.png" alt="Smart Way"><img class="logo-dark" src="/logo-dark.png" alt="Smart Way"></small></span></a>
      <nav>
        ${link('/analytics.html', 'Analytics')}
        ${link('/', 'Live Dashboard')}
        ${link('/docks.html', 'Docking')}
        ${link('/help.html', 'Support')}
        ${me.super ? link('/admin.html', 'Companies') + link('/updates.html', 'Updates') : ''}
      </nav>
      <div class="hdr-right">
        ${me.company ? `<span class="chip">${me.company.replace(/[<>&]/g, '')}</span>` : '<span class="chip">Smart Way Group</span>'}
        <span class="who">${me.name.replace(/[<>&]/g, '')}</span>
        <button class="icon-btn" id="themeBtn" title="Toggle theme" aria-label="Toggle theme">
          <svg class="ico-moon" viewBox="0 0 24 24" fill="currentColor"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></svg>
          <svg class="ico-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
        </button>
        <button class="btn sm" id="outBtn">Sign out</button>
      </div>`;
    if (me.staff) fetch('/api/tickets?status=open').then((r) => (r.ok ? r.json() : null)).then((d) => {   // Smart Way support: how many tickets wait for an answer
      const n = d && d.tickets ? d.tickets.length : 0, a = document.querySelector('nav a[href="/help.html"]');
      if (n && a) a.insertAdjacentHTML('beforeend', ` <b style="display:inline-block;min-width:18px;padding:0 5px;margin-left:4px;border-radius:9px;background:var(--rec);color:#fff;font-size:11px;line-height:18px;text-align:center">${n > 99 ? '99+' : n}</b>`);
    }).catch(() => {});
    document.getElementById('themeBtn').onclick = () => {
      const n = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = n; try { localStorage.setItem('bwc-theme', n); } catch (e) { }
      window.dispatchEvent(new Event('themechange'));
    };
    document.getElementById('outBtn').onclick = () => fetch('/api/logout', { method: 'POST' }).then(() => { location.href = '/login.html'; });
    return me;
  }).catch(() => { location.href = '/login.html'; return new Promise(() => { }); });
})();
