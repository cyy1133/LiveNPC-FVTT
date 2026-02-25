const fs = require("node:fs/promises");
const path = require("node:path");
const { Client, Events, GatewayIntentBits } = require("discord.js");
const dotenv = require("dotenv");

const { Logger } = require("./logger");
const { completeJson } = require("./llm/openai-client");
const { login: openaiOauthLogin, refreshToken: openaiOauthRefresh } = require("./llm/openai-codex-oauth");
const {
  normalizeCodexBin,
  getLoginStatus: getCodexLoginStatus,
  launchLogin: launchCodexLogin,
  completeStructured: codexCompleteStructured,
} = require("./llm/codex-cli-client");
const { ensureCodexPrerequisites } = require("./setup/prereq-manager");

// Foundry automation layer (Playwright + in-page scripts)
const { FvttClient } = require("./fvtt/fvtt-client");

dotenv.config();

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function compact(text, max = 400) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 3)) + "...";
}

function safeLower(text) {
  return String(text || "").trim().toLowerCase();
}

function normalizeTokenKey(text) {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function clampInt(value, fallback, min = 64, max = 4096) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalizeNpcImageGenerationState({ config, npc } = {}) {
  const globalCfg = isPlainObject(config?.imageGeneration) ? config.imageGeneration : {};
  const npcImage = isPlainObject(npc?.image) ? npc.image : {};

  const webuiUrl = String(globalCfg.webuiUrl || "").trim().replace(/\/+$/, "");
  const width = clampInt(globalCfg.width, 768, 64, 4096);
  const height = clampInt(globalCfg.height, 768, 64, 4096);
  const timeoutMs = clampInt(globalCfg.timeoutMs, 120000, 15000, 300000);
  const defaultPrompt = String(npcImage.defaultPrompt || npcImage.baseTags || "").trim();
  const npcEnabled = npcImage.enabled === true;
  const configured = Boolean(webuiUrl);
  const enabled = configured && npcEnabled;

  return {
    configured,
    enabled,
    webuiUrl,
    width,
    height,
    timeoutMs,
    defaultPrompt,
    // Keep alias for older code paths.
    baseTags: defaultPrompt,
    npcEnabled,
  };
}

function normalizeImagePromptText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\u0000/g, "")
    .trim();
}

function buildImagePrompt({ npcName, baseTags, extraPrompt }) {
  const base = normalizeImagePromptText(baseTags);
  const extra = normalizeImagePromptText(extraPrompt);
  const rawTags = [];
  if (base) rawTags.push(...base.split(","));
  if (extra) rawTags.push(...extra.split(","));

  const seen = new Set();
  const deduped = [];
  for (const raw of rawTags) {
    const tag = normalizeImagePromptText(raw);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(tag);
  }

  if (!deduped.length) {
    deduped.push(`${String(npcName || "NPC")} portrait`);
    deduped.push("fantasy style");
    deduped.push("cinematic lighting");
  }
  return deduped.join(", ");
}

function escapeHtml(text) {
  const s = String(text || "");
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pad2(n) {
  return String(Number(n) || 0).padStart(2, "0");
}

function formatTraceStamp(ts = Date.now()) {
  const d = new Date(ts);
  return [
    d.getFullYear(),
    pad2(d.getMonth() + 1),
    pad2(d.getDate()),
    "-",
    pad2(d.getHours()),
    pad2(d.getMinutes()),
    pad2(d.getSeconds()),
  ].join("");
}

function isSensitiveKeyName(key) {
  return /(token|password|api[_-]?key|secret|authorization|cookie|session)/i.test(String(key || ""));
}

function sanitizeForTrace(value) {
  const seen = new WeakSet();

  function walk(v, keyHint = "", depth = 0) {
    if (isSensitiveKeyName(keyHint)) return "[REDACTED]";
    if (v === null || v === undefined) return v;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
    if (typeof v === "bigint") return String(v);
    if (typeof v === "function") return `[Function:${v.name || "anonymous"}]`;
    if (v instanceof Error) {
      return {
        name: v.name || "Error",
        message: String(v.message || ""),
        stack: String(v.stack || ""),
      };
    }
    if (depth > 12) return "[MaxDepth]";

    if (Array.isArray(v)) {
      return v.map((item) => walk(item, "", depth + 1));
    }

    if (typeof v === "object") {
      if (seen.has(v)) return "[Circular]";
      seen.add(v);

      const out = {};
      for (const [k, child] of Object.entries(v)) {
        out[k] = walk(child, k, depth + 1);
      }
      return out;
    }

    return String(v);
  }

  return walk(value, "", 0);
}

function pickEnabledNpcs(config) {
  const npcs = ensureArray(config?.npcs).filter((npc) => npc && npc.enabled !== false);
  return npcs;
}

function resolveNpcForDiscordMessage({ content, npcs, defaultNpcId, allowSingleNpcFallback = true }) {
  const text = String(content || "");
  const lowered = safeLower(text);

  // Heuristic 1: explicit prefix "NPCNAME:" or "NPCNAME,"
  for (const npc of npcs) {
    const name = String(npc?.displayName || "").trim();
    if (!name) continue;
    const nLower = safeLower(name);
    if (lowered.startsWith(nLower + ":") || lowered.startsWith(nLower + ",") || lowered.startsWith(nLower + " ")) {
      return npc;
    }
  }

  // Heuristic 2: includes exact NPC name
  for (const npc of npcs) {
    const name = String(npc?.displayName || "").trim();
    if (!name) continue;
    if (lowered.includes(safeLower(name))) return npc;
  }

  // Heuristic 3: default NPC
  if (defaultNpcId) {
    const byId = npcs.find((n) => String(n?.id) === String(defaultNpcId));
    if (byId) return byId;
  }

  // Heuristic 4: single NPC
  if (allowSingleNpcFallback && npcs.length === 1) return npcs[0];

  return null;
}

function actorSelectorForNpc(npc) {
  const actor = npc?.actor || {};
  const type = String(actor.type || "name").toLowerCase();
  const value = String(actor.value || "").trim();
  if (!value) return { actorId: "", actorName: "" };
  if (type === "id" || type === "actorid") return { actorId: value, actorName: "" };
  return { actorId: "", actorName: value };
}

function isLikelyFvttSystemMessage(content) {
  const text = String(content || "").replace(/\s+/g, " ").trim();
  if (!text) return true;
  const lower = text.toLowerCase();
  if (/^[+-]?\d+(?:[.,]\d+)?$/.test(text)) return true;

  if (lower.includes("hp updated")) return true;
  if (lower.includes("apply undo")) return true;
  if (lower.includes("calc x1")) return true;
  if (lower.includes("welcome to plutonium")) return true;
  if (lower.includes("saving throw")) return true;
  if (lower.includes("base damage")) return true;
  if (/\battack\b.*\b1d20\b/i.test(text)) return true;
  if (lower.includes("martial melee")) return true;
  if (lower.includes("equipped proficient")) return true;
  if (lower.includes("initiative")) return true;

  return false;
}

async function readMaybe(filePath) {
  const p = String(filePath || "").trim();
  if (!p) return "";
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return "";
  }
}

async function loadPersonaBundle(npc) {
  const docs = npc?.personaDocs || {};
  const files = [
    ["IDENTITY.md", docs.identity],
    ["SOUL.md", docs.soul],
    ["BEHAVIOR_RULES.md", docs.behavior],
    ["BATTLE_RULES.md", docs.battle],
    ["RELATIONS.md", docs.relations],
    ["MEMORY.md", docs.memory],
  ];

  const parts = [];
  for (const [label, filePath] of files) {
    const body = await readMaybe(filePath);
    if (!body.trim()) continue;
    parts.push(`[${label}]\n${body.trim()}`);
  }
  return parts.join("\n\n");
}

async function loadSharedWorldBundle(config) {
  const docs = config?.npc?.sharedDocs || {};
  const [worldBody, battleRulesBody] = await Promise.all([readMaybe(docs.world), readMaybe(docs.battleRules)]);
  const parts = [];
  if (String(worldBody || "").trim()) {
    parts.push(`[WORLD_LORE.md]\n${String(worldBody).trim()}`);
  }
  if (String(battleRulesBody || "").trim()) {
    parts.push(`[BATTLE_RULES_SHARED.md]\n${String(battleRulesBody).trim()}`);
  }
  return parts.join("\n\n");
}

async function loadNpcPromptDocs({ config, npc }) {
  const [sharedWorld, persona] = await Promise.all([loadSharedWorldBundle(config), loadPersonaBundle(npc)]);
  if (sharedWorld && persona) return `${sharedWorld}\n\n${persona}`;
  return sharedWorld || persona || "";
}

function isTargetChannel(message, channelName) {
  const wanted = safeLower(channelName);
  if (!wanted) return true;

  const name = message.channel?.name;
  if (name && safeLower(name) === wanted) return true;

  const parentName = message.channel?.parent?.name;
  if (parentName && safeLower(parentName) === wanted) return true;

  return false;
}

function stripBotMention(text, botUserId) {
  const raw = String(text || "");
  if (!botUserId) return raw.trim();
  return raw.replace(new RegExp(`<@!?${botUserId}>`, "g"), "").trim();
}

function formatSpellSlotKey(key) {
  const k = String(key || "").trim().toLowerCase();
  const m = k.match(/^spell(\d+)$/);
  if (m) return `Lv${m[1]}`;
  if (k === "pact") return "Pact";
  return k || "?";
}

function summarizeSpellSlots(slotsLike) {
  const slots = isPlainObject(slotsLike) ? slotsLike : {};
  const rows = Object.entries(slots)
    .map(([key, value]) => ({
      key: formatSpellSlotKey(key),
      rawKey: String(key || ""),
      value: Number(value?.value ?? 0),
      max: Number(value?.max ?? 0),
    }))
    .filter((row) => Number.isFinite(row.max) && row.max > 0 && Number.isFinite(row.value))
    .sort((a, b) => String(a.rawKey).localeCompare(String(b.rawKey), "en"));
  if (!rows.length) return "- spell slots: none";
  return `- spell slots: ${rows.map((r) => `${r.key} ${r.value}/${r.max}`).join(", ")}`;
}

function summarizePreparedSpells(spellsLike) {
  const spells = ensureArray(spellsLike)
    .map((s) => ({
      name: String(s?.name || "").trim(),
      level: Number(s?.level ?? 0),
      prepared: Boolean(s?.prepared),
      range: String(s?.range || "").trim(),
    }))
    .filter((s) => s.name);
  if (!spells.length) return ["- prepared spells: none"];

  const prepared = spells
    .filter((s) => s.prepared || s.level === 0)
    .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name, "ko"));
  if (!prepared.length) return ["- prepared spells: none"];

  return prepared.slice(0, 14).map((s) => {
    const rangeText = s.range ? ` range=${s.range}` : "";
    return `- spell: Lv${s.level} ${s.name}${rangeText}`;
  });
}

function summarizeInventoryItems(inventoryLike) {
  const items = ensureArray(inventoryLike)
    .map((item) => ({
      name: String(item?.name || "").trim(),
      type: String(item?.type || "").trim(),
      quantity: Number(item?.quantity ?? 1),
      equipped: Boolean(item?.equipped),
    }))
    .filter((item) => item.name);
  if (!items.length) return ["- inventory: none"];

  const equippedFirst = items.sort((a, b) => {
    if (a.equipped !== b.equipped) return a.equipped ? -1 : 1;
    return a.name.localeCompare(b.name, "ko");
  });
  return equippedFirst.slice(0, 16).map((item) => {
    const eq = item.equipped ? "equipped" : "bag";
    const qty = Number.isFinite(item.quantity) ? item.quantity : 1;
    return `- item: ${item.name} [${item.type || "item"}] x${qty} (${eq})`;
  });
}

function summarizeActionCatalog(actionsLike) {
  const actions = ensureArray(actionsLike)
    .map((action) => ({
      name: String(action?.name || "").trim(),
      type: String(action?.type || "").trim(),
      activation: String(action?.activation || "").trim(),
      actionType: String(action?.actionType || "").trim(),
      range: String(action?.range || "").trim(),
    }))
    .filter((action) => action.name);
  if (!actions.length) return ["- actions: none"];

  return actions.slice(0, 20).map((action) => {
    const tags = [action.type, action.activation, action.actionType].filter(Boolean).join("/");
    const range = action.range ? ` range=${action.range}` : "";
    return `- action: ${action.name}${tags ? ` [${tags}]` : ""}${range}`;
  });
}

function summarizeCurrentTargets(targetsLike) {
  const targets = ensureArray(targetsLike)
    .map((target) => ({
      id: String(target?.id || "").trim(),
      name: String(target?.name || "").trim(),
      distanceFt: Number(target?.distanceFt),
      orthDistanceFt: Number(target?.orthDistanceFt),
      hp: isPlainObject(target?.hp) ? target.hp : {},
      inCombat: target?.inCombat,
      defeated: Boolean(target?.defeated),
      isDeadLike: Boolean(target?.isDeadLike),
      conditions: isPlainObject(target?.conditions) ? target.conditions : {},
    }))
    .filter((target) => target.id || target.name);
  if (!targets.length) return ["- selected targets: none"];

  return targets.slice(0, 8).map((target) => {
    const id = target.id || "?";
    const name = target.name || id;
    const dist =
      Number.isFinite(target.orthDistanceFt)
        ? `${target.orthDistanceFt}ft(orth)`
        : Number.isFinite(target.distanceFt)
          ? `${target.distanceFt}ft`
          : "?ft";
    const hpText = formatTokenHpText(target);
    const stateText = describeTokenState(target);
    return `- target: ${name} (${id}) dist=${dist} hp=${hpText} state=${stateText}`;
  });
}

function formatTokenHpText(tokenLike) {
  const hp = isPlainObject(tokenLike?.hp) ? tokenLike.hp : {};
  const value = Number(hp.value);
  const max = Number(hp.max);
  const temp = Number(hp.temp ?? 0);
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return "?/?";
  return `${value}/${max}${Number.isFinite(temp) && temp > 0 ? `(+${temp})` : ""}`;
}

function buildTokenStateFlags(tokenLike) {
  const flags = [];
  const conditions = isPlainObject(tokenLike?.conditions) ? tokenLike.conditions : {};
  if (isTokenDeadLike(tokenLike)) {
    flags.push("deadlike");
  }
  if (conditions.unconscious) flags.push("unconscious");
  if (conditions.concentrating) flags.push("concentrating");
  if (conditions.bleeding) flags.push("bleeding");
  if (tokenLike?.inCombat === true) flags.push("in-combat");
  if (tokenLike?.inCombat === false) flags.push("out-of-combat");
  return flags;
}

function describeTokenState(tokenLike) {
  const flags = buildTokenStateFlags(tokenLike);
  return flags.length ? flags.join(",") : "normal";
}

function isTokenDeadLike(tokenLike) {
  if (!tokenLike || typeof tokenLike !== "object") return false;
  if (Boolean(tokenLike.isDeadLike) || Boolean(tokenLike.defeated)) return true;
  const conditions = isPlainObject(tokenLike.conditions) ? tokenLike.conditions : {};
  if (conditions.dead) return true;
  const hpValue = Number(tokenLike?.hp?.value);
  return Number.isFinite(hpValue) && hpValue <= 0;
}

function isCombatActiveInSceneContext(sceneContext) {
  const combat = sceneContext?.scene?.combat;
  if (!isPlainObject(combat)) return false;
  return !Boolean(combat.ended) && (Boolean(combat.active) || Boolean(combat.started));
}

function isTokenSelectableTarget(tokenLike, sceneContext, selfTokenId = "") {
  const id = String(tokenLike?.id || "").trim();
  if (!id) return false;
  if (selfTokenId && id === selfTokenId) return false;
  if (Boolean(tokenLike?.hidden)) return false;
  if (isTokenDeadLike(tokenLike)) return false;
  if (isCombatActiveInSceneContext(sceneContext) && tokenLike?.inCombat !== true) return false;
  return true;
}

function parseDirectionFromText(text) {
  const raw = String(text || "").toLowerCase();
  if (!raw) return null;

  if (/\bne\b|northeast|north-east|북동|우상|오른쪽\s*위/.test(raw)) return "NE";
  if (/\bnw\b|northwest|north-west|북서|좌상|왼쪽\s*위/.test(raw)) return "NW";
  if (/\bse\b|southeast|south-east|남동|우하|오른쪽\s*아래/.test(raw)) return "SE";
  if (/\bsw\b|southwest|south-west|남서|좌하|왼쪽\s*아래/.test(raw)) return "SW";
  if (/\bn\b|\bnorth\b|북|위쪽|위로/.test(raw)) return "N";
  if (/\bs\b|\bsouth\b|남|아래쪽|아래로/.test(raw)) return "S";
  if (/\be\b|\beast\b|동|오른쪽|우측/.test(raw)) return "E";
  if (/\bw\b|\bwest\b|서|왼쪽|좌측/.test(raw)) return "W";
  return null;
}

function parseMoveAmountFromText(text) {
  const raw = String(text || "").toLowerCase();
  if (!raw) return { amount: null, unit: null };

  const ft = raw.match(/(\d+(?:\.\d+)?)\s*(ft|feet|피트|자|m)/i);
  if (ft) {
    const amount = Number(ft[1]);
    if (Number.isFinite(amount) && amount > 0) {
      // Treat m as ft-equivalent in current dnd grid context unless user reconfigures.
      return { amount, unit: "ft" };
    }
  }

  const cell = raw.match(/(\d+(?:\.\d+)?)\s*(칸|cell|cells|grid)/i);
  if (cell) {
    const amount = Number(cell[1]);
    if (Number.isFinite(amount) && amount > 0) return { amount, unit: "grid" };
  }

  return { amount: null, unit: null };
}

function isLikelyMoveRequest(text) {
  const raw = String(text || "").toLowerCase();
  if (!raw) return false;
  return /(이동|움직|다가가|붙어|접근|가줘|가라|포지션|자리)/.test(raw);
}

function isLikelyActionRequest(text) {
  const raw = String(text || "").toLowerCase();
  if (!raw) return false;
  return /(공격|때려|쳐|쏴|시전|주문|cast|use|사용)/.test(raw);
}

