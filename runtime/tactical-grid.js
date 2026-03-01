"use strict";

const DIAGONAL_DIRECTIONS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeDiagonalRule(value) {
  if (typeof value === "number") {
    const table = new Map([
      [0, "alternating-1"],
      [1, "equidistant"],
      [2, "exact"],
      [3, "approximate"],
      [4, "rectilinear"],
      [5, "alternating-2"],
    ]);
    return table.get(value) || "alternating-1";
  }

  const raw = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
  if (!raw) return "alternating-1";
  if (raw.includes("equidistant") || raw === "equal") return "equidistant";
  if (raw.includes("exact")) return "exact";
  if (raw.includes("approx")) return "approximate";
  if (raw.includes("rect") || raw.includes("manhattan")) return "rectilinear";
  if (raw.includes("alternating-2") || raw.includes("10-5")) return "alternating-2";
  if (raw.includes("alternating") || raw.includes("5-10-5")) return "alternating-1";
  return "alternating-1";
}

function normalizeScene(sceneContext) {
  const scene = isPlainObject(sceneContext?.scene) ? sceneContext.scene : {};
  const gridSizePx = Math.max(1, toFiniteNumber(scene.gridSizePx || scene.gridSize, 100));
  const gridDistance = Math.max(1, toFiniteNumber(scene.gridDistance, 5));
  const widthPx = Math.max(0, toFiniteNumber(scene.width, 0));
  const heightPx = Math.max(0, toFiniteNumber(scene.height, 0));
  const cols = Math.max(1, toFiniteNumber(scene.cols, Math.ceil(widthPx / gridSizePx) || 1));
  const rows = Math.max(1, toFiniteNumber(scene.rows, Math.ceil(heightPx / gridSizePx) || 1));
  const diagonalRule = normalizeDiagonalRule(
    scene.diagonalRule ?? scene.diagonals ?? scene.gridDiagonalRule ?? scene.grid?.diagonals
  );
  return { gridSizePx, gridDistance, widthPx, heightPx, cols, rows, diagonalRule };
}

function normalizeTokenRect(token, sceneMeta) {
  if (!isPlainObject(token)) return null;
  const gridSizePx = sceneMeta.gridSizePx;
  const xPx = toFiniteNumber(token.x, 0);
  const yPx = toFiniteNumber(token.y, 0);
  const wCells = Math.max(1, Math.round(toFiniteNumber(token.width, 1)));
  const hCells = Math.max(1, Math.round(toFiniteNumber(token.height, 1)));
  return {
    id: String(token.id || ""),
    x: Math.round(xPx / gridSizePx),
    y: Math.round(yPx / gridSizePx),
    w: wCells,
    h: hCells,
  };
}

function rectKey(rect) {
  return `${rect.x},${rect.y},${rect.w},${rect.h}`;
}

function stateKey(rect, diagonalParity) {
  return `${rectKey(rect)}|${Number(diagonalParity) % 2}`;
}

function topLeftKey(x, y) {
  return `${x},${y}`;
}

function rectCells(rect) {
  const cells = [];
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      cells.push({ x, y });
    }
  }
  return cells;
}

function cellCenterPx(cell, sceneMeta) {
  return {
    x: (Number(cell.x) + 0.5) * sceneMeta.gridSizePx,
    y: (Number(cell.y) + 0.5) * sceneMeta.gridSizePx,
  };
}

function rectCenterPx(rect, sceneMeta) {
  return {
    x: (Number(rect.x) + Number(rect.w) / 2) * sceneMeta.gridSizePx,
    y: (Number(rect.y) + Number(rect.h) / 2) * sceneMeta.gridSizePx,
  };
}

function rectSamplePointsPx(rect, sceneMeta) {
  const size = sceneMeta.gridSizePx;
  const left = rect.x * size;
  const right = (rect.x + rect.w) * size;
  const top = rect.y * size;
  const bottom = (rect.y + rect.h) * size;
  const center = rectCenterPx(rect, sceneMeta);
  return [
    center,
    { x: left + size * 0.2, y: top + size * 0.2 },
    { x: right - size * 0.2, y: top + size * 0.2 },
    { x: left + size * 0.2, y: bottom - size * 0.2 },
    { x: right - size * 0.2, y: bottom - size * 0.2 },
  ];
}

