// Abre el cuadro del lápiz en una tarjeta de ejemplo y saca captura (ventana oculta).
process.env.RADAR_DEMO = require('path').join(__dirname, 'demo.json');
const { app, BrowserWindow } = require('electron');
require('../src/main.js');
app.on('browser-window-created', (_e, w) => {
  w.webContents.on('did-finish-load', () => setTimeout(async () => {
    await w.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((x) => setTimeout(x, ms));
      for (let i = 0; i < 40 && !document.querySelector('.dev .edit'); i++) await wait(250);
      const c = [...document.querySelectorAll('.dev')].find((x) => x.textContent.includes('33:44:02'));
      c.querySelector('.edit').click(); await wait(200);
      c.querySelector('.rename input').value = 'Mi PC';
    })()`);
    await new Promise((r) => setTimeout(r, 400));
    require('fs').writeFileSync(require('path').join(__dirname, 'lapiz.png'), (await w.webContents.capturePage({ x: 330, y: 200, width: 340, height: 300 })).toPNG());
    app.quit();
  }, 300));
});
