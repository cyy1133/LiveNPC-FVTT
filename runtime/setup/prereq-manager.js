const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

function isWin() {
  return process.platform === "win32";
}

async function fileExists(filePath) {
  const p = String(filePath || "").trim();
  if (!p) return false;
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function compact(text, max = 400) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 3)) + "...";
}

async function findOnPath(commandName) {
  const cmd = String(commandName || "").trim();
  if (!cmd) return null;
  try {
    if (isWin()) {
      const { stdout } = await execFileAsync("where", [cmd], {
        windowsHide: true,
        timeout: 10_000,
        encoding: "utf8",
      });
      const lines = String(stdout || "")
        .split(/\r?\n/)
        .map((v) => v.trim())
        .filter(Boolean);
      for (const line of lines) {
        if (await fileExists(line)) return line;
      }
      return null;
    }

    const { stdout } = await execFileAsync("which", [cmd], {
      timeout: 10_000,
      encoding: "utf8",
    });
    const line = String(stdout || "")
      .split(/\r?\n/)[0]
      .trim();
    if (!line) return null;
    return (await fileExists(line)) ? line : null;
  } catch {
    return null;
  }
}

async function runCommand(file, args, { timeoutMs = 300_000, cwd } = {}) {
  return new Promise((resolve) => {
    const command = String(file || "").trim();
    const argv = Array.isArray(args) ? args.map((v) => String(v)) : [];
    const shellMode = isWin() && /\.(cmd|bat)$/i.test(command);
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn(command, argv, {
      cwd: cwd || process.cwd(),
      windowsHide: true,
      shell: shellMode,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let timer = null;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // ignore
        }
        done({
          ok: false,
          code: null,
          error: `timeout after ${timeoutMs}ms`,
          stdout,
          stderr,
        });
      }, timeoutMs);
    }

    if (child.stdout) {
      child.stdout.on("data", (buf) => {
        stdout += String(buf || "");
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (buf) => {
        stderr += String(buf || "");
      });
    }

    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      done({
        ok: false,
        code: null,
        error: error?.message || String(error),
        stdout,
        stderr,
      });
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      done({
        ok: Number(code) === 0,
        code: Number.isFinite(Number(code)) ? Number(code) : null,
        error: Number(code) === 0 ? "" : `exit code ${code}`,
        stdout,
        stderr,
      });
    });
  });
}

async function findNpmPath() {
  const tried = [];

  const pathHits = isWin() ? ["npm.cmd", "npm"] : ["npm"];
  for (const name of pathHits) {
    const hit = await findOnPath(name);
    tried.push(name);
    if (hit) return { npmPath: hit, tried };
  }

  if (isWin()) {
    const candidates = [
      path.join(process.env.APPDATA || "", "npm", "npm.cmd"),
      path.join(process.env.ProgramFiles || "", "nodejs", "npm.cmd"),
      path.join(process.env["ProgramFiles(x86)"] || "", "nodejs", "npm.cmd"),
      path.join(process.env.LOCALAPPDATA || "", "Programs", "nodejs", "npm.cmd"),
    ].filter(Boolean);
    for (const p of candidates) {
      tried.push(p);
      if (await fileExists(p)) return { npmPath: p, tried };
    }
  }

  return { npmPath: null, tried };
}

