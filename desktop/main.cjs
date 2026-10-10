const { app, BrowserWindow, ipcMain, session, safeStorage, dialog, WebContentsView, clipboard, shell } = require('electron');
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
  let closing = false;
  win.on('close', event => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    void stopConversation(win.webContents).then(() => win.close()).catch(() => {
      closing = false;
      console.error('Desktop close postponed: session processes could not be stopped');
    });
  });
  win.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) void stopConversation(win.webContents).catch(() => console.error('Session process cleanup failed'));
  });
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

const chatIndex = require('./chat-index.cjs');
const workspace = require('./workspace.cjs').installWorkspace({ ipcMain, dialog, WebContentsView, session, trustedWindow,
  onRootChosen: root => chatIndex.rememberWorkspace(sessionHome, root), isChatBusy: () => modelBusy,
  // Persist per session so switching back or restarting restores what the user picked.
  onPermissionChange: (win, permission) => { const conversation = conversations.get(win.webContents); return conversation && !conversation.readOnly ? chatIndex.setPermission(sessionHome, conversation.id, permission).catch(() => {}) : undefined; },
  onContextChange: win => stopConversation(win.webContents,true) });

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
let settingsBusy = false, switchingModel = false;
ipcMain.handle('providers:settings', async (event, action, payload) => {
  trustedWindow(event);
  if (!['list', 'save', 'delete', 'discover', 'test-tools'].includes(action)) return { ok: false, error: '未知配置操作' };
  if (action !== 'list' && (settingsBusy || switchingModel)) return { ok: false, error: '正在处理配置请求，请稍后重试' };
  if (action !== 'list') settingsBusy = true;
  try {
    const service = await providers(); trustedWindow(event);
    let data;
    if (action === 'test-tools') {
      if (!payload || typeof payload.id !== 'string' || typeof payload.model !== 'string') throw Error('invalid selection');
      const config = await service.resolve(payload.id, payload.model); trustedWindow(event);
      const { probeDesktopTools } = await import('../src/desktop-tool-probe.ts');
      data = await probeDesktopTools(config);
    } else data = action === 'list' ? await service.list() : await service[action](payload);
    trustedWindow(event); return { ok: true, data };
  } catch (e) {
    const { ProviderError } = await import('../src/desktop-providers.ts');
    return { ok: false, error: e instanceof ProviderError ? e.message : '配置操作失败；请检查文件权限、系统加密或配置完整性。原始内容已隐藏。' };
  } finally { if (action !== 'list') settingsBusy = false; }
});

