const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getStatus: () => ipcRenderer.invoke('get-status'),
  startBackup: (mode, dest) => ipcRenderer.invoke('start-backup', { mode, dest }),
  startRestore: (mode, dest) => ipcRenderer.invoke('start-restore', { mode, dest }),
  cancel: () => ipcRenderer.invoke('cancel'),
  chooseDir: () => ipcRenderer.invoke('choose-dir'),
  chooseImage: () => ipcRenderer.invoke('choose-image'),
  onLog: (cb) => ipcRenderer.on('log', (e, s) => cb(s)),
  onProgress: (cb) => ipcRenderer.on('progress', (e, v, msg) => cb(v, msg)),
  onFinish: (cb) => ipcRenderer.on('finish', (e, ok, msg) => cb(ok, msg))
});
