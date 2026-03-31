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
const NPC_VIRTUAL_EXPANDED_HEIGHT_PX = 980;
const NPC_VIRTUAL_CARD_GAP_PX = 10;

let npcCardStateLoaded = false;
let npcAvatarLazyObserver = null;
let npcAvatarLazyObserverRoot = null;
let runtimeStarted = false;
let selectedSocialPresetId = "";
let selectedSocialTabId = "simple";
let selectedStorybookGraphId = "";
let selectedStorybookNodeId = "";
let selectedStorybookTransitionId = "";
let socialStatusPollTimer = null;

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

function normalizeDirectorMode(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "off" || raw === "disabled") return "off";
  if (raw === "directed" || raw === "scene" || raw === "conversation") return "directed";
  return "nearby";
}

function normalizeOptionalBool(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

function optionalBoolSelectValue(value) {
  if (value === true) return "on";
  if (value === false) return "off";
  return "global";
}

function parseOptionalBoolSelectValue(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "on" || raw === "true" || raw === "yes") return true;
  if (raw === "off" || raw === "false" || raw === "no") return false;
  return null;
}

function parseJsonArrayText(value, fallback = []) {
  const text = String(value || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function formatJsonArrayText(value) {
  const list = Array.isArray(value) ? value : [];
  return JSON.stringify(list, null, 2);
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function ensureAmbientShape(ambient, directorFallback = null) {
  const out = ambient && typeof ambient === "object" ? ambient : {};
  const fallback = directorFallback && typeof directorFallback === "object" ? directorFallback : {};
  const legacyEnabled = fallback.enabled === true && fallback.allowAmbientTalk !== false;
  out.enabled = out.enabled === true || (out.enabled === undefined ? legacyEnabled : false);
  out.promptFile = String(out.promptFile || "");
  out.promptText = String(out.promptText || "");
  return out;
}

function ensureScenePresetShape(preset, index = 0, directorFallback = null, ambientFallback = null) {
  const out = preset && typeof preset === "object" ? preset : {};
  out.id = String(out.id || out.presetId || `scene-preset-${index + 1}`);
  out.label = String(
    out.label || out.name || out.sceneName || out.mapName || out.sceneId || out.mapId || `Scene Preset ${index + 1}`
  );
  out.sceneId = String(out.sceneId || out.mapId || "");
  out.sceneName = String(out.sceneName || out.mapName || "");
  out.worldStateText = String(out.worldStateText || out.worldSetupText || "");
  out.director = ensureDirectorGlobalShape(out.director, directorFallback);
  out.ambient = ensureAmbientShape(out.ambient, ambientFallback || out.director);
  out.npcOverrides = Array.isArray(out.npcOverrides) ? out.npcOverrides : [];
  out.npcOverrides = out.npcOverrides
    .map((override) => {
      const next = override && typeof override === "object" ? override : {};
      next.npcId = String(next.npcId || next.id || next.name || "");
      next.displayName = String(next.displayName || next.name || next.npcId || "");
      next.director = normalizeNpcDirectorOverrideShape(next.director || next);
      return next;
    })
    .filter((override) => String(override.npcId || "").trim());
  return out;
}

function normalizeStorybookMode(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "node" || raw === "node-storybook" || raw === "storybook" || raw === "graph") return "node-storybook";
  return "simple";
}

function ensureStorybookConditionShape(condition) {
  if (condition && typeof condition === "object" && !Array.isArray(condition)) {
    return {
      ...condition,
      type: String(condition.type || condition.kind || "always").trim() || "always",
      note: String(condition.note || ""),
      targetNodeId: String(condition.targetNodeId || condition.nextNodeId || ""),
    };
  }
  const text = String(condition || "").trim();
  return {
    type: text || "always",
    note: "",
    targetNodeId: "",
  };
}

function ensureStorybookTransitionShape(transition, index = 0) {
  const out = transition && typeof transition === "object" ? transition : {};
  out.id = String(out.id || out.transitionId || `transition-${index + 1}`);
  out.label = String(out.label || out.name || out.id || `Transition ${index + 1}`);
  out.nextNodeId = String(out.nextNodeId || out.targetNodeId || "");
  const rawConditions = Array.isArray(out.conditions) ? out.conditions : [];
  out.conditions = rawConditions.map((condition) => ensureStorybookConditionShape(condition)).filter(Boolean);
  return out;
}

function ensureStorybookNodeShape(node, index = 0) {
  const out = node && typeof node === "object" ? node : {};
  out.id = String(out.id || out.nodeId || `node-${index + 1}`);
  out.label = String(out.label || out.name || out.id || `Node ${index + 1}`);
  out.enabled = out.enabled !== false;
  const npcIds = Array.isArray(out.npcIds) ? out.npcIds : typeof out.npcIds === "string" ? out.npcIds.split(",") : [];
  out.npcIds = npcIds.map((value) => String(value || "").trim()).filter(Boolean);
  out.objectiveText = String(out.objectiveText || out.objective || "");
  out.stageDirections = String(out.stageDirections || out.directions || "");
  const rawTransitions = Array.isArray(out.transitions) ? out.transitions : [];
  out.transitions = rawTransitions.map((transition, transitionIndex) => ensureStorybookTransitionShape(transition, transitionIndex));
  return out;
}

function ensureStorybookGraphShape(graph, index = 0) {
  const out = graph && typeof graph === "object" ? graph : {};
  out.id = String(out.id || out.graphId || `story-graph-${index + 1}`);
  out.label = String(out.label || out.name || out.sceneName || out.sceneId || out.id || `Graph ${index + 1}`);
  out.enabled = out.enabled !== false;
  out.sceneId = String(out.sceneId || out.mapId || "");
  out.sceneName = String(out.sceneName || out.mapName || "");
  out.entryNodeId = String(out.entryNodeId || out.startNodeId || "");
  out.notes = String(out.notes || out.worldStateText || "");
  const rawNodes = Array.isArray(out.nodes) ? out.nodes : [];
  out.nodes = rawNodes.map((node, nodeIndex) => ensureStorybookNodeShape(node, nodeIndex));
  return out;
}

function ensureStorybookShape(rawStorybook) {
  const out = rawStorybook && typeof rawStorybook === "object" ? rawStorybook : {};
  out.enabled = out.enabled === true;
  out.mode = normalizeStorybookMode(out.mode);
  out.promptFile = String(out.promptFile || "");
  out.promptText = String(out.promptText || "");
  const rawGraphs = Array.isArray(out.graphs) ? out.graphs : [];
  out.graphs = rawGraphs.map((graph, index) => ensureStorybookGraphShape(graph, index));
  return out;
}

function normalizeNpcDirectorOverrideShape(director) {
  const out = director && typeof director === "object" ? director : {};
  out.enabled = normalizeOptionalBool(out.enabled);
  out.allowAmbientTalk = normalizeOptionalBool(out.allowAmbientTalk);
  out.allowNpcToNpc = normalizeOptionalBool(out.allowNpcToNpc);
  out.socialWeight = Number.isFinite(Number(out.socialWeight)) ? Number(out.socialWeight) : 1;
  out.playerNearbyFt = Number.isFinite(Number(out.playerNearbyFt)) ? Number(out.playerNearbyFt) : null;
  out.npcCooldownMs = Number.isFinite(Number(out.npcCooldownMs)) ? Number(out.npcCooldownMs) : null;
  out.promptFile = String(out.promptFile || "");
  out.promptText = String(out.promptText || "");
  return out;
}

function ensureDirectorGlobalShape(director, fallback = null) {
  const out = director && typeof director === "object" ? director : {};
  const base = fallback && typeof fallback === "object" ? fallback : {};
  out.enabled = out.enabled === true || (out.enabled === undefined ? base.enabled === true : false);
  out.mode = normalizeDirectorMode(out.mode || base.mode || "nearby");
  out.promptFile = String(out.promptFile || base.promptFile || ".\\persona-defaults\\director.md");
  out.promptText = String(out.promptText || base.promptText || "");
  out.allowAmbientTalk = out.allowAmbientTalk === undefined ? base.allowAmbientTalk !== false : out.allowAmbientTalk !== false;
  out.allowNpcToNpc = out.allowNpcToNpc === undefined ? base.allowNpcToNpc !== false : out.allowNpcToNpc !== false;
  if (!Number.isFinite(Number(out.playerNearbyFt))) out.playerNearbyFt = Number.isFinite(Number(base.playerNearbyFt)) ? Number(base.playerNearbyFt) : 30;
  if (!Number.isFinite(Number(out.maxChainTurns))) out.maxChainTurns = Number.isFinite(Number(base.maxChainTurns)) ? Number(base.maxChainTurns) : 2;
  if (!Number.isFinite(Number(out.maxParticipants))) out.maxParticipants = Number.isFinite(Number(base.maxParticipants)) ? Number(base.maxParticipants) : 3;
  if (!Number.isFinite(Number(out.npcCooldownMs))) out.npcCooldownMs = Number.isFinite(Number(base.npcCooldownMs)) ? Number(base.npcCooldownMs) : 45000;
  if (!Number.isFinite(Number(out.sceneCooldownMs))) out.sceneCooldownMs = Number.isFinite(Number(base.sceneCooldownMs)) ? Number(base.sceneCooldownMs) : 15000;
  if (!Number.isFinite(Number(out.tokenBudgetPerWindow))) out.tokenBudgetPerWindow = Number.isFinite(Number(base.tokenBudgetPerWindow)) ? Number(base.tokenBudgetPerWindow) : 8;
  if (!Number.isFinite(Number(out.tokenBudgetWindowMs))) out.tokenBudgetWindowMs = Number.isFinite(Number(base.tokenBudgetWindowMs)) ? Number(base.tokenBudgetWindowMs) : 600000;
  if (!Number.isFinite(Number(out.lineDelayMinMs))) out.lineDelayMinMs = Number.isFinite(Number(base.lineDelayMinMs)) ? Number(base.lineDelayMinMs) : 300;
  if (!Number.isFinite(Number(out.lineDelayMaxMs))) out.lineDelayMaxMs = Number.isFinite(Number(base.lineDelayMaxMs)) ? Number(base.lineDelayMaxMs) : 900;
  return out;
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

  out.foundry = out.foundry && typeof out.foundry === "object" ? out.foundry : {};
  out.foundry.sessionId = String(out.foundry.sessionId || out.foundry.binding || "");
  out.foundry.userId = String(out.foundry.userId || out.foundry.fvttUserId || "");
  out.foundry.username = String(out.foundry.username || out.foundry.userName || "");

  out.director = normalizeNpcDirectorOverrideShape(out.director);

  out.image = out.image && typeof out.image === "object" ? out.image : {};
  out.image.enabled = out.image.enabled === true;
  const fallbackPrompt = String(out.image.defaultPrompt || out.image.baseTags || "").trim();
  out.image.defaultPrompt = String(fallbackPrompt || "");
  out.image.baseTags = String(out.image.baseTags || out.image.defaultPrompt || "");
  return out;
}

function ensureConfigShape(config) {
  const out = config && typeof config === "object" ? config : {};

  out.foundry = out.foundry && typeof out.foundry === "object" ? out.foundry : {};
  out.foundry.defaultSessionId = String(out.foundry.defaultSessionId || "default");
  out.foundry.sessions = Array.isArray(out.foundry.sessions) ? out.foundry.sessions : [];
  out.foundry.sessions = out.foundry.sessions.map((session, idx) => {
    const next = session && typeof session === "object" ? session : {};
    next.id = String(next.id || next.sessionId || `session-${idx + 1}`);
    next.label = String(next.label || next.name || next.id);
    next.username = String(next.username || next.userName || "");
    next.password = String(next.password || "");
    next.userId = String(next.userId || next.fvttUserId || "");
    next.autoConnect = next.autoConnect === true;
    return next;
  });

  out.npc = out.npc && typeof out.npc === "object" ? out.npc : {};
  if (!Number.isFinite(Number(out.npc.difficultTerrainMultiplier))) {
    out.npc.difficultTerrainMultiplier = 2;
  }
  out.npc.defaultNpcId = String(out.npc.defaultNpcId || "");
  out.npc.sharedDocs = out.npc.sharedDocs && typeof out.npc.sharedDocs === "object" ? out.npc.sharedDocs : {};
  out.npc.sharedDocs.world = String(out.npc.sharedDocs.world || "");
  out.npc.director = ensureDirectorGlobalShape(out.npc.director);
  out.npc.ambient = ensureAmbientShape(out.npc.ambient, out.npc.director);
  out.npc.worldStateText = String(out.npc.worldStateText || out.npc.worldSetupText || "");
  out.npc.scenePresets = Array.isArray(out.npc.scenePresets)
    ? out.npc.scenePresets
    : Array.isArray(out.npc.mapPresets)
      ? out.npc.mapPresets
      : [];
  out.npc.scenePresets = out.npc.scenePresets.map((preset, idx) =>
    ensureScenePresetShape(preset, idx, out.npc.director, out.npc.ambient)
  );
  out.npc.storybook = ensureStorybookShape(out.npc.storybook);

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
      foundry: { sessionId: "", userId: "", username: "" },
      director: {
        enabled: null,
        allowAmbientTalk: null,
        allowNpcToNpc: null,
        socialWeight: 1,
        playerNearbyFt: null,
        npcCooldownMs: null,
        promptFile: "",
        promptText: "",
      },
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
  const defaultSessionId = String(diana?.foundry?.sessionId || "");

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
      foundry: { sessionId: defaultSessionId, userId: "", username: "" },
      director: {
        enabled: null,
        allowAmbientTalk: null,
        allowNpcToNpc: null,
        socialWeight: 1,
        playerNearbyFt: null,
        npcCooldownMs: null,
        promptFile: "",
        promptText: "",
      },
      image: {
        enabled: defaultImageEnabled,
        defaultPrompt: defaultImagePrompt,
        baseTags: defaultImagePrompt,
      },
    },
    npcs.length
  );
}

