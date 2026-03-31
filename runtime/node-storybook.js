"use strict";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function ensureString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function safeLower(value) {
  return ensureString(value).trim().toLowerCase();
}

function normalizeTokenKey(value) {
  return safeLower(value).replace(/\s+/g, " ").trim();
}

function clampNonNegativeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function clampOptionalNonNegativeNumber(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const STORYBOOK_TRANSITION_TYPES = new Set([
  "timeout",
  "active-node-timeout",
  "player-nearby",
  "player-not-nearby",
  "player-visible",
  "combat-started",
  "combat-ended",
  "always",
]);

function normalizeStoryWorkflow(rawWorkflow) {
  const workflow = isPlainObject(rawWorkflow) ? rawWorkflow : {};
  const mode = safeLower(workflow.mode);
  return {
    enabled: workflow.enabled !== false,
    mode: mode === "node-storybook" || mode === "node" || mode === "storybook" || mode === "graph" ? "node-storybook" : "simple",
  };
}

function parseNpcIdList(rawNpcIds) {
  if (Array.isArray(rawNpcIds)) {
    return rawNpcIds.map((value) => ensureString(value).trim()).filter(Boolean);
  }
  return ensureString(rawNpcIds)
    .split(/[\r\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeConditionType(value) {
  const raw = safeLower(value);
  if (raw === "node-timeout" || raw === "active-node-timeout") return "active-node-timeout";
  if (raw === "combat-start" || raw === "combatstarted") return "combat-started";
  if (raw === "combat-end" || raw === "combatended") return "combat-ended";
  if (raw === "nearby-player" || raw === "playernearby") return "player-nearby";
  if (raw === "playervisible" || raw === "visible-player") return "player-visible";
  return STORYBOOK_TRANSITION_TYPES.has(raw) ? raw : "always";
}

function normalizeStoryCondition(rawCondition, index = 0) {
  const condition = isPlainObject(rawCondition) ? rawCondition : { type: rawCondition };
  return {
    id: ensureString(condition.id || `condition-${index + 1}`),
    label: ensureString(condition.label || condition.name || condition.type || `Condition ${index + 1}`),
    type: normalizeConditionType(condition.type || condition.kind || condition.conditionType || condition.when),
    ft: clampOptionalNonNegativeNumber(
      condition.ft ?? condition.distanceFt ?? condition.rangeFt ?? condition.radiusFt ?? condition.thresholdFt,
      null
    ),
    ms: clampOptionalNonNegativeNumber(
      condition.ms ?? condition.timeoutMs ?? condition.durationMs ?? condition.thresholdMs,
      null
    ),
    seconds: clampOptionalNonNegativeNumber(condition.seconds, null),
    minutes: clampOptionalNonNegativeNumber(condition.minutes, null),
  };
}

function getConditionDistanceFt(condition) {
  const distanceFt = clampOptionalNonNegativeNumber(condition?.ft, null);
  return distanceFt == null ? 30 : distanceFt;
}

function getConditionTimeoutMs(condition) {
  const ms = clampOptionalNonNegativeNumber(condition?.ms, null);
  if (ms != null) return ms;
  const seconds = clampOptionalNonNegativeNumber(condition?.seconds, null);
  if (seconds != null) return seconds * 1000;
  const minutes = clampOptionalNonNegativeNumber(condition?.minutes, null);
  if (minutes != null) return minutes * 60_000;
  return 15_000;
}

function normalizeStoryTransition(rawTransition, index = 0) {
  const transition = isPlainObject(rawTransition) ? rawTransition : {};
  const rawConditions = Array.isArray(transition.conditions) && transition.conditions.length ? transition.conditions : [transition];
  const conditions = rawConditions.map((entry, conditionIndex) => normalizeStoryCondition(entry, conditionIndex));
  const primary = conditions[0] || normalizeStoryCondition({ type: "always" }, 0);
  const threshold =
    primary.type === "player-nearby" || primary.type === "player-not-nearby" || primary.type === "player-visible"
      ? getConditionDistanceFt(primary)
      : primary.type === "timeout" || primary.type === "active-node-timeout"
        ? getConditionTimeoutMs(primary)
        : 0;
  return {
    id: ensureString(transition.id || `transition-${index + 1}`),
    label: ensureString(transition.label || transition.name || primary.type || `Transition ${index + 1}`),
    conditionType: primary.type,
    threshold,
    targetNodeId: ensureString(transition.targetNodeId || transition.nextNodeId || transition.target || transition.next || ""),
    conditions,
  };
}

function normalizeStoryNode(rawNode, index = 0) {
  const node = isPlainObject(rawNode) ? rawNode : {};
  const transitions = ensureArray(node.transitions).map((entry, transitionIndex) =>
    normalizeStoryTransition(entry, transitionIndex)
  );
  return {
    id: ensureString(node.id || `node-${index + 1}`),
    label: ensureString(node.label || node.name || `Node ${index + 1}`),
    enabled: node.enabled !== false,
    npcIds: parseNpcIdList(node.npcIds || node.npcs || node.assignedNpcIds),
    worldStateText: ensureString(node.worldStateText || node.sceneText || node.note || node.notes || ""),
    objectiveText: ensureString(node.objectiveText || node.objective || ""),
    stageDirections: ensureString(node.stageDirections || node.directions || ""),
    directorPromptText: ensureString(node.directorPromptText || node.directorText || node.objectiveText || node.objective || ""),
    ambientPromptText: ensureString(node.ambientPromptText || node.ambientText || node.stageDirections || node.directions || ""),
    transitions,
  };
}

function normalizeNodeStorybook(rawStorybook, index = 0) {
  const storybook = isPlainObject(rawStorybook) ? rawStorybook : {};
  const nodes = ensureArray(storybook.nodes).map((entry, nodeIndex) => normalizeStoryNode(entry, nodeIndex));
  if (nodes.length === 0) {
    nodes.push(
      normalizeStoryNode(
        {
          id: "start",
          label: "Start",
          worldStateText: "",
          transitions: [],
        },
        0
      )
    );
  }
  const entryNodeId = ensureString(storybook.entryNodeId || storybook.startNodeId || nodes[0]?.id || "start");
  const normalizedEntryNodeId = nodes.some((node) => node.id === entryNodeId) ? entryNodeId : nodes[0].id;
  return {
    id: ensureString(storybook.id || `storybook-${index + 1}`),
    label: ensureString(storybook.label || storybook.name || `Storybook ${index + 1}`),
    enabled: storybook.enabled !== false,
    sceneId: ensureString(storybook.sceneId || ""),
    sceneName: ensureString(storybook.sceneName || ""),
    notes: ensureString(storybook.notes || ""),
    entryNodeId: normalizedEntryNodeId,
    nodes,
  };
}

function normalizeNodeStorybookList(config) {
  const npcConfig = isPlainObject(config?.npc) ? config.npc : {};
  const modernStorybook = isPlainObject(npcConfig.storybook) ? npcConfig.storybook : null;
  const storybooks = modernStorybook ? ensureArray(modernStorybook.graphs) : ensureArray(npcConfig.nodeStorybooks || npcConfig.storybooks);
  return storybooks.map((entry, index) => normalizeNodeStorybook(entry, index));
}

function resolveNodeStorybook({ config, sceneContext } = {}) {
  const npcConfig = isPlainObject(config?.npc) ? config.npc : {};
  const modernStorybook = isPlainObject(npcConfig.storybook) ? npcConfig.storybook : null;
  const workflow = modernStorybook
    ? {
        enabled: modernStorybook.enabled === true,
        mode: normalizeStoryWorkflow({ mode: modernStorybook.mode }).mode,
      }
    : normalizeStoryWorkflow(npcConfig.socialWorkflow);
  if (!workflow.enabled || workflow.mode !== "node-storybook") return null;

  const sceneId = safeLower(sceneContext?.scene?.id || "");
  const sceneName = normalizeTokenKey(sceneContext?.scene?.name || "");
  if (!sceneId && !sceneName) return null;

  let fallback = null;
  for (const storybook of normalizeNodeStorybookList(config)) {
    if (!storybook.enabled) continue;
    const wantedId = safeLower(storybook.sceneId);
    const wantedName = normalizeTokenKey(storybook.sceneName);
    if (sceneId && wantedId && sceneId === wantedId) return storybook;
    if (!fallback && sceneName && wantedName && sceneName === wantedName) fallback = storybook;
  }
  return fallback;
}

function getStorybookNodeById(storybook, nodeId) {
  const normalizedId = ensureString(nodeId || "");
  return ensureArray(storybook?.nodes).find((node) => ensureString(node?.id || "") === normalizedId) || null;
}

function isCombatActiveInSceneContext(sceneContext) {
  const combat = isPlainObject(sceneContext?.scene?.combat) ? sceneContext.scene.combat : {};
  return !Boolean(combat.ended) && (Boolean(combat.active) || Boolean(combat.started));
}

function getViablePlayerTokens(sceneContext) {
  return ensureArray(sceneContext?.tokens)
    .filter((token) => token?.hasPlayerOwner === true)
    .filter((token) => token?.hidden !== true && token?.defeated !== true && token?.isDeadLike !== true);
}

function getNearestPlayerDistanceFt(sceneContext) {
  const distances = getViablePlayerTokens(sceneContext)
    .map((token) => {
      const orthDistance = Number(token?.orthDistanceFt);
      const distance = Number(token?.distanceFt);
      return Number.isFinite(orthDistance) ? orthDistance : distance;
    })
    .filter((distance) => Number.isFinite(distance) && distance >= 0);
  if (!distances.length) return Number.POSITIVE_INFINITY;
  return Math.min(...distances);
}

function isAnyPlayerVisible(sceneContext) {
  return getViablePlayerTokens(sceneContext).some((token) => {
    const tactical = isPlainObject(token?.tactical) ? token.tactical : null;
    if (!tactical) return true;
    if (tactical.visibleFromSelf === false) return false;
    if (tactical.lineOfEffect === false) return false;
    return true;
  });
}

function buildConditionReason(condition, { nearestPlayerDistanceFt, combatActive, elapsedMs, anyPlayerVisible }) {
  switch (condition.type) {
    case "timeout":
    case "active-node-timeout":
      return `timeout >= ${Math.round(getConditionTimeoutMs(condition))}ms (elapsed=${Math.round(elapsedMs)}ms)`;
    case "player-nearby":
      return `player within ${Number(getConditionDistanceFt(condition))}ft (nearest=${Number.isFinite(nearestPlayerDistanceFt) ? nearestPlayerDistanceFt : "none"})`;
    case "player-not-nearby":
      return `player outside ${Number(getConditionDistanceFt(condition))}ft (nearest=${Number.isFinite(nearestPlayerDistanceFt) ? nearestPlayerDistanceFt : "none"})`;
    case "player-visible":
      return anyPlayerVisible ? "player visible" : "player not visible";
    case "combat-started":
      return combatActive ? "combat started" : "combat inactive";
    case "combat-ended":
      return !combatActive ? "combat ended" : "combat still active";
    case "always":
      return "always";
    default:
      return condition.type;
  }
}

function transitionConditionMatches(condition, { nearestPlayerDistanceFt, combatActive, elapsedMs, anyPlayerVisible }) {
  switch (condition.type) {
    case "timeout":
    case "active-node-timeout":
      return elapsedMs >= Number(getConditionTimeoutMs(condition) || 0);
    case "player-nearby":
      return Number.isFinite(nearestPlayerDistanceFt) && nearestPlayerDistanceFt <= Number(getConditionDistanceFt(condition) || 0);
    case "player-not-nearby":
      return !Number.isFinite(nearestPlayerDistanceFt) || nearestPlayerDistanceFt > Number(getConditionDistanceFt(condition) || 0);
    case "player-visible":
      return anyPlayerVisible === true;
    case "combat-started":
      return combatActive === true;
    case "combat-ended":
      return combatActive === false;
    case "always":
      return true;
    default:
      return false;
  }
}

function advanceNodeStorybookState({ storybook, sceneContext, prevState = null, nowMs = Date.now() } = {}) {
  const normalizedStorybook = normalizeNodeStorybook(storybook, 0);
  const initialNodeId = ensureString(prevState?.nodeId || normalizedStorybook.entryNodeId || normalizedStorybook.nodes[0]?.id || "");
  const nearestPlayerDistanceFt = getNearestPlayerDistanceFt(sceneContext);
  const combatActive = isCombatActiveInSceneContext(sceneContext);
  const anyPlayerVisible = isAnyPlayerVisible(sceneContext);
  let state = {
    nodeId: initialNodeId,
    enteredAtMs: clampNonNegativeNumber(prevState?.enteredAtMs, nowMs),
    lastTransitionId: ensureString(prevState?.lastTransitionId || ""),
    lastTransitionLabel: ensureString(prevState?.lastTransitionLabel || ""),
    lastTransitionReason: ensureString(prevState?.lastTransitionReason || ""),
    updatedAtMs: nowMs,
  };
  if (!state.enteredAtMs) state.enteredAtMs = nowMs;
  const taken = [];
  const visited = new Set();

  for (let hop = 0; hop < Math.max(1, normalizedStorybook.nodes.length); hop += 1) {
    const currentNode = getStorybookNodeById(normalizedStorybook, state.nodeId) || normalizedStorybook.nodes[0];
    if (!currentNode) break;
    if (visited.has(currentNode.id)) break;
    visited.add(currentNode.id);

    const elapsedMs = Math.max(0, nowMs - Number(state.enteredAtMs || nowMs));
    const matchingTransition = currentNode.transitions.find((transition) => {
      if (!transition.targetNodeId) return false;
      if (!getStorybookNodeById(normalizedStorybook, transition.targetNodeId)) return false;
      const conditions = Array.isArray(transition.conditions) && transition.conditions.length
        ? transition.conditions
        : [normalizeStoryCondition({ type: transition.conditionType }, 0)];
      return conditions.every((condition) =>
        transitionConditionMatches(condition, { nearestPlayerDistanceFt, combatActive, elapsedMs, anyPlayerVisible })
      );
    });

    if (!matchingTransition || matchingTransition.targetNodeId === currentNode.id) {
      return {
        storybook: normalizedStorybook,
        node: currentNode,
        state,
        transitionsTaken: taken,
        nearestPlayerDistanceFt,
        combatActive,
        anyPlayerVisible,
      };
    }

    const conditions = Array.isArray(matchingTransition.conditions) && matchingTransition.conditions.length
      ? matchingTransition.conditions
      : [normalizeStoryCondition({ type: matchingTransition.conditionType }, 0)];
    const reason = conditions
      .map((condition) => buildConditionReason(condition, { nearestPlayerDistanceFt, combatActive, elapsedMs, anyPlayerVisible }))
      .filter(Boolean)
      .join("; ");

    taken.push({
      transitionId: matchingTransition.id,
      transitionLabel: matchingTransition.label,
      fromNodeId: currentNode.id,
      toNodeId: matchingTransition.targetNodeId,
      reason,
    });

    state = {
      nodeId: matchingTransition.targetNodeId,
      enteredAtMs: nowMs,
      lastTransitionId: matchingTransition.id,
      lastTransitionLabel: matchingTransition.label,
      lastTransitionReason: reason,
      updatedAtMs: nowMs,
    };
  }

  const fallbackNode = getStorybookNodeById(normalizedStorybook, state.nodeId) || normalizedStorybook.nodes[0] || null;
  return {
    storybook: normalizedStorybook,
    node: fallbackNode,
    state,
    transitionsTaken: taken,
    nearestPlayerDistanceFt,
    combatActive,
    anyPlayerVisible,
  };
}

function isStoryNodeAssignedToNpc(node, npc) {
  const npcIds = parseNpcIdList(node?.npcIds || []);
  if (npcIds.length === 0) return true;
  const keys = new Set(
    [npc?.id, npc?.displayName, npc?.actor?.value]
      .map((value) => normalizeTokenKey(value))
      .filter(Boolean)
  );
  return npcIds.some((entry) => keys.has(normalizeTokenKey(entry)));
}

module.exports = {
  STORYBOOK_TRANSITION_TYPES,
  advanceNodeStorybookState,
  getNearestPlayerDistanceFt,
  getStorybookNodeById,
  isStoryNodeAssignedToNpc,
  normalizeNodeStorybook,
  normalizeNodeStorybookList,
  normalizeStoryCondition,
  normalizeStoryNode,
  normalizeStoryTransition,
  normalizeStoryWorkflow,
  resolveNodeStorybook,
};
