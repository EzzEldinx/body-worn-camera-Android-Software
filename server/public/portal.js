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
        ${link('/reports.html', 'Reports')}
        ${link('/', 'Live Dashboard')}
        ${link('/docks.html', 'Docking')}
        ${link('/help.html', 'Support')}
        ${me.companyId && me.role === 'manager' ? link('/employees.html', 'Team') : ''}
        ${me.super ? link('/admin.html', 'Admin panel') + link('/license.html', 'License') + link('/updates.html', 'Updates') : ''}
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
    // licence notice under the header: expiring (administrators), expired, limited mode, trial running out
    if (me.company) { const sc = document.querySelector('.hdr-right .chip'); if (sc && me.subscription) sc.insertAdjacentHTML('afterend', `<span class="chip" title="Your subscription">Until ${new Date(me.subscription.end).toISOString().slice(0, 10)}</span>`); }
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
    document.getElementById('outBtn').onclick = () => fetch('/api/logout', { method: 'POST' }).then(() => { location.href = '/login.html'; });
    return me;
  }).catch(() => { location.href = '/login.html'; return new Promise(() => { }); });
})();
