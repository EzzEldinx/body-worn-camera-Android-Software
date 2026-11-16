/* Geofencing on the dashboard map: draw zones (circle / polygon), say what raises an alert, who it applies to and when. English + Arabic.
   Uses the page's own globals: map, cams, me, alerts, socket, esc, flash, currentLang, regionList, companyList. The rules live on the server (geofence.js there). */
(function () {
  'use strict';
  const L = (en, ar) => (currentLang === 'ar' ? ar : en);
  const KIND_COLOR = { allowed: '#00B87C', forbidden: '#FF3355', both: '#FFB300', checkpoint: '#2F7BFF', off: '#9AA8BD' };
  const DAYS = [[0, 'Sun', 'أحد'], [1, 'Mon', 'إثنين'], [2, 'Tue', 'ثلاثاء'], [3, 'Wed', 'أربعاء'], [4, 'Thu', 'خميس'], [5, 'Fri', 'جمعة'], [6, 'Sat', 'سبت']];
  const state = { zones: [], canEdit: false, history: [], panel: false, draw: null, ready: false, labels: new Map() };
  const $ = (s, r = document) => r.querySelector(s);
  const el = (html) => { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; };

  const typeOf = (z) => (z.kind === 'checkpoint' ? 'checkpoint' : z.onExit && z.onEnter ? 'both' : z.onEnter ? 'forbidden' : 'allowed');
  const colorOf = (z) => (z.active ? KIND_COLOR[typeOf(z)] : KIND_COLOR.off);
  const TYPE_TXT = {
    allowed: () => [L('Allowed area', 'منطقة مسموحة'), L('Alert when a camera leaves it', 'تنبيه عند خروج الكاميرا منها')],
    forbidden: () => [L('Forbidden area', 'منطقة ممنوعة'), L('Alert when a camera enters it', 'تنبيه عند دخول الكاميرا إليها')],
    both: () => [L('Both ways', 'الاتجاهان'), L('Alert on leaving and on entering', 'تنبيه عند الخروج وعند الدخول')],
    checkpoint: () => [L('Checkpoint', 'نقطة مرور'), L('A camera must pass by on a round', 'يجب أن تمر الكاميرا بها في الجولة')],
  };
  const hasZoneAlert = (z) => (typeof alerts !== 'undefined' ? alerts : []).some((a) => a.zoneId === z.id && !a.ack);

  /* ---------- geometry helpers ---------- */
  const mPerDegLat = 111320;
  const dist = (a, b) => { const dLat = (b.lat - a.lat) * mPerDegLat, dLng = (b.lng - a.lng) * mPerDegLat * Math.cos(a.lat * Math.PI / 180); return Math.hypot(dLat, dLng); };
  function ring(shape) {   // [[lng,lat],...] closed
    if (shape.type === 'polygon') { const r = shape.pts.map((p) => [p[1], p[0]]); r.push(r[0]); return r; }
    const pts = [];
    for (let i = 0; i <= 64; i++) { const a = i / 64 * 2 * Math.PI; pts.push([shape.lng + (shape.r * Math.cos(a)) / (mPerDegLat * Math.cos(shape.lat * Math.PI / 180)), shape.lat + (shape.r * Math.sin(a)) / mPerDegLat]); }
    return pts;
  }
  const centre = (shape) => (shape.type === 'circle' ? [shape.lng, shape.lat] : [shape.pts.reduce((s, p) => s + p[1], 0) / shape.pts.length, shape.pts.reduce((s, p) => s + p[0], 0) / shape.pts.length]);

  /* ---------- map layers ---------- */
  const empty = () => ({ type: 'FeatureCollection', features: [] });
  function whenMap(fn) { if (map.isStyleLoaded()) fn(); else map.once('load', fn); }
  function ensureLayers() {
    if (map.getSource('geozones')) return;
    map.addSource('geozones', { type: 'geojson', data: empty() });
    map.addLayer({ id: 'geo-fill', type: 'fill', source: 'geozones', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'fillOpacity'] } }, map.getLayer('acc-fill') ? 'acc-fill' : undefined);
    map.addLayer({ id: 'geo-line', type: 'line', source: 'geozones', paint: { 'line-color': ['get', 'color'], 'line-width': 2.2, 'line-opacity': 0.9 } }, map.getLayer('acc-fill') ? 'acc-fill' : undefined);
    map.addSource('geodraft', { type: 'geojson', data: empty() });
    map.addLayer({ id: 'geodraft-fill', type: 'fill', source: 'geodraft', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#FFB300', 'fill-opacity': 0.16 } });
    map.addLayer({ id: 'geodraft-line', type: 'line', source: 'geodraft', paint: { 'line-color': '#FFB300', 'line-width': 2.5, 'line-dasharray': [2, 1.5] } });
    map.addLayer({ id: 'geodraft-pts', type: 'circle', source: 'geodraft', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 5, 'circle-color': '#fff', 'circle-stroke-color': '#FFB300', 'circle-stroke-width': 2.5 } });
  }
  function drawZones() {
    whenMap(() => {
      ensureLayers();
      const feats = state.zones.map((z) => {
        const bad = hasZoneAlert(z);
        return { type: 'Feature', properties: { id: z.id, color: bad ? '#FF3355' : colorOf(z), fillOpacity: z.active ? (bad ? 0.26 : 0.14) : 0.06 }, geometry: { type: 'Polygon', coordinates: [ring(z.shape)] } };
      });
      map.getSource('geozones').setData({ type: 'FeatureCollection', features: feats });
      // a name on every zone
      const keep = new Set(state.zones.map((z) => z.id));
      for (const [id, m] of state.labels) if (!keep.has(id)) { m.remove(); state.labels.delete(id); }
      for (const z of state.zones) {
        let m = state.labels.get(z.id);
        if (!m) { m = new maplibregl.Marker({ element: document.createElement('div'), anchor: 'center' }).setLngLat(centre(z.shape)).addTo(map); state.labels.set(z.id, m); }
        m.setLngLat(centre(z.shape));
        const e = m.getElement(), bad = hasZoneAlert(z);
        e.classList.add('geo-lbl'); e.classList.toggle('bad', bad); e.style.background = bad ? '#FF3355' : colorOf(z); e.textContent = (z.kind === 'checkpoint' ? '⚑ ' : '') + z.name;
        e.style.pointerEvents = 'none';
      }
    });
  }
  function drawDraft() {
    const d = state.draw; if (!d || !map.getSource('geodraft')) return;
    const feats = [];
    if (d.mode === 'circle' && d.centre) {
      const r = d.r || 0;
      if (r > 0) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring({ type: 'circle', lat: d.centre.lat, lng: d.centre.lng, r })] } });
      feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [d.centre.lng, d.centre.lat] } });
    } else if (d.mode === 'polygon' && d.pts.length) {
      const c = d.pts.map((p) => [p[1], p[0]]);
      if (d.hover && !d.fixed) c.push([d.hover.lng, d.hover.lat]);
      if (c.length >= 3) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...c, c[0]]] } });
      else if (c.length === 2) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: c } });
      d.pts.forEach((p) => feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [p[1], p[0]] } }));
    }
    map.getSource('geodraft').setData({ type: 'FeatureCollection', features: feats });
  }

  /* ---------- data ---------- */
  async function load() {
    try {
      const r = await fetch('/api/geofences'); if (!r.ok) return;
      const j = await r.json(); state.zones = j.zones || []; state.canEdit = !!j.canEdit;
    } catch (e) { return; }
    drawZones(); renderPanel(); syncButton();
  }
  async function loadHistory() {
    try { const r = await fetch('/api/geofences/alerts?days=7'); if (r.ok) state.history = (await r.json()).alerts || []; } catch (e) { }
    renderPanel();
  }
  async function send(method, url, body) {
    try {
      const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const j = await r.json().catch(() => ({}));
      return r.ok ? { ok: true, ...j } : { ok: false, error: j.error || (r.status === 403 ? L('You are not allowed to do this.', 'ليس لديك صلاحية لذلك.') : L('Something went wrong. Try again.', 'حدث خطأ. حاول مرة أخرى.')) };
    } catch (e) { return { ok: false, error: L('No connection to the server.', 'لا يوجد اتصال بالخادم.') }; }
  }

  /* ---------- the button and the panel ---------- */
  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11a7 7 0 0114 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>';
  let btn, panel, bar, modal;
  function build() {
    const wrap = $('#mapwrap');
    btn = el(`<button class="geo-btn" id="geoBtn" type="button">${ICON}<span class="geo-t"></span><i class="geo-n"></i></button>`);
    panel = el('<div class="geo-panel" id="geoPanel"></div>');
    bar = el('<div class="geo-bar" id="geoBar"></div>');
    modal = el('<div class="geo-modal" id="geoModal"></div>');
    wrap.append(btn, panel, bar); document.body.appendChild(modal);
    btn.onclick = () => togglePanel();
    panel.addEventListener('click', onPanelClick);
    bar.addEventListener('click', onBarClick);
    document.querySelectorAll('.lang-btn').forEach((b) => b.addEventListener('click', () => setTimeout(refreshText, 30)));
    modal.addEventListener('mousedown', (e) => { if (e.target === modal && !state.busy) closeModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (modal.classList.contains('open')) closeModal(); else if (state.draw) cancelDraw(); } });
    refreshText();
  }
  function refreshText() {
    const rtl = currentLang === 'ar';
    $('.geo-t', btn).textContent = L('Geofences', 'النطاقات');
    panel.dir = rtl ? 'rtl' : 'ltr'; bar.dir = rtl ? 'rtl' : 'ltr';
    renderPanel(); renderBar(); syncButton();
  }
  function syncButton() {
    if (!btn) return;
    const open = (typeof alerts !== 'undefined' ? alerts : []).filter((a) => a.zoneId != null && !a.ack).length;
    btn.classList.toggle('alert', open > 0); $('.geo-n', btn).textContent = open;
    btn.classList.toggle('on', state.panel);
  }
  function togglePanel(force) {
    state.panel = force === undefined ? !state.panel : force;
    panel.classList.toggle('open', state.panel); syncButton();
    if (state.panel) { load(); loadHistory(); }
  }
  const IC_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg>';
  const IC_DEL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';
  const IC_EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  function whoTxt(z) {
    const s = z.scope;
    if (s.type === 'all') return L('All cameras', 'كل الكاميرات');
    const n = s.ids.length;
    return s.type === 'cameras' ? L(`${n} camera${n === 1 ? '' : 's'}`, `${n} كاميرا`) : s.type === 'groups' ? L(`Group: ${s.ids.join(', ')}`, `المجموعة: ${s.ids.join('، ')}`) : L(`Region: ${s.ids.join(', ')}`, `المنطقة: ${s.ids.join('، ')}`);
  }
  function whenTxt(z) {
    const all = z.days.length === 7, days = all ? L('every day', 'كل يوم') : DAYS.filter((d) => z.days.includes(d[0])).map((d) => L(d[1], d[2])).join(' ');
    return (z.from && z.to ? `${z.from}–${z.to} · ` : '') + days;
  }
  function zoneRow(z) {
    const [tt] = TYPE_TXT[typeOf(z)](), color = hasZoneAlert(z) ? '#FF3355' : colorOf(z);
    const rule = z.kind === 'checkpoint' ? L(`every ${z.everyMin} min`, `كل ${z.everyMin} دقيقة`) : tt;
    return `<div class="geo-z ${z.active ? '' : 'off'}" data-z="${z.id}"><span class="dot" style="background:${color}"></span><b>${esc(z.name)}</b>
      <span class="acts">${state.canEdit ? `<button class="geo-ic" data-act="edit" title="${L('Edit', 'تعديل')}">${IC_EDIT}</button><button class="geo-ic" data-act="del" title="${L('Delete', 'حذف')}">${IC_DEL}</button>` : `<button class="geo-ic" data-act="show" title="${L('Show on the map', 'عرض على الخريطة')}">${IC_EYE}</button>`}</span>
      <small>${esc(rule)} · ${esc(whoTxt(z))}<br>${esc(whenTxt(z))}${z.active ? '' : ' · ' + L('switched off', 'متوقفة')}</small></div>`;
  }
  const evText = (a) => {
    const cam = (typeof cams !== 'undefined' && cams.get(a.cameraId)), who = esc(cam?.name || a.cameraId);
    const t = a.kind === 'geo_exit' ? L('left', 'غادرت') : a.kind === 'geo_enter' ? L('entered', 'دخلت') : L('missed checkpoint', 'فاتتها نقطة المرور');
    return a.kind === 'checkpoint_missed' ? `${who} ${t} “${esc(a.zone)}”` : `${who} ${t} “${esc(a.zone)}”`;
  };
  function renderPanel() {
    if (!panel) return;
    const rows = state.zones.map(zoneRow).join('');
    const ev = state.history.slice(0, 15).map((a) => `<div class="geo-ev ${a.resolvedTs ? '' : 'open'}" data-cam="${esc(a.cameraId)}">${evText(a)}<small>${new Date(a.ts).toLocaleString()} · ${a.resolvedTs ? L('back in line', 'عادت للوضع الطبيعي') : a.ack ? L('acknowledged', 'تم الإقرار') : L('open', 'مفتوح')}</small></div>`).join('');
    panel.innerHTML = `<div class="geo-h"><b>${L('Geofences', 'النطاقات الجغرافية')}</b><button class="geo-x" data-act="close" aria-label="${L('Close', 'إغلاق')}">×</button></div>
      <div class="geo-body">${state.canEdit ? `<button class="btn pri geo-new" data-act="new">+ ${L('New zone', 'منطقة جديدة')}</button>` : ''}
      ${rows || `<div class="geo-empty">${state.canEdit ? L('No zones yet. Draw an area on the map to get an alert when a camera leaves it, enters it, or does not pass by.', 'لا توجد مناطق بعد. ارسم منطقة على الخريطة لتصلك تنبيهات عند خروج الكاميرا منها أو دخولها أو عدم مرورها.') : L('No zones have been set up for your company.', 'لم يتم إعداد مناطق لشركتك.')}</div>`}
      ${ev ? `<div class="geo-sec">${L('Recent alerts (7 days)', 'آخر التنبيهات (٧ أيام)')}</div>${ev}` : ''}</div>`;
  }
  function onPanelClick(e) {
    const act = e.target.closest('[data-act]')?.dataset.act, row = e.target.closest('.geo-z'), z = row && state.zones.find((x) => x.id === +row.dataset.z);
    if (act === 'close') return togglePanel(false);
    if (act === 'new') return startDraw(null);
    if (act === 'edit' && z) return openForm(z);
    if (act === 'del' && z) return confirmDelete(z);
    if (z) { const c = centre(z.shape); const b = new maplibregl.LngLatBounds(); ring(z.shape).forEach((p) => b.extend(p)); map.fitBounds(b, { padding: 80, maxZoom: 17, duration: 600 }); return; }
    const ev = e.target.closest('.geo-ev'); if (ev && typeof select === 'function') select(ev.dataset.cam, true);
  }
  async function confirmDelete(z) {
    if (!confirm(L(`Delete the zone “${z.name}”? Alerts about it will be closed.`, `حذف المنطقة «${z.name}»؟ ستُغلق التنبيهات الخاصة بها.`))) return;
    const r = await send('DELETE', '/api/geofences/' + z.id);
    flash(r.ok ? L('Zone deleted.', 'تم حذف المنطقة.') : r.error);
    if (r.ok) load();
  }

  /* ---------- drawing ---------- */
  function startDraw(prev) {   // prev = { zone, form } when redrawing the shape of a zone being edited
    closeModal(); togglePanel(false);
    state.draw = { mode: 'circle', centre: null, r: 0, pts: [], hover: null, prev, fixed: false };
    document.body.classList.add('geo-drawing'); bar.classList.add('open');
    try { map.doubleClickZoom.disable(); } catch (e) { }
    whenMap(() => { ensureLayers(); drawDraft(); });
    renderBar();
  }
  function renderBar() {
    if (!bar) return;
    const d = state.draw; if (!d) { bar.classList.remove('open'); return; }
    const help = d.mode === 'circle'
      ? (d.centre ? L('Move the mouse to set the size, then click to finish.', 'حرّك الماوس لضبط الحجم ثم اضغط للإنهاء.') : L('Click the centre of the zone.', 'اضغط على مركز المنطقة.'))
      : L('Click each corner. Finish when the shape is closed.', 'اضغط على كل زاوية ثم اضغط إنهاء عند اكتمال الشكل.');
    bar.innerHTML = `<div class="seg"><button data-m="circle" class="${d.mode === 'circle' ? 'on' : ''}">${L('Circle', 'دائرة')}</button><button data-m="polygon" class="${d.mode === 'polygon' ? 'on' : ''}">${L('Polygon', 'مضلع')}</button></div>
      <span>${help}</span>
      ${d.mode === 'polygon' ? `<button class="btn" data-a="undo" ${d.pts.length ? '' : 'disabled'}>${L('Undo', 'تراجع')}</button><button class="btn pri" data-a="finish" ${d.pts.length >= 3 ? '' : 'disabled'}>${L('Finish', 'إنهاء')}</button>` : ''}
      <button class="btn" data-a="cancel">${L('Cancel', 'إلغاء')}</button>`;
  }
  function onBarClick(e) {
    const d = state.draw; if (!d) return;
    const m = e.target.closest('[data-m]')?.dataset.m, a = e.target.closest('[data-a]')?.dataset.a;
    if (m && m !== d.mode) { d.mode = m; d.centre = null; d.r = 0; d.pts = []; drawDraft(); renderBar(); }
    if (a === 'cancel') cancelDraw();
    if (a === 'undo') { d.pts.pop(); drawDraft(); renderBar(); }
    if (a === 'finish') finishDraw();
  }
  function endDraw() {
    state.draw = null; document.body.classList.remove('geo-drawing'); bar.classList.remove('open');
    try { map.doubleClickZoom.enable(); } catch (e) { }
    map.getSource('geodraft')?.setData(empty());
  }
  function cancelDraw() { const p = state.draw?.prev; endDraw(); if (p?.zone) openForm(p.zone, p.form); else togglePanel(true); }
  function finishDraw() {
    const d = state.draw; if (!d) return;
    let shape;
    if (d.mode === 'circle') { if (!d.centre || d.r < 10) { flash(L('Click the centre, then move out and click again.', 'اضغط على المركز ثم ابتعد واضغط مرة أخرى.')); return; } shape = { type: 'circle', lat: d.centre.lat, lng: d.centre.lng, r: Math.max(10, Math.round(d.r)) }; }
    else { if (d.pts.length < 3) return; shape = { type: 'polygon', pts: d.pts.slice() }; }
    const prev = d.prev; endDraw();
    openForm(prev?.zone || null, prev?.form, shape);
  }
  function onMapClick(e) {
    const d = state.draw; if (!d) return;
    const p = { lat: e.lngLat.lat, lng: e.lngLat.lng };
    if (d.mode === 'circle') {
      if (!d.centre) { d.centre = p; d.r = 0; drawDraft(); renderBar(); } else { d.r = dist(d.centre, p); finishDraw(); }
    } else {
      const first = d.pts[0];
      if (first && d.pts.length >= 3 && Math.hypot(map.project([first[1], first[0]]).x - e.point.x, map.project([first[1], first[0]]).y - e.point.y) < 12) return finishDraw();
      d.pts.push([p.lat, p.lng]); if (d.pts.length > 100) d.pts.pop();
      drawDraft(); renderBar();
    }
  }
  function onMapMove(e) {
    const d = state.draw; if (!d) return;
    if (d.mode === 'circle' && d.centre) { d.r = dist(d.centre, { lat: e.lngLat.lat, lng: e.lngLat.lng }); drawDraft(); }
    else if (d.mode === 'polygon') { d.hover = { lat: e.lngLat.lat, lng: e.lngLat.lng }; drawDraft(); }
  }
  function onMapDbl(e) { const d = state.draw; if (d && d.mode === 'polygon' && d.pts.length >= 3) { e.preventDefault(); d.pts.pop(); finishDraw(); } }

  /* ---------- the form ---------- */
  const draftOf = (z) => ({
    name: z?.name || '', type: z ? typeOf(z) : 'allowed', everyMin: z?.everyMin || 30, severity: z?.severity || 'warning', active: z ? z.active : true,
    scopeType: z?.scope.type || 'all', scopeIds: z?.scope.ids ? [...z.scope.ids] : [], allDay: z ? !(z.from && z.to) && z.days.length === 7 : true,
    days: z ? [...z.days] : [0, 1, 2, 3, 4, 5, 6], from: z?.from || '08:00', to: z?.to || '18:00', companyId: z ? z.companyId : (me.staff ? undefined : me.companyId),
  });
  function openForm(zone, form, shape) {
    state.form = { zone, f: form || draftOf(zone), shape: shape || zone?.shape };
    renderForm(); modal.classList.add('open');
    if (me.super && !zone) fetch('/api/admin/companies').then((r) => r.json()).then((d) => {   // companies made since the page opened
      if (!Array.isArray(d.companies) || !state.form || state.form.zone) return;
      companyList = d.companies; read(); renderForm();
    }).catch(() => { });
  }
  function closeModal() { modal.classList.remove('open'); state.form = null; state.busy = false; }
  const typeCard = (k, on) => { const [t, d] = TYPE_TXT[k](); return `<button type="button" class="geo-type ${on ? 'on' : ''}" data-type="${k}"><b><i style="background:${KIND_COLOR[k]}"></i>${t}</b><small>${d}</small></button>`; };
  function scopeOptions(f) {
    const mine = [...cams.values()].filter((c) => f.companyId === undefined || f.companyId === null ? true : c.companyId === f.companyId);
    if (f.scopeType === 'cameras') return mine.sort((a, b) => String(a.name).localeCompare(String(b.name))).map((c) => [c.cameraId, c.name || c.cameraId]);
    if (f.scopeType === 'groups') return [...new Set(mine.map((c) => c.grp).filter(Boolean))].sort().map((g) => [g, g]);
    if (f.scopeType === 'regions') return [...new Set([...(typeof regionList !== 'undefined' ? regionList : []), ...mine.map((c) => c.region).filter(Boolean)])].sort().map((g) => [g, g]);
    return [];
  }
  function renderForm() {
    const { zone, f, shape } = state.form;
    const staffPick = me.staff && !zone;
    const companies = typeof companyList !== 'undefined' ? companyList : [];
    const opts = scopeOptions(f);
    const pick = f.scopeType === 'all' ? '' : opts.length
      ? `<div class="geo-pick">${opts.map(([v, n]) => `<label><input type="checkbox" data-sc="${esc(v)}" ${f.scopeIds.includes(v) ? 'checked' : ''}> ${esc(n)}</label>`).join('')}</div>`
      : `<div class="geo-hint">${L('Nothing to choose from yet.', 'لا يوجد ما يمكن اختياره بعد.')}</div>`;
    modal.innerHTML = `<div class="geo-card" role="dialog" aria-modal="true" dir="${currentLang === 'ar' ? 'rtl' : 'ltr'}">
      <h3>${zone ? L('Edit zone', 'تعديل المنطقة') : L('New zone', 'منطقة جديدة')}</h3>
      <div class="gf"><label class="l">${L('Name', 'الاسم')}</label><input class="in" id="gfName" maxlength="60" style="margin-top:0" value="${esc(f.name)}" placeholder="${L('e.g. Main gate', 'مثال: البوابة الرئيسية')}"></div>
      ${staffPick ? `<div class="gf"><label class="l">${L('Company', 'الشركة')}</label><select class="in" id="gfCo" style="margin-top:0"><option value="">${L('Smart Way (no company)', 'سمارت واي (بدون شركة)')}</option>${companies.map((c) => `<option value="${c.id}" ${f.companyId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>` : ''}
      <div class="gf"><label class="l">${L('What should raise an alert?', 'ما الذي يسبب التنبيه؟')}</label><div class="geo-types">${['allowed', 'forbidden', 'both', 'checkpoint'].map((k) => typeCard(k, f.type === k)).join('')}</div></div>
      ${f.type === 'checkpoint' ? `<div class="gf"><label class="l">${L('A camera must pass by at least every', 'يجب أن تمر الكاميرا على الأقل كل')}</label><div class="geo-row"><input class="in" id="gfEvery" type="number" min="5" max="720" step="5" style="margin-top:0;width:110px" value="${f.everyMin}"> <span>${L('minutes', 'دقيقة')}</span></div><div class="geo-hint">${L('Counted only while the schedule below is on and the camera is online.', 'يُحسب فقط أثناء الجدول أدناه وعندما تكون الكاميرا متصلة.')}</div></div>` : ''}
      ${shape?.type === 'circle' ? `<div class="gf"><label class="l">${L('Radius (metres)', 'نصف القطر (متر)')}</label><input class="in" id="gfR" type="number" min="10" max="50000" step="5" style="margin-top:0;width:140px" value="${shape.r}"></div>` : `<div class="gf"><div class="geo-hint">${L(`Polygon with ${shape?.pts.length || 0} corners.`, `مضلع بـ ${shape?.pts.length || 0} زوايا.`)}</div></div>`}
      <div class="gf"><label class="l">${L('Urgency', 'الأهمية')}</label><div class="geo-row"><div class="geo-days" id="gfSev"><button type="button" data-sev="warning" class="${f.severity === 'warning' ? 'on' : ''}" style="width:auto;padding:0 14px">${L('Normal', 'عادي')}</button><button type="button" data-sev="critical" class="${f.severity === 'critical' ? 'on' : ''}" style="width:auto;padding:0 14px">${L('Urgent (red)', 'عاجل (أحمر)')}</button></div></div></div>
      <div class="gf"><label class="l">${L('Which cameras', 'أي الكاميرات')}</label><select class="in" id="gfScope" style="margin-top:0;margin-bottom:8px"><option value="all" ${f.scopeType === 'all' ? 'selected' : ''}>${L('All cameras of the company', 'كل كاميرات الشركة')}</option><option value="cameras" ${f.scopeType === 'cameras' ? 'selected' : ''}>${L('Chosen cameras', 'كاميرات محددة')}</option><option value="groups" ${f.scopeType === 'groups' ? 'selected' : ''}>${L('Groups', 'مجموعات')}</option><option value="regions" ${f.scopeType === 'regions' ? 'selected' : ''}>${L('Regions', 'مناطق')}</option></select>${pick}</div>
      <div class="gf"><label class="l">${L('When', 'متى')}</label>
        <label style="display:flex;gap:8px;align-items:center;font-size:13px;cursor:pointer"><input type="checkbox" id="gfAll" ${f.allDay ? 'checked' : ''}> ${L('All day, every day', 'طوال اليوم، كل يوم')}</label>
        ${f.allDay ? '' : `<div class="geo-days" id="gfDays" style="margin:8px 0">${DAYS.map((d) => `<button type="button" data-d="${d[0]}" class="${f.days.includes(d[0]) ? 'on' : ''}">${L(d[1], d[2])}</button>`).join('')}</div>
        <div class="geo-row"><span>${L('From', 'من')}</span><input class="in" id="gfFrom" type="time" style="margin-top:0;width:130px" value="${f.from}"><span>${L('to', 'إلى')}</span><input class="in" id="gfTo" type="time" style="margin-top:0;width:130px" value="${f.to}"></div>
        <div class="geo-hint">${L('A window that ends before it starts (22:00 to 06:00) runs overnight.', 'إذا كانت النهاية قبل البداية (٢٢:٠٠ إلى ٠٦:٠٠) فالفترة تمتد لليوم التالي.')}</div>`}
      </div>
      ${zone ? `<div class="gf"><label style="display:flex;gap:8px;align-items:center;font-size:13px;cursor:pointer"><input type="checkbox" id="gfActive" ${f.active ? 'checked' : ''}> ${L('Zone is switched on', 'المنطقة مفعّلة')}</label></div>` : ''}
      <div class="geo-err" id="gfErr"></div>
      <div class="geo-foot">${zone ? `<button class="btn" data-a="redraw" style="flex:none">${L('Redraw the shape', 'إعادة رسم الشكل')}</button>` : ''}<span style="flex:1"></span><button class="btn" data-a="cancel" style="flex:none">${L('Cancel', 'إلغاء')}</button><button class="btn pri" data-a="save" style="flex:none">${L('Save', 'حفظ')}</button></div></div>`;
    modal.querySelector('.geo-card').onclick = onFormClick;
    modal.querySelector('#gfScope').onchange = (e) => { read(); state.form.f.scopeType = e.target.value; state.form.f.scopeIds = []; renderForm(); };
    modal.querySelector('#gfAll').onchange = (e) => { read(); state.form.f.allDay = e.target.checked; renderForm(); };
    const co = modal.querySelector('#gfCo'); if (co) co.onchange = () => { read(); state.form.f.scopeIds = []; renderForm(); };
    (modal.querySelector('#gfName') || {}).onkeydown = (e) => { if (e.key === 'Enter') save(); };
  }
  function read() {   // the fields -> state.form.f (called before a redraw and before saving)
    const { f } = state.form, g = (id) => modal.querySelector(id);
    f.name = g('#gfName')?.value ?? f.name;
    if (g('#gfEvery')) f.everyMin = Number(g('#gfEvery').value);
    if (g('#gfR') && state.form.shape?.type === 'circle') state.form.shape = { ...state.form.shape, r: Number(g('#gfR').value) };
    if (g('#gfCo')) f.companyId = g('#gfCo').value === '' ? null : Number(g('#gfCo').value);
    f.scopeIds = [...modal.querySelectorAll('[data-sc]')].filter((x) => x.checked).map((x) => x.dataset.sc);
    if (g('#gfFrom')) { f.from = g('#gfFrom').value; f.to = g('#gfTo').value; }
    if (g('#gfActive')) f.active = g('#gfActive').checked;
  }
  function onFormClick(e) {
    const f = state.form?.f; if (!f) return;
    const type = e.target.closest('[data-type]')?.dataset.type, sev = e.target.closest('[data-sev]')?.dataset.sev, day = e.target.closest('[data-d]')?.dataset.d, a = e.target.closest('[data-a]')?.dataset.a;
    if (type) { read(); f.type = type; renderForm(); }
    else if (sev) { read(); f.severity = sev; renderForm(); }
    else if (day !== undefined) { read(); const d = +day; f.days = f.days.includes(d) ? f.days.filter((x) => x !== d) : [...f.days, d]; renderForm(); }
    else if (a === 'cancel') closeModal();
    else if (a === 'save') save();
    else if (a === 'redraw') { read(); const zone = state.form.zone, form = state.form.f; startDraw({ zone, form }); }
  }
  async function save() {
    if (state.busy) return;
    read();
    const { zone, f, shape } = state.form, err = modal.querySelector('#gfErr');
    const body = {
      name: f.name, kind: f.type === 'checkpoint' ? 'checkpoint' : 'zone', shape,
      onExit: f.type === 'allowed' || f.type === 'both', onEnter: f.type === 'forbidden' || f.type === 'both', everyMin: f.type === 'checkpoint' ? f.everyMin : undefined,
      severity: f.severity, scope: { type: f.scopeType, ids: f.scopeIds },
      days: f.allDay ? [0, 1, 2, 3, 4, 5, 6] : f.days, from: f.allDay ? null : f.from, to: f.allDay ? null : f.to, active: f.active,
    };
    if (!zone) { body.tz = -new Date().getTimezoneOffset(); if (me.staff && f.companyId !== undefined && f.companyId !== null) body.companyId = f.companyId; }
    state.busy = true; const sb = modal.querySelector('[data-a="save"]'); if (sb) sb.disabled = true;
    const r = await send(zone ? 'PUT' : 'POST', zone ? '/api/geofences/' + zone.id : '/api/geofences', body);
    state.busy = false;
    if (!r.ok) { if (sb) sb.disabled = false; err.textContent = r.error; err.classList.add('on'); return; }
    closeModal(); flash(zone ? L('Zone saved.', 'تم حفظ المنطقة.') : L('Zone created.', 'تم إنشاء المنطقة.'));
    await load(); togglePanel(true);
  }

  /* ---------- start ---------- */
  function init() {
    if (state.ready) return;
    if (!(me.features || []).includes('geofence')) return;
    state.ready = true;
    build();
    map.on('click', onMapClick); map.on('mousemove', onMapMove); map.on('dblclick', onMapDbl);
    if (typeof socket !== 'undefined') socket.on('geofences_changed', () => { load(); if (state.panel) loadHistory(); });
    load();
  }
  window.geoInit = init;
  window.geoAlertsChanged = () => { if (!state.ready) return; syncButton(); drawZones(); if (state.panel) renderPanel(); };
  if (typeof me !== 'undefined' && me.features) init();
})();
