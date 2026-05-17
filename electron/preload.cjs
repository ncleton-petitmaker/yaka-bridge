const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("oifEval", {
  version: () => "0.1.0",
  isElectron: true,
  selectDirectory: (opts) => ipcRenderer.invoke("select-directory", opts ?? {}),
  openFile: (absPath) => ipcRenderer.invoke("open-file", absPath),
  revealFile: (absPath) => ipcRenderer.invoke("reveal-file", absPath),
  saveDebugBundle: (buffer, filename) =>
    ipcRenderer.invoke("save-debug-bundle", { buffer, filename }),
});
