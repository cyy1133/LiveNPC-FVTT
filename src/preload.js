const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getVersion: () => ipcRenderer.invoke("app:getVersion"),
  getConfig: () => ipcRenderer.invoke("config:get"),
  setConfig: (config) => ipcRenderer.invoke("config:set", { config }),
  startRuntime: () => ipcRenderer.invoke("runtime:start"),
  stopRuntime: () => ipcRenderer.invoke("runtime:stop"),
  getNpcVisuals: (config) => ipcRenderer.invoke("runtime:getNpcVisuals", { config }),
  runDiagnostics: () => ipcRenderer.invoke("diagnostics:runAll"),
  openExternal: (url) => ipcRenderer.invoke("openExternal", { url }),
  onLog: (handler) => {
    const listener = (_evt, entry) => handler(entry);
    ipcRenderer.on("log:entry", listener);
    return () => ipcRenderer.removeListener("log:entry", listener);
  },
  oauthLoginOpenAiCodex: () => ipcRenderer.invoke("oauth:openai:login"),
  onOauthPrompt: (handler) => {
    const listener = (_evt, payload) => handler(payload);
    ipcRenderer.on("oauth:prompt", listener);
    return () => ipcRenderer.removeListener("oauth:prompt", listener);
  },
  answerOauthPrompt: (promptId, value) =>
    ipcRenderer.send("oauth:prompt:answer", { promptId: String(promptId || ""), value: String(value || "") }),
  getCodexLoginStatus: (config) => ipcRenderer.invoke("codex:login:status", { config }),
  launchCodexLogin: (config) => ipcRenderer.invoke("codex:login:launch", { config }),
  installPrerequisites: (config) => ipcRenderer.invoke("setup:installPrerequisites", { config }),
  pickMarkdownFile: (defaultPath) => ipcRenderer.invoke("files:pickMarkdown", { defaultPath }),
  readTextFile: (filePath) => ipcRenderer.invoke("files:readText", { filePath }),
  writeTextFile: (filePath, text) => ipcRenderer.invoke("files:writeText", { filePath, text }),
});
