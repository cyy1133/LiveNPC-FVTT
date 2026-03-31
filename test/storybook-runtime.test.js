const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AppRuntime,
  resolveAmbientConfig,
  resolveDirectorConfig,
  resolveNpcWorldState,
} = require("../runtime/app-runtime");

function makeConfig() {
  return {
    npc: {
      director: {
        enabled: true,
        mode: "nearby",
        promptFile: ".\\persona-defaults\\director.md",
        promptText: "Global director brief.",
        allowAmbientTalk: false,
        allowNpcToNpc: false,
        playerNearbyFt: 30,
        maxChainTurns: 2,
        maxParticipants: 3,
        npcCooldownMs: 45000,
        sceneCooldownMs: 15000,
        tokenBudgetPerWindow: 8,
        tokenBudgetWindowMs: 600000,
        lineDelayMinMs: 300,
        lineDelayMaxMs: 900,
      },
      ambient: {
        enabled: false,
        promptFile: "",
        promptText: "Global ambient off.",
      },
      worldStateText: "@Goblin B: standing watch at the gate",
      scenePresets: [
        {
          id: "goblin-watch",
          label: "Goblin Watch",
          sceneId: "cave-entrance",
          sceneName: "Cave Entrance",
          worldStateText: "The patrol is tired but alert.\n@Goblin A: pacing near the tunnel mouth\n@Goblin B: warming hands by the fire",
          director: {
            enabled: true,
            mode: "directed",
            promptFile: ".\\persona-defaults\\director.md",
            promptText: "Keep the cave patrol terse and suspicious.",
            allowAmbientTalk: true,
            allowNpcToNpc: true,
            playerNearbyFt: 20,
            maxChainTurns: 1,
            maxParticipants: 2,
            npcCooldownMs: 10000,
            sceneCooldownMs: 5000,
            tokenBudgetPerWindow: 4,
            tokenBudgetWindowMs: 120000,
            lineDelayMinMs: 0,
            lineDelayMaxMs: 0,
          },
          ambient: {
            enabled: true,
            promptFile: "",
            promptText: "Idle patrol chatter only.",
          },
          npcOverrides: [
            {
              npcId: "goblin-a",
              displayName: "Goblin A",
              director: {
                socialWeight: 4,
                playerNearbyFt: 12,
              },
            },
          ],
        },
      ],
    },
  };
}

function makeSceneContext(overrides = {}) {
  return {
    scene: {
      id: "cave-entrance",
      name: "Cave Entrance",
    },
    ...overrides,
  };
}

test("storybook-style scene preset resolves the active scene layer and npc activity", () => {
  const config = makeConfig();
  const sceneContext = makeSceneContext();
  const npc = {
    id: "goblin-a",
    displayName: "Goblin A",
    actor: { type: "name", value: "Goblin A" },
    director: {},
  };

  const director = resolveDirectorConfig({ config, npc, sceneContext });
  const ambient = resolveAmbientConfig({ config, sceneContext });
  const worldState = resolveNpcWorldState({ config, npc, sceneContext });

  assert.equal(director.enabled, true);
  assert.equal(director.mode, "directed");
  assert.equal(director.allowAmbientTalk, true);
  assert.equal(director.allowNpcToNpc, true);
  assert.equal(director.playerNearbyFt, 12);
  assert.equal(director.maxChainTurns, 1);
  assert.equal(director.maxParticipants, 2);
  assert.equal(director.sceneCooldownMs, 5000);
  assert.equal(director.socialWeight, 4);
  assert.equal(ambient.enabled, true);
  assert.equal(ambient.promptText, "Idle patrol chatter only.");
  assert.equal(worldState.presetId, "goblin-watch");
  assert.equal(worldState.presetLabel, "Goblin Watch");
  assert.equal(worldState.generalText, "The patrol is tired but alert.");
  assert.equal(worldState.npcActivity, "pacing near the tunnel mouth");
});

test("storybook-style config falls back to global director and world state when the scene does not match", () => {
  const config = makeConfig();
  const sceneContext = makeSceneContext({
    scene: {
      id: "forest-road",
      name: "Forest Road",
    },
  });
  const npc = {
    id: "goblin-b",
    displayName: "Goblin B",
    actor: { type: "name", value: "Goblin B" },
    director: {},
  };

  const director = resolveDirectorConfig({ config, npc, sceneContext });
  const ambient = resolveAmbientConfig({ config, sceneContext });
  const worldState = resolveNpcWorldState({ config, npc, sceneContext });

  assert.equal(director.enabled, true);
  assert.equal(director.mode, "nearby");
  assert.equal(director.allowAmbientTalk, false);
  assert.equal(director.allowNpcToNpc, false);
  assert.equal(director.playerNearbyFt, 30);
  assert.equal(director.maxChainTurns, 2);
  assert.equal(director.maxParticipants, 3);
  assert.equal(ambient.enabled, false);
  assert.equal(ambient.promptText, "Global ambient off.");
  assert.equal(worldState.presetId, "");
  assert.equal(worldState.presetLabel, "");
  assert.equal(worldState.generalText, "");
  assert.equal(worldState.npcActivity, "standing watch at the gate");
});

test("runtime storybook snapshot activates node-storybook graphs and exposes live status", async () => {
  const runtime = new AppRuntime();
  runtime.started = true;
  const config = {
    npc: {
      storybook: {
        enabled: true,
        mode: "node-storybook",
        graphs: [
          {
            id: "guard-shift",
            label: "Guard Shift",
            sceneId: "cave-entrance",
            entryNodeId: "watch",
            nodes: [
              {
                id: "watch",
                label: "Watch",
                objectiveText: "Keep watch at the cave mouth.",
                transitions: [],
              },
            ],
          },
        ],
      },
    },
  };
  const sceneContext = {
    ok: true,
    scene: {
      id: "cave-entrance",
      name: "Cave Entrance",
      combat: { active: false, started: false, ended: true },
    },
    tokens: [],
  };

  const snapshot = runtime._resolveStorybookSceneSnapshot({ config, sceneContext, source: "test" });
  const status = await runtime.getSocialStatus({ config });

  assert.equal(snapshot?.enabled, true);
  assert.equal(snapshot?.mode, "node-storybook");
  assert.equal(snapshot?.graphId, "guard-shift");
  assert.equal(snapshot?.activeNode?.id, "watch");
  assert.equal(status.ok, true);
  assert.equal(status.storybook.enabled, true);
  assert.equal(status.storybook.mode, "node-storybook");
  assert.equal(status.sceneStates.length, 1);
  assert.equal(status.sceneStates[0]?.graphId, "guard-shift");
  assert.equal(status.sceneStates[0]?.nodeId, "watch");
});
