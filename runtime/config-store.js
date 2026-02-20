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
  };

  const [worldTpl, npcTpl, battleTpl] = await Promise.all([
    readTemplateOrFallback("world.md", FALLBACK_WORLD_MD),
    readTemplateOrFallback("npc.md", FALLBACK_NPC_MD),
    readTemplateOrFallback("battlePattern.md", FALLBACK_BATTLE_MD),
  ]);

  await Promise.all([
    writeFileIfMissing(out.world, worldTpl),
    writeFileIfMissing(out.npc, npcTpl),
    writeFileIfMissing(out.battle, battleTpl),
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
    npc: {
      difficultTerrainMultiplier: 2,
      defaultNpcId: "diana",
      sharedDocs: {
        world: String(defaultDocs.world || ""),
      },
    },
    npcs: [
      {
        id: "diana",
        displayName: "양치기 디아나",
        enabled: true,
        actor: { type: "name", value: "양치기 디아나" },
        personaDocs: {
          identity: "",
          soul: String(defaultDocs.npc || ""),
          behavior: "",
          battle: String(defaultDocs.battle || ""),
          relations: "",
          memory: "",
        },
        triggers: { minFt: 2, maxFt: 30 },
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

function applyPersonaDocDefaults(config, defaultDocs = {}) {
  const out = isPlainObject(config) ? config : {};

  out.npc = isPlainObject(out.npc) ? out.npc : {};
  out.npc.sharedDocs = isPlainObject(out.npc.sharedDocs) ? out.npc.sharedDocs : {};
  if (!String(out.npc.sharedDocs.world || "").trim()) {
    out.npc.sharedDocs.world = String(defaultDocs.world || "");
  }

  const npcs = Array.isArray(out.npcs) ? out.npcs : [];
  const diana =
    npcs.find((n) => String(n?.id || "").trim().toLowerCase() === "diana") ||
    npcs.find((n) => String(n?.displayName || "").includes("디아나"));
  if (diana && isPlainObject(diana)) {
    diana.personaDocs = isPlainObject(diana.personaDocs) ? diana.personaDocs : {};
    if (!String(diana.personaDocs.soul || "").trim()) {
      diana.personaDocs.soul = String(defaultDocs.npc || "");
    }
    if (!String(diana.personaDocs.battle || "").trim()) {
      diana.personaDocs.battle = String(defaultDocs.battle || "");
    }
    diana.displayName = String(diana.displayName || "양치기 디아나");
    diana.actor = isPlainObject(diana.actor) ? diana.actor : {};
    diana.actor.type = "name";
    if (!String(diana.actor.value || "").trim()) {
      diana.actor.value = String(diana.displayName || "양치기 디아나");
    }
  }

  if (!String(out.npc.defaultNpcId || "").trim() && diana) {
    out.npc.defaultNpcId = String(diana.id || "diana");
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
