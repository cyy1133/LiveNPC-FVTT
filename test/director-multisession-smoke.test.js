const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AppRuntime,
  resolveAmbientConfig,
  resolveDirectorConfig,
  resolveNpcWorldState,
  resolveNpcFoundrySessionId,
} = require("../runtime/app-runtime");

test("smoke: director config uses global defaults and NPC overrides", () => {
  const config = {
    npc: {
      director: {
        enabled: true,
        mode: "directed",
        promptFile: ".\\persona-defaults\\director.md",
        promptText: "Global director brief",
        allowAmbientTalk: true,
        allowNpcToNpc: false,
        playerNearbyFt: 28,
        maxChainTurns: 2,
        maxParticipants: 3,
        npcCooldownMs: 45000,
        sceneCooldownMs: 15000,
      },
    },
  };

  const npc = {
    id: "guard",
    director: {
      enabled: null,
      allowAmbientTalk: false,
      allowNpcToNpc: true,
      socialWeight: 2.5,
      playerNearbyFt: 14,
      npcCooldownMs: 9000,
      promptText: "This guard should answer first when the gate is mentioned.",
    },
  };

  const resolved = resolveDirectorConfig({ config, npc });

  assert.equal(resolved.enabled, true);
  assert.equal(resolved.mode, "directed");
  assert.equal(resolved.promptFile, ".\\persona-defaults\\director.md");
  assert.equal(resolved.promptText, "This guard should answer first when the gate is mentioned.");
  assert.equal(resolved.allowAmbientTalk, false);
  assert.equal(resolved.allowNpcToNpc, true);
  assert.equal(resolved.playerNearbyFt, 14);
  assert.equal(resolved.maxChainTurns, 2);
  assert.equal(resolved.maxParticipants, 3);
  assert.equal(resolved.npcCooldownMs, 9000);
  assert.equal(resolved.sceneCooldownMs, 15000);
  assert.equal(resolved.socialWeight, 2.5);
});

test("smoke: scene preset overrides ambient/director config and resolves @npc world activity", () => {
  const config = {
    npc: {
      director: {
        enabled: false,
        mode: "nearby",
        allowAmbientTalk: true,
        allowNpcToNpc: false,
      },
      ambient: {
        enabled: false,
        promptText: "Global ambient off.",
      },
      worldStateText: "@Town Guard: standing watch in the square",
      scenePresets: [
        {
          id: "tavern-night",
          label: "Tavern Night",
          sceneName: "Rusty Dragon Inn",
          worldStateText: "@Town Guard: watching the tavern door\n@Barkeep: polishing mugs",
          director: {
            enabled: true,
            mode: "directed",
            allowAmbientTalk: true,
            allowNpcToNpc: true,
            playerNearbyFt: 24,
            maxChainTurns: 1,
            maxParticipants: 2,
            npcCooldownMs: 12000,
            sceneCooldownMs: 8000,
            tokenBudgetPerWindow: 4,
            tokenBudgetWindowMs: 120000,
            lineDelayMinMs: 0,
            lineDelayMaxMs: 0,
          },
          ambient: {
            enabled: true,
            promptText: "Keep idle chatter short.",
          },
          npcOverrides: [
            {
              npcId: "guard",
              director: {
                socialWeight: 3,
              },
            },
          ],
        },
      ],
    },
  };

  const npc = {
    id: "guard",
    displayName: "Town Guard",
    director: {},
  };
  const sceneContext = {
    scene: {
      id: "scene-123",
      name: "Rusty Dragon Inn",
    },
  };

  const director = resolveDirectorConfig({ config, npc, sceneContext });
  const ambient = resolveAmbientConfig({ config, sceneContext });
  const worldState = resolveNpcWorldState({ config, npc, sceneContext });

  assert.equal(director.enabled, true);
  assert.equal(director.mode, "directed");
  assert.equal(director.allowNpcToNpc, true);
  assert.equal(director.socialWeight, 3);
  assert.equal(ambient.enabled, true);
  assert.equal(ambient.promptText, "Keep idle chatter short.");
  assert.equal(worldState.presetLabel, "Tavern Night");
  assert.equal(worldState.npcActivity, "watching the tavern door");
});

test("smoke: NPC FVTT ownership resolves by session id, user id, username, then default", () => {
  const sessions = [
    { sessionId: "gm", userId: "gm-user", username: "GM" },
    { sessionId: "absent-bob", userId: "user-bob", username: "BobPlayer" },
  ];

  assert.equal(
    resolveNpcFoundrySessionId({
      npc: { foundry: { sessionId: "absent-bob" } },
      sessionConfigs: sessions,
      defaultSessionId: "gm",
    }),
    "absent-bob"
  );

  assert.equal(
    resolveNpcFoundrySessionId({
      npc: { foundry: { userId: "user-bob" } },
      sessionConfigs: sessions,
      defaultSessionId: "gm",
    }),
    "absent-bob"
  );

  assert.equal(
    resolveNpcFoundrySessionId({
      npc: { foundry: { username: "bobplayer" } },
      sessionConfigs: sessions,
      defaultSessionId: "gm",
    }),
    "absent-bob"
  );

  assert.equal(
    resolveNpcFoundrySessionId({
      npc: { foundry: {} },
      sessionConfigs: sessions,
      defaultSessionId: "gm",
    }),
    "gm"
  );
});

test("smoke: _withNpcActor routes actor ownership to the NPC-specific FVTT client", async () => {
  const runtime = new AppRuntime();
  runtime.started = true;
  const runToken = runtime._beginRunToken();

  const gmClient = {
    config: { foundry: { actorId: "", actorName: "" } },
    async ensureConnected() {
      return { ok: true };
    },
  };
  const bobClient = {
    config: { foundry: { actorId: "", actorName: "" } },
    async ensureConnected() {
      return { ok: true };
    },
  };

  runtime.fvtt = gmClient;
  runtime.fvttDefaultSessionId = "gm";
  runtime.fvttSessionConfigs = [
    { sessionId: "gm", userId: "gm-user", username: "GM" },
    { sessionId: "absent-bob", userId: "user-bob", username: "BobPlayer" },
  ];
  runtime.fvttClientsBySessionId = new Map([
    ["gm", gmClient],
    ["absent-bob", bobClient],
  ]);

  const seen = [];

  await runtime._withNpcActor(
    {
      id: "innkeeper",
      displayName: "Innkeeper",
      actor: { type: "name", value: "Innkeeper" },
      foundry: { sessionId: "gm" },
    },
    async () => {
      seen.push({
        client: runtime.fvtt === gmClient ? "gm" : "other",
        actorName: gmClient.config.foundry.actorName,
      });
    },
    { runToken }
  );

  await runtime._withNpcActor(
    {
      id: "missing-player",
      displayName: "Missing Player",
      actor: { type: "name", value: "Missing Player" },
      foundry: { username: "BobPlayer" },
    },
    async () => {
      seen.push({
        client: runtime.fvtt === bobClient ? "absent-bob" : "other",
        actorName: bobClient.config.foundry.actorName,
      });
    },
    { runToken }
  );

  assert.deepEqual(seen, [
    { client: "gm", actorName: "Innkeeper" },
    { client: "absent-bob", actorName: "Missing Player" },
  ]);
  assert.equal(runtime.fvtt, gmClient);
  assert.equal(gmClient.config.foundry.actorName, "");
  assert.equal(bobClient.config.foundry.actorName, "");
});
