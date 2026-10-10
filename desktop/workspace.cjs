'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const READ_LIMIT = 256 * 1024;
const OUTPUT_LIMIT = 128 * 1024;
/** New sessions and unreadable/legacy session metadata start at workspace write, not read-only. */
const DEFAULT_PERMISSION = 'write';
const PERMISSIONS = new Set(['read', 'write', 'full']);
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
function readDeliverable(root, input) {
  if (typeof input !== 'string' || input.length > 4096 || !root) fail('请先选择工作区，并指定文件路径');
  const relative = path.isAbsolute(input) ? path.relative(root, input) : input;
  const target = resolveWorkspacePath(root, relative);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1) fail('仅可预览非链接普通文件');
    if (stat.size > READ_LIMIT) fail('文件超过256 KiB预览上限，请在工作区中查看');
    const bytes = Buffer.alloc(stat.size); const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (bytes.subarray(0,length).includes(0)) fail('此文件暂不支持文本预览');
    return {relative,content:bytes.subarray(0,length).toString('utf8')};
  } finally { fs.closeSync(fd); }
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
function installWorkspace({ ipcMain, dialog, WebContentsView, session, trustedWindow, onRootChosen, onPermissionChange, isChatBusy, onContextChange }) {
  const states = new WeakMap();
  const snapshot = state => ({ root: state.root, permission: state.permission });
  const api = {
    getRoot(win) { return win && states.has(win) ? states.get(win).root : null; },
    getPermission(win) { return win && states.has(win) ? states.get(win).permission : DEFAULT_PERMISSION; },
    modelContext(win, signal, allowRemoteOnly=false) {
      const state = getState(win), generation = state.generation, root = state.root, permission = state.permission;
      if (state.busy || state.child) fail('请等待工作区操作完成');
      if (!root&&!allowRemoteOnly) return undefined;
      const check = () => {
        signal?.throwIfAborted();
        if (win.isDestroyed() || state.generation !== generation || state.root !== root || state.permission !== permission) fail('工作区模型权限已变化');
        if(root)resolveWorkspacePath(root);
      };
      check();
      return { workspaceRoot: root||'', remoteOnly:!root, permission, signal, check,
        approve: async (prompt, toolSignal) => {
          check(); toolSignal?.throwIfAborted();
          const remote=prompt.startsWith('调用 MCP 工具');
          const ok = await confirmWithUser(win, state, { title: remote?'确认远程工具调用':'确认模型命令', message: remote?'远程操作使用已授权账号，可能读取或修改云端资源；与本地文件权限无关，仅批准本次调用。':'此命令以当前用户权限运行，没有操作系统工作区沙箱；可能访问工作区外文件和网络。仅批准这一次调用。', detail: `工作目录：${root||'未选择（仅远程工具）'}\n\n${prompt}`, confirm: remote?'批准本次调用':'批准本次命令' }, toolSignal || signal);
          check(); toolSignal?.throwIfAborted(); return ok;
        },
      };
    },
    async confirmModelSwitch(win, from, to) {
      const state = getState(win), generation = state.generation;
      if (state.busy || state.child) fail('请等待工作区操作完成');
      const ok = await confirmWithUser(win, state, { title: '切换会话模型', message: '下一次发送将把本会话完整历史（含工具结果）发送到新模型/服务。取消不会更改会话。', detail: `原目标：${from}\n新目标：${to}\n切换保留当前 ${state.permission === 'full' ? '完全访问' : state.permission === 'write' ? '工作区写入' : '只读'} 权限；新模型可使用相同工具，工具结果仍会发送给新模型。`, confirm: '同意转移历史并切换' });
      return ok && !win.isDestroyed() && state.generation === generation;
    },
    revokeModelTools(win) { const state = getState(win); state.generation++; state.permission = 'read'; },
    /** Only a root the host already recorded; the session's remembered tier is restored, never widened. */
    adoptRoot(win, root, permission) {
      if (!win || win.isDestroyed()) fail('窗口不可用');
      const state = getState(win);
      if (state.busy || state.child) fail('正在处理工作区操作，请稍后重试');
      const tier = PERMISSIONS.has(permission) ? permission : DEFAULT_PERMISSION;
      if (root === null) { state.root = null; state.permission = tier; state.generation++; return snapshot(state); }
      const real = fs.realpathSync(root);
      if (real !== root || fs.lstatSync(root).isSymbolicLink() || !fs.statSync(real).isDirectory() || real.split(/[\\/]/).some(sensitiveName)) fail('目录不可用或受保护');
      state.root = real; state.permission = tier; state.generation++;
      return snapshot(state);
    },
  };
  function closeBrowser(win, state) {
    if (!state.view) return;
    const view = state.view; state.view = null;state.device=false;state.inspectListener=null;
    if (!win.isDestroyed()) win.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }
  function getState(win) {
    let state = states.get(win);
    if (state) return state;
    state = { root: null, permission: DEFAULT_PERMISSION, view: null, browserTabs:new Map(), browserTab:'default', child: null, busy: false, generation: 0, pendingConfirm: null };
    states.set(win, state);
    const hide = () => state.view?.setVisible(false);
    win.webContents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => { if (isMainFrame && !inPlace) { state.generation++; state.permission = DEFAULT_PERMISSION; state.pendingConfirm?.settle(false); hide(); } });
    win.on('resize', hide);
    win.on('closed', () => { state.generation++;closeBrowser(win,state);for(const saved of state.browserTabs.values()){state.view=saved.view;closeBrowser(win,state);}state.browserTabs.clear(); stopChild(state.child); state.pendingConfirm?.settle(false); });
    return state;
  }
  /* 弹窗由渲染进程按客户端设计语言绘制；主进程只认自己签发的一次性确认号，120 秒无应答视为取消。 */
  function confirmWithUser(win, state, options, signal) {
    if (state.pendingConfirm || signal?.aborted) return Promise.resolve(false);
    return new Promise(resolve => {
      const pending = { id: randomUUID(), settle: null };
      const timer = setTimeout(() => pending.settle(false), 120000);
      const abort = () => pending.settle(false);
      pending.settle = ok => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (state.pendingConfirm === pending) state.pendingConfirm = null; if (!win.isDestroyed()) win.webContents.send('workspace:confirm', { id: pending.id, dismissed: true }); resolve(ok === true); };
      signal?.addEventListener('abort', abort, { once: true });
      state.pendingConfirm = pending;
      win.webContents.send('workspace:confirm', { id: pending.id, title: options.title, message: options.message, detail: options.detail, confirm: options.confirm });
    });
  }
  function createBrowser(win, state, offline = false) {
    const isolated = session.fromPartition('workspace-' + randomUUID(), { cache: false });
    isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.setDevicePermissionHandler(() => false);
    isolated.on('will-download', event => event.preventDefault());
    isolated.webRequest.onBeforeRequest((details, callback) => {
      // Permit only bundled internal inspector assets, never remote frontend/network resources.
      // Preview navigation guards still prohibit leaving its document.
      const inspector=details.url.startsWith('devtools://devtools/bundled/');
      callback({cancel:inspector?false:offline?!(details.url.startsWith('data:')&&['mainFrame','image','font','media'].includes(details.resourceType)):details.resourceType==='subFrame'||!allowedURL(details.url)});
    });
    const view = new WebContentsView({ webPreferences: { session: isolated, backgroundThrottling:false, nodeIntegration: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, safeDialogs: true, disableDialogs: true, navigateOnDragDrop: false } });
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-attach-webview', event => event.preventDefault());
    view.webContents.on('will-navigate', (event, url) => { if (offline || !allowedURL(url)) event.preventDefault(); });
    view.webContents.on('will-frame-navigate', (event, details) => {
      const info = details && typeof details === 'object' ? details : event;
      if (!info.isMainFrame || !allowedURL(info.url)) event.preventDefault();
    });
    view.webContents.on('will-redirect', (event, url, _inPlace, isMainFrame) => { if (!isMainFrame || !allowedURL(url)) event.preventDefault(); });
    view.webContents.on('login', event => event.preventDefault());
    win.contentView.addChildView(view); view.setVisible(false); state.view = view;
    return view;
  }
  const inspectors=new WeakMap();
  function inspector(view,win){if(!inspectors.has(view))inspectors.set(view,require('./visual-inspector.cjs').createInspector(win,view,view.previewPath,()=>getState(win).view===view));return inspectors.get(view);}
  async function previewTool(win,state,tool){
    const view=state.view;if(!view||view.webContents.isDestroyed())fail('请先打开HTML预览或网页');
    const wc=view.webContents;
    if(tool==='device'){
      state.device=!state.device;
      if(state.device){const b=view.getBounds();wc.enableDeviceEmulation({screenPosition:'mobile',screenSize:{width:390,height:844},deviceScaleFactor:1,viewSize:{width:390,height:844},viewPosition:{x:0,y:0},scale:Math.min(b.width/390,b.height/844,1)});}else wc.disableDeviceEmulation();
      return {device:state.device};
    }
    if(tool==='devtools'&&wc.debugger.isAttached()){wc.debugger.detach();if(state.inspectListener)wc.debugger.removeListener('message',state.inspectListener);state.inspectListener=null;}
    if(tool==='devtools'){wc.openDevTools({mode:'detach'});return {opened:true};}
    if(tool==='css')return inspector(view,win).open();
    if(tool==='select')return inspector(view,win).pick();
    fail('未知预览工具');
  }
  ipcMain.handle('workspace:action', async (event, action, payload = {}) => {
    let state; let locked = false;
    try {
      const win = trustedWindow(event);
      if (!win || win.isDestroyed()) fail('窗口不可用');
      state = getState(win);
      let generation = state.generation;
      const check = () => { if (trustedWindow(event) !== win || win.isDestroyed() || state.generation !== generation) fail('窗口已变化，请重试'); };
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('操作参数无效');
      if (['choose', 'permission', 'terminal', 'model-tools'].includes(action)) {
        if (state.busy || state.child) fail('正在处理工作区操作，请稍后重试');
        state.busy = true; locked = true;
      }
      let data;
      switch (action) {
        case 'state': data = snapshot(state); break;
        case 'choose': {
          if (isChatBusy?.()) fail('请等待当前消息完成后切换工作区');
          const result = await dialog.showOpenDialog(win, { title: '选择工作区（文件内容可发送到所选模型服务；仅选择愿意分享的目录）', properties: ['openDirectory'] }); check();
          if (!result.canceled && result.filePaths.length) {
            const root = fs.realpathSync(result.filePaths[0]);
            if (!fs.statSync(root).isDirectory() || root.split(/[\\/]/).some(sensitiveName)) fail('不能选择受保护目录');
            if (isChatBusy?.()) fail('请等待当前消息完成后切换工作区');
            await onContextChange?.(win); check();
            if (isChatBusy?.()) fail('请求已开始，请稍后重试');
            await onRootChosen?.(root); check();
            state.root = root; generation = ++state.generation;
          }
          data = snapshot(state); break;
        }
        case 'model-tools': fail('独立模型工具开关已移除，请使用统一权限'); break;
        case 'permission': {
          if (isChatBusy?.()) fail('请等待当前消息完成后更改权限');
          if (!PERMISSIONS.has(payload.permission)) fail('权限必须为 read、write 或 full');
          if (payload.permission !== 'read') resolveWorkspacePath(state.root);
          if (payload.permission === 'full' && state.permission !== 'full') {
            const ok = await confirmWithUser(win, state, { title: '允许完整权限？', message: '模型可读取和修改工作区外文件，并执行命令，无需逐次确认。', detail: '没有操作系统沙箱；命令拥有当前用户的文件、进程和网络权限，可能访问敏感数据。文件工具的受保护状态路径、链接检查、预算与日志仍保留，但不能约束任意命令。切换模型或目录保留权限；本会话记住所选权限，关闭客户端后再打开该会话仍会恢复。', confirm: '允许完整权限' }); check();
            if (!ok) fail('已取消权限变更');
          }
          if (isChatBusy?.()) fail('请求已开始，请稍后重试');
          if (state.permission !== payload.permission) {
            await onContextChange?.(win); check();
            if (isChatBusy?.()) fail('请求已开始，请稍后重试');
            generation = ++state.generation;
          }
          state.permission = payload.permission;
          // Remember only a selection the user actually completed; a failed write keeps the current tier.
          await onPermissionChange?.(win, state.permission);
          data = snapshot(state); break;
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
        case 'deliverable-read': data = readDeliverable(state.root,payload.path); break;
        case 'deliverable-preview': {
          const file = readDeliverable(state.root,payload.path);
          if (!/\.html?$/i.test(file.relative)) fail('仅HTML支持运行预览');
          closeBrowser(win,state);
          const view = createBrowser(win,state,true);view.previewPath=file.relative;
          const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; font-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">`;
          await view.webContents.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(csp+file.content));check();
          data = {relative:file.relative};break;
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
          if (!state.root || state.permission === 'read') fail('请先选择工作区并启用工作区写入或完全访问');
          const command = payload.command;
          if (typeof command !== 'string' || !command.trim() || command.length > 8192 || command.includes('\0')) fail('命令须为 1–8192 字符');
          resolveWorkspacePath(state.root);
          const ok = state.permission === 'full' || await confirmWithUser(win, state, { title: '确认执行命令', message: '此命令没有操作系统沙箱，以当前用户权限执行，可访问工作区外及网络。', detail: `工作目录：${state.root}\n\n${command}\n\n单次非交互进程；30 秒超时，输出最多 128 KiB。`, confirm: '执行命令' }); check();
          if (!ok) fail('已取消命令');
          resolveWorkspacePath(state.root); data = await runCommand(state, command); break;
        }
        case 'browser-open': {
          const url = safeURL(payload.url);
          closeBrowser(win,state);
          const view = createBrowser(win, state);
          await view.webContents.loadURL(url); check();
          if (state.view !== view) fail('浏览器已关闭');
          data = { url: view.webContents.getURL() }; break;
        }
        case 'browser-tab': {
          if(typeof payload.id!=='string'||!/^[a-z0-9-]{1,80}$/i.test(payload.id))fail('页签无效');
          if(payload.close){
            if(payload.id===state.browserTab){closeBrowser(win,state);}else{const saved=state.browserTabs.get(payload.id);if(saved){const active=state.view,device=state.device;state.view=saved.view;closeBrowser(win,state);state.view=active;state.device=device;state.browserTabs.delete(payload.id);}}
          }else if(payload.id!==state.browserTab){
            if(state.view?.webContents.debugger.isAttached())state.view.webContents.debugger.detach();
            state.view?.setVisible(false);state.browserTabs.set(state.browserTab,{view:state.view,device:state.device});
            const saved=state.browserTabs.get(payload.id);state.browserTabs.delete(payload.id);state.view=saved?.view||null;state.device=saved?.device||false;state.browserTab=payload.id;
          }
          data={id:state.browserTab};break;
        }
        case 'browser-bounds': {
          if (!state.view && payload.visible === false) { data = { visible: false }; break; }
          const bounds = safeBounds(payload, win.getContentSize());
          if (!state.view) fail('浏览器尚未打开');
          const old=state.view.getBounds();if(old.width!==bounds.width||old.height!==bounds.height)state.view.setVisible(false);
          state.view.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
          state.view.setVisible(bounds.visible);state.view.webContents.invalidate(); data = { visible: bounds.visible, bounds:state.view.getBounds() }; break;
        }
        case 'browser-inspect': {
          if(!state.view)fail('请先打开预览');data=await inspector(state.view,win).action(payload);break;
        }
        case 'browser-tool': {
          if(!['select','css','device','devtools'].includes(payload.tool))fail('未知预览工具');
          data=await previewTool(win,state,payload.tool);break;
        }
        case 'browser-tools-menu': {
          if(!state.view)fail('请先打开HTML预览或网页');
          const {Menu}=require('electron');
          const selected=await new Promise(resolve=>{let choice=null;const menu=Menu.buildFromTemplate([
            {label:'选择元素',click:()=>{choice='select';}},
            {label:'CSS 检查器',click:()=>{choice='css';}},
            {label:'Device Toolbar（设备模拟）',type:'checkbox',checked:!!state.device,click:()=>{choice='device';}},
            {label:'DevTools',click:()=>{choice='devtools';}},
          ]);menu.popup({window:win,callback:()=>resolve(choice)});});check();
          data=selected?await previewTool(win,state,selected):null;break;
        }
        case 'browser-back':
          if (!state.view) fail('浏览器尚未打开');
          if (state.view.webContents.navigationHistory.canGoBack()) state.view.webContents.navigationHistory.goBack();
          data = null; break;
        case 'browser-reload':
          if (!state.view) fail('浏览器尚未打开');
          state.view.webContents.reload(); data = null; break;
        case 'browser-close': closeBrowser(win, state); data = null; break;
        case 'confirm-response': {
          const pending = state.pendingConfirm;
          if (pending && typeof payload.id === 'string' && payload.id === pending.id) pending.settle(payload.ok === true);
          data = null; break;
        }
        default: fail('未知工作区操作');
      }
      check(); return { ok: true, data };
    } catch (error) { return { ok: false, error: error instanceof WorkspaceError ? error.message : '工作区操作失败：来源不可信、路径不可访问或操作未完成' }; }
    finally { if (locked && state) state.busy = false; }
  });
  return api;
}
module.exports = { readDeliverable, installWorkspace, safeRelative, sensitiveName, resolveWorkspacePath, safeURL, safeBounds, shellEnvironment };
