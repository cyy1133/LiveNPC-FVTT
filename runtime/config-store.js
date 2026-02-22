const fs = require("node:fs/promises");
const path = require("node:path");

const FALLBACK_WORLD_MD = `# Shared World Lore (Default)

- System: DND 5e.
- Tone: medieval fantasy.
- Speech: natural in-world speech, avoid modern slang.
- Behavior: keep character consistency and act within world logic.
- Safety: refuse disallowed content briefly in-character and redirect.
`;

const FALLBACK_NPC_MD = `# NPC Persona (Default)

- Keep in-character.
- Speak as a living person in this world, not as an AI/system.
- Use concise dialogue unless the user asks for long narration.
- Prioritize cooperation with party goals unless explicitly conflicted.
`;

const FALLBACK_BATTLE_MD = `# Battle Pattern (Default)

1. Confirm visible enemies and current target.
2. Prefer legal, reliable actions that can finish this turn.
3. If spell slots are low/unavailable, prefer cantrip or weapon attack.
4. If target is out of range, approach first, then attack if possible.
5. Avoid wasting turns; always end with the most effective valid action.
`;

const FALLBACK_DND5E_BATTLE_RULES_MD = `# DND5e Battle Rules (Shared)

These are hard constraints for all NPC battle decisions.

1. Action economy per turn:
- Movement: up to speed once per turn.
- Action: at most 1.
- Bonus Action: at most 1, and only when a valid feature/spell allows it.
- Reaction: not part of normal turn sequence; usually outside own turn.

2. Do not perform two Action-cost activities in one turn.
- Example: weapon attack + Vicious Mockery (both Action) is normally illegal in the same turn.

3. Concentration:
- A creature can concentrate on only one spell at a time.
- Casting another concentration spell ends the previous concentration.
- If concentration is active, avoid replacing it unless tactically necessary.

4. Target validity:
- Do not target creatures with HP 0, defeated/dead/dying conditions, or otherwise removed from combat.
- During active combat, hostile targets should be selected from active combat participants.

5. Resource validity:
- Leveled spells require available spell slots.
- If slots are unavailable, prefer cantrip/weapon/action alternatives.

6. End-turn discipline:
- If no legal effective action remains, end the turn.
`;

const DEFAULT_DIANA_IMAGE_TAGS = "female knight, dark fantasy, dramatic lighting, full body";

function getDefaultConfigPath(appDataDir) {
  return path.join(String(appDataDir || "."), "config.json");
}

function ensureTrailingNewline(text) {
  const t = String(text || "");
  return t.endsWith("\n") ? t : `${t}\n`;
}

async function readTemplateOrFallback(templateFile, fallbackText) {
  const p = path.join(__dirname, "default-prompts", templateFile);
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return ensureTrailingNewline(fallbackText);
  }
}

async function writeFileIfMissing(filePath, text) {
  try {
    await fs.access(filePath);
    return;
  } catch {
    // missing -> create
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, ensureTrailingNewline(text), "utf8");
}

async function ensureDefaultPersonaFiles(baseDir) {
  const dir = String(baseDir || "").trim() || path.resolve(process.cwd(), "persona-defaults");
  const out = {
    world: path.join(dir, "world.md"),
    npc: path.join(dir, "npc.md"),
    battle: path.join(dir, "battlePattern.md"),
    battleRules: path.join(dir, "dnd5e-battle-rules.md"),
  };

  const [worldTpl, npcTpl, battleTpl, sharedBattleRulesTpl] = await Promise.all([
    readTemplateOrFallback("world.md", FALLBACK_WORLD_MD),
    readTemplateOrFallback("npc.md", FALLBACK_NPC_MD),
    readTemplateOrFallback("battlePattern.md", FALLBACK_BATTLE_MD),
    readTemplateOrFallback("dnd5e-battle-rules.md", FALLBACK_DND5E_BATTLE_RULES_MD),
  ]);

  await Promise.all([
    writeFileIfMissing(out.world, worldTpl),
    writeFileIfMissing(out.npc, npcTpl),
    writeFileIfMissing(out.battle, battleTpl),
    writeFileIfMissing(out.battleRules, sharedBattleRulesTpl),
  ]);
  return out;
}

