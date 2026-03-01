let currentConfig = null;
let mdEditorTarget = null;
let mdEditorDirty = false;
const PERSONA_DOC_KEYS = ["identity", "soul", "behavior", "battle", "relations", "memory"];

const npcCardExpandedState = new Map();
const npcVisualByNpcId = new Map();
const npcThumbnailFailureByNpcId = new Map();

const NPC_CARD_STATE_STORAGE_KEY = "livenpc:npc-card-expanded:v1";
const NPC_VIRTUALIZATION_THRESHOLD = 24;
const NPC_VIRTUAL_OVERSCAN_PX = 420;
const NPC_VIRTUAL_COLLAPSED_HEIGHT_PX = 72;
const NPC_VIRTUAL_EXPANDED_HEIGHT_PX = 560;
const NPC_VIRTUAL_CARD_GAP_PX = 10;

let npcCardStateLoaded = false;
let npcAvatarLazyObserver = null;
let npcAvatarLazyObserverRoot = null;
let runtimeStarted = false;

function $(id) {
  return document.getElementById(id);
}

function loadNpcCardExpandedStateFromStorage() {
  if (npcCardStateLoaded) return;
  npcCardStateLoaded = true;
  try {
    const raw = window.localStorage?.getItem(NPC_CARD_STATE_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    for (const [npcId, expanded] of Object.entries(parsed)) {
      const id = String(npcId || "").trim();
      if (!id) continue;
      npcCardExpandedState.set(id, Boolean(expanded));
    }
  } catch {
    // ignore storage parse failures
  }
}

function persistNpcCardExpandedStateToStorage() {
  try {
    const out = {};
    for (const [npcId, expanded] of npcCardExpandedState.entries()) {
      const id = String(npcId || "").trim();
      if (!id) continue;
      out[id] = expanded === true;
    }
    window.localStorage?.setItem(NPC_CARD_STATE_STORAGE_KEY, JSON.stringify(out));
  } catch {
    // ignore storage write failures
  }
}

function pruneNpcUiState(config) {
  const ids = new Set(
    (Array.isArray(config?.npcs) ? config.npcs : [])
      .map((npc) => String(npc?.id || "").trim())
      .filter(Boolean)
  );

  let changed = false;
  for (const key of npcCardExpandedState.keys()) {
    if (!ids.has(key)) {
      npcCardExpandedState.delete(key);
      changed = true;
    }
  }
  for (const key of npcVisualByNpcId.keys()) {
    if (!ids.has(key)) npcVisualByNpcId.delete(key);
  }
  for (const key of npcThumbnailFailureByNpcId.keys()) {
    if (!ids.has(key)) npcThumbnailFailureByNpcId.delete(key);
  }

  if (changed) persistNpcCardExpandedStateToStorage();
}

function shouldUseNpcVirtualization(npcs) {
  return Array.isArray(npcs) && npcs.length >= NPC_VIRTUALIZATION_THRESHOLD;
}

function estimateNpcCardHeight(npc) {
  const npcId = String(npc?.id || "").trim();
  if (!npcId) return NPC_VIRTUAL_COLLAPSED_HEIGHT_PX;
  return npcCardExpandedState.get(npcId) === true ? NPC_VIRTUAL_EXPANDED_HEIGHT_PX : NPC_VIRTUAL_COLLAPSED_HEIGHT_PX;
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
  const actorType = String(out.actor.type || "name").toLowerCase();
  out.actor.type = actorType === "id" || actorType === "actorid" ? "id" : "name";
  out.actor.value = String(out.actor.value || out.displayName || "");

  out.personaDocs = out.personaDocs && typeof out.personaDocs === "object" ? out.personaDocs : {};
  for (const key of PERSONA_DOC_KEYS) {
    out.personaDocs[key] = String(out.personaDocs[key] || "");
  }

  out.triggers = out.triggers && typeof out.triggers === "object" ? out.triggers : {};
  if (!Number.isFinite(Number(out.triggers.minFt))) out.triggers.minFt = 2;
  if (!Number.isFinite(Number(out.triggers.maxFt))) out.triggers.maxFt = 30;

  out.image = out.image && typeof out.image === "object" ? out.image : {};
  out.image.enabled = out.image.enabled === true;
  const fallbackPrompt = String(out.image.defaultPrompt || out.image.baseTags || "").trim();
  out.image.defaultPrompt = String(fallbackPrompt || "");
  out.image.baseTags = String(out.image.baseTags || out.image.defaultPrompt || "");
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

  out.imageGeneration =
    out.imageGeneration && typeof out.imageGeneration === "object" ? out.imageGeneration : {};
  out.imageGeneration.webuiUrl = String(out.imageGeneration.webuiUrl || "");
  if (!Number.isFinite(Number(out.imageGeneration.width)) || Number(out.imageGeneration.width) <= 0) {
    out.imageGeneration.width = 768;
  }
  if (!Number.isFinite(Number(out.imageGeneration.height)) || Number(out.imageGeneration.height) <= 0) {
    out.imageGeneration.height = 768;
  }
  if (!Number.isFinite(Number(out.imageGeneration.timeoutMs)) || Number(out.imageGeneration.timeoutMs) < 15000) {
    out.imageGeneration.timeoutMs = 120000;
  }

  out.npcs = Array.isArray(out.npcs) ? out.npcs : [];
  if (!out.npcs.length) {
    out.npcs.push({
      id: "npc1",
      displayName: "NPC",
      enabled: true,
      actor: { type: "name", value: "NPC" },
      personaDocs: { identity: "", soul: "", behavior: "", battle: "", relations: "", memory: "" },
      triggers: { minFt: 2, maxFt: 30 },
      image: { enabled: false, defaultPrompt: "", baseTags: "" },
    });
  }
  out.npcs = out.npcs.map((npc, idx) => ensureNpcShape(npc, idx));
  return out;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function fallbackAvatarText(name) {
  const text = String(name || "").trim();
  if (!text) return "?";
  return text.slice(0, 1).toUpperCase();
}

function resolveNpcThumbnailUrl(raw, config) {
  const src = String(raw || "").trim();
  if (!src) return "";
  if (/^(data:|blob:|https?:|file:)/i.test(src)) return src;

  const base = String(config?.foundry?.url || "").trim();
  if (!base) return src;
  try {
    const normalizedBase = base.endsWith("/") ? base : `${base}/`;
    return new URL(src.replace(/^\//, ""), normalizedBase).toString();
  } catch {
    return src;
  }
}

function updateNpcVisualMap(visuals) {
  const rows = Array.isArray(visuals) ? visuals : [];
  const nextMap = new Map();
  for (const row of rows) {
    const npcId = String(row?.npcId || "").trim();
    if (!npcId) continue;
    nextMap.set(npcId, row);
  }

  for (const [npcId, row] of nextMap.entries()) {
    const nextThumb = String(row?.thumbnail || "").trim();
    const failedThumb = String(npcThumbnailFailureByNpcId.get(npcId) || "").trim();
    if (nextThumb && failedThumb && nextThumb !== failedThumb) {
      npcThumbnailFailureByNpcId.delete(npcId);
    }
  }

  npcVisualByNpcId.clear();
  for (const [npcId, row] of nextMap.entries()) {
    npcVisualByNpcId.set(npcId, row);
  }
}

async function refreshNpcVisuals({ silent = false } = {}) {
  if (!window.api?.getNpcVisuals) return false;

  const config = ensureConfigShape(currentConfig || {});
  try {
    const result = await window.api.getNpcVisuals(config);
    const visuals = Array.isArray(result?.visuals) ? result.visuals : [];

    if (!result?.ok && visuals.length === 0) {
      if (!silent) {
        appendLog({
          ts: Date.now(),
          level: "warn",
          scope: "ui",
          message: `token visuals unavailable: ${result?.error || "runtime-not-started"}`,
        });
      }
      return false;
    }

    updateNpcVisualMap(visuals);
    renderNpcList(config);

    if (!silent) {
      const ready = visuals.filter((v) => String(v?.thumbnail || "").trim()).length;
      appendLog({
        ts: Date.now(),
        level: "info",
        scope: "ui",
        message: `token visuals synced: ${ready}/${visuals.length}`,
      });
    }
    return true;
  } catch (e) {
    if (!silent) {
      appendLog({
        ts: Date.now(),
        level: "warn",
        scope: "ui",
        message: `token visuals failed: ${e?.message || e}`,
      });
    }
    return false;
  }
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
  const defaultImagePrompt = String(diana?.image?.defaultPrompt || diana?.image?.baseTags || "");
  const defaultImageEnabled = diana?.image?.enabled === true;

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
      image: {
        enabled: defaultImageEnabled,
        defaultPrompt: defaultImagePrompt,
        baseTags: defaultImagePrompt,
      },
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
  $("f-image-webui-url").value = String(config?.imageGeneration?.webuiUrl || "");
  $("f-image-width").value = String(config?.imageGeneration?.width || 768);
  $("f-image-height").value = String(config?.imageGeneration?.height || 768);

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

  config.imageGeneration = config.imageGeneration || {};
  config.imageGeneration.webuiUrl = String($("f-image-webui-url")?.value || "").trim();
  const imageWidth = Number($("f-image-width")?.value);
  const imageHeight = Number($("f-image-height")?.value);
  config.imageGeneration.width = Number.isFinite(imageWidth) && imageWidth > 0 ? Math.round(imageWidth) : 768;
  config.imageGeneration.height = Number.isFinite(imageHeight) && imageHeight > 0 ? Math.round(imageHeight) : 768;
  const timeoutMs = Number(config.imageGeneration.timeoutMs);
  config.imageGeneration.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs >= 15000 ? timeoutMs : 120000;

  const worldDocInput = $("f-world-doc");
  config.npc.sharedDocs.world = String(worldDocInput?.value || "").trim();

  updateQuickSetupUi(config);
  return config;
}

function setMainTab(tabId) {
  const wanted = String(tabId || "basic");
  const buttons = document.querySelectorAll("[data-main-tab-btn]");
  const panels = document.querySelectorAll("[data-main-tab-content]");
  buttons.forEach((btn) => {
    const active = String(btn.dataset.mainTabBtn || "") === wanted;
    btn.classList.toggle("active", active);
  });
  panels.forEach((panel) => {
    const active = String(panel.dataset.mainTabContent || "") === wanted;
    panel.classList.toggle("active", active);
  });

  if (wanted === "npc" && currentConfig) {
    window.requestAnimationFrame(() => {
      renderNpcList(currentConfig);
    });
  }
}

function setBasicTab(tabId) {
  const wanted = String(tabId || "runtime");
  const buttons = document.querySelectorAll("[data-basic-tab-btn]");
  const panels = document.querySelectorAll("[data-basic-tab-content]");
  buttons.forEach((btn) => {
    const active = String(btn.dataset.basicTabBtn || "") === wanted;
    btn.classList.toggle("active", active);
  });
  panels.forEach((panel) => {
    const active = String(panel.dataset.basicTabContent || "") === wanted;
    panel.classList.toggle("active", active);
  });
}

function initTabUi() {
  document.querySelectorAll("[data-main-tab-btn]").forEach((btn) => {
    btn.addEventListener("click", () => setMainTab(btn.dataset.mainTabBtn || "basic"));
  });
  document.querySelectorAll("[data-basic-tab-btn]").forEach((btn) => {
    btn.addEventListener("click", () => setBasicTab(btn.dataset.basicTabBtn || "runtime"));
  });
  setMainTab("basic");
  setBasicTab("runtime");
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

function npcConditionLabel(flagKey) {
  const key = String(flagKey || "").trim().toLowerCase();
  if (!key) return "";
  const table = {
    dead: "사망",
    unconscious: "기절",
    concentrating: "집중",
    bleeding: "출혈",
    prone: "넘어짐",
    stunned: "충격",
    restrained: "속박",
    grappled: "붙잡힘",
    incapacitated: "행동불가",
    paralyzed: "마비",
    blinded: "실명",
    deafened: "난청",
    frightened: "공포",
    charmed: "매혹",
    poisoned: "중독",
  };
  return table[key] || key;
}

function collectNpcConditionLabels(visual) {
  const labels = [];
  const seen = new Set();

  const addLabel = (raw) => {
    const label = String(raw || "").trim();
    if (!label || seen.has(label)) return;
    seen.add(label);
    labels.push(label);
  };

  const flags = Array.isArray(visual?.conditionFlags) ? visual.conditionFlags : [];
  for (const flag of flags) {
    addLabel(npcConditionLabel(flag));
  }

  const conditions = visual?.conditions && typeof visual.conditions === "object" ? visual.conditions : {};
  for (const [key, value] of Object.entries(conditions)) {
    if (!value) continue;
    addLabel(npcConditionLabel(key));
  }

  return labels.slice(0, 4);
}

function formatNpcHpHeaderText(visual) {
  const hp = visual?.hp && typeof visual.hp === "object" ? visual.hp : {};
  const value = Number(hp.value);
  const max = Number(hp.max);
  const temp = Number(hp.temp ?? 0);
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return "HP ?/?";
  const percent = Math.round((value / max) * 100);
  return `HP ${value}/${max}${Number.isFinite(temp) && temp > 0 ? `(+${temp})` : ""} ${percent}%`;
}

function formatNpcHeaderStateSummary(visual) {
  if (!visual || !visual.ok) {
    return runtimeStarted ? "상태: 토큰/배우 미해결" : "상태: Start 후 동기화";
  }

  const parts = [formatNpcHpHeaderText(visual)];
  const conditionLabels = collectNpcConditionLabels(visual);
  parts.push(conditionLabels.length ? conditionLabels.join(", ") : "정상");

  if (visual?.isDeadLike) parts.push("전투불가");
  else if (visual?.inCombat) parts.push("전투참가");
  else parts.push("비전투");

  return parts.join(" | ");
}

function setNpcAvatarFallback(avatar, displayName) {
  avatar.innerHTML = "";
  const fallback = document.createElement("div");
  fallback.className = "npc-avatar-fallback";
  fallback.textContent = fallbackAvatarText(displayName);
  avatar.appendChild(fallback);
}

function ensureNpcAvatarLazyObserver() {
  if (typeof window.IntersectionObserver !== "function") return null;
  const list = $("npc-list");
  if (!list) return null;

  if (npcAvatarLazyObserver && npcAvatarLazyObserverRoot === list) return npcAvatarLazyObserver;

  if (npcAvatarLazyObserver) {
    try {
      npcAvatarLazyObserver.disconnect();
    } catch {
      // ignore
    }
  }

  npcAvatarLazyObserverRoot = list;
  npcAvatarLazyObserver = new window.IntersectionObserver(
    (entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const img = entry.target;
        const src = String(img?.dataset?.src || "").trim();
        if (src && !img.getAttribute("src")) {
          img.setAttribute("src", src);
        }
        observer.unobserve(img);
      }
    },
    { root: list, rootMargin: "220px 0px" }
  );

  return npcAvatarLazyObserver;
}

function appendNpcAvatarImage({ avatar, npcId, displayName, thumbnailUrl }) {
  const src = String(thumbnailUrl || "").trim();
  const failed = String(npcThumbnailFailureByNpcId.get(npcId) || "").trim();
  if (!src || (failed && failed === src)) {
    setNpcAvatarFallback(avatar, displayName);
    return;
  }

  avatar.innerHTML = "";
  const img = document.createElement("img");
  img.alt = `${displayName} token`;
  img.loading = "lazy";
  img.decoding = "async";
  img.dataset.src = src;
  img.addEventListener("error", () => {
    const failedSrc = String(img.dataset.src || img.currentSrc || img.src || "").trim();
    if (failedSrc) npcThumbnailFailureByNpcId.set(npcId, failedSrc);
    setNpcAvatarFallback(avatar, displayName);
  });
  img.addEventListener("load", () => {
    const failedSrc = String(npcThumbnailFailureByNpcId.get(npcId) || "").trim();
    if (failedSrc === src) npcThumbnailFailureByNpcId.delete(npcId);
  });

  avatar.appendChild(img);

  const observer = ensureNpcAvatarLazyObserver();
  if (observer) {
    observer.observe(img);
  } else {
    img.src = src;
  }
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

function createNpcCardElement(config, npc, i, { virtualized = false } = {}) {
  const npcId = String(npc?.id || `npc_${i}`);
  const card = document.createElement("div");
  card.className = "npc-card";

  const headerMain = document.createElement("button");
  headerMain.type = "button";
  headerMain.className = "npc-header-main";

  const avatar = document.createElement("div");
  avatar.className = "npc-avatar";

  const meta = document.createElement("div");
  meta.className = "npc-meta";

  const name = document.createElement("div");
  name.className = "npc-name";

  const sub = document.createElement("div");
  sub.className = "npc-sub";

  const state = document.createElement("div");
  state.className = "npc-state";

  const expandIndicator = document.createElement("span");
  expandIndicator.className = "npc-expand-indicator";
  expandIndicator.textContent = "▾";

  const controls = document.createElement("div");
  controls.className = "npc-controls";

  const summary = document.createElement("div");
  summary.className = "npc-summary";

  const updateSummary = () => {
    summary.textContent = `id=${npc.id || "-"} actor=${npc?.actor?.value || "-"} react<=${Number.isFinite(Number(npc?.triggers?.maxFt)) ? Number(npc.triggers.maxFt) : 0}ft image=${npc?.image?.enabled ? "on" : "off"}`;
  };

  const setCardExpanded = (nextExpanded, { reflow = true } = {}) => {
    const expanded = Boolean(nextExpanded);
    npcCardExpandedState.set(npcId, expanded);
    persistNpcCardExpandedStateToStorage();
    card.classList.toggle("expanded", expanded);
    headerMain.setAttribute("aria-expanded", expanded ? "true" : "false");
    if (virtualized && reflow) {
      renderNpcList(config);
    }
  };

  const renderCardHeader = () => {
    const visual = npcVisualByNpcId.get(npcId) || null;
    const displayName = String(npc.displayName || npc.id || `npc_${i}`);
    const resolvedThumb = resolveNpcThumbnailUrl(visual?.thumbnail || "", config);

    name.textContent = displayName;
    if (visual?.tokenName) {
      sub.textContent = `token: ${visual.tokenName}`;
    } else if (visual?.actorName) {
      sub.textContent = `actor: ${visual.actorName}`;
    } else {
      sub.textContent = runtimeStarted ? "token: not resolved" : "token: sync after Start";
    }
    state.textContent = formatNpcHeaderStateSummary(visual);

    appendNpcAvatarImage({
      avatar,
      npcId,
      displayName,
      thumbnailUrl: resolvedThumb,
    });
  };

  const controlActions = document.createElement("div");
  controlActions.className = "npc-control-actions";

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

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "danger";
  deleteBtn.textContent = "Delete NPC";
  deleteBtn.addEventListener("click", () => {
    const answer = window.prompt(`'${npc.displayName || npc.id}' NPC를 정말 삭제하시겠습니까?\n삭제하려면 yes 를 입력하세요.`);
    if (String(answer || "").trim().toLowerCase() !== "yes") return;
    closeMdEditor({ force: true });
    npcCardExpandedState.delete(npcId);
    persistNpcCardExpandedStateToStorage();
    npcVisualByNpcId.delete(npcId);
    npcThumbnailFailureByNpcId.delete(npcId);
    config.npcs.splice(i, 1);
    setConfigEditor(config);
    renderNpcList(config);
    appendLog({
      ts: Date.now(),
      level: "info",
      scope: "ui",
      message: `NPC deleted: id=${npc.id} name=${npc.displayName || npc.id}`,
    });
  });

  controlActions.appendChild(toggle);
  controlActions.appendChild(deleteBtn);
  controls.appendChild(controlActions);
  updateSummary();
  controls.appendChild(summary);

  const displayRow = document.createElement("div");
  displayRow.className = "npc-doc-row";
  const displayLabel = document.createElement("label");
  displayLabel.textContent = "NPC Display Name";
  const displayInput = document.createElement("input");
  displayInput.type = "text";
  displayInput.placeholder = "Name used in chat";
  displayInput.value = String(npc?.displayName || "");

  const actorRow = document.createElement("div");
  actorRow.className = "npc-doc-row";
  const actorLabel = document.createElement("label");
  actorLabel.textContent = "FVTT Actor Name";
  const actorInput = document.createElement("input");
  actorInput.type = "text";
  actorInput.placeholder = "FVTT Actor name";
  actorInput.value = String(npc?.actor?.value || "");

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
    updateSummary();
    renderCardHeader();
    setConfigEditor(config);
  });

  actorInput.addEventListener("change", () => {
    npc.actor = npc.actor || { type: "name", value: "" };
    npc.actor.type = "name";
    npc.actor.value = String(actorInput.value || "").trim();
    npcVisualByNpcId.delete(npcId);
    npcThumbnailFailureByNpcId.delete(npcId);
    updateSummary();
    renderCardHeader();
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
    updateSummary();
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

  const imageDetails = document.createElement("details");
  imageDetails.className = "npc-image-details";
  if (npc?.image?.enabled || String(npc?.image?.defaultPrompt || npc?.image?.baseTags || "").trim()) {
    imageDetails.open = true;
  }

  const imageSummary = document.createElement("summary");
  imageSummary.textContent = "Image Prompt Settings";
  imageDetails.appendChild(imageSummary);

  const imageBody = document.createElement("div");
  imageBody.className = "npc-image-body";

  const imageEnableRow = document.createElement("label");
  imageEnableRow.className = "npc-toggle";
  const imageEnableCb = document.createElement("input");
  imageEnableCb.type = "checkbox";
  imageEnableCb.checked = npc?.image?.enabled === true;
  const imageEnableText = document.createElement("span");
  imageEnableText.textContent = imageEnableCb.checked ? "Image Enabled" : "Image Disabled";
  imageEnableCb.addEventListener("change", () => {
    npc.image = npc.image || {};
    npc.image.enabled = imageEnableCb.checked;
    imageEnableText.textContent = imageEnableCb.checked ? "Image Enabled" : "Image Disabled";
    updateSummary();
    setConfigEditor(config);
  });
  imageEnableRow.appendChild(imageEnableCb);
  imageEnableRow.appendChild(imageEnableText);

  const imagePromptRow = document.createElement("div");
  imagePromptRow.className = "npc-doc-row";
  const imagePromptLabel = document.createElement("label");
  imagePromptLabel.textContent = "NPC 기본 이미지 프롬프트";
  const imagePromptArea = document.createElement("textarea");
  imagePromptArea.className = "npc-textarea";
  imagePromptArea.placeholder = "e.g. female knight, dark fantasy, dramatic lighting";
  imagePromptArea.value = String(npc?.image?.defaultPrompt || npc?.image?.baseTags || "");
  imagePromptArea.addEventListener("change", () => {
    npc.image = npc.image || {};
    npc.image.defaultPrompt = String(imagePromptArea.value || "").trim();
    // Keep baseTags for backward compatibility with older runtime fields.
    npc.image.baseTags = npc.image.defaultPrompt;
    setConfigEditor(config);
  });
  imagePromptRow.appendChild(imagePromptLabel);
  imagePromptRow.appendChild(imagePromptArea);

  imageBody.appendChild(imageEnableRow);
  imageBody.appendChild(imagePromptRow);
  imageDetails.appendChild(imageBody);

  controls.appendChild(displayRow);
  displayRow.appendChild(displayLabel);
  displayRow.appendChild(displayInput);
  controls.appendChild(actorRow);
  controls.appendChild(reactRow);
  controls.appendChild(soulRow);
  controls.appendChild(battleRow);
  controls.appendChild(imageDetails);

  meta.appendChild(name);
  meta.appendChild(sub);
  meta.appendChild(state);

  headerMain.appendChild(avatar);
  headerMain.appendChild(meta);
  headerMain.appendChild(expandIndicator);
  headerMain.addEventListener("click", () => {
    const expanded = card.classList.contains("expanded");
    setCardExpanded(!expanded, { reflow: true });
  });

  card.appendChild(headerMain);
  card.appendChild(controls);
  setCardExpanded(npcCardExpandedState.get(npcId) === true, { reflow: false });
  renderCardHeader();
  return card;
}

function renderNpcListStandard(list, config, npcs) {
  list.classList.remove("virtualized");
  list.innerHTML = "";
  for (let i = 0; i < npcs.length; i += 1) {
    const npc = ensureNpcShape(npcs[i], i);
    list.appendChild(createNpcCardElement(config, npc, i, { virtualized: false }));
  }
}

function renderNpcListVirtualized(list, config, npcs) {
  list.classList.add("virtualized");
  if (!list.__npcVirtualScrollHandler) {
    list.__npcVirtualScrollHandler = () => {
      if (!list.classList.contains("virtualized")) return;
      if (list.__npcVirtualScrollRaf) return;
      list.__npcVirtualScrollRaf = window.requestAnimationFrame(() => {
        list.__npcVirtualScrollRaf = 0;
        renderNpcList(currentConfig || config);
      });
    };
    list.addEventListener("scroll", list.__npcVirtualScrollHandler, { passive: true });
  }

  let inner = list.querySelector(".npc-virtual-inner");
  if (!inner) {
    list.innerHTML = "";
    inner = document.createElement("div");
    inner.className = "npc-virtual-inner";
    list.appendChild(inner);
  }

  const heights = npcs.map((npc) => estimateNpcCardHeight(npc));
  const tops = [];
  let cursor = 0;
  for (let i = 0; i < npcs.length; i += 1) {
    tops.push(cursor);
    cursor += heights[i] + NPC_VIRTUAL_CARD_GAP_PX;
  }
  const totalHeight = Math.max(0, cursor - NPC_VIRTUAL_CARD_GAP_PX);
  inner.style.height = `${totalHeight}px`;

  if (!npcs.length) {
    inner.innerHTML = "";
    return;
  }

  const viewTop = Number(list.scrollTop || 0);
  const viewHeight = Math.max(1, Number(list.clientHeight || 720));
  const minY = Math.max(0, viewTop - NPC_VIRTUAL_OVERSCAN_PX);
  const maxY = viewTop + viewHeight + NPC_VIRTUAL_OVERSCAN_PX;

  let start = 0;
  while (start < npcs.length && tops[start] + heights[start] < minY) {
    start += 1;
  }
  if (start >= npcs.length) {
    start = npcs.length - 1;
  }

  let endExclusive = start;
  while (endExclusive < npcs.length && tops[endExclusive] <= maxY) {
    endExclusive += 1;
  }
  const end = Math.max(start, Math.min(npcs.length - 1, endExclusive - 1));

  inner.innerHTML = "";
  for (let i = start; i <= end; i += 1) {
    const npc = ensureNpcShape(npcs[i], i);
    const card = createNpcCardElement(config, npc, i, { virtualized: true });
    card.style.position = "absolute";
    card.style.left = "0";
    card.style.right = "0";
    card.style.top = `${tops[i]}px`;
    card.style.height = `${heights[i]}px`;
    inner.appendChild(card);
  }
}

function renderNpcList(config) {
  const list = $("npc-list");
  if (!list) return;

  loadNpcCardExpandedStateFromStorage();
  config = ensureConfigShape(config || {});
  pruneNpcUiState(config);

  const npcs = Array.isArray(config?.npcs) ? config.npcs : [];
  if (!npcs.length) {
    list.classList.remove("virtualized");
    list.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "(No NPCs)";
    list.appendChild(empty);
    return;
  }

  if (shouldUseNpcVirtualization(npcs)) {
    renderNpcListVirtualized(list, config, npcs);
    return;
  }

  renderNpcListStandard(list, config, npcs);
}

async function loadConfigFromMainProcess() {
  const cfg = await window.api.getConfig();
  $("config-path").textContent = cfg.configPath || "-";
  currentConfig = ensureConfigShape(cfg.config || {});

  closeMdEditor({ force: true });
  setConfigEditor(currentConfig);
  renderNpcList(currentConfig);
  await loadQuickFormFromConfig(currentConfig);
  if (runtimeStarted) {
    await refreshNpcVisuals({ silent: true });
  }
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

  initTabUi();
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
      npcCardExpandedState.set(String(nextNpc.id || ""), false);
      npcThumbnailFailureByNpcId.delete(String(nextNpc.id || ""));
      persistNpcCardExpandedStateToStorage();
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

  const refreshNpcVisualsButton = $("btn-refresh-npc-visuals");
  if (refreshNpcVisualsButton) {
    refreshNpcVisualsButton.addEventListener("click", async () => {
      refreshNpcVisualsButton.disabled = true;
      try {
        await refreshNpcVisuals({ silent: false });
      } finally {
        refreshNpcVisualsButton.disabled = false;
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

  const imageWebUiInput = $("f-image-webui-url");
  if (imageWebUiInput) {
    imageWebUiInput.addEventListener("change", () => {
      currentConfig = applyQuickFormToConfig(currentConfig || {});
      setConfigEditor(currentConfig);
    });
  }

  const imageWidthInput = $("f-image-width");
  if (imageWidthInput) {
    imageWidthInput.addEventListener("change", () => {
      currentConfig = applyQuickFormToConfig(currentConfig || {});
      setConfigEditor(currentConfig);
    });
  }

  const imageHeightInput = $("f-image-height");
  if (imageHeightInput) {
    imageHeightInput.addEventListener("change", () => {
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
      runtimeStarted = true;
      appendLog({ ts: Date.now(), level: "info", scope: "ui", message: "runtime started" });
      await refreshNpcVisuals({ silent: false });
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
      runtimeStarted = false;
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

  window.addEventListener("resize", () => {
    if (currentConfig) {
      renderNpcList(currentConfig);
    }
  });
}

init().catch((e) => {
  appendLog({ ts: Date.now(), level: "error", scope: "ui", message: `init failed: ${e?.message || e}` });
});
