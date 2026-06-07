const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bridge", {
  getStatus: () => ipcRenderer.invoke("bridge:get-status"),
  sync: () => ipcRenderer.invoke("bridge:sync"),
  signIn: (input) => ipcRenderer.invoke("bridge:sign-in", input),
  openService: (serviceId) => ipcRenderer.invoke("bridge:open-service", serviceId),
  reconnectService: (serviceId) => ipcRenderer.invoke("bridge:reconnect-service", serviceId),
  refreshCodex: () => ipcRenderer.invoke("bridge:refresh-codex"),
  setupCodex: () => ipcRenderer.invoke("bridge:setup-codex"),
  openCodexHelp: () => ipcRenderer.invoke("bridge:open-codex-help"),
  signOut: () => ipcRenderer.invoke("bridge:sign-out"),
  revealDataDir: () => ipcRenderer.invoke("bridge:reveal-data-dir"),
  onStatus: (callback) => {
    ipcRenderer.on("bridge:status", (_event, status) => callback(status));
  },
});
