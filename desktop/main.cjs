const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const entry = path.join(__dirname, 'renderer', 'index.html');
const entryURL = pathToFileURL(entry).href;
const windows = new Set();

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 800, minHeight: 600,
    frame: false, show: false, backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, webviewTag: false,
    },
  });
  windows.add(win);
  win.once('ready-to-show', () => win.show());
  // No navigation, external launches, downloads or remote frames in this shell.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-frame-navigate', event => event.preventDefault());
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.on('maximize', () => win.webContents.send('window:maximized', true));
  win.on('unmaximize', () => win.webContents.send('window:maximized', false));
  win.on('closed', () => windows.delete(win));
  void win.loadFile(entry).catch(error => {
    console.error('Desktop failed to load:', error.message);
    win.destroy();
  });
  return win;
}

ipcMain.handle('window:action', (event, action) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const frame = event.senderFrame;
  if (!win || !windows.has(win) || frame !== event.sender.mainFrame ||
      frame.url.split('#')[0] !== entryURL) {
    throw new Error('Untrusted desktop sender');
  }
  switch (action) {
    case 'min': win.minimize(); break;
    case 'max': win.isMaximized() ? win.unmaximize() : win.maximize(); break;
    case 'close':
      win.close();
      return { ok: true, maximized: false };
    case 'reset':
      win.setFullScreen(false); win.unmaximize(); win.setSize(1440, 900); win.center(); break;
    case 'new': createWindow(); break;
    case 'fullscreen': win.setFullScreen(!win.isFullScreen()); break;
    default: throw new Error('Unknown window action');
  }
  return { ok: true, maximized: win.isMaximized() };
});

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.on('will-download', event => event.preventDefault());
  createWindow();
  app.on('activate', () => { if (windows.size === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
