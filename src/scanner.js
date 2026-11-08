/*
 * Radar de Red — motor de escaneo (solo lectura, solo la red local propia).
 * Técnicas: barrido + tabla ARP, fabricante por MAC (OUI), DNS inverso del router,
 * NetBIOS (nombres de Windows), mDNS/Bonjour (servicios) y SSDP/UPnP (modelo).
 */
'use strict';
const os = require('os');
const dgram = require('dgram');
const dns = require('dns');
const http = require('http');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

let OUI = null;
function loadOui() {
  if (!OUI) OUI = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'oui.json'), 'utf8'));
  return OUI;
}

// ---------- utilidades ----------
const ip2n = (ip) => ip.split('.').reduce((a, b) => (a << 8) + (+b), 0) >>> 0;
const n2ip = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
const normMac = (m) => m.replace(/-/g, ':').toUpperCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) => new Promise((res) => execFile(cmd, args, { windowsHide: true, encoding: 'latin1', timeout: 15000 }, (e, out) => res(out || '')));

/** Fabricante a partir de la MAC. */
function vendorOf(mac) {
  const hex = mac.replace(/:/g, '').toUpperCase();
  const db = loadOui();
  for (const [pref, bits, name] of db.longer) {
    if (hex.startsWith(pref) && bits > 24) return name;
  }
  return db.p24[hex.slice(0, 6)] || null;
}
/** MAC aleatoria/privada (bit "administrada localmente"). */
const isRandomMac = (mac) => (parseInt(mac.slice(0, 2), 16) & 0x02) !== 0;

// ---------- interfaz y puerta de enlace ----------
function localNet() {
  const ifs = os.networkInterfaces();
  const cands = [];
  for (const [name, list] of Object.entries(ifs)) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^169\.254\./.test(a.address)) continue;
      if (/vEthernet|VirtualBox|VMware|Hyper-V|Loopback|WSL/i.test(name)) continue;
      cands.push({ name, ip: a.address, mask: a.netmask, mac: normMac(a.mac) });
    }
  }
  // Preferir redes privadas típicas
  cands.sort((x, y) => (/^192\.168\./.test(y.ip) ? 1 : 0) - (/^192\.168\./.test(x.ip) ? 1 : 0));
  return cands[0] || null;
}

async function gateway() {
  const out = await run('route', ['print', '-4', '0.0.0.0']);
  const m = out.match(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/m);
  return m ? m[1] : null;
}

function hostsOf(net) {
  const ipn = ip2n(net.ip);
  let maskn = ip2n(net.mask);
  // Limitar a /24 como máximo (redes domésticas); evita barridos enormes.
  if (maskn < ip2n('255.255.255.0')) maskn = ip2n('255.255.255.0');
  const base = ipn & maskn;
  const bcast = base | (~maskn >>> 0);
  const out = [];
  for (let n = base + 1; n < bcast; n++) out.push(n2ip(n >>> 0));
  return out;
}

// ---------- NetBIOS (nombre de equipos Windows / NAS) ----------
function nbstatPacket(id) {
  const b = Buffer.alloc(50);
  b.writeUInt16BE(id, 0); b.writeUInt16BE(0, 2); b.writeUInt16BE(1, 4);
  b[12] = 0x20;
  const name = '*' + '\0'.repeat(15);
  for (let i = 0; i < 16; i++) {
    const c = name.charCodeAt(i);
    b[13 + i * 2] = 0x41 + (c >> 4);
    b[14 + i * 2] = 0x41 + (c & 0x0f);
  }
  b[45] = 0; b.writeUInt16BE(0x21, 46); b.writeUInt16BE(1, 48);
  return b;
}
function parseNbstat(msg) {
  try {
    let off = 12; // salta cabecera
    while (msg[off] !== 0) off += msg[off] + 1; // nombre
    off += 1 + 2 + 2 + 4 + 2; // fin nombre, tipo, clase, ttl, rdlength
    const n = msg[off]; off++;
    const names = [];
    for (let i = 0; i < n; i++) {
      const nm = msg.slice(off, off + 15).toString('latin1').trim();
      const suffix = msg[off + 15]; const flags = msg.readUInt16BE(off + 16);
      names.push({ nm, suffix, group: !!(flags & 0x8000) });
      off += 18;
    }
    const ws = names.find((x) => x.suffix === 0 && !x.group) || names.find((x) => !x.group);
    return ws ? ws.nm : null;
  } catch (e) { return null; }
}

