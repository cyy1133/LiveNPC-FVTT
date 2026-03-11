const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

function findBundledCodexBinSync() {
  if (process.platform !== "win32") return "";

  const appDataCodex = path.join(process.env.APPDATA || "", "npm", "codex.cmd");
  if (appDataCodex && fsSync.existsSync(appDataCodex)) return appDataCodex;

  const extRoot = path.join(process.env.USERPROFILE || "", ".vscode", "extensions");
  if (!extRoot || !fsSync.existsSync(extRoot)) return "";

  try {
    const dirs = fsSync
      .readdirSync(extRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^openai\.chatgpt-/i.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();

    for (const dirName of dirs) {
      const candidate = path.join(extRoot, dirName, "bin", "windows-x86_64", "codex.exe");
      if (fsSync.existsSync(candidate)) return candidate;
    }
  } catch {
    return "";
  }

  return "";
}

function normalizeCodexBin(rawBin) {
  const bin = String(rawBin || "").trim();
  if (bin) {
    const looksLikePath =
      path.isAbsolute(bin) ||
      /^[.]{1,2}[\\/]/.test(bin) ||
      /[\\/]/.test(bin);
    if (!looksLikePath || fsSync.existsSync(bin)) return bin;
  }
  const bundled = findBundledCodexBinSync();
  if (bundled) return bundled;
  if (process.platform === "win32") return "codex.exe";
  return "codex";
}

function buildStructuredSchema() {
  const stepSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      type: {
        type: "string",
        enum: [
          "none",
          "say",
          "action",
          "tokenaction",
          "aoe",
          "move",
          "tokenmove",
          "targetset",
          "targetclear",
          "inspect",
        ],
      },
      text: { type: ["string", "null"] },
      what: { type: ["string", "null"], enum: ["sheet", "context", "chatlog", null] },
      actionName: { type: ["string", "null"] },
      targetTokenRef: { type: ["string", "null"] },
      tokenRef: { type: ["string", "null"] },
      targetRef: { type: ["string", "null"] },
      direction: { type: ["string", "null"], enum: ["N", "S", "E", "W", "NE", "NW", "SE", "SW", null] },
      amount: { type: ["number", "null"] },
      unit: { type: ["string", "null"], enum: ["grid", "ft", null] },
      difficult: { type: ["boolean", "null"] },
      shape: { type: ["string", "null"], enum: ["circle", "cone", "line", null] },
      radiusFt: { type: ["number", "null"] },
      lengthFt: { type: ["number", "null"] },
      widthFt: { type: ["number", "null"] },
      angleDeg: { type: ["number", "null"] },
      centerTokenRef: { type: ["string", "null"] },
      includeSelf: { type: ["boolean", "null"] },
      includeHostileOnly: { type: ["boolean", "null"] },
      placeTemplate: { type: ["boolean", "null"] },
      centerX: { type: ["number", "null"] },
      centerY: { type: ["number", "null"] },
    },
    required: [
      "type",
      "text",
      "what",
      "actionName",
      "targetTokenRef",
      "tokenRef",
      "targetRef",
      "direction",
      "amount",
      "unit",
      "difficult",
      "shape",
      "radiusFt",
      "lengthFt",
      "widthFt",
      "angleDeg",
      "centerTokenRef",
      "includeSelf",
      "includeHostileOnly",
      "placeTemplate",
      "centerX",
      "centerY",
    ],
  };

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    properties: {
      replyText: { type: "string" },
      intent: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: {
            type: "string",
            enum: [
              "none",
              "say",
              "action",
              "tokenaction",
              "aoe",
              "move",
              "tokenmove",
              "targetset",
              "targetclear",
              "inspect",
              "plan",
            ],
          },
          text: { type: ["string", "null"] },
          what: { type: ["string", "null"], enum: ["sheet", "context", "chatlog", null] },
          actionName: { type: ["string", "null"] },
          targetTokenRef: { type: ["string", "null"] },
          tokenRef: { type: ["string", "null"] },
          targetRef: { type: ["string", "null"] },
          direction: { type: ["string", "null"], enum: ["N", "S", "E", "W", "NE", "NW", "SE", "SW", null] },
          amount: { type: ["number", "null"] },
          unit: { type: ["string", "null"], enum: ["grid", "ft", null] },
          difficult: { type: ["boolean", "null"] },
          shape: { type: ["string", "null"], enum: ["circle", "cone", "line", null] },
          radiusFt: { type: ["number", "null"] },
          lengthFt: { type: ["number", "null"] },
          widthFt: { type: ["number", "null"] },
          angleDeg: { type: ["number", "null"] },
          centerTokenRef: { type: ["string", "null"] },
          includeSelf: { type: ["boolean", "null"] },
          includeHostileOnly: { type: ["boolean", "null"] },
          placeTemplate: { type: ["boolean", "null"] },
          centerX: { type: ["number", "null"] },
          centerY: { type: ["number", "null"] },
          steps: {
            type: ["array", "null"],
            items: stepSchema,
          },
        },
        required: [
          "type",
          "text",
          "what",
          "actionName",
          "targetTokenRef",
          "tokenRef",
          "targetRef",
          "direction",
          "amount",
          "unit",
          "difficult",
          "shape",
          "radiusFt",
          "lengthFt",
          "widthFt",
          "angleDeg",
          "centerTokenRef",
          "includeSelf",
          "includeHostileOnly",
          "placeTemplate",
          "centerX",
          "centerY",
          "steps",
        ],
      },
    },
    required: ["replyText", "intent"],
  };
}

