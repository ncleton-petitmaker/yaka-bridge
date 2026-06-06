const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bridge", {
  getStatus: () => ipcRenderer.invoke("bridge:get-status"),
  sync: () => ipcRenderer.invoke("bridge:sync"),
  openService: (serviceId) => ipcRenderer.invoke("bridge:open-service", serviceId),
  reconnectService: (serviceId) => ipcRenderer.invoke("bridge:reconnect-service", serviceId),
  signOut: () => ipcRenderer.invoke("bridge:sign-out"),
  revealDataDir: () => ipcRenderer.invoke("bridge:reveal-data-dir"),
  onStatus: (callback) => {
    ipcRenderer.on("bridge:status", (_event, status) => callback(status));
  },
});
