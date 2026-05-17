// Preload pour la fenêtre de setup (install + auth).
// Bi-directionnel : reçoit les mises à jour d'état du main process
// et renvoie les actions utilisateur.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("oifSetup", {
  onState: (cb) => {
    const handler = (_, state) => cb(state);
    ipcRenderer.on("setup-state", handler);
    return () => ipcRenderer.removeListener("setup-state", handler);
  },
  action: (a, data) => ipcRenderer.send("setup-action", a, data),
});