function normalizeSingleIntentLike(rawIntent) {
  const item = rawIntent && typeof rawIntent === "object" ? rawIntent : {};
  const type = String(item.type || "none").trim().toLowerCase();
  const args = {};

  if (type === "say" && item.text) {
    args.text = String(item.text);
  } else if (type === "inspect" && item.what) {
    args.what = String(item.what);
  } else if (type === "targetset") {
    const tokenRef = String(item.tokenRef || item.targetTokenRef || item.targetRef || "").trim();
    if (tokenRef) args.tokenRef = tokenRef;
  } else if (type === "targetclear") {
    // no args
  } else if (type === "action") {
    if (item.actionName) args.actionName = String(item.actionName);
    if (item.targetTokenRef || item.targetRef) args.targetTokenRef = String(item.targetTokenRef || item.targetRef);
  } else if (type === "tokenaction") {
    if (item.tokenRef) args.tokenRef = String(item.tokenRef);
    if (item.actionName) args.actionName = String(item.actionName);
    if (item.targetTokenRef || item.targetRef) args.targetTokenRef = String(item.targetTokenRef || item.targetRef);
  } else if (type === "move") {
    if (item.direction) args.direction = String(item.direction);
    if (Number.isFinite(Number(item.amount))) args.amount = Number(item.amount);
    if (item.unit) args.unit = String(item.unit);
    if (typeof item.difficult === "boolean") args.difficult = item.difficult;
    if (item.targetTokenRef) args.targetTokenRef = String(item.targetTokenRef);
  } else if (type === "tokenmove") {
    if (item.tokenRef) args.tokenRef = String(item.tokenRef);
    if (item.direction) args.direction = String(item.direction);
    if (Number.isFinite(Number(item.amount))) args.amount = Number(item.amount);
    if (item.unit) args.unit = String(item.unit);
    if (typeof item.difficult === "boolean") args.difficult = item.difficult;
  } else if (type === "aoe") {
    if (item.actionName) args.actionName = String(item.actionName);
    if (item.shape) args.shape = String(item.shape);
    if (Number.isFinite(Number(item.radiusFt))) args.radiusFt = Number(item.radiusFt);
    if (Number.isFinite(Number(item.lengthFt))) args.lengthFt = Number(item.lengthFt);
    if (Number.isFinite(Number(item.widthFt))) args.widthFt = Number(item.widthFt);
    if (Number.isFinite(Number(item.angleDeg))) args.angleDeg = Number(item.angleDeg);
    if (item.centerTokenRef) args.centerTokenRef = String(item.centerTokenRef);
    if (item.direction) args.direction = String(item.direction);
    if (typeof item.includeSelf === "boolean") args.includeSelf = item.includeSelf;
    if (typeof item.includeHostileOnly === "boolean") args.includeHostileOnly = item.includeHostileOnly;
    if (typeof item.placeTemplate === "boolean") args.placeTemplate = item.placeTemplate;
    if (Number.isFinite(Number(item.centerX))) args.centerX = Number(item.centerX);
    if (Number.isFinite(Number(item.centerY))) args.centerY = Number(item.centerY);
  }

  return { type, args };
}

function normalizeStructuredOutput(parsed) {
  const root = parsed && typeof parsed === "object" ? parsed : {};
  const rawIntent = root.intent && typeof root.intent === "object" ? root.intent : {};
  const type = String(rawIntent.type || "none").trim().toLowerCase();

  if (type === "plan") {
    const stepsRaw = Array.isArray(rawIntent.steps) ? rawIntent.steps : [];
    const steps = stepsRaw
      .map((step) => normalizeSingleIntentLike(step))
      .filter((step) =>
        ["say", "action", "tokenaction", "aoe", "move", "tokenmove", "targetset", "targetclear", "inspect"].includes(
          String(step?.type || "")
        )
      )
      .slice(0, 8);
    return {
      replyText: String(root.replyText || "").trim() || "(...)",
      intent: { type: steps.length ? "plan" : "none", args: { steps } },
    };
  }

  const single = normalizeSingleIntentLike(rawIntent);
  return {
    replyText: String(root.replyText || "").trim() || "(...)",
    intent: single,
  };
}