function normalizeWall(wall) {
  if (!isPlainObject(wall)) return null;
  const c = Array.isArray(wall.c) ? wall.c.map((value) => toFiniteNumber(value, 0)) : [];
  if (c.length < 4) return null;

  const isBlockedMode = (value) => {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const raw = value.trim().toLowerCase();
      if (!raw || raw === "0" || raw === "false" || raw === "none") return false;
      return true;
    }
    return toFiniteNumber(value, 0) > 0;
  };

  const open =
    wall.open === true ||
    wall.isOpen === true ||
    wall.document?.isOpen === true ||
    String(wall.doorState || wall.ds || "").trim().toLowerCase() === "open";

  return {
    id: String(wall.id || ""),
    c: [c[0], c[1], c[2], c[3]],
    move: isBlockedMode(wall.move),
    sight: isBlockedMode(wall.sight),
    open,
  };
}

function normalizeWalls(sceneContext) {
  return ensureArray(sceneContext?.walls).map(normalizeWall).filter(Boolean);
}

function normalizeTerrainCells(sceneContext) {
  const raw = isPlainObject(sceneContext?.terrainCells) ? sceneContext.terrainCells : {};
  const out = new Map();
  for (const [key, value] of Object.entries(raw)) {
    const multiplier = Math.max(1, toFiniteNumber(value, 1));
    if (multiplier > 1) out.set(String(key), multiplier);
  }
  return out;
}

function normalizeTerrainRegions(sceneContext) {
  const raw = ensureArray(sceneContext?.terrainRegions);
  return raw
    .map((region) => {
      if (!isPlainObject(region)) return null;
      const multiplier = Math.max(1, toFiniteNumber(region.multiplier, 1));
      if (multiplier <= 1) return null;
      const shape = String(region.shape || region.type || "").trim().toLowerCase();
      if (!shape) return null;
      const normalized = {
        id: String(region.id || ""),
        multiplier,
        shape,
      };
      if (shape === "rect" || shape === "rectangle") {
        normalized.x = toFiniteNumber(region.x, 0);
        normalized.y = toFiniteNumber(region.y, 0);
        normalized.width = Math.max(0, toFiniteNumber(region.width, 0));
        normalized.height = Math.max(0, toFiniteNumber(region.height, 0));
      } else if (shape === "ellipse" || shape === "circle") {
        normalized.x = toFiniteNumber(region.x, 0);
        normalized.y = toFiniteNumber(region.y, 0);
        normalized.radiusX = Math.max(0, toFiniteNumber(region.radiusX ?? region.rx ?? region.radius, 0));
        normalized.radiusY = Math.max(0, toFiniteNumber(region.radiusY ?? region.ry ?? region.radius, 0));
      } else if (shape === "polygon") {
        normalized.points = ensureArray(region.points)
          .map((point) =>
            isPlainObject(point)
              ? { x: toFiniteNumber(point.x, 0), y: toFiniteNumber(point.y, 0) }
              : Array.isArray(point) && point.length >= 2
                ? { x: toFiniteNumber(point[0], 0), y: toFiniteNumber(point[1], 0) }
                : null
          )
          .filter(Boolean);
        if (normalized.points.length < 3) return null;
      } else {
        return null;
      }
      return normalized;
    })
    .filter(Boolean);
}

function cross(ax, ay, bx, by) {
  return ax * by - ay * bx;
}

function pointOnSegment(px, py, ax, ay, bx, by) {
  const area = cross(px - ax, py - ay, bx - ax, by - ay);
  if (Math.abs(area) > 1e-7) return false;
  const minX = Math.min(ax, bx) - 1e-7;
  const maxX = Math.max(ax, bx) + 1e-7;
  const minY = Math.min(ay, by) - 1e-7;
  const maxY = Math.max(ay, by) + 1e-7;
  return px >= minX && px <= maxX && py >= minY && py <= maxY;
}

function segmentsIntersect(a, b, c, d) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const acx = c.x - a.x;
  const acy = c.y - a.y;
  const adx = d.x - a.x;
  const ady = d.y - a.y;
  const cdx = d.x - c.x;
  const cdy = d.y - c.y;
  const cax = a.x - c.x;
  const cay = a.y - c.y;
  const cbx = b.x - c.x;
  const cby = b.y - c.y;

  const o1 = cross(abx, aby, acx, acy);
  const o2 = cross(abx, aby, adx, ady);
  const o3 = cross(cdx, cdy, cax, cay);
  const o4 = cross(cdx, cdy, cbx, cby);

  if ((o1 > 0 && o2 < 0 || o1 < 0 && o2 > 0) && (o3 > 0 && o4 < 0 || o3 < 0 && o4 > 0)) {
    return true;
  }

  if (Math.abs(o1) <= 1e-7 && pointOnSegment(c.x, c.y, a.x, a.y, b.x, b.y)) return true;
  if (Math.abs(o2) <= 1e-7 && pointOnSegment(d.x, d.y, a.x, a.y, b.x, b.y)) return true;
  if (Math.abs(o3) <= 1e-7 && pointOnSegment(a.x, a.y, c.x, c.y, d.x, d.y)) return true;
  if (Math.abs(o4) <= 1e-7 && pointOnSegment(b.x, b.y, c.x, c.y, d.x, d.y)) return true;

  return false;
}