function findMentionedTokenByName(sceneContext, text) {
  const raw = String(text || "").toLowerCase();
  if (!raw) return null;
  const selfTokenId = String(sceneContext?.actorToken?.id || "").trim();
  const tokens = ensureArray(sceneContext?.tokens)
    .map((token) => ({
      id: String(token?.id || "").trim(),
      name: String(token?.name || "").trim(),
      dxCells: Number(token?.dxCells),
      dyCells: Number(token?.dyCells),
      orthDistanceFt: Number(token?.orthDistanceFt),
      distanceFt: Number(token?.distanceFt),
      hidden: Boolean(token?.hidden),
      inCombat: token?.inCombat,
      defeated: Boolean(token?.defeated),
      isDeadLike: Boolean(token?.isDeadLike),
      hp: isPlainObject(token?.hp) ? token.hp : {},
      conditions: isPlainObject(token?.conditions) ? token.conditions : {},
    }))
    .filter((token) => token.id && token.name)
    .filter((token) => isTokenSelectableTarget(token, sceneContext, selfTokenId));

  if (!tokens.length) return null;

  function tokenAliases(name) {
    const base = String(name || "").trim().toLowerCase();
    if (!base) return [];
    const parts = base
      .split(/[\s\-_/]+/)
      .map((v) => v.trim())
      .filter(Boolean);
    return Array.from(new Set([base, ...parts.filter((p) => p.length >= 2)]));
  }

  function matchesAlias(alias) {
    if (!alias) return false;
    if (raw.includes(alias)) return true;
    // tolerate Korean particles (e.g., 딘한테 / 딘에게 / 딘을)
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const particle = "(은|는|이|가|을|를|에|에서|로|으로|에게|한테|랑|과|와)?";
    const re = new RegExp(`${escaped}${particle}`, "i");
    return re.test(raw);
  }

  const scored = [];
  for (const token of tokens) {
    const aliases = tokenAliases(token.name);
    let score = -1;
    for (const alias of aliases) {
      if (!matchesAlias(alias)) continue;
      score = Math.max(score, alias.length);
    }
    if (score < 0) continue;
    scored.push({ token, score });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  return scored[0].token;
}

function collectMentionedSceneTokens({ text, sceneTokens, limit = 4 }) {
  const tokens = ensureArray(sceneTokens).map((token) => ({
    id: String(token?.id || "").trim(),
    name: String(token?.name || "").trim(),
    actorName: String(token?.actorName || "").trim(),
  }));
  if (!tokens.length) return [];

  const hit = findMentionedTokenByName({ tokens }, text);
  if (!hit?.id) return [];

  const exact = tokens.find((token) => token.id === hit.id) || hit;
  return [
    {
      id: String(exact.id || "").trim(),
      name: String(exact.name || "").trim(),
      actorName: String(exact.actorName || "").trim(),
    },
  ]
    .filter((token) => token.id && token.name)
    .slice(0, Math.max(1, Number(limit) || 1));
}

function buildNameAliases(name) {
  const base = String(name || "").trim().toLowerCase();
  if (!base) return [];
  const parts = base
    .split(/[\s\-_/]+/)
    .map((v) => v.trim())
    .filter(Boolean);
  return Array.from(new Set([base, ...parts.filter((p) => p.length >= 2)]));
}

function findTokenBySpeakerHint(sceneContext, speakerHint) {
  const raw = String(speakerHint || "").trim();
  if (!raw) return null;

  const rawLower = raw.toLowerCase();
  const hintKey = normalizeTokenKey(rawLower);
  if (!hintKey) return null;

  const pools = [ensureArray(sceneContext?.tokens), ensureArray(sceneContext?.targets)];
  const candidates = [];

  for (const pool of pools) {
    for (const token of pool) {
      const id = String(token?.id || "").trim();
      const name = String(token?.name || "").trim();
      const actorName = String(token?.actorName || "").trim();
      if (!id && !name && !actorName) continue;

      const names = [name, actorName].filter(Boolean);
      let score = 0;
      for (const n of names) {
        const aliases = buildNameAliases(n);
        for (const alias of aliases) {
          const aliasKey = normalizeTokenKey(alias);
          if (!aliasKey) continue;
          if (aliasKey === hintKey) {
            score = Math.max(score, 10_000);
            continue;
          }
          if (aliasKey.startsWith(hintKey) || hintKey.startsWith(aliasKey)) {
            score = Math.max(score, 9_000);
            continue;
          }
          if (aliasKey.includes(hintKey) || hintKey.includes(aliasKey)) {
            score = Math.max(score, 8_000);
            continue;
          }
          if (rawLower.includes(alias)) {
            score = Math.max(score, 7_000);
            continue;
          }
        }
      }
      if (!score) continue;

      candidates.push({
        token,
        score,
        orthDistanceFt: Number(token?.orthDistanceFt),
        distanceFt: Number(token?.distanceFt),
      });
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const ao = Number.isFinite(a.orthDistanceFt) ? a.orthDistanceFt : Number.POSITIVE_INFINITY;
    const bo = Number.isFinite(b.orthDistanceFt) ? b.orthDistanceFt : Number.POSITIVE_INFINITY;
    if (ao !== bo) return ao - bo;
    const ad = Number.isFinite(a.distanceFt) ? a.distanceFt : Number.POSITIVE_INFINITY;
    const bd = Number.isFinite(b.distanceFt) ? b.distanceFt : Number.POSITIVE_INFINITY;
    if (ad !== bd) return ad - bd;
    return String(a.token?.name || "").localeCompare(String(b.token?.name || ""), "ko");
  });
  return candidates[0]?.token || null;
}

function evaluateNpcReactionDistance({
  npc,
  sceneContext,
  text,
  speakerHint,
  preferSpeaker = true,
  allowTextFallback = true,
} = {}) {
  const minFtRaw = Number(npc?.triggers?.minFt);
  const maxFtRaw = Number(npc?.triggers?.maxFt);
  const minFt = Number.isFinite(minFtRaw) ? Math.max(0, minFtRaw) : 0;
  const maxFt = Number.isFinite(maxFtRaw) ? Math.max(0, maxFtRaw) : 0;

  if (!(maxFt > 0)) {
    return { enabled: false, allowed: true, reason: "distance-disabled", minFt, maxFt };
  }

  if (!sceneContext?.ok) {
    return { enabled: true, allowed: true, reason: "scene-unavailable", minFt, maxFt };
  }

  const sourceCandidates = [];
  if (preferSpeaker) {
    sourceCandidates.push({
      source: "speaker",
      token: findTokenBySpeakerHint(sceneContext, speakerHint),
    });
    if (allowTextFallback) {
      sourceCandidates.push({
        source: "text-mention",
        token: findMentionedTokenByName(sceneContext, text),
      });
    }
  } else {
    if (allowTextFallback) {
      sourceCandidates.push({
        source: "text-mention",
        token: findMentionedTokenByName(sceneContext, text),
      });
    }
    sourceCandidates.push({
      source: "speaker",
      token: findTokenBySpeakerHint(sceneContext, speakerHint),
    });
  }

  const picked = sourceCandidates.find((row) => row?.token && (row.token.id || row.token.name));
  if (!picked) {
    return { enabled: true, allowed: false, reason: "source-not-found", minFt, maxFt };
  }

  const distOrth = Number(picked.token?.orthDistanceFt);
  const dist = Number.isFinite(distOrth) ? distOrth : Number(picked.token?.distanceFt);
  if (!Number.isFinite(dist)) {
    return {
      enabled: true,
      allowed: false,
      reason: "distance-unknown",
      minFt,
      maxFt,
      source: picked.source,
      sourceTokenId: String(picked.token?.id || ""),
      sourceTokenName: String(picked.token?.name || ""),
    };
  }

  const allowed = dist <= maxFt && dist >= minFt;
  return {
    enabled: true,
    allowed,
    reason: allowed ? "in-range" : dist > maxFt ? "too-far" : "too-close",
    minFt,
    maxFt,
    distanceFt: dist,
    source: picked.source,
    sourceTokenId: String(picked.token?.id || ""),
    sourceTokenName: String(picked.token?.name || ""),
  };
}

function findTokenByRefInSceneContext(sceneContext, tokenRef) {
  const raw = String(tokenRef || "").trim();
  if (!raw) return null;
  const key = normalizeTokenKey(raw);
  if (!key) return null;

  const candidates = [];
  const pools = [ensureArray(sceneContext?.targets), ensureArray(sceneContext?.tokens)];
  for (const pool of pools) {
    for (const token of pool) {
      const id = String(token?.id || "").trim();
      const name = String(token?.name || "").trim();
      if (!id && !name) continue;
      const idKey = normalizeTokenKey(id);
      const nameKey = normalizeTokenKey(name);

      let score = 0;
      if (id && raw === id) score = 10_000;
      else if (idKey && idKey === key) score = 9_000;
      else if (nameKey && nameKey === key) score = 8_000;
      else if (nameKey && nameKey.startsWith(key)) score = 7_000;
      else if (nameKey && nameKey.includes(key)) score = 6_000;

      if (!score) continue;
      candidates.push({
        token,
        score,
        orthDistanceFt: Number(token?.orthDistanceFt),
        distanceFt: Number(token?.distanceFt),
      });
    }
  }
  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const ao = Number.isFinite(a.orthDistanceFt) ? a.orthDistanceFt : Number.POSITIVE_INFINITY;
    const bo = Number.isFinite(b.orthDistanceFt) ? b.orthDistanceFt : Number.POSITIVE_INFINITY;
    if (ao !== bo) return ao - bo;
    const ad = Number.isFinite(a.distanceFt) ? a.distanceFt : Number.POSITIVE_INFINITY;
    const bd = Number.isFinite(b.distanceFt) ? b.distanceFt : Number.POSITIVE_INFINITY;
    if (ad !== bd) return ad - bd;
    return String(a.token?.name || "").localeCompare(String(b.token?.name || ""), "ko");
  });
  return candidates[0].token || null;
}

function directionFromDelta(dxCells, dyCells) {
  const dx = Number(dxCells);
  const dy = Number(dyCells);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  const sx = dx === 0 ? 0 : dx > 0 ? 1 : -1;
  const sy = dy === 0 ? 0 : dy > 0 ? 1 : -1;
  if (sx === 0 && sy === 0) return null;
  if (sx === 1 && sy === 1) return "SE";
  if (sx === 1 && sy === -1) return "NE";
  if (sx === -1 && sy === 1) return "SW";
  if (sx === -1 && sy === -1) return "NW";
  if (sx === 1) return "E";
  if (sx === -1) return "W";
  if (sy === 1) return "S";
  return "N";
}

function inferFallbackIntentFromText({ text, sceneContext }) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const mentioned = findMentionedTokenByName(sceneContext, raw);
  const direction = parseDirectionFromText(raw);
  const amountUnit = parseMoveAmountFromText(raw);

  if (isLikelyMoveRequest(raw)) {
    const args = {};
    if (direction) args.direction = direction;
    if (amountUnit.amount !== null) args.amount = amountUnit.amount;
    if (amountUnit.unit) args.unit = amountUnit.unit;
    if (mentioned?.id) args.targetTokenRef = mentioned.id;

    // If user asks to "stick/approach" target, runtime will derive direction from token delta.
    if (mentioned?.id && /(붙어|다가가|접근|근처|옆)/.test(raw.toLowerCase())) {
      if (!args.direction) args.direction = null;
      if (!Number.isFinite(Number(args.amount))) {
        args.amount = Number.isFinite(mentioned?.orthDistanceFt)
          ? Math.max(1, Math.round(Number(mentioned.orthDistanceFt) / 5))
          : null;
      }
      if (!args.unit) args.unit = "grid";
    }

    if (!args.direction && mentioned && Number.isFinite(mentioned.dxCells) && Number.isFinite(mentioned.dyCells)) {
      args.direction = directionFromDelta(mentioned.dxCells, mentioned.dyCells);
    }
    if (!Number.isFinite(Number(args.amount)) || Number(args.amount) <= 0) {
      args.amount = 1;
    }
    if (!args.unit) args.unit = "grid";

    return { type: "move", args };
  }

  if (isLikelyActionRequest(raw) && mentioned?.id) {
    const actionName = /(시전|주문|cast)/i.test(raw) ? "주문" : "공격";
    return { type: "action", args: { actionName, targetTokenRef: mentioned.id } };
  }

  return null;
}

function normalizeDirection(raw) {
  const key = String(raw || "")
    .trim()
    .toUpperCase();
  const table = {
    N: "N",
    S: "S",
    E: "E",
    W: "W",
    NE: "NE",
    NW: "NW",
    SE: "SE",
    SW: "SW",
  };
  return table[key] || null;
}

function toPositiveNumber(raw, fallback) {
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallback;
}

function normalizeAoeSpec(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const shapeRaw = String(source.shape || source.areaShape || source.form || "circle")
    .trim()
    .toLowerCase();
  const shape =
    shapeRaw === "cone" ? "cone" : shapeRaw === "line" || shapeRaw === "ray" ? "line" : "circle";

  const normalized = {
    shape,
    radiusFt: toPositiveNumber(source.radiusFt ?? source.radius ?? source.distanceFt, 15),
    lengthFt: toPositiveNumber(source.lengthFt ?? source.distanceFt ?? source.radiusFt ?? source.radius, 15),
    widthFt: toPositiveNumber(source.widthFt ?? source.width, 5),
    angleDeg: Math.max(1, Math.min(360, toPositiveNumber(source.angleDeg ?? source.angle, 60))),
    centerTokenRef: String(
      source.centerTokenRef || source.centerTargetRef || source.centerTarget || source.targetTokenRef || ""
    ).trim() || null,
    direction: String(source.direction || "").trim() || null,
    includeSelf: Boolean(source.includeSelf),
    includeHostileOnly: Boolean(source.includeHostileOnly),
    placeTemplate: source.placeTemplate !== false,
  };

  const centerX = Number(source.centerX);
  const centerY = Number(source.centerY);
  if (Number.isFinite(centerX) && Number.isFinite(centerY)) {
    normalized.centerX = centerX;
    normalized.centerY = centerY;
  }

  return normalized;
}

function normalizeActionTag(plan, depth = 0) {
  if (depth > 3) return { type: "none" };

  const normalizeSequence = (rawSteps) => {
    const steps = Array.isArray(rawSteps)
      ? rawSteps
          .map((step) => normalizeActionTag(step, depth + 1))
          .filter((step) => step.type !== "none")
          .slice(0, 10)
      : [];
    if (!steps.length) return { type: "none" };
    if (steps.length === 1) return steps[0];

    if (
      steps.length === 2 &&
      steps[0].type === "targetset" &&
      (steps[1].type === "action" || steps[1].type === "tokenaction")
    ) {
      const second = { ...steps[1] };
      if (!second.targetRef && steps[0].tokenRef) {
        second.targetRef = steps[0].tokenRef;
      }
      return second;
    }

    return { type: "sequence", steps };
  };

  if (Array.isArray(plan)) {
    return normalizeSequence(plan);
  }

  if (!plan || typeof plan !== "object") return { type: "none" };

  const type = String(plan.type || "").trim().toLowerCase();
  if ((!type || type === "actions" || type === "list") && Array.isArray(plan.steps)) {
    return normalizeSequence(plan.steps);
  }
  if ((!type || type === "actions" || type === "list") && Array.isArray(plan.actions)) {
    return normalizeSequence(plan.actions);
  }
  if (!type || type === "none") return { type: "none" };

  if (type === "sequence") {
    return normalizeSequence(plan.steps);
  }

  if (type === "move") {
    const direction = normalizeDirection(plan.direction);
    if (!direction) return { type: "none" };
    const amount = Number(plan.amount);
    return {
      type: "move",
      move: {
        type: "move",
        direction,
        amount: Number.isFinite(amount) && amount > 0 ? amount : 1,
        unit: String(plan.unit || "grid").toLowerCase() === "ft" ? "ft" : "grid",
        maxRequested: false,
        difficult: Boolean(plan.difficult),
        raw: "llm-tag-move",
      },
    };
  }

  if (type === "tokenmove") {
    const direction = normalizeDirection(plan.direction);
    const tokenRef = String(plan.tokenRef || "").trim();
    if (!direction || !tokenRef) return { type: "none" };
    const amount = Number(plan.amount);
    return {
      type: "tokenmove",
      tokenRef,
      move: {
        type: "move",
        direction,
        amount: Number.isFinite(amount) && amount > 0 ? amount : 1,
        unit: String(plan.unit || "grid").toLowerCase() === "ft" ? "ft" : "grid",
        maxRequested: false,
        difficult: Boolean(plan.difficult),
        raw: "llm-tag-token-move",
      },
    };
  }

  if (type === "targetset" || type === "target") {
    const tokenRef = String(
      plan.tokenRef ||
        plan.targetRef ||
        plan.targetTokenRef ||
        plan.targetTokenId ||
        plan.targetId ||
        plan.targetName ||
        ""
    ).trim();
    if (!tokenRef) return { type: "none" };
    return { type: "targetset", tokenRef };
  }

  if (type === "targetclear") {
    return { type: "targetclear" };
  }

  if (type === "action") {
    const actionName = String(plan.actionName || "").trim();
    if (!actionName) return { type: "none" };
    const targetRef =
      String(plan.targetRef || plan.targetTokenRef || plan.targetTokenId || plan.targetId || plan.targetName || "")
        .trim() || null;
    return { type: "action", actionName, targetRef };
  }

  if (type === "tokenaction") {
    const tokenRef = String(plan.tokenRef || "").trim();
    const actionName = String(plan.actionName || "").trim();
    if (!tokenRef || !actionName) return { type: "none" };
    const targetRef =
      String(plan.targetRef || plan.targetTokenRef || plan.targetTokenId || plan.targetId || plan.targetName || "")
        .trim() || null;
    return { type: "tokenaction", tokenRef, actionName, targetRef };
  }

  if (type === "aoe" || type === "aoeaction") {
    const actionName = String(plan.actionName || "").trim();
    if (!actionName) return { type: "none" };
    return {
      type: "aoe",
      actionName,
      aoe: normalizeAoeSpec(plan),
    };
  }

  if (type === "image" || type === "img" || type === "sdimage" || type === "generateimage") {
    const prompt =
      String(
        plan.prompt ||
          plan.extraPrompt ||
          plan.promptText ||
          plan.tags ||
          plan.text ||
          plan.description ||
          ""
      ).trim() || "";
    const reason = String(plan.reason || plan.trigger || plan.context || "").trim() || "";
    return {
      type: "image",
      prompt,
      reason,
    };
  }

  return { type: "none" };
}

function extractFvttActionTags(rawText) {
  const text = String(rawText || "");
  const regex = /\[\[FVTT_ACTION\s+([\s\S]*?)\s*\]\]/gi;

  const actionJsons = [];
  let match = null;
  while ((match = regex.exec(text)) !== null) {
    actionJsons.push(String(match[1] || "").trim());
  }

  const visibleText = text.replace(regex, "").trim();
  if (!actionJsons.length) {
    return {
      visibleText,
      hadTag: false,
      hadExplicitNone: false,
      actions: [],
      parseErrors: [],
    };
  }

  const actions = [];
  const parseErrors = [];
  let hadExplicitNone = false;
  for (const actionJson of actionJsons) {
    try {
      const parsed = JSON.parse(actionJson);
      const rawType = String(parsed?.type || "").trim().toLowerCase();
      const normalized = normalizeActionTag(parsed);
      if (normalized.type === "none") {
        if (rawType === "none") {
          hadExplicitNone = true;
        } else {
          parseErrors.push(`ignored invalid FVTT_ACTION tag type: ${rawType || "(missing)"}`);
        }
        continue;
      }
      actions.push(normalized);
    } catch (e) {
      parseErrors.push(String(e?.message || e || "unknown parse error"));
    }
  }

  return {
    visibleText,
    hadTag: true,
    hadExplicitNone,
    actions,
    parseErrors,
  };
}

function actionTagToIntentSteps(actionTag) {
  const action = actionTag && typeof actionTag === "object" ? actionTag : { type: "none" };
  const type = String(action.type || "none").toLowerCase();
  if (type === "none") return [];

  if (type === "sequence") {
    const steps = [];
    for (const child of Array.isArray(action.steps) ? action.steps : []) {
      steps.push(...actionTagToIntentSteps(child));
    }
    return steps.slice(0, 10);
  }

  if (type === "move") {
    const move = action.move || {};
    return [
      {
        type: "move",
        args: {
          direction: String(move.direction || "").toUpperCase(),
          amount: Number(move.amount || 1),
          unit: String(move.unit || "grid").toLowerCase() === "ft" ? "ft" : "grid",
          difficult: Boolean(move.difficult),
        },
      },
    ];
  }

  if (type === "tokenmove") {
    const move = action.move || {};
    const tokenRef = String(action.tokenRef || "").trim();
    if (!tokenRef) return [];
    return [
      {
        type: "tokenmove",
        args: {
          tokenRef,
          direction: String(move.direction || "").toUpperCase(),
          amount: Number(move.amount || 1),
          unit: String(move.unit || "grid").toLowerCase() === "ft" ? "ft" : "grid",
          difficult: Boolean(move.difficult),
        },
      },
    ];
  }

  if (type === "targetset") {
    const tokenRef = String(action.tokenRef || "").trim();
    if (!tokenRef) return [];
    return [{ type: "targetset", args: { tokenRef } }];
  }

  if (type === "targetclear") {
    return [{ type: "targetclear", args: {} }];
  }

  if (type === "action") {
    const actionName = String(action.actionName || "").trim();
    if (!actionName) return [];
    const targetTokenRef = String(action.targetRef || "").trim() || null;
    return [{ type: "action", args: { actionName, targetTokenRef } }];
  }

  if (type === "tokenaction") {
    const tokenRef = String(action.tokenRef || "").trim();
    const actionName = String(action.actionName || "").trim();
    if (!tokenRef || !actionName) return [];
    const targetTokenRef = String(action.targetRef || "").trim() || null;
    return [{ type: "tokenaction", args: { tokenRef, actionName, targetTokenRef } }];
  }

  if (type === "aoe") {
    const actionName = String(action.actionName || "").trim();
    if (!actionName) return [];
    const aoe = normalizeAoeSpec(action.aoe || {});
    const args = {
      actionName,
      shape: aoe.shape,
      radiusFt: aoe.radiusFt,
      lengthFt: aoe.lengthFt,
      widthFt: aoe.widthFt,
      angleDeg: aoe.angleDeg,
      centerTokenRef: aoe.centerTokenRef,
      direction: aoe.direction,
      includeSelf: aoe.includeSelf,
      includeHostileOnly: aoe.includeHostileOnly,
      placeTemplate: aoe.placeTemplate,
    };
    if (Number.isFinite(Number(aoe.centerX)) && Number.isFinite(Number(aoe.centerY))) {
      args.centerX = Number(aoe.centerX);
      args.centerY = Number(aoe.centerY);
    }
    return [{ type: "aoe", args }];
  }

  if (type === "image") {
    return [
      {
        type: "image",
        args: {
          prompt: String(action.prompt || "").trim(),
          reason: String(action.reason || "").trim(),
        },
      },
    ];
  }

  return [];
}

function buildIntentFromActionTags(actions) {
  const steps = [];
  for (const action of Array.isArray(actions) ? actions : []) {
    steps.push(...actionTagToIntentSteps(action));
  }

  if (!steps.length) return { type: "none", args: {} };
  if (steps.length === 1) return steps[0];
  return {
    type: "plan",
    args: {
      steps: steps.slice(0, 10),
    },
  };
}

function pickNearestTokenFromSceneContext(sceneContext) {
  const selfTokenId = String(sceneContext?.actorToken?.id || "").trim();
  const tokens = ensureArray(sceneContext?.tokens)
    .map((token) => ({
      id: String(token?.id || "").trim(),
      name: String(token?.name || "").trim(),
      dxCells: Number(token?.dxCells),
      dyCells: Number(token?.dyCells),
      orthDistanceFt: Number(token?.orthDistanceFt),
      distanceFt: Number(token?.distanceFt),
      hidden: Boolean(token?.hidden),
      disposition: Number(token?.disposition),
      inCombat: token?.inCombat,
      defeated: Boolean(token?.defeated),
      isDeadLike: Boolean(token?.isDeadLike),
      hp: isPlainObject(token?.hp) ? token.hp : {},
      conditions: isPlainObject(token?.conditions) ? token.conditions : {},
    }))
    .filter((token) => isTokenSelectableTarget(token, sceneContext, selfTokenId));
  if (!tokens.length) return null;

  const hostiles = tokens.filter((token) => Number.isFinite(token.disposition) && token.disposition < 0);
  const pool = hostiles.length ? hostiles : tokens;
  pool.sort((a, b) => {
    const ao = Number.isFinite(a.orthDistanceFt) ? a.orthDistanceFt : Number.POSITIVE_INFINITY;
    const bo = Number.isFinite(b.orthDistanceFt) ? b.orthDistanceFt : Number.POSITIVE_INFINITY;
    if (ao !== bo) return ao - bo;
    const ad = Number.isFinite(a.distanceFt) ? a.distanceFt : Number.POSITIVE_INFINITY;
    const bd = Number.isFinite(b.distanceFt) ? b.distanceFt : Number.POSITIVE_INFINITY;
    if (ad !== bd) return ad - bd;
    return a.name.localeCompare(b.name, "ko");
  });
  return pool[0] || null;
}

