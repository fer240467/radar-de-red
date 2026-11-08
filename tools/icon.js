// Renderiza src/ui/icon.svg a PNG (varios tamaños) e ICO.
const { app, BrowserWindow } = require('electron'); const fs = require('fs'); const path = require('path');
const R = path.join(__dirname, '..');
function ico(pngs) { const n = pngs.length, h = Buffer.alloc(6 + 16 * n); h.writeUInt16LE(1, 2); h.writeUInt16LE(n, 4); let off = h.length;
  pngs.forEach(([s, b], i) => { const e = 6 + 16 * i; h[e] = s >= 256 ? 0 : s; h[e + 1] = s >= 256 ? 0 : s; h.writeUInt16LE(1, e + 4); h.writeUInt16LE(32, e + 6); h.writeUInt32LE(b.length, e + 8); h.writeUInt32LE(off, e + 12); off += b.length; });
  return Buffer.concat([h, ...pngs.map((p) => p[1])]); }
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 512, height: 512, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  fs.writeFileSync(path.join(__dirname, 'icon.html'), '<html><body style="margin:0;background:transparent"><img src="../src/ui/icon.svg" width="512" height="512"></body></html>');
  await w.loadFile(path.join(__dirname, 'icon.html')); await new Promise((r) => setTimeout(r, 600));
  const big = (await w.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 })).resize({ width: 512, height: 512 });
  const sizes = [16, 32, 48, 256]; const pngs = sizes.map((s) => [s, big.resize({ width: s, height: s, quality: 'best' }).toPNG()]);
  fs.mkdirSync(path.join(R, 'build'), { recursive: true });
  fs.writeFileSync(path.join(R, 'build', 'icon.ico'), ico(pngs));
  fs.writeFileSync(path.join(R, 'src', 'ui', 'icon.png'), big.resize({ width: 256, height: 256 }).toPNG());
  console.log('icono listo'); app.quit();
});