function wallBlocksKind(wall, kind) {
  if (!wall || wall.open) return false;
  return kind === "sight" ? Boolean(wall.sight) : Boolean(wall.move);
}

function isSegmentBlockedByWalls({ from, to, walls, kind }) {
  for (const wall of walls) {
    if (!wallBlocksKind(wall, kind)) continue;
    const c = wall.c;
    if (segmentsIntersect(from, to, { x: c[0], y: c[1] }, { x: c[2], y: c[3] })) {
      return true;
    }
  }
  return false;
}

function rectFitsScene(rect, sceneMeta) {
  return (
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.w <= sceneMeta.cols &&
    rect.y + rect.h <= sceneMeta.rows
  );
}

function buildOccupiedCellSet(tokens, sceneMeta, { ignoreIds = [] } = {}) {
  const ignore = new Set(ensureArray(ignoreIds).map((value) => String(value || "").trim()).filter(Boolean));
  const occupied = new Set();
  for (const token of ensureArray(tokens)) {
    const id = String(token?.id || "").trim();
    if (ignore.has(id)) continue;
    const blocking =
      token?.hidden !== true &&
      token?.isDeadLike !== true &&
      token?.defeated !== true &&
      !(Number.isFinite(Number(token?.hp?.value)) && Number(token.hp.value) <= 0);
    if (!blocking) continue;
    const rect = normalizeTokenRect(token, sceneMeta);
    if (!rect) continue;
    for (const cell of rectCells(rect)) {
      occupied.add(topLeftKey(cell.x, cell.y));
    }
  }
  return occupied;
}