// ---------- DNS mínimo (para mDNS) ----------
function readName(buf, off, depth = 0) {
  const labels = []; let jumped = false; let end = off;
  while (depth < 20) {
    const len = buf[off];
    if (len === undefined) break;
    if (len === 0) { off++; if (!jumped) end = off; break; }
    if ((len & 0xc0) === 0xc0) {
      const ptr = ((len & 0x3f) << 8) | buf[off + 1];
      if (!jumped) end = off + 2;
      jumped = true; off = ptr; depth++; continue;
    }
    labels.push(buf.slice(off + 1, off + 1 + len).toString('utf8'));
    off += len + 1;
  }
  return { name: labels.join('.'), end: jumped ? end : off };
}
function parseDns(buf) {
  const recs = [];
  const qd = buf.readUInt16BE(4), an = buf.readUInt16BE(6), ns = buf.readUInt16BE(8), ar = buf.readUInt16BE(10);
  let off = 12;
  for (let i = 0; i < qd; i++) { off = readName(buf, off).end + 4; }
  for (let i = 0; i < an + ns + ar; i++) {
    const { name, end } = readName(buf, off); off = end;
    const type = buf.readUInt16BE(off); const rdlen = buf.readUInt16BE(off + 8); off += 10;
    const rd = buf.slice(off, off + rdlen);
    const r = { name, type };
    if (type === 12) r.ptr = readName(buf, off).name;
    else if (type === 16) {
      r.txt = []; let p = 0;
      while (p < rd.length) { const l = rd[p]; r.txt.push(rd.slice(p + 1, p + 1 + l).toString('utf8')); p += l + 1; }
    } else if (type === 1 && rdlen === 4) r.a = [...rd].join('.');
    else if (type === 33) r.target = readName(buf, off + 6).name;
    recs.push(r); off += rdlen;
  }
  return recs;
}
function dnsQuery(names, type = 12) {
  const parts = [Buffer.from([0, 0, 0, 0, 0, names.length >> 8, names.length & 255, 0, 0, 0, 0, 0, 0])];
  parts[0] = Buffer.alloc(12); parts[0].writeUInt16BE(names.length, 4);
  for (const n of names) {
    for (const lab of n.split('.')) { parts.push(Buffer.from([lab.length])); parts.push(Buffer.from(lab)); }
    const t = Buffer.alloc(5); t[0] = 0; t.writeUInt16BE(type, 1); t.writeUInt16BE(0x8001, 3); // QU
    parts.push(t);
  }
  return Buffer.concat(parts);
}

const MDNS_TYPES = [
  '_services._dns-sd._udp.local', '_googlecast._tcp.local', '_airplay._tcp.local', '_raop._tcp.local',
  '_ipp._tcp.local', '_printer._tcp.local', '_pdl-datastream._tcp.local', '_spotify-connect._tcp.local',
  '_hap._tcp.local', '_companion-link._tcp.local', '_device-info._tcp.local', '_androidtvremote2._tcp.local',
  '_amzn-wplay._tcp.local', '_smb._tcp.local', '_workstation._tcp.local', '_http._tcp.local',
  '_sonos._tcp.local', '_matter._tcp.local', '_esphomelib._tcp.local', '_mediaremotetv._tcp.local',
];

function mdnsScan(ms) {
  return new Promise((resolve) => {
    const byIp = {};
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const add = (ip, k, v) => { (byIp[ip] = byIp[ip] || { services: new Set(), names: new Set(), txt: [] }); if (k === 'svc') byIp[ip].services.add(v); else if (k === 'name') byIp[ip].names.add(v); else byIp[ip].txt.push(...v); };
    sock.on('message', (msg, rinfo) => {
      try {
        for (const r of parseDns(msg)) {
          if (r.type === 12 && r.name.startsWith('_')) {
            const svc = r.name.replace(/\.local$/, '');
            if (svc !== '_services._dns-sd._udp') add(rinfo.address, 'svc', svc);
            const inst = (r.ptr || '').split('._')[0];
            if (inst && !inst.startsWith('_')) add(rinfo.address, 'name', inst);
          }
          if (r.type === 16 && r.txt) add(rinfo.address, 'txt', r.txt);
          if (r.type === 1 && r.name.endsWith('.local')) add(r.a || rinfo.address, 'name', r.name.replace(/\.local$/, ''));
        }
      } catch (e) { /* paquete raro */ }
    });
    sock.on('error', () => {});
    sock.bind(0, () => {
      try { sock.setMulticastTTL(255); } catch (e) { /* nada */ }
      const q = dnsQuery(MDNS_TYPES);
      sock.send(q, 5353, '224.0.0.251');
      setTimeout(() => sock.send(q, 5353, '224.0.0.251'), 700);
    });
    setTimeout(() => { try { sock.close(); } catch (e) { /* nada */ } resolve(byIp); }, ms);
  });
}

