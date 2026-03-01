const test = require("node:test");
const assert = require("node:assert/strict");

const {
  analyzeSceneTactics,
  computeCoverLevelFromSamples,
  derivePathMoveFromSceneContext,
  diagonalStepUnits,
  isSegmentBlockedByWalls,
  normalizeWalls,
  pickAutoTargetFromSceneContext,
} = require("../runtime/tactical-grid");

function makeSceneContext({ walls = [], tokens = [], targets = [], terrainCells = {}, diagonalRule = "alternating-1", walkSpeedFt = 30 } = {}) {
  return {
    ok: true,
    scene: {
      id: "scene-1",
      name: "Test Scene",
      width: 800,
      height: 800,
      gridDistance: 5,
      gridSizePx: 100,
      cols: 8,
      rows: 8,
      diagonalRule,
      combat: {
        id: "combat-1",
        active: true,
        started: true,
        ended: false,
      },
    },
    actorToken: {
      id: "self",
      name: "Self",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    },
    actorStats: {
      walkSpeedFt,
    },
    walls,
    terrainCells,
    targets,
    tokens: [
      {
        id: "self",
        name: "Self",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        hidden: false,
        disposition: 1,
        hp: { value: 10, max: 10, temp: 0 },
        inCombat: true,
        isDeadLike: false,
      },
      ...tokens,
    ],
  };
}

function makeToken(id, xCells, yCells, extra = {}) {
  return {
    id,
    name: id,
    x: xCells * 100,
    y: yCells * 100,
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

test("movement/sight wall blocks a line segment", () => {
  const walls = normalizeWalls({
    walls: [{ id: "wall-1", c: [150, 0, 150, 100], move: true, sight: true, open: false }],
  });

  const blocked = isSegmentBlockedByWalls({
    from: { x: 50, y: 50 },
    to: { x: 250, y: 50 },
    walls,
    kind: "sight",
  });

  assert.equal(blocked, true);
});

test("alternating diagonal rule uses 5-10-5 movement costs", () => {
  assert.equal(diagonalStepUnits("alternating-1", 0), 1);
  assert.equal(diagonalStepUnits("alternating-1", 1), 2);
  assert.equal(diagonalStepUnits("exact", 0), Math.SQRT2);
});

test("analyzeSceneTactics applies difficult terrain cost and diagonal pathing", () => {
  const scene = makeSceneContext({
    diagonalRule: "alternating-1",
    terrainCells: {
      "1,1": 2,
      "2,2": 2,
    },
    tokens: [makeToken("orc", 3, 3)],
  });

  const analyzed = analyzeSceneTactics(scene, { selfTokenId: "self" });
  const orc = analyzed.tokens.find((token) => token.id === "orc");

  assert.ok(orc);
  assert.equal(orc.tactical.pathFound, true);
  assert.ok(Array.isArray(orc.tactical.pathSegments));
  assert.ok(orc.tactical.pathSegments.length >= 1);
  assert.equal(orc.tactical.pathDistanceFt, 15);
  assert.ok(orc.tactical.pathCostFt > orc.tactical.pathDistanceFt);
  assert.equal(orc.tactical.difficultTerrainOnPath, true);
  assert.equal(orc.tactical.reachableThisTurn, true);
});

test("cover sampling classifies partial obstruction as half cover", () => {
  const cover = computeCoverLevelFromSamples(10, 3, true);
  assert.equal(cover.coverLevel, "half");
  assert.equal(cover.coverValue, 2);
});

test("pickAutoTargetFromSceneContext prefers visible low-cover hostiles over blocked/dead/out-of-combat ones", () => {
  const scene = makeSceneContext({
    walls: [
      { id: "wall-a", c: [100, 0, 100, 300], move: true, sight: true, open: false },
    ],
    tokens: [
      makeToken("blocked", 2, 0),
      makeToken("visible", 0, 3),
      makeToken("dead", 0, 1, { hp: { value: 0, max: 10, temp: 0 }, isDeadLike: true }),
      makeToken("inactive", 1, 2, { inCombat: false }),
      makeToken("covered", 3, 3, { tactical: { coverLevel: "three-quarters", coverValue: 5 } }),
    ],
  });

  const picked = pickAutoTargetFromSceneContext(scene, { preferSelected: true });
  assert.ok(picked);
  assert.equal(picked.id, "visible");
});

test("derivePathMoveFromSceneContext returns diagonal path segments", () => {
  const scene = makeSceneContext({
    tokens: [makeToken("orc", 3, 3)],
  });

  const derived = derivePathMoveFromSceneContext(scene, "orc");
  assert.ok(derived);
  assert.equal(derived.direction, "SE");
  assert.equal(derived.unit, "grid");
  assert.deepEqual(
    derived.pathSegments.map((segment) => `${segment.direction}${segment.amount}`),
    ["SE2"]
  );
  assert.equal(derived.pathDistanceFt, 15);
});

test("combat scenario prefers reachable visible target over full-cover target through walls", () => {
  const scene = makeSceneContext({
    terrainCells: {
      "0,1": 2,
      "0,2": 2,
      "1,2": 2,
    },
    walls: [
      { id: "wall-full", c: [100, 0, 100, 200], move: true, sight: true, open: false },
    ],
    targets: [makeToken("brute", 2, 0), makeToken("archer", 0, 3)],
    tokens: [
      makeToken("brute", 2, 0),
      makeToken("archer", 0, 3),
    ],
    walkSpeedFt: 30,
  });

  const analyzed = analyzeSceneTactics(scene, { selfTokenId: "self" });
  const brute = analyzed.tokens.find((token) => token.id === "brute");
  const archer = analyzed.tokens.find((token) => token.id === "archer");
  assert.equal(brute.tactical.visibleFromSelf, false);
  assert.equal(archer.tactical.visibleFromSelf, true);
  assert.equal(archer.tactical.pathCostFt, 20);

  const picked = pickAutoTargetFromSceneContext(analyzed, { preferSelected: true });
  assert.ok(picked);
  assert.equal(picked.id, "archer");
});