function rectCollidesOccupied(rect, occupied) {
  for (const cell of rectCells(rect)) {
    if (occupied.has(topLeftKey(cell.x, cell.y))) return true;
  }
  return false;
}
function edgeBlockedForRect(fromRect, dx, dy, sceneMeta, walls) {
  if (Math.abs(dx) + Math.abs(dy) !== 1) return true;

  if (dx === 1) {
    for (let row = 0; row < fromRect.h; row += 1) {
      const from = cellCenterPx({ x: fromRect.x + fromRect.w - 1, y: fromRect.y + row }, sceneMeta);
      const to = cellCenterPx({ x: fromRect.x + fromRect.w, y: fromRect.y + row }, sceneMeta);
      if (isSegmentBlockedByWalls({ from, to, walls, kind: "move" })) return true;
    }
    return false;
  }
  if (dx === -1) {
    for (let row = 0; row < fromRect.h; row += 1) {
      const from = cellCenterPx({ x: fromRect.x, y: fromRect.y + row }, sceneMeta);
      const to = cellCenterPx({ x: fromRect.x - 1, y: fromRect.y + row }, sceneMeta);
      if (isSegmentBlockedByWalls({ from, to, walls, kind: "move" })) return true;
    }
    return false;
  }
  if (dy === 1) {
    for (let col = 0; col < fromRect.w; col += 1) {
      const from = cellCenterPx({ x: fromRect.x + col, y: fromRect.y + fromRect.h - 1 }, sceneMeta);
      const to = cellCenterPx({ x: fromRect.x + col, y: fromRect.y + fromRect.h }, sceneMeta);
      if (isSegmentBlockedByWalls({ from, to, walls, kind: "move" })) return true;
    }
    return false;
  }
  for (let col = 0; col < fromRect.w; col += 1) {
    const from = cellCenterPx({ x: fromRect.x + col, y: fromRect.y }, sceneMeta);
    const to = cellCenterPx({ x: fromRect.x + col, y: fromRect.y - 1 }, sceneMeta);
    if (isSegmentBlockedByWalls({ from, to, walls, kind: "move" })) return true;
  }
  return false;
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersects =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInTerrainRegionPx(point, region) {
  if (!region) return false;
  if (region.shape === "rect" || region.shape === "rectangle") {
    return (
      point.x >= region.x &&
      point.x <= region.x + region.width &&
      point.y >= region.y &&
      point.y <= region.y + region.height
    );
  }
  if (region.shape === "ellipse" || region.shape === "circle") {
    const rx = Math.max(region.radiusX, Number.EPSILON);
    const ry = Math.max(region.radiusY, Number.EPSILON);
    const dx = (point.x - region.x) / rx;
    const dy = (point.y - region.y) / ry;
    return dx * dx + dy * dy <= 1;
  }
  if (region.shape === "polygon") {
    return pointInPolygon(point, region.points || []);
  }
  return false;
}

function terrainMultiplierForCell(cell, sceneMeta, terrainCells, terrainRegions) {
  const key = topLeftKey(cell.x, cell.y);
  let multiplier = Math.max(1, toFiniteNumber(terrainCells.get(key), 1));
  if (terrainRegions.length > 0) {
    const point = cellCenterPx(cell, sceneMeta);
    for (const region of terrainRegions) {
      if (pointInTerrainRegionPx(point, region)) {
        multiplier = Math.max(multiplier, Math.max(1, toFiniteNumber(region.multiplier, 1)));
      }
    }
  }
  return multiplier;
}

function terrainMultiplierForRect(rect, sceneMeta, terrainCells, terrainRegions) {
  let multiplier = 1;
  for (const cell of rectCells(rect)) {
    multiplier = Math.max(multiplier, terrainMultiplierForCell(cell, sceneMeta, terrainCells, terrainRegions));
  }
  return multiplier;
}

function diagonalStepUnits(rule, diagonalParity) {
  switch (normalizeDiagonalRule(rule)) {
    case "equidistant":
      return 1;
    case "exact":
      return Math.SQRT2;
    case "approximate":
      return 1.5;
    case "rectilinear":
      return 2;
    case "alternating-2":
      return diagonalParity === 0 ? 2 : 1;
    case "alternating-1":
    default:
      return diagonalParity === 0 ? 1 : 2;
  }
}

function heuristicUnitsForRects(fromRect, goalRects, diagonalRule) {
  const rule = normalizeDiagonalRule(diagonalRule);
  let best = Number.POSITIVE_INFINITY;
  for (const goal of goalRects) {
    const dx = Math.abs(goal.x - fromRect.x);
    const dy = Math.abs(goal.y - fromRect.y);
    let estimate;
    if (rule === "rectilinear") {
      estimate = dx + dy;
    } else if (rule === "exact") {
      const diagonal = Math.min(dx, dy);
      const straight = Math.max(dx, dy) - diagonal;
      estimate = diagonal * Math.SQRT2 + straight;
    } else if (rule === "approximate") {
      const diagonal = Math.min(dx, dy);
      const straight = Math.max(dx, dy) - diagonal;
      estimate = diagonal * 1.5 + straight;
    } else {
      estimate = Math.max(dx, dy);
    }
    if (estimate < best) best = estimate;
  }
  return Number.isFinite(best) ? best : 0;
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function rectsTouchForMelee(a, b) {
  if (rectsOverlap(a, b)) return false;
  const aMaxX = a.x + a.w - 1;
  const aMaxY = a.y + a.h - 1;
  const bMaxX = b.x + b.w - 1;
  const bMaxY = b.y + b.h - 1;
  const gapX = a.x > bMaxX ? a.x - bMaxX - 1 : b.x > aMaxX ? b.x - aMaxX - 1 : 0;
  const gapY = a.y > bMaxY ? a.y - bMaxY - 1 : b.y > aMaxY ? b.y - aMaxY - 1 : 0;
  return gapX === 0 && gapY === 0;
}

function buildGoalRectsAroundTarget(targetRect, actorRect, sceneMeta, occupied) {
  const goals = [];
  const minX = targetRect.x - actorRect.w;
  const maxX = targetRect.x + targetRect.w;
  const minY = targetRect.y - actorRect.h;
  const maxY = targetRect.y + targetRect.h;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const candidate = { x, y, w: actorRect.w, h: actorRect.h };
      if (!rectFitsScene(candidate, sceneMeta)) continue;
      if (rectCollidesOccupied(candidate, occupied)) continue;
      if (!rectsTouchForMelee(candidate, targetRect)) continue;
      goals.push(candidate);
    }
  }
  return goals;
}

function canDiagonalTransition(current, next, dx, dy, sceneMeta, occupied, walls) {
  const horiz = { x: current.x + dx, y: current.y, w: current.w, h: current.h };
  const vert = { x: current.x, y: current.y + dy, w: current.w, h: current.h };
  const pathA =
    rectFitsScene(horiz, sceneMeta) &&
    !rectCollidesOccupied(horiz, occupied) &&
    !edgeBlockedForRect(current, dx, 0, sceneMeta, walls) &&
    !edgeBlockedForRect(horiz, 0, dy, sceneMeta, walls);
  const pathB =
    rectFitsScene(vert, sceneMeta) &&
    !rectCollidesOccupied(vert, occupied) &&
    !edgeBlockedForRect(current, 0, dy, sceneMeta, walls) &&
    !edgeBlockedForRect(vert, dx, 0, sceneMeta, walls);
  if (!pathA && !pathB) return false;
  return rectFitsScene(next, sceneMeta) && !rectCollidesOccupied(next, occupied);
}

