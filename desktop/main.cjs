const { app, BrowserWindow, ipcMain, session, safeStorage } = require('electron');
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

function trustedWindow(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  const frame = event.senderFrame;
  if (!win || !windows.has(win) || !frame || frame !== event.sender.mainFrame ||
      frame.url.split('#')[0] !== entryURL) {
    throw new Error('Untrusted desktop sender');
  }
  return win;
}

const sessionHome = path.resolve(process.env.PERSONAL_AGENT_HOME ?? path.join(__dirname, '..', '.personal-agent'));
ipcMain.handle('sessions:list', async (event) => {
  trustedWindow(event);
  try {
    const { desktopSessions } = await import('../src/desktop-sessions.ts');
    const result = await desktopSessions(sessionHome);
    trustedWindow(event); // Recheck after asynchronous IO, before returning private IDs.
    return result;
  } catch (_) {
    throw new Error('会话列表读取失败；请检查 PERSONAL_AGENT_HOME 与目录权限');
  }
});

ipcMain.handle('sessions:history', async (event, id) => {
  trustedWindow(event);
  try {
    const { desktopHistory } = await import('../src/desktop-sessions.ts');
    const result = await desktopHistory(sessionHome, id);
    trustedWindow(event);
    return result;
  } catch (_) {
    throw new Error('历史读取失败：会话不存在、损坏、受保护或超过 1 MiB；不会自动修复');
  }
});

let providerService;
async function providers() {
  const { DesktopProviders } = await import('../src/desktop-providers.ts');
  return providerService ??= new DesktopProviders(sessionHome, safeStorage);
}
// ponytail: serialize configuration/discovery in this host; cross-process writes use a file lock.
let settingsBusy = false;
ipcMain.handle('providers:settings', async (event, action, payload) => {
  trustedWindow(event);
  if (!['list', 'save', 'delete', 'discover'].includes(action)) return { ok: false, error: '未知配置操作' };
  if (settingsBusy) return { ok: false, error: '正在处理配置请求，请稍后重试' };
  settingsBusy = true;
  try {
    const service = await providers(); trustedWindow(event);
    const data = action === 'list' ? await service.list() : await service[action](payload);
    trustedWindow(event); return { ok: true, data };
  } catch (e) {
    const { ProviderError } = await import('../src/desktop-providers.ts');
    return { ok: false, error: e instanceof ProviderError ? e.message : '配置操作失败；请检查文件权限、系统加密或配置完整性。原始内容已隐藏。' };
  } finally { settingsBusy = false; }
});

const providerPreviews = new WeakMap();
let providerSequence = 0;
// ponytail: one global model request; use per-window locks only if parallel turns are needed.
let modelBusy = false;
ipcMain.handle('runtime:provider', async (event, selection) => {
  trustedWindow(event);
  const token = ++providerSequence;
  providerPreviews.set(event.sender, { token, expires: 0 });
  try {
    const { desktopProvider } = await import('../src/desktop-model.ts');
    let preview;
    if (selection !== undefined) {
      const config = await (await providers()).resolve(selection.id, selection.model);
      preview = { baseUrl: config.baseUrl, model: config.model, revision: config.revision, providerId: selection.id };
    } else { preview = await desktopProvider(sessionHome); }
    trustedWindow(event);
    if (providerPreviews.get(event.sender)?.token !== token) throw new Error('Stale preview');
    providerPreviews.set(event.sender, { ...preview, token, expires: Date.now() + 300000 });
    return { ...preview, token };
  } catch (_) { throw new Error('模型配置不可用；请先用 CLI 配置完整 Provider，密钥不在桌面显示'); }
});
ipcMain.handle('runtime:model', async (event, input, token) => {
  trustedWindow(event);
  const preview = providerPreviews.get(event.sender);
  if (!preview || token !== preview.token || preview.expires < Date.now()) throw new Error('请重新查看并确认模型配置');
  if (modelBusy) throw new Error('模型请求正在运行');
  providerPreviews.delete(event.sender);
  modelBusy = true;
  try {
    const { desktopModelSend } = await import('../src/desktop-model.ts');
    trustedWindow(event);
    const selected = preview.providerId ? await (await providers()).resolve(preview.providerId, preview.model, preview.revision) : undefined;
    trustedWindow(event);
    const result = await desktopModelSend(sessionHome, input, preview, process.env, selected);
    trustedWindow(event);
    return result;
  } catch (_) { throw new Error('模型请求失败，可能已计费或保存部分日志；请检查本地配置与历史，不会自动重试'); }
  finally { modelBusy = false; }
});

let echoBusy = false;
ipcMain.handle('runtime:echo', async (event, input) => {
  trustedWindow(event);
  if (echoBusy) throw new Error('离线测试正在运行，请稍后再试');
  echoBusy = true;
  try {
    const { desktopEcho } = await import('../src/desktop-echo.ts');
    trustedWindow(event);
    const result = await desktopEcho(sessionHome, input);
    trustedWindow(event);
    return result;
  } catch (_) {
    throw new Error('离线测试失败；输入须为 1–8192 字节。可能已保存部分日志，请刷新会话检查，不会自动重试。');
  } finally { echoBusy = false; }
});

ipcMain.handle('desktop:info', (event) => {
  trustedWindow(event);
  return {
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    agentConnected: false,
  };
});

ipcMain.handle('window:action', (event, action) => {
  const win = trustedWindow(event);
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