const providerPreviews = new WeakMap();
let providerSequence = 0;
// ponytail: one global model request; use per-window locks only if parallel turns are needed.
let modelBusy = false;
const conversations = new WeakMap();
const chatRuns = new WeakMap();
const chatSettlements = new WeakMap();
let capabilityService, skillPackageService;
async function capabilities() {
  return capabilityService ??= import('../src/desktop-capabilities.ts').then(m => m.createDesktopCapabilities(sessionHome, safeStorage));
}
async function skillPackages() {
  return skillPackageService ??= import('../src/skill-packages.ts').then(m => m.createSkillPackages(sessionHome));
}
ipcMain.handle('desktop:memory', async (event, action, payload = {}) => {
  const win = trustedWindow(event), root = workspace.getRoot(win);
  if (!['list','save','remove','toggle','clear'].includes(action) || !payload || typeof payload !== 'object') return {ok:false,error:'未知记忆操作'};
  if (action !== 'list' && modelBusy) return {ok:false,error:'请等待当前任务结束再修改记忆'};
  if (action !== 'list') modelBusy = true;
  try {
    const { createDesktopMemory } = await import('../src/desktop-memory.ts');
    const service = createDesktopMemory(sessionHome); let data;
    const check = () => { trustedWindow(event); if (workspace.getRoot(win) !== root) throw Error('工作区已变化'); };
    check();
    if (action === 'list') data = await service.list();
    else if (action === 'save') {
      if (!payload.entry || !['global','workspace'].includes(payload.entry.scope)) throw Error('invalid memory');
      if (payload.entry.scope === 'workspace' && !root) throw Error('select workspace');
      const previous = (await service.list()).entries.find(e=>e.id===payload.entry.id);
      if(previous?.scope==='workspace' && previous.workspaceRoot!==root) throw Error('先选择记忆所属工作区再编辑');
      check();
      data = await service.save({id:payload.entry.id,text:payload.entry.text,scope:payload.entry.scope,enabled:payload.entry.enabled,
        ...(payload.entry.scope === 'workspace' ? {workspaceRoot:root} : {})},payload.revision);
    } else if (action === 'toggle') data = await service.toggle(payload.id,payload.enabled,payload.revision);
    else {
      const answer = await dialog.showMessageBox(win,{type:'warning',message:action==='clear'?'清空全部已保存记忆？':'删除这条记忆？',detail:'删除后不再注入新请求；已发送给模型的内容和历史记录不会被撤回。',buttons:['取消','删除'],defaultId:0,cancelId:0});
      check(); if (answer.response!==1) return {ok:true,data:await service.list()};
      data = action==='clear'?await service.clear(payload.revision):await service.remove(payload.id,payload.revision);
    }
    check();return {ok:true,data,workspaceRoot:root};
  } catch (error) {
    const { DesktopMemoryError } = await import('../src/desktop-memory.ts');
    return {ok:false,error:error instanceof DesktopMemoryError?error.message:'记忆操作失败，请刷新并检查工作区或文件完整性；原始内容已隐藏'};
  } finally { if(action!=='list')modelBusy=false; }
});
async function taskService() { return (await import('../src/desktop-tasks.ts')).createDesktopTasks(sessionHome); }
ipcMain.handle('desktop:task', async (event, action, payload = {}) => {
  const win=trustedWindow(event), conversation=conversations.get(event.sender);
  if(!['get','configure','finish','remove'].includes(action)||!payload||typeof payload!=='object')return {ok:false,error:'未知任务操作'};
  if(!conversation||conversation.readOnly)return {ok:false,error:'请先发送一条消息或打开可续聊的会话'};
  if(action!=='get'&&modelBusy)return {ok:false,error:'请先停止当前运行'};
  if(action!=='get')modelBusy=true;
  try {
    const service=await taskService();trustedWindow(event);let data;
    if(action==='get'){data=await service.get(conversation.id);if(data.task?.status==='running'&&![...chatRuns.keys()].some(sender=>conversations.get(sender)?.id===conversation.id))data=await service.recover(conversation.id);}
    else if(action==='configure')data=await service.configure(conversation.id,{objective:payload.objective,maxRounds:payload.maxRounds,criteria:payload.criteria,plan:payload.plan},payload.revision);
    else if(action==='remove')data=await service.remove(conversation.id,payload.revision);
    else {const answer=await dialog.showMessageBox(win,{type:'question',message:'确认此目标已经完成？',detail:'这是你的人工确认，不等于自动测试通过。请先检查文件、工具结果和交付物。',buttons:['取消','确认完成'],defaultId:0,cancelId:0});trustedWindow(event);if(answer.response!==1)return {ok:true,data:await service.get(conversation.id)};data=await service.finish(conversation.id,payload.revision);}
    const {SessionStore}=await import('../src/session-store.ts');const plan=await new SessionStore({root:sessionHome,maxReadBytes:1024*1024}).taskState(conversation.id);
    trustedWindow(event);return {ok:true,data:{...data,plan:plan?{state:plan.state,steps:plan.steps}:null}};
  }catch(e){const {DesktopTaskError}=await import('../src/desktop-tasks.ts');return {ok:false,error:e instanceof DesktopTaskError?e.message:'任务读取或修改失败；原记录保留'};}
  finally{if(action!=='get')modelBusy=false;}
});
const oauthRuns=new Map();
const capabilityOwner = sender => 'desktop-window-' + sender.id;
async function stopConversation(sender,preserveRemote=false) {
  oauthRuns.get(sender)?.controller.abort();
  const run = chatRuns.get(sender), settled = chatSettlements.get(sender); run?.abort();
  const id = conversations.get(sender)?.id;
  await settled;
  const jobs = id ? await (await import('../src/background-jobs.ts')).stopJobs(id) : 0;
  if (capabilityService) await (await capabilityService).closeOwner(capabilityOwner(sender),preserveRemote);
  return { ok: true, stopped: !!run || jobs > 0 };
}
ipcMain.handle('chat:stop', async event => {
  trustedWindow(event);
  const result = await stopConversation(event.sender);
  trustedWindow(event); return result;
});
ipcMain.handle('desktop:capabilities', async (event, action, payload = {}) => {
  const win = trustedWindow(event);
  if(action==='oauthstatus')return {ok:true,data:oauthRuns.get(event.sender)?.progress||null};
  if(action==='oauthcancel'){oauthRuns.get(event.sender)?.controller.abort();return {ok:true,data:null};}
  const actions = ['oauthstart','oauthforget','list','skillsave','skillremove','skillenable','serversave','serverremove','connect','disconnect','packages','packageimport','packageenable','packageremove','mcpget','mcpsave','plugins','pluginconfigure','pluginconnect'];
  const readOnly = ['list','packages','mcpget','plugins'].includes(action);
  if (!actions.includes(action) || !payload || typeof payload !== 'object') return {ok:false,error:'未知能力管理操作'};
  if (!readOnly && modelBusy) return {ok:false,error:'请等待当前聊天或管理操作完成'};
  if (!readOnly) modelBusy = true;
  const authAttempt=action==='oauthstart'?{controller:new AbortController(),progress:{message:'正在准备浏览器授权…'}}:null;
  const authAbort=()=>authAttempt?.controller.abort(),authNavigate=(_e,_url,inPlace,mainFrame)=>{if(mainFrame&&!inPlace)authAbort();};
  if(authAttempt){oauthRuns.set(event.sender,authAttempt);win.once('closed',authAbort);event.sender.on('did-start-navigation',authNavigate);}
  try {
    const service = await capabilities(), owner = capabilityOwner(event.sender), root = workspace.getRoot(win);
    const check = () => { trustedWindow(event);authAttempt?.controller.signal.throwIfAborted(); if (workspace.getRoot(win) !== root) throw Error('工作区已变化'); };
    check();
    if(action==='oauthforget'){
      const answer=await dialog.showMessageBox(win,{type:'warning',buttons:['取消','清除本地授权'],defaultId:0,cancelId:0,message:'断开并清除本机 OAuth 令牌？',detail:'此操作不代表服务商已撤销授权。要彻底撤销，请到服务商的已授权应用页面移除 Personal Agent / 你注册的应用。'});check();if(answer.response===1)await service.forgetOAuth(payload.id);return {ok:true,data:null};
    }
    if(action==='oauthstart'){

      let resource,serverId;
      if(payload.packageId){const pack=(await (await skillPackages()).plugins()).find(p=>p.id===payload.packageId),c=pack?.connectors.find(c=>c.key===payload.connectorKey);if(!c?.supported)return {ok:false,error:'插件连接声明不受支持'};resource=c.url;serverId=c.serverId;}
      else {const configured=(await service.list(owner,root)).servers.find(s=>s.id===payload.id);if(configured?.type!=='http')return {ok:false,error:'OAuth 仅支持已配置的 HTTP 服务'};resource=configured.url;serverId=configured.id;}
      check();const config=await service.getMcpConfig();if(config.revision!==payload.revision)return {ok:false,error:'配置已变化，请重新打开授权'};
      // The OAuth form's explicit submit is consent; do not ask again in a native dialog.
      check();
      const run=authAttempt,controller=run.controller;run.progress={message:'正在获取 OAuth 授权信息…'};
      try{
        const checkAuth=()=>{check();controller.signal.throwIfAborted();};
        const saved=await service.authorize(owner,resource,serverId,payload.clientId||'',payload.scope||'',config.revision,{signal:controller.signal,progress:p=>{run.progress=p;},openBrowser:async url=>{checkAuth();await shell.openExternal(url);checkAuth();}});
        checkAuth();
        run.progress={message:'授权已保存，正在连接 MCP 并发现工具…'};
        try{await service.connect(owner,root,serverId,saved.revision,controller.signal);checkAuth();return {ok:true,data:{authorized:true,connected:true}};}
        catch{checkAuth();return {ok:true,data:{authorized:true,connected:false,connectionFailed:true}};}
      }finally{controller.abort();}
    }
    if(['plugins','pluginconfigure','pluginconnect'].includes(action)){
      const items=await (await skillPackages()).plugins(action!=='plugins');check();
      if(action==='plugins')return {ok:true,data:items};
      const pack=items.find(p=>p.id===payload.packageId), connector=pack?.connectors.find(c=>c.key===payload.connectorKey);
      if(!connector?.supported)return {ok:false,error:'连接声明不受支持，请检查插件说明'};
      if(action==='pluginconfigure'){
        if(typeof payload.token!=='string'||payload.token.length>8192||/[\r\n]/.test(payload.token)||connector.needsToken&&!payload.token.trim())return {ok:false,error:'请填写你本人授权的令牌；不能使用 TRAE 占位符'};
        const config=await service.getMcpConfig(),json=JSON.parse(config.json);
        if(config.revision!==payload.revision)return {ok:false,error:'MCP 配置已变化，请重新打开配置'};
        json.mcpServers[connector.serverId]={type:'http',url:connector.url,...(payload.token?{headers:{Authorization:'Bearer '+payload.token}}:{})};
        await service.saveMcpConfig(JSON.stringify(json),config.revision);check();return {ok:true,data:await service.list(owner,root)};
      }
      const configured=(await service.list(owner,root)).servers.find(s=>s.id===connector.serverId);
      if(!configured||configured.type!=='http'||configured.url!==connector.url)return {ok:false,error:'请先配置此插件的连接；配置地址必须与已校验的插件声明一致'};
      payload={id:connector.serverId};action='connect';
    }
    if (['packages','packageimport','packageenable','packageremove'].includes(action)) {
      const packages = await skillPackages(); check();
      if (action === 'packageimport') {
        if (!['folder','zip','file'].includes(payload.kind)) return {ok:false,error:'请选择文件夹、ZIP 或 SKILL.md'};
        const choice = await dialog.showOpenDialog(win,{title:'导入技能 / 插件（包含配套资源）',properties:[payload.kind === 'folder' ? 'openDirectory' : 'openFile'],
          ...(payload.kind === 'folder' ? {} : {filters:[{name:payload.kind === 'zip' ? '技能 ZIP' : '技能文档',extensions:[payload.kind === 'zip' ? 'zip' : 'md']}]})});
        check(); if (choice.canceled || choice.filePaths.length !== 1) return {ok:true,cancelled:true,data:await packages.list()};
        const confirm = await dialog.showMessageBox(win,{type:'warning',buttons:['取消','导入并启用'],defaultId:0,cancelId:0,message:'将技能安装到当前 Agent 的全局插件目录？',
          detail:choice.filePaths[0]+'\n保留技能及资源，在所有工作区可用。技能内容可能发送给模型；导入不会运行脚本、安装软件、连接 MCP 或扩大工具权限。请仅导入可信内容。'});
        check(); if (confirm.response !== 1) return {ok:true,cancelled:true,data:await packages.list()};
        await packages.importPath(choice.filePaths[0]);
      } else if (action === 'packageenable') await packages.enable(payload.id,payload.enabled);
      else if (action === 'packageremove') {
        const before = await packages.list(); check(); const item = before.packages.find(p=>p.id===payload.id); if (!item) throw Error('插件不存在');
        const confirm = await dialog.showMessageBox(win,{type:'warning',buttons:['取消','删除'],defaultId:0,cancelId:0,message:'删除本 Agent 中的插件和技能资源？',detail:item.name+'\n不删除原始导入文件，不影响 TRAE。独立 MCP 配置与连接不会随包删除；如需移除请先在插件卡片中断开并删除连接配置，或到 MCP 页管理。'});
        check(); if (confirm.response !== 1) return {ok:true,cancelled:true,data:before}; await packages.remove(item.id);
      }
      check(); return {ok:true,data:await packages.list()};
    }
    if (action === 'mcpget') { const data=await service.getMcpConfig(); check(); return {ok:true,data}; }
    if (action === 'mcpsave') { const data=await service.saveMcpConfig(payload.json,payload.revision); check(); return {ok:true,data}; }
    if (['skillremove','serverremove','connect'].includes(action)) {
      const before = await service.list(owner,root); check();
      const item = (action === 'skillremove' ? before.skills : before.servers).find(item => item.id === payload.id);
      if (!item) throw Error('配置不存在');
      if (action === 'connect' && item.type !== 'http' && (!root || workspace.getPermission(win) === 'read')) return {ok:false,error:'连接 MCP 需要选择工作区写入或完全访问权限'};
      const answer = await dialog.showMessageBox(win,{type:'warning',buttons:['取消',action === 'connect' ? '启动并连接' : '删除配置'],defaultId:0,cancelId:0,
        message:action === 'connect' ? (item.type === 'http' ? '连接远程 MCP 服务？' : '启动本地 MCP 服务器？') : '删除此配置？',
        detail:action === 'connect' ? (item.type === 'http' ? `${item.url}\n此服务会收到工具调用参数和单独配置的凭据，工具结果会发送给模型并保存历史。不会转移 TRAE 的登录状态。停止仅断开客户端，不能撤销远程已发生的操作。` : `${item.command}\n参数：${JSON.stringify(item.args)}\n目录：${item.cwd || root}\n进程拥有当前用户权限，没有 OS 沙箱；可能访问文件和网络。工具结果会发送给模型。只批准这次启动，不自动重连。`) : item.id});
      check();
      if (answer.response !== 1) return {ok:true,cancelled:true,data:{...(await service.list(owner,root)),permission:workspace.getPermission(win)}};
      if (action === 'connect') { if (item.type !== 'http' && workspace.getPermission(win) === 'read') throw Error('权限已变化'); await service.connect(owner,root,payload.id,item.revision); }
      else if (action === 'skillremove') await service.removeSkill(payload.id);
      else await service.removeServer(payload.id);
    } else if (action === 'skillsave') await service.saveSkill(payload.skill);
    else if (action === 'skillenable') { if (!root) throw Error('请先选择工作区'); await service.enableSkill(root,payload.id,payload.enabled); }
    else if (action === 'serversave') await service.saveServer(payload.server);
    else if (action === 'disconnect') await service.disconnect(owner,payload.id);
    check(); return {ok:true,data:{...(await service.list(owner,root)),permission:workspace.getPermission(win)}};
  } catch (error) {
    const { McpConfigError } = await import('../src/desktop-capabilities.ts');
    const { SkillPackageError } = await import('../src/skill-packages.ts');
    return {ok:false,error:error instanceof McpConfigError || error instanceof SkillPackageError ? error.message : '操作未完成，请检查配置格式、文件完整性、绝对路径、工作区或服务器响应；原始错误内容已隐藏。'};
  }
  finally {if(authAttempt){authAttempt.controller.abort();win.removeListener('closed',authAbort);event.sender.removeListener('did-start-navigation',authNavigate);if(oauthRuns.get(event.sender)===authAttempt)oauthRuns.delete(event.sender);} if (!readOnly) modelBusy = false; }
});
ipcMain.handle('chat:manage', async (event, action, payload = {}) => {
  const win = trustedWindow(event);
  if (!['rename','pin','delete','export'].includes(action) || !payload || typeof payload !== 'object') return {ok:false,error:'未知会话管理操作'};
  if (modelBusy) return {ok:false,error:'请等待当前请求或管理操作完成'};
  modelBusy = true;
  try {
    const entry = chatIndex.find(sessionHome,payload.id);
    if (!entry) throw Error('会话不存在或为旧版只读历史');
    const service = await import('../src/desktop-session-management.ts'); trustedWindow(event);
    let data;
    if (action === 'rename') data = await service.renameSession(sessionHome,entry.id,payload.title);
    else if (action === 'pin') data = await service.pinSession(sessionHome,entry.id,payload.pinned);
    else if (action === 'delete') {
      const answer = await dialog.showMessageBox(win,{type:'warning',buttons:['取消','删除会话'],defaultId:0,cancelId:0,message:'删除此会话及本地历史？',detail:entry.title+'\n删除不可撤销，但不会删除工作区文件；后台任务会停止。'});
      trustedWindow(event); if (answer.response !== 1) return {ok:true,cancelled:true};
      for (const other of windows) if (conversations.get(other.webContents)?.id === entry.id) await stopConversation(other.webContents);
      trustedWindow(event); data = await service.deleteSession(sessionHome,entry.id);
      for (const other of windows) if (conversations.get(other.webContents)?.id === entry.id) { conversations.delete(other.webContents); providerPreviews.delete(other.webContents); }
    } else {
      const exported = await service.exportSession(sessionHome,entry.id,payload.format || 'markdown'); trustedWindow(event);
      const chosen = await dialog.showSaveDialog(win,{title:'导出会话（包含消息与工具内容）',defaultPath:exported.filename,filters:[{name:'会话文件',extensions:[payload.format === 'json' ? 'json' : 'md']}],properties:['showOverwriteConfirmation']});
      trustedWindow(event); if (chosen.canceled || !chosen.filePath) return {ok:true,cancelled:true};
      const fs = require('node:fs/promises'), target = path.resolve(chosen.filePath), home = path.resolve(sessionHome);
      const relative = path.relative(home,target);
      if (relative === '' || (!relative.startsWith('..'+path.sep) && !path.isAbsolute(relative))) throw Error('禁止导出到Agent状态目录');
      let cursor = path.dirname(target);
      for (;;) { const s = await fs.lstat(cursor); if (!s.isDirectory() || s.isSymbolicLink()) throw Error('导出目录不安全'); const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent; }
      trustedWindow(event);
      // Never overwrite an existing file, even if the native dialog selected it.
      await fs.writeFile(target,exported.content,{flag:'wx',mode:0o600}); data = {exported:true};
    }
    trustedWindow(event);
    for (const other of windows) if (!other.isDestroyed()) other.webContents.send('chat:managed',{action,id:entry.id,title:action === 'rename' ? payload.title.trim() : entry.title});
    return {ok:true,data};
  } catch (_) { return {ok:false,error:'会话操作未完成。请检查名称、历史完整性和文件权限；导出请使用尚不存在的新文件名。'}; }
  finally { modelBusy = false; }
});
ipcMain.handle('chat:list', async event => {
  trustedWindow(event);
  const indexed = chatIndex.list(sessionHome);
  const { desktopSessions } = await import('../src/desktop-sessions.ts');
  const old = await desktopSessions(sessionHome); trustedWindow(event);
  const known = new Set(indexed.sessions.map(s => s.id));
  return { ...indexed, activeSessionId: conversations.get(event.sender)?.id || null, sessions: [...indexed.sessions.map(s => ({ ...s, indexed: true })), ...old.ids.filter(id => !known.has(id)).map(id => ({ id, title: id, workspaceRoot: null, updatedAt: '', failed: true, indexed: false }))] };
});
ipcMain.handle('chat:open', async (event, id) => {
  const win = trustedWindow(event);
  if (modelBusy) throw Error('请等待当前消息完成');
  modelBusy = true;
  try {
    const { desktopHistory } = await import('../src/desktop-sessions.ts');
    const history = await desktopHistory(sessionHome, id); trustedWindow(event);
    if (conversations.get(event.sender)?.id !== id) { await stopConversation(event.sender,true); trustedWindow(event); }
    else if (capabilityService) { await (await capabilityService).closeOwner(capabilityOwner(event.sender),true); trustedWindow(event); }
    const entry = chatIndex.find(sessionHome, id);
    let canResume = false, selection, identity = '', workspaceError = '';
    if (entry) {
      identity = entry.identity;
      try {
        const [providerId, baseUrl, model, revision] = JSON.parse(identity);
        selection = providerId ? { id: providerId, model } : undefined;
        const current = providerId ? await (await providers()).resolve(providerId, model, revision) : await (await import('../src/desktop-model.ts')).desktopProvider(sessionHome);
        trustedWindow(event);
        canResume = current.baseUrl === baseUrl && current.model === model;
      } catch { canResume = false; }
      {
        try { workspace.adoptRoot(win, entry.workspaceRoot, entry.permission); }
        catch { workspaceError = '原工作区不可用，请重新选择目录'; canResume = false; }
      }
    }
    trustedWindow(event);
    conversations.set(event.sender, { id, identity, failed: !!entry?.failed, readOnly: !entry }); providerPreviews.delete(event.sender);
    const jobs = await import('../src/background-jobs.ts'); trustedWindow(event);
    return { ...history, title: entry?.title || id, canResume, failed: !!entry?.failed, selection, identity, workspaceError,
      backgroundJobs: jobs.listJobs(id).filter(jobs.isRunning).length };
  } finally { modelBusy = false; }
});
ipcMain.handle('chat:reset', async event => {
  trustedWindow(event);
  if (modelBusy) throw new Error('请求进行中，暂不能新建会话');
  modelBusy = true;
  try {
    await stopConversation(event.sender,true); trustedWindow(event);
    conversations.delete(event.sender); providerPreviews.delete(event.sender);
    return { ok: true };
  } finally { modelBusy = false; }
});
ipcMain.handle('chat:switch-model', async (event, token) => {
  const win = trustedWindow(event);
  if (modelBusy) throw Error('请等待当前请求完成');
  const conversation = conversations.get(event.sender), preview = providerPreviews.get(event.sender);
  let invalidated = false;
  const navigation = (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) invalidated = true; };
  const check = () => {
    trustedWindow(event);
    if (invalidated || !conversation || conversation.readOnly || conversations.get(event.sender) !== conversation) throw Error('历史只读，请新建会话');
    if (!preview || preview.token !== token || providerPreviews.get(event.sender) !== preview || preview.expires < Date.now()) throw Error('模型预览已过期，请重新选择');
  };
  if (settingsBusy) throw Error('配置请求正在运行');
  check(); modelBusy = true; switchingModel = true;
  event.sender.on('did-start-navigation', navigation);
  try {
    const identity = JSON.stringify([preview.providerId, preview.baseUrl, preview.model, preview.revision]);
    const { desktopHistory } = await import('../src/desktop-sessions.ts');
    const validate = async () => {
      check();
      const entry = chatIndex.find(sessionHome, conversation.id);
      const history = await desktopHistory(sessionHome, conversation.id); check();
      if (!entry || entry.identity !== conversation.identity) throw Error('会话身份已变化，原会话保留');
      const current = preview.providerId ? await (await providers()).resolve(preview.providerId, preview.model, preview.revision) : await (await import('../src/desktop-model.ts')).desktopProvider(sessionHome);
      check();
      if (current.baseUrl !== preview.baseUrl || current.model !== preview.model || current.revision !== preview.revision) throw Error('模型配置已变化');
      return entry;
    };
    await validate();
    const before = JSON.parse(conversation.identity);
    if (!await workspace.confirmModelSwitch(win, `${before[2]} · ${before[1]}`, `${preview.model} · ${preview.baseUrl}`)) return { changed: false };
    const entry = await validate();
    // Recheck inside the index lease, after its asynchronous queue has settled.
    await chatIndex.remember(sessionHome, { ...entry, identity }, latest => {
      check();
      if (!latest || latest.identity !== entry.identity || latest.updatedAt !== entry.updatedAt) throw Error('会话已变化');
    });
    conversation.identity = identity; providerPreviews.delete(event.sender);
    return { changed: true, identity };
  } finally { event.sender.removeListener('did-start-navigation', navigation); modelBusy = false; switchingModel = false; }
});
ipcMain.handle('chat:send', async (event, input, token, control) => {
  trustedWindow(event);
  const taskRevision=control && typeof control==='object' && typeof control.taskRevision==='string' ? control.taskRevision : undefined;
  if (typeof input !== 'string' || !input.trim() || Buffer.byteLength(input) > 8192) throw new Error('请输入 1–8192 字节文本');
  const preview = providerPreviews.get(event.sender);
  if (!preview || preview.token !== token || preview.expires < Date.now()) throw new Error('请重新确认模型');
  if (modelBusy) throw new Error('模型请求正在运行');
  // No renderer-provided session IDs and no cross-provider transfer of existing history.
  const identity = JSON.stringify([preview.providerId, preview.baseUrl, preview.model, preview.revision]);
  let conversation = conversations.get(event.sender);
  if (conversation && (conversation.identity !== identity || conversation.readOnly)) throw new Error('会话只读或模型配置已变化；请显式确认模型切换，原会话保留');
  if (!conversation) {
    conversation = { identity, id: 'desktop-chat-' + require('node:crypto').randomUUID(), failed: false };
    conversations.set(event.sender, conversation);
  }
  providerPreviews.delete(event.sender); modelBusy = true;
  const controller = new AbortController(), win = trustedWindow(event);
  chatRuns.set(event.sender, controller);
  let settle;
  chatSettlements.set(event.sender, new Promise(resolve => { settle = resolve; }));
  const abort = () => controller.abort();
  const navigating = (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) abort(); };
  win.once('closed', abort); event.sender.on('did-start-navigation', navigating);
  try {
    const toolOptions = workspace.modelContext(win, controller.signal,true);
    const existing = chatIndex.find(sessionHome, conversation.id);
    if (existing && existing.workspaceRoot !== workspace.getRoot(win)) throw Error('工作区与会话不一致，请恢复原工作区；聊天未新建');
    await chatIndex.remember(sessionHome, { id: conversation.id, identity, title: existing?.title || input.trim().slice(0, 60), workspaceRoot: existing ? existing.workspaceRoot : workspace.getRoot(trustedWindow(event)), permission: workspace.getPermission(trustedWindow(event)), failed: true });
    trustedWindow(event);
    const { desktopModelSend } = await import('../src/desktop-model.ts');
    const selected = preview.providerId ? await (await providers()).resolve(preview.providerId, preview.model, preview.revision) : undefined;
    trustedWindow(event); controller.signal.throwIfAborted();
    if (toolOptions) {
      if (existing && existing.workspaceRoot !== (toolOptions.workspaceRoot||null)) throw Error('会话工作区已变化，请恢复原工作区');
      const check = toolOptions.check;
      toolOptions.check = () => { trustedWindow(event); if (chatRuns.get(event.sender) !== controller) throw Error('请求已过期'); check(); };
      toolOptions.onActivity = activity => { if (!controller.signal.aborted) { trustedWindow(event); event.sender.send('chat:activity', activity); } };
    }
    const service = await capabilities(); trustedWindow(event); controller.signal.throwIfAborted();
    const root = workspace.getRoot(win);
    const packages = await skillPackages();
    const extensions = { skills: root ? await service.skills(root) : [], tools: toolOptions ? await service.tools(capabilityOwner(event.sender), root, toolOptions.permission) : [],
      skillTools: toolOptions && root ? await packages.tools() : [], skillCatalog: toolOptions && root ? await packages.catalogPrompt() : '' };
    trustedWindow(event); controller.signal.throwIfAborted(); toolOptions?.check();
    let result;
    const {createDesktopTaskFlow}=await import('../src/desktop-task-flow.ts');
    const flow=await createDesktopTaskFlow(sessionHome,conversation.id,input,()=>{trustedWindow(event);controller.signal.throwIfAborted();toolOptions.check();});
    {
      let snapshot=flow.snapshot();
      if(taskRevision!==undefined){
      if(snapshot.revision!==taskRevision||!snapshot.task)throw Error('任务已变化');
      const answer=await dialog.showMessageBox(win,{type:'warning',message:'启动 / 恢复此长任务？',detail:`目标：${snapshot.task.objective}\n验收：${snapshot.task.criteria||'按目标检查'}\n计划：${snapshot.task.plan||'未单独制定计划'}\n${snapshot.task.maxRounds?`最多再执行 ${snapshot.task.maxRounds-snapshot.task.rounds} 轮`:'不设轮数上限'}，不设任务总时长和API/Token花费上限，可随时停止；可能持续计费和执行当前权限允许的操作。模型要求输入、报告待验收、工具失败或中断即停。重启后不会自动继续。`,buttons:['取消','开始'],defaultId:0,cancelId:0});
      trustedWindow(event);controller.signal.throwIfAborted();toolOptions.check();
      if(answer.response!==1){await chatIndex.markFailed(sessionHome,conversation.id,conversation.failed);return {id:conversation.id,content:'未启动长任务',model:preview.model,backgroundJobs:0};}
      await flow.manualStart(taskRevision);snapshot=flow.snapshot();}
      const results=[];let first=true;
      try {
        while(first||snapshot.task?.status==='running'){
          controller.signal.throwIfAborted();toolOptions.check();
          // Re-resolve identity each round; never continue under changed endpoint credentials/configuration.
          if(preview.providerId)await (await providers()).resolve(preview.providerId,preview.model,preview.revision);
          if((!first||taskRevision!==undefined)&&snapshot.task?.status==='running')await flow.beginRound();
          const prompt=first&&taskRevision===undefined?input:'继续已授权目标，先检查当前结果，勿重放旧操作；完成本轮后用 update_goal 报告下一步或验收证据。';
          const round=await desktopModelSend(sessionHome,prompt,preview,process.env,selected,conversation.id,toolOptions,controller.signal,{...extensions,onStream:chunk=>{if(!controller.signal.aborted&&chatRuns.get(event.sender)===controller){trustedWindow(event);event.sender.send('chat:stream',{...chunk,token});}},hostTools:flow.tools,planning:flow.planning(),beforeTool:flow.gate,taskGuidance:flow.guidance()});results.push(round);first=false;
          snapshot=await flow.endRound(!!round.error||!!round.toolStatus?.failed);
          if(snapshot.task)event.sender.send('chat:activity',{type:'long-task',round:snapshot.task.rounds,maxRounds:snapshot.task.maxRounds});
        }
        result=results.at(-1);if(!result)throw Error('No round');
        if(snapshot.task)result={...result,content:results.map((r,i)=>`第 ${i+1} 轮\n${r.error||r.content}`).join('\n\n')+`\n\n任务：${snapshot.task.status} · ${snapshot.task.reason}`,transcript:results.flatMap(r=>r.transcript||[]),task:snapshot};
      } finally {try{await flow.pause('执行已停止或中断；需手动恢复');}finally{if(flow.snapshot().task)await (await import('../src/background-jobs.ts')).stopJobs(conversation.id);}}
    }
    conversation.failed = !!result.error;
    await chatIndex.markFailed(sessionHome, conversation.id, conversation.failed);
    const jobs = await import('../src/background-jobs.ts');
    trustedWindow(event); return { ...result, backgroundJobs: jobs.listJobs(conversation.id).filter(jobs.isRunning).length };
  } catch (_) {
    conversation.failed = true;
    throw new Error('请求失败或已停止，模型请求可能已有限重试并计费，部分工具可能已执行；请检查历史和文件，不会自动重跑工具或回滚');
  } finally {
    win.removeListener('closed', abort); event.sender.removeListener('did-start-navigation', navigating);
    chatRuns.delete(event.sender); chatSettlements.delete(event.sender); modelBusy = false; settle();
  }
});
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

ipcMain.handle('desktop:copy', (event, text) => {
  trustedWindow(event);
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error('Copy text exceeds 1 MiB');
  clipboard.writeText(text);
  return { ok: true };
});

// Editing is scoped to the trusted shell's focused frame; no arbitrary method invocation.
ipcMain.handle('desktop:edit', (event, action) => {
  const win = trustedWindow(event);
  if (!['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'].includes(action)) throw new Error('Unknown edit action');
  win.webContents[action]();
  return { ok: true };
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
let jobsCleanedForQuit = false, quitCleanup;
app.on('before-quit', event => {
  if (jobsCleanedForQuit) return;
  event.preventDefault();
  for (const win of windows) chatRuns.get(win.webContents)?.abort();
  quitCleanup ??= Promise.all([...windows].map(win => stopConversation(win.webContents)))
    .then(() => import('../src/background-jobs.ts')).then(jobs => jobs.shutdownJobsAsync()).then(() => {
    jobsCleanedForQuit = true; app.quit();
  }).catch(() => { quitCleanup = undefined; console.error('Quit postponed: background process cleanup failed'); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