function getTransitionForRect(
  current,
  dx,
  dy,
  sceneMeta,
  occupied,
  walls,
  terrainCells,
  terrainRegions,
  diagonalParity
) {
  if (!dx && !dy) return null;
  const next = { x: current.x + dx, y: current.y + dy, w: current.w, h: current.h };
  if (!rectFitsScene(next, sceneMeta)) return null;
  if (rectCollidesOccupied(next, occupied)) return null;

  const diagonal = Math.abs(dx) === 1 && Math.abs(dy) === 1;
  if (diagonal) {
    if (!canDiagonalTransition(current, next, dx, dy, sceneMeta, occupied, walls)) return null;
  } else if (edgeBlockedForRect(current, dx, dy, sceneMeta, walls)) {
    return null;
  }

  const distanceUnits = diagonal ? diagonalStepUnits(sceneMeta.diagonalRule, diagonalParity) : 1;
  const terrainMultiplier = terrainMultiplierForRect(next, sceneMeta, terrainCells, terrainRegions);
  return {
    next,
    diagonal,
    distanceUnits,
    terrainMultiplier,
    costUnits: distanceUnits * terrainMultiplier,
  };
}

function pathRectsToSegments(pathRects) {
  if (!Array.isArray(pathRects) || pathRects.length < 2) return [];
  const segments = [];
  let current = null;

  const directionFromDelta = (dx, dy) => {
    if (dx === 1 && dy === 0) return "E";
    if (dx === -1 && dy === 0) return "W";
    if (dx === 0 && dy === 1) return "S";
    if (dx === 0 && dy === -1) return "N";
    if (dx === 1 && dy === 1) return "SE";
    if (dx === 1 && dy === -1) return "NE";
    if (dx === -1 && dy === 1) return "SW";
    if (dx === -1 && dy === -1) return "NW";
    return "";
  };

  for (let i = 1; i < pathRects.length; i += 1) {
    const prev = pathRects[i - 1];
    const next = pathRects[i];
    const direction = directionFromDelta(next.x - prev.x, next.y - prev.y);
    if (!direction) continue;
    if (current && current.direction === direction) {
      current.amount += 1;
    } else {
      current = { direction, amount: 1, unit: "grid" };
      segments.push(current);
    }
  }
  return segments;
}
function findPathBetweenRects({ startRect, goalRects, sceneMeta, occupied, walls, sceneContext, maxVisited = 10000 }) {
  if (!startRect || !Array.isArray(goalRects) || goalRects.length === 0) return null;
  const goalKeys = new Set(goalRects.map((rect) => rectKey(rect)));
  const terrainCells = normalizeTerrainCells(sceneContext);
  const terrainRegions = normalizeTerrainRegions(sceneContext);
  const start = {
    rect: startRect,
    key: stateKey(startRect, 0),
    diagonalParity: 0,
    steps: 0,
    distanceUnits: 0,
    costUnits: 0,
  };

  if (goalKeys.has(rectKey(startRect))) {
    return { rects: [startRect], steps: 0, distanceUnits: 0, costUnits: 0 };
  }

  const open = [{ ...start, priority: 0 }];
  const bestCost = new Map([[start.key, 0]]);
  const previous = new Map();
  const states = new Map([[start.key, start]]);

  while (open.length > 0) {
    open.sort((a, b) => a.priority - b.priority);
    const current = open.shift();
    const knownCost = bestCost.get(current.key);
    if (!Number.isFinite(knownCost) || current.costUnits > knownCost + 1e-9) continue;
    if (bestCost.size > maxVisited) break;

    if (goalKeys.has(rectKey(current.rect))) {
      const rects = [];
      let cursorKey = current.key;
      while (cursorKey) {
        const state = states.get(cursorKey);
        if (!state) break;
        rects.push(state.rect);
        cursorKey = previous.get(cursorKey)?.prevKey || null;
      }
      rects.reverse();
      return {
        rects,
        steps: current.steps,
        distanceUnits: current.distanceUnits,
        costUnits: current.costUnits,
      };
    }

    for (const [dx, dy] of DIAGONAL_DIRECTIONS) {
      const transition = getTransitionForRect(
        current.rect,
        dx,
        dy,
        sceneMeta,
        occupied,
        walls,
        terrainCells,
        terrainRegions,
        current.diagonalParity
      );
      if (!transition) continue;

      const nextDiagonalParity = transition.diagonal ? (current.diagonalParity + 1) % 2 : current.diagonalParity;
      const next = {
        rect: transition.next,
        key: stateKey(transition.next, nextDiagonalParity),
        diagonalParity: nextDiagonalParity,
        steps: current.steps + 1,
        distanceUnits: current.distanceUnits + transition.distanceUnits,
        costUnits: current.costUnits + transition.costUnits,
      };
      const existingBest = bestCost.get(next.key);
      if (Number.isFinite(existingBest) && existingBest <= next.costUnits + 1e-9) continue;

      bestCost.set(next.key, next.costUnits);
      previous.set(next.key, { prevKey: current.key });
      states.set(next.key, next);
      const heuristic = heuristicUnitsForRects(next.rect, goalRects, sceneMeta.diagonalRule);
      open.push({ ...next, priority: next.costUnits + heuristic });
    }
  }

  return null;
}