function enrichMoveArgsFromText({ args, text, sceneContext }) {
  const out = isPlainObject(args) ? { ...args } : {};
  const raw = String(text || "");
  const mentioned = findMentionedTokenByName(sceneContext, raw);
  const nearest = pickNearestTokenFromSceneContext(sceneContext);
  const amountUnit = parseMoveAmountFromText(raw);
  const explicitDirection = parseDirectionFromText(raw);

  if (!out.targetTokenRef && mentioned?.id) out.targetTokenRef = mentioned.id;
  if (!out.targetTokenRef && /(붙어|다가가|접근|근처)/.test(raw.toLowerCase()) && nearest?.id) {
    out.targetTokenRef = nearest.id;
  }

  if (!out.direction && explicitDirection) out.direction = explicitDirection;
  if (
    !out.direction &&
    mentioned &&
    Number.isFinite(mentioned.dxCells) &&
    Number.isFinite(mentioned.dyCells)
  ) {
    out.direction = directionFromDelta(mentioned.dxCells, mentioned.dyCells);
  }
  if (
    !out.direction &&
    nearest &&
    Number.isFinite(nearest.dxCells) &&
    Number.isFinite(nearest.dyCells) &&
    /(붙어|다가가|접근|근처)/.test(raw.toLowerCase())
  ) {
    out.direction = directionFromDelta(nearest.dxCells, nearest.dyCells);
  }

  if (!Number.isFinite(Number(out.amount)) || Number(out.amount) <= 0) {
    if (amountUnit.amount !== null) {
      out.amount = amountUnit.amount;
    } else if (
      mentioned &&
      Number.isFinite(mentioned.orthDistanceFt) &&
      /(붙어|다가가|접근|근처)/.test(raw.toLowerCase())
    ) {
      out.amount = Math.max(1, Math.round(mentioned.orthDistanceFt / 5));
    } else {
      out.amount = 1;
    }
  }

  if (!out.unit) {
    if (amountUnit.unit) out.unit = amountUnit.unit;
    else out.unit = "grid";
  }

  return out;
}

function enrichActionArgsFromText({ args, text, sceneContext }) {
  const out = isPlainObject(args) ? { ...args } : {};
  const raw = String(text || "");
  const mentioned = findMentionedTokenByName(sceneContext, raw);
  const nearest = pickNearestTokenFromSceneContext(sceneContext);
  if (!out.targetTokenRef && mentioned?.id) out.targetTokenRef = mentioned.id;
  if (!out.targetTokenRef && nearest?.id) out.targetTokenRef = nearest.id;
  if (!out.actionName) {
    out.actionName = /(시전|주문|cast)/i.test(raw) ? "주문" : "공격";
  }
  return out;
}

function enrichAoeArgsFromText({ args, text, sceneContext }) {
  const out = isPlainObject(args) ? { ...args } : {};
  const raw = String(text || "");
  const mentioned = findMentionedTokenByName(sceneContext, raw);
  const nearest = pickNearestTokenFromSceneContext(sceneContext);

  if (!out.centerTokenRef && mentioned?.id) out.centerTokenRef = mentioned.id;
  if (!out.centerTokenRef && nearest?.id) out.centerTokenRef = nearest.id;
  if (!out.actionName) {
    out.actionName = /(섀터|shatter|thunderwave|burning hands|fireball|스펠|주문|시전)/i.test(raw)
      ? "주문"
      : "공격";
  }
  if (!out.shape) out.shape = "circle";
  return out;
}

function formatDetailedSceneContext(sceneContext) {
  if (!sceneContext || !sceneContext.ok) return [];

  const lines = [
    "Detailed scene context:",
    `- scene: ${sceneContext.scene?.name || "unknown"} (${sceneContext.scene?.id || "n/a"})`,
    `- map size: ${sceneContext.scene?.width || 0} x ${sceneContext.scene?.height || 0}`,
    `- grid: ${sceneContext.scene?.gridDistance || 5}${sceneContext.scene?.gridUnits || "ft"} per cell`,
    `- map image: ${sceneContext.scene?.backgroundSrc || "(none)"}`,
  ];

  if (sceneContext.scene?.description) {
    lines.push(`- scene notes: ${compact(sceneContext.scene.description, 280)}`);
  }

  if (sceneContext.actorToken) {
    lines.push(
      `- self token: ${sceneContext.actorToken.name} @ x=${sceneContext.actorToken.x}, y=${sceneContext.actorToken.y}`
    );
  } else if (sceneContext.actorTokenInOtherScene) {
    lines.push(
      `- self token in other scene: ${sceneContext.actorTokenInOtherScene.sceneName} / ${sceneContext.actorTokenInOtherScene.tokenName}`
    );
  } else {
    lines.push("- self token: not on this scene");
  }

  if (Array.isArray(sceneContext.targets) && sceneContext.targets.length) {
    lines.push(`- current targets: ${sceneContext.targets.map((target) => `${target.name}(${target.id})`).join(", ")}`);
  } else {
    lines.push("- current targets: (none)");
  }

  const tokens = Array.isArray(sceneContext.tokens) ? sceneContext.tokens.slice(0, 16) : [];
  if (tokens.length) {
    lines.push("- nearby tokens with stable refs:");
    for (const token of tokens) {
      const dist = Number.isFinite(token.distanceFt) ? `${token.distanceFt}ft` : "unknown";
      const orth = Number.isFinite(token.orthDistanceFt) ? `${token.orthDistanceFt}ft` : "unknown";
      const dx = Number.isFinite(token.dxCells) ? token.dxCells : "?";
      const dy = Number.isFinite(token.dyCells) ? token.dyCells : "?";
      const hpText = formatTokenHpText(token);
      const state = describeTokenState(token);
      lines.push(
        `  - ${token.name} (${token.id}) pos=${token.x},${token.y} dist=${dist} orth=${orth} delta=(${dx},${dy}) hp=${hpText} state=${state}`
      );
    }
  }

  return lines;
}

function summarizeActorConditionLines(actorSheet) {
  const conditions = isPlainObject(actorSheet?.actor?.conditions) ? actorSheet.actor.conditions : {};
  const flags = [];
  if (conditions.concentrating) flags.push("concentrating");
  if (conditions.bleeding) flags.push("bleeding");
  if (conditions.unconscious) flags.push("unconscious");
  if (conditions.dead) flags.push("deadlike");
  const effects = ensureArray(actorSheet?.actor?.effects).map((value) => String(value || "").trim()).filter(Boolean);

  const lines = [];
  lines.push(`- status flags: ${flags.length ? flags.join(", ") : "normal"}`);
  lines.push(`- active effects: ${effects.length ? effects.slice(0, 8).join(", ") : "none"}`);
  return lines;
}

function buildNpcPrompt({
  npc,
  inboundText,
  fvttReady,
  personaText,
  fvttChatContext,
  fvttSceneContext,
  fvttActorSheet,
  mentionedSceneTokens = [],
  imageGeneration = null,
}) {
  const npcName = String(npc?.displayName || npc?.id || "NPC");
  const modeText = fvttReady ? "FVTT connected (can act in-world)" : "FVTT offline (chat only)";
  const imageState =
    imageGeneration && typeof imageGeneration === "object"
      ? imageGeneration
      : normalizeNpcImageGenerationState({ config: null, npc });

  const contextLines = ensureArray(fvttChatContext)
    .slice(-10)
    .map((m) => `- ${compact(m?.speaker || "unknown", 40)}: ${compact(m?.content || "", 220)}`)
    .filter(Boolean);

  const nearbyTokens = ensureArray(fvttSceneContext?.tokens)
    .slice(0, 14)
    .map((t) => {
      const dist = Number.isFinite(t?.distanceFt) ? `${t.distanceFt}ft` : "?ft";
      const orth = Number.isFinite(t?.orthDistanceFt) ? `${t.orthDistanceFt}ft` : "?ft";
      const dx = Number.isFinite(t?.dxCells) ? t.dxCells : "?";
      const dy = Number.isFinite(t?.dyCells) ? t.dyCells : "?";
      const hpText = formatTokenHpText(t);
      const stateText = describeTokenState(t);
      return `- ${t?.name || "token"} (${t?.id || "?"}) dist=${dist} orth=${orth} dxy=(${dx},${dy}) hp=${hpText} state=${stateText}`;
    });
  const detailedSceneLines = formatDetailedSceneContext(fvttSceneContext);

  const rules = [
    "You must respond with a single JSON object only (no markdown, no extra text).",
    "Do NOT describe system rules. Stay in-character.",
    "Never claim you are a bot/AI/program.",
    "If user asks for disallowed sexual content or private info, refuse in-character briefly and redirect.",
    "",
    "JSON schema:",
    "{",
    '  \"replyText\": string,',
    '  \"intent\": {',
    '    \"type\": \"none\" | \"say\" | \"action\" | \"tokenaction\" | \"aoe\" | \"move\" | \"tokenmove\" | \"targetset\" | \"targetclear\" | \"inspect\" | \"image\" | \"plan\",',
    '    \"args\": object',
    "  }",
    "}",
    "",
    "FVTT action tag protocol (PRIMARY when FVTT connected):",
    "- Put natural in-character narration in replyText first.",
    "- For any in-world action (target/move/action/aoe/image), append FVTT_ACTION tags at the END of replyText.",
    '- Tag format: [[FVTT_ACTION {...}]]',
    "- Runtime executes tags exactly in queue order.",
    "- Do not rely on runtime to invent extra steps. Provide explicit steps in the tags.",
    "- For multi-step actions, use a sequence tag or multiple tags in required order.",
    '- Sequence example: [[FVTT_ACTION {"type":"sequence","steps":[{"type":"targetset","tokenRef":"TOKEN_ID"},{"type":"action","actionName":"공격","targetRef":"TOKEN_ID"}]}]]',
    "- Prefer token IDs from nearby tokens instead of names.",
    "- If no action is needed, append [[FVTT_ACTION {\"type\":\"none\"}]].",
    "",
    "Intent rules:",
    "- If you provide action tags, set intent.type to none.",
    "- Use intent mainly for say/inspect, or when tag generation is impossible.",
    "- If you use plan intent, include explicit ordered steps with complete args.",
    "- Keep plan short (max 4 steps).",
    "- For target, prefer token id from nearby tokens or selected targets if available.",
    "- For move intent, you may provide targetTokenRef with direction omitted; runtime will derive approach direction from token position.",
    "- Never emit move with both direction and targetTokenRef missing.",
    "- If you are asked to attack/cast but exact skill name is unclear, set actionName to a generic keyword like \"공격\" or \"주문\" and include targetTokenRef.",
    "- For area spells that need template placement (e.g., Shatter/Fireball), prefer aoe with centerTokenRef set to the intended token.",
    "- Runtime can auto-approach target range for action intent; avoid separate move intent unless user explicitly asks movement only.",
    "- If you need awareness before acting, include inspect step first (context/sheet).",
    "- You must use actor resources below (spell slots, prepared spells, inventory, actions).",
    "- Never choose leveled spells with empty slots. Prefer cantrip/weapon if slots are depleted.",
    "- During combat turns, respect action economy: at most one Action and one Bonus Action.",
    "- During combat turns, output an ordered action-set plan (max 4 steps) and keep only meaningful steps among say/move/action/bonus-action.",
    "- During combat turns, each step will be executed sequentially and only Action:ok advances to the next step.",
    "- Do not target creatures with HP 0, dead/defeated state, or targets not participating in active combat.",
    "- Reflect current HP and status effects in tone and tactical decisions.",
    "- Use image intent/tag only if image generation is enabled in the context section below.",
    "",
    "Supported intents:",
    "- say: { text }",
    "- inspect: { what: \"sheet\" | \"context\" | \"chatlog\" }",
    "- targetset: { tokenRef: string }",
    "- targetclear: {}",
    "- move: { direction?: \"N|S|E|W|NE|NW|SE|SW\", amount?: number, unit?: \"grid|ft\", difficult?: boolean, targetTokenRef?: string }",
    "- tokenmove: { tokenRef: string, direction: \"N|S|E|W|NE|NW|SE|SW\", amount?: number, unit?: \"grid|ft\", difficult?: boolean }",
    "- action: { actionName: string, targetTokenRef?: string }",
    "- tokenaction: { tokenRef: string, actionName: string, targetTokenRef?: string }",
    "- aoe: { actionName: string, shape: \"circle|cone|line\", radiusFt?: number, lengthFt?: number, widthFt?: number, angleDeg?: number, centerTokenRef?: string, direction?: string, includeSelf?: boolean, includeHostileOnly?: boolean, placeTemplate?: boolean, centerX?: number, centerY?: number }",
    "- image: { prompt?: string, reason?: string }",
    "- plan: { steps: [ {type,args}, ... ] }",
    "",
  ].join("\n");

  const parts = [
    `NPC: ${npcName}`,
    `Mode: ${modeText}`,
    "",
    "Inbound:",
    inboundText,
    "",
  ];

  if (personaText) {
    parts.push("Persona:", personaText, "");
  }

  if (imageState.enabled) {
    parts.push(
      "Image generation:",
      `- SD WebUI enabled for this NPC (size=${imageState.width}x${imageState.height})`,
      `- Default prompt: ${imageState.defaultPrompt || "(none)"}`,
      "- Use image tags sparingly (major emotion shift, battle start, dramatic scene transition).",
      "- Image prompt should reflect current HP/status effects/combat tension when relevant.",
      '- Example: [[FVTT_ACTION {"type":"image","prompt":"grim expression, rain, close-up portrait","reason":"battle start"}]]',
      "- At most one image tag per reply unless user explicitly asks for multiple images.",
      ""
    );
  } else if (imageState.configured) {
    parts.push(
      "Image generation:",
      "- SD WebUI is configured globally but disabled for this NPC. Do not emit image tags or image intent.",
      ""
    );
  } else {
    parts.push(
      "Image generation:",
      "- SD WebUI is not configured. Do not emit image tags or image intent.",
      ""
    );
  }

  if (fvttReady && contextLines.length) {
    parts.push("Recent FVTT chat:", ...contextLines, "");
  }

  if (fvttReady && fvttSceneContext?.ok) {
    const sceneSlots = fvttSceneContext?.spells?.slots || {};
    const sheetSlots = fvttActorSheet?.actor?.spellSlots || {};
    const slotLine = summarizeSpellSlots(Object.keys(sheetSlots).length ? sheetSlots : sceneSlots);

    const spellItems =
      ensureArray(fvttActorSheet?.actor?.spells?.items).length > 0
        ? ensureArray(fvttActorSheet?.actor?.spells?.items)
        : ensureArray(fvttSceneContext?.spells?.items);
    const preparedSpellLines = summarizePreparedSpells(spellItems);

    const inventoryItems =
      ensureArray(fvttSceneContext?.inventory?.items).length > 0
        ? ensureArray(fvttSceneContext?.inventory?.items)
        : ensureArray(fvttSceneContext?.inventory?.equipped);
    const inventoryLines = summarizeInventoryItems(inventoryItems);

    const actionLines = summarizeActionCatalog(fvttActorSheet?.actor?.actions);
    const targetLines = summarizeCurrentTargets(fvttSceneContext?.targets);

    const hp = fvttActorSheet?.actor?.hp || {};
    const hpLine =
      Number.isFinite(Number(hp.value)) && Number.isFinite(Number(hp.max))
        ? `- hp: ${Number(hp.value)}/${Number(hp.max)} temp=${Number(hp.temp ?? 0)}`
        : "- hp: unknown";
    const actorStatusLines = summarizeActorConditionLines(fvttActorSheet);
    const acLine = Number.isFinite(Number(fvttActorSheet?.actor?.ac))
      ? `- ac: ${Number(fvttActorSheet?.actor?.ac)}`
      : "- ac: unknown";
    const moveLine = Number.isFinite(Number(fvttActorSheet?.actor?.movement?.walk))
      ? `- walk speed: ${Number(fvttActorSheet?.actor?.movement?.walk)}ft`
      : Number.isFinite(Number(fvttSceneContext?.actorStats?.walkSpeedFt))
        ? `- walk speed: ${Number(fvttSceneContext?.actorStats?.walkSpeedFt)}ft`
        : "- walk speed: unknown";

    parts.push(
      "FVTT scene context:",
      `- scene: ${fvttSceneContext?.scene?.name || "unknown"}`,
      `- you: ${fvttSceneContext?.actorToken?.name || "(no token on scene)"}`,
      "",
      "Actor resources:",
      hpLine,
      ...actorStatusLines,
      acLine,
      moveLine,
      slotLine,
      ...preparedSpellLines,
      ...inventoryLines,
      ...actionLines,
      "",
      "Current targets:",
      ...targetLines,
      "",
      "Nearby tokens:",
      ...nearbyTokens,
      ""
    );

    if (Array.isArray(mentionedSceneTokens) && mentionedSceneTokens.length > 0) {
      const mentionLines = mentionedSceneTokens
        .slice(0, 8)
        .map((token) => {
          const id = String(token?.id || "").trim();
          const name = String(token?.name || "token").trim();
          const actorName = String(token?.actorName || "").trim();
          return `- ${name} (${id || "?"})${actorName ? ` actor=${actorName}` : ""}`;
        });
      parts.push("Mentioned tokens in current scene (high priority refs):", ...mentionLines, "");
    }

    if (detailedSceneLines.length) {
      parts.push(...detailedSceneLines, "");
    }
  }

  parts.push("Rules:", rules);
  return parts.join("\n");
}

function buildCombatTurnInboundText({ npcName, combatState, actorSheet, sceneContext } = {}) {
  const name = String(npcName || "NPC");
  const state = isPlainObject(combatState) ? combatState : {};
  const combat = isPlainObject(state?.combat) ? state.combat : {};
  const current = isPlainObject(state?.currentCombatant) ? state.currentCombatant : {};
  const hostiles = ensureArray(state?.nearbyHostiles)
    .filter((token) => !isTokenDeadLike(token))
    .filter((token) => !isCombatActiveInSceneContext(sceneContext) || token?.inCombat === true)
    .slice(0, 6);
  const hp = getActorHpSummary(actorSheet);
  const actorConditions = isPlainObject(actorSheet?.actor?.conditions) ? actorSheet.actor.conditions : {};
  const actorConditionFlags = [];
  if (actorConditions.concentrating) actorConditionFlags.push("concentrating");
  if (actorConditions.bleeding) actorConditionFlags.push("bleeding");
  if (actorConditions.unconscious) actorConditionFlags.push("unconscious");
  if (actorConditions.dead) actorConditionFlags.push("deadlike");

  const lines = [
    "[AUTO_COMBAT_TURN]",
    `지금은 ${name}의 전투 턴입니다.`,
    "이번 턴에 합법적이고 실행 가능한 행동을 반드시 수행하세요.",
    "replyText는 턴 대사 후보로 짧게 작성하세요 (1~2문장).",
    "가능하면 적을 지정하고 공격/주문을 사용하세요. 사거리 밖이면 먼저 이동 후 공격하세요.",
    "한 턴에 Action은 1회, Bonus Action은 1회만 사용하세요.",
    "HP 0이거나 dead/defeated 상태의 대상은 절대 공격하지 마세요.",
    "활성 전투 중에는 전투 참가자(in-combat)만 공격 대상으로 선택하세요.",
    "행동은 최대 4단계 액션 세트로 계획하세요: 대사(say), 이동(move), 행동(action), 보조행동(bonus-action).",
    "intent.type은 가능하면 plan을 사용하고, steps는 실제 실행 순서대로 작성하세요.",
    "각 단계는 이전 단계가 Action:ok일 때만 다음 단계로 진행됩니다.",
    "반드시 replyText 끝에 FVTT_ACTION 태그를 포함하세요.",
  ];

  if (Number.isFinite(hp.value) && Number.isFinite(hp.max) && hp.max > 0) {
    const percent = Math.round((hp.value / hp.max) * 100);
    lines.push(`- Self HP: ${hp.value}/${hp.max} (temp=${hp.temp}, ${percent}%, ${hp.condition})`);
  }
  lines.push(`- Self conditions: ${actorConditionFlags.length ? actorConditionFlags.join(", ") : "normal"}`);

  const round = Number(combat.round ?? state.round);
  const turn = Number(combat.turn ?? state.turn);
  if (Number.isFinite(round) && round > 0) lines.push(`- Round: ${round}`);
  if (Number.isFinite(turn) && turn >= 0) lines.push(`- Turn Index: ${turn}`);
  if (current.name || current.id) {
    lines.push(`- Current Combatant: ${String(current.name || current.id)}`);
  }

  if (hostiles.length > 0) {
    lines.push("- Nearby hostiles (valid attack candidates):");
    for (const hostile of hostiles) {
      const dist = Number.isFinite(Number(hostile?.distanceFt)) ? `${Number(hostile.distanceFt)}ft` : "?ft";
      const hpText = formatTokenHpText(hostile);
      const stateText = describeTokenState(hostile);
      lines.push(
        `  - ${String(hostile?.name || hostile?.id || "target")} (${String(hostile?.id || "?")}) dist=${dist} hp=${hpText} state=${stateText}`
      );
    }
  } else {
    lines.push("- Nearby hostiles (valid attack candidates): none");
  }

  lines.push('행동이 불가능하면 [[FVTT_ACTION {"type":"none"}]] 를 넣으세요.');
  return lines.join("\n");
}

