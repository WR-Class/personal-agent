'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const READ_LIMIT = 256 * 1024;
const OUTPUT_LIMIT = 128 * 1024;
class WorkspaceError extends Error {}
const fail = message => { throw new WorkspaceError(message); };

function sensitiveName(name) {
  return /^(?:\.env(?:\..*)?|\.ssh|\.gnupg|\.aws|\.azure|\.config|\.git|\.dsh|\.personal-agent|\.npmrc|\.netrc|\.git-credentials|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i.test(name) ||
    /\.(?:pem|key|p12|pfx|p8|jks|keystore)$/i.test(name) || /(?:^|[._-])(?:private[._-]?key|api[._-]?key)(?:[._-]|$)/i.test(name);
}
function safeRelative(relative = '') {
  if (typeof relative !== 'string' || relative.length > 4096 || /[\x00-\x1f:*?"<>|]/.test(relative) ||
      path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative)) fail('仅允许工作区内相对路径');
  const parts = relative.split(/[\\/]/);
  if (parts.some(p => p === '..' || (p && /[. ]$/.test(p) && p !== '.') || sensitiveName(p) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) fail('路径包含父级跳转、受保护文件或非法名称');
  return parts.filter(p => p && p !== '.');
}
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function resolveWorkspacePath(root, relative = '') {
  if (!root) fail('请先选择工作区目录');
  const parts = safeRelative(relative);
  let current = root;
  // Reject all links, including in-workspace links; realpath also catches junction escapes.
  if (fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root) !== root) fail('工作区目录已变化，请重新选择');
  for (const part of parts) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink() || !inside(root, fs.realpathSync(current))) fail('不允许符号链接或目录联接');
  }
  return current;
}
function safeURL(input) {
  if (typeof input !== 'string' || input.length > 8192 || /[\x00-\x20\x7f\\]/.test(input) || !/^https?:\/\//i.test(input)) fail('仅允许不含凭据的 HTTP/HTTPS URL');
  let url;
  try { url = new URL(input); } catch { fail('URL 无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) fail('仅允许不含凭据的 HTTP/HTTPS URL');
  return url.href;
}
function allowedURL(input) { try { safeURL(input); return true; } catch { return false; } }
function safeBounds(input, size) {
  if (!input || typeof input.visible !== 'boolean') fail('浏览器可见性无效');
  const { x, y, width, height, visible } = input;
  if (![x, y, width, height].every(Number.isSafeInteger) || x < 0 || y < 0 || width < 1 || height < 1 ||
      x + width > size[0] || y + height > size[1]) fail('浏览器区域必须位于窗口内');
  return { x, y, width, height, visible };
}
function shellEnvironment(source = process.env) {
  // Allowlist, not a key-name blacklist: no provider keys, NODE_OPTIONS, ENV or BASH_ENV.
  const allowed = new Set(['systemroot', 'windir', 'comspec', 'path', 'pathext', 'temp', 'tmp', 'tmpdir', 'home', 'userprofile', 'lang', 'lc_all']);
  return Object.fromEntries(Object.entries(source).filter(([key]) => allowed.has(key.toLowerCase())));
}
function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', env: shellEnvironment() });
    killer.on('error', () => { try { child.kill(); } catch {} });
  } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }
}
function runCommand(state, command) {
  return new Promise((resolve, reject) => {
    const windows = process.platform === 'win32';
    const executable = windows ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/bin/sh';
    const args = windows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command];
    const child = spawn(executable, args, { cwd: state.root, env: shellEnvironment(), windowsHide: true, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'] });
    state.child = child;
    const chunks = []; let length = 0; let stopped = false; let settled = false;
    const finish = (error, code) => {
      if (settled) return; settled = true; clearTimeout(timer);
      const encoded = Buffer.from(Buffer.concat(chunks).toString('utf8'));
      const output = new TextDecoder().decode(encoded.subarray(0, OUTPUT_LIMIT), { stream: true });
      error ? reject(error) : resolve({ output, code: code ?? -1, truncated: length >= OUTPUT_LIMIT || encoded.length > OUTPUT_LIMIT, timedOut });
    };
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; stopChild(child); finish(null, -1); }, 30000);
    const collect = chunk => {
      const remaining = OUTPUT_LIMIT - length;
      if (remaining > 0) { const part = chunk.subarray(0, remaining); chunks.push(part); length += part.length; }
      if (length >= OUTPUT_LIMIT && !stopped) { stopped = true; stopChild(child); finish(null, -1); }
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', error => finish(error));
    child.once('close', code => { if (state.child === child) state.child = null; finish(null, code); });
  });
}
function installWorkspace({ ipcMain, dialog, WebContentsView, session, trustedWindow }) {
  const states = new WeakMap();
  const snapshot = state => ({ root: state.root, permission: state.permission });
  function closeBrowser(win, state) {
    if (!state.view) return;
    const view = state.view; state.view = null;
    if (!win.isDestroyed()) win.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }
  function getState(win) {
    let state = states.get(win);
    if (state) return state;
    state = { root: null, permission: 'read', view: null, child: null, busy: false, generation: 0 };
    states.set(win, state);
    const hide = () => state.view?.setVisible(false);
    win.webContents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => { if (isMainFrame && !inPlace) { state.generation++; hide(); } });
    win.on('resize', hide);
    win.on('closed', () => { state.generation++; closeBrowser(win, state); stopChild(state.child); });
    return state;
  }
  function createBrowser(win, state) {
    const isolated = session.fromPartition('workspace-' + randomUUID(), { cache: false });
    isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.setDevicePermissionHandler(() => false);
    isolated.on('will-download', event => event.preventDefault());
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.resourceType === 'subFrame' || !allowedURL(details.url) }));
    const view = new WebContentsView({ webPreferences: { session: isolated, nodeIntegration: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, safeDialogs: true, disableDialogs: true, navigateOnDragDrop: false } });
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-attach-webview', event => event.preventDefault());
    view.webContents.on('will-navigate', (event, url) => { if (!allowedURL(url)) event.preventDefault(); });
    view.webContents.on('will-frame-navigate', (event, details) => {
      const info = details && typeof details === 'object' ? details : event;
      if (!info.isMainFrame || !allowedURL(info.url)) event.preventDefault();
    });
    view.webContents.on('will-redirect', (event, url, _inPlace, isMainFrame) => { if (!isMainFrame || !allowedURL(url)) event.preventDefault(); });
    view.webContents.on('login', event => event.preventDefault());
    win.contentView.addChildView(view); view.setVisible(false); state.view = view;
    return view;
  }
  ipcMain.handle('workspace:action', async (event, action, payload = {}) => {
    let state; let locked = false;
    try {
      const win = trustedWindow(event);
      if (!win || win.isDestroyed()) fail('窗口不可用');
      state = getState(win);
      const generation = state.generation;
      const check = () => { if (trustedWindow(event) !== win || win.isDestroyed() || state.generation !== generation) fail('窗口已变化，请重试'); };
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('操作参数无效');
      if (['choose', 'permission', 'terminal'].includes(action)) {
        if (state.busy || state.child) fail('正在处理工作区操作，请稍后重试');
        state.busy = true; locked = true;
      }
      let data;
      switch (action) {
        case 'state': data = snapshot(state); break;
        case 'choose': {
          const result = await dialog.showOpenDialog(win, { title: '选择工作区目录', properties: ['openDirectory'] }); check();
          if (!result.canceled && result.filePaths.length) {
            const root = fs.realpathSync(result.filePaths[0]);
            if (!fs.statSync(root).isDirectory() || root.split(/[\\/]/).some(sensitiveName)) fail('不能选择受保护目录');
            state.root = root; state.permission = 'read';
          }
          data = snapshot(state); break;
        }
        case 'permission': {
          if (!['read', 'full'].includes(payload.permission)) fail('权限必须为 read 或 full');
          if (payload.permission === 'full' && state.permission !== 'full') {
            const result = await dialog.showMessageBox(win, { type: 'warning', title: '允许完整工作区权限？', message: '命令将以当前用户权限运行，可访问工作区外的文件、网络及密钥。', detail: '这不是安全沙箱。每条命令仍须原生确认；模型仍无工具，不能自行读文件或执行命令。仅确认你信任的命令。', buttons: ['取消', '允许完整权限'], defaultId: 0, cancelId: 0, noLink: true }); check();
            if (result.response !== 1) fail('已取消权限变更');
          }
          state.permission = payload.permission; data = snapshot(state); break;
        }
        case 'files': {
          const target = resolveWorkspacePath(state.root, payload.relative ?? '');
          const dir = fs.opendirSync(target); const entries = []; let truncated = false;
          try {
            let entry;
            while ((entry = dir.readSync())) {
              if (sensitiveName(entry.name) || entry.isSymbolicLink()) continue;
              try { resolveWorkspacePath(state.root, path.relative(state.root, path.join(target, entry.name))); } catch { continue; }
              if (entries.length === 500) { truncated = true; break; }
              entries.push({ name: entry.name, relative: path.relative(state.root, path.join(target, entry.name)).split(path.sep).join('/'), directory: entry.isDirectory() });
            }
          } finally { dir.closeSync(); }
          data = { entries, truncated }; break;
        }
        case 'read': {
          const target = resolveWorkspacePath(state.root, payload.relative);
          const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
          try {
            const stat = fs.fstatSync(fd); if (!stat.isFile()) fail('仅可预览普通文本文件');
            const buffer = Buffer.alloc(READ_LIMIT); const length = fs.readSync(fd, buffer, 0, READ_LIMIT, 0);
            const bytes = buffer.subarray(0, length);
            if (bytes.includes(0)) fail('不能预览二进制文件');
            data = { relative: payload.relative, content: bytes.toString('utf8'), truncated: stat.size > READ_LIMIT };
          } finally { fs.closeSync(fd); }
          break;
        }
        case 'terminal': {
          if (!state.root || state.permission !== 'full') fail('请先选择工作区并启用完整权限');
          const command = payload.command;
          if (typeof command !== 'string' || !command.trim() || command.length > 8192 || command.includes('\0')) fail('命令须为 1–8192 字符');
          resolveWorkspacePath(state.root);
          const result = await dialog.showMessageBox(win, { type: 'warning', title: '确认执行命令', message: '以当前用户权限执行下列命令（可访问工作区外）？', detail: `工作目录：${state.root}\n\n${command}\n\n单次非交互进程；30 秒超时，输出最多 128 KiB。模型仍无工具。`, buttons: ['取消', '执行命令'], defaultId: 0, cancelId: 0, noLink: true }); check();
          if (result.response !== 1) fail('已取消命令');
          resolveWorkspacePath(state.root); data = await runCommand(state, command); break;
        }
        case 'browser-open': {
          const url = safeURL(payload.url);
          const view = state.view || createBrowser(win, state);
          await view.webContents.loadURL(url); check();
          if (state.view !== view) fail('浏览器已关闭');
          data = { url: view.webContents.getURL() }; break;
        }
        case 'browser-bounds': {
          if (!state.view && payload.visible === false) { data = { visible: false }; break; }
          const bounds = safeBounds(payload, win.getContentSize());
          if (!state.view) fail('浏览器尚未打开');
          state.view.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
          state.view.setVisible(bounds.visible); data = { visible: bounds.visible }; break;
        }
        case 'browser-back':
          if (!state.view) fail('浏览器尚未打开');
          if (state.view.webContents.navigationHistory.canGoBack()) state.view.webContents.navigationHistory.goBack();
          data = null; break;
        case 'browser-reload':
          if (!state.view) fail('浏览器尚未打开');
          state.view.webContents.reload(); data = null; break;
        case 'browser-close': closeBrowser(win, state); data = null; break;
        default: fail('未知工作区操作');
      }
      check(); return { ok: true, data };
    } catch (error) { return { ok: false, error: error instanceof WorkspaceError ? error.message : '工作区操作失败：来源不可信、路径不可访问或操作未完成' }; }
    finally { if (locked && state) state.busy = false; }
  });
}
module.exports = { installWorkspace, safeRelative, sensitiveName, resolveWorkspacePath, safeURL, safeBounds, shellEnvironment };