function syncNpcGlobalInputsFromConfig(config) {
  const worldInput = $("f-world-doc");
  if (worldInput) {
    worldInput.value = String(config?.npc?.sharedDocs?.world || "");
  }

  const director = config?.npc?.director || {};
  const ambient = config?.npc?.ambient || {};

  const directorEnabled = $("f-director-enabled");
  if (directorEnabled) {
    directorEnabled.checked = director.enabled === true;
  }

  const directorMode = $("f-director-mode");
  if (directorMode) {
    directorMode.value = normalizeDirectorMode(director.mode);
  }

  const directorPromptFile = $("f-director-prompt-file");
  if (directorPromptFile) {
    directorPromptFile.value = String(director.promptFile || "");
  }

  const directorPromptText = $("f-director-prompt-text");
  if (directorPromptText) {
    directorPromptText.value = String(director.promptText || "");
  }

  const directorAmbient = $("f-director-ambient");
  if (directorAmbient) {
    directorAmbient.checked = director.allowAmbientTalk !== false;
  }

  const directorNpcToNpc = $("f-director-npc2npc");
  if (directorNpcToNpc) {
    directorNpcToNpc.checked = director.allowNpcToNpc !== false;
  }

  const assignNumber = (id, value, fallback) => {
    const input = $(id);
    if (!input) return;
    input.value = String(Number.isFinite(Number(value)) ? Number(value) : fallback);
  };

  assignNumber("f-director-player-nearby-ft", director.playerNearbyFt, 30);
  assignNumber("f-director-max-chain-turns", director.maxChainTurns, 2);
  assignNumber("f-director-max-participants", director.maxParticipants, 3);
  assignNumber("f-director-npc-cooldown-ms", director.npcCooldownMs, 45000);
  assignNumber("f-director-scene-cooldown-ms", director.sceneCooldownMs, 15000);
  assignNumber("f-director-token-budget", director.tokenBudgetPerWindow, 8);
  assignNumber("f-director-token-window-ms", director.tokenBudgetWindowMs, 600000);
  assignNumber("f-director-line-delay-min-ms", director.lineDelayMinMs, 300);
  assignNumber("f-director-line-delay-max-ms", director.lineDelayMaxMs, 900);

  const ambientEnabled = $("f-ambient-enabled");
  if (ambientEnabled) {
    ambientEnabled.checked = ambient.enabled === true;
  }

  const ambientPromptFile = $("f-ambient-prompt-file");
  if (ambientPromptFile) {
    ambientPromptFile.value = String(ambient.promptFile || "");
  }

  const ambientPromptText = $("f-ambient-prompt-text");
  if (ambientPromptText) {
    ambientPromptText.value = String(ambient.promptText || "");
  }

  const worldStateInput = $("f-world-state-text");
  if (worldStateInput) {
    worldStateInput.value = String(config?.npc?.worldStateText || "");
  }

  syncSocialPresetSelectFromConfig(config);
  syncStorybookFieldsFromConfig(config);
}

function applyNpcGlobalFormToConfig(config) {
  const next = ensureConfigShape(config || {});
  next.npc = next.npc || {};
  next.npc.sharedDocs = next.npc.sharedDocs || {};
  next.npc.director = next.npc.director || {};
  next.npc.ambient = next.npc.ambient || {};

  const worldInput = $("f-world-doc");
  next.npc.sharedDocs.world = String(worldInput?.value || "").trim();

  next.npc.director.enabled = $("f-director-enabled")?.checked === true;
  next.npc.director.mode = normalizeDirectorMode($("f-director-mode")?.value || "nearby");
  next.npc.director.promptFile = String($("f-director-prompt-file")?.value || "").trim();
  next.npc.director.promptText = String($("f-director-prompt-text")?.value || "").trim();
  next.npc.director.allowAmbientTalk = $("f-director-ambient")?.checked !== false;
  next.npc.director.allowNpcToNpc = $("f-director-npc2npc")?.checked !== false;

  const assignNumber = (key, id, fallback) => {
    const parsed = Number($(id)?.value);
    next.npc.director[key] = Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };

  assignNumber("playerNearbyFt", "f-director-player-nearby-ft", 30);
  assignNumber("maxChainTurns", "f-director-max-chain-turns", 2);
  assignNumber("maxParticipants", "f-director-max-participants", 3);
  assignNumber("npcCooldownMs", "f-director-npc-cooldown-ms", 45000);
  assignNumber("sceneCooldownMs", "f-director-scene-cooldown-ms", 15000);
  assignNumber("tokenBudgetPerWindow", "f-director-token-budget", 8);
  assignNumber("tokenBudgetWindowMs", "f-director-token-window-ms", 600000);
  assignNumber("lineDelayMinMs", "f-director-line-delay-min-ms", 300);
  assignNumber("lineDelayMaxMs", "f-director-line-delay-max-ms", 900);
  next.npc.ambient.enabled = $("f-ambient-enabled")?.checked === true;
  next.npc.ambient.promptFile = String($("f-ambient-prompt-file")?.value || "").trim();
  next.npc.ambient.promptText = String($("f-ambient-prompt-text")?.value || "").trim();
  next.npc.worldStateText = String($("f-world-state-text")?.value || "").trim();

  return applyStorybookFormToConfig(next);
}

function makeUniqueScenePresetId(config, base = "scene-preset") {
  const taken = new Set(
    (Array.isArray(config?.npc?.scenePresets) ? config.npc.scenePresets : [])
      .map((preset) => String(preset?.id || "").trim().toLowerCase())
      .filter(Boolean)
  );
  let i = 1;
  while (taken.has(`${base}-${i}`.toLowerCase())) {
    i += 1;
  }
  return `${base}-${i}`;
}

function getSelectedScenePreset(config) {
  const presets = Array.isArray(config?.npc?.scenePresets) ? config.npc.scenePresets : [];
  return presets.find((preset) => String(preset?.id || "") === String(selectedSocialPresetId || "")) || null;
}

function syncSocialPresetSelectFromConfig(config) {
  const select = $("f-social-preset-select");
  if (!select) return;
  const presets = Array.isArray(config?.npc?.scenePresets) ? config.npc.scenePresets : [];
  if (!selectedSocialPresetId && presets[0]?.id) {
    selectedSocialPresetId = String(presets[0].id || "");
  }
  if (selectedSocialPresetId && !presets.some((preset) => String(preset?.id || "") === selectedSocialPresetId)) {
    selectedSocialPresetId = String(presets[0]?.id || "");
  }

  select.innerHTML = "";
  if (!presets.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "(No presets)";
    select.appendChild(option);
  } else {
    for (const preset of presets) {
      const option = document.createElement("option");
      option.value = String(preset?.id || "");
      option.textContent = String(preset?.label || preset?.sceneName || preset?.sceneId || preset?.id || "(unnamed)");
      select.appendChild(option);
    }
  }
  select.value = String(selectedSocialPresetId || "");
  syncSelectedScenePresetFields(config);
}

function syncSelectedScenePresetFields(config) {
  const preset = getSelectedScenePreset(config);
  const labelInput = $("f-social-preset-label");
  const sceneIdInput = $("f-social-preset-scene-id");
  const sceneNameInput = $("f-social-preset-scene-name");
  if (labelInput) labelInput.value = String(preset?.label || "");
  if (sceneIdInput) sceneIdInput.value = String(preset?.sceneId || "");
  if (sceneNameInput) sceneNameInput.value = String(preset?.sceneName || "");
}

function captureCurrentSocialPreset(config, basePreset = null) {
  config = ensureConfigShape(config || {});
  const existing = basePreset && typeof basePreset === "object" ? basePreset : {};
  return ensureScenePresetShape(
    {
      id: existing.id || makeUniqueScenePresetId(config),
      label:
        existing.label ||
        existing.sceneName ||
        existing.sceneId ||
        `Scene Preset ${Array.isArray(config?.npc?.scenePresets) ? config.npc.scenePresets.length + 1 : 1}`,
      sceneId: existing.sceneId || "",
      sceneName: existing.sceneName || "",
      worldStateText: String(config?.npc?.worldStateText || ""),
      director: cloneJson(config?.npc?.director || {}),
      ambient: cloneJson(config?.npc?.ambient || {}),
      npcOverrides: (Array.isArray(config?.npcs) ? config.npcs : []).map((npc) => ({
        npcId: String(npc?.id || ""),
        displayName: String(npc?.displayName || npc?.id || ""),
        director: cloneJson(npc?.director || {}),
      })),
    },
    0,
    config?.npc?.director || {},
    config?.npc?.ambient || {}
  );
}

function applyScenePresetToConfig(config, preset) {
  const next = ensureConfigShape(config || {});
  const normalized = ensureScenePresetShape(preset, 0, next?.npc?.director || {}, next?.npc?.ambient || {});
  next.npc.director = ensureDirectorGlobalShape(cloneJson(normalized.director || {}));
  next.npc.ambient = ensureAmbientShape(cloneJson(normalized.ambient || {}), next.npc.director);
  next.npc.worldStateText = String(normalized.worldStateText || "");
  const overrideMap = new Map(
    ensureArray(normalized.npcOverrides).map((override) => [String(override?.npcId || "").trim(), override])
  );
  next.npcs = ensureArray(next.npcs).map((npc, index) => {
    const current = ensureNpcShape(npc, index);
    const override =
      overrideMap.get(String(current?.id || "").trim()) ||
      ensureArray(normalized.npcOverrides).find(
        (entry) =>
          String(entry?.displayName || "").trim().toLowerCase() === String(current?.displayName || "").trim().toLowerCase()
      );
    if (!override) return current;
    current.director = normalizeNpcDirectorOverrideShape(cloneJson(override.director || {}));
    return current;
  });
  return next;
}

function makeUniqueStorybookId(takenIds, base) {
  const taken = takenIds instanceof Set ? takenIds : new Set(ensureArray(takenIds).map((value) => String(value || "").trim()).filter(Boolean));
  const prefix = String(base || "item").trim() || "item";
  let i = 1;
  while (taken.has(`${prefix}-${i}`.toLowerCase())) {
    i += 1;
  }
  return `${prefix}-${i}`;
}

function getSelectedStorybookGraph(config = currentConfig) {
  const book = config?.npc?.storybook;
  const graphs = Array.isArray(book?.graphs) ? book.graphs : [];
  if (!graphs.length) return null;
  const requested = String(selectedStorybookGraphId || "").trim();
  if (requested) {
    const match = graphs.find((graph) => String(graph?.id || "") === requested);
    if (match) return match;
  }
  return graphs[0] || null;
}

function getSelectedStorybookNode(config = currentConfig) {
  const graph = getSelectedStorybookGraph(config);
  if (!graph) return null;
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  if (!nodes.length) return null;
  const requested = String(selectedStorybookNodeId || "").trim();
  if (requested) {
    const match = nodes.find((node) => String(node?.id || "") === requested);
    if (match) return match;
  }
  return nodes[0] || null;
}