function getActorHpSummary(actorSheet) {
  const hp = isPlainObject(actorSheet?.actor?.hp) ? actorSheet.actor.hp : {};
  const valueNum = Number(hp.value);
  const maxNum = Number(hp.max);
  const tempNum = Number(hp.temp ?? 0);
  const hasValue = Number.isFinite(valueNum);
  const hasMax = Number.isFinite(maxNum) && maxNum > 0;
  const ratio = hasValue && hasMax ? Math.max(0, Math.min(1, valueNum / maxNum)) : null;

  let condition = "unknown";
  if (ratio !== null) {
    if (ratio <= 0.2) condition = "critical";
    else if (ratio <= 0.45) condition = "wounded";
    else if (ratio <= 0.75) condition = "steady";
    else condition = "healthy";
  }

  return {
    value: hasValue ? valueNum : null,
    max: hasMax ? maxNum : null,
    temp: Number.isFinite(tempNum) ? tempNum : 0,
    ratio,
    condition,
  };
}

function buildImageSituationPrompt({ actorSheet, sceneContext, combatState } = {}) {
  const tags = [];
  const hp = getActorHpSummary(actorSheet);
  const conditions = isPlainObject(actorSheet?.actor?.conditions) ? actorSheet.actor.conditions : {};

  if (Number.isFinite(hp.ratio)) {
    if (hp.ratio <= 0.2) tags.push("badly wounded");
    else if (hp.ratio <= 0.45) tags.push("wounded");
    else if (hp.ratio >= 0.85) tags.push("battle-ready");
  }

  if (conditions.bleeding) tags.push("bleeding");
  if (conditions.concentrating) tags.push("maintaining magical concentration");
  if (conditions.unconscious || conditions.dead) tags.push("collapsed");

  const combatActive =
    Boolean(combatState?.inCombat) ||
    (isCombatActiveInSceneContext(sceneContext) && Boolean(sceneContext?.scene?.combat));
  if (combatActive) {
    tags.push("active battle");
  }

  const nearbyHostiles = ensureArray(combatState?.nearbyHostiles).filter((token) => !isTokenDeadLike(token));
  if (nearbyHostiles.length >= 3) tags.push("surrounded by enemies");
  else if (nearbyHostiles.length > 0) tags.push("enemy nearby");

  const effectTags = ensureArray(actorSheet?.actor?.effects)
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .slice(0, 2);
  for (const effect of effectTags) {
    tags.push(effect);
  }

  return tags.join(", ");
}

function buildCombatEndInboundText({ npcName, prevCombatState, combatState, actorSheet } = {}) {
  const name = String(npcName || "NPC");
  const prev = isPlainObject(prevCombatState) ? prevCombatState : {};
  const current = isPlainObject(combatState) ? combatState : {};
  const prevCombat = isPlainObject(prev?.combat) ? prev.combat : {};
  const hp = getActorHpSummary(actorSheet);
  const conditions = isPlainObject(actorSheet?.actor?.conditions) ? actorSheet.actor.conditions : {};
  const hostiles = ensureArray(current?.nearbyHostiles).filter((token) => !isTokenDeadLike(token)).slice(0, 4);

  const lines = [
    "[AUTO_COMBAT_END]",
    `${name}의 전투가 방금 종료되었습니다.`,
    "현재 HP 상태와 주변 위협 상황을 반영해서 전투 직후 짧은 대사만 하세요.",
    "replyText는 1~2문장으로 작성하고 FVTT_ACTION 태그는 넣지 마세요.",
  ];

  const prevRound = Number(prevCombat.round ?? prev.round);
  const prevTurn = Number(prevCombat.turn ?? prev.turn);
  const prevCombatId = String(prevCombat.id || prev.combatId || "").trim();
  if (prevCombatId) lines.push(`- Ended Combat Id: ${prevCombatId}`);
  if (Number.isFinite(prevRound) && prevRound > 0) lines.push(`- Ended Round: ${prevRound}`);
  if (Number.isFinite(prevTurn) && prevTurn >= 0) lines.push(`- Ended Turn Index: ${prevTurn}`);

  if (Number.isFinite(hp.value) && Number.isFinite(hp.max) && hp.max > 0) {
    const percent = Math.round((hp.value / hp.max) * 100);
    lines.push(`- HP: ${hp.value}/${hp.max} (temp=${hp.temp}, ${percent}%)`);
    lines.push(`- HP Condition: ${hp.condition}`);
  }
  const conditionFlags = [];
  if (conditions.concentrating) conditionFlags.push("concentrating");
  if (conditions.bleeding) conditionFlags.push("bleeding");
  if (conditions.unconscious) conditionFlags.push("unconscious");
  if (conditions.dead) conditionFlags.push("deadlike");
  lines.push(`- Status effects: ${conditionFlags.length ? conditionFlags.join(", ") : "normal"}`);

  if (hostiles.length > 0) {
    lines.push("- Nearby hostiles after combat:");
    for (const hostile of hostiles) {
      const dist = Number.isFinite(Number(hostile?.distanceFt)) ? `${Number(hostile.distanceFt)}ft` : "?ft";
      lines.push(`  - ${String(hostile?.name || hostile?.id || "target")} (${String(hostile?.id || "?")}) dist=${dist}`);
    }
  } else {
    lines.push("- Nearby hostiles after combat: none");
  }

  return lines.join("\n");
}

function buildCombatEndFallbackSpeech({ npcName, actorSheet, combatState } = {}) {
  const name = String(npcName || "NPC");
  const hp = getActorHpSummary(actorSheet);
  const conditions = isPlainObject(actorSheet?.actor?.conditions) ? actorSheet.actor.conditions : {};
  const hostileCount = ensureArray(combatState?.nearbyHostiles).filter((h) => Number(h?.disposition) < 0).length;
  if (conditions.dead || conditions.unconscious) return `${name}는 의식을 잃은 듯 휘청이며 제대로 말을 잇지 못한다.`;
  if (conditions.bleeding) return `${name}는 흘러내리는 피를 지혈하며 거칠게 숨을 고른다.`;
  if (Number.isFinite(hp.ratio)) {
    if (hp.ratio <= 0.2) return `${name}는 비틀거리며 상처를 부여잡고 거친 숨을 몰아쉰다.`;
    if (hp.ratio <= 0.45) return `${name}는 피 묻은 장비를 정리하며 전열을 다시 가다듬는다.`;
    if (hp.ratio <= 0.75) return `${name}는 숨을 고르며 주변을 빠르게 훑어본다.`;
  }
  if (conditions.concentrating) return `${name}는 주문의 흐름을 붙잡은 채 주변 위협을 조심스럽게 살핀다.`;
  if (hostileCount > 0) return `${name}는 경계를 풀지 않고 남은 위협이 있는지 주시한다.`;
  return `${name}는 짧게 숨을 고르고 전투가 끝난 자리를 정리한다.`;
}

function normalizeIntent(output) {
  const root = isPlainObject(output) ? output : {};
  const replyText = String(root.replyText || "").trim();
  const intentRoot = isPlainObject(root.intent) ? root.intent : { type: "none", args: {} };
  const type = String(intentRoot.type || "none").trim().toLowerCase();
  const args = isPlainObject(intentRoot.args) ? intentRoot.args : {};

  const allowed = new Set([
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
    "image",
    "plan",
  ]);
  const normType = allowed.has(type) ? type : "none";
  if (normType === "plan") {
    const stepsRaw = Array.isArray(args.steps) ? args.steps : [];
    const steps = stepsRaw
      .map((step) => {
        const stepType = String(step?.type || "").trim().toLowerCase();
        const stepArgs = isPlainObject(step?.args)
          ? step.args
          : (() => {
              const out = {};
              if (step?.text) out.text = String(step.text);
              if (step?.what) out.what = String(step.what);
              if (step?.actionName) out.actionName = String(step.actionName);
              if (step?.targetTokenRef) out.targetTokenRef = String(step.targetTokenRef);
              if (step?.tokenRef) out.tokenRef = String(step.tokenRef);
              if (step?.targetRef) out.targetRef = String(step.targetRef);
              if (step?.direction) out.direction = String(step.direction);
              if (Number.isFinite(Number(step?.amount))) out.amount = Number(step.amount);
              if (step?.unit) out.unit = String(step.unit);
              if (typeof step?.difficult === "boolean") out.difficult = step.difficult;
              if (step?.shape) out.shape = String(step.shape);
              if (Number.isFinite(Number(step?.radiusFt))) out.radiusFt = Number(step.radiusFt);
              if (Number.isFinite(Number(step?.lengthFt))) out.lengthFt = Number(step.lengthFt);
              if (Number.isFinite(Number(step?.widthFt))) out.widthFt = Number(step.widthFt);
              if (Number.isFinite(Number(step?.angleDeg))) out.angleDeg = Number(step.angleDeg);
              if (step?.centerTokenRef) out.centerTokenRef = String(step.centerTokenRef);
              if (typeof step?.includeSelf === "boolean") out.includeSelf = step.includeSelf;
              if (typeof step?.includeHostileOnly === "boolean") out.includeHostileOnly = step.includeHostileOnly;
              if (typeof step?.placeTemplate === "boolean") out.placeTemplate = step.placeTemplate;
              if (Number.isFinite(Number(step?.centerX))) out.centerX = Number(step.centerX);
              if (Number.isFinite(Number(step?.centerY))) out.centerY = Number(step.centerY);
              if (step?.prompt) out.prompt = String(step.prompt);
              if (step?.extraPrompt) out.prompt = String(step.extraPrompt);
              if (step?.reason) out.reason = String(step.reason);
              if (step?.trigger) out.reason = String(step.trigger);
              return out;
            })();
        if (!allowed.has(stepType) || stepType === "plan" || stepType === "none") return null;
        return { type: stepType, args: stepArgs };
      })
      .filter(Boolean)
      .slice(0, 8);
    if (steps.length === 0) {
      return { replyText: replyText || "(...)", intent: { type: "none", args: {} } };
    }
    return { replyText: replyText || "(...)", intent: { type: "plan", args: { steps } } };
  }

  return { replyText: replyText || "(...)", intent: { type: normType, args } };
}

class AppRuntime {
  constructor({ appDataDir, onLog } = {}) {
    this.appDataDir = String(appDataDir || "");
    this.log = new Logger({ onLog });

    this.discord = null;
    this.fvtt = null;
    this.started = false;
    this.queue = Promise.resolve();

    this._persistConfig = null;
    this._configRef = null;

    this._fvttPollTimer = null;
    this._fvttObserverInFlight = false;
    this._processedFvttMessageIds = new Set();
    this._processedCombatTurnKeysByNpc = new Map();
    this._lastCombatStateByNpc = new Map();
    this._fvttInboundCutoffTs = 0;
    this._openAiScopeHintShown = false;

    this._traceEnabled = false;
    this._traceToUi = false;
    this._traceIncludePrompt = true;
    this._traceIncludeLlmRaw = true;
    this._traceIncludeContexts = true;
    this._traceFilePath = "";
    this._traceWriteQueue = Promise.resolve();
    this._traceWriteWarned = false;
  }

  async start({ config, persistConfig } = {}) {
    if (this.started) return;
    this.started = true;
    this._persistConfig = typeof persistConfig === "function" ? persistConfig : null;
    this._configRef = config && typeof config === "object" ? config : null;

    try {
      await this._configureTrace(config);
    } catch (e) {
      this._traceEnabled = false;
      this._traceFilePath = "";
      this.log.warn("trace", `trace disabled (setup failed): ${e?.message || e}`);
    }
    this.log.info("runtime", "starting...");
    this.log.info("llm", `provider=${this._getLlmProvider(config)}`);
    this._fvttInboundCutoffTs = Date.now();
    this._trace("runtime.start", {
      provider: this._getLlmProvider(config),
      fvttInboundCutoffTs: this._fvttInboundCutoffTs,
      appDataDir: this.appDataDir || process.cwd(),
      npcs: pickEnabledNpcs(config).map((npc) => ({
        id: npc?.id || "",
        displayName: npc?.displayName || "",
        enabled: npc?.enabled !== false,
      })),
    });

    const npcs = pickEnabledNpcs(config);
    if (!npcs.length) {
      this.log.warn("runtime", "no enabled NPCs; runtime will start but will not respond.");
    }

    if (config?.foundry?.enabled) {
      const fvttConfig = {
        foundry: {
          url: String(config.foundry.url || "").trim(),
          username: String(config.foundry.username || "").trim(),
          password: String(config.foundry.password || "").trim(),
          headless: Boolean(config.foundry.headless),
          loginTimeoutMs: Number(config.foundry.loginTimeoutMs || 120_000),
          autoConnect: Boolean(config.foundry.autoConnect),
          keepAliveMs: Number(config.foundry.keepAliveMs || 30_000),
          combatAutoTurn: config?.foundry?.combatAutoTurn !== false,
          actorId: "", // selected per-NPC via withNpcActor()
          actorName: "",
        },
        npc: {
          difficultTerrainMultiplier: Number(config?.npc?.difficultTerrainMultiplier || 2),
        },
      };
      this.fvtt = new FvttClient(fvttConfig);
      if (config.foundry.autoConnect) {
        this.log.info("fvtt", "autoConnect enabled; connecting...");
        const connected = await this.fvtt.ensureConnected();
        if (!connected.ok) {
          this.log.warn("fvtt", `connect failed: ${connected.error}`);
        } else {
          this.log.info("fvtt", "connected.");
        }
      } else {
        this.log.info("fvtt", "will connect on demand.");
      }

      // Start basic FVTT observers (chat polling) for in-world triggers.
      this._startFvttObservers(config);
    }

    if (config?.discord?.enabled) {
      await this._startDiscord({ config });
    }

    this.log.info("runtime", "started.");
    this._trace("runtime.started", { ok: true });
  }

  async stop() {
    if (!this.started) return;
    this.started = false;
    this.log.info("runtime", "stopping...");

    this._persistConfig = null;
    this._configRef = null;
    this._fvttInboundCutoffTs = 0;
    this._processedCombatTurnKeysByNpc.clear();
    this._lastCombatStateByNpc.clear();

    if (this.discord) {
      try {
        await this.discord.destroy();
      } catch {
        // ignore
      }
      this.discord = null;
    }

    if (this.fvtt) {
      try {
        await this.fvtt.close();
      } catch {
        // ignore
      }
      this.fvtt = null;
    }

    this._stopFvttObservers();

    this._trace("runtime.stopped", { ok: true });
    await this._flushTrace();
    this.log.info("runtime", "stopped.");
  }

  async getNpcVisuals({ config } = {}) {
    const resolvedConfig =
      config && typeof config === "object"
        ? config
        : this._configRef && typeof this._configRef === "object"
          ? this._configRef
          : {};
    const npcs = ensureArray(resolvedConfig?.npcs);

    const makeFallback = (npc, error = "") => ({
      npcId: String(npc?.id || ""),
      npcName: String(npc?.displayName || npc?.id || "NPC"),
      ok: false,
      actorId: "",
      actorName: "",
      tokenId: "",
      tokenName: "",
      thumbnail: "",
      thumbnailSource: "",
      error: String(error || ""),
    });

    if (!npcs.length) {
      return { ok: true, connected: false, visuals: [] };
    }

    if (!this.started || !this.fvtt) {
      return {
        ok: false,
        connected: false,
        error: "runtime-not-started",
        visuals: npcs.map((npc) => makeFallback(npc, "runtime-not-started")),
      };
    }

    const connected = await this.fvtt.ensureConnected().catch((e) => ({ ok: false, error: e?.message || String(e) }));
    if (!connected?.ok) {
      return {
        ok: false,
        connected: false,
        error: String(connected?.error || "fvtt-connect-failed"),
        visuals: npcs.map((npc) => makeFallback(npc, String(connected?.error || "fvtt-connect-failed"))),
      };
    }

    const visuals = [];
    for (const npc of npcs) {
      const npcId = String(npc?.id || "");
      const npcName = String(npc?.displayName || npc?.id || "NPC");
      try {
        const status = await this._withNpcActor(npc, () => this.fvtt.getStatus());
        const actor = isPlainObject(status?.actor) ? status.actor : {};
        const token = isPlainObject(status?.token) ? status.token : {};
        const tokenImg = String(token?.img || token?.textureSrc || "").trim();
        const actorImg = String(actor?.img || "").trim();

        visuals.push({
          npcId,
          npcName,
          ok: Boolean(status?.ok),
          actorId: String(actor?.id || ""),
          actorName: String(actor?.name || ""),
          tokenId: String(token?.id || ""),
          tokenName: String(token?.name || ""),
          thumbnail: tokenImg || actorImg,
          thumbnailSource: tokenImg ? "token" : actorImg ? "actor" : "",
          error: status?.ok ? "" : String(status?.error || ""),
        });
      } catch (e) {
        visuals.push(makeFallback(npc, e?.message || e));
      }
    }

    return { ok: true, connected: true, visuals };
  }

  async _configureTrace(config) {
    const traceCfg = isPlainObject(config?.runtime?.trace) ? config.runtime.trace : {};
    const enabled = traceCfg.enabled !== false;
    this._traceEnabled = Boolean(enabled);
    this._traceToUi = Boolean(traceCfg.toUi);
    this._traceIncludePrompt = traceCfg.includePrompt !== false;
    this._traceIncludeLlmRaw = traceCfg.includeLlmRaw !== false;
    this._traceIncludeContexts = traceCfg.includeContexts !== false;
    this._traceWriteWarned = false;

    if (!this._traceEnabled) {
      this._traceFilePath = "";
      return;
    }

    const rawDir = String(traceCfg.logDir || "").trim();
    const logDir = rawDir ? path.resolve(rawDir) : path.join(this.appDataDir || process.cwd(), "logs");
    const rawFile = String(traceCfg.logFile || "").trim();
    const filePath = rawFile
      ? path.isAbsolute(rawFile)
        ? rawFile
        : path.join(logDir, rawFile)
      : path.join(logDir, `runtime-trace-${formatTraceStamp()}.ndjson`);

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    this._traceFilePath = filePath;
    this.log.info("trace", `full trace enabled: ${filePath}`);
    this._trace("trace.started", {
      filePath,
      includePrompt: this._traceIncludePrompt,
      includeLlmRaw: this._traceIncludeLlmRaw,
      includeContexts: this._traceIncludeContexts,
    });
  }

  async _flushTrace() {
    try {
      await this._traceWriteQueue;
    } catch {
      // ignore
    }
  }

  _trace(event, payload = {}) {
    if (!this._traceEnabled || !this._traceFilePath) return;
    const entry = {
      ts: Date.now(),
      event: String(event || "trace"),
      payload: sanitizeForTrace(payload),
    };
    let line = "";
    try {
      line = JSON.stringify(entry) + "\n";
    } catch {
      line = JSON.stringify({
        ts: Date.now(),
        event: String(event || "trace"),
        payload: { error: "trace-serialize-failed" },
      }) + "\n";
    }

    this._traceWriteQueue = this._traceWriteQueue
      .then(() => fs.appendFile(this._traceFilePath, line, "utf8"))
      .catch((e) => {
        if (!this._traceWriteWarned) {
          this._traceWriteWarned = true;
          this.log.warn("trace", `write failed: ${e?.message || e}`);
        }
      });

    if (this._traceToUi) {
      this.log.info("trace", `${entry.event}`);
    }
  }

  _startFvttObservers(config) {
    this._stopFvttObservers();
    if (!this.fvtt) return;

    const everyMs = Math.max(500, Number(config?.foundry?.pollChatEveryMs || 1200));
    this._fvttPollTimer = setInterval(() => {
      void this._pollFvttObservers(config);
    }, everyMs);

    if (this._fvttPollTimer && typeof this._fvttPollTimer.unref === "function") {
      this._fvttPollTimer.unref();
    }
  }

  _stopFvttObservers() {
    if (this._fvttPollTimer) {
      clearInterval(this._fvttPollTimer);
      this._fvttPollTimer = null;
    }
    this._fvttObserverInFlight = false;
    this._processedFvttMessageIds.clear();
    this._processedCombatTurnKeysByNpc.clear();
    this._lastCombatStateByNpc.clear();
  }

  async _pollFvttObservers(config) {
    if (this._fvttObserverInFlight) return;
    this._fvttObserverInFlight = true;
    try {
      await this._pollFvttChat(config);
      await this._pollFvttCombatTurns(config);
    } finally {
      this._fvttObserverInFlight = false;
    }
  }

