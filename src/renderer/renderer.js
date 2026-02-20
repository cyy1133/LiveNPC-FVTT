let currentConfig = null;
let mdEditorTarget = null;
let mdEditorDirty = false;
const PERSONA_DOC_KEYS = ["identity", "soul", "behavior", "battle", "relations", "memory"];

function $(id) {
  return document.getElementById(id);
}

function nowLineTs() {
  return new Date().toLocaleTimeString();
}

function appendLog(entry) {
  const box = $("logbox");
  const line = document.createElement("div");
  line.className = `logline ${entry.level || "info"}`;
  const ts = entry.ts ? new Date(entry.ts).toLocaleTimeString() : nowLineTs();
  line.textContent = `[${ts}] ${entry.scope || "app"}: ${entry.message || ""}`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function setConfigEditor(config) {
  $("config-editor").value = JSON.stringify(config || {}, null, 2);
}

function getProvider(config) {
  return String(config?.llm?.provider || "codex-cli").trim().toLowerCase();
}

function ensureNpcShape(npc, index = 0) {
  const out = npc && typeof npc === "object" ? npc : {};
  out.id = String(out.id || `npc${index + 1}`);
  out.displayName = String(out.displayName || out.id || `npc_${index}`);
  out.enabled = out.enabled !== false;

  out.actor = out.actor && typeof out.actor === "object" ? out.actor : {};
  out.actor.type = "name";
  out.actor.value = String(out.actor.value || out.displayName || "");

  out.personaDocs = out.personaDocs && typeof out.personaDocs === "object" ? out.personaDocs : {};
  for (const key of PERSONA_DOC_KEYS) {
    out.personaDocs[key] = String(out.personaDocs[key] || "");
  }

  out.triggers = out.triggers && typeof out.triggers === "object" ? out.triggers : {};
  if (!Number.isFinite(Number(out.triggers.minFt))) out.triggers.minFt = 2;
  if (!Number.isFinite(Number(out.triggers.maxFt))) out.triggers.maxFt = 30;
  return out;
}

function ensureConfigShape(config) {
  const out = config && typeof config === "object" ? config : {};

  out.npc = out.npc && typeof out.npc === "object" ? out.npc : {};
  if (!Number.isFinite(Number(out.npc.difficultTerrainMultiplier))) {
    out.npc.difficultTerrainMultiplier = 2;
  }
  out.npc.defaultNpcId = String(out.npc.defaultNpcId || "");
  out.npc.sharedDocs = out.npc.sharedDocs && typeof out.npc.sharedDocs === "object" ? out.npc.sharedDocs : {};
  out.npc.sharedDocs.world = String(out.npc.sharedDocs.world || "");

  out.npcs = Array.isArray(out.npcs) ? out.npcs : [];
  if (!out.npcs.length) {
    out.npcs.push({
      id: "npc1",
      displayName: "NPC",
      enabled: true,
      actor: { type: "name", value: "NPC" },
      personaDocs: { identity: "", soul: "", behavior: "", battle: "", relations: "", memory: "" },
      triggers: { minFt: 2, maxFt: 30 },
    });
  }
  out.npcs = out.npcs.map((npc, idx) => ensureNpcShape(npc, idx));
  return out;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeUniqueNpcId(config, base = "npc") {
  const taken = new Set(
    (Array.isArray(config?.npcs) ? config.npcs : [])
      .map((n) => String(n?.id || "").trim().toLowerCase())
      .filter(Boolean)
  );
  let i = 1;
  while (taken.has(`${base}${i}`.toLowerCase())) {
    i += 1;
  }
  return `${base}${i}`;
}

function createNpcTemplate(config) {
  const npcs = Array.isArray(config?.npcs) ? config.npcs : [];
  const index = npcs.length + 1;
  const id = makeUniqueNpcId(config, "npc");
  const displayName = `NPC ${index}`;

  const diana = npcs.find((n) => String(n?.id || "").trim().toLowerCase() === "diana");
  const defaultSoul = String(diana?.personaDocs?.soul || "");
  const defaultBattle = String(diana?.personaDocs?.battle || "");
  const defaultMinFt = Number.isFinite(Number(diana?.triggers?.minFt)) ? Number(diana.triggers.minFt) : 2;
  const defaultMaxFt = Number.isFinite(Number(diana?.triggers?.maxFt)) ? Number(diana.triggers.maxFt) : 30;

  return ensureNpcShape(
    {
      id,
      displayName,
      enabled: true,
      actor: { type: "name", value: displayName },
      personaDocs: {
        identity: "",
        soul: defaultSoul,
        behavior: "",
        battle: defaultBattle,
          relations: "",
          memory: "",
        },
      triggers: { minFt: defaultMinFt, maxFt: defaultMaxFt },
    },
    npcs.length
  );
}

function syncWorldDocInputFromConfig(config) {
  const worldInput = $("f-world-doc");
  if (!worldInput) return;
  worldInput.value = String(config?.npc?.sharedDocs?.world || "");
}

function openAiOauthStatusText(config) {
  const oauth = config?.llm?.openai?.oauth || {};
  const access = String(oauth.accessToken || "").trim();
  const refresh = String(oauth.refreshToken || "").trim();
  const exp = Number(oauth.expiresAtMs || 0);
  if (!access || !refresh) return "Not logged in";
  if (!exp) return "Logged in (unknown expiry)";
  const leftMs = exp - Date.now();
  if (leftMs <= 0) return "Logged in (token expired, will refresh on request)";
  const leftMin = Math.floor(leftMs / 60000);
  return `Logged in (expires in ${leftMin} min)`;
}

async function codexLoginStatusText(config) {
  try {
    const status = await window.api.getCodexLoginStatus(config);
    if (!status?.ok) return `Codex status failed: ${status?.error || "unknown error"}`;
    return status.loggedIn ? "Logged in via ChatGPT/Codex CLI" : "Not logged in (run Codex login)";
  } catch (e) {
    return `Codex status failed: ${e?.message || e}`;
  }
}

async function refreshProviderStatus(config) {
  const provider = getProvider(config);
  const statusEl = $("oauth-status");
  if (!statusEl) return;

  if (provider === "codex-cli") {
    statusEl.textContent = "Checking Codex login status...";
    statusEl.textContent = await codexLoginStatusText(config);
    return;
  }

  if (provider === "openai-oauth") {
    statusEl.textContent = openAiOauthStatusText(config);
    return;
  }

  statusEl.textContent = "API key mode (no login button required)";
}

function updateQuickSetupUi(config) {
  const provider = getProvider(config);
  $("f-llm-provider").value = provider;
  $("f-openai-key-wrap").style.display = provider === "openai-api-key" ? "flex" : "none";

  const headerBtn = $("btn-oauth");
  const inlineBtn = $("btn-oauth-inline");
  const needsLoginButton = provider === "codex-cli" || provider === "openai-oauth";
  if (headerBtn) {
    headerBtn.disabled = !needsLoginButton;
    headerBtn.textContent = provider === "codex-cli" ? "Codex Login" : "OpenAI OAuth";
  }
  if (inlineBtn) {
    inlineBtn.disabled = !needsLoginButton;
    inlineBtn.textContent = provider === "codex-cli" ? "Codex Login" : "OAuth Login";
  }

  const modelLabel = $("f-model-label");
  if (modelLabel) {
    modelLabel.textContent = provider === "codex-cli" ? "Codex Model" : "OpenAI Model";
  }

  const codexWrap = $("f-codex-bin-wrap");
  if (codexWrap) {
    codexWrap.style.display = provider === "codex-cli" ? "flex" : "none";
  }
}
async function loadQuickFormFromConfig(config) {
  config = ensureConfigShape(config || {});

  $("f-discord-token").value = String(config?.discord?.botToken || "");
  $("f-discord-channel").value = String(config?.discord?.channelName || "aibot");
  $("f-discord-mention").checked = Boolean(config?.discord?.requireMention);

  $("f-fvtt-url").value = String(config?.foundry?.url || "");
  $("f-fvtt-user").value = String(config?.foundry?.username || "");
  $("f-fvtt-pass").value = String(config?.foundry?.password || "");
  $("f-fvtt-headless").checked = Boolean(config?.foundry?.headless);

  const provider = getProvider(config);
  $("f-llm-provider").value = provider;

  const codexModel = String(config?.llm?.codexCli?.model || "gpt-5.3-codex");
  const openaiModel = String(config?.llm?.openai?.model || "gpt-5");
  $("f-openai-model").value = provider === "codex-cli" ? codexModel : openaiModel;
  $("f-openai-key").value = String(config?.llm?.openai?.apiKey || "");

  const codexBinInput = $("f-codex-bin");
  if (codexBinInput) {
    codexBinInput.value = String(config?.llm?.codexCli?.binPath || "");
  }

  $("f-trace-enabled").checked = config?.runtime?.trace?.enabled !== false;
  $("f-trace-logdir").value = String(config?.runtime?.trace?.logDir || "");

  syncWorldDocInputFromConfig(config);
  updateQuickSetupUi(config);
  await refreshProviderStatus(config);
}

function applyQuickFormToConfig(config) {
  config = ensureConfigShape(config || {});

  config.discord = config.discord || {};
  config.discord.enabled = true;
  config.discord.botToken = String($("f-discord-token").value || "");
  config.discord.channelName = String($("f-discord-channel").value || "aibot").trim() || "aibot";
  config.discord.requireMention = Boolean($("f-discord-mention").checked);

  config.foundry = config.foundry || {};
  config.foundry.enabled = true;
  config.foundry.url = String($("f-fvtt-url").value || "").trim();
  config.foundry.username = String($("f-fvtt-user").value || "").trim();
  config.foundry.password = String($("f-fvtt-pass").value || "");
  config.foundry.headless = Boolean($("f-fvtt-headless").checked);
  if (!Number.isFinite(Number(config.foundry.pollChatEveryMs))) {
    config.foundry.pollChatEveryMs = 1200;
  }

  config.llm = config.llm || {};
  config.llm.provider = String($("f-llm-provider").value || "codex-cli").trim().toLowerCase();
  config.llm.openai = config.llm.openai || {};
  config.llm.openai.apiBaseUrl = String(config.llm.openai.apiBaseUrl || "https://api.openai.com");
  config.llm.openai.model = String(config.llm.openai.model || "gpt-5");
  config.llm.openai.apiKey = String($("f-openai-key").value || "");
  config.llm.openai.oauth = config.llm.openai.oauth || {
    accessToken: "",
    refreshToken: "",
    expiresAtMs: 0,
  };

  config.llm.codexCli = config.llm.codexCli || {};
  const modelInput = String($("f-openai-model").value || "").trim();
  if (config.llm.provider === "codex-cli") {
    config.llm.codexCli.model = modelInput || "gpt-5.3-codex";
  } else {
    config.llm.openai.model = modelInput || "gpt-5";
  }

  const codexBinInput = $("f-codex-bin");
  if (codexBinInput) {
    config.llm.codexCli.binPath = String(codexBinInput.value || "").trim();
  } else {
    config.llm.codexCli.binPath = String(config.llm.codexCli.binPath || "");
  }

  config.runtime = config.runtime || {};
  config.runtime.trace = config.runtime.trace || {};
  config.runtime.trace.enabled = Boolean($("f-trace-enabled").checked);
  config.runtime.trace.logDir = String($("f-trace-logdir").value || "").trim();
  config.runtime.trace.toUi = Boolean(config.runtime.trace.toUi);
  config.runtime.trace.includePrompt = config.runtime.trace.includePrompt !== false;
  config.runtime.trace.includeLlmRaw = config.runtime.trace.includeLlmRaw !== false;
  config.runtime.trace.includeContexts = config.runtime.trace.includeContexts !== false;

  const worldDocInput = $("f-world-doc");
  config.npc.sharedDocs.world = String(worldDocInput?.value || "").trim();

  updateQuickSetupUi(config);
  return config;
}
function isSameDocTarget(a, b) {
  if (!a || !b) return false;
  return (
    String(a.kind || "") === String(b.kind || "") &&
    Number(a.npcIndex || -1) === Number(b.npcIndex || -1) &&
    String(a.docKey || "") === String(b.docKey || "")
  );
}

function getDocTargetLabel(config, target) {
  if (!target || !config) return "Markdown";
  if (target.kind === "world") return "Shared World Lore";

  if (target.kind === "npcDoc") {
    const npc = Array.isArray(config?.npcs) ? config.npcs[target.npcIndex] : null;
    const npcName = String(npc?.displayName || npc?.id || `npc_${target.npcIndex}`);
    const key = String(target.docKey || "");
    if (key === "soul") return `${npcName} - Soul/Personality`;
    if (key === "battle") return `${npcName} - Battle Pattern`;
    return `${npcName} - ${key}`;
  }

  return "Markdown";
}

function getDocTargetPath(config, target) {
  if (!target || !config) return "";
  if (target.kind === "world") return String(config?.npc?.sharedDocs?.world || "");

  if (target.kind === "npcDoc") {
    const npc = Array.isArray(config?.npcs) ? config.npcs[target.npcIndex] : null;
    if (!npc) return "";
    return String(npc?.personaDocs?.[target.docKey] || "");
  }

  return "";
}

function setDocTargetPath(config, target, nextPath) {
  if (!target || !config) return;
  const p = String(nextPath || "").trim();

  if (target.kind === "world") {
    config.npc = config.npc || {};
    config.npc.sharedDocs = config.npc.sharedDocs || {};
    config.npc.sharedDocs.world = p;
  } else if (target.kind === "npcDoc") {
    const npc = Array.isArray(config?.npcs) ? config.npcs[target.npcIndex] : null;
    if (!npc) return;
    npc.personaDocs = npc.personaDocs || {};
    npc.personaDocs[target.docKey] = p;
  }

  if (mdEditorTarget && isSameDocTarget(target, mdEditorTarget)) {
    $("md-editor-path").textContent = p || "-";
  }
}

function setMdEditorOpen(open) {
  const layout = $("npc-layout");
  if (!layout) return;
  layout.classList.toggle("with-editor", Boolean(open));
}

function setMdEditorStatus(message) {
  const status = $("md-editor-status");
  if (status) status.textContent = String(message || "");
}

function setMdEditorBusy(busy) {
  const disabled = Boolean(busy);
  if ($("btn-md-reload")) $("btn-md-reload").disabled = disabled;
  if ($("btn-md-save")) $("btn-md-save").disabled = disabled;
  if ($("btn-md-close")) $("btn-md-close").disabled = disabled;
  if ($("md-editor-text")) $("md-editor-text").disabled = disabled;
}

function confirmDiscardEditorChanges() {
  if (!mdEditorDirty) return true;
  return window.confirm("Unsaved markdown changes will be lost. Continue?");
}

function closeMdEditor({ force = false } = {}) {
  if (!force && !confirmDiscardEditorChanges()) return false;

  mdEditorTarget = null;
  mdEditorDirty = false;
  setMdEditorOpen(false);

  const title = $("md-editor-title");
  const path = $("md-editor-path");
  const text = $("md-editor-text");
  if (title) title.textContent = "Selected Markdown";
  if (path) path.textContent = "-";
  if (text) text.value = "";
  setMdEditorStatus("Select any markdown file to edit.");
  setMdEditorBusy(false);
  return true;
}

async function reloadMdEditorFromDisk({ silent = false } = {}) {
  if (!mdEditorTarget) {
    if (!silent) setMdEditorStatus("No markdown target selected.");
    return false;
  }

  currentConfig = ensureConfigShape(currentConfig || {});
  const filePath = getDocTargetPath(currentConfig, mdEditorTarget);
  if (!filePath) {
    setMdEditorStatus("Target path is empty. Select a markdown file first.");
    return false;
  }

  setMdEditorBusy(true);
  setMdEditorStatus(`Loading: ${filePath}`);
  try {
    $("md-editor-text").value = "";
    const read = await window.api.readTextFile(filePath);
    if (!read?.ok) {
      const errText = String(read?.error || "");
      if (errText.includes("ENOENT")) {
        mdEditorDirty = false;
        setMdEditorStatus("File not found. Edit and save to create a new file.");
        return true;
      }
      setMdEditorStatus(`Load failed: ${read?.error || "unknown error"}`);
      return false;
    }

    $("md-editor-text").value = String(read.text || "");
    mdEditorDirty = false;
    setMdEditorStatus("Loaded from disk.");
    return true;
  } catch (e) {
    setMdEditorStatus(`Load failed: ${e?.message || e}`);
    return false;
  } finally {
    setMdEditorBusy(false);
  }
}

async function openMdEditorForTarget(target) {
  currentConfig = ensureConfigShape(currentConfig || {});
  if (!target) return false;

  if (mdEditorTarget && !isSameDocTarget(mdEditorTarget, target) && !confirmDiscardEditorChanges()) {
    return false;
  }

  const filePath = getDocTargetPath(currentConfig, target);
  if (!filePath) {
    appendLog({ ts: Date.now(), level: "warn", scope: "ui", message: "Select a markdown file first." });
    return false;
  }

  mdEditorTarget = {
    kind: String(target.kind || ""),
    npcIndex: Number(target.npcIndex || 0),
    docKey: String(target.docKey || ""),
  };
  mdEditorDirty = false;

  $("md-editor-title").textContent = getDocTargetLabel(currentConfig, target);
  $("md-editor-path").textContent = filePath;
  setMdEditorOpen(true);

  return reloadMdEditorFromDisk({ silent: true });
}

async function saveMdEditorToDisk() {
  if (!mdEditorTarget) {
    setMdEditorStatus("No markdown target selected.");
    return false;
  }

  currentConfig = ensureConfigShape(currentConfig || {});
  const filePath = getDocTargetPath(currentConfig, mdEditorTarget);
  if (!filePath) {
    setMdEditorStatus("Target path is empty. Select a markdown file first.");
    return false;
  }

  const content = String($("md-editor-text")?.value || "");
  setMdEditorBusy(true);
  setMdEditorStatus(`Saving: ${filePath}`);
  try {
    const saved = await window.api.writeTextFile(filePath, content);
    if (!saved?.ok) {
      setMdEditorStatus(`Save failed: ${saved?.error || "unknown error"}`);
      return false;
    }

    mdEditorDirty = false;
    setMdEditorStatus("Saved.");
    appendLog({ ts: Date.now(), level: "info", scope: "ui", message: `markdown saved: ${filePath}` });
    return true;
  } catch (e) {
    setMdEditorStatus(`Save failed: ${e?.message || e}`);
    return false;
  } finally {
    setMdEditorBusy(false);
  }
}

async function pickMarkdownForTarget(target, { openEditor = false } = {}) {
  currentConfig = ensureConfigShape(currentConfig || {});
  const currentPath = getDocTargetPath(currentConfig, target);

  try {
    const picked = await window.api.pickMarkdownFile(currentPath);
    if (!picked?.ok) {
      if (!picked?.canceled) {
        appendLog({
          ts: Date.now(),
          level: "error",
          scope: "ui",
          message: `file select failed: ${picked?.error || "unknown error"}`,
        });
      }
      return false;
    }

    setDocTargetPath(currentConfig, target, picked.path);
    syncWorldDocInputFromConfig(currentConfig);
    renderNpcList(currentConfig);
    setConfigEditor(currentConfig);

    appendLog({ ts: Date.now(), level: "info", scope: "ui", message: `markdown selected: ${picked.path}` });

    if (openEditor) {
      await openMdEditorForTarget(target);
    }
    return true;
  } catch (e) {
    appendLog({ ts: Date.now(), level: "error", scope: "ui", message: `file select failed: ${e?.message || e}` });
    return false;
  }
}

async function editTargetWithFallbackPick(target) {
  currentConfig = ensureConfigShape(currentConfig || {});
  const before = getDocTargetPath(currentConfig, target);
  if (!before) {
    const picked = await pickMarkdownForTarget(target, { openEditor: false });
    if (!picked) return false;
  }
  return openMdEditorForTarget(target);
}
function createDocPathRow({ label, value, placeholder, onChange, onPick, onEdit }) {
  const wrap = document.createElement("div");
  wrap.className = "npc-doc-row";

  const title = document.createElement("label");
  title.textContent = label;

  const row = document.createElement("div");
  row.className = "file-row";

  const input = document.createElement("input");
  input.type = "text";
  input.value = String(value || "");
  input.placeholder = placeholder;
  input.addEventListener("change", () => onChange(String(input.value || "").trim()));

  const pickBtn = document.createElement("button");
  pickBtn.type = "button";
  pickBtn.textContent = "Select";
  pickBtn.addEventListener("click", async () => {
    try {
      await onPick();
    } catch (e) {
      appendLog({ ts: Date.now(), level: "error", scope: "ui", message: `select failed: ${e?.message || e}` });
    }
  });

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.textContent = "Edit";
  editBtn.addEventListener("click", async () => {
    try {
      await onEdit();
    } catch (e) {
      appendLog({ ts: Date.now(), level: "error", scope: "ui", message: `edit failed: ${e?.message || e}` });
    }
  });

  row.appendChild(input);
  row.appendChild(pickBtn);
  row.appendChild(editBtn);

  wrap.appendChild(title);
  wrap.appendChild(row);
  return wrap;
}

function renderNpcList(config) {
  const list = $("npc-list");
  list.innerHTML = "";
  config = ensureConfigShape(config || {});
  const npcs = Array.isArray(config?.npcs) ? config.npcs : [];

  if (!npcs.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "(No NPCs)";
    list.appendChild(empty);
    return;
  }

  for (let i = 0; i < npcs.length; i += 1) {
    const npc = ensureNpcShape(npcs[i], i);

    const card = document.createElement("div");
    card.className = "npc-card";

    const header = document.createElement("div");
    header.className = "npc-header";

    const meta = document.createElement("div");
    meta.className = "npc-meta";

    const name = document.createElement("div");
    name.className = "npc-name";
    name.textContent = npc.displayName || npc.id || `npc_${i}`;

    const sub = document.createElement("div");
    sub.className = "npc-sub";
    sub.textContent = `id=${npc.id || "-"} actor=${npc?.actor?.value || "-"} react<=${Number.isFinite(Number(npc?.triggers?.maxFt)) ? Number(npc.triggers.maxFt) : 0}ft`;

    meta.appendChild(name);
    meta.appendChild(sub);

    const toggle = document.createElement("label");
    toggle.className = "npc-toggle";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = npc.enabled !== false;
    const t = document.createElement("span");
    t.textContent = cb.checked ? "Enabled" : "Disabled";
    cb.addEventListener("change", () => {
      npc.enabled = cb.checked;
      t.textContent = cb.checked ? "Enabled" : "Disabled";
      setConfigEditor(config);
    });
    toggle.appendChild(cb);
    toggle.appendChild(t);

    header.appendChild(meta);
    header.appendChild(toggle);

    const controls = document.createElement("div");
    controls.className = "npc-controls";

    const displayRow = document.createElement("div");
    displayRow.className = "npc-doc-row";

    const displayLabel = document.createElement("label");
    displayLabel.textContent = "NPC Display Name";

    const displayInput = document.createElement("input");
    displayInput.type = "text";
    displayInput.placeholder = "Name used in chat";
    displayInput.value = String(npc?.displayName || "");
    displayInput.addEventListener("change", () => {
      const prevDisplay = String(npc.displayName || "");
      const nextDisplay = String(displayInput.value || "").trim() || prevDisplay || npc.id || `npc_${i}`;
      npc.displayName = nextDisplay;
      const actorCurrent = String(npc?.actor?.value || "").trim();
      if (!actorCurrent || actorCurrent === prevDisplay) {
        npc.actor = npc.actor || { type: "name", value: "" };
        npc.actor.type = "name";
        npc.actor.value = nextDisplay;
        actorInput.value = nextDisplay;
      }
      name.textContent = npc.displayName || npc.id || `npc_${i}`;
      sub.textContent = `id=${npc.id || "-"} actor=${npc?.actor?.value || "-"} react<=${Number.isFinite(Number(npc?.triggers?.maxFt)) ? Number(npc.triggers.maxFt) : 0}ft`;
      setConfigEditor(config);
    });

    const actorRow = document.createElement("div");
    actorRow.className = "npc-doc-row";

    const actorLabel = document.createElement("label");
    actorLabel.textContent = "FVTT Actor Name";

    const actorInput = document.createElement("input");
    actorInput.type = "text";
    actorInput.placeholder = "FVTT Actor name";
    actorInput.value = String(npc?.actor?.value || "");
    actorInput.addEventListener("change", () => {
      npc.actor = npc.actor || { type: "name", value: "" };
      npc.actor.type = "name";
      npc.actor.value = String(actorInput.value || "").trim();
      name.textContent = npc.displayName || npc.id || `npc_${i}`;
      sub.textContent = `id=${npc.id || "-"} actor=${npc?.actor?.value || "-"} react<=${Number.isFinite(Number(npc?.triggers?.maxFt)) ? Number(npc.triggers.maxFt) : 0}ft`;
      setConfigEditor(config);
    });

    actorRow.appendChild(actorLabel);
    actorRow.appendChild(actorInput);

    const reactRow = document.createElement("div");
    reactRow.className = "npc-doc-row";

    const reactLabel = document.createElement("label");
    reactLabel.textContent = "React Distance <= (ft)";

    const reactInput = document.createElement("input");
    reactInput.type = "number";
    reactInput.min = "0";
    reactInput.step = "1";
    reactInput.placeholder = "0 = disabled";
    reactInput.value = String(Number.isFinite(Number(npc?.triggers?.maxFt)) ? Number(npc.triggers.maxFt) : 30);
    reactInput.addEventListener("change", () => {
      npc.triggers = npc.triggers || {};
      const parsed = Number(reactInput.value);
      npc.triggers.maxFt = Number.isFinite(parsed) && parsed >= 0 ? parsed : 30;
      reactInput.value = String(npc.triggers.maxFt);
      sub.textContent = `id=${npc.id || "-"} actor=${npc?.actor?.value || "-"} react<=${Number.isFinite(Number(npc?.triggers?.maxFt)) ? Number(npc.triggers.maxFt) : 0}ft`;
      setConfigEditor(config);
    });

    reactRow.appendChild(reactLabel);
    reactRow.appendChild(reactInput);

    const soulTarget = { kind: "npcDoc", npcIndex: i, docKey: "soul" };
    const soulRow = createDocPathRow({
      label: "Personality / Dialogue (.md)",
      value: npc?.personaDocs?.soul || "",
      placeholder: "C:\\docs\\npc-soul.md",
      onChange: (v) => {
        setDocTargetPath(config, soulTarget, v);
        setConfigEditor(config);
      },
      onPick: () => pickMarkdownForTarget(soulTarget, { openEditor: false }),
      onEdit: () => editTargetWithFallbackPick(soulTarget),
    });

    const battleTarget = { kind: "npcDoc", npcIndex: i, docKey: "battle" };
    const battleRow = createDocPathRow({
      label: "Battle Pattern (.md)",
      value: npc?.personaDocs?.battle || "",
      placeholder: "C:\\docs\\npc-battle.md",
      onChange: (v) => {
        setDocTargetPath(config, battleTarget, v);
        setConfigEditor(config);
      },
      onPick: () => pickMarkdownForTarget(battleTarget, { openEditor: false }),
      onEdit: () => editTargetWithFallbackPick(battleTarget),
    });

    controls.appendChild(displayRow);
    displayRow.appendChild(displayLabel);
    displayRow.appendChild(displayInput);
    controls.appendChild(actorRow);
    controls.appendChild(reactRow);
    controls.appendChild(soulRow);
    controls.appendChild(battleRow);

    card.appendChild(header);
    card.appendChild(controls);
    list.appendChild(card);
  }
}

async function loadConfigFromMainProcess() {
  const cfg = await window.api.getConfig();
  $("config-path").textContent = cfg.configPath || "-";
  currentConfig = ensureConfigShape(cfg.config || {});

  closeMdEditor({ force: true });
  setConfigEditor(currentConfig);
  renderNpcList(currentConfig);
  await loadQuickFormFromConfig(currentConfig);
  return currentConfig;
}

async function saveNpcSettingsOnly() {
  currentConfig = ensureConfigShape(currentConfig || {});
  const worldInput = $("f-world-doc");
  if (worldInput) {
    currentConfig.npc.sharedDocs.world = String(worldInput.value || "").trim();
  }

  const latest = await window.api.getConfig();
  const merged = ensureConfigShape(latest?.config || {});
  merged.npc = cloneJson(currentConfig.npc || {});
  merged.npcs = cloneJson(currentConfig.npcs || []);

  await window.api.setConfig(merged);
  currentConfig = ensureConfigShape(merged);
  setConfigEditor(currentConfig);
  renderNpcList(currentConfig);
  syncWorldDocInputFromConfig(currentConfig);
}

async function reloadNpcSettingsOnly() {
  const latest = await window.api.getConfig();
  const disk = ensureConfigShape(latest?.config || {});
  currentConfig = ensureConfigShape(currentConfig || {});

  currentConfig.npc = cloneJson(disk.npc || {});
  currentConfig.npcs = cloneJson(disk.npcs || []);
  currentConfig.npc = currentConfig.npc && typeof currentConfig.npc === "object" ? currentConfig.npc : {};
  currentConfig.npcs = Array.isArray(currentConfig.npcs) ? currentConfig.npcs : [];

  closeMdEditor({ force: true });
  setConfigEditor(currentConfig);
  renderNpcList(currentConfig);
  syncWorldDocInputFromConfig(currentConfig);
}
async function installPrerequisitesForCurrentConfig({ silent = false } = {}) {
  currentConfig = applyQuickFormToConfig(currentConfig || {});
  if (!silent) {
    appendLog({
      ts: Date.now(),
      level: "info",
      scope: "setup",
      message: "Installing/checking prerequisites for selected provider...",
    });
  }

  const result = await window.api.installPrerequisites(currentConfig);
  if (!result?.ok) {
    throw new Error(result?.error || "prerequisites installation failed");
  }

  currentConfig = ensureConfigShape(result?.config || currentConfig);
  setConfigEditor(currentConfig);
  renderNpcList(currentConfig);
  await loadQuickFormFromConfig(currentConfig);

  if (!silent) {
    const codexBin = String(result?.codexBinPath || "").trim();
    appendLog({
      ts: Date.now(),
      level: "info",
      scope: "setup",
      message: codexBin ? `Prerequisites ready. codex=${codexBin}` : "Prerequisites ready.",
    });
  }
  return result;
}

async function doProviderLogin() {
  currentConfig = applyQuickFormToConfig(currentConfig || {});
  const provider = getProvider(currentConfig);

  if (provider === "codex-cli") {
    await installPrerequisitesForCurrentConfig({ silent: false });
    appendLog({ ts: Date.now(), level: "info", scope: "ui", message: "Launching Codex login terminal..." });
    const res = await window.api.launchCodexLogin(currentConfig);
    if (!res?.ok) {
      throw new Error(res?.error || "failed to launch codex login");
    }
    appendLog({
      ts: Date.now(),
      level: "info",
      scope: "ui",
      message: "Complete login in the opened terminal, then run diagnostics.",
    });
    await refreshProviderStatus(currentConfig);
    return;
  }

  if (provider === "openai-oauth") {
    appendLog({ ts: Date.now(), level: "info", scope: "ui", message: "Starting OpenAI OAuth flow..." });
    const res = await window.api.oauthLoginOpenAiCodex();
    appendLog({
      ts: Date.now(),
      level: "info",
      scope: "ui",
      message: `OAuth complete: ${res?.ok ? "ok" : "unknown"}`,
    });
    await loadConfigFromMainProcess();
    return;
  }

  appendLog({
    ts: Date.now(),
    level: "info",
    scope: "ui",
    message: "API key mode selected. No login button needed.",
  });
  await refreshProviderStatus(currentConfig);
}
async function init() {
  const ver = await window.api.getVersion();
  $("app-version").textContent = ver.version || "-";

  await loadConfigFromMainProcess();

  window.api.onLog((entry) => appendLog(entry));
  window.api.onOauthPrompt(({ promptId, message }) => {
    const value = window.prompt(message || "Paste redirect URL");
    window.api.answerOauthPrompt(promptId, value || "");
  });

  // Quick setup
  $("f-llm-provider").addEventListener("change", async () => {
    currentConfig = applyQuickFormToConfig(currentConfig || {});
    updateQuickSetupUi(currentConfig);
    setConfigEditor(currentConfig);
    await refreshProviderStatus(currentConfig);
  });

  const worldInput = $("f-world-doc");
  if (worldInput) {
    worldInput.addEventListener("change", () => {
      currentConfig = ensureConfigShape(currentConfig || {});
      currentConfig.npc.sharedDocs.world = String(worldInput.value || "").trim();
      setConfigEditor(currentConfig);
    });
  }

  const worldPickButton = $("btn-world-doc-pick");
  if (worldPickButton) {
    worldPickButton.addEventListener("click", async () => {
      await pickMarkdownForTarget({ kind: "world" }, { openEditor: false });
    });
  }

  const worldEditButton = $("btn-world-doc-edit");
  if (worldEditButton) {
    worldEditButton.addEventListener("click", async () => {
      await editTargetWithFallbackPick({ kind: "world" });
    });
  }

  const addNpcButton = $("btn-add-npc");
  if (addNpcButton) {
    addNpcButton.addEventListener("click", () => {
      currentConfig = ensureConfigShape(currentConfig || {});
      const nextNpc = createNpcTemplate(currentConfig);
      currentConfig.npcs.push(nextNpc);
      setConfigEditor(currentConfig);
      renderNpcList(currentConfig);
      appendLog({
        ts: Date.now(),
        level: "info",
        scope: "ui",
        message: `NPC added: id=${nextNpc.id} name=${nextNpc.displayName}`,
      });
    });
  }

  const saveNpcButton = $("btn-save-npc");
  if (saveNpcButton) {
    saveNpcButton.addEventListener("click", async () => {
      saveNpcButton.disabled = true;
      try {
        await saveNpcSettingsOnly();
        appendLog({ ts: Date.now(), level: "info", scope: "ui", message: "npc settings saved" });
      } catch (e) {
        appendLog({ ts: Date.now(), level: "error", scope: "ui", message: `npc save failed: ${e?.message || e}` });
      } finally {
        saveNpcButton.disabled = false;
      }
    });
  }

  const reloadNpcButton = $("btn-reload-npc");
  if (reloadNpcButton) {
    reloadNpcButton.addEventListener("click", async () => {
      reloadNpcButton.disabled = true;
      try {
        await reloadNpcSettingsOnly();
        appendLog({ ts: Date.now(), level: "info", scope: "ui", message: "npc settings reloaded" });
      } catch (e) {
        appendLog({
          ts: Date.now(),
          level: "error",
          scope: "ui",
          message: `npc reload failed: ${e?.message || e}`,
        });
      } finally {
        reloadNpcButton.disabled = false;
      }
    });
  }

  const mdText = $("md-editor-text");
  if (mdText) {
    mdText.addEventListener("input", () => {
      if (!mdEditorTarget) return;
      mdEditorDirty = true;
      setMdEditorStatus("Edited (not saved)");
    });
  }

  const mdReload = $("btn-md-reload");
  if (mdReload) {
    mdReload.addEventListener("click", async () => {
      if (mdEditorDirty && !window.confirm("Reload from disk and discard unsaved changes?")) return;
      await reloadMdEditorFromDisk({ silent: false });
    });
  }

  const mdSave = $("btn-md-save");
  if (mdSave) {
    mdSave.addEventListener("click", async () => {
      await saveMdEditorToDisk();
    });
  }

  const mdClose = $("btn-md-close");
  if (mdClose) {
    mdClose.addEventListener("click", () => {
      closeMdEditor({ force: false });
    });
  }

  const codexBinInput = $("f-codex-bin");
  if (codexBinInput) {
    codexBinInput.addEventListener("change", () => {
      currentConfig = applyQuickFormToConfig(currentConfig || {});
      setConfigEditor(currentConfig);
    });
  }

  const traceToggle = $("f-trace-enabled");
  if (traceToggle) {
    traceToggle.addEventListener("change", () => {
      currentConfig = applyQuickFormToConfig(currentConfig || {});
      setConfigEditor(currentConfig);
    });
  }

  const traceDirInput = $("f-trace-logdir");
  if (traceDirInput) {
    traceDirInput.addEventListener("change", () => {
      currentConfig = applyQuickFormToConfig(currentConfig || {});
      setConfigEditor(currentConfig);
    });
  }

  const loginButtons = ["btn-oauth-inline", "btn-oauth"];
  for (const id of loginButtons) {
    $(id).addEventListener("click", async () => {
      $(id).disabled = true;
      try {
        await doProviderLogin();
      } catch (e) {
        appendLog({ ts: Date.now(), level: "error", scope: "ui", message: `login failed: ${e?.message || e}` });
      } finally {
        $(id).disabled = false;
      }
    });
  }

  $("btn-install-prereq").addEventListener("click", async () => {
    $("btn-install-prereq").disabled = true;
    try {
      await installPrerequisitesForCurrentConfig({ silent: false });
    } catch (e) {
      appendLog({
        ts: Date.now(),
        level: "error",
        scope: "setup",
        message: `prerequisites failed: ${e?.message || e}`,
      });
    } finally {
      $("btn-install-prereq").disabled = false;
    }
  });

  $("btn-save-quick").addEventListener("click", async () => {
    $("btn-save-quick").disabled = true;
    try {
      currentConfig = applyQuickFormToConfig(currentConfig || {});
      await window.api.setConfig(currentConfig);
      appendLog({ ts: Date.now(), level: "info", scope: "ui", message: "config saved (quick setup)" });
      await loadConfigFromMainProcess();
    } catch (e) {
      appendLog({ ts: Date.now(), level: "error", scope: "ui", message: `save failed: ${e?.message || e}` });
    } finally {
      $("btn-save-quick").disabled = false;
    }
  });

  // Advanced config
  $("btn-reload-config").addEventListener("click", async () => {
    $("btn-reload-config").disabled = true;
    try {
      await loadConfigFromMainProcess();
      appendLog({ ts: Date.now(), level: "info", scope: "ui", message: "config reloaded" });
    } catch (e) {
      appendLog({ ts: Date.now(), level: "error", scope: "ui", message: `reload failed: ${e?.message || e}` });
    } finally {
      $("btn-reload-config").disabled = false;
    }
  });

  $("btn-save-config").addEventListener("click", async () => {
    $("btn-save-config").disabled = true;
    try {
      const raw = $("config-editor").value || "{}";
      const parsed = JSON.parse(raw);
      const normalized = ensureConfigShape(parsed);
      await window.api.setConfig(normalized);
      appendLog({ ts: Date.now(), level: "info", scope: "ui", message: "config saved (advanced)" });
      await loadConfigFromMainProcess();
    } catch (e) {
      appendLog({ ts: Date.now(), level: "error", scope: "ui", message: `save failed: ${e?.message || e}` });
    } finally {
      $("btn-save-config").disabled = false;
    }
  });

  // Runtime controls
  $("btn-start").addEventListener("click", async () => {
    $("btn-start").disabled = true;
    try {
      await window.api.startRuntime();
      appendLog({ ts: Date.now(), level: "info", scope: "ui", message: "runtime started" });
    } catch (e) {
      appendLog({ ts: Date.now(), level: "error", scope: "ui", message: `start failed: ${e?.message || e}` });
    } finally {
      $("btn-start").disabled = false;
    }
  });

  $("btn-stop").addEventListener("click", async () => {
    $("btn-stop").disabled = true;
    try {
      await window.api.stopRuntime();
      appendLog({ ts: Date.now(), level: "info", scope: "ui", message: "runtime stopped" });
    } catch (e) {
      appendLog({ ts: Date.now(), level: "error", scope: "ui", message: `stop failed: ${e?.message || e}` });
    } finally {
      $("btn-stop").disabled = false;
    }
  });

  $("btn-diag").addEventListener("click", async () => {
    $("btn-diag").disabled = true;
    $("diag-out").textContent = "running...";
    try {
      const result = await window.api.runDiagnostics();
      $("diag-out").textContent = JSON.stringify(result, null, 2);
      await refreshProviderStatus(currentConfig || {});
    } catch (e) {
      $("diag-out").textContent = `diagnostics failed: ${e?.message || e}`;
    } finally {
      $("btn-diag").disabled = false;
    }
  });

  $("link-spec").addEventListener("click", async (e) => {
    e.preventDefault();
    appendLog({
      ts: Date.now(),
      level: "info",
      scope: "ui",
      message: "Spec is at: fvtt-ai-runtime/Spec.md (open in your editor).",
    });
  });
}

init().catch((e) => {
  appendLog({ ts: Date.now(), level: "error", scope: "ui", message: `init failed: ${e?.message || e}` });
});