function computeCoverLevelFromSamples(totalRays, blockedRays, lineOfEffect) {
  const total = Math.max(1, Number(totalRays || 0));
  const blocked = Math.max(0, Math.min(total, Number(blockedRays || 0)));
  if (!lineOfEffect || blocked >= total) {
    return { coverLevel: "full", coverValue: 99, blockedRatio: 1 };
  }
  const ratio = blocked / total;
  if (ratio >= 0.6) return { coverLevel: "three-quarters", coverValue: 5, blockedRatio: ratio };
  if (ratio >= 0.2) return { coverLevel: "half", coverValue: 2, blockedRatio: ratio };
  return { coverLevel: "none", coverValue: 0, blockedRatio: ratio };
}

function computeCoverAssessment(sceneContext, selfRect, targetRect, walls, existingTactical) {
  if (isPlainObject(existingTactical) && String(existingTactical.coverLevel || "").trim()) {
    return {
      coverLevel: String(existingTactical.coverLevel),
      coverValue: Number.isFinite(Number(existingTactical.coverValue)) ? Number(existingTactical.coverValue) : 0,
      blockedRatio: Number.isFinite(Number(existingTactical.coverRatio))
        ? Number(existingTactical.coverRatio)
        : Number.isFinite(Number(existingTactical.blockedRatio))
          ? Number(existingTactical.blockedRatio)
          : 0,
      coverSamples: isPlainObject(existingTactical.coverSamples) ? existingTactical.coverSamples : null,
    };
  }

  const sceneMeta = normalizeScene(sceneContext);
  const attackerSamples = rectSamplePointsPx(selfRect, sceneMeta);
  const targetSamples = rectSamplePointsPx(targetRect, sceneMeta);
  let totalRays = 0;
  let blockedRays = 0;
  let clearRays = 0;

  for (const from of attackerSamples) {
    for (const to of targetSamples) {
      totalRays += 1;
      if (isSegmentBlockedByWalls({ from, to, walls, kind: "sight" })) {
        blockedRays += 1;
      } else {
        clearRays += 1;
      }
    }
  }

  const lineOfEffect = clearRays > 0;
  const cover = computeCoverLevelFromSamples(totalRays, blockedRays, lineOfEffect);
  return {
    ...cover,
    coverSamples: {
      totalRays,
      blockedRays,
      clearRays,
    },
  };
}

