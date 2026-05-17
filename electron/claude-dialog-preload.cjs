// Preload pour la fenêtre dialog "Installer Claude Code".
// Expose juste un canal one-way pour que les boutons HTML
// communiquent leur action au main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("oifClaudeDialog", {
  respond: (action) => ipcRenderer.send("claude-dialog-respond", action),
});