async function findCodexFromVscodeExtension() {
  if (!isWin()) return null;

  const extRoot = path.join(process.env.USERPROFILE || "", ".vscode", "extensions");
  if (!(await fileExists(extRoot))) return null;

  try {
    const dirs = await fs.readdir(extRoot, { withFileTypes: true });
    const extensionDirs = dirs
      .filter((d) => d.isDirectory() && /^openai\.chatgpt-/i.test(d.name))
      .map((d) => d.name)
      .sort()
      .reverse();

    for (const dirName of extensionDirs) {
      const base = path.join(extRoot, dirName, "bin");
      if (!(await fileExists(base))) continue;
      const bins = await fs.readdir(base, { withFileTypes: true });
      for (const b of bins) {
        if (!b.isDirectory()) continue;
        if (!/^windows-/i.test(b.name)) continue;
        const codexPath = path.join(base, b.name, "codex.exe");
        if (await fileExists(codexPath)) return codexPath;
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function findCodexPath(preferred) {
  const preferredPath = String(preferred || "").trim();
  if (preferredPath && (await fileExists(preferredPath))) return preferredPath;

  if (isWin()) {
    const appDataCodex = path.join(process.env.APPDATA || "", "npm", "codex.cmd");
    if (await fileExists(appDataCodex)) return appDataCodex;

    const vscodeCodex = await findCodexFromVscodeExtension();
    if (vscodeCodex) return vscodeCodex;
  }

  const pathHits = isWin() ? ["codex.exe", "codex.cmd", "codex"] : ["codex"];
  for (const name of pathHits) {
    const hit = await findOnPath(name);
    if (hit) return hit;
  }

  return null;
}

async function installNodeWithWinget() {
  if (!isWin()) {
    return { ok: false, error: "automatic Node install is only implemented for Windows" };
  }
  const winget = await findOnPath("winget");
  if (!winget) {
    return { ok: false, error: "winget not found. Install Node.js LTS manually." };
  }
  return runCommand(winget, ["install", "--id", "OpenJS.NodeJS.LTS", "-e", "--accept-source-agreements", "--accept-package-agreements"], {
    timeoutMs: 20 * 60_000,
  });
}

async function installCodexWithNpm(npmPath) {
  return runCommand(npmPath, ["install", "-g", "@openai/codex"], {
    timeoutMs: 20 * 60_000,
  });
}

async function ensureCodexPrerequisites({ config, onLog } = {}) {
  const events = [];
  const log = (msg) => {
    const line = String(msg || "").trim();
    if (!line) return;
    events.push(line);
    if (typeof onLog === "function") onLog(line);
  };

  const provider = String(config?.llm?.provider || "codex-cli").trim().toLowerCase();
  if (provider !== "codex-cli") {
    return {
      ok: true,
      provider,
      events,
      detail: "no codex prerequisites required for this provider",
    };
  }

  const configuredBin = String(config?.llm?.codexCli?.binPath || "").trim();
  let codexPath = await findCodexPath(configuredBin);
  if (codexPath) {
    log(`codex already found: ${codexPath}`);
    return {
      ok: true,
      provider,
      codexBinPath: codexPath,
      installed: { node: false, codex: false },
      events,
      detail: "codex already installed",
    };
  }

  log("codex not found. checking npm...");
  let { npmPath } = await findNpmPath();
  let installedNode = false;
  let installedCodex = false;

  if (!npmPath) {
    log("npm not found. trying to install Node.js LTS via winget...");
    const nodeInstall = await installNodeWithWinget();
    if (!nodeInstall.ok) {
      return {
        ok: false,
        provider,
        events,
        installed: { node: false, codex: false },
        error: `node install failed: ${compact(nodeInstall.error || nodeInstall.stderr || nodeInstall.stdout)}`,
      };
    }
    installedNode = true;
    log("node install command completed.");
    const npmCheck = await findNpmPath();
    npmPath = npmCheck.npmPath;
  }

  if (!npmPath) {
    return {
      ok: false,
      provider,
      events,
      installed: { node: installedNode, codex: false },
      error: "npm still not found after node installation.",
    };
  }

  log(`npm found: ${npmPath}`);
  log("installing @openai/codex globally...");
  const codexInstall = await installCodexWithNpm(npmPath);
  if (!codexInstall.ok) {
    return {
      ok: false,
      provider,
      events,
      installed: { node: installedNode, codex: false },
      error: `codex install failed: ${compact(codexInstall.error || codexInstall.stderr || codexInstall.stdout)}`,
    };
  }
  installedCodex = true;
  log("codex install command completed.");

  codexPath = await findCodexPath(configuredBin);
  if (!codexPath) {
    return {
      ok: false,
      provider,
      events,
      installed: { node: installedNode, codex: installedCodex },
      error: "codex command not found after install. Restart app or set codexCli.binPath manually.",
    };
  }

  log(`codex installed: ${codexPath}`);
  return {
    ok: true,
    provider,
    codexBinPath: codexPath,
    installed: { node: installedNode, codex: installedCodex },
    events,
    detail: installedCodex ? "codex installed" : "codex already available",
  };
}

module.exports = {
  ensureCodexPrerequisites,
};
