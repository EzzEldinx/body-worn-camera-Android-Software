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
      <a class="brand" href="/analytics.html"><img src="/logo.png" alt="Smart Way"><strong>VisionGuard</strong></a>
      <nav>
        ${link('/analytics.html', 'Analytics')}
        ${link('/', 'Live Dashboard')}
        ${me.super ? link('/admin.html', 'Companies') : ''}
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
    document.getElementById('themeBtn').onclick = () => {
      const n = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = n; try { localStorage.setItem('bwc-theme', n); } catch (e) { }
      window.dispatchEvent(new Event('themechange'));
    };
    document.getElementById('outBtn').onclick = () => fetch('/api/logout', { method: 'POST' }).then(() => { location.href = '/login.html'; });
    return me;
  }).catch(() => { location.href = '/login.html'; return new Promise(() => { }); });
})();