// ---------- SSDP / UPnP ----------
function httpGet(url, ms = 2500) {
  return new Promise((res) => {
    try {
      const req = http.get(url, { timeout: ms }, (r) => {
        let d = ''; r.setEncoding('utf8');
        r.on('data', (c) => { d += c; if (d.length > 200000) req.destroy(); });
        r.on('end', () => res(d));
      });
      req.on('timeout', () => { req.destroy(); res(''); });
      req.on('error', () => res(''));
    } catch (e) { res(''); }
  });
}
/** Decodifica entidades HTML (&quot; &amp; &#39;…) que algunos equipos mandan en sus nombres. */
const unent = (s) => (s == null ? s : String(s).replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&'));
const xmlTag = (x, t) => { const m = x.match(new RegExp(`<${t}[^>]*>([^<]*)</${t}>`, 'i')); return m ? unent(m[1].trim()) : null; };

function ssdpScan(ms) {
  return new Promise((resolve) => {
    const byIp = {};
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('message', (msg, rinfo) => {
      const t = msg.toString('utf8');
      const loc = (t.match(/^location:\s*(.+)$/im) || [])[1];
      const srv = (t.match(/^server:\s*(.+)$/im) || [])[1];
      const e = (byIp[rinfo.address] = byIp[rinfo.address] || { locations: new Set(), server: null });
      if (loc) e.locations.add(loc.trim());
      if (srv) e.server = srv.trim();
    });
    sock.on('error', () => {});
    sock.bind(0, () => {
      const m = Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ssdp:all\r\n\r\n');
      sock.send(m, 1900, '239.255.255.250');
      setTimeout(() => sock.send(m, 1900, '239.255.255.250'), 600);
    });
    setTimeout(async () => {
      try { sock.close(); } catch (e) { /* nada */ }
      // Leer las descripciones XML (modelo, fabricante, nombre amigable)
      await Promise.all(Object.entries(byIp).map(async ([ip, e]) => {
        for (const loc of [...e.locations].slice(0, 3)) {
          if (!loc.includes(ip)) continue;
          const x = await httpGet(loc);
          if (!x) continue;
          e.friendlyName = e.friendlyName || xmlTag(x, 'friendlyName');
          e.manufacturer = e.manufacturer || xmlTag(x, 'manufacturer');
          e.modelName = e.modelName || xmlTag(x, 'modelName');
          e.modelNumber = e.modelNumber || xmlTag(x, 'modelNumber');
          e.deviceType = e.deviceType || xmlTag(x, 'deviceType');
        }
      }));
      resolve(byIp);
    }, ms);
  });
}

// ---------- barrido + ARP ----------
async function sweep(hosts, onProgress) {
  const sock = dgram.createSocket('udp4');
  const nb = {};
  sock.on('message', (msg, rinfo) => { const n = parseNbstat(msg); if (n) nb[rinfo.address] = n; });
  sock.on('error', () => {});
  await new Promise((r) => sock.bind(0, r));
  let i = 0;
  for (const h of hosts) {
    sock.send(nbstatPacket(i & 0xffff), 137, h);
    if (++i % 32 === 0) { onProgress && onProgress(Math.round((i / hosts.length) * 40)); await sleep(15); }
  }
  // segunda pasada para equipos dormidos
  await sleep(600);
  for (const h of hosts) sock.send(nbstatPacket(7), 137, h);
  await sleep(1800);
  try { sock.close(); } catch (e) { /* nada */ }
  return nb;
}

async function arpTable(net) {
  const out = await run('arp', ['-a', '-N', net.ip]);
  const res = {};
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f]{2}(?:-[0-9a-f]{2}){5})/i);
    if (!m) continue;
    const mac = normMac(m[2]);
    if (mac === 'FF:FF:FF:FF:FF:FF' || mac.startsWith('01:00:5E') || mac.startsWith('33:33')) continue;
    res[m[1]] = mac;
  }
  return res;
}

