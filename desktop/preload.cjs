const { contextBridge, ipcRenderer } = require("electron");

const allowedActions = new Set(["min", "max", "close", "reset", "new", "fullscreen"]);

contextBridge.exposeInMainWorld("personalAgentDesktop", {
  platform: process.platform,
  listSessions() { return ipcRenderer.invoke("sessions:list"); },
  sendEcho(input) { return ipcRenderer.invoke("runtime:echo", input); },
  getProvider() { return ipcRenderer.invoke("runtime:provider"); },
  sendModel(input, token) { return ipcRenderer.invoke("runtime:model", input, token); },
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
  onMaximized(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, maximized) => callback(Boolean(maximized));
    ipcRenderer.on("window:maximized", listener);
    return () => ipcRenderer.removeListener("window:maximized", listener);
  },
});