function getSelectedStorybookTransition(config = currentConfig) {
  const node = getSelectedStorybookNode(config);
  if (!node) return null;
  const transitions = Array.isArray(node.transitions) ? node.transitions : [];
  if (!transitions.length) return null;
  const requested = String(selectedStorybookTransitionId || "").trim();
  if (requested) {
    const match = transitions.find((transition) => String(transition?.id || "") === requested);
    if (match) return match;
  }
  return transitions[0] || null;
}

function syncStorybookGraphSelectFromConfig(config) {
  const select = $("f-storybook-graph-select");
  if (!select) return;
  const book = config?.npc?.storybook || {};
  const graphs = Array.isArray(book.graphs) ? book.graphs : [];
  if (!selectedStorybookGraphId && graphs[0]?.id) {
    selectedStorybookGraphId = String(graphs[0].id || "");
  }
  if (selectedStorybookGraphId && !graphs.some((graph) => String(graph?.id || "") === selectedStorybookGraphId)) {
    selectedStorybookGraphId = String(graphs[0]?.id || "");
  }
  select.innerHTML = "";
  if (!graphs.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "(No graphs)";
    select.appendChild(option);
  } else {
    for (const graph of graphs) {
      const option = document.createElement("option");
      option.value = String(graph?.id || "");
      option.textContent = String(graph?.label || graph?.sceneName || graph?.sceneId || graph?.id || "(unnamed)");
      select.appendChild(option);
    }
  }
  select.value = String(selectedStorybookGraphId || "");
}

function syncStorybookNodeSelectFromConfig(config) {
  const select = $("f-storybook-node-select");
  if (!select) return;
  const graph = getSelectedStorybookGraph(config);
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  if (!selectedStorybookNodeId && nodes[0]?.id) {
    selectedStorybookNodeId = String(nodes[0].id || "");
  }
  if (selectedStorybookNodeId && !nodes.some((node) => String(node?.id || "") === selectedStorybookNodeId)) {
    selectedStorybookNodeId = String(nodes[0]?.id || "");
  }
  select.innerHTML = "";
  if (!nodes.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "(No nodes)";
    select.appendChild(option);
  } else {
    for (const node of nodes) {
      const option = document.createElement("option");
      option.value = String(node?.id || "");
      option.textContent = String(node?.label || node?.id || "(unnamed)");
      select.appendChild(option);
    }
  }
  select.value = String(selectedStorybookNodeId || "");
}

function syncStorybookTransitionSelectFromConfig(config) {
  const select = $("f-storybook-transition-select");
  if (!select) return;
  const node = getSelectedStorybookNode(config);
  const transitions = Array.isArray(node?.transitions) ? node.transitions : [];
  if (!selectedStorybookTransitionId && transitions[0]?.id) {
    selectedStorybookTransitionId = String(transitions[0].id || "");
  }
  if (selectedStorybookTransitionId && !transitions.some((transition) => String(transition?.id || "") === selectedStorybookTransitionId)) {
    selectedStorybookTransitionId = String(transitions[0]?.id || "");
  }
  select.innerHTML = "";
  if (!transitions.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "(No transitions)";
    select.appendChild(option);
  } else {
    for (const transition of transitions) {
      const option = document.createElement("option");
      option.value = String(transition?.id || "");
      option.textContent = String(transition?.label || transition?.id || "(unnamed)");
      select.appendChild(option);
    }
  }
  select.value = String(selectedStorybookTransitionId || "");
}

function renderStorybookPreview(config) {
  const preview = $("storybook-preview-summary");
  if (!preview) return;
  renderStorybookGraphVisual(config);
  const book = config?.npc?.storybook || {};
  const graphs = Array.isArray(book.graphs) ? book.graphs : [];
  const graph = getSelectedStorybookGraph(config);
  const node = getSelectedStorybookNode(config);
  const transition = getSelectedStorybookTransition(config);
  const lines = [
    `Storybook: ${book.enabled ? "enabled" : "disabled"} / ${String(book.mode || "simple")}`,
    `Graphs: ${graphs.length}`,
  ];
  if (graph) {
    const nodeCount = Array.isArray(graph.nodes) ? graph.nodes.length : 0;
    lines.push(`Selected graph: ${graph.label || graph.id}`);
    lines.push(`Scene match: ${graph.sceneId || "-"} / ${graph.sceneName || "-"}`);
    lines.push(`Entry node: ${graph.entryNodeId || "-"}`);
    lines.push(`Nodes in graph: ${nodeCount}`);
    if (node) {
      lines.push(`Selected node: ${node.label || node.id}`);
      lines.push(`NPCs: ${Array.isArray(node.npcIds) && node.npcIds.length ? node.npcIds.join(", ") : "-"}`);
      lines.push(`Transitions: ${Array.isArray(node.transitions) ? node.transitions.length : 0}`);
      lines.push(`Objective: ${String(node.objectiveText || "").trim() || "-"}`);
      if (transition) {
        const conditionList = Array.isArray(transition.conditions)
          ? transition.conditions
              .map((condition) => {
                const shape = ensureStorybookConditionShape(condition);
                const type = String(shape?.type || shape?.kind || "").trim();
                if (!type) return "";
                const distance =
                  shape?.distanceFt ?? shape?.rangeFt ?? shape?.radiusFt ?? shape?.ft ?? null;
                const timeout =
                  shape?.seconds ??
                  (Number.isFinite(Number(shape?.minutes)) ? `${Number(shape.minutes)}m` : null) ??
                  (Number.isFinite(Number(shape?.timeoutMs || shape?.durationMs || shape?.ms))
                    ? `${Math.round(Number(shape.timeoutMs || shape.durationMs || shape.ms) / 1000)}s`
                    : null);
                if (distance !== null && distance !== undefined && distance !== "") return `${type}(${distance}ft)`;
                if (timeout !== null && timeout !== undefined && timeout !== "") return `${type}(${timeout})`;
                return type;
              })
              .filter(Boolean)
          : [];
        lines.push(`Selected transition: ${transition.label || transition.id}`);
        lines.push(`Next node: ${transition.nextNodeId || "-"}`);
        lines.push(`Conditions: ${conditionList.length ? conditionList.join(", ") : "-"}`);
      }
    }
  } else {
    lines.push("No storybook graph selected.");
  }
  preview.textContent = lines.join("\n");
}

