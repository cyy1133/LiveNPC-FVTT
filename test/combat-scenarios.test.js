const test = require("node:test");
const assert = require("node:assert/strict");

const {
  analyzeSceneTactics,
  pickAutoTargetFromSceneContext,
  derivePathMoveFromSceneContext,
} = require("../runtime/tactical-grid");

function sceneWith({ tokens = [], targets = [], walls = [], terrainCells = {}, walkSpeedFt = 30 } = {}) {
  return {
    ok: true,
    scene: {
      id: "combat-scene",
      name: "Combat Scenario",
      width: 1000,
      height: 1000,
      gridDistance: 5,
      gridSizePx: 100,
      cols: 10,
      rows: 10,
      diagonalRule: "alternating-1",
      combat: { id: "combat", active: true, started: true, ended: false },
    },
    actorToken: { id: "hero", name: "Hero", x: 0, y: 0, width: 1, height: 1 },
    actorStats: { walkSpeedFt },
    terrainCells,
    walls,
    targets,
    tokens: [
      {
        id: "hero",
        name: "Hero",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        hidden: false,
        disposition: 1,
        hp: { value: 24, max: 24, temp: 0 },
        inCombat: true,
        isDeadLike: false,
      },
      ...tokens,
    ],
  };
}

function hostile(id, x, y, extra = {}) {
  return {
    id,
    name: id,
    x: x * 100,
    y: y * 100,
    width: 1,
    height: 1,
    hidden: false,
    disposition: -1,
    hp: { value: 10, max: 10, temp: 0 },
    inCombat: true,
    isDeadLike: false,
    ...extra,
  };
}

test("scenario: fighter routes around wall and picks the exposed archer", () => {
  const scene = sceneWith({
    walls: [{ id: "wall", c: [100, 0, 100, 300], move: true, sight: true, open: false }],
    terrainCells: { "0,1": 2, "0,2": 2, "1,2": 2 },
    tokens: [hostile("brute", 2, 0), hostile("archer", 0, 4)],
    targets: [hostile("brute", 2, 0), hostile("archer", 0, 4)],
  });

  const analyzed = analyzeSceneTactics(scene, { selfTokenId: "hero" });
  const picked = pickAutoTargetFromSceneContext(analyzed, { preferSelected: true });
  const move = derivePathMoveFromSceneContext(analyzed, "archer");

  assert.equal(picked?.id, "archer");
  assert.equal(move?.direction, "S");
  assert.equal(move?.pathCostFt, 25);
});

test("scenario: dead or inactive creatures never survive target filtering", () => {
  const scene = sceneWith({
    tokens: [
      hostile("dead", 1, 0, { hp: { value: 0, max: 10, temp: 0 }, isDeadLike: true }),
      hostile("inactive", 0, 2, { inCombat: false }),
      hostile("live", 2, 2),
    ],
    targets: [
      hostile("dead", 1, 0, { hp: { value: 0, max: 10, temp: 0 }, isDeadLike: true }),
      hostile("inactive", 0, 2, { inCombat: false }),
      hostile("live", 2, 2),
    ],
  });

  const analyzed = analyzeSceneTactics(scene, { selfTokenId: "hero" });
  const picked = pickAutoTargetFromSceneContext(analyzed, { preferSelected: true });

  assert.equal(picked?.id, "live");
});
