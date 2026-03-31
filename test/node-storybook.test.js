const test = require("node:test");
const assert = require("node:assert/strict");

const {
  advanceNodeStorybookState,
  isStoryNodeAssignedToNpc,
  normalizeNodeStorybook,
  normalizeStoryWorkflow,
  resolveNodeStorybook,
} = require("../runtime/node-storybook");

function makeSceneContext({ sceneId = "cave", sceneName = "Cave", playerDistanceFt = 99, combatActive = false, tokens = null } = {}) {
  return {
    scene: {
      id: sceneId,
      name: sceneName,
      combat: {
        active: combatActive,
        started: combatActive,
        ended: combatActive === false,
      },
    },
    tokens:
      tokens ||
      [
        {
          id: "hero",
          name: "Hero",
          hasPlayerOwner: true,
          hidden: false,
          defeated: false,
          isDeadLike: false,
          distanceFt: playerDistanceFt,
          orthDistanceFt: playerDistanceFt,
        },
      ],
  };
}

test("normalizeStoryWorkflow defaults to simple mode", () => {
  assert.deepEqual(normalizeStoryWorkflow({}), {
    enabled: true,
    mode: "simple",
  });
  assert.deepEqual(normalizeStoryWorkflow({ enabled: false, mode: "node-storybook" }), {
    enabled: false,
    mode: "node-storybook",
  });
});

test("resolveNodeStorybook matches legacy nodeStorybooks by scene id", () => {
  const config = {
    npc: {
      socialWorkflow: {
        enabled: true,
        mode: "node-storybook",
      },
      nodeStorybooks: [
        {
          id: "guard-shift",
          label: "Guard Shift",
          sceneId: "cave-entrance",
          sceneName: "Cave Entrance",
          nodes: [{ id: "watch", label: "Watch" }],
        },
      ],
    },
  };

  const storybook = resolveNodeStorybook({
    config,
    sceneContext: makeSceneContext({ sceneId: "cave-entrance", sceneName: "Wrong Name" }),
  });

  assert.equal(storybook?.id, "guard-shift");
  assert.equal(storybook?.entryNodeId, "watch");
});

test("resolveNodeStorybook matches current npc.storybook.graphs schema", () => {
  const config = {
    npc: {
      storybook: {
        enabled: true,
        mode: "node-storybook",
        graphs: [
          {
            id: "cave-guard-shift",
            label: "Cave Guard Shift",
            sceneName: "Cave Entrance",
            entryNodeId: "watch",
            nodes: [{ id: "watch", label: "Watch" }],
          },
        ],
      },
    },
  };

  const storybook = resolveNodeStorybook({
    config,
    sceneContext: makeSceneContext({ sceneId: "other-scene", sceneName: "Cave Entrance" }),
  });

  assert.equal(storybook?.id, "cave-guard-shift");
  assert.equal(storybook?.entryNodeId, "watch");
});

test("advanceNodeStorybookState follows timeout and player-nearby transitions", () => {
  const storybook = normalizeNodeStorybook({
    id: "guard-shift",
    label: "Guard Shift",
    entryNodeId: "rotation",
    nodes: [
      {
        id: "rotation",
        label: "Rotation",
        transitions: [{ id: "t1", conditionType: "player-nearby", thresholdFt: 20, targetNodeId: "suspicious" }],
      },
      {
        id: "suspicious",
        label: "Suspicious",
        transitions: [{ id: "t2", conditionType: "timeout", thresholdMs: 10000, targetNodeId: "challenge" }],
      },
      {
        id: "challenge",
        label: "Challenge",
        transitions: [],
      },
    ],
  });

  const nearPlayer = advanceNodeStorybookState({
    storybook,
    sceneContext: makeSceneContext({ sceneId: "cave", playerDistanceFt: 10 }),
    nowMs: 1000,
  });

  assert.equal(nearPlayer.node?.id, "suspicious");
  assert.equal(nearPlayer.state.nodeId, "suspicious");
  assert.equal(nearPlayer.transitionsTaken.length, 1);
  assert.match(nearPlayer.state.lastTransitionReason, /player within 20ft/i);

  const afterTimeout = advanceNodeStorybookState({
    storybook,
    sceneContext: makeSceneContext({ sceneId: "cave", playerDistanceFt: 10 }),
    prevState: {
      nodeId: "suspicious",
      enteredAtMs: 1000,
    },
    nowMs: 12050,
  });

  assert.equal(afterTimeout.node?.id, "challenge");
  assert.equal(afterTimeout.transitionsTaken.length, 1);
  assert.match(afterTimeout.state.lastTransitionReason, /timeout/i);
});

