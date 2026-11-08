// Prueba automática del lápiz: abre la app con datos de ejemplo, renombra un equipo y verifica.
process.env.RADAR_DEMO = process.env.RADAR_DEMO || require('path').join(__dirname, 'demo.json');
require('../src/main.js');
const { app, BrowserWindow } = require('electron');
app.on('browser-window-created', (_e, w) => {
  w.webContents.on('did-finish-load', () => setTimeout(async () => {
    const r = await w.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((x) => setTimeout(x, ms));
      for (let i = 0; i < 40 && !document.querySelector('.dev .edit'); i++) await wait(250);
      const card = [...document.querySelectorAll('.dev')].find((c) => c.textContent.includes('00:11:22:33:44:08'));
      if (!card) return 'no encontré la tarjeta';
      card.querySelector('.edit').click(); await wait(200);
      const inp = card.querySelector('.rename input'); if (!inp) return 'no se abrió el cuadro de nombre';
      inp.value = 'Aire acondicionado'; card.querySelector('.rename .primary').click(); await wait(300);
      const ok = [...document.querySelectorAll('.dev h3 .nm')].some((n) => n.textContent === 'Aire acondicionado');
      return ok ? 'OK: el nombre se guardó y se ve en la tarjeta' : 'FALLÓ: no aparece el nombre';
    })()`);
    console.log(r); app.quit();
  }, 500));
});
