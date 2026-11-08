const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('radar', {
  scan: () => ipcRenderer.invoke('scan'),
  onProgress: (cb) => { ipcRenderer.removeAllListeners('progress'); ipcRenderer.on('progress', (_e, d) => cb(d)); },
  notify: (title, body) => ipcRenderer.send('notify', { title, body }),
});
