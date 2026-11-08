const { app, BrowserWindow, ipcMain, Notification } = require('electron');
const path = require('path');
const scanner = require('./scanner');

let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1000, height: 780, minWidth: 380, minHeight: 520,
    show: !process.env.RADAR_SHOT && !process.env.RADAR_DEMO, // las capturas de prueba no aparecen en pantalla
    backgroundColor: '#0b0b0d', title: 'Radar de Red', autoHideMenuBar: true,
    icon: path.join(__dirname, 'ui', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  // Solo para pruebas: RADAR_SHOT=archivo.png captura la ventana tras el primer escaneo y cierra.
  if (process.env.RADAR_SHOT) setTimeout(async () => {
    const h = await win.webContents.executeJavaScript('document.documentElement.scrollHeight');
    win.setContentSize(1000, Math.min(h, 3000)); await new Promise((r) => setTimeout(r, 700));
    require('fs').writeFileSync(process.env.RADAR_SHOT, (await win.webContents.capturePage()).toPNG()); app.quit();
  }, 16000);
}

let scanning = false;
ipcMain.handle('scan', async () => {
  // Solo para la captura del README: RADAR_DEMO usa datos de ejemplo, no la red real.
  if (process.env.RADAR_DEMO) { const d = JSON.parse(require('fs').readFileSync(process.env.RADAR_DEMO, 'utf8')); d.time = Date.now(); return d; }
  if (scanning) return { error: 'Ya hay un escaneo en curso.' };
  scanning = true;
  try {
    return await scanner.scan((p, msg) => { if (win && !win.isDestroyed()) win.webContents.send('progress', { p, msg }); });
  } catch (e) {
    return { error: e.message };
  } finally { scanning = false; }
});
ipcMain.on('notify', (_e, { title, body }) => {
  if (Notification.isSupported()) new Notification({ title, body, icon: path.join(__dirname, 'ui', 'icon.png') }).show();
});

// El modo de ejemplo usa una memoria aparte para no mezclar datos falsos con los reales.
if (process.env.RADAR_DEMO) app.setPath('userData', require('path').join(require('os').tmpdir(), 'radar-demo'));
app.setAppUserModelId('uy.radardered.app');
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