  async _pollFvttChat(config) {
    if (!this.started) return;
    if (!this.fvtt || !config?.foundry?.enabled) return;
    if (!this.fvtt.isReady()) return;

    const npcs = pickEnabledNpcs(config);
    if (!npcs.length) return;

    let chat = null;
    try {
      chat = await this.fvtt.getRecentChat(18);
      this._trace("fvtt.chat.poll.response", {
        ok: Boolean(chat?.ok),
        count: Number(chat?.count || 0),
        limit: Number(chat?.limit || 0),
      });
    } catch (e) {
      this.log.warn("fvtt", `chat poll failed: ${e?.message || e}`);
      this._trace("fvtt.chat.poll.error", { error: e });
      return;
    }
    if (!chat?.ok) return;

    const messages = ensureArray(chat.messages);
    for (const msg of messages) {
      const id = String(msg?.id || "");
      if (!id) continue;
      if (this._processedFvttMessageIds.has(id)) continue;
      this._processedFvttMessageIds.add(id);
      if (this._processedFvttMessageIds.size > 250) {
        // avoid unbounded growth
        this._processedFvttMessageIds.clear();
      }

      const msgTs = Number(msg?.timestamp);
      const hasMsgTs = Number.isFinite(msgTs) && msgTs > 0;
      if (this._fvttInboundCutoffTs > 0) {
        if (!hasMsgTs) {
          this._trace("fvtt.chat.skip", {
            reason: "missing-timestamp",
            messageId: id,
            cutoffTs: this._fvttInboundCutoffTs,
          });
          continue;
        }
        if (msgTs < this._fvttInboundCutoffTs) {
          this._trace("fvtt.chat.skip", {
            reason: "before-runtime-start",
            messageId: id,
            messageTs: msgTs,
            cutoffTs: this._fvttInboundCutoffTs,
          });
          continue;
        }
      }

      const speaker = String(msg?.speaker || "").trim();
      const content = String(msg?.content || "").trim();
      if (!content) continue;
      if (msg?.isRoll) continue;
      if (isLikelyFvttSystemMessage(content)) continue;

      // Ignore messages that look like they came from an NPC (avoid loops).
      const speakerLower = safeLower(speaker);
      if (npcs.some((n) => speakerLower.includes(safeLower(n.displayName || n.id)))) {
        continue;
      }

      // Trigger: message mentions an NPC name.
      const hitNpc = resolveNpcForDiscordMessage({
        content,
        npcs,
        defaultNpcId: "",
        allowSingleNpcFallback: false,
      });
      if (!hitNpc) continue;

      this._trace("fvtt.chat.inbound", {
        messageId: id,
        speaker,
        content,
        npcId: hitNpc?.id || "",
        npcName: hitNpc?.displayName || "",
      });

      // Queue to keep FVTT actions serialized.
      this.queue = this.queue.then(() =>
        this._handleNpcFvttInbound({ config, npc: hitNpc, speaker, text: content })
      );
      await this.queue.catch(() => {});
    }
  }

  _captureCombatSnapshot(state) {
    const safe = isPlainObject(state) ? state : {};
    const combat = isPlainObject(safe?.combat) ? safe.combat : {};
    return {
      ok: Boolean(safe?.ok),
      inCombat: Boolean(safe?.inCombat),
      actorInCombat: Boolean(safe?.actorInCombat),
      isActorTurn: Boolean(safe?.isActorTurn),
      turnKey: String(safe?.turnKey || "").trim(),
      round: Number(combat.round ?? safe?.round ?? 0),
      turn: Number(combat.turn ?? safe?.turn ?? -1),
      combatId: String(combat.id || "").trim(),
      combat: {
        id: String(combat.id || "").trim(),
        sceneId: String(combat.sceneId || "").trim(),
        sceneName: String(combat.sceneName || "").trim(),
        round: Number(combat.round ?? safe?.round ?? 0),
        turn: Number(combat.turn ?? safe?.turn ?? -1),
      },
    };
  }

  async _pollFvttCombatTurns(config) {
    if (!this.started) return;
    if (!this.fvtt || !config?.foundry?.enabled) return;
    if (!this.fvtt.isReady()) return;
    if (config?.foundry?.combatAutoTurn === false) return;

    const npcs = pickEnabledNpcs(config);
    if (!npcs.length) return;

    for (const npc of npcs) {
      const npcName = String(npc?.displayName || npc?.id || "NPC");
      const npcKey = String(npc?.id || npcName || "").trim() || `npc:${Math.random().toString(36).slice(2, 8)}`;

      let state = null;
      try {
        state = await this._withNpcActor(npc, () => this.fvtt.getActorCombatState());
      } catch (e) {
        const message = String(e?.message || e);
        if (
          !this.started ||
          /Target page, context or browser has been closed|Browser has been closed|Protocol error/i.test(message)
        ) {
          this._trace("fvtt.combat.poll.skip", { npcId: npc?.id || "", npcName, reason: "session-closed", message });
          continue;
        }
        this.log.warn("combat", `poll failed (${npcName}): ${message}`);
        this._trace("fvtt.combat.poll.error", { npcId: npc?.id || "", npcName, error: e });
        continue;
      }

      this._trace("fvtt.combat.poll", {
        npcId: npc?.id || "",
        npcName,
        state: state || null,
      });

      const prevSnapshot = this._lastCombatStateByNpc.get(npcKey) || null;
      const currentSnapshot = this._captureCombatSnapshot(state);
      this._lastCombatStateByNpc.set(npcKey, currentSnapshot);
      if (this._lastCombatStateByNpc.size > 200) {
        this._lastCombatStateByNpc.clear();
      }

      const combatJustEnded = Boolean(prevSnapshot?.actorInCombat) && currentSnapshot.ok && !currentSnapshot.actorInCombat;
      if (combatJustEnded) {
        this.log.info("combat", `combat ended -> ${npcName}`);
        this._trace("fvtt.combat.end.trigger", {
          npcId: npc?.id || "",
          npcName,
          prev: prevSnapshot,
          current: currentSnapshot,
        });
        this.queue = this.queue.then(() =>
          this._handleNpcCombatEnd({
            config,
            npc,
            prevCombatState: prevSnapshot,
            combatState: state,
          })
        );
        await this.queue.catch((e) => {
          this.log.warn("combat", `end speech failed (${npcName}): ${e?.message || e}`);
          this._trace("fvtt.combat.end.error", {
            npcId: npc?.id || "",
            npcName,
            error: e,
          });
        });
      }

      if (!state?.ok) continue;
      if (!state?.inCombat) continue;
      if (!state?.actorInCombat) continue;
      if (!state?.isActorTurn) continue;

      const turnKey = String(state?.turnKey || "").trim();
      if (!turnKey) continue;

      const prevTurnKey = this._processedCombatTurnKeysByNpc.get(npcKey);
      if (prevTurnKey === turnKey) continue;
      this._processedCombatTurnKeysByNpc.set(npcKey, turnKey);
      if (this._processedCombatTurnKeysByNpc.size > 200) {
        this._processedCombatTurnKeysByNpc.clear();
      }

      this.log.info("combat", `auto turn -> ${npcName} (${turnKey})`);
      this._trace("fvtt.combat.turn.trigger", {
        npcId: npc?.id || "",
        npcName,
        turnKey,
        round: Number(state?.combat?.round ?? state?.round ?? 0),
        turn: Number(state?.combat?.turn ?? state?.turn ?? -1),
      });

      this.queue = this.queue.then(() => this._handleNpcCombatTurn({ config, npc, combatState: state }));
      await this.queue.catch((e) => {
        this.log.warn("combat", `turn handler failed (${npcName}): ${e?.message || e}`);
        this._trace("fvtt.combat.turn.error", {
          npcId: npc?.id || "",
          npcName,
          turnKey,
          error: e,
        });
      });
    }
  }

  async _handleNpcCombatTurn({ config, npc, combatState }) {
    const npcName = String(npc?.displayName || npc?.id || "NPC");
    const turnKey = String(combatState?.turnKey || "").trim();
    let text = buildCombatTurnInboundText({ npcName, combatState });

    this._trace("fvtt.combat.turn.handle.start", {
      npcId: npc?.id || "",
      npcName,
      turnKey,
      text,
    });

    const personaText = await loadNpcPromptDocs({ config, npc });

    let fvttChatContext = [];
    let fvttSceneContext = null;
    let fvttActorSheet = null;
    try {
      const chat = await this.fvtt.getRecentChat(10);
      if (chat?.ok) fvttChatContext = chat.messages || [];
      fvttSceneContext = await this._withNpcActor(npc, () => this.fvtt.getSceneContext(60));
      fvttActorSheet = await this._withNpcActor(npc, () => this.fvtt.getActorSheet());
    } catch (e) {
      this.log.warn("combat", `context build failed (${npcName}): ${e?.message || e}`);
      this._trace("fvtt.combat.turn.context.error", { npcId: npc?.id || "", npcName, error: e });
    }

    if (this._traceIncludeContexts) {
      this._trace("fvtt.combat.turn.context", {
        npcId: npc?.id || "",
        npcName,
        turnKey,
        chat: fvttChatContext,
        scene: fvttSceneContext,
        actorSheet: fvttActorSheet,
        combatState,
      });
    }

    text = buildCombatTurnInboundText({
      npcName,
      combatState,
      actorSheet: fvttActorSheet,
      sceneContext: fvttSceneContext,
    });

    const prompt = buildNpcPrompt({
      npc,
      inboundText: text,
      fvttReady: true,
      personaText,
      fvttChatContext,
      fvttSceneContext,
      fvttActorSheet,
      mentionedSceneTokens: ensureArray(combatState?.nearbyHostiles).slice(0, 4),
      imageGeneration: normalizeNpcImageGenerationState({ config, npc }),
    });

    let replyText = "";
    let intent = { type: "none", args: {} };
    let strictExecution = false;
    try {
      const completion = await this._completeNpcJson({
        config,
        prompt,
        timeoutMs: 90_000,
        traceMeta: {
          origin: "combat-turn",
          npcId: npc?.id || "",
          npcName,
          turnKey,
        },
      });
      const normalized = normalizeIntent(completion.parsed);
      const actionTag = extractFvttActionTags(normalized.replyText);
      replyText = actionTag.hadTag ? actionTag.visibleText || "(...)" : normalized.replyText || "(...)";

      let baseIntent = normalized.intent;
      let allowFallback = true;
      let allowRepair = true;
      let actionIntentSource = "intent";
      if (actionTag.hadTag) {
        if (actionTag.actions.length > 0) {
          baseIntent = buildIntentFromActionTags(actionTag.actions);
          allowFallback = false;
          allowRepair = false;
          strictExecution = true;
          actionIntentSource = "tag-strict";
        } else if (actionTag.hadExplicitNone && actionTag.parseErrors.length === 0) {
          baseIntent = { type: "none", args: {} };
          allowFallback = false;
          allowRepair = false;
          strictExecution = true;
          actionIntentSource = "tag-none";
        }
      }
      if (!actionTag.hadTag && String(baseIntent?.type || "none").toLowerCase() === "plan") {
        allowFallback = false;
        allowRepair = false;
        strictExecution = true;
        actionIntentSource = "intent-plan-strict";
      }

      intent = this._applyFallbackIntentFromText({
        text,
        intent: baseIntent,
        fvttSceneContext,
        allowFallback,
        allowRepair,
      });
      this._trace("llm.intent.combat", {
        npcId: npc?.id || "",
        npcName,
        turnKey,
        replyText,
        actionTag,
        normalizedIntent: normalized.intent,
        actionIntentSource,
        strictExecution,
        repairedIntent: intent,
      });
      this.log.info("llm", `intent(combat): type=${intent.type} args=${compact(JSON.stringify(intent.args), 220)}`);
    } catch (e) {
      this.log.error("llm", `LLM failed (combat turn): ${e?.message || e}`);
      this._maybeLogOpenAiScopeHint(e, config);
      this._trace("llm.error.combat", { npcId: npc?.id || "", npcName, turnKey, error: e });
      replyText = "짧게 숨을 고르며 전황을 살핀다.";
      intent = { type: "none", args: {} };
    }

    const plannedSteps = this._expandIntentToSteps(intent);
    const budgetPreview =
      plannedSteps.length > 0
        ? this._applyCombatTurnStepBudget({
            steps: plannedSteps,
            fvttActorSheet,
          })
        : { steps: [] };
    const hasPlannedSay = ensureArray(budgetPreview?.steps).some(
      (step) => String(step?.type || "").toLowerCase() === "say"
    );

    // 1) Turn start speech
    // If LLM already provided an explicit say-step inside the ordered action set,
    // keep speech order inside the step queue and skip this auto pre-speech.
    const startSpeech = hasPlannedSay ? "" : String(replyText || "").trim();
    if (startSpeech) {
      try {
        await this._withNpcActor(npc, () => this.fvtt.speakAsActor(startSpeech));
        this._trace("fvtt.speak.outbound", {
          npcId: npc?.id || "",
          npcName,
          text: startSpeech,
          origin: "combat-turn-start",
          turnKey,
        });
      } catch (e) {
        this.log.warn("combat", `start speech failed (${npcName}): ${e?.message || e}`);
        this._trace("fvtt.speak.error", {
          npcId: npc?.id || "",
          error: e,
          origin: "combat-turn-start",
          turnKey,
        });
      }
    }

    // 2) Action execution
    if (intent?.type && intent.type !== "none") {
      try {
        this._trace("fvtt.intent.execute.start", {
          npcId: npc?.id || "",
          intent,
          origin: "combat-turn",
          strictExecution,
          turnKey,
        });
        await this._executeIntentPlan({
          config,
          npc,
          intent,
          origin: "combat-turn",
          strict: strictExecution,
          execution: { fvttActorSheet, combatState },
        });
        this._trace("fvtt.intent.execute.done", {
          npcId: npc?.id || "",
          intentType: intent?.type || "none",
          origin: "combat-turn",
          turnKey,
        });
      } catch (e) {
        this.log.warn("combat", `intent failed (${npcName}): ${e?.message || e}`);
        this._trace("fvtt.intent.execute.error", {
          npcId: npc?.id || "",
          error: e,
          intent,
          origin: "combat-turn",
          turnKey,
        });
      }
    }

    // 3) Turn end handoff to next combatant
    let endTurn = null;
    try {
      endTurn = await this._withNpcActor(npc, () => this.fvtt.endActorCombatTurn(turnKey));
      this._trace("fvtt.combat.turn.end", {
        npcId: npc?.id || "",
        npcName,
        turnKey,
        result: endTurn,
      });
      const needsAdvanceRetry =
        !endTurn?.ok ||
        (endTurn?.ok &&
          !endTurn?.skipped &&
          String(endTurn?.turnKeyAfter || "").trim() === String(endTurn?.turnKeyBefore || "").trim()) ||
        (endTurn?.ok &&
          endTurn?.skipped &&
          !["turn-already-advanced", "not-actor-turn"].includes(String(endTurn?.reason || "")));

      if (needsAdvanceRetry) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        const verify = await this._withNpcActor(npc, () => this.fvtt.getActorCombatState());
        this._trace("fvtt.combat.turn.end.verify", {
          npcId: npc?.id || "",
          npcName,
          turnKey,
          state: verify || null,
          firstResult: endTurn || null,
        });
        if (verify?.ok && verify?.isActorTurn && String(verify?.turnKey || "").trim() === turnKey) {
          const retry = await this._withNpcActor(npc, () => this.fvtt.endActorCombatTurn(turnKey));
          this._trace("fvtt.combat.turn.end.retry", {
            npcId: npc?.id || "",
            npcName,
            turnKey,
            result: retry || null,
          });
          if (retry?.ok) endTurn = retry;
        }
      }

      if (!endTurn?.ok) {
        this.log.warn("combat", `turn end failed (${npcName}): ${String(endTurn?.error || "unknown error")}`);
      } else if (endTurn?.skipped) {
        const reason = String(endTurn?.reason || "skipped");
        const beforeKey = String(endTurn?.turnKeyBefore || "");
        const afterKey = String(endTurn?.turnKeyAfter || "");
        this.log.info(
          "combat",
          `turn handoff skipped (${npcName}): ${reason}${beforeKey ? ` before=${beforeKey}` : ""}${afterKey ? ` after=${afterKey}` : ""}`
        );
      } else {
        const beforeKey = String(endTurn?.turnKeyBefore || "");
        const afterKey = String(endTurn?.turnKeyAfter || "");
        this.log.info(
          "combat",
          `turn handed off (${npcName})${beforeKey || afterKey ? `: ${beforeKey || "(unknown)"} -> ${afterKey || "(unknown)"}` : ""}`
        );
      }
    } catch (e) {
      this.log.warn("combat", `turn end failed (${npcName}): ${e?.message || e}`);
      this._trace("fvtt.combat.turn.end.error", {
        npcId: npc?.id || "",
        npcName,
        turnKey,
        error: e,
      });
    }