/** Estado de cada vecino según Windows: Reachable = contestó recién. */
async function neighborStates(net) {
  const out = await run('powershell.exe', ['-NoProfile', '-Command',
    `Get-NetNeighbor -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { $_.IPAddress + ';' + $_.State }`]);
  const st = {};
  for (const line of out.split(/\r?\n/)) {
    const [ip, s] = line.trim().split(';');
    if (ip && s) st[ip] = s;
  }
  return st;
}

async function reverseName(ip, gw) {
  const r = new dns.promises.Resolver({ timeout: 1200, tries: 1 });
  if (gw) { try { r.setServers([gw]); } catch (e) { /* nada */ } }
  try { const n = await r.reverse(ip); return n && n[0] ? n[0].replace(/\.(home|lan|local|localdomain|router|domain)$/i, '') : null; } catch (e) { return null; }
}

// ---------- clasificación ----------
const has = (s, re) => !!(s && re.test(s));
function classify(d) {
  const v = d.vendor || '';
  const txt = (d.mdnsTxt || []).join(' ');
  const svc = d.services || [];
  const names = [d.hostname, d.netbios, d.ssdp && d.ssdp.friendlyName, ...(d.mdnsNames || [])].filter(Boolean).join(' ');
  const model = d.ssdp ? [d.ssdp.manufacturer, d.ssdp.modelName, d.ssdp.modelNumber].filter(Boolean).join(' ') : '';
  const all = `${names} ${model} ${txt} ${v}`;

  if (d.isSelf) return ['pc', 'Esta computadora', 'seguro'];
  if (d.isGateway) return ['router', 'Router / módem', 'seguro'];
  if (has(all, /\b(tv|qled|oled|bravia|smart ?tv|webos|tizen|android ?tv|crystal uhd|neo qled|the frame)\b/i) || has(d.ssdp && d.ssdp.deviceType, /MediaRenderer/i) && has(v, /samsung|lg |sony|tcl|hisense|philips|panasonic/i))
    return ['tv', 'Televisor', 'seguro'];
  if (svc.includes('_googlecast._tcp')) {
    if (has(txt, /md=[^ ]*(tv|google tv)/i)) return ['tv', 'Televisor (Chromecast integrado)', 'seguro'];
    if (has(txt, /md=[^ ]*(nest|home|speaker|audio)/i)) return ['speaker', 'Parlante inteligente', 'seguro'];
    return ['stream', 'TV Box / Chromecast', 'seguro'];
  }
  if (has(all, /eshare|miracast|anycast|tv ?box|mibox|fire ?tv|roku|apple ?tv|android_?box/i) || svc.includes('_amzn-wplay._tcp') || svc.includes('_androidtvremote2._tcp'))
    return ['stream', 'Reproductor multimedia / TV Box', 'probable'];
  if (svc.some((s) => /_ipp|_printer|_pdl-datastream/.test(s)) || has(v, /epson|canon|brother|lexmark|kyocera|ricoh|xerox/i) || has(all, /printer|impresora|officejet|deskjet|laserjet/i))
    return ['printer', 'Impresora', svc.length ? 'seguro' : 'probable'];
  if (has(v, /sony interactive|nintendo/i) || has(all, /playstation|ps4|ps5|xbox|switch/i)) return ['console', 'Consola de juegos', 'probable'];
  if (svc.includes('_sonos._tcp') || has(v, /sonos|bose|harman|jbl/i) || svc.includes('_spotify-connect._tcp') && !svc.includes('_airplay._tcp'))
    return ['speaker', 'Parlante / equipo de audio', 'probable'];
  if (has(v, /hikvision|dahua|ezviz|imou|reolink|axis|uniview|wyze/i) || has(all, /camera|cámara|ipcam|tapo c/i)) return ['camera', 'Cámara de seguridad', 'probable'];
  if (has(v, /dreame|roborock|irobot|ecovacs|roidmi|trifo|eufy/i) || has(all, /vacuum|roborock|roomba|deebot|dreame/i)) return ['vacuum', 'Robot aspiradora', 'probable'];
  if (has(all, /shellyplug/i)) return ['iot', 'Enchufe inteligente (Shelly Plug)', 'seguro'];
  if (has(all, /shelly/i)) return ['iot', 'Dispositivo Shelly (relé, luz, sensor)', 'seguro'];
  if (d.samsungTv) return ['tv', 'Televisor Samsung', 'seguro'];
  if (has(v, /samjin/i)) return ['appliance', 'Electrodoméstico con Wi-Fi o SmartThings (ej. aire acondicionado)', 'posible'];
  if (has(v, /espressif|tuya|shelly|itead|sonoff|broadlink|lumi|wiz|signify|philips lighting|yeelight|meross/i) || svc.includes('_hap._tcp') || svc.includes('_esphomelib._tcp') || svc.includes('_matter._tcp'))
    return ['iot', 'Dispositivo inteligente (enchufe, luz, sensor…)', 'probable'];
  if (svc.includes('_companion-link._tcp') || has(all, /iphone|ipad/i)) return ['phone', 'iPhone / iPad', 'probable'];
  if (has(all, /android|galaxy|redmi|xiaomi|poco|motorola|moto ?[a-z0-9]|pixel|huawei|honor|oppo|vivo|realme|oneplus|\bA\d{1,2}\b|\bS\d{1,2}\b|BVS/i) || d.random)
    return ['phone', d.random ? 'Celular o tablet (MAC privada)' : 'Celular o tablet', d.random ? 'probable' : 'probable'];
  if (d.netbios || svc.includes('_smb._tcp') || svc.includes('_workstation._tcp') || has(v, /intel corporate|realtek|micro-star|asustek|giga-byte|dell|lenovo|hewlett|hp inc|apple/i))
    return ['pc', 'Computadora / notebook', 'probable'];
  // Fabricantes de placas Wi-Fi que van casi siempre dentro de notebooks
  if (has(v, /azurewave|liteon|lite-on|hon hai|cloud network technology|wistron|chicony|universal global scientific|intel wireless/i))
    return ['pc', 'Notebook (placa Wi-Fi ' + v.split(/[ ,]/)[0] + ')', 'probable'];
  if (has(v, /tp-link|tenda|mercusys|huawei|zte|netgear|d-link|ubiquiti|mikrotik|linksys|asus/i)) return ['network', 'Equipo de red (repetidor, AP…)', 'probable'];
  // Samsung y LG fabrican celulares, teles y electrodomésticos: sin más pistas no se puede saber cuál es.
  if (has(v, /samsung|lg electronics/i)) return ['unknown', 'Celular, tele o electrodoméstico ' + v.split(' ')[0], 'posible'];
  if (has(v, /whirlpool|bosch|haier|midea|electrolux|gree/i)) return ['appliance', 'Electrodoméstico ' + v.split(' ')[0], 'posible'];
  return ['unknown', 'Desconocido', 'desconocido'];
}

