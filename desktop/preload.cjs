const { contextBridge, ipcRenderer } = require("electron");

const allowedActions = new Set(["min", "max", "close", "reset", "new", "fullscreen"]);

contextBridge.exposeInMainWorld("personalAgentDesktop", {
  platform: process.platform,
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
  resetChat() { return ipcRenderer.invoke('chat:reset'); },
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
