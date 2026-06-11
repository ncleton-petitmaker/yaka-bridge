const { contextBridge, ipcRenderer } = require("electron");

// Token de session injecté par le main via webPreferences.additionalArguments.
// Sert à signer les appels /api/* du daemon local (Workstream A). Lu une seule
// fois au chargement du preload.
function daemonTokenFromArgv() {
  const prefix = "--daemon-token=";
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "";
}

contextBridge.exposeInMainWorld("appBridge", {
  version: () => "0.1.0",
  isElectron: true,
  daemonToken: daemonTokenFromArgv(),
  selectDirectory: (opts) => ipcRenderer.invoke("select-directory", opts ?? {}),
  openFile: (absPath) => ipcRenderer.invoke("open-file", absPath),
  revealFile: (absPath) => ipcRenderer.invoke("reveal-file", absPath),
  saveDebugBundle: (buffer, filename) =>
    ipcRenderer.invoke("save-debug-bundle", { buffer, filename }),
});
