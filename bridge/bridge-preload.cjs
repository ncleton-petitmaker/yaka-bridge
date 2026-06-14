const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bridge", {
  getStatus: () => ipcRenderer.invoke("bridge:get-status"),
  sync: () => ipcRenderer.invoke("bridge:sync"),
  signIn: (input) => ipcRenderer.invoke("bridge:sign-in", input),
  openService: (serviceId) => ipcRenderer.invoke("bridge:open-service", serviceId),
  reconnectService: (serviceId) => ipcRenderer.invoke("bridge:reconnect-service", serviceId),
  refreshCodex: () => ipcRenderer.invoke("bridge:refresh-codex"),
  setupCodex: () => ipcRenderer.invoke("bridge:setup-codex"),
  setupBridge: () => ipcRenderer.invoke("bridge:setup"),
  ensureAdminProvisioning: () => ipcRenderer.invoke("bridge:ensure-admin-provisioning"),
  setLocalAiModel: (model) => ipcRenderer.invoke("bridge:local-ai-set-model", model),
  voiceStatus: () => ipcRenderer.invoke("bridge:voice-status"),
  setVoiceShortcut: (shortcut) => ipcRenderer.invoke("bridge:voice-set-shortcut", shortcut),
  changeVoiceShortcut: () => ipcRenderer.invoke("bridge:voice-change-shortcut"),
  testVoiceOverlay: () => ipcRenderer.invoke("bridge:voice-test-overlay"),
  toggleVoice: () => ipcRenderer.invoke("bridge:voice-toggle"),
  testVoiceMicrophone: () => ipcRenderer.invoke("bridge:voice-test-microphone"),
  openCodexHelp: () => ipcRenderer.invoke("bridge:open-codex-help"),
  signOut: () => ipcRenderer.invoke("bridge:sign-out"),
  revealDataDir: () => ipcRenderer.invoke("bridge:reveal-data-dir"),
  onStatus: (callback) => {
    ipcRenderer.on("bridge:status", (_event, status) => callback(status));
  },
});
