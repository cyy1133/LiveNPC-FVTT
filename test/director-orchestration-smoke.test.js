const test = require("node:test");
const assert = require("node:assert/strict");

const { AppRuntime } = require("../runtime/app-runtime");

function createNpc(id, displayName, { socialWeight = 1, allowAmbientTalk = true, allowNpcToNpc = true } = {}) {
  return {
    id,
    displayName,
    enabled: true,
    actor: { type: "name", value: displayName },
    triggers: { minFt: 0, maxFt: 30 },
    foundry: { sessionId: "gm" },
    director: {
      enabled: null,
      allowAmbientTalk: allowAmbientTalk === true ? true : false,
      allowNpcToNpc: allowNpcToNpc === true ? true : false,
      socialWeight,
      playerNearbyFt: 30,
      npcCooldownMs: null,
      promptFile: "",
      promptText: "",
    },
  };
}

function makeScene(distanceFt) {
  return {
    ok: true,
    tokens: [
      {
        id: "hero-token",
        name: "Hero",
        actorName: "Hero",
        orthDistanceFt: distanceFt,
        distanceFt,
      },
    ],
    targets: [],
  };
}

test("smoke: director lead selection prefers the strongest nearby ambient NPC", async () => {
  const runtime = new AppRuntime();
  runtime.started = true;
  const runToken = runtime._beginRunToken();

  const barkeep = createNpc("barkeep", "Barkeep", { socialWeight: 1 });
  const guard = createNpc("guard", "Town Guard", { socialWeight: 3 });
  const config = {
    npc: {
      director: {
        enabled: true,
        mode: "nearby",
        allowAmbientTalk: true,
        allowNpcToNpc: true,
        playerNearbyFt: 30,
        maxChainTurns: 2,
        maxParticipants: 3,
        npcCooldownMs: 45000,
        sceneCooldownMs: 15000,
        tokenBudgetPerWindow: 8,
        tokenBudgetWindowMs: 600000,
        lineDelayMinMs: 0,
        lineDelayMaxMs: 0,
      },
    },
    npcs: [barkeep, guard],
  };

  runtime._getTacticalSceneContext = async (npc) => {
    return npc.id === "guard" ? makeScene(8) : makeScene(15);
  };

  const picked = await runtime._pickDirectorLeadNpc({
    config,
    inboundText: "Anyone here know what happened at the gate?",
    speakerHint: "Hero",
    runToken,
  });

  assert.equal(picked?.id, "guard");
});

test("smoke: director adds one nearby follow-up and scene cooldown blocks immediate repetition", async () => {
  const runtime = new AppRuntime();
  runtime.started = true;
  const runToken = runtime._beginRunToken();

  const barkeep = createNpc("barkeep", "Barkeep", { socialWeight: 1 });
  const guard = createNpc("guard", "Town Guard", { socialWeight: 2 });
  const config = {
    foundry: {
      enabled: true,
      defaultSessionId: "gm",
    },
    npc: {
      ambient: {
        enabled: true,
      },
      director: {
        enabled: true,
        mode: "nearby",
        allowAmbientTalk: true,
        allowNpcToNpc: true,
        playerNearbyFt: 30,
        maxChainTurns: 2,
        maxParticipants: 3,
        npcCooldownMs: 60000,
        sceneCooldownMs: 60000,
        tokenBudgetPerWindow: 4,
        tokenBudgetWindowMs: 600000,
        lineDelayMinMs: 0,
        lineDelayMaxMs: 0,
      },
    },
    npcs: [barkeep, guard],
  };

  const speaks = [];
  const discordLines = [];
  const client = {
    config: {
      foundry: {
        actorId: "",
        actorName: "",
      },
    },
    async ensureConnected() {
      return { ok: true };
    },
    async getRecentChat() {
      return { ok: true, messages: [] };
    },
    async getActorSheet() {
      return { ok: true, actorName: this.config.foundry.actorName };
    },
    async speakAsActor(text) {
      speaks.push({
        actorName: String(this.config.foundry.actorName || ""),
        text: String(text || ""),
      });
      return { ok: true };
    },
  };

  runtime.fvtt = client;
  runtime.fvttDefaultSessionId = "gm";
  runtime.fvttSessionConfigs = [{ sessionId: "gm", userId: "", username: "GM" }];
  runtime.fvttClientsBySessionId = new Map([["gm", client]]);
  runtime._getTacticalSceneContext = async () => makeScene(10);
  runtime._completeNpcJson = async ({ traceMeta }) => {
    if (traceMeta?.origin === "director-followup") {
      return {
        parsed: {
          replyText: "Hold the line. I heard the same rumor.",
          intent: { type: "none", args: {} },
        },
      };
    }
    throw new Error(`unexpected completion origin: ${traceMeta?.origin || "unknown"}`);
  };

  const discordMessage = {
    channel: {
      async send(text) {
        discordLines.push(String(text || ""));
        return { ok: true };
      },
    },
  };

  const invoke = () =>
    runtime._maybeRunDirectorConversation({
      config,
      origin: "discord",
      primaryNpc: barkeep,
      primaryReplyText: "Ale first, rumors second.",
      inboundText: "Anyone here know what happened at the gate?",
      speakerHint: "Hero",
      reactionGate: {
        sourceTokenId: "hero-token",
        sourceTokenName: "Hero",
        distanceFt: 10,
      },
      discordMessage,
      runToken,
    });

  await invoke();
  await invoke();

  assert.deepEqual(speaks, [{ actorName: "Town Guard", text: "Hold the line. I heard the same rumor." }]);
  assert.deepEqual(discordLines, ["**Town Guard:** Hold the line. I heard the same rumor."]);
});