function computeTokenTacticalAssessment(sceneContext, token, { selfTokenId = "" } = {}) {
  const sceneMeta = normalizeScene(sceneContext);
  const selfToken = ensureArray(sceneContext?.tokens).find((entry) => String(entry?.id || "") === String(selfTokenId || ""));
  if (!selfToken) return null;
  const selfRect = normalizeTokenRect(selfToken, sceneMeta);
  const targetRect = normalizeTokenRect(token, sceneMeta);
  if (!selfRect || !targetRect) return null;

  const existing = isPlainObject(token?.tactical) ? token.tactical : {};
  const walls = normalizeWalls(sceneContext);
  const occupied = buildOccupiedCellSet(sceneContext?.tokens, sceneMeta, { ignoreIds: [selfToken.id, token.id] });
  const selfCenter = rectCenterPx(selfRect, sceneMeta);
  const targetCenter = rectCenterPx(targetRect, sceneMeta);
  const fallbackBlockedByWall = isSegmentBlockedByWalls({ from: selfCenter, to: targetCenter, walls, kind: "sight" });
  const blockedByWall =
    typeof existing.blockedByWall === "boolean" ? existing.blockedByWall : fallbackBlockedByWall;
  const hidden = token?.hidden === true;
  const cover = computeCoverAssessment(sceneContext, selfRect, targetRect, walls, existing);
  const lineOfEffect =
    typeof existing.lineOfEffect === "boolean" ? existing.lineOfEffect : blockedByWall !== true && cover.coverLevel !== "full";
  const visibleFromSelf =
    typeof existing.visibleFromSelf === "boolean" ? existing.visibleFromSelf : !hidden && lineOfEffect;
  const goalRects = buildGoalRectsAroundTarget(targetRect, selfRect, sceneMeta, occupied);
  const path = findPathBetweenRects({
    startRect: selfRect,
    goalRects,
    sceneMeta,
    occupied,
    walls,
    sceneContext,
  });
  const pathSegments = pathRectsToSegments(path?.rects || []);
  const pathDistanceFt =
    path && Number.isFinite(path.distanceUnits) ? Number((path.distanceUnits * sceneMeta.gridDistance).toFixed(1)) : null;
  const pathCostFt =
    path && Number.isFinite(path.costUnits) ? Number((path.costUnits * sceneMeta.gridDistance).toFixed(1)) : null;
  const selfWalkFt = toFiniteNumber(sceneContext?.actorStats?.walkSpeedFt, 0);
  const reachableThisTurn = Number.isFinite(pathCostFt) && selfWalkFt > 0 ? pathCostFt <= selfWalkFt + 0.1 : false;

  return {
    ...existing,
    visibleFromSelf,
    lineOfSight: visibleFromSelf,
    lineOfEffect,
    blockedByWall,
    hidden,
    coverLevel: cover.coverLevel,
    coverValue: cover.coverValue,
    coverRatio: Number(cover.blockedRatio.toFixed(2)),
    coverSamples: cover.coverSamples,
    pathFound: Boolean(path && path.rects && path.rects.length > 0),
    pathSteps: path ? path.steps : null,
    pathDistanceFt,
    pathCostFt,
    pathSegments,
    reachableThisTurn,
    goalCount: goalRects.length,
    usesNativeCollision: existing.native === true,
    difficultTerrainOnPath:
      Number.isFinite(pathDistanceFt) &&
      Number.isFinite(pathCostFt) &&
      Number(pathCostFt) > Number(pathDistanceFt) + 0.1,
  };
}
function isTokenTacticallySelectable(token, sceneContext, selfTokenId = "") {
  const id = String(token?.id || "").trim();
  if (!id) return false;
  if (selfTokenId && id === selfTokenId) return false;
  if (Boolean(token?.hidden)) return false;
  if (Boolean(token?.isDeadLike) || Boolean(token?.defeated)) return false;
  if (Number.isFinite(Number(token?.hp?.value)) && Number(token.hp.value) <= 0) return false;
  const combat = sceneContext?.scene?.combat;
  const combatActive = Boolean(combat) && !combat?.ended && (combat?.active || combat?.started);
  if (combatActive && token?.inCombat !== true) return false;
  return true;
}

function analyzeSceneTactics(sceneContext, { selfTokenId } = {}) {
  if (!isPlainObject(sceneContext) || sceneContext.ok === false) return sceneContext;
  const actorTokenId = String(selfTokenId || sceneContext?.actorToken?.id || "").trim();
  if (!actorTokenId) return sceneContext;

  const tokens = ensureArray(sceneContext?.tokens).map((token) => {
    const tactical = computeTokenTacticalAssessment(sceneContext, token, { selfTokenId: actorTokenId });
    return tactical ? { ...token, tactical } : { ...token };
  });

  const byId = new Map(tokens.map((token) => [String(token?.id || ""), token]));
  const targets = ensureArray(sceneContext?.targets).map((token) => {
    const cached = byId.get(String(token?.id || ""));
    if (cached?.tactical) {
      return { ...token, tactical: cached.tactical };
    }
    const tactical = computeTokenTacticalAssessment(
      { ...sceneContext, tokens: ensureArray(sceneContext?.tokens).concat(token) },
      token,
      { selfTokenId: actorTokenId }
    );
    return tactical ? { ...token, tactical } : { ...token };
  });

  return { ...sceneContext, tokens, targets };
}

