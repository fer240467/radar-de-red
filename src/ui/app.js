(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const ICON = { router: '📶', tv: '📺', stream: '📦', phone: '📱', pc: '💻', printer: '🖨️', console: '🎮', speaker: '🔊', camera: '📷', iot: '💡', vacuum: '🧹', network: '🔌', appliance: '🧺', unknown: '❔' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ----- memoria local (nombres propios e historial) -----
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } };
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* nada */ } };
  let names = load('radar-names', {});     // mac -> nombre puesto por el usuario
  let history = load('radar-history', {}); // mac -> último dato visto
  let last = null;

  let toastT;
  const toast = (m) => { const t = $('toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600); };

  function title(d) { return names[d.mac] || d.bestName || d.label; }

  function card(d, { isNew = false, offline = false } = {}) {
    const el = document.createElement('article');
    el.className = 'dev' + (isNew ? ' is-new' : '') + (offline ? ' off' : '');
    const tags = [];
    if (isNew) tags.push('<span class="tag new">NUEVO</span>');
    if (d.isSelf) tags.push('<span class="tag self">Esta PC</span>');
    if (d.random) tags.push('<span class="tag">MAC privada</span>');
    if (!offline) tags.push(`<span class="tag ${esc(d.confidence)}">${{ seguro: 'Identificado', probable: 'Probable', posible: 'Posible', desconocido: 'Sin identificar' }[d.confidence] || ''}</span>`);
    if (offline && d.lastSeen) tags.push(`<span class="tag">Visto: ${new Date(d.lastSeen).toLocaleString()}</span>`);
    const details = {
      'Nombre en el router': d.hostname, 'Nombre Windows': d.netbios, 'Nombre anunciado': (d.mdnsNames || []).join(', '),
      'Servicios': (d.services || []).join(', '), 'Ficha UPnP': d.ssdp && [d.ssdp.friendlyName, d.ssdp.deviceType, d.ssdp.server].filter(Boolean).join(' · '),
    };
    const detTxt = Object.entries(details).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n');
    el.innerHTML = `
      <div class="ico">${ICON[d.type] || ICON.unknown}</div>
      <div>
        <h3><span class="nm">${esc(title(d))}</span><button class="edit" title="Ponerle nombre">✏️</button></h3>
        <div class="what">${title(d) === d.label
          ? (d.model ? esc(d.model) : '<span style="color:var(--muted)">Tocá ✏️ para ponerle nombre</span>')
          : esc(d.label) + (d.model ? ' · ' + esc(d.model) : '')}</div>
        <div class="meta">
          ${d.vendor ? `Fabricante: ${esc(d.vendor)}<br>` : (d.random ? 'Fabricante: oculto (MAC privada)<br>' : '')}
          IP <code>${esc(d.ip)}</code> · MAC <code>${esc(d.mac)}</code>
        </div>
        <div class="tags">${tags.join('')}</div>
      </div>
      ${detTxt ? `<details><summary>Más detalles</summary><pre>${esc(detTxt)}</pre></details>` : ''}`;
    el.querySelector('.edit').onclick = () => {
      if (el.querySelector('.rename')) return;
      const box = document.createElement('div'); box.className = 'rename';
      box.innerHTML = `<input value="${esc(names[d.mac] || '')}" placeholder="Ej: Tele del living, Lavarropas…"><button class="primary">Guardar</button><button>Quitar</button>`;
      el.querySelector('.meta').after(box);
      const inp = box.querySelector('input'); inp.focus();
      const save = (v) => { if (v) names[d.mac] = v; else delete names[d.mac]; store('radar-names', names); render(); toast(v ? 'Nombre guardado' : 'Nombre quitado'); };
      box.querySelector('.primary').onclick = () => save(inp.value.trim());
      box.querySelectorAll('button')[1].onclick = () => save('');
      inp.onkeydown = (e) => { if (e.key === 'Enter') save(inp.value.trim()); if (e.key === 'Escape') render(); };
    };
    return el;
  }

  const ORDER = ['router', 'pc', 'phone', 'tv', 'stream', 'speaker', 'console', 'printer', 'camera', 'iot', 'vacuum', 'appliance', 'network', 'unknown'];
  const ipn = (ip) => ip.split('.').reduce((a, b) => a * 256 + +b, 0);

  function render() {
    if (!last) return;
    const q = $('filter').value.trim().toLowerCase();
    const sort = $('sort').value;
    let list = last.devices.slice();
    if (q) list = list.filter((d) => [title(d), d.label, d.vendor, d.model, d.ip, d.mac, d.hostname].join(' ').toLowerCase().includes(q));
    list.sort((a, b) => sort === 'type' ? ORDER.indexOf(a.type) - ORDER.indexOf(b.type) || ipn(a.ip) - ipn(b.ip)
      : sort === 'name' ? title(a).localeCompare(title(b)) : ipn(a.ip) - ipn(b.ip));
    const box = $('list'); box.innerHTML = '';
    if (!list.length) box.innerHTML = '<p class="empty">No hay equipos que coincidan.</p>';
    for (const d of list) box.appendChild(card(d, { isNew: last.newMacs.has(d.mac) }));

    const now = new Set(last.devices.map((d) => d.mac));
    const off = Object.values(history).filter((h) => !now.has(h.mac)).sort((a, b) => b.lastSeen - a.lastSeen);
    $('offlineBox').hidden = !off.length; $('offCount').textContent = off.length;
    const ob = $('offList'); ob.innerHTML = '';
    for (const h of off) ob.appendChild(card(h, { offline: true }));

    const unknown = last.devices.filter((d) => !names[d.mac] && (d.confidence === 'desconocido' || d.confidence === 'posible' || d.random)).length;
    $('sTotal').textContent = last.devices.length;
    $('sKnown').textContent = last.devices.length - unknown;
    $('sUnknown').textContent = unknown;
    $('sNew').textContent = last.newMacs.size;
  }

  async function doScan(silent = false) {
    $('btnScan').disabled = true;
    $('progress').hidden = false; $('bar').style.width = '0%';
    window.radar.onProgress(({ p, msg }) => { $('bar').style.width = p + '%'; $('progMsg').textContent = msg; });
    const r = await window.radar.scan();
    $('btnScan').disabled = false; $('progress').hidden = true;
    if (r.error) { toast(r.error); return; }

    const firstTime = Object.keys(history).length === 0;
    const newMacs = new Set();
    for (const d of r.devices) {
      if (!history[d.mac] && !firstTime) newMacs.add(d.mac);
      history[d.mac] = Object.assign({}, d, { lastSeen: r.time });
    }
    store('radar-history', history);
    last = Object.assign(r, { newMacs });
    $('netInfo').textContent = `Red ${r.net.ip.replace(/\.\d+$/, '.0')}/24 · router ${r.net.gateway || '?'} · ${new Date(r.time).toLocaleTimeString()}`;
    $('summary').hidden = false; $('tools').hidden = false;
    render();
    if (newMacs.size) {
      const lst = r.devices.filter((d) => newMacs.has(d.mac)).map((d) => `${d.label}${d.vendor ? ' (' + d.vendor.split(' ')[0] + ')' : ''}`).join(', ');
      window.radar.notify(`Radar de Red: ${newMacs.size} equipo(s) nuevo(s)`, lst);
      toast(`¡${newMacs.size} equipo(s) nuevo(s) en tu red!`);
    } else if (!silent) toast(`${r.devices.length} equipos encontrados`);
  }

  $('btnScan').onclick = () => doScan();
  $('filter').oninput = render;
  $('sort').onchange = render;
  let timer = null;
  $('watch').onchange = (e) => {
    clearInterval(timer);
    if (e.target.checked) { timer = setInterval(() => doScan(true), 5 * 60 * 1000); toast('Vigilando: escaneo cada 5 minutos'); }
    else toast('Vigilancia apagada');
  };
  // Primer escaneo automático al abrir
  setTimeout(() => doScan(), 300);
})();