function formatUiRelativeTime(ts) {
  const value = Number(ts || 0);
  if (!Number.isFinite(value) || value <= 0) return "-";
  const deltaMs = Math.max(0, Date.now() - value);
  if (deltaMs < 1000) return "just now";
  const sec = Math.round(deltaMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hour = Math.round(min / 60);
  if (hour < 24) return `${hour}h ago`;
  const day = Math.round(hour / 24);
  return `${day}d ago`;
}

function renderSocialStatus(payload) {
  const summaryRoot = $("social-status-summary");
  const scenesRoot = $("social-status-scenes");
  const transitionsRoot = $("social-status-transitions");
  if (!summaryRoot || !scenesRoot || !transitionsRoot) return;

  const status = payload && typeof payload === "object" ? payload : {};
  const storybook = status.storybook && typeof status.storybook === "object" ? status.storybook : {};
  const sceneStates = Array.isArray(status.sceneStates) ? status.sceneStates : [];
  const transitions = Array.isArray(status.recentTransitions) ? status.recentTransitions : [];

  const summaryItems = [
    `Runtime: ${status.runtimeStarted ? "running" : "stopped"}`,
    `Storybook: ${storybook.enabled ? "enabled" : "disabled"}`,
    `Mode: ${String(storybook.mode || "simple")}`,
    `Graphs: ${Number(storybook.graphCount || 0)}`,
    `Active scenes: ${sceneStates.length}`,
  ];
  summaryRoot.innerHTML = summaryItems
    .map((line) => {
      const colonIndex = line.indexOf(":");
      const label = colonIndex >= 0 ? line.slice(0, colonIndex) : line;
      const value = colonIndex >= 0 ? line.slice(colonIndex + 1).trim() : "";
      return `<div class="social-status-item"><strong>${label}</strong><div class="meta">${value}</div></div>`;
    })
    .join("");

  if (!sceneStates.length) {
    scenesRoot.innerHTML = '<div class="social-status-item"><strong>No active Storybook scene</strong><div class="meta">Start the runtime and enter a matched scene to see active nodes here.</div></div>';
  } else {
    scenesRoot.innerHTML = sceneStates
      .map((entry) => {
        const objective = String(entry?.objectiveText || "").trim();
        const stageDirections = String(entry?.stageDirections || "").trim();
        const meta = [
          `Scene key: ${String(entry?.sceneKey || "-")}`,
          `Updated: ${formatUiRelativeTime(entry?.updatedAtTs)}`,
          String(entry?.lastTransitionReason || "").trim() ? `Last transition: ${String(entry.lastTransitionReason).trim()}` : "",
        ]
          .filter(Boolean)
          .join("<br>");
        return `<div class="social-status-item"><strong>${String(entry?.graphLabel || entry?.graphId || "Storybook")} / ${String(entry?.nodeLabel || entry?.nodeId || "node")}</strong><div class="meta">${meta}</div>${objective ? `<div style="margin-top:8px">${objective}</div>` : ""}${stageDirections ? `<div class="meta" style="margin-top:6px">${stageDirections}</div>` : ""}</div>`;
      })
      .join("");
  }

  if (!transitions.length) {
    transitionsRoot.innerHTML = '<div class="social-status-item"><strong>No recent transitions</strong><div class="meta">When Storybook state changes, the latest transitions will appear here.</div></div>';
  } else {
    transitionsRoot.innerHTML = transitions
      .map((entry) => {
        const title = `${String(entry?.graphLabel || entry?.graphId || "Storybook")} :: ${String(entry?.fromNodeLabel || entry?.fromNodeId || "-")} -> ${String(entry?.toNodeLabel || entry?.toNodeId || "-")}`;
        const meta = [`When: ${formatUiRelativeTime(entry?.ts)}`, `Reason: ${String(entry?.reason || "-")}`].join("<br>");
        return `<div class="social-status-item"><strong>${title}</strong><div class="meta">${meta}</div></div>`;
      })
      .join("");
  }
}

async function refreshSocialStatus({ silent = true } = {}) {
  try {
    const result = await window.api.getSocialStatus(currentConfig || {});
    renderSocialStatus(result);
  } catch (e) {
    if (!silent) {
      appendLog({ ts: Date.now(), level: "error", scope: "ui", message: `social status failed: ${e?.message || e}` });
    }
  }
}

function buildStorybookNodeOptions(graph, { includeEmptyLabel = "(No nodes)" } = {}) {
  const options = [];
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  if (!nodes.length) {
    options.push({ value: "", label: includeEmptyLabel });
    return options;
  }
  for (const node of nodes) {
    options.push({
      value: String(node?.id || ""),
      label: String(node?.label || node?.id || "(unnamed)"),
    });
  }
  return options;
}

function syncStorybookNodeTargetSelect(selectId, graph, value, emptyLabel) {
  const select = $(selectId);
  if (!select) return;
  const options = buildStorybookNodeOptions(graph, { includeEmptyLabel: emptyLabel });
  select.innerHTML = "";
  for (const optionSpec of options) {
    const option = document.createElement("option");
    option.value = String(optionSpec.value || "");
    option.textContent = String(optionSpec.label || optionSpec.value || "");
    select.appendChild(option);
  }
  const wanted = String(value || "").trim();
  if (wanted && options.some((option) => String(option.value || "") === wanted)) {
    select.value = wanted;
    return;
  }
  select.value = String(options[0]?.value || "");
}

function getPrimaryStorybookCondition(transition) {
  const conditions = Array.isArray(transition?.conditions) ? transition.conditions : [];
  if (!conditions.length) return ensureStorybookConditionShape({ type: "always" });
  return ensureStorybookConditionShape(conditions[0]);
}

function shouldUseAdvancedStorybookConditions(transition) {
  const conditions = Array.isArray(transition?.conditions) ? transition.conditions : [];
  if (conditions.length > 1) return true;
  if (!conditions.length) return false;
  const first = ensureStorybookConditionShape(conditions[0]);
  return Boolean(first.targetNodeId);
}

function syncStorybookModeUi(config) {
  const section = $("storybook-section");
  if (!section) return;
  const mode = normalizeStorybookMode(config?.npc?.storybook?.mode || "simple");
  const advancedEnabled = $("f-storybook-transition-advanced-enabled")?.checked === true;
  section.dataset.storybookMode = mode === "node-storybook" ? "node" : "simple";
  section.dataset.storybookAdvanced = advancedEnabled ? "on" : "off";
  const note = $("storybook-mode-note");
  if (!note) return;
  if (mode === "node-storybook") {
    note.innerHTML =
      "<strong>Node Storybook</strong><span class=\"muted\">Use scene graphs, story nodes, and transition rules when you want staged escalation, patrol loops, guard shifts, or branching beats.</span>";
    return;
  }
  note.innerHTML =
    "<strong>Simple Director</strong><span class=\"muted\">Keep the current social director workflow. Nearby reactions, NPC-to-NPC talk, and ambient chatter work without graph setup.</span>";
}

function syncStorybookFieldsFromConfig(config) {
  const book = config?.npc?.storybook || {};
  const enabled = $("f-storybook-enabled");
  if (enabled) enabled.checked = book.enabled === true;
  const mode = $("f-storybook-mode");
  if (mode) mode.value = normalizeStorybookMode(book.mode);
  const promptFile = $("f-storybook-prompt-file");
  if (promptFile) promptFile.value = String(book.promptFile || "");
  const promptText = $("f-storybook-prompt-text");
  if (promptText) promptText.value = String(book.promptText || "");

  syncStorybookGraphSelectFromConfig(config);
  syncStorybookNodeSelectFromConfig(config);
  syncStorybookTransitionSelectFromConfig(config);

  const graph = getSelectedStorybookGraph(config);
  const node = getSelectedStorybookNode(config);
  const transition = getSelectedStorybookTransition(config);
  if ($("f-storybook-graph-label")) $("f-storybook-graph-label").value = String(graph?.label || "");
  if ($("f-storybook-graph-enabled")) $("f-storybook-graph-enabled").checked = graph?.enabled !== false;
  if ($("f-storybook-graph-scene-id")) $("f-storybook-graph-scene-id").value = String(graph?.sceneId || "");
  if ($("f-storybook-graph-scene-name")) $("f-storybook-graph-scene-name").value = String(graph?.sceneName || "");
  syncStorybookNodeTargetSelect("f-storybook-graph-entry-node-id", graph, graph?.entryNodeId || "", "(Select entry node)");
  if ($("f-storybook-graph-notes")) $("f-storybook-graph-notes").value = String(graph?.notes || "");

  if ($("f-storybook-node-id")) $("f-storybook-node-id").value = String(node?.id || "");
  if ($("f-storybook-node-label")) $("f-storybook-node-label").value = String(node?.label || "");
  if ($("f-storybook-node-enabled")) $("f-storybook-node-enabled").checked = node?.enabled !== false;
  if ($("f-storybook-node-npc-ids")) $("f-storybook-node-npc-ids").value = Array.isArray(node?.npcIds) ? node.npcIds.join("\n") : "";
  if ($("f-storybook-node-objective-text")) $("f-storybook-node-objective-text").value = String(node?.objectiveText || "");
  if ($("f-storybook-node-stage-directions")) $("f-storybook-node-stage-directions").value = String(node?.stageDirections || "");

  if ($("f-storybook-transition-label")) $("f-storybook-transition-label").value = String(transition?.label || "");
  syncStorybookNodeTargetSelect("f-storybook-transition-next-node-id", graph, transition?.nextNodeId || "", "(Select next node)");
  const primaryCondition = getPrimaryStorybookCondition(transition);
  const quickType = $("f-storybook-transition-condition-type");
  if (quickType) quickType.value = String(primaryCondition?.type || "always");
  const quickDistance = $("f-storybook-transition-condition-distance-ft");
  if (quickDistance) {
    const distance =
      primaryCondition?.distanceFt ?? primaryCondition?.rangeFt ?? primaryCondition?.radiusFt ?? primaryCondition?.ft ?? "";
    quickDistance.value = distance === "" ? "" : String(distance);
  }
  const quickTimeout = $("f-storybook-transition-condition-timeout-seconds");
  if (quickTimeout) {
    const seconds =
      primaryCondition?.seconds ??
      (Number.isFinite(Number(primaryCondition?.minutes)) ? Number(primaryCondition.minutes) * 60 : null) ??
      (Number.isFinite(Number(primaryCondition?.timeoutMs || primaryCondition?.durationMs || primaryCondition?.ms))
        ? Math.round(Number(primaryCondition.timeoutMs || primaryCondition.durationMs || primaryCondition.ms) / 1000)
        : "");
    quickTimeout.value = seconds === "" || seconds === null ? "" : String(seconds);
  }
  const advancedEnabled = $("f-storybook-transition-advanced-enabled");
  if (advancedEnabled) advancedEnabled.checked = shouldUseAdvancedStorybookConditions(transition);
  if ($("f-storybook-transition-conditions")) {
    $("f-storybook-transition-conditions").value = JSON.stringify(Array.isArray(transition?.conditions) ? transition.conditions : [], null, 2);
  }

  syncStorybookModeUi(config);
  renderStorybookPreview(config);
}

function applyStorybookFormToConfig(config) {
  const next = ensureConfigShape(config || {});
  next.npc.storybook = next.npc.storybook || {};
  next.npc.storybook.enabled = $("f-storybook-enabled")?.checked === true;
  next.npc.storybook.mode = normalizeStorybookMode($("f-storybook-mode")?.value || "simple");
  next.npc.storybook.promptFile = String($("f-storybook-prompt-file")?.value || "").trim();
  next.npc.storybook.promptText = String($("f-storybook-prompt-text")?.value || "").trim();

  const book = next.npc.storybook;
  const graph = getSelectedStorybookGraph(next);
  const node = getSelectedStorybookNode(next);
  const transition = getSelectedStorybookTransition(next);
  if (graph) {
    graph.label = String($("f-storybook-graph-label")?.value || graph.label || "").trim() || graph.label || graph.id;
    graph.enabled = $("f-storybook-graph-enabled")?.checked !== false;
    graph.sceneId = String($("f-storybook-graph-scene-id")?.value || "").trim();
    graph.sceneName = String($("f-storybook-graph-scene-name")?.value || "").trim();
    graph.entryNodeId = String($("f-storybook-graph-entry-node-id")?.value || "").trim();
    graph.notes = String($("f-storybook-graph-notes")?.value || "").trim();
  }
  if (node) {
    const nextNodeId = String($("f-storybook-node-id")?.value || "").trim();
    if (nextNodeId) {
      const previousNodeId = String(node.id || "");
      node.id = nextNodeId;
      if (selectedStorybookNodeId === previousNodeId) {
        selectedStorybookNodeId = nextNodeId;
      }
      if (graph?.entryNodeId === previousNodeId) {
        graph.entryNodeId = nextNodeId;
      }
      for (const candidate of ensureArray(graph?.nodes)) {
        for (const transitionItem of ensureArray(candidate?.transitions)) {
          if (String(transitionItem?.nextNodeId || "") === previousNodeId) {
            transitionItem.nextNodeId = nextNodeId;
          }
        }
      }
    }
    node.label = String($("f-storybook-node-label")?.value || node.label || "").trim() || node.label || node.id;
    node.enabled = $("f-storybook-node-enabled")?.checked !== false;
    node.npcIds = String($("f-storybook-node-npc-ids")?.value || "")
      .split(/[\r\n,]+/)
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    node.objectiveText = String($("f-storybook-node-objective-text")?.value || "").trim();
    node.stageDirections = String($("f-storybook-node-stage-directions")?.value || "").trim();
  }
  if (transition) {
    transition.label = String($("f-storybook-transition-label")?.value || transition.label || "").trim() || transition.label || transition.id;
    transition.nextNodeId = String($("f-storybook-transition-next-node-id")?.value || "").trim();
    const useAdvanced = $("f-storybook-transition-advanced-enabled")?.checked === true;
    const raw = String($("f-storybook-transition-conditions")?.value || "").trim();
    if (useAdvanced && raw) {
      try {
        const parsed = JSON.parse(raw);
        transition.conditions = Array.isArray(parsed) ? parsed.map((item) => ensureStorybookConditionShape(item)) : [];
      } catch {
        transition.conditions = Array.isArray(transition.conditions) ? transition.conditions : [];
      }
    } else if (useAdvanced) {
      transition.conditions = [];
    } else {
      const quickType = String($("f-storybook-transition-condition-type")?.value || "always").trim() || "always";
      const quick = { type: quickType };
      const distanceFt = Number($("f-storybook-transition-condition-distance-ft")?.value);
      const timeoutSeconds = Number($("f-storybook-transition-condition-timeout-seconds")?.value);
      if ((quickType === "player-nearby" || quickType === "player-visible") && Number.isFinite(distanceFt) && distanceFt > 0) {
        quick.distanceFt = Math.round(distanceFt);
      }
      if (quickType === "active-node-timeout" && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
        quick.seconds = Math.round(timeoutSeconds);
      }
      transition.conditions = [ensureStorybookConditionShape(quick)];
    }
  }

  book.graphs = ensureArray(book.graphs).map((item, index) => ensureStorybookGraphShape(item, index));
  next.npc.storybook = ensureStorybookShape(book);
  syncStorybookModeUi(next);
  renderStorybookPreview(next);
  return next;
}

function selectStorybookGraph(config, graphId) {
  const nextGraphId = String(graphId || "").trim();
  selectedStorybookGraphId = nextGraphId;
  selectedStorybookNodeId = "";
  selectedStorybookTransitionId = "";
  syncStorybookFieldsFromConfig(config);
}

function selectStorybookNode(config, nodeId) {
  selectedStorybookNodeId = String(nodeId || "").trim();
  selectedStorybookTransitionId = "";
  syncStorybookFieldsFromConfig(config);
}

function selectStorybookTransition(config, transitionId) {
  selectedStorybookTransitionId = String(transitionId || "").trim();
  syncStorybookFieldsFromConfig(config);
}

function makeUniqueStorybookGraphId(config, base = "story-graph") {
  const taken = new Set(
    ensureArray(config?.npc?.storybook?.graphs)
      .map((graph) => String(graph?.id || "").trim().toLowerCase())
      .filter(Boolean)
  );
  return makeUniqueStorybookId(taken, base);
}

function makeUniqueStorybookNodeId(graph, base = "node") {
  const taken = new Set(
    ensureArray(graph?.nodes)
      .map((node) => String(node?.id || "").trim().toLowerCase())
      .filter(Boolean)
  );
  return makeUniqueStorybookId(taken, base);
}

function makeUniqueStorybookTransitionId(node, base = "transition") {
  const taken = new Set(
    ensureArray(node?.transitions)
      .map((transition) => String(transition?.id || "").trim().toLowerCase())
      .filter(Boolean)
  );
  return makeUniqueStorybookId(taken, base);
}

function createStorybookTemplateGraph(config, templateId) {
  const graphIdBase =
    templateId === "guard-shift" ? "guard-shift" : templateId === "patrol-alert" ? "patrol-alert" : "tavern-rumor";
  const graphId = makeUniqueStorybookGraphId(config, graphIdBase);
  const makeNodeId = (suffix) => `${graphId}-${suffix}`;
  if (templateId === "guard-shift") {
    return ensureStorybookGraphShape({
      id: graphId,
      label: "Guard Shift",
      sceneName: "",
      notes: "Low-prep guard rotation. Assign node NPC ids after creation.",
      entryNodeId: makeNodeId("rotation"),
      nodes: [
        {
          id: makeNodeId("rotation"),
          label: "Rotation",
          objectiveText: "Guards complain, hand over watch, and keep a low level of routine chatter.",
          stageDirections: "Calm but alert. Short lines. Feels like a normal shift change.",
          transitions: [
            {
              id: `${graphId}-rotation-nearby`,
              label: "Player Nearby",
              nextNodeId: makeNodeId("suspicious"),
              conditions: [{ type: "player-nearby", distanceFt: 25 }],
            },
            {
              id: `${graphId}-rotation-combat`,
              label: "Combat Started",
              nextNodeId: makeNodeId("combat"),
              conditions: [{ type: "combat-started" }],
            },
          ],
        },
        {
          id: makeNodeId("suspicious"),
          label: "Suspicious",
          objectiveText: "The guards trade short lines about a sound, movement, or something feeling wrong.",
          stageDirections: "Tension rises. Less joking, more scanning and short questions.",
          transitions: [
            {
              id: `${graphId}-suspicious-visible`,
              label: "Player Visible",
              nextNodeId: makeNodeId("challenge"),
              conditions: [{ type: "player-visible", distanceFt: 25 }],
            },
            {
              id: `${graphId}-suspicious-timeout`,
              label: "Calm Returns",
              nextNodeId: makeNodeId("rotation"),
              conditions: [{ type: "active-node-timeout", seconds: 15 }],
            },
            {
              id: `${graphId}-suspicious-combat`,
              label: "Combat Started",
              nextNodeId: makeNodeId("combat"),
              conditions: [{ type: "combat-started" }],
            },
          ],
        },
        {
          id: makeNodeId("challenge"),
          label: "Challenge",
          objectiveText: "Guards address the intruders directly and demand an answer or halt.",
          stageDirections: "Direct, loud, and defensive. Keep it focused on warning or challenge.",
          transitions: [
            {
              id: `${graphId}-challenge-combat`,
              label: "Combat Started",
              nextNodeId: makeNodeId("combat"),
              conditions: [{ type: "combat-started" }],
            },
            {
              id: `${graphId}-challenge-timeout`,
              label: "Nobody Escalates",
              nextNodeId: makeNodeId("rotation"),
              conditions: [{ type: "active-node-timeout", seconds: 12 }],
            },
          ],
        },
        {
          id: makeNodeId("combat"),
          label: "Combat",
          objectiveText: "Social beats stop. This node exists only to explain why the guards are no longer chatting.",
          stageDirections: "Hold until combat ends.",
          transitions: [
            {
              id: `${graphId}-combat-ended`,
              label: "Combat Ended",
              nextNodeId: makeNodeId("rotation"),
              conditions: [{ type: "combat-ended" }],
            },
          ],
        },
      ],
    });
  }

  if (templateId === "patrol-alert") {
    return ensureStorybookGraphShape({
      id: graphId,
      label: "Patrol Alert",
      sceneName: "",
      notes: "Good for corridors, caves, and camp patrols.",
      entryNodeId: makeNodeId("patrol"),
      nodes: [
        {
          id: makeNodeId("patrol"),
          label: "Patrol",
          objectiveText: "The patrol exchanges short status lines while moving through the area.",
          stageDirections: "Routine movement and brief check-ins.",
          transitions: [
            {
              id: `${graphId}-patrol-nearby`,
              label: "Player Nearby",
              nextNodeId: makeNodeId("inspect"),
              conditions: [{ type: "player-nearby", distanceFt: 30 }],
            },
          ],
        },
        {
          id: makeNodeId("inspect"),
          label: "Inspect",
          objectiveText: "The patrol narrows focus and checks the suspicious area.",
          stageDirections: "Short investigative lines, cautious tone.",
          transitions: [
            {
              id: `${graphId}-inspect-visible`,
              label: "Player Visible",
              nextNodeId: makeNodeId("alarm"),
              conditions: [{ type: "player-visible", distanceFt: 30 }],
            },
            {
              id: `${graphId}-inspect-timeout`,
              label: "Nothing Found",
              nextNodeId: makeNodeId("patrol"),
              conditions: [{ type: "active-node-timeout", seconds: 20 }],
            },
          ],
        },
        {
          id: makeNodeId("alarm"),
          label: "Alarm",
          objectiveText: "The patrol warns others, calls out targets, and prepares escalation.",
          stageDirections: "Fast, loud, urgent.",
          transitions: [
            {
              id: `${graphId}-alarm-combat`,
              label: "Combat Started",
              nextNodeId: makeNodeId("combat"),
              conditions: [{ type: "combat-started" }],
            },
          ],
        },
        {
          id: makeNodeId("combat"),
          label: "Combat",
          objectiveText: "Combat has taken over the scene.",
          stageDirections: "Let the combat system drive from here.",
          transitions: [
            {
              id: `${graphId}-combat-ended`,
              label: "Combat Ended",
              nextNodeId: makeNodeId("patrol"),
              conditions: [{ type: "combat-ended" }],
            },
          ],
        },
      ],
    });
  }

  return ensureStorybookGraphShape({
    id: graphId,
    label: "Tavern Rumor",
    sceneName: "",
    notes: "A simple social graph for bards, barkeeps, and regulars.",
    entryNodeId: makeNodeId("idle"),
    nodes: [
      {
        id: makeNodeId("idle"),
        label: "Idle Chatter",
        objectiveText: "Locals trade light rumors and background chatter without focusing on the party too hard.",
        stageDirections: "Loose, warm, low-stakes.",
        transitions: [
          {
            id: `${graphId}-idle-nearby`,
            label: "Player Nearby",
            nextNodeId: makeNodeId("hook"),
            conditions: [{ type: "player-nearby", distanceFt: 20 }],
          },
        ],
      },
      {
        id: makeNodeId("hook"),
        label: "Rumor Hook",
        objectiveText: "One or two NPCs start hinting at a specific rumor or problem in the room.",
        stageDirections: "Still social, but more directed. Avoid turning everyone into quest givers.",
        transitions: [
          {
            id: `${graphId}-hook-timeout`,
            label: "Back To Idle",
            nextNodeId: makeNodeId("idle"),
            conditions: [{ type: "active-node-timeout", seconds: 25 }],
          },
        ],
      },
    ],
  });
}

function formatStorybookConditionSummary(condition) {
  const normalized = ensureStorybookConditionShape(condition);
  const type = String(normalized.type || "always").trim();
  if (type === "player-nearby") {
    const distance = normalized.distanceFt ?? normalized.rangeFt ?? normalized.radiusFt ?? normalized.ft ?? 30;
    return `Player nearby <= ${distance}ft`;
  }
  if (type === "player-visible") {
    const distance = normalized.distanceFt ?? normalized.rangeFt ?? normalized.radiusFt ?? normalized.ft;
    return distance ? `Player visible within ${distance}ft` : "Player visible";
  }
  if (type === "active-node-timeout") {
    const seconds =
      normalized.seconds ??
      (Number.isFinite(Number(normalized.minutes)) ? Number(normalized.minutes) * 60 : null) ??
      (Number.isFinite(Number(normalized.timeoutMs || normalized.durationMs || normalized.ms))
        ? Math.round(Number(normalized.timeoutMs || normalized.durationMs || normalized.ms) / 1000)
        : null);
    return seconds ? `Node timeout ${seconds}s` : "Node timeout";
  }
  if (type === "combat-started") return "Combat started";
  if (type === "combat-ended") return "Combat ended";
  if (type === "always") return "Always";
  return type;
}

function renderStorybookGraphVisual(config) {
  const root = $("storybook-graph-visual");
  if (!root) return;
  root.innerHTML = "";
  const graph = getSelectedStorybookGraph(config);
  if (!graph) {
    const empty = document.createElement("div");
    empty.className = "storybook-graph-node";
    empty.textContent = "No story graph selected.";
    root.appendChild(empty);
    return;
  }

  const selectedNodeId = String(getSelectedStorybookNode(config)?.id || "");
  const entryNodeId = String(graph?.entryNodeId || "");
  const nodes = ensureArray(graph?.nodes);
  for (const node of nodes) {
    const card = document.createElement("article");
    card.className = "storybook-graph-node";
    if (String(node?.id || "") === selectedNodeId) card.classList.add("active");
    if (String(node?.id || "") === entryNodeId) card.classList.add("entry");

    const header = document.createElement("div");
    header.className = "storybook-graph-node-header";

    const title = document.createElement("div");
    title.className = "storybook-graph-node-title";
    title.textContent = String(node?.label || node?.id || "(node)");
    header.appendChild(title);

    const badge = document.createElement("div");
    badge.className = "storybook-graph-node-badge";
    badge.textContent = String(node?.id || "");
    header.appendChild(badge);
    card.appendChild(header);

    const meta = document.createElement("div");
    meta.className = "storybook-graph-node-meta";
    const objective = document.createElement("div");
    objective.textContent = `Objective: ${String(node?.objectiveText || "").trim() || "-"}`;
    meta.appendChild(objective);
    const actors = document.createElement("div");
    actors.textContent = `Actors: ${ensureArray(node?.npcIds).length ? ensureArray(node.npcIds).join(", ") : "all matched NPCs"}`;
    meta.appendChild(actors);
    card.appendChild(meta);

    const links = document.createElement("div");
    links.className = "storybook-graph-node-links";
    const transitions = ensureArray(node?.transitions);
    if (!transitions.length) {
      links.textContent = "No outgoing transitions";
    } else {
      links.innerHTML = transitions
        .slice(0, 4)
        .map((transition) => {
          const firstCondition = ensureArray(transition?.conditions)[0];
          const summary = firstCondition ? formatStorybookConditionSummary(firstCondition) : "Condition";
          return `${summary} -> ${String(transition?.nextNodeId || "-")}`;
        })
        .join("<br>");
    }
    card.appendChild(links);
    root.appendChild(card);
  }
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
  if ($("f-fvtt-default-session")) {
    $("f-fvtt-default-session").value = String(config?.foundry?.defaultSessionId || "default");
  }
  if ($("f-fvtt-sessions-json")) {
    $("f-fvtt-sessions-json").value = formatJsonArrayText(config?.foundry?.sessions || []);
  }

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

  syncNpcGlobalInputsFromConfig(config);
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
  config.foundry.defaultSessionId = String($("f-fvtt-default-session")?.value || config.foundry.defaultSessionId || "default").trim() || "default";
  config.foundry.sessions = parseJsonArrayText($("f-fvtt-sessions-json")?.value, config.foundry.sessions);
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

  applyNpcGlobalFormToConfig(config);

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

function setSocialTab(tabId) {
  const wanted = String(tabId || "simple");
  selectedSocialTabId = wanted;
  const buttons = document.querySelectorAll("[data-social-tab-btn]");
  const panels = document.querySelectorAll("[data-social-tab-content]");
  buttons.forEach((btn) => {
    const active = String(btn.dataset.socialTabBtn || "") === wanted;
    btn.classList.toggle("active", active);
  });
  panels.forEach((panel) => {
    const active = String(panel.dataset.socialTabContent || "") === wanted;
    panel.classList.toggle("active", active);
  });
  if (wanted === "status") {
    refreshSocialStatus({ silent: true });
  }
}

function initTabUi() {
  document.querySelectorAll("[data-main-tab-btn]").forEach((btn) => {
    btn.addEventListener("click", () => setMainTab(btn.dataset.mainTabBtn || "basic"));
  });
  document.querySelectorAll("[data-basic-tab-btn]").forEach((btn) => {
    btn.addEventListener("click", () => setBasicTab(btn.dataset.basicTabBtn || "runtime"));
  });
  document.querySelectorAll("[data-social-tab-btn]").forEach((btn) => {
    btn.addEventListener("click", () => setSocialTab(btn.dataset.socialTabBtn || "simple"));
  });
  setMainTab("basic");
  setBasicTab("runtime");
  setSocialTab(selectedSocialTabId || "simple");
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
  if (target.kind === "directorGlobal") return "Director - Global Prompt";
  if (target.kind === "ambientGlobal") return "Ambient - Global Prompt";
  if (target.kind === "storybookGlobal") return "Storybook - Global Prompt";

  if (target.kind === "npcDoc") {
    const npc = Array.isArray(config?.npcs) ? config.npcs[target.npcIndex] : null;
    const npcName = String(npc?.displayName || npc?.id || `npc_${target.npcIndex}`);
    const key = String(target.docKey || "");
    if (key === "soul") return `${npcName} - Soul/Personality`;
    if (key === "battle") return `${npcName} - Battle Pattern`;
    return `${npcName} - ${key}`;
  }

  if (target.kind === "npcDirectorPrompt") {
    const npc = Array.isArray(config?.npcs) ? config.npcs[target.npcIndex] : null;
    const npcName = String(npc?.displayName || npc?.id || `npc_${target.npcIndex}`);
    return `${npcName} - Director Prompt`;
  }

  return "Markdown";
}

function getDocTargetPath(config, target) {
  if (!target || !config) return "";
  if (target.kind === "world") return String(config?.npc?.sharedDocs?.world || "");
  if (target.kind === "directorGlobal") return String(config?.npc?.director?.promptFile || "");
  if (target.kind === "ambientGlobal") return String(config?.npc?.ambient?.promptFile || "");
  if (target.kind === "storybookGlobal") return String(config?.npc?.storybook?.promptFile || "");

  if (target.kind === "npcDoc") {
    const npc = Array.isArray(config?.npcs) ? config.npcs[target.npcIndex] : null;
    if (!npc) return "";
    return String(npc?.personaDocs?.[target.docKey] || "");
  }

  if (target.kind === "npcDirectorPrompt") {
    const npc = Array.isArray(config?.npcs) ? config.npcs[target.npcIndex] : null;
    if (!npc) return "";
    return String(npc?.director?.promptFile || "");
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
  } else if (target.kind === "directorGlobal") {
    config.npc = config.npc || {};
    config.npc.director = config.npc.director || {};
    config.npc.director.promptFile = p;
  } else if (target.kind === "ambientGlobal") {
    config.npc = config.npc || {};
    config.npc.ambient = config.npc.ambient || {};
    config.npc.ambient.promptFile = p;
  } else if (target.kind === "storybookGlobal") {
    config.npc = config.npc || {};
    config.npc.storybook = config.npc.storybook || {};
    config.npc.storybook.promptFile = p;
  } else if (target.kind === "npcDoc") {
    const npc = Array.isArray(config?.npcs) ? config.npcs[target.npcIndex] : null;
    if (!npc) return;
    npc.personaDocs = npc.personaDocs || {};
    npc.personaDocs[target.docKey] = p;
  } else if (target.kind === "npcDirectorPrompt") {
    const npc = Array.isArray(config?.npcs) ? config.npcs[target.npcIndex] : null;
    if (!npc) return;
    npc.director = npc.director || {};
    npc.director.promptFile = p;
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
    syncNpcGlobalInputsFromConfig(currentConfig);
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
    const reactFt = Number.isFinite(Number(npc?.triggers?.maxFt)) ? Number(npc.triggers.maxFt) : 0;
    const sessionRef =
      String(npc?.foundry?.sessionId || npc?.foundry?.username || npc?.foundry?.userId || config?.foundry?.defaultSessionId || "")
        .trim() || "-";
    const directorRef = optionalBoolSelectValue(npc?.director?.enabled);
    const socialWeight = Number.isFinite(Number(npc?.director?.socialWeight)) ? Number(npc.director.socialWeight) : 1;
    summary.textContent = `id=${npc.id || "-"} actor=${npc?.actor?.value || "-"} session=${sessionRef} react<=${reactFt}ft dir=${directorRef} weight=${socialWeight} image=${npc?.image?.enabled ? "on" : "off"}`;
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

  const foundryDetails = document.createElement("details");
  foundryDetails.className = "npc-image-details";
  if (
    String(npc?.foundry?.sessionId || "").trim() ||
    String(npc?.foundry?.userId || "").trim() ||
    String(npc?.foundry?.username || "").trim()
  ) {
    foundryDetails.open = true;
  }

  const foundrySummary = document.createElement("summary");
  foundrySummary.textContent = "FVTT Ownership / Session";
  foundryDetails.appendChild(foundrySummary);

  const foundryBody = document.createElement("div");
  foundryBody.className = "npc-image-body";

  const sessionRow = document.createElement("div");
  sessionRow.className = "npc-doc-row";
  const sessionLabel = document.createElement("label");
  sessionLabel.textContent = "Preferred Session ID";
  const sessionInput = document.createElement("input");
  sessionInput.type = "text";
  sessionInput.placeholder = String(config?.foundry?.defaultSessionId || "default");
  sessionInput.value = String(npc?.foundry?.sessionId || "");
  sessionInput.addEventListener("change", () => {
    npc.foundry = npc.foundry || {};
    npc.foundry.sessionId = String(sessionInput.value || "").trim();
    updateSummary();
    setConfigEditor(config);
  });
  sessionRow.appendChild(sessionLabel);
  sessionRow.appendChild(sessionInput);

  const fvttUserIdRow = document.createElement("div");
  fvttUserIdRow.className = "npc-doc-row";
  const fvttUserIdLabel = document.createElement("label");
  fvttUserIdLabel.textContent = "Fallback FVTT User ID";
  const fvttUserIdInput = document.createElement("input");
  fvttUserIdInput.type = "text";
  fvttUserIdInput.placeholder = "owner id";
  fvttUserIdInput.value = String(npc?.foundry?.userId || "");
  fvttUserIdInput.addEventListener("change", () => {
    npc.foundry = npc.foundry || {};
    npc.foundry.userId = String(fvttUserIdInput.value || "").trim();
    updateSummary();
    setConfigEditor(config);
  });
  fvttUserIdRow.appendChild(fvttUserIdLabel);
  fvttUserIdRow.appendChild(fvttUserIdInput);

  const fvttUsernameRow = document.createElement("div");
  fvttUsernameRow.className = "npc-doc-row";
  const fvttUsernameLabel = document.createElement("label");
  fvttUsernameLabel.textContent = "Fallback FVTT Username";
  const fvttUsernameInput = document.createElement("input");
  fvttUsernameInput.type = "text";
  fvttUsernameInput.placeholder = "owner username";
  fvttUsernameInput.value = String(npc?.foundry?.username || "");
  fvttUsernameInput.addEventListener("change", () => {
    npc.foundry = npc.foundry || {};
    npc.foundry.username = String(fvttUsernameInput.value || "").trim();
    updateSummary();
    setConfigEditor(config);
  });
  fvttUsernameRow.appendChild(fvttUsernameLabel);
  fvttUsernameRow.appendChild(fvttUsernameInput);

  foundryBody.appendChild(sessionRow);
  foundryBody.appendChild(fvttUserIdRow);
  foundryBody.appendChild(fvttUsernameRow);
  foundryDetails.appendChild(foundryBody);

  const directorDetails = document.createElement("details");
  directorDetails.className = "npc-image-details";
  if (
    npc?.director?.enabled !== null ||
    npc?.director?.allowAmbientTalk !== null ||
    npc?.director?.allowNpcToNpc !== null ||
    Number(npc?.director?.socialWeight || 1) !== 1 ||
    npc?.director?.playerNearbyFt !== null ||
    npc?.director?.npcCooldownMs !== null ||
    String(npc?.director?.promptFile || "").trim() ||
    String(npc?.director?.promptText || "").trim()
  ) {
    directorDetails.open = true;
  }

  const directorSummary = document.createElement("summary");
  directorSummary.textContent = "Director Settings";
  directorDetails.appendChild(directorSummary);

  const directorBody = document.createElement("div");
  directorBody.className = "npc-image-body";

  const createDirectorOverrideRow = (labelText, selectedValue, onChange) => {
    const row = document.createElement("div");
    row.className = "npc-doc-row";
    const label = document.createElement("label");
    label.textContent = labelText;
    const select = document.createElement("select");
    select.innerHTML = [
      '<option value="global">Use Global Default</option>',
      '<option value="on">Force On</option>',
      '<option value="off">Force Off</option>',
    ].join("");
    select.value = optionalBoolSelectValue(selectedValue);
    select.addEventListener("change", () => onChange(parseOptionalBoolSelectValue(select.value)));
    row.appendChild(label);
    row.appendChild(select);
    return row;
  };

  const directorEnabledRow = createDirectorOverrideRow("Director Enabled", npc?.director?.enabled, (value) => {
    npc.director = npc.director || {};
    npc.director.enabled = value;
    updateSummary();
    setConfigEditor(config);
  });

  const ambientOverrideRow = createDirectorOverrideRow("Ambient Daily Talk", npc?.director?.allowAmbientTalk, (value) => {
    npc.director = npc.director || {};
    npc.director.allowAmbientTalk = value;
    setConfigEditor(config);
  });

  const npcToNpcOverrideRow = createDirectorOverrideRow("NPC to NPC Talk", npc?.director?.allowNpcToNpc, (value) => {
    npc.director = npc.director || {};
    npc.director.allowNpcToNpc = value;
    setConfigEditor(config);
  });

  const socialWeightRow = document.createElement("div");
  socialWeightRow.className = "npc-doc-row";
  const socialWeightLabel = document.createElement("label");
  socialWeightLabel.textContent = "Social Weight";
  const socialWeightInput = document.createElement("input");
  socialWeightInput.type = "number";
  socialWeightInput.min = "0";
  socialWeightInput.max = "10";
  socialWeightInput.step = "0.1";
  socialWeightInput.value = String(Number.isFinite(Number(npc?.director?.socialWeight)) ? Number(npc.director.socialWeight) : 1);
  socialWeightInput.addEventListener("change", () => {
    npc.director = npc.director || {};
    const parsed = Number(socialWeightInput.value);
    npc.director.socialWeight = Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
    socialWeightInput.value = String(npc.director.socialWeight);
    updateSummary();
    setConfigEditor(config);
  });
  socialWeightRow.appendChild(socialWeightLabel);
  socialWeightRow.appendChild(socialWeightInput);

  const directorNearbyRow = document.createElement("div");
  directorNearbyRow.className = "npc-doc-row";
  const directorNearbyLabel = document.createElement("label");
  directorNearbyLabel.textContent = "Player Nearby Distance Override (ft)";
  const directorNearbyInput = document.createElement("input");
  directorNearbyInput.type = "number";
  directorNearbyInput.min = "0";
  directorNearbyInput.step = "1";
  directorNearbyInput.placeholder = "global";
  directorNearbyInput.value =
    npc?.director?.playerNearbyFt === null || npc?.director?.playerNearbyFt === undefined
      ? ""
      : String(npc.director.playerNearbyFt);
  directorNearbyInput.addEventListener("change", () => {
    npc.director = npc.director || {};
    const raw = String(directorNearbyInput.value || "").trim();
    const parsed = Number(raw);
    npc.director.playerNearbyFt = raw && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    directorNearbyInput.value = npc.director.playerNearbyFt === null ? "" : String(npc.director.playerNearbyFt);
    setConfigEditor(config);
  });
  directorNearbyRow.appendChild(directorNearbyLabel);
  directorNearbyRow.appendChild(directorNearbyInput);

  const directorCooldownRow = document.createElement("div");
  directorCooldownRow.className = "npc-doc-row";
  const directorCooldownLabel = document.createElement("label");
  directorCooldownLabel.textContent = "NPC Cooldown Override (ms)";
  const directorCooldownInput = document.createElement("input");
  directorCooldownInput.type = "number";
  directorCooldownInput.min = "0";
  directorCooldownInput.step = "100";
  directorCooldownInput.placeholder = "global";
  directorCooldownInput.value =
    npc?.director?.npcCooldownMs === null || npc?.director?.npcCooldownMs === undefined
      ? ""
      : String(npc.director.npcCooldownMs);
  directorCooldownInput.addEventListener("change", () => {
    npc.director = npc.director || {};
    const raw = String(directorCooldownInput.value || "").trim();
    const parsed = Number(raw);
    npc.director.npcCooldownMs = raw && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    directorCooldownInput.value = npc.director.npcCooldownMs === null ? "" : String(npc.director.npcCooldownMs);
    setConfigEditor(config);
  });
  directorCooldownRow.appendChild(directorCooldownLabel);
  directorCooldownRow.appendChild(directorCooldownInput);

  const directorPromptTarget = { kind: "npcDirectorPrompt", npcIndex: i };
  const directorPromptRow = createDocPathRow({
    label: "Director Prompt Override (.md)",
    value: npc?.director?.promptFile || "",
    placeholder: "C:\\docs\\npc-director.md",
    onChange: (v) => {
      setDocTargetPath(config, directorPromptTarget, v);
      setConfigEditor(config);
    },
    onPick: () => pickMarkdownForTarget(directorPromptTarget, { openEditor: false }),
    onEdit: () => editTargetWithFallbackPick(directorPromptTarget),
  });

  const directorPromptTextRow = document.createElement("div");
  directorPromptTextRow.className = "npc-doc-row";
  const directorPromptTextLabel = document.createElement("label");
  directorPromptTextLabel.textContent = "Director Prompt Inline Addendum";
  const directorPromptTextArea = document.createElement("textarea");
  directorPromptTextArea.className = "npc-textarea";
  directorPromptTextArea.placeholder = "Optional NPC-specific director note";
  directorPromptTextArea.value = String(npc?.director?.promptText || "");
  directorPromptTextArea.addEventListener("change", () => {
    npc.director = npc.director || {};
    npc.director.promptText = String(directorPromptTextArea.value || "").trim();
    setConfigEditor(config);
  });
  directorPromptTextRow.appendChild(directorPromptTextLabel);
  directorPromptTextRow.appendChild(directorPromptTextArea);

  directorBody.appendChild(directorEnabledRow);
  directorBody.appendChild(ambientOverrideRow);
  directorBody.appendChild(npcToNpcOverrideRow);
  directorBody.appendChild(socialWeightRow);
  directorBody.appendChild(directorNearbyRow);
  directorBody.appendChild(directorCooldownRow);
  directorBody.appendChild(directorPromptRow);
  directorBody.appendChild(directorPromptTextRow);
  directorDetails.appendChild(directorBody);

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
  controls.appendChild(foundryDetails);
  controls.appendChild(directorDetails);
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
  syncStorybookFieldsFromConfig(currentConfig);
  if (runtimeStarted) {
    await refreshNpcVisuals({ silent: true });
  }
  await refreshSocialStatus({ silent: true });
  return currentConfig;
}

async function saveNpcSettingsOnly() {
  currentConfig = applyNpcGlobalFormToConfig(currentConfig || {});

  const latest = await window.api.getConfig();
  const merged = ensureConfigShape(latest?.config || {});
  merged.npc = cloneJson(currentConfig.npc || {});
  merged.npcs = cloneJson(currentConfig.npcs || []);

  await window.api.setConfig(merged);
  currentConfig = ensureConfigShape(merged);
  setConfigEditor(currentConfig);
  renderNpcList(currentConfig);
  syncNpcGlobalInputsFromConfig(currentConfig);
  await refreshSocialStatus({ silent: true });
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
  syncNpcGlobalInputsFromConfig(currentConfig);
  syncStorybookFieldsFromConfig(currentConfig);
  await refreshSocialStatus({ silent: true });
}

function buildScenePresetExportPack(preset) {
  return {
    kind: "livenpc-social-scene-preset",
    version: 1,
    exportedAt: new Date().toISOString(),
    preset: cloneJson(preset || {}),
  };
}

async function exportSelectedScenePreset() {
  currentConfig = applyNpcGlobalFormToConfig(currentConfig || {});
  const preset = getSelectedScenePreset(currentConfig);
  if (!preset) throw new Error("no scene preset selected");

  const suggestedName = `${String(preset.label || preset.sceneName || preset.sceneId || preset.id || "scene-preset")
    .replace(/[^\w\-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "scene-preset"}.json`;
  const picked = await window.api.pickJsonSaveFile(suggestedName);
  if (!picked?.ok) {
    if (picked?.canceled) return false;
    throw new Error(picked?.error || "export path selection failed");
  }

  const payload = JSON.stringify(buildScenePresetExportPack(preset), null, 2);
  const saved = await window.api.writeTextFile(picked.path, payload);
  if (!saved?.ok) throw new Error(saved?.error || "preset export failed");
  appendLog({ ts: Date.now(), level: "info", scope: "ui", message: `scene preset exported: ${picked.path}` });
  return true;
}

async function importScenePreset() {
  const picked = await window.api.pickJsonFile();
  if (!picked?.ok) {
    if (picked?.canceled) return false;
    throw new Error(picked?.error || "import selection failed");
  }

  const read = await window.api.readTextFile(picked.path);
  if (!read?.ok) throw new Error(read?.error || "preset import read failed");

  const parsed = JSON.parse(String(read.text || "{}"));
  const rawPreset =
    parsed && typeof parsed === "object" && parsed.preset && typeof parsed.preset === "object" ? parsed.preset : parsed;

  currentConfig = ensureConfigShape(currentConfig || {});
  const imported = ensureScenePresetShape(
    rawPreset,
    Array.isArray(currentConfig?.npc?.scenePresets) ? currentConfig.npc.scenePresets.length : 0,
    currentConfig?.npc?.director || {},
    currentConfig?.npc?.ambient || {}
  );

  const presets = Array.isArray(currentConfig?.npc?.scenePresets) ? currentConfig.npc.scenePresets : [];
  const existingIndex = presets.findIndex((preset) => String(preset?.id || "") === String(imported.id || ""));
  if (existingIndex >= 0) {
    presets[existingIndex] = imported;
  } else {
    presets.push(imported);
  }
  currentConfig.npc.scenePresets = presets;
  selectedSocialPresetId = String(imported.id || "");
  currentConfig = applyScenePresetToConfig(currentConfig, imported);
  setConfigEditor(currentConfig);
  renderNpcList(currentConfig);
  syncNpcGlobalInputsFromConfig(currentConfig);
  appendLog({
    ts: Date.now(),
    level: "info",
    scope: "ui",
    message: `scene preset imported and applied: ${picked.path}`,
  });
  return true;
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
      currentConfig = applyNpcGlobalFormToConfig(currentConfig || {});
      setConfigEditor(currentConfig);
    });
  }

  const npcGlobalFieldIds = [
    "f-director-enabled",
    "f-director-mode",
    "f-director-prompt-file",
    "f-director-prompt-text",
    "f-director-ambient",
    "f-director-npc2npc",
    "f-director-player-nearby-ft",
    "f-director-max-chain-turns",
    "f-director-max-participants",
    "f-director-npc-cooldown-ms",
    "f-director-scene-cooldown-ms",
    "f-director-token-budget",
    "f-director-token-window-ms",
    "f-director-line-delay-min-ms",
    "f-director-line-delay-max-ms",
    "f-ambient-enabled",
    "f-ambient-prompt-file",
    "f-ambient-prompt-text",
    "f-world-state-text",
    "f-storybook-enabled",
    "f-storybook-mode",
    "f-storybook-prompt-file",
    "f-storybook-prompt-text",
  ];
  for (const fieldId of npcGlobalFieldIds) {
    const el = $(fieldId);
    if (!el) continue;
    el.addEventListener("change", () => {
      currentConfig = applyNpcGlobalFormToConfig(currentConfig || {});
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

  const directorPromptPickButton = $("btn-director-prompt-pick");
  if (directorPromptPickButton) {
    directorPromptPickButton.addEventListener("click", async () => {
      await pickMarkdownForTarget({ kind: "directorGlobal" }, { openEditor: false });
    });
  }

  const directorPromptEditButton = $("btn-director-prompt-edit");
  if (directorPromptEditButton) {
    directorPromptEditButton.addEventListener("click", async () => {
      await editTargetWithFallbackPick({ kind: "directorGlobal" });
    });
  }

  const ambientPromptPickButton = $("btn-ambient-prompt-pick");
  if (ambientPromptPickButton) {
    ambientPromptPickButton.addEventListener("click", async () => {
      await pickMarkdownForTarget({ kind: "ambientGlobal" }, { openEditor: false });
    });
  }

  const ambientPromptEditButton = $("btn-ambient-prompt-edit");
  if (ambientPromptEditButton) {
    ambientPromptEditButton.addEventListener("click", async () => {
      await editTargetWithFallbackPick({ kind: "ambientGlobal" });
    });
  }

  const storybookPromptPickButton = $("btn-storybook-prompt-pick");
  if (storybookPromptPickButton) {
    storybookPromptPickButton.addEventListener("click", async () => {
      await pickMarkdownForTarget({ kind: "storybookGlobal" }, { openEditor: false });
    });
  }

  const storybookPromptEditButton = $("btn-storybook-prompt-edit");
  if (storybookPromptEditButton) {
    storybookPromptEditButton.addEventListener("click", async () => {
      await editTargetWithFallbackPick({ kind: "storybookGlobal" });
    });
  }

  const socialPresetSelect = $("f-social-preset-select");
  if (socialPresetSelect) {
    socialPresetSelect.addEventListener("change", () => {
      selectedSocialPresetId = String(socialPresetSelect.value || "");
      syncSelectedScenePresetFields(currentConfig || {});
    });
  }

  const bindPresetMetaField = (fieldId, key) => {
    const el = $(fieldId);
    if (!el) return;
    el.addEventListener("change", () => {
      currentConfig = ensureConfigShape(currentConfig || {});
      const preset = getSelectedScenePreset(currentConfig);
      if (!preset) return;
      preset[key] = String(el.value || "").trim();
      if (key === "label") {
        syncSocialPresetSelectFromConfig(currentConfig);
      }
      setConfigEditor(currentConfig);
    });
  };
  bindPresetMetaField("f-social-preset-label", "label");
  bindPresetMetaField("f-social-preset-scene-id", "sceneId");
  bindPresetMetaField("f-social-preset-scene-name", "sceneName");

  const newPresetButton = $("btn-social-preset-new");
  if (newPresetButton) {
    newPresetButton.addEventListener("click", () => {
      currentConfig = applyNpcGlobalFormToConfig(currentConfig || {});
      const preset = captureCurrentSocialPreset(currentConfig, {
        id: makeUniqueScenePresetId(currentConfig),
        label: "New Scene Preset",
        sceneId: "",
        sceneName: "",
      });
      currentConfig.npc.scenePresets.push(preset);
      selectedSocialPresetId = String(preset.id || "");
      syncNpcGlobalInputsFromConfig(currentConfig);
      setConfigEditor(currentConfig);
      appendLog({ ts: Date.now(), level: "info", scope: "ui", message: `scene preset created: ${preset.label}` });
    });
  }

  const capturePresetButton = $("btn-social-preset-capture");
  if (capturePresetButton) {
    capturePresetButton.addEventListener("click", () => {
      currentConfig = applyNpcGlobalFormToConfig(currentConfig || {});
      const current = getSelectedScenePreset(currentConfig);
      if (!current) {
        appendLog({ ts: Date.now(), level: "warn", scope: "ui", message: "no scene preset selected to capture into" });
        return;
      }
      const captured = captureCurrentSocialPreset(currentConfig, current);
      const presets = currentConfig.npc.scenePresets || [];
      const index = presets.findIndex((preset) => String(preset?.id || "") === String(current.id || ""));
      if (index >= 0) presets[index] = captured;
      currentConfig.npc.scenePresets = presets;
      selectedSocialPresetId = String(captured.id || "");
      syncNpcGlobalInputsFromConfig(currentConfig);
      setConfigEditor(currentConfig);
      appendLog({ ts: Date.now(), level: "info", scope: "ui", message: `scene preset captured: ${captured.label}` });
    });
  }

  const applyPresetButton = $("btn-social-preset-apply");
  if (applyPresetButton) {
    applyPresetButton.addEventListener("click", () => {
      currentConfig = applyNpcGlobalFormToConfig(currentConfig || {});
      const preset = getSelectedScenePreset(currentConfig);
      if (!preset) {
        appendLog({ ts: Date.now(), level: "warn", scope: "ui", message: "no scene preset selected to apply" });
        return;
      }
      currentConfig = applyScenePresetToConfig(currentConfig, preset);
      setConfigEditor(currentConfig);
      renderNpcList(currentConfig);
      syncNpcGlobalInputsFromConfig(currentConfig);
      appendLog({ ts: Date.now(), level: "info", scope: "ui", message: `scene preset applied: ${preset.label}` });
    });
  }

  const deletePresetButton = $("btn-social-preset-delete");
  if (deletePresetButton) {
    deletePresetButton.addEventListener("click", () => {
      currentConfig = ensureConfigShape(currentConfig || {});
      const preset = getSelectedScenePreset(currentConfig);
      if (!preset) return;
      currentConfig.npc.scenePresets = ensureArray(currentConfig.npc.scenePresets).filter(
        (entry) => String(entry?.id || "") !== String(preset.id || "")
      );
      selectedSocialPresetId = String(currentConfig.npc.scenePresets[0]?.id || "");
      syncNpcGlobalInputsFromConfig(currentConfig);
      setConfigEditor(currentConfig);
      appendLog({ ts: Date.now(), level: "info", scope: "ui", message: `scene preset deleted: ${preset.label}` });
    });
  }

  const exportPresetButton = $("btn-social-preset-export");
  if (exportPresetButton) {
    exportPresetButton.addEventListener("click", async () => {
      exportPresetButton.disabled = true;
      try {
        await exportSelectedScenePreset();
      } catch (e) {
        appendLog({ ts: Date.now(), level: "error", scope: "ui", message: `preset export failed: ${e?.message || e}` });
      } finally {
        exportPresetButton.disabled = false;
      }
    });
  }

  const importPresetButton = $("btn-social-preset-import");
  if (importPresetButton) {
    importPresetButton.addEventListener("click", async () => {
      importPresetButton.disabled = true;
      try {
        await importScenePreset();
      } catch (e) {
        appendLog({ ts: Date.now(), level: "error", scope: "ui", message: `preset import failed: ${e?.message || e}` });
      } finally {
        importPresetButton.disabled = false;
      }
    });
  }

  const bindStorybookField = (fieldId, handler, { event = "change" } = {}) => {
    const el = $(fieldId);
    if (!el) return;
    el.addEventListener(event, () => {
      currentConfig = applyStorybookFormToConfig(currentConfig || {});
      if (typeof handler === "function") handler(el);
      setConfigEditor(currentConfig);
    });
  };

  const storybookGlobalFields = [
    "f-storybook-enabled",
    "f-storybook-mode",
    "f-storybook-prompt-file",
    "f-storybook-prompt-text",
    "f-storybook-graph-label",
    "f-storybook-graph-enabled",
    "f-storybook-graph-scene-id",
    "f-storybook-graph-scene-name",
    "f-storybook-graph-entry-node-id",
    "f-storybook-graph-notes",
    "f-storybook-node-label",
    "f-storybook-node-enabled",
    "f-storybook-node-id",
    "f-storybook-node-npc-ids",
    "f-storybook-node-objective-text",
    "f-storybook-node-stage-directions",
    "f-storybook-transition-label",
    "f-storybook-transition-next-node-id",
    "f-storybook-transition-condition-type",
    "f-storybook-transition-condition-distance-ft",
    "f-storybook-transition-condition-timeout-seconds",
    "f-storybook-transition-advanced-enabled",
    "f-storybook-transition-conditions",
  ];
  for (const fieldId of storybookGlobalFields) {
    const el = $(fieldId);
    if (!el) continue;
    const eventType = el.tagName === "INPUT" && el.type !== "checkbox" ? "input" : el.tagName === "TEXTAREA" ? "input" : "change";
    el.addEventListener(eventType, () => {
      currentConfig = applyStorybookFormToConfig(currentConfig || {});
      setConfigEditor(currentConfig);
    });
    if (eventType === "input") {
      el.addEventListener("change", () => {
        currentConfig = applyStorybookFormToConfig(currentConfig || {});
        setConfigEditor(currentConfig);
      });
    }
  }

  const storybookGraphSelect = $("f-storybook-graph-select");
  if (storybookGraphSelect) {
    storybookGraphSelect.addEventListener("change", () => {
      currentConfig = applyStorybookFormToConfig(currentConfig || {});
      selectStorybookGraph(currentConfig, storybookGraphSelect.value);
      setConfigEditor(currentConfig);
    });
  }

  const storybookNodeSelect = $("f-storybook-node-select");
  if (storybookNodeSelect) {
    storybookNodeSelect.addEventListener("change", () => {
      currentConfig = applyStorybookFormToConfig(currentConfig || {});
      selectStorybookNode(currentConfig, storybookNodeSelect.value);
      setConfigEditor(currentConfig);
    });
  }

  const storybookTransitionSelect = $("f-storybook-transition-select");
  if (storybookTransitionSelect) {
    storybookTransitionSelect.addEventListener("change", () => {
      currentConfig = applyStorybookFormToConfig(currentConfig || {});
      selectStorybookTransition(currentConfig, storybookTransitionSelect.value);
      setConfigEditor(currentConfig);
    });
  }

  const addGraphButtons = ["btn-storybook-graph-new", "btn-storybook-graph-add"];
  for (const buttonId of addGraphButtons) {
    const button = $(buttonId);
    if (!button) continue;
    button.addEventListener("click", () => {
      currentConfig = ensureConfigShape(currentConfig || {});
      currentConfig = applyStorybookFormToConfig(currentConfig);
      currentConfig.npc.storybook = ensureStorybookShape(currentConfig.npc.storybook);
      const graph = ensureStorybookGraphShape(
        {
          id: makeUniqueStorybookGraphId(currentConfig),
          label: "New Graph",
          enabled: true,
          sceneId: "",
          sceneName: "",
          entryNodeId: "",
          notes: "",
          nodes: [],
        },
        Array.isArray(currentConfig?.npc?.storybook?.graphs) ? currentConfig.npc.storybook.graphs.length : 0
      );
      currentConfig.npc.storybook.graphs.push(graph);
      selectedStorybookGraphId = String(graph.id || "");
      selectedStorybookNodeId = "";
      selectedStorybookTransitionId = "";
      syncStorybookFieldsFromConfig(currentConfig);
      setConfigEditor(currentConfig);
      appendLog({ ts: Date.now(), level: "info", scope: "ui", message: `storybook graph created: ${graph.label}` });
    });
  }

  const deleteGraphButton = $("btn-storybook-graph-delete");
  if (deleteGraphButton) {
    deleteGraphButton.addEventListener("click", () => {
      currentConfig = ensureConfigShape(currentConfig || {});
      const graph = getSelectedStorybookGraph(currentConfig);
      if (!graph) return;
      const answer = window.prompt(`'${graph.label || graph.id}' 그래프를 정말 삭제하시겠습니까?\n삭제하려면 yes 를 입력하세요.`);
      if (String(answer || "").trim().toLowerCase() !== "yes") return;
      currentConfig.npc.storybook.graphs = ensureArray(currentConfig.npc.storybook.graphs).filter(
        (entry) => String(entry?.id || "") !== String(graph.id || "")
      );
      selectedStorybookGraphId = String(currentConfig.npc.storybook.graphs[0]?.id || "");
      selectedStorybookNodeId = "";
      selectedStorybookTransitionId = "";
      syncStorybookFieldsFromConfig(currentConfig);
      setConfigEditor(currentConfig);
      appendLog({ ts: Date.now(), level: "info", scope: "ui", message: `storybook graph deleted: ${graph.label || graph.id}` });
    });
  }

  const addNodeButtons = ["btn-storybook-node-new", "btn-storybook-node-add"];
  for (const buttonId of addNodeButtons) {
    const button = $(buttonId);
    if (!button) continue;
    button.addEventListener("click", () => {
      currentConfig = ensureConfigShape(currentConfig || {});
      currentConfig = applyStorybookFormToConfig(currentConfig);
      const graph = getSelectedStorybookGraph(currentConfig);
      if (!graph) {
        appendLog({ ts: Date.now(), level: "warn", scope: "ui", message: "no storybook graph selected" });
        return;
      }
      graph.nodes = ensureArray(graph.nodes);
      const node = ensureStorybookNodeShape(
        {
          id: makeUniqueStorybookNodeId(graph),
          label: "New Node",
          enabled: true,
          npcIds: [],
          objectiveText: "",
          stageDirections: "",
          transitions: [],
        },
        graph.nodes.length
      );
      graph.nodes.push(node);
      if (!graph.entryNodeId) graph.entryNodeId = String(node.id || "");
      selectedStorybookGraphId = String(graph.id || "");
      selectedStorybookNodeId = String(node.id || "");
      selectedStorybookTransitionId = "";
      syncStorybookFieldsFromConfig(currentConfig);
      setConfigEditor(currentConfig);
      appendLog({ ts: Date.now(), level: "info", scope: "ui", message: `storybook node created: ${node.label}` });
    });
  }

  const deleteNodeButton = $("btn-storybook-node-delete");
  if (deleteNodeButton) {
    deleteNodeButton.addEventListener("click", () => {
      currentConfig = ensureConfigShape(currentConfig || {});
      const graph = getSelectedStorybookGraph(currentConfig);
      const node = getSelectedStorybookNode(currentConfig);
      if (!graph || !node) return;
      const answer = window.prompt(`'${node.label || node.id}' 노드를 정말 삭제하시겠습니까?\n삭제하려면 yes 를 입력하세요.`);
      if (String(answer || "").trim().toLowerCase() !== "yes") return;
      graph.nodes = ensureArray(graph.nodes).filter((entry) => String(entry?.id || "") !== String(node.id || ""));
      if (String(graph.entryNodeId || "") === String(node.id || "")) {
        graph.entryNodeId = String(graph.nodes[0]?.id || "");
      }
      for (const nextNode of ensureArray(graph.nodes)) {
        nextNode.transitions = ensureArray(nextNode.transitions).map((transition) => {
          const next = ensureStorybookTransitionShape(transition);
          if (String(next.nextNodeId || "") === String(node.id || "")) {
            next.nextNodeId = String(graph.entryNodeId || graph.nodes[0]?.id || "");
          }
          return next;
        });
      }
      selectedStorybookNodeId = String(graph.nodes[0]?.id || "");
      selectedStorybookTransitionId = "";
      syncStorybookFieldsFromConfig(currentConfig);
      setConfigEditor(currentConfig);
      appendLog({ ts: Date.now(), level: "info", scope: "ui", message: `storybook node deleted: ${node.label || node.id}` });
    });
  }

  const addTransitionButtons = ["btn-storybook-transition-new", "btn-storybook-transition-add"];
  for (const buttonId of addTransitionButtons) {
    const button = $(buttonId);
    if (!button) continue;
    button.addEventListener("click", () => {
      currentConfig = ensureConfigShape(currentConfig || {});
      currentConfig = applyStorybookFormToConfig(currentConfig);
      const node = getSelectedStorybookNode(currentConfig);
      if (!node) {
        appendLog({ ts: Date.now(), level: "warn", scope: "ui", message: "no storybook node selected" });
        return;
      }
      node.transitions = ensureArray(node.transitions);
      const transition = ensureStorybookTransitionShape(
        {
          id: makeUniqueStorybookTransitionId(node),
          label: "New Transition",
          nextNodeId: "",
          conditions: [{ type: "always" }],
        },
        node.transitions.length
      );
      node.transitions.push(transition);
      selectedStorybookTransitionId = String(transition.id || "");
      syncStorybookFieldsFromConfig(currentConfig);
      setConfigEditor(currentConfig);
      appendLog({ ts: Date.now(), level: "info", scope: "ui", message: `storybook transition created: ${transition.label}` });
    });
  }

  const deleteTransitionButton = $("btn-storybook-transition-delete");
  if (deleteTransitionButton) {
    deleteTransitionButton.addEventListener("click", () => {
      currentConfig = ensureConfigShape(currentConfig || {});
      const node = getSelectedStorybookNode(currentConfig);
      const transition = getSelectedStorybookTransition(currentConfig);
      if (!node || !transition) return;
      const answer = window.prompt(`'${transition.label || transition.id}' 전이 규칙을 정말 삭제하시겠습니까?\n삭제하려면 yes 를 입력하세요.`);
      if (String(answer || "").trim().toLowerCase() !== "yes") return;
      node.transitions = ensureArray(node.transitions).filter((entry) => String(entry?.id || "") !== String(transition.id || ""));
      selectedStorybookTransitionId = String(node.transitions[0]?.id || "");
      syncStorybookFieldsFromConfig(currentConfig);
      setConfigEditor(currentConfig);
      appendLog({ ts: Date.now(), level: "info", scope: "ui", message: `storybook transition deleted: ${transition.label || transition.id}` });
    });
  }

  const saveSocialButton = $("btn-save-social");
  if (saveSocialButton) {
    saveSocialButton.addEventListener("click", async () => {
      saveSocialButton.disabled = true;
      try {
        currentConfig = applyStorybookFormToConfig(currentConfig || {});
        await saveNpcSettingsOnly();
        appendLog({ ts: Date.now(), level: "info", scope: "ui", message: "social settings saved" });
      } catch (e) {
        appendLog({ ts: Date.now(), level: "error", scope: "ui", message: `social save failed: ${e?.message || e}` });
      } finally {
        saveSocialButton.disabled = false;
      }
    });
  }

  const reloadSocialButton = $("btn-reload-social");
  if (reloadSocialButton) {
    reloadSocialButton.addEventListener("click", async () => {
      reloadSocialButton.disabled = true;
      try {
        await reloadNpcSettingsOnly();
        appendLog({ ts: Date.now(), level: "info", scope: "ui", message: "social settings reloaded" });
      } catch (e) {
        appendLog({ ts: Date.now(), level: "error", scope: "ui", message: `social reload failed: ${e?.message || e}` });
      } finally {
        reloadSocialButton.disabled = false;
      }
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
      currentConfig = applyNpcGlobalFormToConfig(currentConfig || {});
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
      await refreshSocialStatus({ silent: true });
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
      await refreshSocialStatus({ silent: true });
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

  if (socialStatusPollTimer) {
    window.clearInterval(socialStatusPollTimer);
  }
  socialStatusPollTimer = window.setInterval(() => {
    refreshSocialStatus({ silent: true });
  }, 5000);
}

init().catch((e) => {
  appendLog({ ts: Date.now(), level: "error", scope: "ui", message: `init failed: ${e?.message || e}` });
});