function compareCandidatePriority(a, b) {
  const as = a?.tactical || {};
  const bs = b?.tactical || {};
  const aVis = as.visibleFromSelf === true ? 1 : 0;
  const bVis = bs.visibleFromSelf === true ? 1 : 0;
  if (aVis !== bVis) return bVis - aVis;

  const aCover = Number.isFinite(Number(as.coverValue)) ? Number(as.coverValue) : 99;
  const bCover = Number.isFinite(Number(bs.coverValue)) ? Number(bs.coverValue) : 99;
  if (aCover !== bCover) return aCover - bCover;

  const aReach = as.reachableThisTurn === true ? 1 : 0;
  const bReach = bs.reachableThisTurn === true ? 1 : 0;
  if (aReach !== bReach) return bReach - aReach;

  const aPath = Number.isFinite(Number(as.pathCostFt)) ? Number(as.pathCostFt) : Number.POSITIVE_INFINITY;
  const bPath = Number.isFinite(Number(bs.pathCostFt)) ? Number(bs.pathCostFt) : Number.POSITIVE_INFINITY;
  if (aPath !== bPath) return aPath - bPath;

  const aDist = Number.isFinite(Number(a?.orthDistanceFt)) ? Number(a.orthDistanceFt) : Number.POSITIVE_INFINITY;
  const bDist = Number.isFinite(Number(b?.orthDistanceFt)) ? Number(b.orthDistanceFt) : Number.POSITIVE_INFINITY;
  if (aDist !== bDist) return aDist - bDist;

  return String(a?.name || "").localeCompare(String(b?.name || ""), "ko");
}

function pickAutoTargetFromSceneContext(sceneContext, { preferSelected = true } = {}) {
  const selfTokenId = String(sceneContext?.actorToken?.id || "").trim();
  const analyzed = analyzeSceneTactics(sceneContext, { selfTokenId });

  const validTargets = ensureArray(analyzed?.targets).filter((token) =>
    isTokenTacticallySelectable(token, analyzed, selfTokenId)
  );
  if (preferSelected && validTargets.length > 0) {
    validTargets.sort(compareCandidatePriority);
    return validTargets[0] || null;
  }

  const tokens = ensureArray(analyzed?.tokens).filter((token) => isTokenTacticallySelectable(token, analyzed, selfTokenId));
  const hostiles = tokens.filter((token) => Number(token?.disposition) < 0);
  const pool = hostiles.length ? hostiles : tokens;
  if (!pool.length) return null;
  pool.sort(compareCandidatePriority);
  return pool[0] || null;
}

function derivePathMoveFromSceneContext(sceneContext, targetTokenRef) {
  const selfTokenId = String(sceneContext?.actorToken?.id || "").trim();
  const analyzed = analyzeSceneTactics(sceneContext, { selfTokenId });
  const tokens = ensureArray(analyzed?.tokens);
  const target =
    tokens.find((token) => String(token?.id || "") === String(targetTokenRef || "").trim()) ||
    tokens.find((token) => String(token?.name || "").trim() === String(targetTokenRef || "").trim()) ||
    null;
  if (!target || !target.tactical || !Array.isArray(target.tactical.pathSegments) || !target.tactical.pathSegments.length) {
    return null;
  }

  const first = target.tactical.pathSegments[0];
  if (!first?.direction) return null;

  return {
    direction: String(first.direction || "").toUpperCase(),
    amount: Number(first.amount || 1),
    unit: "grid",
    pathSegments: target.tactical.pathSegments.map((segment) => ({
      direction: String(segment.direction || "").toUpperCase(),
      amount: Math.max(1, Number(segment.amount || 1)),
      unit: "grid",
    })),
    targetName: String(target?.name || target?.id || "").trim(),
    pathDistanceFt: Number(target?.tactical?.pathDistanceFt),
    pathCostFt: Number(target?.tactical?.pathCostFt),
    visibleFromSelf: target?.tactical?.visibleFromSelf === true,
    blockedByWall: target?.tactical?.blockedByWall === true,
    coverLevel: String(target?.tactical?.coverLevel || ""),
  };
}

module.exports = {
  analyzeSceneTactics,
  buildGoalRectsAroundTarget,
  compareCandidatePriority,
  computeCoverAssessment,
  computeCoverLevelFromSamples,
  computeTokenTacticalAssessment,
  derivePathMoveFromSceneContext,
  diagonalStepUnits,
  edgeBlockedForRect,
  findPathBetweenRects,
  heuristicUnitsForRects,
  isSegmentBlockedByWalls,
  isTokenTacticallySelectable,
  normalizeDiagonalRule,
  normalizeScene,
  normalizeTerrainCells,
  normalizeTerrainRegions,
  normalizeTokenRect,
  normalizeWalls,
  pathRectsToSegments,
  pickAutoTargetFromSceneContext,
  segmentsIntersect,
  terrainMultiplierForRect,
};