async function writeJsonNoBom(filePath, value) {
  const json = JSON.stringify(value);
  await fs.writeFile(filePath, json, { encoding: "utf8" });
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function compactTextForError(text, maxLen = 1200) {
  const s = String(text || "")
    .replace(/\r/g, "")
    .trim();
  if (!s) return "";
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}...(truncated)`;
}

function tryParseJsonObjectFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    // continue
  }

  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      return JSON.parse(line);
    } catch {
      // continue
    }
  }

  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(raw.slice(first, last + 1));
    } catch {
      // ignore
    }
  }

  return null;
}

async function getLoginStatus({ codexBin } = {}) {
  const bin = normalizeCodexBin(codexBin);
  try {
    const { stdout, stderr } = await execFileAsync(bin, ["login", "status"], {
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 512 * 1024,
      encoding: "utf8",
    });
    const text = `${String(stdout || "").trim()}\n${String(stderr || "").trim()}`.trim();
    const loggedIn = /logged in/i.test(text) && !/not logged in/i.test(text);
    return { ok: true, loggedIn, text };
  } catch (error) {
    return { ok: false, loggedIn: false, error: error?.message || String(error) };
  }
}

function launchLogin({ codexBin } = {}) {
  const bin = normalizeCodexBin(codexBin);

  if (process.platform === "win32") {
    // Open a dedicated cmd window that runs `codex login`.
    const cmdLine = `start "Codex Login" cmd /k "${bin}" login`;
    const child = spawn("cmd.exe", ["/c", cmdLine], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    return { ok: true };
  }

  // Fallback for non-Windows: best-effort detached launch.
  const child = spawn(bin, ["login"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { ok: true };
}

async function completeStructured({
  prompt,
  model,
  codexBin,
  timeoutMs = 120_000,
  cwd,
} = {}) {
  const bin = normalizeCodexBin(codexBin);
  const tmpDir = os.tmpdir();
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const schemaPath = path.join(tmpDir, `codex-schema-${id}.json`);
  const outputPath = path.join(tmpDir, `codex-last-${id}.json`);

  try {
    await fs.mkdir(tmpDir, { recursive: true }).catch(() => {});
    await writeJsonNoBom(schemaPath, buildStructuredSchema());

    const args = [
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
    ];

    if (model) {
      args.push("--model", String(model));
    }

    args.push(String(prompt || ""));

    let stdout = "";
    let stderr = "";
    let execError = null;

    try {
      const result = await execFileAsync(bin, args, {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
        cwd: cwd || process.cwd(),
      });
      stdout = String(result.stdout || "");
      stderr = String(result.stderr || "");
    } catch (error) {
      execError = error;
      stdout = String(error?.stdout || "");
      stderr = String(error?.stderr || "");
      // Continue: output-last-message might still be written even on non-zero exit.
    }

    let parsed = null;
    try {
      parsed = await readJson(outputPath);
    } catch (error) {
      const fallbackParsed = tryParseJsonObjectFromText(stdout) || tryParseJsonObjectFromText(stderr);
      if (fallbackParsed) {
        parsed = fallbackParsed;
      } else {
        const reason = [];
        if (execError?.message) reason.push(`exec failed: ${String(execError.message)}`);
        if (error?.message) reason.push(`output read failed: ${String(error.message)}`);
        const stderrCompact = compactTextForError(stderr, 900);
        if (stderrCompact) reason.push(`stderr: ${stderrCompact}`);
        const stdoutCompact = compactTextForError(stdout, 900);
        if (stdoutCompact) reason.push(`stdout: ${stdoutCompact}`);
        return {
          ok: false,
          error: reason.length
            ? reason.join(" | ")
            : `codex-cli completion failed without output (${outputPath})`,
        };
      }
    }

    const normalized = normalizeStructuredOutput(parsed);
    return {
      ok: true,
      parsed: normalized,
      raw: parsed,
      stdout,
      stderr,
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error),
    };
  } finally {
    await fs.unlink(schemaPath).catch(() => {});
    await fs.unlink(outputPath).catch(() => {});
  }
}

module.exports = {
  normalizeCodexBin,
  getLoginStatus,
  launchLogin,
  completeStructured,
};
