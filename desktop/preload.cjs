const { contextBridge, ipcRenderer } = require("electron");

const allowedActions = new Set(["min", "max", "close", "reset", "new", "fullscreen"]);

contextBridge.exposeInMainWorld("personalAgentDesktop", {
  platform: process.platform,
  desktopAction(action) { return ipcRenderer.invoke('desktop:edit', action); },
  desktopCopy(text) { return ipcRenderer.invoke('desktop:copy', text); },
  workspace(action, payload) { return ipcRenderer.invoke('workspace:action', action, payload); },
  listSessions() { return ipcRenderer.invoke("sessions:list"); },
  sendEcho(input) { return ipcRenderer.invoke("runtime:echo", input); },
  getProvider(selection) {
    if (selection === undefined) return ipcRenderer.invoke("runtime:provider");
    if (!selection || typeof selection.id !== 'string' || typeof selection.model !== 'string') return Promise.reject(new Error('Invalid model selection'));
    return ipcRenderer.invoke("runtime:provider", { id: selection.id, model: selection.model });
  },
  providerSettings(action, payload) { return ipcRenderer.invoke("providers:settings", action, payload); },
  sendModel(input, token) { return ipcRenderer.invoke("runtime:model", input, token); },
  sendChat(input, token) { return ipcRenderer.invoke('chat:send', input, token); },
  sendTask(input, token, revision) { if(typeof revision!=='string'||! /^[a-f0-9]{64}$/.test(revision))return Promise.reject(new Error('Invalid task revision'));return ipcRenderer.invoke('chat:send', input, token, {taskRevision:revision}); },
  task(action, payload) { return ipcRenderer.invoke('desktop:task', action, payload); },
  switchChatModel(token) { return ipcRenderer.invoke('chat:switch-model', token); },
  resetChat() { return ipcRenderer.invoke('chat:reset'); },
  stopChat() { return ipcRenderer.invoke('chat:stop'); },
  onChatStream(callback) {
    if(typeof callback!=='function')return ()=>{};
    const listener=(_event,p)=>{if(p&&Number.isSafeInteger(p.token)&&typeof p.responseId==='string'&&typeof p.text==='string')callback(p);};
    ipcRenderer.on('chat:stream',listener);return ()=>ipcRenderer.removeListener('chat:stream',listener);
  },
  onChatActivity(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('chat:activity', listener);
    return () => ipcRenderer.removeListener('chat:activity', listener);
  },
  memory(action, payload) { return ipcRenderer.invoke('desktop:memory', action, payload); },
  capabilities(action, payload) { return ipcRenderer.invoke('desktop:capabilities', action, payload); },
  manageChat(action, payload) { return ipcRenderer.invoke('chat:manage', action, payload); },
  onChatManaged(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('chat:managed', listener);
    return () => ipcRenderer.removeListener('chat:managed', listener);
  },
  listChats() { return ipcRenderer.invoke('chat:list'); },
  openChat(id) { return ipcRenderer.invoke('chat:open', id); },
  readHistory(id) { return ipcRenderer.invoke("sessions:history", id); },
  async getInfo() {
    const info = await ipcRenderer.invoke("desktop:info");
    return { ...info, sandboxed: process.sandboxed === true, contextIsolated: process.contextIsolated === true };
  },
  windowAction(action) {
    if (!allowedActions.has(action)) {
      return Promise.resolve({ ok: false, maximized: false });
    }
    return ipcRenderer.invoke("window:action", action);
  },
  onWorkspaceInspect(callback) {
    if(typeof callback!=='function')return ()=>{};
    const listener=(_event,payload)=>callback(payload);ipcRenderer.on('workspace:inspect',listener);return ()=>ipcRenderer.removeListener('workspace:inspect',listener);
  },
  onWorkspaceConfirm(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("workspace:confirm", listener);
    return () => ipcRenderer.removeListener("workspace:confirm", listener);
  },
  onMaximized(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, maximized) => callback(Boolean(maximized));
    ipcRenderer.on("window:maximized", listener);
    return () => ipcRenderer.removeListener("window:maximized", listener);
  },
});