function defaultConfig(defaultDocs = {}) {
  // NOTE: secrets are stored in config.json for now (MVP). We will migrate to an OS vault
  // once the core runtime is stable.
  return {
    discord: {
      enabled: true,
      botToken: "",
      channelName: "aibot",
      requireMention: true,
    },
    foundry: {
      enabled: true,
      url: "",
      username: "",
      password: "",
      headless: true,
      loginTimeoutMs: 120_000,
      autoConnect: true,
      keepAliveMs: 30_000,
      pollChatEveryMs: 1200,
      combatAutoTurn: true,
    },
    llm: {
      provider: "codex-cli", // codex-cli | openai-oauth | openai-api-key
      codexCli: {
        binPath: "",
        model: "gpt-5.3-codex",
      },
      openai: {
        apiBaseUrl: "https://api.openai.com",
        model: "gpt-5",
        apiKey: "", // used when provider=openai-api-key
        oauth: {
          accessToken: "",
          refreshToken: "",
          expiresAtMs: 0,
        },
      },
    },
    runtime: {
      trace: {
        enabled: true,
        toUi: false,
        includePrompt: true,
        includeLlmRaw: true,
        includeContexts: true,
        logDir: "",
        logFile: "",
      },
    },
    imageGeneration: {
      webuiUrl: "",
      width: 768,
      height: 768,
      timeoutMs: 120_000,
    },
    npc: {
      difficultTerrainMultiplier: 2,
      defaultNpcId: "diana",
      sharedDocs: {
        world: String(defaultDocs.world || ""),
        battleRules: String(defaultDocs.battleRules || ""),
      },
    },
    npcs: [
      {
        id: "diana",
        displayName: "Diana",
        enabled: true,
        actor: { type: "name", value: "Diana" },
        personaDocs: {
          identity: "",
          soul: String(defaultDocs.npc || ""),
          behavior: "",
          battle: String(defaultDocs.battle || ""),
          relations: "",
          memory: "",
        },
        triggers: { minFt: 2, maxFt: 30 },
        image: {
          enabled: false,
          defaultPrompt: DEFAULT_DIANA_IMAGE_TAGS,
          baseTags: DEFAULT_DIANA_IMAGE_TAGS,
        },
      },
    ],
  };
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mergeDefaults(base, override) {
  if (!isPlainObject(base)) return override;
  const out = { ...base };
  if (!isPlainObject(override)) return out;
  for (const [k, v] of Object.entries(override)) {
    if (Array.isArray(v)) {
      out[k] = v;
      continue;
    }
    if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = mergeDefaults(out[k], v);
      continue;
    }
    out[k] = v;
  }
  return out;
}

function normalizeImageGeneration(out) {
  out.imageGeneration = isPlainObject(out.imageGeneration) ? out.imageGeneration : {};
  out.imageGeneration.webuiUrl = String(out.imageGeneration.webuiUrl || "");

  const width = Number(out.imageGeneration.width);
  out.imageGeneration.width = Number.isFinite(width) && width > 0 ? Math.round(width) : 768;

  const height = Number(out.imageGeneration.height);
  out.imageGeneration.height = Number.isFinite(height) && height > 0 ? Math.round(height) : 768;

  const timeoutMs = Number(out.imageGeneration.timeoutMs);
  out.imageGeneration.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs >= 30_000 ? Math.round(timeoutMs) : 120_000;
}

