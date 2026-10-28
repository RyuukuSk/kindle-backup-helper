const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { BackupEngine } = require('./engine');

// 关闭 Chromium 沙盒（受限环境/低版本系统下避免初始化失败）
app.commandLine.appendSwitch('no-sandbox');
// 完全禁用 GPU（Intel 集显/macOS 12 兼容性，避免 GPU Helper 崩溃）
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.disableHardwareAcceleration();

let mainWindow = null;
const engine = new BackupEngine();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 660,
    height: 720,
    minWidth: 620,
    minHeight: 680,
    title: 'Kindle 备份助手',
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ===== 引擎事件桥接到渲染进程 =====
engine.onLog = (s) => mainWindow?.webContents.send('log', s);
engine.onProgress = (v, msg) => mainWindow?.webContents.send('progress', v, msg);
engine.onFinish = (ok, msg) => mainWindow?.webContents.send('finish', ok, msg);

// ===== IPC 处理 =====
ipcMain.handle('get-status', async () => {
  return {
    connected: engine.locateKindle() !== null,
    kindlePath: engine.locateKindle(),
    platform: process.platform,
    destOptions: engine.getDestOptions(),
    defaultDest: engine.getDefaultDest()
  };
});

ipcMain.handle('start-backup', async (e, payload) => {
  const { mode, dest } = payload || {};
  if (typeof mode !== 'number' || mode < 0 || mode > 2) return { ok: false, msg: '无效的备份模式' };
  if (typeof dest !== 'string' || !dest) return { ok: false, msg: '无效的备份位置' };
  return engine.startBackup(mode, dest);
});

ipcMain.handle('start-restore', async (e, payload) => {
  const { mode, dest } = payload || {};
  if (typeof mode !== 'number' || mode < 0 || mode > 2) return { ok: false, msg: '无效的还原模式' };
  if (typeof dest !== 'string' || !dest) return { ok: false, msg: '无效的备份位置' };
  return engine.startRestore(mode, dest);
});

ipcMain.handle('cancel', async () => {
  engine.cancel();
  return true;
});

ipcMain.handle('choose-dir', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: '选择备份位置'
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('choose-image', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    title: '选择备份映像文件',
    filters: [
      { name: '映像文件', extensions: ['img', 'dmg', 'iso'] }
    ]
  });
  return r.canceled ? null : r.filePaths[0];
});