test("advanceNodeStorybookState reacts to combat-started", () => {
  const storybook = normalizeNodeStorybook({
    id: "guard-shift",
    label: "Guard Shift",
    entryNodeId: "watch",
    nodes: [
      {
        id: "watch",
        label: "Watch",
        transitions: [{ id: "combat", conditionType: "combat-started", targetNodeId: "battle" }],
      },
      {
        id: "battle",
        label: "Battle",
        transitions: [],
      },
    ],
  });

  const result = advanceNodeStorybookState({
    storybook,
    sceneContext: makeSceneContext({ combatActive: true }),
    nowMs: 500,
  });

  assert.equal(result.node?.id, "battle");
  assert.equal(result.state.lastTransitionId, "combat");
});

test("advanceNodeStorybookState supports player-visible and active-node-timeout conditions", () => {
  const storybook = normalizeNodeStorybook({
    id: "lookout",
    label: "Lookout",
    entryNodeId: "idle",
    nodes: [
      {
        id: "idle",
        label: "Idle",
        transitions: [
          {
            id: "spot",
            nextNodeId: "alert",
            conditions: [{ type: "player-visible", distanceFt: 60 }],
          },
        ],
      },
      {
        id: "alert",
        label: "Alert",
        transitions: [
          {
            id: "settle",
            nextNodeId: "idle",
            conditions: [{ type: "active-node-timeout", seconds: 5 }],
          },
        ],
      },
    ],
  });

  const spotted = advanceNodeStorybookState({
    storybook,
    sceneContext: makeSceneContext({
      playerDistanceFt: 20,
      tokens: [
        {
          id: "hero",
          name: "Hero",
          hasPlayerOwner: true,
          hidden: false,
          defeated: false,
          isDeadLike: false,
          distanceFt: 20,
          orthDistanceFt: 20,
          tactical: { visibleFromSelf: true, lineOfEffect: true },
        },
      ],
    }),
    nowMs: 1000,
  });

  assert.equal(spotted.node?.id, "alert");
  assert.match(spotted.state.lastTransitionReason, /player visible/i);

  const settled = advanceNodeStorybookState({
    storybook,
    sceneContext: makeSceneContext({ playerDistanceFt: 80, tokens: [] }),
    prevState: {
      nodeId: "alert",
      enteredAtMs: 1000,
    },
    nowMs: 7000,
  });

  assert.equal(settled.node?.id, "idle");
  assert.match(settled.state.lastTransitionReason, /timeout/i);
});

test("isStoryNodeAssignedToNpc matches npc id and display name", () => {
  const node = {
    npcIds: ["goblin-a", "Town Guard"],
  };

  assert.equal(
    isStoryNodeAssignedToNpc(node, {
      id: "goblin-a",
      displayName: "Goblin A",
      actor: { value: "Goblin A" },
    }),
    true
  );

  assert.equal(
    isStoryNodeAssignedToNpc(node, {
      id: "guard-1",
      displayName: "Town Guard",
      actor: { value: "Guard" },
    }),
    true
  );

  assert.equal(
    isStoryNodeAssignedToNpc(node, {
      id: "villager",
      displayName: "Villager",
      actor: { value: "Villager" },
    }),
    false
  );
});
