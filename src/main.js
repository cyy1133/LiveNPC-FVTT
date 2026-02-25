const path = require("node:path");
const fs = require("node:fs/promises");
const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { AppRuntime } = require("../runtime/app-runtime");
const { loadAppConfig, saveAppConfig, getDefaultConfigPath } = require("../runtime/config-store");

let mainWindow = null;
let runtime = null;
const pendingOauthPrompts = new Map();

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  return win;
}

function ensureRuntime() {
  if (runtime) return runtime;
  runtime = new AppRuntime({
    appDataDir: app.getPath("userData"),
    onLog: (entry) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("log:entry", entry);
      }
    },
  });
  return runtime;
}

app.whenReady().then(() => {
  mainWindow = createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

app.on("window-all-closed", async () => {
  if (process.platform !== "darwin") {
    try {
      if (runtime) await runtime.stop();
    } catch {
      // ignore
    }
    app.quit();
  }
});

ipcMain.handle("app:getVersion", async () => {
  return { version: app.getVersion() };
});

ipcMain.handle("config:get", async () => {
  const configPath = getDefaultConfigPath(app.getPath("userData"));
  const config = await loadAppConfig(configPath);
  return { configPath, config };
});

ipcMain.handle("config:set", async (_evt, { config }) => {
  const configPath = getDefaultConfigPath(app.getPath("userData"));
  await saveAppConfig(configPath, config);
  return { ok: true };
});

ipcMain.handle("runtime:start", async () => {
  const configPath = getDefaultConfigPath(app.getPath("userData"));
  const config = await loadAppConfig(configPath);
  const rt = ensureRuntime();
  await rt.start({
    config,
    persistConfig: async (nextConfig) => {
      await saveAppConfig(configPath, nextConfig);
    },
  });
  return { ok: true };
});

ipcMain.handle("runtime:stop", async () => {
  const rt = ensureRuntime();
  await rt.stop();
  return { ok: true };
});

ipcMain.handle("runtime:getNpcVisuals", async (_evt, { config } = {}) => {
  const configPath = getDefaultConfigPath(app.getPath("userData"));
  const nextConfig = config && typeof config === "object" ? config : await loadAppConfig(configPath);
  const rt = ensureRuntime();
  return rt.getNpcVisuals({ config: nextConfig });
});

ipcMain.handle("diagnostics:runAll", async () => {
  const configPath = getDefaultConfigPath(app.getPath("userData"));
  const config = await loadAppConfig(configPath);
  const rt = ensureRuntime();
  return rt.runDiagnostics({
    config,
    persistConfig: async (nextConfig) => {
      await saveAppConfig(configPath, nextConfig);
    },
  });
});

ipcMain.handle("openExternal", async (_evt, { url }) => {
  if (!url) return { ok: false, error: "missing url" };
  await shell.openExternal(String(url));
  return { ok: true };
});

ipcMain.on("oauth:prompt:answer", (_evt, { promptId, value }) => {
  const id = String(promptId || "");
  const entry = pendingOauthPrompts.get(id);
  if (!entry) return;
  pendingOauthPrompts.delete(id);
  entry.resolve(String(value || ""));
});

ipcMain.handle("oauth:openai:login", async () => {
  const configPath = getDefaultConfigPath(app.getPath("userData"));
  const config = await loadAppConfig(configPath);
  const rt = ensureRuntime();

  const creds = await rt.oauthLoginOpenAiCodex({
    openUrl: async (url) => {
      await shell.openExternal(String(url));
    },
    prompt: async ({ message }) => {
      const promptId = `p_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const p = new Promise((resolve) => pendingOauthPrompts.set(promptId, { resolve }));
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("oauth:prompt", { promptId, message: String(message || "") });
      }
      return p;
    },
  });

  config.llm = config.llm || {};
  config.llm.provider = "openai-oauth";
  config.llm.openai = config.llm.openai || {};
  config.llm.openai.oauth = {
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAtMs: creds.expiresAtMs,
  };
  await saveAppConfig(configPath, config);

  return { ok: true };
});

ipcMain.handle("codex:login:status", async (_evt, { config } = {}) => {
  const configPath = getDefaultConfigPath(app.getPath("userData"));
  const nextConfig = config && typeof config === "object" ? config : await loadAppConfig(configPath);
  const rt = ensureRuntime();
  return rt.getCodexLoginStatusForUser({ config: nextConfig });
});

ipcMain.handle("codex:login:launch", async (_evt, { config } = {}) => {
  const configPath = getDefaultConfigPath(app.getPath("userData"));
  const nextConfig = config && typeof config === "object" ? config : await loadAppConfig(configPath);
  const rt = ensureRuntime();
  return rt.launchCodexLoginForUser({ config: nextConfig });
});

ipcMain.handle("setup:installPrerequisites", async (_evt, { config } = {}) => {
  const configPath = getDefaultConfigPath(app.getPath("userData"));
  const nextConfig = config && typeof config === "object" ? config : await loadAppConfig(configPath);
  const rt = ensureRuntime();
  const result = await rt.ensurePrerequisitesForConfig({ config: nextConfig });

  if (result?.ok && result?.provider === "codex-cli" && result?.codexBinPath) {
    nextConfig.llm = nextConfig.llm || {};
    nextConfig.llm.codexCli = nextConfig.llm.codexCli || {};
    nextConfig.llm.codexCli.binPath = String(result.codexBinPath || "").trim();
    await saveAppConfig(configPath, nextConfig);
  }

  return {
    ...result,
    config: nextConfig,
  };
});

ipcMain.handle("files:pickMarkdown", async (evt, { defaultPath } = {}) => {
  const owner = BrowserWindow.fromWebContents(evt.sender) || mainWindow || undefined;
  const result = await dialog.showOpenDialog(owner, {
    title: "Select markdown file",
    defaultPath: String(defaultPath || "").trim() || undefined,
    properties: ["openFile"],
    filters: [
      { name: "Markdown", extensions: ["md", "markdown", "txt"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });

  if (result.canceled || !Array.isArray(result.filePaths) || !result.filePaths.length) {
    return { ok: false, canceled: true, path: "" };
  }
  return { ok: true, canceled: false, path: String(result.filePaths[0] || "") };
});

ipcMain.handle("files:readText", async (_evt, { filePath } = {}) => {
  const p = String(filePath || "").trim();
  if (!p) return { ok: false, error: "filePath is required", text: "" };
  try {
    const text = await fs.readFile(p, "utf8");
    return { ok: true, text, filePath: p };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), text: "", filePath: p };
  }
});

ipcMain.handle("files:writeText", async (_evt, { filePath, text } = {}) => {
  const p = String(filePath || "").trim();
  if (!p) return { ok: false, error: "filePath is required" };
  try {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, String(text || ""), "utf8");
    return { ok: true, filePath: p };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), filePath: p };
  }
});