// ---------- escaneo completo ----------
async function scan(onProgress = () => {}) {
  const net = localNet();
  if (!net) throw new Error('No se encontró una conexión de red activa.');
  const gw = await gateway();
  const hosts = hostsOf(net);
  onProgress(2, 'Preparando el escaneo…');

  const mdnsP = mdnsScan(4500);
  const ssdpP = ssdpScan(4500);
  onProgress(5, `Buscando equipos en ${hosts[0]} – ${hosts[hosts.length - 1]}…`);
  const nb = await sweep(hosts, (p) => onProgress(5 + p, 'Buscando equipos…'));
  onProgress(50, 'Leyendo la tabla de la red…');
  const arp = await arpTable(net);
  arp[net.ip] = net.mac;

  onProgress(60, 'Escuchando qué anuncia cada equipo…');
  const [mdns, ssdp] = await Promise.all([mdnsP, ssdpP]);

  // Quién está activo: se le "toca la puerta" a cada equipo conocido y se espera que Windows
  // termine de comprobarlo (los que quedan en "Probe" se vuelven a mirar).
  onProgress(72, 'Comprobando quién está activo…');
  const knownIps = Object.keys(arp).filter((ip) => ip !== net.ip);
  const poke = async () => {
    const s = dgram.createSocket('udp4'); s.on('error', () => {});
    await new Promise((r) => s.bind(0, r));
    for (let k = 0; k < 3; k++) for (const ip of knownIps) s.send(Buffer.from([0]), 9, ip);
    await sleep(300); try { s.close(); } catch (e) { /* nada */ }
  };
  await poke(); await sleep(2500);
  let states = await neighborStates(net);
  if (knownIps.some((ip) => /^(Probe|Incomplete|Delay)$/i.test(states[ip] || ''))) {
    await poke(); await sleep(2000);
    states = await neighborStates(net);
  }

  onProgress(80, 'Averiguando nombres…');
  const ips = Object.keys(arp);
  const names = {};
  await Promise.all(ips.map(async (ip) => { names[ip] = await reverseName(ip, gw); }));

  // Preguntas directas a equipos que se identifican solos (solo lectura)
  onProgress(88, 'Consultando a los equipos que se presentan solos…');
  const extra = {};
  await Promise.all(ips.map(async (ip) => {
    const v = vendorOf(arp[ip]) || '';
    if (/samsung/i.test(v)) {
      const j = await httpGet(`http://${ip}:8001/api/v2/`, 1500);
      try {
        const o = JSON.parse(j);
        if (o && o.device) extra[ip] = { samsungTv: true, name: unent(o.device.name || o.name), model: unent(o.device.modelName || o.device.model) };
      } catch (e) { /* no es una tele Samsung o está apagada */ }
    } else if (/espressif/i.test(v)) {
      const j = await httpGet(`http://${ip}/shelly`, 1500);
      try { const o = JSON.parse(j); if (o && (o.type || o.model)) extra[ip] = { model: `Shelly ${o.type || o.model}` }; } catch (e) { /* no es Shelly */ }
    }
  }));

  onProgress(95, 'Identificando cada equipo…');
  const devices = ips.map((ip) => {
    const mac = arp[ip];
    const m = mdns[ip];
    const d = {
      ip, mac,
      vendor: vendorOf(mac),
      random: isRandomMac(mac),
      hostname: names[ip] || null,
      netbios: nb[ip] || null,
      services: m ? [...m.services] : [],
      mdnsNames: m ? [...m.names].filter((x) => !/^[0-9a-f-]{20,}$/i.test(x)) : [],
      mdnsTxt: m ? m.txt : [],
      ssdp: ssdp[ip] ? { friendlyName: ssdp[ip].friendlyName, manufacturer: ssdp[ip].manufacturer, modelName: ssdp[ip].modelName, modelNumber: ssdp[ip].modelNumber, deviceType: ssdp[ip].deviceType, server: ssdp[ip].server } : null,
      isSelf: ip === net.ip,
      isGateway: ip === gw,
    };
    const txtModel = (d.mdnsTxt.find((t) => /^(md|model|fn)=/i.test(t)) || '').replace(/^[a-z]+=/i, '');
    const ex = extra[ip] || {};
    d.samsungTv = !!ex.samsungTv;
    d.model = ex.model || (d.ssdp && [d.ssdp.manufacturer, d.ssdp.modelName, d.ssdp.modelNumber].filter(Boolean).join(' ')) || txtModel || null;
    if (d.model) d.model = [...new Set(d.model.split(/\s+/))].join(' '); // quita palabras repetidas
    d.bestName = ex.name || (d.ssdp && d.ssdp.friendlyName) || d.mdnsNames[0] || d.netbios || d.hostname || null;
    // Activo: contestó a la red ahora o respondió a alguna consulta. Si no, está en reposo o apagado.
    d.state = states[ip] || null;
    d.alive = d.isSelf || /^(Reachable|Permanent)$/i.test(d.state || '') || !!(nb[ip] || m || ssdp[ip] || extra[ip]);
    const [type, label, confidence] = classify(d);
    Object.assign(d, { type, label, confidence });
    return d;
  });
  devices.sort((a, b) => ip2n(a.ip) - ip2n(b.ip));
  onProgress(100, 'Listo');
  return { net: { ip: net.ip, mask: net.mask, iface: net.name, gateway: gw }, devices, time: Date.now() };
}

module.exports = { scan, vendorOf, isRandomMac };
