#!/usr/bin/env node
const path = require("node:path");
const readline = require("node:readline");

const { AppRuntime } = require("./app-runtime");
const { loadAppConfig, saveAppConfig } = require("./config-store");

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a) continue;
    if (a.startsWith("--")) {
      const key = String(a.slice(2) || "").trim();
      if (!key) continue;
      const next = argv[i + 1];
      if (next && !String(next).startsWith("--")) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
      continue;
    }
    args._.push(a);
  }
  return args;
}

function defaultConfigPath() {
  return path.join(process.cwd(), "config.json");
}

function askLine(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || ""));
    });
  });
}

function normalizeLoose(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function actorSelectorForNpc(npc) {
  const actor = npc?.actor || {};
  const type = String(actor.type || "name").toLowerCase();
  const value = String(actor.value || "").trim();
  if (!value) return { actorId: "", actorName: "" };
  if (type === "id" || type === "actorid") return { actorId: value, actorName: "" };
  return { actorId: "", actorName: value };
}

async function withNpcActor(config, npc, fn) {
  const sel = actorSelectorForNpc(npc);
  const foundry = config.foundry || {};
  const prevId = foundry.actorId;
  const prevName = foundry.actorName;
  foundry.actorId = sel.actorId;
  foundry.actorName = sel.actorName;
  try {
    return await fn();
  } finally {
    foundry.actorId = prevId;
    foundry.actorName = prevName;
  }
}

function pickProbeNpcs(config, npcFilterRaw) {
  const npcFilter = String(npcFilterRaw || "").trim();
  const all = Array.isArray(config?.npcs) ? config.npcs.filter((n) => n && n.enabled !== false) : [];
  if (npcFilter) {
    const needle = normalizeLoose(npcFilter);
    return all.filter((n) => {
      const id = normalizeLoose(n?.id);
      const name = normalizeLoose(n?.displayName);
      return id === needle || name === needle || id.includes(needle) || name.includes(needle);
    });
  }
  if (all.length > 0) return all;

  const fallbackId = String(config?.npc?.defaultNpcId || "default").trim() || "default";
  const fallbackActorId = String(config?.foundry?.actorId || "").trim();
  const fallbackActorName = String(config?.foundry?.actorName || "").trim();
  return [
    {
      id: fallbackId,
      displayName: fallbackId,
      enabled: true,
      actor: fallbackActorId ? { type: "id", value: fallbackActorId } : { type: "name", value: fallbackActorName },
    },
  ];
}

function tokenMatches(token, targetNeedle) {
  if (!targetNeedle) return false;
  const id = normalizeLoose(token?.id);
  const name = normalizeLoose(token?.name);
  const actorName = normalizeLoose(token?.actorName);
  return id === targetNeedle || name === targetNeedle || actorName === targetNeedle || name.includes(targetNeedle);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || "help";
  const configPath = path.resolve(args.config || defaultConfigPath());

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(
      [
        "fvtt-ai-runtime CLI",
        "",
        "Commands:",
        "  node runtime/cli.js diagnose [--config ./config.json]",
        "  node runtime/cli.js run [--config ./config.json]",
        "  node runtime/cli.js setup [--config ./config.json]",
        "  node runtime/cli.js codex-login [--config ./config.json]",
        "  node runtime/cli.js oauth-login [--config ./config.json]",
        "  node runtime/cli.js probe [--config ./config.json] [--npc diana] [--target 피티팡] [--maxTokens 60]",
      ].join("\n")
    );
    return;
  }

  if (cmd === "setup") {
    const config = await loadAppConfig(configPath);
    const rt = new AppRuntime({
      onLog: (e) => {
        const ts = e.ts ? new Date(e.ts).toLocaleTimeString() : "";
        console.log(`[${ts}] ${e.level} ${e.scope}: ${e.message}`);
      },
    });
    const result = await rt.ensurePrerequisitesForConfig({ config });
    if (!result?.ok) {
      throw new Error(result?.error || "setup failed");
    }
    if (result?.provider === "codex-cli" && result?.codexBinPath) {
      config.llm = config.llm || {};
      config.llm.codexCli = config.llm.codexCli || {};
      config.llm.codexCli.binPath = String(result.codexBinPath || "").trim();
      await saveAppConfig(configPath, config);
      console.log(`Saved codex bin path: ${config.llm.codexCli.binPath}`);
    }
    console.log("Setup complete.");
    return;
  }

  if (cmd === "codex-login") {
    const config = await loadAppConfig(configPath);
    const rt = new AppRuntime({
      onLog: (e) => {
        const ts = e.ts ? new Date(e.ts).toLocaleTimeString() : "";
        console.log(`[${ts}] ${e.level} ${e.scope}: ${e.message}`);
      },
    });
    const launched = await rt.launchCodexLoginForUser({ config });
    if (!launched?.ok) {
      throw new Error(launched?.error || "failed to launch codex login");
    }
    console.log("Codex login terminal launched. Complete login there, then run diagnose.");
    return;
  }

  if (cmd === "oauth-login") {
    const config = await loadAppConfig(configPath);
    const rt = new AppRuntime({
      onLog: (e) => {
        const ts = e.ts ? new Date(e.ts).toLocaleTimeString() : "";
        console.log(`[${ts}] ${e.level} ${e.scope}: ${e.message}`);
      },
    });

    const creds = await rt.oauthLoginOpenAiCodex({
      openUrl: async (url) => {
        console.log("Open this URL in your browser:");
        console.log(url);
      },
      prompt: async ({ message }) => {
        return askLine(message + " ");
      },
    });

    config.llm = config.llm || {};
    config.llm.provider = "openai-oauth";
    config.llm.openai = config.llm.openai || {};
    config.llm.openai.oauth = {
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      expiresAtMs: creds.expiresAtMs,
    };
    await saveAppConfig(configPath, config);
    console.log("Saved OAuth tokens to config.json (MVP).");
    return;
  }

  if (cmd === "diagnose") {
    const config = await loadAppConfig(configPath);
    const rt = new AppRuntime({
      onLog: (e) => {
        const ts = e.ts ? new Date(e.ts).toLocaleTimeString() : "";
        console.log(`[${ts}] ${e.level} ${e.scope}: ${e.message}`);
      },
    });
    await rt.start({ config });
    const diag = await rt.runDiagnostics({ config });
    console.log(JSON.stringify(diag, null, 2));
    await rt.stop();
    return;
  }

  if (cmd === "probe") {
    const { FvttClient } = require("./fvtt/fvtt-client");
    const config = await loadAppConfig(configPath);
    const targetRaw = String(args.target || "").trim();
    const targetNeedle = normalizeLoose(targetRaw);
    const maxTokens = Math.min(100, Math.max(10, Number(args.maxTokens || 60) || 60));
    const npcs = pickProbeNpcs(config, args.npc);

    if (!npcs.length) {
      throw new Error("No NPCs resolved for probe. Check config.npcs or --npc filter.");
    }

    const fvtt = new FvttClient(config);
    try {
      const connected = await fvtt.ensureConnected();
      if (!connected?.ok) {
        throw new Error(`FVTT connect failed: ${connected?.error || "unknown error"}`);
      }

      const sceneTokensRes = await fvtt.listSceneTokens().catch((e) => ({ ok: false, error: e?.message || String(e) }));
      if (sceneTokensRes?.ok) {
        console.log(`[scene] ${sceneTokensRes.scene?.name || "-"} tokens=${sceneTokensRes.count || 0}`);
      } else {
        console.log(`[scene] token listing failed: ${sceneTokensRes?.error || "unknown error"}`);
      }

      for (const npc of npcs) {
        const npcName = String(npc?.displayName || npc?.id || "npc");
        const sel = actorSelectorForNpc(npc);
        console.log("");
        console.log(`[npc] ${npcName} (id=${String(npc?.id || "") || "-"}) actorId=${sel.actorId || "-"} actorName=${sel.actorName || "-"}`);

        const status = await withNpcActor(config, npc, () =>
          fvtt.getStatus().catch((e) => ({ ok: false, error: e?.message || String(e) }))
        );
        const statusActorId = String(status?.actor?.id || "").trim();
        const statusActorName = String(status?.actor?.name || sel.actorName || "").trim();
        if (status?.ok) {
          console.log(
            `[status] actor=${status.actor?.name || "-"} actorId=${statusActorId || "-"} scene=${status.scene?.name || "-"} token=${status.token?.name || "-"}`
          );
        } else {
          console.log(`[status] failed: ${status?.error || "unknown error"}`);
        }

        if (sceneTokensRes?.ok && statusActorName) {
          const sceneTokens = Array.isArray(sceneTokensRes.tokens) ? sceneTokensRes.tokens : [];
          const actorIdMatches = statusActorId
            ? sceneTokens.filter((t) => String(t?.actorId || "").trim() === statusActorId)
            : [];
          const actorNameNeedle = normalizeLoose(statusActorName);
          const actorNameMatches = sceneTokens.filter(
            (t) => normalizeLoose(t?.actorName || t?.name || "") === actorNameNeedle
          );

          if (actorIdMatches.length > 0) {
            console.log(
              `[scene-match] actorIdOnScene=${actorIdMatches.length} ${actorIdMatches
                .slice(0, 6)
                .map((t) => `${t.name}(${t.id})`)
                .join(", ")}`
            );
          } else {
            console.log("[scene-match] actorIdOnScene=0");
          }

          if (actorNameMatches.length > 0) {
            console.log(
              `[scene-match] actorNameOnScene=${actorNameMatches.length} ${actorNameMatches
                .slice(0, 6)
                .map((t) => `${t.name}(${t.id})`)
                .join(", ")}`
            );
          }

          if (
            status?.ok &&
            String(status.scene?.id || "").trim() &&
            String(sceneTokensRes.scene?.id || "").trim() &&
            String(status.scene.id) !== String(sceneTokensRes.scene.id) &&
            actorNameMatches.length > 0 &&
            actorIdMatches.length === 0
          ) {
            console.log(
              "[warn] Actor selector likely points to a different actor with the same name. Pin npc.actorId in config."
            );
          }
        }

        const ctx = await withNpcActor(config, npc, () =>
          fvtt.getSceneContext(maxTokens).catch((e) => ({ ok: false, error: e?.message || String(e) }))
        );
        if (!ctx?.ok) {
          console.log(`[context] failed: ${ctx?.error || "unknown error"}`);
          continue;
        }

        const sampledTokens = Array.isArray(ctx.tokens) ? ctx.tokens : [];
        const totalTokens = Number(ctx?.counts?.total || sampledTokens.length);
        console.log(
          `[context] scene=${ctx.scene?.name || "-"} actorToken=${ctx.actorToken ? "on-scene" : "missing"} sampled=${sampledTokens.length}/${totalTokens}`
        );
        if (ctx.actorTokenInOtherScene) {
          console.log(
            `[context] actorTokenInOtherScene=${ctx.actorTokenInOtherScene.sceneName || "-"} / ${ctx.actorTokenInOtherScene.tokenName || "-"}`
          );
        }

        const sampledActors = sampledTokens.filter((t) => String(t?.actorId || "").trim());
        if (sampledActors.length > 0) {
          const preview = sampledActors
            .slice(0, 12)
            .map((t) => `${t.name}(${t.id})`)
            .join(", ");
          console.log(`[context] actor-backed sampled tokens: ${preview}`);
        } else {
          console.log("[context] actor-backed sampled tokens: (none)");
        }

        if (targetNeedle) {
          const sampledMatches = sampledTokens.filter((t) => tokenMatches(t, targetNeedle));
          const sceneMatches = sceneTokensRes?.ok
            ? sceneTokensRes.tokens.filter((t) => tokenMatches(t, targetNeedle))
            : [];
          console.log(
            `[target:${targetRaw}] sampledMatches=${sampledMatches.length} fullSceneMatches=${sceneMatches.length}`
          );
          if (sampledMatches.length > 0) {
            console.log(
              `[target:${targetRaw}] sampled=${sampledMatches
                .slice(0, 6)
                .map((t) => `${t.name}(${t.id})`)
                .join(", ")}`
            );
          }
          if (sceneMatches.length > 0) {
            console.log(
              `[target:${targetRaw}] fullScene=${sceneMatches
                .slice(0, 10)
                .map((t) => `${t.name}(${t.id})`)
                .join(", ")}`
            );
          }
        }
      }
    } finally {
      await fvtt.close().catch(() => {});
    }
    return;
  }

  if (cmd === "run") {
    const config = await loadAppConfig(configPath);
    const rt = new AppRuntime({
      onLog: (e) => {
        const ts = e.ts ? new Date(e.ts).toLocaleTimeString() : "";
        console.log(`[${ts}] ${e.level} ${e.scope}: ${e.message}`);
      },
    });
    await rt.start({ config });
    console.log("Runtime running. Press Ctrl+C to stop.");
    process.on("SIGINT", async () => {
      await rt.stop();
      process.exit(0);
    });
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error("[fatal]", err?.message || err);
  process.exit(1);
});