test("smoke: ambient chatter produces one idle line and one follow-up, then cools down", async () => {
  const runtime = new AppRuntime();
  runtime.started = true;
  runtime._fvttObserverInFlight = false;
  runtime._lastCombatStateByNpc.clear();
  runtime._directorNpcCooldownUntil.clear();
  runtime._directorSceneCooldownUntil.clear();
  const runToken = runtime._beginRunToken();

  const barkeep = createNpc("barkeep", "Barkeep", { socialWeight: 2 });
  const guard = createNpc("guard", "Town Guard", { socialWeight: 1 });
  const config = {
    foundry: {
      enabled: true,
      defaultSessionId: "gm",
    },
    npc: {
      director: {
        enabled: true,
        mode: "nearby",
        allowAmbientTalk: true,
        allowNpcToNpc: true,
        playerNearbyFt: 30,
        maxChainTurns: 2,
        maxParticipants: 3,
        npcCooldownMs: 60000,
        sceneCooldownMs: 60000,
        tokenBudgetPerWindow: 8,
        tokenBudgetWindowMs: 600000,
        lineDelayMinMs: 0,
        lineDelayMaxMs: 0,
      },
    },
    npcs: [barkeep, guard],
  };

  const speaks = [];
  const client = {
    config: {
      foundry: {
        actorId: "",
        actorName: "",
      },
    },
    async ensureConnected() {
      return { ok: true };
    },
    async getRecentChat() {
      return { ok: true, messages: [] };
    },
    async getActorSheet() {
      return { ok: true, actorName: this.config.foundry.actorName };
    },
    async speakAsActor(text) {
      speaks.push({
        actorName: String(this.config.foundry.actorName || ""),
        text: String(text || ""),
      });
      return { ok: true };
    },
  };

  runtime.fvtt = client;
  runtime.fvttDefaultSessionId = "gm";
  runtime.fvttSessionConfigs = [{ sessionId: "gm", userId: "", username: "GM" }];
  runtime.fvttClientsBySessionId = new Map([["gm", client]]);
  runtime._getTacticalSceneContext = async () => makeScene(8);
  runtime._completeNpcJson = async ({ traceMeta }) => {
    if (traceMeta?.origin === "ambient-chatter") {
      return {
        parsed: {
          replyText: "Fresh stew is almost ready.",
          intent: { type: "none", args: {} },
        },
      };
    }
    if (traceMeta?.origin === "director-followup") {
      return {
        parsed: {
          replyText: "And keep your purse close tonight.",
          intent: { type: "none", args: {} },
        },
      };
    }
    throw new Error(`unexpected completion origin: ${traceMeta?.origin || "unknown"}`);
  };

  await runtime._pollAmbientChatter(config);
  await runtime._pollAmbientChatter(config);
  runtime._throwIfRuntimeStopped(runToken);

  assert.deepEqual(speaks, [
    { actorName: "Barkeep", text: "Fresh stew is almost ready." },
    { actorName: "Town Guard", text: "And keep your purse close tonight." },
  ]);
});

test("smoke: ambient chatter respects the standalone ambient toggle", async () => {
  const runtime = new AppRuntime();
  runtime.started = true;
  runtime._fvttObserverInFlight = false;
  runtime._lastCombatStateByNpc.clear();
  runtime._directorNpcCooldownUntil.clear();
  runtime._directorSceneCooldownUntil.clear();

  const barkeep = createNpc("barkeep", "Barkeep", { socialWeight: 2 });
  const config = {
    foundry: {
      enabled: true,
      defaultSessionId: "gm",
    },
    npc: {
      ambient: {
        enabled: false,
      },
      director: {
        enabled: true,
        mode: "nearby",
        allowAmbientTalk: true,
        allowNpcToNpc: true,
        playerNearbyFt: 30,
        maxChainTurns: 2,
        maxParticipants: 3,
        npcCooldownMs: 60000,
        sceneCooldownMs: 60000,
        tokenBudgetPerWindow: 8,
        tokenBudgetWindowMs: 600000,
        lineDelayMinMs: 0,
        lineDelayMaxMs: 0,
      },
    },
    npcs: [barkeep],
  };

  const speaks = [];
  const client = {
    config: {
      foundry: {
        actorId: "",
        actorName: "",
      },
    },
    async ensureConnected() {
      return { ok: true };
    },
    async getRecentChat() {
      return { ok: true, messages: [] };
    },
    async getActorSheet() {
      return { ok: true, actorName: this.config.foundry.actorName };
    },
    async speakAsActor(text) {
      speaks.push(String(text || ""));
      return { ok: true };
    },
  };

  runtime.fvtt = client;
  runtime.fvttDefaultSessionId = "gm";
  runtime.fvttSessionConfigs = [{ sessionId: "gm", userId: "", username: "GM" }];
  runtime.fvttClientsBySessionId = new Map([["gm", client]]);
  runtime._getTacticalSceneContext = async () => makeScene(8);
  runtime._completeNpcJson = async () => {
    throw new Error("ambient generation should not run while ambient is disabled");
  };

  await runtime._pollAmbientChatter(config);

  assert.deepEqual(speaks, []);
});