    // 4) Turn end speech
    if (endTurn?.ok && !endTurn?.skipped) {
      const endSpeech = "행동을 마치고 턴을 넘긴다.";
      try {
        await this._withNpcActor(npc, () => this.fvtt.speakAsActor(endSpeech));
        this._trace("fvtt.speak.outbound", {
          npcId: npc?.id || "",
          npcName,
          text: endSpeech,
          origin: "combat-turn-end",
          turnKey,
        });
      } catch (e) {
        this.log.warn("combat", `end speech failed (${npcName}): ${e?.message || e}`);
        this._trace("fvtt.speak.error", {
          npcId: npc?.id || "",
          error: e,
          origin: "combat-turn-end",
          turnKey,
        });
      }
    }
  }

  async _handleNpcCombatEnd({ config, npc, prevCombatState, combatState }) {
    const npcName = String(npc?.displayName || npc?.id || "NPC");
    this._trace("fvtt.combat.end.handle.start", {
      npcId: npc?.id || "",
      npcName,
      prevCombatState: prevCombatState || null,
      combatState: combatState || null,
    });

    const personaText = await loadNpcPromptDocs({ config, npc });
    let fvttChatContext = [];
    let fvttSceneContext = null;
    let fvttActorSheet = null;

    try {
      const chat = await this.fvtt.getRecentChat(10);
      if (chat?.ok) fvttChatContext = chat.messages || [];
      fvttSceneContext = await this._withNpcActor(npc, () => this.fvtt.getSceneContext(60));
      fvttActorSheet = await this._withNpcActor(npc, () => this.fvtt.getActorSheet());
    } catch (e) {
      this.log.warn("combat", `end context build failed (${npcName}): ${e?.message || e}`);
      this._trace("fvtt.combat.end.context.error", { npcId: npc?.id || "", npcName, error: e });
    }

    const inboundText = buildCombatEndInboundText({
      npcName,
      prevCombatState,
      combatState,
      actorSheet: fvttActorSheet,
    });

    const prompt = buildNpcPrompt({
      npc,
      inboundText,
      fvttReady: true,
      personaText,
      fvttChatContext,
      fvttSceneContext,
      fvttActorSheet,
      mentionedSceneTokens: ensureArray(combatState?.nearbyHostiles).slice(0, 4),
      imageGeneration: normalizeNpcImageGenerationState({ config, npc }),
    });

    let replyText = "";
    try {
      const completion = await this._completeNpcJson({
        config,
        prompt,
        timeoutMs: 60_000,
        traceMeta: {
          origin: "combat-end",
          npcId: npc?.id || "",
          npcName,
        },
      });
      const normalized = normalizeIntent(completion.parsed);
      const actionTag = extractFvttActionTags(normalized.replyText);
      replyText = actionTag.hadTag ? actionTag.visibleText || "" : String(normalized.replyText || "");
      this._trace("llm.intent.combat.end", {
        npcId: npc?.id || "",
        npcName,
        replyText,
        normalizedIntent: normalized.intent,
        actionTag,
      });
    } catch (e) {
      this.log.warn("llm", `LLM failed (combat end): ${e?.message || e}`);
      this._trace("llm.error.combat.end", { npcId: npc?.id || "", npcName, error: e });
    }

    const speech = String(replyText || "").trim() || buildCombatEndFallbackSpeech({
      npcName,
      actorSheet: fvttActorSheet,
      combatState,
    });
    if (!speech) return;

    try {
      await this._withNpcActor(npc, () => this.fvtt.speakAsActor(speech));
      this._trace("fvtt.speak.outbound", {
        npcId: npc?.id || "",
        npcName,
        text: speech,
        origin: "combat-end",
      });
    } catch (e) {
      this.log.warn("combat", `end speech failed (${npcName}): ${e?.message || e}`);
      this._trace("fvtt.speak.error", {
        npcId: npc?.id || "",
        npcName,
        error: e,
        origin: "combat-end",
      });
    }
  }

  async _handleNpcFvttInbound({ config, npc, speaker, text }) {
    const npcName = String(npc?.displayName || npc?.id || "NPC");
    this.log.info("fvtt", `inbound -> ${npcName} (speaker=${speaker || "?"}): ${compact(text, 180)}`);
    this._trace("fvtt.inbound.handle.start", {
      npcId: npc?.id || "",
      npcName,
      speaker: String(speaker || ""),
      text: String(text || ""),
    });

    const personaText = await loadNpcPromptDocs({ config, npc });

    // Build FVTT-only context for LLM
    let fvttChatContext = [];
    let fvttSceneContext = null;
    let fvttActorSheet = null;
    let mentionedSceneTokens = [];
    try {
      const chat = await this.fvtt.getRecentChat(10);
      if (chat?.ok) fvttChatContext = chat.messages || [];
      fvttSceneContext = await this._withNpcActor(npc, () => this.fvtt.getSceneContext(60));
      fvttActorSheet = await this._withNpcActor(npc, () => this.fvtt.getActorSheet());
      const sceneTokens = await this.fvtt.listSceneTokens();
      if (sceneTokens?.ok) {
        mentionedSceneTokens = collectMentionedSceneTokens({
          text,
          sceneTokens: sceneTokens.tokens,
          limit: 4,
        });
      }
    } catch (e) {
      this.log.warn("fvtt", `context build failed: ${e?.message || e}`);
      this._trace("fvtt.inbound.context.error", { npcId: npc?.id || "", error: e });
    }

    if (this._traceIncludeContexts) {
      this._trace("fvtt.inbound.context", {
        npcId: npc?.id || "",
        chat: fvttChatContext,
        scene: fvttSceneContext,
        actorSheet: fvttActorSheet,
        mentionedSceneTokens,
      });
    }

    const reactionGate = evaluateNpcReactionDistance({
      npc,
      sceneContext: fvttSceneContext,
      text,
      speakerHint: speaker,
      preferSpeaker: true,
    });
    this._trace("npc.reaction.gate", {
      origin: "fvtt-inbound",
      npcId: npc?.id || "",
      npcName,
      speaker: String(speaker || ""),
      gate: reactionGate,
    });
    if (reactionGate.enabled && !reactionGate.allowed) {
      const sourceName = reactionGate.sourceTokenName || reactionGate.sourceTokenId || "unknown";
      const distText = Number.isFinite(Number(reactionGate.distanceFt))
        ? `${Number(reactionGate.distanceFt)}ft`
        : "?ft";
      this.log.info(
        "fvtt",
        `skip inbound (${npcName}): source=${sourceName} dist=${distText} allowed<=${reactionGate.maxFt}ft`
      );
      return;
    }

    const prompt = buildNpcPrompt({
      npc,
      inboundText: text,
      fvttReady: true,
      personaText,
      fvttChatContext,
      fvttSceneContext,
      fvttActorSheet,
      mentionedSceneTokens,
      imageGeneration: normalizeNpcImageGenerationState({ config, npc }),
    });

    let replyText = "";
    let intent = { type: "none", args: {} };
    let strictExecution = false;
    try {
      const completion = await this._completeNpcJson({
        config,
        prompt,
        timeoutMs: 90_000,
        traceMeta: {
          origin: "fvtt-inbound",
          npcId: npc?.id || "",
          npcName,
        },
      });
      const normalized = normalizeIntent(completion.parsed);
      const actionTag = extractFvttActionTags(normalized.replyText);
      replyText = actionTag.hadTag ? actionTag.visibleText || "(...)" : normalized.replyText || "(...)";

      let baseIntent = normalized.intent;
      let allowFallback = true;
      let allowRepair = true;
      let actionIntentSource = "intent";
      if (actionTag.hadTag) {
        if (actionTag.actions.length > 0) {
          baseIntent = buildIntentFromActionTags(actionTag.actions);
          allowFallback = false;
          allowRepair = false;
          strictExecution = true;
          actionIntentSource = "tag-strict";
        } else if (actionTag.hadExplicitNone && actionTag.parseErrors.length === 0) {
          baseIntent = { type: "none", args: {} };
          allowFallback = false;
          allowRepair = false;
          strictExecution = true;
          actionIntentSource = "tag-none";
        }
      }
      if (!actionTag.hadTag && String(baseIntent?.type || "none").toLowerCase() === "plan") {
        allowFallback = false;
        allowRepair = false;
        strictExecution = true;
        actionIntentSource = "intent-plan-strict";
      }

      intent = this._applyFallbackIntentFromText({
        text,
        intent: baseIntent,
        fvttSceneContext,
        allowFallback,
        allowRepair,
      });
      this._trace("llm.intent.fvtt", {
        npcId: npc?.id || "",
        replyText,
        actionTag,
        normalizedIntent: normalized.intent,
        actionIntentSource,
        strictExecution,
        repairedIntent: intent,
      });
      this.log.info("llm", `intent(fvtt): type=${intent.type} args=${compact(JSON.stringify(intent.args), 220)}`);
    } catch (e) {
      this.log.error("llm", `LLM failed (fvtt inbound): ${e?.message || e}`);
      this._maybeLogOpenAiScopeHint(e, config);
      this._trace("llm.error.fvtt", { npcId: npc?.id || "", error: e });
      return;
    }

    if (intent?.type && intent.type !== "none") {
      try {
        this._trace("fvtt.intent.execute.start", {
          npcId: npc?.id || "",
          intent,
          origin: "fvtt",
          strictExecution,
        });
        await this._executeIntentPlan({ config, npc, intent, origin: "fvtt", strict: strictExecution });
        this._trace("fvtt.intent.execute.done", { npcId: npc?.id || "", intentType: intent?.type || "none" });
      } catch (e) {
        this.log.warn("fvtt", `intent failed: ${e?.message || e}`);
        this._trace("fvtt.intent.execute.error", { npcId: npc?.id || "", error: e, intent });
      }
    }

    try {
      await this._withNpcActor(npc, () => this.fvtt.speakAsActor(replyText));
      this._trace("fvtt.speak.outbound", {
        npcId: npc?.id || "",
        npcName,
        text: replyText,
        origin: "fvtt",
      });
    } catch (e) {
      this.log.warn("fvtt", `speak failed: ${e?.message || e}`);
      this._trace("fvtt.speak.error", { npcId: npc?.id || "", error: e, origin: "fvtt" });
    }
  }

  async runDiagnostics({ config, persistConfig } = {}) {
    const prevPersist = this._persistConfig;
    const prevConfigRef = this._configRef;
    if (typeof persistConfig === "function") {
      this._persistConfig = persistConfig;
    }
    if (config && typeof config === "object") {
      this._configRef = config;
    }

    try {
    const result = {
      ts: Date.now(),
      discord: { ok: false, detail: "" },
      fvtt: { ok: false, detail: "" },
      llm: { ok: false, provider: String(config?.llm?.provider || ""), detail: "" },
      sharedDocs: config?.npc?.sharedDocs || {},
      npcs: [],
    };

    const npcs = pickEnabledNpcs(config);
    result.npcs = npcs.map((n) => ({
      id: n.id,
      name: n.displayName,
      enabled: n.enabled !== false,
      actor: n.actor,
      docs: n.personaDocs,
      triggers: n.triggers,
      image: n.image,
    }));

    // Discord diag
    try {
      const enabled = Boolean(config?.discord?.enabled);
      if (!enabled) {
        result.discord = { ok: true, detail: "disabled" };
      } else {
        const token = String(config?.discord?.botToken || "").trim();
        if (!token) {
          result.discord = { ok: false, detail: "missing botToken" };
        } else {
          result.discord = { ok: true, detail: "token present (not validated here)" };
        }
      }
    } catch (e) {
      result.discord = { ok: false, detail: e?.message || String(e) };
    }

    const withNpcActorOnClient = async (fvttClient, npc, fn) => {
      const sel = actorSelectorForNpc(npc);
      const foundry = fvttClient.config.foundry;
      const prevId = foundry.actorId;
      const prevName = foundry.actorName;
      foundry.actorId = sel.actorId;
      foundry.actorName = sel.actorName;
      try {
        return await fn();
      } finally {
        foundry.actorId = prevId;
        foundry.actorName = prevName;
      }
    };

    // FVTT diag (connect + basic read)
    let diagFvtt = null;
    let diagFvttIsTemp = false;
    try {
      const enabled = Boolean(config?.foundry?.enabled);
      if (!enabled) {
        result.fvtt = { ok: true, detail: "disabled" };
      } else {
        diagFvtt = this.fvtt;
        if (!diagFvtt) {
          const fvttConfig = {
            foundry: {
              url: String(config.foundry.url || "").trim(),
              username: String(config.foundry.username || "").trim(),
              password: String(config.foundry.password || "").trim(),
              headless: true,
              loginTimeoutMs: Number(config.foundry.loginTimeoutMs || 120_000),
              autoConnect: false,
              keepAliveMs: 0,
              actorId: "",
              actorName: "",
            },
            npc: {
              difficultTerrainMultiplier: Number(config?.npc?.difficultTerrainMultiplier || 2),
            },
          };
          diagFvtt = new FvttClient(fvttConfig);
          diagFvttIsTemp = true;
        }

        const connected = await diagFvtt.ensureConnected();
        if (!connected.ok) {
          result.fvtt = { ok: false, detail: connected.error };
        } else {
          // Basic: can we read chat?
          const chat = await diagFvtt.getRecentChat(5);
          result.fvtt = { ok: Boolean(chat?.ok), detail: chat?.ok ? "connected + chat ok" : chat?.error || "" };
        }
      }
    } catch (e) {
      result.fvtt = { ok: false, detail: e?.message || String(e) };
    }

    // LLM diag (provider-aware)
    const provider = this._getLlmProvider(config);
    try {
      if (provider === "codex-cli") {
        const codex = this._getCodexCliConfig(config);
        const status = await getCodexLoginStatus({ codexBin: codex.binPath });
        if (!status?.ok) {
          result.llm = {
            ok: false,
            provider,
            detail: `codex status check failed: ${status?.error || "unknown error"}`,
          };
        } else if (!status.loggedIn) {
          result.llm = { ok: false, provider, detail: "codex not logged in (run codex login)" };
        } else {
          const prompt = [
            "Return a single JSON object only. No extra text.",
            '{ "replyText": "ok", "intent": { "type": "none", "args": {} } }',
          ].join("\n");
          await this._completeNpcJson({ config, prompt, timeoutMs: 35_000 });
          result.llm = { ok: true, provider, detail: `codex login ok + completion ok (${codex.model})` };
        }
      } else if (provider === "openai-api-key" || provider === "openai-oauth") {
        const prompt = [
          "Return a single JSON object only. No extra text.",
          '{ "replyText": "ok", "intent": { "type": "none", "args": {} } }',
        ].join("\n");
        await this._completeNpcJson({ config, prompt, timeoutMs: 30_000 });
        result.llm = { ok: true, provider, detail: "completion ok" };
      } else {
        result.llm = { ok: false, provider, detail: `unsupported provider: ${provider}` };
      }
    } catch (e) {
      result.llm = { ok: false, provider, detail: e?.message || String(e) };
    }

    // NPC diag (requires FVTT)
    if (result.fvtt.ok && config?.foundry?.enabled) {
      const npcChecks = [];
      for (const npc of npcs) {
        const entry = { id: npc.id, name: npc.displayName, ok: false, detail: "" };
        try {
          if (!diagFvtt) {
            entry.ok = false;
            entry.detail = "fvtt not available";
          } else {
            const status = await withNpcActorOnClient(diagFvtt, npc, () => diagFvtt.getStatus());
            if (!status?.ok) {
              entry.ok = false;
              entry.detail = status?.error || "status failed";
            } else {
              entry.ok = true;
              entry.detail = `scene=${status.scene?.name || "-"} token=${status.token?.name || "-"}`;
            }
          }
        } catch (e) {
          entry.ok = false;
          entry.detail = e?.message || String(e);
        }
        npcChecks.push(entry);
      }
      result.npcChecks = npcChecks;
    }

    if (diagFvtt && diagFvttIsTemp) {
      await diagFvtt.close().catch(() => {});
    }

    return result;
    } finally {
      this._persistConfig = prevPersist;
      this._configRef = prevConfigRef;
    }
  }

  async _startDiscord({ config }) {
    const token = String(config?.discord?.botToken || "").trim();
    if (!token) {
      this.log.warn("discord", "disabled: missing botToken in config.json");
      return;
    }

    const channelName = String(config?.discord?.channelName || "aibot").trim();
    const requireMention = Boolean(config?.discord?.requireMention);
    const npcs = pickEnabledNpcs(config);

    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    });

    client.once(Events.ClientReady, () => {
      this.log.info("discord", `logged in as ${client.user?.tag || "unknown"}`);
      this._trace("discord.ready", {
        tag: String(client.user?.tag || ""),
        id: String(client.user?.id || ""),
      });
    });

    client.on(Events.MessageCreate, async (message) => {
      if (!this.started) return;
      if (!message || !message.author || message.author.bot) return;
      if (!isTargetChannel(message, channelName)) return;

      const botUserId = client.user?.id;
      const mentioned = botUserId ? Boolean(message.mentions?.users?.has(botUserId)) : false;
      if (requireMention && !mentioned) return;

      const raw = String(message.content || "").trim();
      const cleaned = stripBotMention(raw, botUserId);
      if (!cleaned) return;

      const npc = resolveNpcForDiscordMessage({
        content: cleaned,
        npcs,
        defaultNpcId: String(config?.npc?.defaultNpcId || "").trim(),
      });
      this._trace("discord.inbound.message", {
        messageId: String(message.id || ""),
        channelId: String(message.channel?.id || ""),
        channelName: String(message.channel?.name || ""),
        guildId: String(message.guild?.id || ""),
        guildName: String(message.guild?.name || ""),
        authorId: String(message.author?.id || ""),
        authorName: String(message.author?.username || message.author?.displayName || ""),
        mentioned,
        requireMention,
        raw,
        cleaned,
        resolvedNpcId: npc?.id || "",
        resolvedNpcName: npc?.displayName || "",
      });

      if (!npc) {
        // Multi-NPC, but no explicit selection in the message.
        if (npcs.length > 1) {
          await message
            .reply(`?대뒓 NPC瑜?遺瑜댁떆?붿? ?대쫫??媛숈씠 ?곸뼱 二쇱꽭?? (?? "?묒튂湲??붿븘?? ...")`)
            .catch(() => {});
        }
        return;
      }

      // Queue per runtime to avoid concurrent page.evaluate / token conflicts.
      this.queue = this.queue.then(() => this._handleNpcDiscordMessage({ config, npc, message, text: cleaned }));
      await this.queue.catch(() => {});
    });

    await client.login(token);
    this.discord = client;
  }

  async _withNpcActor(npc, fn) {
    if (!this.fvtt) throw new Error("FVTT not configured");
    const sel = actorSelectorForNpc(npc);
    const foundry = this.fvtt.config.foundry;
    const prevId = foundry.actorId;
    const prevName = foundry.actorName;
    foundry.actorId = sel.actorId;
    foundry.actorName = sel.actorName;
    try {
      return await fn();
    } finally {
      foundry.actorId = prevId;
      foundry.actorName = prevName;
    }
  }

  _getLlmProvider(config) {
    return String(config?.llm?.provider || "codex-cli").trim().toLowerCase();
  }

  _getCodexCliConfig(config) {
    const codex = config?.llm?.codexCli || {};
    return {
      binPath: normalizeCodexBin(codex.binPath),
      model: String(codex.model || config?.llm?.openai?.model || "gpt-5.3-codex").trim(),
    };
  }

  async _getOpenAiApiKeyForConfig(config) {
    const provider = this._getLlmProvider(config);
    const openai = config?.llm?.openai || {};

    if (provider === "openai-api-key") {
      const key = String(openai.apiKey || "").trim();
      if (!key) throw new Error("Missing OpenAI API key in config");
      return key;
    }

    if (provider === "openai-oauth") {
      const oauth = openai.oauth || {};
      let accessToken = String(oauth.accessToken || "").trim();
      const refreshToken = String(oauth.refreshToken || "").trim();
      const expiresAtMs = Number(oauth.expiresAtMs || 0);

      if (!accessToken || !refreshToken) {
        throw new Error("OpenAI OAuth not logged in. (Missing tokens in config)");
      }

      // Refresh if expiring in <60s.
      if (!expiresAtMs || Date.now() > expiresAtMs - 60_000) {
        this.log.info("llm", "refreshing OpenAI OAuth token...");
        const refreshed = await openaiOauthRefresh({ refreshToken });
        accessToken = refreshed.accessToken;
        // Persist refreshed tokens in-memory only (MVP). GUI will add an explicit Save later.
        openai.oauth = {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          expiresAtMs: refreshed.expiresAtMs,
        };
        if (this._persistConfig && this._configRef) {
          try {
            await this._persistConfig(this._configRef);
          } catch (e) {
            this.log.warn("config", `failed to persist refreshed OAuth token: ${e?.message || e}`);
          }
        }
        this.log.info("llm", "token refreshed.");
      }

      return accessToken;
    }

    throw new Error(`Unsupported LLM provider: ${provider}`);
  }

  async _completeNpcJson({ config, prompt, timeoutMs = 90_000, traceMeta = null }) {
    const provider = this._getLlmProvider(config);
    const traceCtx = isPlainObject(traceMeta) ? traceMeta : {};

    this._trace("llm.request", {
      ...traceCtx,
      provider,
      timeoutMs,
      prompt: this._traceIncludePrompt ? String(prompt || "") : "[prompt omitted by trace setting]",
    });

    try {
      if (provider === "codex-cli") {
        const codex = this._getCodexCliConfig(config);
        const result = await codexCompleteStructured({
          prompt,
          model: codex.model,
          codexBin: codex.binPath,
          timeoutMs,
          cwd: process.cwd(),
        });
        if (!result?.ok) {
          throw new Error(result?.error || "codex-cli completion failed");
        }
        this._trace("llm.response", {
          ...traceCtx,
          provider,
          api: "codex-cli",
          parsed: result.parsed,
          raw: this._traceIncludeLlmRaw ? result.raw : "[omitted]",
          stdout: this._traceIncludeLlmRaw ? String(result?.stdout || "") : "[omitted]",
          stderr: this._traceIncludeLlmRaw ? String(result?.stderr || "") : "[omitted]",
        });
        return {
          api: "codex-cli",
          parsed: result.parsed,
          raw: result.raw,
          text: "",
          stdout: result.stdout || "",
          stderr: result.stderr || "",
        };
      }

      if (provider === "openai-api-key" || provider === "openai-oauth") {
        const openai = config?.llm?.openai || {};
        const baseUrl = String(openai.apiBaseUrl || "https://api.openai.com").trim();
        const model = String(openai.model || "gpt-5").trim();
        const apiKey = await this._getOpenAiApiKeyForConfig(config);
        const completion = await completeJson({
          baseUrl,
          apiKey,
          model,
          prompt,
          timeoutMs,
        });
        this._trace("llm.response", {
          ...traceCtx,
          provider,
          api: completion?.api || "unknown",
          model,
          baseUrl,
          parsed: completion?.parsed,
          text: this._traceIncludeLlmRaw ? String(completion?.text || "") : "[omitted]",
          raw: this._traceIncludeLlmRaw ? completion?.raw : "[omitted]",
        });
        return completion;
      }

      throw new Error(`Unsupported LLM provider: ${provider}`);
    } catch (e) {
      this._trace("llm.response.error", {
        ...traceCtx,
        provider,
        error: e,
      });
      throw e;
    }
  }

  _maybeLogOpenAiScopeHint(error, config) {
    const provider = this._getLlmProvider(config);
    if (provider !== "openai-oauth" && provider !== "openai-api-key") return;
    if (this._openAiScopeHintShown) return;
    const text = String(error?.message || error || "");
    if (!/missing scopes?:/i.test(text)) return;

    this._openAiScopeHintShown = true;
    this.log.warn(
      "llm",
      "OpenAI scopes are missing for API calls. Use codex-cli provider, then run Install Prerequisites and Codex Login."
    );
  }

  _formatFvttExecutionError(errorLike) {
    const raw = String(errorLike?.message || errorLike || "").trim();
    if (!raw) return "unknown error";

    const lower = raw.toLowerCase();
    if (lower.includes("no available spell slot")) {
      return "해당 주문을 시전할 주문 슬롯이 없습니다. 슬롯을 회복하거나 다른 행동을 지시해 주세요.";
    }
    if (lower.includes("different scene")) {
      return "대상 토큰이 다른 장면에 있어서 실행할 수 없습니다. NPC와 대상을 같은 장면에 두고 다시 시도해 주세요.";
    }
    if (lower.includes("target_dead") || lower.includes("hp is 0") || lower.includes("dead/defeated")) {
      return "대상이 이미 전투 불능 상태(HP 0 또는 사망/패배 상태)라 공격할 수 없습니다. 다른 대상을 지정해 주세요.";
    }
    if (lower.includes("target_not_in_combat") || lower.includes("not an active combat participant")) {
      return "현재 전투에 참여하지 않은 대상은 공격할 수 없습니다. 전투 참가 중인 대상을 지정해 주세요.";
    }
    if (lower.includes("actor token is not available on any scene") || lower.includes("no token on scene")) {
      return "NPC 토큰이 장면에 없어 실행할 수 없습니다. 토큰을 배치한 뒤 다시 시도해 주세요.";
    }
    if (
      lower.includes("displaycard produced unresolved message only") ||
      lower.includes("template placed but no resolved workflow message")
    ) {
      return "주문 카드는 생성됐지만 자동 굴림까지 완료하지 못했습니다. 주문 슬롯과 카드 버튼 자동 처리 상태를 확인해 주세요.";
    }

    // Avoid leaking unreadable mojibake text to Discord replies.
    if (/[�]/.test(raw) || /\?[^\s]{2,}/.test(raw)) {
      return "인코딩이 깨진 FVTT 오류가 발생했습니다. runtime-trace 로그를 확인해 주세요.";
    }

    return raw;
  }

  _applyFallbackIntentFromText({ text, intent, fvttSceneContext, allowFallback = true, allowRepair = true }) {
    const current = intent && typeof intent === "object" ? intent : { type: "none", args: {} };
    const fallback = inferFallbackIntentFromText({ text, sceneContext: fvttSceneContext });

    const repairOne = (step) => {
      const stepType = String(step?.type || "none").toLowerCase();
      const stepArgs = isPlainObject(step?.args) ? step.args : {};

      if (stepType === "move") {
        return {
          type: "move",
          args: enrichMoveArgsFromText({
            args: stepArgs,
            text,
            sceneContext: fvttSceneContext,
          }),
        };
      }
      if (stepType === "action") {
        return {
          type: "action",
          args: enrichActionArgsFromText({
            args: stepArgs,
            text,
            sceneContext: fvttSceneContext,
          }),
        };
      }
      if (stepType === "aoe") {
        return {
          type: "aoe",
          args: enrichAoeArgsFromText({
            args: stepArgs,
            text,
            sceneContext: fvttSceneContext,
          }),
        };
      }
      return {
        type: stepType,
        args: stepArgs,
      };
    };

    const type = String(current.type || "none").toLowerCase();
    if (allowRepair) {
      if (type === "plan") {
        const stepsRaw = Array.isArray(current?.args?.steps) ? current.args.steps : [];
        const repairedSteps = stepsRaw
          .map((step) => repairOne(step))
          .filter((step) =>
            [
              "say",
              "inspect",
              "move",
              "tokenmove",
              "action",
              "tokenaction",
              "targetset",
              "targetclear",
              "aoe",
              "image",
            ].includes(String(step?.type || ""))
          )
          .slice(0, 8);

        if (repairedSteps.length > 0) {
          const repairedPlan = { type: "plan", args: { steps: repairedSteps } };
          this.log.info(
            "llm",
            `intent repaired(plan): steps=${repairedSteps.map((s) => s.type).join("->")}`
          );
          this._trace("llm.intent.repaired", {
            kind: "plan",
            before: current,
            after: repairedPlan,
          });
          return repairedPlan;
        }
      } else if (type !== "none") {
        const repaired = repairOne(current);
        const repairedType = String(repaired?.type || "none");
        if (repairedType === "move" || repairedType === "action" || repairedType === "aoe") {
          this.log.info(
            "llm",
            `intent repaired: type=${repairedType} args=${compact(JSON.stringify(repaired.args), 240)}`
          );
        }
        this._trace("llm.intent.repaired", {
          kind: "single",
          before: current,
          after: repaired,
        });
        return repaired;
      }
    }

    if (type !== "none") return current;

    if (!allowFallback || !fallback) return current;
    this.log.info("llm", `fallback intent: type=${fallback.type} args=${compact(JSON.stringify(fallback.args), 240)}`);
    this._trace("llm.intent.fallback", {
      before: current,
      after: fallback,
    });
    return fallback;
  }

  _expandIntentToSteps(intent) {
    const current = intent && typeof intent === "object" ? intent : { type: "none", args: {} };
    const type = String(current.type || "none").toLowerCase();
    if (type === "none") return [];
    if (type !== "plan") {
      return [{ type, args: isPlainObject(current?.args) ? current.args : {} }];
    }

    const stepsRaw = Array.isArray(current?.args?.steps) ? current.args.steps : [];
    return stepsRaw
      .map((step) => ({
        type: String(step?.type || "").toLowerCase().trim(),
        args: isPlainObject(step?.args) ? step.args : {},
      }))
      .filter((step) =>
        [
          "say",
          "inspect",
          "move",
          "tokenmove",
          "action",
          "tokenaction",
          "targetset",
          "targetclear",
          "aoe",
          "image",
        ].includes(step.type)
      )
      .slice(0, 8);
  }

  _normalizeActionActivation(value) {
    const raw = String(value || "").toLowerCase().trim();
    if (!raw) return "action";
    if (raw.includes("bonus")) return "bonus";
    if (raw.includes("reaction")) return "reaction";
    if (raw.includes("special")) return "special";
    if (raw.includes("action")) return "action";
    return "action";
  }

  _buildActorActionActivationIndex(fvttActorSheet) {
    const index = new Map();
    const actions = ensureArray(fvttActorSheet?.actor?.actions);
    for (const action of actions) {
      const name = String(action?.name || "").trim();
      if (!name) continue;
      const key = normalizeTokenKey(name);
      if (!key) continue;
      if (!index.has(key)) {
        index.set(key, this._normalizeActionActivation(action?.activation));
      }
    }
    return index;
  }

  _resolveCombatStepActivation(step, activationIndex) {
    const type = String(step?.type || "").toLowerCase();
    if (!["action", "tokenaction", "aoe"].includes(type)) return "";

    const args = isPlainObject(step?.args) ? step.args : {};
    const actionName = String(args.actionName || "").trim();
    if (!actionName) return "action";

    const key = normalizeTokenKey(actionName);
    if (key && activationIndex.has(key)) {
      return this._normalizeActionActivation(activationIndex.get(key));
    }

    if (key) {
      for (const [candidateKey, candidateActivation] of activationIndex.entries()) {
        if (!candidateKey) continue;
        if (candidateKey.includes(key) || key.includes(candidateKey)) {
          return this._normalizeActionActivation(candidateActivation);
        }
      }
    }

    if (/(보너스|bonus)/i.test(actionName)) return "bonus";
    return "action";
  }

  _applyCombatTurnStepBudget({ steps, fvttActorSheet }) {
    const list = ensureArray(steps);
    const activationIndex = this._buildActorActionActivationIndex(fvttActorSheet);
    const limits = { say: 1, move: 1, action: 1, bonus: 1, actionSet: 4 };
    const usage = { say: 0, move: 0, action: 0, bonus: 0 };
    const kept = [];
    const skipped = [];

    for (let i = 0; i < list.length; i += 1) {
      const step = list[i];
      const type = String(step?.type || "").toLowerCase();
      if (!type) continue;

      if (kept.length >= limits.actionSet) {
        skipped.push({ index: i + 1, type, reason: "action-set-limit-exceeded" });
        continue;
      }

      if (type === "say") {
        if (usage.say >= limits.say) {
          skipped.push({ index: i + 1, type, reason: "say-budget-exceeded" });
          continue;
        }
        usage.say += 1;
        kept.push(step);
        continue;
      }

      if (type === "move" || type === "tokenmove") {
        if (usage.move >= limits.move) {
          skipped.push({ index: i + 1, type, reason: "move-budget-exceeded" });
          continue;
        }
        usage.move += 1;
        kept.push(step);
        continue;
      }

      if (type === "action" || type === "tokenaction" || type === "aoe") {
        const activation = this._resolveCombatStepActivation(step, activationIndex);
        if (activation === "reaction") {
          skipped.push({
            index: i + 1,
            type,
            activation,
            reason: "reaction-not-on-own-turn",
          });
          continue;
        }
        const budgetKey = activation === "bonus" ? "bonus" : "action";
        if (usage[budgetKey] >= limits[budgetKey]) {
          skipped.push({
            index: i + 1,
            type,
            activation,
            reason: `${budgetKey}-budget-exceeded`,
          });
          continue;
        }
        usage[budgetKey] += 1;
        kept.push(step);
        continue;
      }

      skipped.push({
        index: i + 1,
        type,
        reason: "unsupported-combat-action-set",
      });
    }

    return { steps: kept, limits, usage, skipped };
  }

  async _executeIntentPlan({ config, npc, intent, origin, strict = false, execution = {} }) {
    let steps = this._expandIntentToSteps(intent);
    if (!steps.length) return;
    const normalizedOrigin = String(origin || "").trim();

    if (normalizedOrigin === "combat-turn") {
      const budgeted = this._applyCombatTurnStepBudget({
        steps,
        fvttActorSheet: execution?.fvttActorSheet || null,
      });
      steps = budgeted.steps;
      this._trace("fvtt.combat.turn.economy", {
        npcId: npc?.id || "",
        limits: budgeted.limits,
        usage: budgeted.usage,
        skipped: budgeted.skipped,
        plannedSteps: steps,
      });
      if (budgeted.skipped.length > 0) {
        this.log.info(
          "combat",
          `turn economy filtered: ${budgeted.skipped.map((entry) => `${entry.type}:${entry.reason}`).join(", ")}`
        );
      }
      if (!steps.length) return;
    }

    const runtimeState = { moveConsumed: false };

    this._trace("fvtt.plan.start", {
      origin: normalizedOrigin,
      npcId: npc?.id || "",
      intentType: String(intent?.type || ""),
      strict: Boolean(strict),
      steps,
    });

    this.log.info("fvtt", `plan(${normalizedOrigin || "msg"}): ${steps.map((s) => s.type).join(" -> ")}`);
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      const executionHint = {
        origin: normalizedOrigin,
        allowAutoApproach: !runtimeState.moveConsumed,
      };
      this.log.info("fvtt", `plan step ${i + 1}/${steps.length}: ${step.type}`);
      this._trace("fvtt.plan.step.start", {
        origin: normalizedOrigin,
        npcId: npc?.id || "",
        index: i + 1,
        total: steps.length,
        step,
        strict: Boolean(strict),
        execution: {
          moveConsumed: runtimeState.moveConsumed,
          allowAutoApproach: executionHint.allowAutoApproach,
        },
      });
      let result = null;
      try {
        result = await this._executeNpcIntent({
          config,
          npc,
          intent: step,
          strict,
          execution: executionHint,
        });
      } catch (e) {
        this._trace("fvtt.plan.step.callback", {
          origin: normalizedOrigin,
          npcId: npc?.id || "",
          index: i + 1,
          total: steps.length,
          stepType: step?.type || "",
          callback: "Action:fail",
          error: e,
        });
        if (normalizedOrigin === "combat-turn") {
          this.log.warn("combat", `Action:fail step=${i + 1}/${steps.length} type=${step?.type || "unknown"}`);
        }
        throw e;
      }
      const callback = result?.ok === true ? "Action:ok" : "Action:fail";
      this._trace("fvtt.plan.step.callback", {
        origin: normalizedOrigin,
        npcId: npc?.id || "",
        index: i + 1,
        total: steps.length,
        stepType: step?.type || "",
        callback,
        result,
      });
      if (normalizedOrigin === "combat-turn") {
        const actionName = String(result?.actionName || "").trim();
        this.log.info(
          "combat",
          `${callback} step=${i + 1}/${steps.length} type=${step?.type || "unknown"}${actionName ? ` action=${actionName}` : ""}`
        );
      }
      if (result?.ok !== true) {
        throw new Error(`step callback failed: step=${i + 1}/${steps.length} type=${step?.type || "unknown"}`);
      }
      if (result?.moveConsumed) runtimeState.moveConsumed = true;
      this._trace("fvtt.plan.step.done", {
        origin: normalizedOrigin,
        npcId: npc?.id || "",
        index: i + 1,
        total: steps.length,
        stepType: step?.type || "",
        strict: Boolean(strict),
        execution: {
          moveConsumed: runtimeState.moveConsumed,
          allowAutoApproach: executionHint.allowAutoApproach,
        },
        result,
      });
      if (i + 1 < steps.length) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    this._trace("fvtt.plan.done", {
      origin: normalizedOrigin,
      npcId: npc?.id || "",
      strict: Boolean(strict),
      stepsCount: steps.length,
      moveConsumed: runtimeState.moveConsumed,
    });
  }

  async _handleNpcDiscordMessage({ config, npc, message, text }) {
    const npcName = String(npc?.displayName || npc?.id || "NPC");
    this.log.info("discord", `inbound -> ${npcName}: ${compact(text, 180)}`);
    this._trace("discord.handle.start", {
      npcId: npc?.id || "",
      npcName,
      messageId: String(message?.id || ""),
      channelId: String(message?.channel?.id || ""),
      channelName: String(message?.channel?.name || ""),
      userId: String(message?.author?.id || ""),
      userName: String(message?.author?.username || message?.author?.displayName || ""),
      text: String(text || ""),
    });

    let fvttReady = false;
    let fvttChatContext = [];
    let fvttSceneContext = null;
    let fvttActorSheet = null;
    let mentionedSceneTokens = [];

    if (this.fvtt && config?.foundry?.enabled) {
      const connected = await this.fvtt.ensureConnected();
      fvttReady = Boolean(connected.ok);
      this._trace("fvtt.ensureConnected", {
        origin: "discord",
        npcId: npc?.id || "",
        connected: fvttReady,
        detail: connected?.error || "",
      });
      if (fvttReady) {
        // Pull context.
        try {
          const chat = await this.fvtt.getRecentChat(10);
          if (chat?.ok) fvttChatContext = chat.messages || [];
        } catch (e) {
          this.log.warn("fvtt", `chat context failed: ${e?.message || e}`);
          fvttReady = false;
        }
      }

      if (fvttReady) {
        try {
          fvttSceneContext = await this._withNpcActor(npc, () => this.fvtt.getSceneContext(60));
        } catch (e) {
          this.log.warn("fvtt", `scene context failed: ${e?.message || e}`);
          fvttReady = false;
        }
      }

      if (fvttReady) {
        try {
          fvttActorSheet = await this._withNpcActor(npc, () => this.fvtt.getActorSheet());
        } catch (e) {
          this.log.warn("fvtt", `actor sheet failed: ${e?.message || e}`);
        }
      }

      if (fvttReady) {
        try {
          const sceneTokens = await this.fvtt.listSceneTokens();
          if (sceneTokens?.ok) {
            mentionedSceneTokens = collectMentionedSceneTokens({
              text,
              sceneTokens: sceneTokens.tokens,
              limit: 4,
            });
          }
        } catch (e) {
          this.log.warn("fvtt", `scene token list failed: ${e?.message || e}`);
        }
      }
    }

    if (this._traceIncludeContexts) {
      this._trace("discord.handle.context", {
        npcId: npc?.id || "",
        fvttReady,
        chat: fvttChatContext,
        scene: fvttSceneContext,
        actorSheet: fvttActorSheet,
        mentionedSceneTokens,
      });
    }

    const speakerHint = String(message?.member?.displayName || message?.author?.displayName || message?.author?.username || "").trim();
    const reactionGate = evaluateNpcReactionDistance({
      npc,
      sceneContext: fvttSceneContext,
      text,
      speakerHint,
      preferSpeaker: true,
      allowTextFallback: false,
    });
    this._trace("npc.reaction.gate", {
      origin: "discord",
      npcId: npc?.id || "",
      npcName,
      speakerHint,
      gate: reactionGate,
    });
    if (reactionGate.enabled && !reactionGate.allowed) {
      const sourceName = reactionGate.sourceTokenName || reactionGate.sourceTokenId || speakerHint || "unknown";
      const distText = Number.isFinite(Number(reactionGate.distanceFt))
        ? `${Number(reactionGate.distanceFt)}ft`
        : "?ft";
      this.log.info(
        "discord",
        `skip inbound (${npcName}): source=${sourceName} dist=${distText} allowed<=${reactionGate.maxFt}ft`
      );
      return;
    }

    const personaText = await loadNpcPromptDocs({ config, npc });

    let replyText = "";
    let intent = { type: "none", args: {} };
    let strictExecution = false;

    const prompt = buildNpcPrompt({
      npc,
      inboundText: text,
      fvttReady,
      personaText,
      fvttChatContext,
      fvttSceneContext,
      fvttActorSheet,
      mentionedSceneTokens,
      imageGeneration: normalizeNpcImageGenerationState({ config, npc }),
    });

    try {
      const completion = await this._completeNpcJson({
        config,
        prompt,
        timeoutMs: 90_000,
        traceMeta: {
          origin: "discord",
          npcId: npc?.id || "",
          npcName,
          userId: String(message?.author?.id || ""),
          messageId: String(message?.id || ""),
        },
      });
      const normalized = normalizeIntent(completion.parsed);
      const actionTag = extractFvttActionTags(normalized.replyText);
      replyText = actionTag.hadTag ? actionTag.visibleText || "(...)" : normalized.replyText || "(...)";

      let baseIntent = normalized.intent;
      let allowFallback = true;
      let allowRepair = true;
      let actionIntentSource = "intent";
      if (actionTag.hadTag) {
        if (actionTag.actions.length > 0) {
          baseIntent = buildIntentFromActionTags(actionTag.actions);
          allowFallback = false;
          allowRepair = false;
          strictExecution = true;
          actionIntentSource = "tag-strict";
        } else if (actionTag.hadExplicitNone && actionTag.parseErrors.length === 0) {
          baseIntent = { type: "none", args: {} };
          allowFallback = false;
          allowRepair = false;
          strictExecution = true;
          actionIntentSource = "tag-none";
        }
      }
      if (!actionTag.hadTag && String(baseIntent?.type || "none").toLowerCase() === "plan") {
        allowFallback = false;
        allowRepair = false;
        strictExecution = true;
        actionIntentSource = "intent-plan-strict";
      }

      intent = this._applyFallbackIntentFromText({
        text,
        intent: baseIntent,
        fvttSceneContext,
        allowFallback,
        allowRepair,
      });
      this._trace("llm.intent.discord", {
        npcId: npc?.id || "",
        messageId: String(message?.id || ""),
        replyText,
        actionTag,
        normalizedIntent: normalized.intent,
        actionIntentSource,
        strictExecution,
        repairedIntent: intent,
      });
      this.log.info("llm", `intent(discord): type=${intent.type} args=${compact(JSON.stringify(intent.args), 220)}`);
    } catch (e) {
      this.log.error("llm", `LLM failed: ${e?.message || e}`);
      this._maybeLogOpenAiScopeHint(e, config);
      this._trace("llm.error.discord", { npcId: npc?.id || "", messageId: String(message?.id || ""), error: e });
      replyText = "I had a response error just now. Please try again in a moment.";
      intent = { type: "none", args: {} };
    }

    // Execute intent (MVP subset)
    let actionNote = "";
    if (fvttReady && this.fvtt && intent?.type && intent.type !== "none") {
      try {
        this._trace("fvtt.intent.execute.start", {
          origin: "discord",
          npcId: npc?.id || "",
          intent,
          strictExecution,
        });
        await this._executeIntentPlan({ config, npc, intent, origin: "discord", strict: strictExecution });
        this._trace("fvtt.intent.execute.done", {
          origin: "discord",
          npcId: npc?.id || "",
          intentType: intent?.type || "none",
        });
      } catch (e) {
        const displayError = this._formatFvttExecutionError(e);
        actionNote = `\n(FVTT 동작 실행 실패: ${displayError})`;
        this._trace("fvtt.intent.execute.error", {
          origin: "discord",
          npcId: npc?.id || "",
          error: e,
          intent,
        });
      }
    }

    // Speak in FVTT (best effort) if online
    if (fvttReady && this.fvtt) {
      try {
        await this._withNpcActor(npc, () => this.fvtt.speakAsActor(replyText));
        this._trace("fvtt.speak.outbound", {
          origin: "discord",
          npcId: npc?.id || "",
          npcName,
          text: replyText,
        });
      } catch (e) {
        this.log.warn("fvtt", `speak failed: ${e?.message || e}`);
        this._trace("fvtt.speak.error", { origin: "discord", npcId: npc?.id || "", error: e });
      }
    }

    try {
      const sent = await message.reply(replyText + actionNote);
      this._trace("discord.outbound.reply", {
        npcId: npc?.id || "",
        npcName,
        requestMessageId: String(message?.id || ""),
        replyMessageId: String(sent?.id || ""),
        text: String(replyText + actionNote),
      });
    } catch (e) {
      this._trace("discord.outbound.reply.error", {
        npcId: npc?.id || "",
        requestMessageId: String(message?.id || ""),
        error: e,
      });
    }
  }

  async _pickAutoTargetTokenRef(npc) {
    try {
      const scene = await this._withNpcActor(npc, () => this.fvtt.getSceneContext(30));
      if (!scene?.ok) return null;

      const selfTokenId = String(scene?.actorToken?.id || "").trim();
      const selected = ensureArray(scene.targets)
        .filter((token) => isTokenSelectableTarget(token, scene, selfTokenId))
        .map((t) => String(t?.id || "").trim())
        .find(Boolean);
      if (selected) return selected;

      const tokens = ensureArray(scene.tokens).filter((token) => isTokenSelectableTarget(token, scene, selfTokenId));
      if (!tokens.length) return null;

      const hostiles = tokens.filter((token) => Number(token?.disposition) < 0);
      const pool = hostiles.length ? hostiles : tokens;
      pool.sort((a, b) => {
        const ao = Number.isFinite(Number(a?.orthDistanceFt)) ? Number(a.orthDistanceFt) : Number.POSITIVE_INFINITY;
        const bo = Number.isFinite(Number(b?.orthDistanceFt)) ? Number(b.orthDistanceFt) : Number.POSITIVE_INFINITY;
        if (ao !== bo) return ao - bo;
        const ad = Number.isFinite(Number(a?.distanceFt)) ? Number(a.distanceFt) : Number.POSITIVE_INFINITY;
        const bd = Number.isFinite(Number(b?.distanceFt)) ? Number(b.distanceFt) : Number.POSITIVE_INFINITY;
        if (ad !== bd) return ad - bd;
        return String(a?.name || "").localeCompare(String(b?.name || ""), "ko");
      });
      return String(pool[0]?.id || "").trim() || null;
    } catch {
      return null;
    }
  }

  async _deriveMoveFromTarget({ npc, targetTokenRef }) {
    const ref = String(targetTokenRef || "").trim();
    if (!ref) return null;
    try {
      const scene = await this._withNpcActor(npc, () => this.fvtt.getSceneContext(40));
      if (!scene?.ok) return null;
      const target = findTokenByRefInSceneContext(scene, ref) || findMentionedTokenByName(scene, ref) || null;
      if (!target) return null;

      const direction = directionFromDelta(target?.dxCells, target?.dyCells);
      if (!direction) return null;

      let amount = null;
      if (Number.isFinite(Number(target?.orthDistanceFt))) {
        amount = Math.max(1, Math.round(Number(target.orthDistanceFt) / 5));
      } else if (Number.isFinite(Number(target?.dxCells)) || Number.isFinite(Number(target?.dyCells))) {
        amount = Math.max(Math.abs(Number(target?.dxCells || 0)), Math.abs(Number(target?.dyCells || 0)), 1);
      }
      return {
        direction,
        amount: Number.isFinite(Number(amount)) && Number(amount) > 0 ? Number(amount) : 1,
        unit: "grid",
        targetName: String(target?.name || target?.id || "").trim(),
      };
    } catch {
      return null;
    }
  }

  async _executeNpcImageIntent({ config, npc, args, strict = false }) {
    const state = normalizeNpcImageGenerationState({ config, npc });
    const npcName = String(npc?.displayName || npc?.id || "NPC");
    if (!state.enabled) {
      const reason = state.configured
        ? "image generation disabled for this NPC"
        : "image generation not configured (missing SD WebUI URL)";
      if (strict) throw new Error(reason);
      this.log.info("image", `skip (${npcName}): ${reason}`);
      this._trace("sd.image.skip", {
        npcId: npc?.id || "",
        npcName,
        reason,
      });
      return { ok: false, skipped: true, reason };
    }

    const extraPrompt = normalizeImagePromptText(
      args?.prompt || args?.extraPrompt || args?.promptText || args?.tags || args?.text || ""
    );
    const reasonText = normalizeImagePromptText(args?.reason || args?.trigger || args?.context || "");
    let imageActorSheet = null;
    let imageSceneContext = null;
    let imageCombatState = null;
    if (this.fvtt) {
      try {
        imageActorSheet = await this._withNpcActor(npc, () => this.fvtt.getActorSheet());
        imageSceneContext = await this._withNpcActor(npc, () => this.fvtt.getSceneContext(30));
        imageCombatState = await this._withNpcActor(npc, () => this.fvtt.getActorCombatState());
      } catch {
        // Ignore context fetch failures and continue with provided prompt.
      }
    }
    const situationPrompt = buildImageSituationPrompt({
      actorSheet: imageActorSheet,
      sceneContext: imageSceneContext,
      combatState: imageCombatState,
    });
    const mergedExtraPrompt = [extraPrompt, situationPrompt].filter(Boolean).join(", ");
    const finalPrompt = buildImagePrompt({
      npcName,
      baseTags: state.defaultPrompt,
      extraPrompt: mergedExtraPrompt,
    });
    const endpoint = `${state.webuiUrl}/sdapi/v1/txt2img`;

    this._trace("sd.image.request", {
      npcId: npc?.id || "",
      npcName,
      endpoint,
      width: state.width,
      height: state.height,
      reason: reasonText,
      userPrompt: compact(extraPrompt, 240),
      situationPrompt: compact(situationPrompt, 240),
      prompt: compact(finalPrompt, 280),
    });

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), state.timeoutMs);

    let response = null;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: finalPrompt,
          width: state.width,
          height: state.height,
          batch_size: 1,
          n_iter: 1,
        }),
        signal: controller.signal,
      });
    } catch (e) {
      const message = e?.name === "AbortError" ? "SD WebUI request timed out" : String(e?.message || e);
      throw new Error(`image generation request failed: ${message}`);
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (!response?.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `image generation failed: HTTP ${Number(response.status || 0)} ${compact(body || response.statusText || "", 220)}`
      );
    }

    const data = await response.json().catch(() => null);
    const rawImage = Array.isArray(data?.images) && data.images.length > 0 ? String(data.images[0] || "") : "";
    if (!rawImage.trim()) {
      throw new Error("image generation failed: SD WebUI returned no images");
    }

    const base64 = rawImage.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "").trim();
    if (!base64) {
      throw new Error("image generation failed: empty image payload");
    }
    const dataUrl = `data:image/png;base64,${base64}`;
    const caption = reasonText ? `${npcName} - ${reasonText}` : `${npcName} image`;
    const html = [
      `<div class=\"npc-image-message\">`,
      `<p><strong>${escapeHtml(caption)}</strong></p>`,
      `<p><small>${escapeHtml(compact(finalPrompt, 220))}</small></p>`,
      `<img src=\"${dataUrl}\" alt=\"${escapeHtml(caption)}\" style=\"max-width:100%;height:auto;border-radius:8px;\" />`,
      `</div>`,
    ].join("");

    const speak = await this._withNpcActor(npc, () => this.fvtt.speakAsActor(html));
    if (!speak?.ok) {
      throw new Error(String(speak?.error || "failed to post image to FVTT chat"));
    }

    this.log.info("image", `generated: ${npcName} ${state.width}x${state.height}`);
    this._trace("sd.image.generated", {
      npcId: npc?.id || "",
      npcName,
      width: state.width,
      height: state.height,
      reason: reasonText,
      prompt: compact(finalPrompt, 280),
      messageId: String(speak?.messageId || ""),
    });
    return {
      ok: true,
      width: state.width,
      height: state.height,
      reason: reasonText,
      prompt: finalPrompt,
      messageId: String(speak?.messageId || ""),
    };
  }

  async _executeNpcIntent({ config, npc, intent, strict = false, execution = {} }) {
    const type = String(intent?.type || "none").toLowerCase();
    const args = isPlainObject(intent?.args) ? intent.args : {};
    const allowAutoApproach = execution?.allowAutoApproach !== false;

    if (!this.fvtt) throw new Error("FVTT not configured");
    this._trace("fvtt.intent.step", {
      npcId: npc?.id || "",
      type,
      args,
      strict: Boolean(strict),
      execution: {
        allowAutoApproach,
        origin: String(execution?.origin || ""),
      },
    });

    if (type === "say") {
      const text = String(args.text || "").trim();
      if (!text) return { ok: true, moveConsumed: false, skipped: true };
      const result = await this._withNpcActor(npc, () => this.fvtt.speakAsActor(text));
      this._trace("fvtt.say.response", { npcId: npc?.id || "", text, result });
      if (!result?.ok) {
        throw new Error(String(result?.error || "say failed"));
      }
      this.log.info("fvtt", `say ok: ${compact(text, 120)}`);
      return { ok: true, moveConsumed: false, saidText: text };
    }

    if (type === "inspect") {
      const what = String(args.what || "").toLowerCase();
      if (what === "sheet") {
        const sheet = await this._withNpcActor(npc, () => this.fvtt.getActorSheet());
        this.log.info("fvtt", `sheet ok=${sheet?.ok}`);
        this._trace("fvtt.inspect.result", { npcId: npc?.id || "", what, result: sheet });
        return { ok: true, moveConsumed: false };
      }
      if (what === "context") {
        const ctx = await this._withNpcActor(npc, () => this.fvtt.getSceneContext(20));
        this.log.info("fvtt", `context ok=${ctx?.ok}`);
        this._trace("fvtt.inspect.result", { npcId: npc?.id || "", what, result: ctx });
        return { ok: true, moveConsumed: false };
      }
      if (what === "chatlog") {
        const log = await this.fvtt.getRecentChat(10);
        this.log.info("fvtt", `chatlog ok=${log?.ok}`);
        this._trace("fvtt.inspect.result", { npcId: npc?.id || "", what, result: log });
        return { ok: true, moveConsumed: false };
      }
      return { ok: true, moveConsumed: false, skipped: true };
    }

    if (type === "image") {
      await this._executeNpcImageIntent({ config, npc, args, strict });
      return { ok: true, moveConsumed: false };
    }

    if (type === "targetset") {
      const tokenRef = String(args.tokenRef || args.targetTokenRef || args.targetRef || "").trim();
      if (!tokenRef) return { ok: true, moveConsumed: false, skipped: true };
      const result = await this._withNpcActor(npc, () => this.fvtt.setActorTarget(tokenRef));
      this._trace("fvtt.targetset.response", { npcId: npc?.id || "", tokenRef, result });
      if (!result?.ok) {
        throw new Error(String(result?.error || "targetset failed"));
      }
      this.log.info("fvtt", `target set: ${tokenRef}`);
      return { ok: true, moveConsumed: false };
    }

    if (type === "targetclear") {
      const result = await this._withNpcActor(npc, () => this.fvtt.clearActorTargets());
      this._trace("fvtt.targetclear.response", { npcId: npc?.id || "", result });
      if (!result?.ok) {
        throw new Error(String(result?.error || "targetclear failed"));
      }
      this.log.info("fvtt", "targets cleared");
      return { ok: true, moveConsumed: false };
    }

    if (type === "move") {
      let targetTokenRef = String(args.targetTokenRef || "").trim() || null;
      if (!strict && !targetTokenRef) {
        targetTokenRef = await this._pickAutoTargetTokenRef(npc);
      }
      let direction = String(args.direction || "").toUpperCase().trim();
      let amount = Number(args.amount || 1);
      let unit = String(args.unit || "grid").toLowerCase() === "ft" ? "ft" : "grid";
      const difficult = Boolean(args.difficult);

      if (!direction && targetTokenRef) {
        const derived = await this._deriveMoveFromTarget({ npc, targetTokenRef });
        if (derived?.direction) {
          direction = String(derived.direction).toUpperCase();
          if (!Number.isFinite(amount) || amount <= 0) {
            amount = Number(derived.amount || 1);
          }
          if (!args.unit && derived.unit) {
            unit = String(derived.unit) === "ft" ? "ft" : "grid";
          }
          this.log.info(
            "fvtt",
            `move derived from target: ${derived.targetName || targetTokenRef} direction=${direction} amount=${amount}${unit}`
          );
        }
      }

      if (!strict && !direction) {
        const nearestTarget = await this._pickAutoTargetTokenRef(npc);
        if (nearestTarget && nearestTarget !== targetTokenRef) {
          const derived = await this._deriveMoveFromTarget({ npc, targetTokenRef: nearestTarget });
          if (derived?.direction) {
            direction = String(derived.direction).toUpperCase();
            if (!Number.isFinite(amount) || amount <= 0) {
              amount = Number(derived.amount || 1);
            }
            targetTokenRef = nearestTarget;
            this.log.info(
              "fvtt",
              `move re-derived from nearest target: ${derived.targetName || nearestTarget} direction=${direction} amount=${amount}${unit}`
            );
          }
        }
      }

      if (!direction) {
        throw new Error("move failed: direction is missing");
      }

      const move = {
        type: "move",
        direction,
        amount: Number.isFinite(amount) && amount > 0 ? amount : 1,
        unit,
        maxRequested: false,
        difficult,
        raw: "llm-move",
      };
      this._trace("fvtt.move.request", {
        npcId: npc?.id || "",
        targetTokenRef: targetTokenRef || "",
        move,
      });
      const result = await this._withNpcActor(npc, () =>
        this.fvtt.moveToken(move, config?.npc?.difficultTerrainMultiplier || 2)
      );
      this._trace("fvtt.move.response", { npcId: npc?.id || "", result });
      if (!result?.ok) {
        const detail = String(result?.detail || "").trim();
        throw new Error([result?.error || "move failed", detail].filter(Boolean).join(" | "));
      }
      const finalX = Number(result?.token?.x);
      const finalY = Number(result?.token?.y);
      this.log.info(
        "fvtt",
        `move ok: direction=${direction} amount=${move.amount}${unit}${Number.isFinite(finalX) && Number.isFinite(finalY) ? ` -> (${finalX},${finalY})` : ""}`
      );
      return { ok: true, moveConsumed: true };
    }

    if (type === "tokenmove") {
      const tokenRef = String(args.tokenRef || "").trim();
      if (!tokenRef) throw new Error("tokenmove failed: tokenRef is missing");
      const direction = String(args.direction || "").toUpperCase().trim();
      if (!direction) throw new Error("tokenmove failed: direction is missing");
      const move = {
        type: "move",
        direction,
        amount: Number.isFinite(Number(args.amount)) && Number(args.amount) > 0 ? Number(args.amount) : 1,
        unit: String(args.unit || "grid").toLowerCase() === "ft" ? "ft" : "grid",
        maxRequested: false,
        difficult: Boolean(args.difficult),
        raw: "llm-token-move",
      };
      this._trace("fvtt.tokenmove.request", { npcId: npc?.id || "", tokenRef, move });
      const result = await this._withNpcActor(npc, () =>
        this.fvtt.moveTokenByRef(tokenRef, move, config?.npc?.difficultTerrainMultiplier || 2)
      );
      this._trace("fvtt.tokenmove.response", { npcId: npc?.id || "", result });
      if (!result?.ok) {
        const detail = String(result?.detail || "").trim();
        throw new Error([result?.error || "tokenmove failed", detail].filter(Boolean).join(" | "));
      }
      this.log.info("fvtt", `tokenmove ok: ${tokenRef} ${direction}${move.amount}${move.unit}`);
      return { ok: true, moveConsumed: true };
    }

    if (type === "action") {
      let actionName = String(args.actionName || "").trim();
      let targetTokenRef = String(args.targetTokenRef || "").trim() || null;
      if (!strict && !targetTokenRef) {
        targetTokenRef = await this._pickAutoTargetTokenRef(npc);
      }
      if (!actionName) {
        if (strict) throw new Error("action failed: actionName is missing");
        actionName = "공격";
      }
      this._trace("fvtt.action.request", {
        npcId: npc?.id || "",
        actionName,
        targetTokenRef: targetTokenRef || "",
        allowAutoApproach,
      });
      const result = await this._withNpcActor(npc, () =>
        allowAutoApproach
          ? this.fvtt.useActorActionSmart(actionName, targetTokenRef)
          : this.fvtt.useActorAction(actionName, targetTokenRef)
      );
      this._trace("fvtt.action.response", { npcId: npc?.id || "", result });
      let finalResult = result;
      if (!result?.ok) {
        const template = result?.action?.template || null;
        const templateType = String(template?.type || "")
          .trim()
          .toLowerCase();
        const templateSizeFt = Number(template?.size ?? 0) || 0;
        const rangeText = String(result?.action?.range || "")
          .trim()
          .toLowerCase();
        const slotBlocked =
          String(result?.errorCode || "")
            .trim()
            .toUpperCase() === "NO_SPELL_SLOT" || /no available spell slot/i.test(String(result?.error || ""));
        const canRetryAsAoe =
          !slotBlocked && Boolean(targetTokenRef) && Boolean(templateType) && templateSizeFt > 0 && !/\b(self|spec)\b/.test(rangeText);

        if (canRetryAsAoe) {
          const aoe = {
            centerTokenRef: targetTokenRef,
            placeTemplate: true,
            includeSelf: false,
            includeHostileOnly: false,
          };
          if (templateType === "sphere" || templateType === "circle") {
            aoe.shape = "circle";
            aoe.radiusFt = templateSizeFt;
          } else if (templateType === "cone") {
            aoe.shape = "cone";
            aoe.lengthFt = templateSizeFt;
            aoe.angleDeg = Math.max(1, Number(template?.width ?? 60) || 60);
          } else {
            aoe.shape = "line";
            aoe.lengthFt = templateSizeFt;
            aoe.widthFt = Math.max(1, Number(template?.width ?? 5) || 5);
          }

          this._trace("fvtt.action.retry_aoe.request", {
            npcId: npc?.id || "",
            actionName,
            targetTokenRef: targetTokenRef || "",
            aoe,
          });
          const retry = await this._withNpcActor(npc, () => this.fvtt.useActorActionAoe(actionName, aoe));
          this._trace("fvtt.action.retry_aoe.response", { npcId: npc?.id || "", result: retry });
          if (retry?.ok) {
            finalResult = retry;
          }
        }
      }
      if (!finalResult?.ok) {
        const detail = String(finalResult?.detail || "").trim();
        throw new Error([finalResult?.error || "action failed", detail].filter(Boolean).join(" | "));
      }
      const resolvedAction = String(finalResult?.action?.name || actionName);
      const resolvedTarget = String(finalResult?.target?.name || finalResult?.target?.id || targetTokenRef || "").trim();
      this.log.info(
        "fvtt",
        `action ok: ${resolvedAction}${resolvedTarget ? ` -> ${resolvedTarget}` : ""}${finalResult?.autoResolved ? ` (${finalResult.autoResolved})` : ""}`
      );
      return {
        ok: true,
        moveConsumed: Boolean(finalResult?.approach?.moved),
        actionActivation: this._normalizeActionActivation(finalResult?.action?.activation),
        actionName: resolvedAction,
      };
    }

    if (type === "tokenaction") {
      const tokenRef = String(args.tokenRef || "").trim();
      if (!tokenRef) throw new Error("tokenaction failed: tokenRef is missing");
      let actionName = String(args.actionName || "").trim();
      if (!actionName) {
        if (strict) throw new Error("tokenaction failed: actionName is missing");
        actionName = "공격";
      }
      const targetTokenRef = String(args.targetTokenRef || args.targetRef || "").trim() || null;
      this._trace("fvtt.tokenaction.request", {
        npcId: npc?.id || "",
        tokenRef,
        actionName,
        targetTokenRef: targetTokenRef || "",
        allowAutoApproach,
      });
      const result = await this._withNpcActor(npc, () =>
        allowAutoApproach
          ? this.fvtt.useTokenActionSmart(tokenRef, actionName, targetTokenRef)
          : this.fvtt.useTokenAction(tokenRef, actionName, targetTokenRef)
      );
      this._trace("fvtt.tokenaction.response", { npcId: npc?.id || "", result });
      if (!result?.ok) {
        const detail = String(result?.detail || "").trim();
        throw new Error([result?.error || "tokenaction failed", detail].filter(Boolean).join(" | "));
      }
      const resolvedAction = String(result?.action?.name || actionName);
      const resolvedTarget = String(result?.target?.name || result?.target?.id || targetTokenRef || "").trim();
      this.log.info(
        "fvtt",
        `tokenaction ok: ${tokenRef} ${resolvedAction}${resolvedTarget ? ` -> ${resolvedTarget}` : ""}`
      );
      return {
        ok: true,
        moveConsumed: Boolean(result?.approach?.moved),
        actionActivation: this._normalizeActionActivation(result?.action?.activation),
        actionName: resolvedAction,
      };
    }

    if (type === "aoe") {
      const actionName = String(args.actionName || "").trim();
      if (!actionName) {
        if (strict) throw new Error("aoe failed: actionName is missing");
        return { ok: true, moveConsumed: false, skipped: true };
      }
      let centerTokenRef = String(args.centerTokenRef || "").trim() || null;
      if (!strict && !centerTokenRef) {
        centerTokenRef = await this._pickAutoTargetTokenRef(npc);
      }
      const aoe = {
        shape: String(args.shape || "circle"),
        radiusFt: Number(args.radiusFt || 15),
        lengthFt: Number(args.lengthFt || 15),
        widthFt: Number(args.widthFt || 5),
        angleDeg: Number(args.angleDeg || 60),
        centerTokenRef,
        direction: String(args.direction || "").trim() || null,
        includeSelf: Boolean(args.includeSelf),
        includeHostileOnly: Boolean(args.includeHostileOnly),
        placeTemplate: args.placeTemplate !== false,
      };
      if (Number.isFinite(Number(args.centerX)) && Number.isFinite(Number(args.centerY))) {
        aoe.centerX = Number(args.centerX);
        aoe.centerY = Number(args.centerY);
      }
      this._trace("fvtt.aoe.request", { npcId: npc?.id || "", actionName, aoe });
      const result = await this._withNpcActor(npc, () => this.fvtt.useActorActionAoe(actionName, aoe));
      this._trace("fvtt.aoe.response", { npcId: npc?.id || "", result });
      if (!result?.ok) {
        const detail = String(result?.detail || "").trim();
        throw new Error([result?.error || "aoe failed", detail].filter(Boolean).join(" | "));
      }
      this.log.info(
        "fvtt",
        `aoe ok: ${actionName}${centerTokenRef ? ` center=${centerTokenRef}` : ""}${result?.autoResolved ? ` (${result.autoResolved})` : ""}`
      );
      return {
        ok: true,
        moveConsumed: false,
        actionActivation: this._normalizeActionActivation(result?.action?.activation),
        actionName,
      };
    }

    return { ok: true, moveConsumed: false, skipped: true };
  }

  // Expose OAuth login for future GUI integration
  async oauthLoginOpenAiCodex({ openUrl, prompt }) {
    return openaiOauthLogin({ openUrl, prompt });
  }

  async getCodexLoginStatusForUser({ config } = {}) {
    const codex = this._getCodexCliConfig(config || {});
    return getCodexLoginStatus({ codexBin: codex.binPath });
  }

  async launchCodexLoginForUser({ config } = {}) {
    const codex = this._getCodexCliConfig(config || {});
    return launchCodexLogin({ codexBin: codex.binPath });
  }

  async ensurePrerequisitesForConfig({ config } = {}) {
    const cfg = config || {};
    const provider = this._getLlmProvider(cfg);
    if (provider !== "codex-cli") {
      return {
        ok: true,
        provider,
        detail: "no auto-install prerequisites required for this provider",
      };
    }
    return ensureCodexPrerequisites({
      config: cfg,
      onLog: (line) => this.log.info("setup", line),
    });
  }
}

module.exports = { AppRuntime };