function normalizeNpcShape(npc, { defaultDocs, isDiana = false, fallbackName = "NPC" } = {}) {
  const out = isPlainObject(npc) ? npc : {};

  out.id = String(out.id || (isDiana ? "diana" : "npc"));
  out.displayName = String(out.displayName || (isDiana ? "Diana" : fallbackName || out.id));
  out.enabled = out.enabled !== false;

  out.actor = isPlainObject(out.actor) ? out.actor : {};
  out.actor.type = "name";
  out.actor.value = String(out.actor.value || out.displayName || "");

  out.personaDocs = isPlainObject(out.personaDocs) ? out.personaDocs : {};
  out.personaDocs.identity = String(out.personaDocs.identity || "");
  out.personaDocs.soul = String(out.personaDocs.soul || (isDiana ? defaultDocs.npc || "" : ""));
  out.personaDocs.behavior = String(out.personaDocs.behavior || "");
  out.personaDocs.battle = String(out.personaDocs.battle || (isDiana ? defaultDocs.battle || "" : ""));
  out.personaDocs.relations = String(out.personaDocs.relations || "");
  out.personaDocs.memory = String(out.personaDocs.memory || "");

  out.triggers = isPlainObject(out.triggers) ? out.triggers : {};
  const minFt = Number(out.triggers.minFt);
  const maxFt = Number(out.triggers.maxFt);
  out.triggers.minFt = Number.isFinite(minFt) ? minFt : 2;
  out.triggers.maxFt = Number.isFinite(maxFt) ? maxFt : 30;

  out.image = isPlainObject(out.image) ? out.image : {};
  out.image.enabled = out.image.enabled === true;
  const fallbackPrompt = String(out.image.defaultPrompt || out.image.baseTags || "").trim();
  out.image.defaultPrompt = String(fallbackPrompt || (isDiana ? DEFAULT_DIANA_IMAGE_TAGS : ""));
  // Keep baseTags for backward compatibility with older configs/runtimes.
  out.image.baseTags = String(out.image.baseTags || out.image.defaultPrompt || "");

  return out;
}

function applyPersonaDocDefaults(config, defaultDocs = {}) {
  const out = isPlainObject(config) ? config : {};

  out.npc = isPlainObject(out.npc) ? out.npc : {};
  out.npc.sharedDocs = isPlainObject(out.npc.sharedDocs) ? out.npc.sharedDocs : {};
  if (!String(out.npc.sharedDocs.world || "").trim()) {
    out.npc.sharedDocs.world = String(defaultDocs.world || "");
  }
  if (!String(out.npc.sharedDocs.battleRules || "").trim()) {
    out.npc.sharedDocs.battleRules = String(defaultDocs.battleRules || "");
  }

  normalizeImageGeneration(out);

  out.npcs = Array.isArray(out.npcs) ? out.npcs : [];
  if (!out.npcs.length) {
    out.npcs.push({ id: "diana" });
  }

  let hasDiana = false;
  out.npcs = out.npcs.map((npc, index) => {
    const id = String(npc?.id || "").trim().toLowerCase();
    const isDiana = id === "diana";
    if (isDiana) hasDiana = true;
    const fallbackName = isDiana ? "Diana" : `NPC ${index + 1}`;
    return normalizeNpcShape(npc, { defaultDocs, isDiana, fallbackName });
  });

  if (!hasDiana) {
    out.npcs.unshift(
      normalizeNpcShape(
        {
          id: "diana",
          displayName: "Diana",
          actor: { type: "name", value: "Diana" },
        },
        { defaultDocs, isDiana: true, fallbackName: "Diana" }
      )
    );
  }

  if (!String(out.npc.defaultNpcId || "").trim()) {
    out.npc.defaultNpcId = "diana";
  }

  return out;
}

async function loadAppConfig(configPath) {
  const filePath = String(configPath || "").trim();
  const personaDir = filePath
    ? path.join(path.dirname(filePath), "persona-defaults")
    : path.resolve(process.cwd(), "persona-defaults");
  const defaultDocs = await ensureDefaultPersonaFiles(personaDir);
  const defaults = defaultConfig(defaultDocs);

  if (!filePath) {
    return applyPersonaDocDefaults(defaults, defaultDocs);
  }

  try {
    const raw = await fs.readFile(filePath, "utf8");
    const clean = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = JSON.parse(clean);
    return applyPersonaDocDefaults(mergeDefaults(defaults, parsed), defaultDocs);
  } catch (e) {
    if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) {
      return applyPersonaDocDefaults(defaults, defaultDocs);
    }
    throw e;
  }
}

async function saveAppConfig(configPath, config) {
  const filePath = String(configPath || "");
  if (!filePath) throw new Error("configPath is required");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

module.exports = { getDefaultConfigPath, loadAppConfig, saveAppConfig };
