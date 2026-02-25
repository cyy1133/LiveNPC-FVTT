const { chromium } = require("playwright");

class FvttClient {
  constructor(config) {
    this.config = config;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.ready = false;
    this.connectingPromise = null;
    this.keepAliveTimer = null;
    this.keepAliveInFlight = false;
    this.lastKeepAliveOkAt = 0;
  }

  async connect() {
    try {
      await this.close();

      this.browser = await chromium.launch({
        headless: this.config.foundry.headless,
      });
      this.context = await this.browser.newContext();
      this.page = await this.context.newPage();

      this.page.setDefaultTimeout(this.config.foundry.loginTimeoutMs);
      await this.page.goto(this.config.foundry.url, { waitUntil: "domcontentloaded" });

      await this._loginIfNeeded();
      await this._waitForGameReady();
      this.ready = true;
      this._startKeepAlive();
    } catch (error) {
      const diag = this.page ? await this._diagnosePage().catch(() => null) : null;
      if (diag) {
        console.error("[fvtt-diag]", JSON.stringify(diag, null, 2));
      }
      await this.close().catch(() => {});
      throw error;
    }
  }

  async ensureConnected() {
    if (this.isReady()) {
      return { ok: true };
    }

    if (!this.connectingPromise) {
      this.connectingPromise = this.connect().finally(() => {
        this.connectingPromise = null;
      });
    }

    try {
      await this.connectingPromise;
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  async close() {
    this.ready = false;
    this._stopKeepAlive();
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    if (this.context) {
      try {
        await this.context.close();
      } catch {
        // browser.close may have already closed context
      }
      this.context = null;
      this.page = null;
    }
  }

  isReady() {
    return Boolean(this.ready && this.page);
  }

  _startKeepAlive() {
    this._stopKeepAlive();

    const intervalMs = Number(this.config?.foundry?.keepAliveMs ?? 0);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;

    this.keepAliveTimer = setInterval(() => {
      void this._keepAliveTick();
    }, intervalMs);

    // Don't keep the process alive just because of keepalive.
    if (this.keepAliveTimer && typeof this.keepAliveTimer.unref === "function") {
      this.keepAliveTimer.unref();
    }
  }

  _stopKeepAlive() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    this.keepAliveInFlight = false;
  }

  async _keepAliveTick() {
    if (this.keepAliveInFlight) return;
    if (!this.ready || !this.page) return;

    this.keepAliveInFlight = true;
    try {
      const result = await this.page.evaluate(() => ({
        ok: true,
        ready: Boolean(globalThis.game?.ready),
        userId: String(globalThis.game?.user?.id || ""),
        worldId: String(globalThis.game?.world?.id || ""),
        ts: Date.now(),
      }));

      if (result?.ok && result?.ready) {
        this.lastKeepAliveOkAt = Date.now();
      }
    } catch (error) {
      const message = error?.message || String(error);
      if (
        /Target page, context or browser has been closed|Browser has been closed|Protocol error/i.test(message)
      ) {
        console.warn("[fvtt] keepalive lost session:", message);
        await this.close().catch(() => {});
      }
    } finally {
      this.keepAliveInFlight = false;
    }
  }

  async getStatus() {
    await this._waitForGameReady();
    return this.page.evaluate(({ actorId, actorName }) => {
      function sceneTokens(scene) {
        if (!scene) return [];
        if (Array.isArray(scene.tokens?.contents)) return scene.tokens.contents;
        if (Array.isArray(scene.tokens)) return scene.tokens;
        return [];
      }

      function findActor() {
        if (actorId) return game.actors.get(actorId) ?? null;
        if (!actorName) return null;
        const named = game.actors.filter((a) => a.name === actorName);
        if (named.length <= 1) return named[0] ?? null;

        const preferredScenes = [];
        const pushUnique = (scene) => {
          if (!scene?.id) return;
          if (!preferredScenes.some((entry) => entry.id === scene.id)) preferredScenes.push(scene);
        };
        pushUnique(canvas?.scene || null);
        pushUnique(game.scenes.current || null);
        pushUnique(game.scenes.active || null);

        for (const scene of preferredScenes) {
          const actorIdsOnScene = new Set(sceneTokens(scene).map((token) => String(token?.actorId || "")));
          const sceneMatch = named.find((candidate) => actorIdsOnScene.has(String(candidate?.id || "")));
          if (sceneMatch) return sceneMatch;
        }
        return named[0] ?? null;
      }

      function findTokenForActor(actor) {
        if (!actor) return { scene: null, token: null };
        const preferredScenes = [];
        const pushUnique = (scene) => {
          if (!scene?.id) return;
          if (!preferredScenes.some((entry) => entry.id === scene.id)) preferredScenes.push(scene);
        };

        pushUnique(canvas?.scene || null);
        pushUnique(game.scenes.current || null);
        pushUnique(game.scenes.active || null);

        for (const scene of preferredScenes) {
          const found = sceneTokens(scene).find((t) => t.actorId === actor.id);
          if (found) return { scene, token: found };
        }
        for (const scene of game.scenes.contents) {
          const found = sceneTokens(scene).find((t) => t.actorId === actor.id);
          if (found) return { scene, token: found };
        }
        return { scene: null, token: null };
      }

      function summarizeSpellStatus(actor) {
        const spellItems = (Array.isArray(actor?.items?.contents) ? actor.items.contents : []).filter(
          (item) => item.type === "spell"
        );
        const spells = actor?.system?.spells ?? {};
        const slots = {};
        for (const [key, slot] of Object.entries(spells)) {
          if (!slot || typeof slot !== "object") continue;
          const value = Number(slot.value ?? 0);
          const max = Number(slot.max ?? 0);
          if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) continue;
          slots[key] = { value, max };
        }

        const prepared = spellItems.filter((item) => {
          const preparedRaw = item.system?.preparation?.prepared;
          const mode = String(item.system?.preparation?.mode || "").toLowerCase();
          return Boolean(preparedRaw) || mode === "always";
        });

        return {
          count: spellItems.length,
          preparedCount: prepared.length,
          slots,
          spellDc: Number(actor?.system?.attributes?.spelldc ?? 0) || null,
        };
      }

      function normalizeImageSrc(value) {
        return String(value || "").trim();
      }

      function tokenImageSrc(tokenDoc, actor) {
        return (
          normalizeImageSrc(tokenDoc?.texture?.src) ||
          normalizeImageSrc(tokenDoc?.img) ||
          normalizeImageSrc(tokenDoc?.document?.texture?.src) ||
          normalizeImageSrc(tokenDoc?.document?.img) ||
          normalizeImageSrc(actor?.prototypeToken?.texture?.src) ||
          normalizeImageSrc(actor?.img)
        );
      }

      const actor = findActor();
      if (!actor) {
        return { ok: false, error: "FVTT ?≫꽣瑜?李얠? 紐삵뻽?듬땲?? FVTT_ACTOR_ID/FVTT_ACTOR_NAME???뺤씤?섏꽭??" };
      }

      const { scene, token } = findTokenForActor(actor);
      if (!token || !scene) {
        return {
          ok: false,
          error: "?쒖꽦 ?붾뱶?먯꽌 ?대떦 ?≫꽣 ?좏겙??李얠? 紐삵뻽?듬땲?? ?좏겙??留듭뿉 諛곗튂??二쇱꽭??",
          actor: {
            id: actor.id,
            name: actor.name,
          },
        };
      }

      const movement = actor.system?.attributes?.movement ?? {};
      const walkSpeedFt = Number(movement.walk ?? movement.land ?? movement.fly ?? 30) || 30;
      const gridDistance = Number(scene.grid?.distance ?? 5) || 5;

      return {
        ok: true,
        actor: {
          id: actor.id,
          name: actor.name,
          img: normalizeImageSrc(actor?.img),
          walkSpeedFt,
          spells: summarizeSpellStatus(actor),
        },
        scene: {
          id: scene.id,
          name: scene.name,
          gridDistance,
        },
        token: {
          id: token.id,
          name: token.name,
          x: token.x,
          y: token.y,
          img: tokenImageSrc(token, actor),
          textureSrc: normalizeImageSrc(token?.texture?.src),
        },
      };
    }, this._actorSelector());
  }

  async speakAsActor(text) {
    await this._waitForGameReady();
    return this.page.evaluate(
      async ({ actorId, actorName, text: body }) => {
        function sceneTokens(scene) {
          if (!scene) return [];
          if (Array.isArray(scene.tokens?.contents)) return scene.tokens.contents;
          if (Array.isArray(scene.tokens)) return scene.tokens;
          return [];
        }

        function findActor() {
          if (actorId) return game.actors.get(actorId) ?? null;
          if (!actorName) return null;
          const named = game.actors.filter((a) => a.name === actorName);
          if (named.length <= 1) return named[0] ?? null;

          const preferredScenes = [];
          const pushUnique = (scene) => {
            if (!scene?.id) return;
            if (!preferredScenes.some((entry) => entry.id === scene.id)) preferredScenes.push(scene);
          };
          pushUnique(canvas?.scene || null);
          pushUnique(game.scenes.current || null);
          pushUnique(game.scenes.active || null);

          for (const scene of preferredScenes) {
            const actorIdsOnScene = new Set(sceneTokens(scene).map((token) => String(token?.actorId || "")));
            const sceneMatch = named.find((candidate) => actorIdsOnScene.has(String(candidate?.id || "")));
            if (sceneMatch) return sceneMatch;
          }
          return named[0] ?? null;
        }

        function findTokenForActor(actor) {
          if (!actor) return { scene: null, token: null };
          const preferredScenes = [];
          const pushUnique = (scene) => {
            if (!scene?.id) return;
            if (!preferredScenes.some((entry) => entry.id === scene.id)) preferredScenes.push(scene);
          };

          pushUnique(canvas?.scene || null);
          pushUnique(game.scenes.current || null);
          pushUnique(game.scenes.active || null);

          for (const scene of preferredScenes) {
            const found = sceneTokens(scene).find((t) => t.actorId === actor.id);
            if (found) return { scene, token: found };
          }
          for (const scene of game.scenes.contents) {
            const found = sceneTokens(scene).find((t) => t.actorId === actor.id);
            if (found) return { scene, token: found };
          }
          return { scene: null, token: null };
        }

        const actor = findActor();
        if (!actor) return { ok: false, error: "?≫꽣瑜?李얠? 紐삵뻽?듬땲??" };

        const { scene, token } = findTokenForActor(actor);
        if (!scene || !token) return { ok: false, error: "?좏겙??李얠? 紐삵뻽?듬땲??" };

        const message = await ChatMessage.create({
          speaker: {
            actor: actor.id,
            token: token.id,
            scene: scene.id,
            alias: actor.name,
          },
          content: body,
        });

        return { ok: true, messageId: message.id, actorName: actor.name };
      },
      { ...this._actorSelector(), text }
    );
  }

  async moveToken(moveIntent, difficultTerrainMultiplier) {
    await this._waitForGameReady();
    return this.page.evaluate(
      async ({ actorId, actorName, move, difficultTerrainMultiplier: terrainMultiplier }) => {
        function sceneTokens(scene) {
          if (!scene) return [];
          if (Array.isArray(scene.tokens?.contents)) return scene.tokens.contents;
          if (Array.isArray(scene.tokens)) return scene.tokens;
          return [];
        }

        function findActor() {
          if (actorId) return game.actors.get(actorId) ?? null;
          if (!actorName) return null;
          const named = game.actors.filter((a) => a.name === actorName);
          if (named.length <= 1) return named[0] ?? null;

          const preferredScenes = [];
          const pushUnique = (scene) => {
            if (!scene?.id) return;
            if (!preferredScenes.some((entry) => entry.id === scene.id)) preferredScenes.push(scene);
          };
          pushUnique(canvas?.scene || null);
          pushUnique(game.scenes.current || null);
          pushUnique(game.scenes.active || null);

          for (const scene of preferredScenes) {
            const actorIdsOnScene = new Set(sceneTokens(scene).map((token) => String(token?.actorId || "")));
            const sceneMatch = named.find((candidate) => actorIdsOnScene.has(String(candidate?.id || "")));
            if (sceneMatch) return sceneMatch;
          }
          return named[0] ?? null;
        }

        function findTokenForActor(actor) {
          if (!actor) return { scene: null, token: null };
          const preferredScenes = [];
          const pushUnique = (scene) => {
            if (!scene?.id) return;
            if (!preferredScenes.some((entry) => entry.id === scene.id)) preferredScenes.push(scene);
          };

          pushUnique(canvas?.scene || null);
          pushUnique(game.scenes.current || null);
          pushUnique(game.scenes.active || null);

          for (const scene of preferredScenes) {
            const found = sceneTokens(scene).find((t) => t.actorId === actor.id);
            if (found) return { scene, token: found };
          }
          for (const scene of game.scenes.contents) {
            const found = sceneTokens(scene).find((t) => t.actorId === actor.id);
            if (found) return { scene, token: found };
          }
          return { scene: null, token: null };
        }

        function directionVector(direction) {
          const table = {
            N: [0, -1],
            S: [0, 1],
            E: [1, 0],
            W: [-1, 0],
            NE: [1, -1],
            NW: [-1, -1],
            SE: [1, 1],
            SW: [-1, 1],
          };
          return table[direction] ?? null;
        }

        const actor = findActor();
        if (!actor) return { ok: false, error: "?≫꽣瑜?李얠? 紐삵뻽?듬땲??" };

        const { scene, token } = findTokenForActor(actor);
        if (!scene || !token) {
          return {
            ok: false,
            error: "?쒖꽦 ?붾뱶?먯꽌 ?≫꽣 ?좏겙??李얠? 紐삵뻽?듬땲?? 癒쇱? ?좏겙??留듭뿉 ?щ젮 二쇱꽭??",
          };
        }

        const vector = directionVector(move.direction);
        if (!vector) return { ok: false, error: "?대룞 諛⑺뼢 ?댁꽍???ㅽ뙣?덉뒿?덈떎." };

        if (!canvas.scene || canvas.scene.id !== scene.id) {
          await scene.view();
          await new Promise((resolve) => setTimeout(resolve, 250));
        }

        const placeable = canvas.tokens.placeables.find((t) => t.document.id === token.id);
        if (!placeable) {
          return { ok: false, error: "罹붾쾭?ㅼ뿉???좏겙??李얠? 紐삵뻽?듬땲?? ?대떦 ?ъ씠 ?대젮 ?덈뒗吏 ?뺤씤??二쇱꽭??" };
        }

        const movement = actor.system?.attributes?.movement ?? {};
        const walkSpeedFt = Number(movement.walk ?? movement.land ?? movement.fly ?? 30) || 30;
        const sceneGridDistance = Number(canvas.scene.grid.distance ?? 5) || 5;
        const gridSizePx = Number(canvas.grid.size ?? 100) || 100;
        const difficultMultiplier = Number(terrainMultiplier) > 1 ? Number(terrainMultiplier) : 2;
        const costMultiplier = move.difficult ? difficultMultiplier : 1;
        const stepBudgetFt = walkSpeedFt / costMultiplier;

        let requestedDistanceFt;
        if (move.maxRequested) {
          requestedDistanceFt = stepBudgetFt;
        } else if (move.amount === null || move.amount === undefined) {
          requestedDistanceFt = sceneGridDistance;
        } else if (move.unit === "ft") {
          requestedDistanceFt = Number(move.amount);
        } else {
          requestedDistanceFt = Number(move.amount) * sceneGridDistance;
        }

        if (!Number.isFinite(requestedDistanceFt) || requestedDistanceFt <= 0) {
          requestedDistanceFt = sceneGridDistance;
        }

        let requestedSteps = Math.max(1, Math.floor(requestedDistanceFt / sceneGridDistance));
        const maxByBudgetSteps = Math.max(1, Math.floor(stepBudgetFt / sceneGridDistance));
        if (move.maxRequested) {
          requestedSteps = maxByBudgetSteps;
        }

        const tokenWidthPx = Number(placeable.document.width ?? 1) * gridSizePx;
        const tokenHeightPx = Number(placeable.document.height ?? 1) * gridSizePx;
        const [vx, vy] = vector;
        const startX = Number(placeable.document.x);
        const startY = Number(placeable.document.y);
        const isDiagonal = vx !== 0 && vy !== 0;

        if (isDiagonal) {
          // Execute diagonal intent as two axis-aligned moves (X then Y). This keeps Discord-style
          // commands predictable and avoids diagonal ambiguity.
          const budgetSteps = Math.max(0, Math.floor(stepBudgetFt / sceneGridDistance));
          const xSteps = Math.min(requestedSteps, budgetSteps);
          const ySteps = Math.min(requestedSteps, Math.max(0, budgetSteps - xSteps));
          const totalSteps = xSteps + ySteps;

          if (totalSteps <= 0) {
            return {
              ok: false,
              error: "?대쾲 ???대룞 媛??嫄곕━ ?덉뿉???대룞?????놁뒿?덈떎.",
              details: {
                walkSpeedFt,
                difficultApplied: move.difficult,
              },
            };
          }

          const points = [placeable.center];
          let x = startX;
          let y = startY;
          for (let i = 0; i < xSteps; i += 1) {
            x += vx * gridSizePx;
            points.push({
              x: x + tokenWidthPx / 2,
              y: startY + tokenHeightPx / 2,
            });
          }
          const midX = startX + vx * xSteps * gridSizePx;
          y = startY;
          for (let i = 0; i < ySteps; i += 1) {
            y += vy * gridSizePx;
            points.push({
              x: midX + tokenWidthPx / 2,
              y: y + tokenHeightPx / 2,
            });
          }

          const measured = canvas.grid.measurePath(points);
          const measuredDistanceFt = Number(
            measured?.distance ?? measured?.cost ?? totalSteps * sceneGridDistance
          );
          const costFt = measuredDistanceFt * costMultiplier;

          if (xSteps > 0) {
            await placeable.document.update({ x: midX, y: startY }, { animate: true });
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          if (ySteps > 0) {
            const finalY = startY + vy * ySteps * gridSizePx;
            await placeable.document.update({ x: midX, y: finalY }, { animate: true });
          }

          return {
            ok: true,
            actorName: actor.name,
            sceneName: scene.name,
            stepsMoved: totalSteps,
            xSteps,
            ySteps,
            xDir: vx > 0 ? "E" : "W",
            yDir: vy > 0 ? "S" : "N",
            distanceFt: Number(measuredDistanceFt.toFixed(2)),
            costFt: Number(costFt.toFixed(2)),
            walkSpeedFt,
            remainingFt: Number(Math.max(0, walkSpeedFt - costFt).toFixed(2)),
            clipped: xSteps < requestedSteps || ySteps < requestedSteps,
            difficultApplied: move.difficult,
            difficultMultiplier: costMultiplier,
            note: move.difficult ? `difficult terrain: cost x${costMultiplier}` : "",
          };
        }

        function measureSteps(steps) {
          let x = startX;
          let y = startY;
          const points = [placeable.center];

          for (let i = 0; i < steps; i += 1) {
            x += vx * gridSizePx;
            y += vy * gridSizePx;
            points.push({
              x: x + tokenWidthPx / 2,
              y: y + tokenHeightPx / 2,
            });
          }

          const measured = canvas.grid.measurePath(points);
          const measuredDistanceFt = Number(
            measured?.distance ?? measured?.cost ?? steps * sceneGridDistance
          );
          const costFt = measuredDistanceFt * costMultiplier;
          return {
            steps,
            targetX: x,
            targetY: y,
            measuredDistanceFt,
            costFt,
          };
        }

        let current = measureSteps(requestedSteps);
        while (current.steps > 0 && current.costFt > walkSpeedFt) {
          current = measureSteps(current.steps - 1);
        }

        if (current.steps <= 0) {
          return {
            ok: false,
            error: "?대쾲 ???대룞 媛??嫄곕━ ?덉뿉???대룞?????놁뒿?덈떎.",
            details: {
              walkSpeedFt,
              difficultApplied: move.difficult,
            },
          };
        }

        await placeable.document.update(
          {
            x: current.targetX,
            y: current.targetY,
          },
          { animate: true }
        );

        return {
          ok: true,
          actorName: actor.name,
          sceneName: scene.name,
          stepsMoved: current.steps,
          distanceFt: Number(current.measuredDistanceFt.toFixed(2)),
          costFt: Number(current.costFt.toFixed(2)),
          walkSpeedFt,
          remainingFt: Number(Math.max(0, walkSpeedFt - current.costFt).toFixed(2)),
          clipped: current.steps < requestedSteps,
          difficultApplied: move.difficult,
          difficultMultiplier: costMultiplier,
          note: move.difficult
            ? `?대젮??吏??媛?뺤쑝濡??대룞 鍮꾩슜 x${costMultiplier}瑜??곸슜?덉뒿?덈떎.`
            : "?대젮??吏???먮룞 媛먯????쒗븳?곸엯?덈떎. ?꾩슂?섎㈃ '?대젮??吏?? 議곌굔???④퍡 留먰빐 二쇱꽭??",
        };
      },
      {
        ...this._actorSelector(),
        move: moveIntent,
        difficultTerrainMultiplier,
      }
    );
  }

  async getRecentChat(limit = 8) {
    await this._waitForGameReady();
    return this.page.evaluate(({ limit: rawLimit }) => {
      function toPlainText(html) {
        const div = document.createElement("div");
        div.innerHTML = String(html || "");
        const plain = (div.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        return plain;
      }

      const limit = Math.min(30, Math.max(1, Number(rawLimit) || 8));
      const messages = Array.isArray(game.messages?.contents) ? game.messages.contents : [];

      const recent = messages.slice(-limit).map((message) => {
        const speaker = message.speaker?.alias || message.alias || message.user?.name || "Unknown";
        const content = toPlainText(message.content);
        const ts = Number(message.timestamp);
        return {
          id: message.id,
          speaker,
          content: content || "(?댁슜 ?놁쓬)",
          timestamp: Number.isFinite(ts) && ts > 0 ? ts : null,
          isRoll: Boolean(message.isRoll),
        };
      });

      return {
        ok: true,
        limit,
        count: recent.length,
        messages: recent,
      };
    }, { limit });
  }

  async getSceneContext(maxTokens = 20) {
    await this._waitForGameReady();
    return this.page.evaluate(
      ({ actorId, actorName, maxTokens: rawMaxTokens }) => {
        function sceneTokens(scene) {
          if (!scene) return [];
          if (Array.isArray(scene.tokens?.contents)) return scene.tokens.contents;
          if (Array.isArray(scene.tokens)) return scene.tokens;
          return [];
        }

        function toPlainText(html) {
          const div = document.createElement("div");
          div.innerHTML = String(html || "");
          return (div.textContent || "")
            .replace(/\s+/g, " ")
            .trim();
        }

        function findActor() {
          if (actorId) return game.actors.get(actorId) ?? null;
          if (!actorName) return null;
          const named = game.actors.filter((actor) => actor.name === actorName);
          if (named.length <= 1) return named[0] ?? null;

          const preferredScenes = [];
          const pushUnique = (scene) => {
            if (!scene?.id) return;
            if (!preferredScenes.some((entry) => entry.id === scene.id)) preferredScenes.push(scene);
          };
          pushUnique(canvas?.scene || null);
          pushUnique(game.scenes.current || null);
          pushUnique(game.scenes.active || null);

          for (const scene of preferredScenes) {
            const actorIdsOnScene = new Set(sceneTokens(scene).map((token) => String(token?.actorId || "")));
            const sceneMatch = named.find((candidate) => actorIdsOnScene.has(String(candidate?.id || "")));
            if (sceneMatch) return sceneMatch;
          }
          return named[0] ?? null;
        }

        function findTokenForActor(actor) {
          if (!actor) return { scene: null, token: null };
          const preferredScenes = [];
          const pushUnique = (scene) => {
            if (!scene?.id) return;
            if (!preferredScenes.some((entry) => entry.id === scene.id)) preferredScenes.push(scene);
          };

          pushUnique(canvas?.scene || null);
          pushUnique(game.scenes.current || null);
          pushUnique(game.scenes.active || null);

          for (const scene of preferredScenes) {
            const found = sceneTokens(scene).find((token) => token.actorId === actor.id);
            if (found) return { scene, token: found };
          }
          for (const scene of game.scenes.contents) {
            const found = sceneTokens(scene).find((token) => token.actorId === actor.id);
            if (found) return { scene, token: found };
          }
          return { scene: null, token: null };
        }

        function summarizeInventory(actor) {
          const inventoryTypes = new Set([
            "weapon",
            "equipment",
            "consumable",
            "tool",
            "loot",
            "container",
            "backpack",
          ]);
          const items = Array.isArray(actor?.items?.contents) ? actor.items.contents : [];
          const inventory = items
            .filter((item) => inventoryTypes.has(String(item.type || "").toLowerCase()))
            .map((item) => {
              const quantity = Number(item.system?.quantity ?? item.system?.uses?.value ?? 1) || 1;
              const equippedRaw = item.system?.equipped;
              const equipped = Boolean(
                (typeof equippedRaw === "object" ? equippedRaw?.value : equippedRaw) ||
                  item.system?.attuned ||
                  item.system?.prepared
              );
              return {
                id: item.id,
                name: item.name || item.id,
                type: item.type || "",
                quantity,
                equipped,
              };
            })
            .sort((a, b) => {
              if (a.equipped !== b.equipped) return a.equipped ? -1 : 1;
              return String(a.name).localeCompare(String(b.name), "ko");
            });

          return {
            count: inventory.length,
            equipped: inventory.filter((item) => item.equipped).slice(0, 10),
            items: inventory.slice(0, 24),
          };
        }

        function summarizeSpells(actor) {
          const items = Array.isArray(actor?.items?.contents) ? actor.items.contents : [];
          const spells = items
            .filter((item) => item.type === "spell")
            .map((item) => {
              const level = Number(item.system?.level ?? 0);
              const prepMode = String(item.system?.preparation?.mode || "");
              const prepared = Boolean(item.system?.preparation?.prepared) || prepMode.toLowerCase() === "always";
              const school = String(item.system?.school || item.system?.school?.value || "");
              const uses = Number(item.system?.uses?.value ?? 0);
              const usesMax = Number(item.system?.uses?.max ?? 0);
              const rangeValue = item.system?.range?.value;
              const rangeUnits = item.system?.range?.units;
              const range = [rangeValue !== undefined ? rangeValue : "", rangeUnits || ""].join(" ").trim();
              return {
                id: item.id,
                name: item.name || item.id,
                level: Number.isFinite(level) ? level : 0,
                prepared,
                prepMode,
                school,
                range,
                uses: Number.isFinite(uses) ? uses : 0,
                usesMax: Number.isFinite(usesMax) ? usesMax : 0,
              };
            })
            .sort((a, b) => {
              if (a.prepared !== b.prepared) return a.prepared ? -1 : 1;
              if (a.level !== b.level) return a.level - b.level;
              return String(a.name).localeCompare(String(b.name), "ko");
            });

          const slotsRaw = actor?.system?.spells ?? {};
          const slots = {};
          for (const [key, slot] of Object.entries(slotsRaw)) {
            if (!slot || typeof slot !== "object") continue;
            const value = Number(slot.value ?? 0);
            const max = Number(slot.max ?? 0);
            if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) continue;
            slots[key] = { value, max };
          }

          return {
            count: spells.length,
            preparedCount: spells.filter((spell) => spell.prepared).length,
            spellDc: Number(actor?.system?.attributes?.spelldc ?? 0) || null,
            slots,
            items: spells.slice(0, 28),
          };
        }

        function normalizeStatusKey(value) {
          return String(value || "")
            .toLowerCase()
            .trim()
            .replace(/\s+/g, "")
            .replace(/[^\p{L}\p{N}._-]+/gu, "");
        }

        function combatantsOf(combat) {
          if (!combat) return [];
          if (Array.isArray(combat.combatants?.contents)) return combat.combatants.contents;
          if (Array.isArray(combat.combatants)) return combat.combatants;
          return [];
        }

        function pickCombat(scene) {
          const all = Array.isArray(game.combats?.contents) ? game.combats.contents : [];
          if (!all.length) return null;
          const sceneId = String(scene?.id || canvas?.scene?.id || game.scenes.current?.id || "");
          const open = all.filter((combat) => !combat?.ended);
          const byScene = open.filter((combat) => String(combat?.scene?.id || combat?.sceneId || "") === sceneId);
          return (
            game.combat ||
            byScene.find((combat) => Boolean(combat?.started || combat?.active)) ||
            byScene[0] ||
            open.find((combat) => Boolean(combat?.started || combat?.active)) ||
            open[0] ||
            null
          );
        }

        function findCombatantForToken(tokenDoc, combat) {
          if (!tokenDoc || !combat) return null;
          const tokenId = String(tokenDoc?.id || tokenDoc?.tokenId || "");
          const actorId = String(tokenDoc?.actorId || tokenDoc?.actor?.id || "");
          for (const combatant of combatantsOf(combat)) {
            const combatantTokenId = String(combatant?.tokenId || combatant?.token?.id || "");
            const combatantActorId = String(combatant?.actorId || combatant?.actor?.id || "");
            if (tokenId && combatantTokenId && tokenId === combatantTokenId) return combatant;
            if (actorId && combatantActorId && actorId === combatantActorId) return combatant;
          }
          return null;
        }

        function collectStatusData(tokenDoc, actor) {
          const statusSet = new Set();
          const labels = [];
          const labelSet = new Set();

          const pushStatus = (raw) => {
            const key = normalizeStatusKey(raw);
            if (!key) return;
            statusSet.add(key);
          };

          const pushLabel = (raw) => {
            const label = String(raw || "").trim();
            if (!label) return;
            if (!labelSet.has(label)) {
              labelSet.add(label);
              labels.push(label);
            }
            pushStatus(label);
          };

          const pushIterableStatuses = (iterable) => {
            if (!iterable || typeof iterable[Symbol.iterator] !== "function") return;
            for (const entry of iterable) {
              pushStatus(entry);
            }
          };

          pushIterableStatuses(actor?.statuses);
          pushIterableStatuses(tokenDoc?.statuses);

          const activeEffects = Array.isArray(actor?.effects?.contents)
            ? actor.effects.contents
            : Array.isArray(actor?.effects)
              ? actor.effects
              : [];

          for (const effect of activeEffects) {
            if (!effect || effect.disabled === true) continue;
            pushLabel(effect?.name || effect?.label || "");
            pushIterableStatuses(effect?.statuses);
          }

          const statusKeys = Array.from(statusSet);
          const hasStatus = (re) => statusKeys.some((key) => re.test(key));

          return {
            labels: labels.slice(0, 12),
            statusKeys: statusKeys.slice(0, 20),
            concentration: hasStatus(/concentr|집중/),
            bleeding: hasStatus(/bleed|hemorr|출혈/),
            dead: hasStatus(/dead|defeat|dying|사망|죽음/),
            unconscious: hasStatus(/unconscious|기절|의식없|빈사/),
          };
        }

        function summarizeTokenState(tokenDoc, combat) {
          const actor = tokenDoc?.actor || game.actors.get(tokenDoc?.actorId) || null;
          const hpRaw = actor?.system?.attributes?.hp ?? {};
          const hpValue = Number(hpRaw?.value);
          const hpMax = Number(hpRaw?.max);
          const hpTemp = Number(hpRaw?.temp ?? 0);
          const combatant = findCombatantForToken(tokenDoc, combat);
          const defeated = Boolean(combatant?.defeated || tokenDoc?.combatant?.defeated);
          const statuses = collectStatusData(tokenDoc, actor);
          const hpKnown = Number.isFinite(hpValue);
          const hpZero = hpKnown && hpValue <= 0;
          const isDeadLike = hpZero || defeated || statuses.dead;

          return {
            actorName: String(actor?.name || ""),
            hasPlayerOwner: Boolean(actor?.hasPlayerOwner),
            hp: {
              value: hpKnown ? hpValue : null,
              max: Number.isFinite(hpMax) ? hpMax : null,
              temp: Number.isFinite(hpTemp) ? hpTemp : 0,
            },
            inCombat: Boolean(combatant),
            combatantId: String(combatant?.id || ""),
            defeated,
            isDeadLike,
            conditions: {
              concentrating: Boolean(statuses.concentration),
              bleeding: Boolean(statuses.bleeding),
              dead: Boolean(statuses.dead),
              unconscious: Boolean(statuses.unconscious),
            },
            effects: statuses.labels,
            statusKeys: statuses.statusKeys,
          };
        }

        const scene = canvas?.scene || game.scenes.current || game.scenes.active || null;
        if (!scene) {
          return { ok: false, error: "?쒖꽦 ?ъ쓣 李얠? 紐삵뻽?듬땲??" };
        }

        const actor = findActor();
        const actorInAnyScene = findTokenForActor(actor);
        const sceneTokenDocs = sceneTokens(scene);
        const combat = pickCombat(scene);
        const gridDistance = Number(scene.grid?.distance ?? 5) || 5;
        const gridUnits = String(scene.grid?.units || "ft");
        const gridSizePx = Number(canvas?.grid?.size ?? scene.grid?.size ?? 100) || 100;
        const maxTokens = Math.min(60, Math.max(5, Number(rawMaxTokens) || 20));

        function measureGridDistanceFt(centerA, centerB) {
          try {
            const measured = canvas?.grid?.measurePath?.([centerA, centerB]);
            const distanceFt = Number(measured?.distance ?? measured?.cost);
            if (Number.isFinite(distanceFt)) return distanceFt;
          } catch {
            // ignore measure failures
          }

          const ax = Number(centerA?.x || 0);
          const ay = Number(centerA?.y || 0);
          const bx = Number(centerB?.x || 0);
          const by = Number(centerB?.y || 0);
          const px = Math.hypot(bx - ax, by - ay);
          return (px / gridSizePx) * gridDistance;
        }

        function deltaCellsBetweenCenters(fromCenter, toCenter) {
          return {
            dxCells: Math.round((Number(toCenter?.x || 0) - Number(fromCenter?.x || 0)) / gridSizePx),
            dyCells: Math.round((Number(toCenter?.y || 0) - Number(fromCenter?.y || 0)) / gridSizePx),
          };
        }

        const actorToken =
          actor && sceneTokenDocs.find((token) => token.actorId === actor.id)
            ? sceneTokenDocs.find((token) => token.actorId === actor.id)
            : null;

        const actorCenter = actorToken
          ? {
              x:
                Number(actorToken.x || 0) +
                (Number(actorToken.width || 1) * gridSizePx) / 2,
              y:
                Number(actorToken.y || 0) +
                (Number(actorToken.height || 1) * gridSizePx) / 2,
            }
          : null;

        const tokens = sceneTokenDocs.map((token) => {
          const tokenState = summarizeTokenState(token, combat);
          const center = {
            x: Number(token.x || 0) + (Number(token.width || 1) * gridSizePx) / 2,
            y: Number(token.y || 0) + (Number(token.height || 1) * gridSizePx) / 2,
          };

          let distanceFt = null;
          let orthDistanceFt = null;
          let dxCells = null;
          let dyCells = null;
          if (actorCenter && actorToken && token.id !== actorToken.id) {
            const delta = deltaCellsBetweenCenters(actorCenter, center);
            dxCells = delta.dxCells;
            dyCells = delta.dyCells;
            distanceFt = Number(measureGridDistanceFt(actorCenter, center).toFixed(1));
            orthDistanceFt = Number(((Math.abs(dxCells) + Math.abs(dyCells)) * gridDistance).toFixed(1));
          }

          return {
            id: token.id,
            name: token.name || token.id,
            actorId: token.actorId || "",
            actorName: tokenState.actorName,
            hasPlayerOwner: tokenState.hasPlayerOwner,
            x: Number(token.x || 0),
            y: Number(token.y || 0),
            width: Number(token.width || 1),
            height: Number(token.height || 1),
            hidden: Boolean(token.hidden),
            disposition: Number(token.disposition ?? 0),
            hp: tokenState.hp,
            inCombat: tokenState.inCombat,
            combatantId: tokenState.combatantId,
            defeated: tokenState.defeated,
            isDeadLike: tokenState.isDeadLike,
            conditions: tokenState.conditions,
            effects: tokenState.effects,
            statusKeys: tokenState.statusKeys,
            distanceFt,
            orthDistanceFt,
            dxCells,
            dyCells,
          };
        });

        if (actorToken) {
          tokens.sort((a, b) => {
            if (a.id === actorToken.id) return -1;
            if (b.id === actorToken.id) return 1;
            const da = Number.isFinite(a.distanceFt) ? a.distanceFt : Number.POSITIVE_INFINITY;
            const db = Number.isFinite(b.distanceFt) ? b.distanceFt : Number.POSITIVE_INFINITY;
            if (da !== db) return da - db;
            return String(a.name).localeCompare(String(b.name), "ko");
          });
        } else {
          // If actor token is not on the current scene, prioritize actor-backed tokens first
          // so the LLM still sees likely PCs/NPCs before decorative props.
          tokens.sort((a, b) => {
            if (a.hidden !== b.hidden) return a.hidden ? 1 : -1;
            if (a.hasPlayerOwner !== b.hasPlayerOwner) return a.hasPlayerOwner ? -1 : 1;
            const ad = Math.abs(Number(a.disposition ?? 0));
            const bd = Math.abs(Number(b.disposition ?? 0));
            if (ad !== bd) return bd - ad;
            const aActor = a.actorId ? 1 : 0;
            const bActor = b.actorId ? 1 : 0;
            if (aActor !== bActor) return bActor - aActor;
            return String(a.name).localeCompare(String(b.name), "ko");
          });
        }

        const backgroundSrc =
          scene.background?.src ||
          scene.background?.texture?.src ||
          scene.img ||
          "";

        const description = toPlainText(scene.description || scene.navName || "");
        const inventory = actor ? summarizeInventory(actor) : null;
        const spells = actor ? summarizeSpells(actor) : null;
        const movement = actor?.system?.attributes?.movement ?? {};
        const walkSpeedFt = actor
          ? Number(movement.walk ?? movement.land ?? movement.fly ?? movement.swim ?? movement.burrow ?? 30) || 30
          : null;
        const currency =
          actor?.system?.currency && typeof actor.system.currency === "object"
            ? Object.fromEntries(
                Object.entries(actor.system.currency)
                  .map(([key, value]) => [key, Number(value ?? 0) || 0])
                  .filter(([, value]) => Number.isFinite(value))
              )
            : null;
        const tokenById = new Map(tokens.map((token) => [String(token?.id || ""), token]));
        const targets = Array.from(game.user?.targets || [])
          .map((target) => {
            const document = target?.document || target;
            const targetScene = document?.parent || null;
            const cached = tokenById.get(String(document?.id || "")) || null;
            const freshState = cached
              ? null
              : summarizeTokenState(document, targetScene?.id === scene?.id ? combat : pickCombat(targetScene));
            const center = target?.center || {
              x:
                Number(document?.x || 0) +
                (Number(document?.width || 1) * gridSizePx) / 2,
              y:
                Number(document?.y || 0) +
                (Number(document?.height || 1) * gridSizePx) / 2,
            };

            let distanceFt = null;
            let orthDistanceFt = null;
            let dxCells = null;
            let dyCells = null;
            if (actorCenter && targetScene && targetScene.id === scene.id) {
              const delta = deltaCellsBetweenCenters(actorCenter, center);
              dxCells = delta.dxCells;
              dyCells = delta.dyCells;
              distanceFt = Number(measureGridDistanceFt(actorCenter, center).toFixed(1));
              orthDistanceFt = Number(((Math.abs(dxCells) + Math.abs(dyCells)) * gridDistance).toFixed(1));
            }

            return {
              id: String(document?.id || ""),
              name: String(document?.name || document?.id || ""),
              sceneId: String(targetScene?.id || ""),
              sceneName: String(targetScene?.name || ""),
              x: Number(document?.x || 0),
              y: Number(document?.y || 0),
              disposition: Number(document?.disposition ?? cached?.disposition ?? 0),
              hp: cached?.hp || freshState?.hp || { value: null, max: null, temp: 0 },
              inCombat: Boolean(cached?.inCombat ?? freshState?.inCombat),
              combatantId: String(cached?.combatantId || freshState?.combatantId || ""),
              defeated: Boolean(cached?.defeated ?? freshState?.defeated),
              isDeadLike: Boolean(cached?.isDeadLike ?? freshState?.isDeadLike),
              conditions: cached?.conditions || freshState?.conditions || {},
              effects: cached?.effects || freshState?.effects || [],
              statusKeys: cached?.statusKeys || freshState?.statusKeys || [],
              distanceFt,
              orthDistanceFt,
              dxCells,
              dyCells,
            };
          })
          .filter((target) => Boolean(target.id));

        return {
          ok: true,
          scene: {
            id: scene.id,
            name: scene.name,
            width: Number(scene.width || 0),
            height: Number(scene.height || 0),
            gridDistance,
            gridUnits,
            gridType: Number(scene.grid?.type ?? 0),
            backgroundSrc,
            description: description.slice(0, 600),
            combat: combat
              ? {
                  id: String(combat?.id || ""),
                  sceneId: String(combat?.scene?.id || combat?.sceneId || ""),
                  round: Number.isFinite(Number(combat?.round)) ? Number(combat.round) : 0,
                  turn: Number.isFinite(Number(combat?.turn)) ? Number(combat.turn) : -1,
                  started: Boolean(combat?.started),
                  active: Boolean(combat?.active),
                  ended: Boolean(combat?.ended),
                }
              : null,
          },
          actor: actor
            ? {
                id: actor.id,
                name: actor.name,
              }
            : null,
          actorStats: actor
            ? {
                walkSpeedFt,
              }
            : null,
          inventory,
          spells,
          currency,
          actorToken: actorToken
            ? {
                id: actorToken.id,
                name: actorToken.name || actorToken.id,
                x: Number(actorToken.x || 0),
                y: Number(actorToken.y || 0),
              }
            : null,
          actorTokenInOtherScene:
            actorInAnyScene.token && (!actorToken || actorInAnyScene.scene?.id !== scene.id)
              ? {
                  sceneId: actorInAnyScene.scene?.id || "",
                  sceneName: actorInAnyScene.scene?.name || "",
                  tokenId: actorInAnyScene.token.id,
                  tokenName: actorInAnyScene.token.name || actorInAnyScene.token.id,
                }
              : null,
          counts: {
            total: tokens.length,
            hidden: tokens.filter((token) => token.hidden).length,
          },
          targets,
          tokens: tokens.slice(0, maxTokens),
        };
      },
      { ...this._actorSelector(), maxTokens }
    );
  }

  async listSceneTokens() {
    await this._waitForGameReady();
    return this.page.evaluate(() => {
      function sceneTokens(scene) {
        if (!scene) return [];
        if (Array.isArray(scene.tokens?.contents)) return scene.tokens.contents;
        if (Array.isArray(scene.tokens)) return scene.tokens;
        return [];
      }

      const scene = canvas?.scene || game.scenes.current || game.scenes.active || null;
      if (!scene) {
        return { ok: false, error: "?쒖꽦 ?ъ쓣 李얠? 紐삵뻽?듬땲??" };
      }

      const tokens = sceneTokens(scene).map((token) => {
        const actor = token.actor || game.actors.get(token.actorId);
        return {
          id: token.id,
          name: token.name || token.id,
          actorId: token.actorId || "",
          actorName: actor?.name || "",
          x: Number(token.x || 0),
          y: Number(token.y || 0),
          hidden: Boolean(token.hidden),
        };
      });

      return {
        ok: true,
        scene: {
          id: scene.id,
          name: scene.name,
        },
        count: tokens.length,
        tokens,
      };
    });
  }

  async getActorCombatState() {
    await this._waitForGameReady();
    return this.page.evaluate(({ actorId, actorName }) => {
      function sceneTokens(scene) {
        if (!scene) return [];
        if (Array.isArray(scene.tokens?.contents)) return scene.tokens.contents;
        if (Array.isArray(scene.tokens)) return scene.tokens;
        return [];
      }

      function normalize(value) {
        return String(value || "")
          .toLowerCase()
          .trim()
          .replace(/\s+/g, "")
          .replace(/[^\p{L}\p{N}]+/gu, "");
      }

      function findActor() {
        if (actorId) return game.actors.get(actorId) ?? null;
        if (!actorName) return null;
        const named = game.actors.filter((actor) => actor.name === actorName);
        if (named.length <= 1) return named[0] ?? null;

        const preferredScenes = [];
        const pushUnique = (scene) => {
          if (!scene?.id) return;
          if (!preferredScenes.some((entry) => entry.id === scene.id)) preferredScenes.push(scene);
        };
        pushUnique(canvas?.scene || null);
        pushUnique(game.scenes.current || null);
        pushUnique(game.scenes.active || null);

        for (const scene of preferredScenes) {
          const actorIdsOnScene = new Set(sceneTokens(scene).map((token) => String(token?.actorId || "")));
          const sceneMatch = named.find((candidate) => actorIdsOnScene.has(String(candidate?.id || "")));
          if (sceneMatch) return sceneMatch;
        }
        return named[0] ?? null;
      }

      function findTokenForActor(actor) {
        if (!actor) return { scene: null, token: null };
        const preferredScenes = [];
        const pushUnique = (scene) => {
          if (!scene?.id) return;
          if (!preferredScenes.some((entry) => entry.id === scene.id)) preferredScenes.push(scene);
        };

        pushUnique(canvas?.scene || null);
        pushUnique(game.scenes.current || null);
        pushUnique(game.scenes.active || null);

        for (const scene of preferredScenes) {
          const found = sceneTokens(scene).find((token) => token.actorId === actor.id);
          if (found) return { scene, token: found };
        }
        for (const scene of game.scenes.contents) {
          const found = sceneTokens(scene).find((token) => token.actorId === actor.id);
          if (found) return { scene, token: found };
        }
        return { scene: null, token: null };
      }

      function tokenCenter(token, scene) {
        const gridSizePx = Number(scene?.grid?.size ?? canvas?.grid?.size ?? 100) || 100;
        return {
          x: Number(token?.x || 0) + (Number(token?.width || 1) * gridSizePx) / 2,
          y: Number(token?.y || 0) + (Number(token?.height || 1) * gridSizePx) / 2,
        };
      }

      function distanceInfo(fromToken, toToken, scene) {
        if (!fromToken || !toToken || !scene) return { distanceFt: null, orthDistanceFt: null };
        const gridSizePx = Number(scene?.grid?.size ?? canvas?.grid?.size ?? 100) || 100;
        const gridDistance = Number(scene?.grid?.distance ?? canvas?.scene?.grid?.distance ?? 5) || 5;
        const fromCenter = tokenCenter(fromToken, scene);
        const toCenter = tokenCenter(toToken, scene);
        const dxPx = Number(toCenter.x) - Number(fromCenter.x);
        const dyPx = Number(toCenter.y) - Number(fromCenter.y);
        const dxCells = Math.round(dxPx / gridSizePx);
        const dyCells = Math.round(dyPx / gridSizePx);
        const euclidCells = Math.hypot(dxPx, dyPx) / gridSizePx;
        const orthCells = Math.abs(dxCells) + Math.abs(dyCells);
        return {
          distanceFt: Number.isFinite(euclidCells) ? Number((euclidCells * gridDistance).toFixed(2)) : null,
          orthDistanceFt: Number.isFinite(orthCells) ? Number((orthCells * gridDistance).toFixed(2)) : null,
        };
      }

      function pickCombat(scene) {
        const all = Array.isArray(game.combats?.contents) ? game.combats.contents : [];
        if (!all.length) return null;
        const sceneId = String(scene?.id || canvas?.scene?.id || game.scenes.current?.id || "");
        const open = all.filter((combat) => !combat?.ended);
        const byScene = open.filter((combat) => String(combat?.scene?.id || combat?.sceneId || "") === sceneId);
        return (
          game.combat ||
          byScene.find((combat) => Boolean(combat?.started || combat?.active)) ||
          byScene[0] ||
          open.find((combat) => Boolean(combat?.started || combat?.active)) ||
          open[0] ||
          null
        );
      }

      function summarizeCombatant(combatant, combat) {
        if (!combatant) return null;
        const tokenId = String(combatant?.tokenId || combatant?.token?.id || "");
        const tokenDoc = tokenId ? sceneTokens(combat?.scene || null).find((token) => String(token?.id || "") === tokenId) : null;
        return {
          id: String(combatant?.id || ""),
          tokenId,
          actorId: String(combatant?.actorId || combatant?.actor?.id || ""),
          name: String(combatant?.name || tokenDoc?.name || combatant?.actor?.name || combatant?.id || ""),
          initiative: Number.isFinite(Number(combatant?.initiative)) ? Number(combatant.initiative) : null,
          defeated: Boolean(combatant?.defeated),
          hidden: Boolean(combatant?.hidden),
          active: Boolean(combatant?.isActive),
        };
      }

      function combatTurnOrder(combat) {
        if (!combat) return [];
        if (Array.isArray(combat.turns)) return combat.turns;
        if (Array.isArray(combat.combatants?.contents)) return combat.combatants.contents;
        if (Array.isArray(combat.combatants)) return combat.combatants;
        return [];
      }

      function currentCombatantOf(combat, turnOrder = []) {
        if (!combat) return null;
        // Prefer Foundry's active combatant pointer; some tables/plugins desync turn index from collection order.
        if (combat.combatant) return combat.combatant;

        const turn = Number(combat.turn);
        if (Number.isInteger(turn) && turn >= 0 && turn < turnOrder.length) {
          return turnOrder[turn] || null;
        }
        return null;
      }

      function normalizeStatusKey(value) {
        return String(value || "")
          .toLowerCase()
          .trim()
          .replace(/\s+/g, "")
          .replace(/[^\p{L}\p{N}._-]+/gu, "");
      }

      function findCombatantForToken(tokenDoc, combat, combatants = []) {
        if (!tokenDoc || !combat) return null;
        const tokenId = String(tokenDoc?.id || tokenDoc?.tokenId || "");
        const actorId = String(tokenDoc?.actorId || tokenDoc?.actor?.id || "");
        for (const combatant of combatants) {
          const combatantTokenId = String(combatant?.tokenId || combatant?.token?.id || "");
          const combatantActorId = String(combatant?.actorId || combatant?.actor?.id || "");
          if (tokenId && combatantTokenId && tokenId === combatantTokenId) return combatant;
          if (actorId && combatantActorId && actorId === combatantActorId) return combatant;
        }
        return null;
      }

      function summarizeTokenState(tokenDoc, combatant) {
        const actor = tokenDoc?.actor || game.actors.get(tokenDoc?.actorId) || null;
        const hpRaw = actor?.system?.attributes?.hp ?? {};
        const hpValue = Number(hpRaw?.value);
        const hpMax = Number(hpRaw?.max);
        const hpTemp = Number(hpRaw?.temp ?? 0);
        const defeated = Boolean(combatant?.defeated || tokenDoc?.combatant?.defeated);

        const statusSet = new Set();
        const labels = [];
        const labelSet = new Set();
        const pushStatus = (raw) => {
          const key = normalizeStatusKey(raw);
          if (!key) return;
          statusSet.add(key);
        };
        const pushLabel = (raw) => {
          const label = String(raw || "").trim();
          if (!label) return;
          if (!labelSet.has(label)) {
            labelSet.add(label);
            labels.push(label);
          }
          pushStatus(label);
        };
        const pushIterable = (iterable) => {
          if (!iterable || typeof iterable[Symbol.iterator] !== "function") return;
          for (const entry of iterable) pushStatus(entry);
        };

        pushIterable(actor?.statuses);
        pushIterable(tokenDoc?.statuses);
        const activeEffects = Array.isArray(actor?.effects?.contents)
          ? actor.effects.contents
          : Array.isArray(actor?.effects)
            ? actor.effects
            : [];
        for (const effect of activeEffects) {
          if (!effect || effect.disabled === true) continue;
          pushLabel(effect?.name || effect?.label || "");
          pushIterable(effect?.statuses);
        }

        const statusKeys = Array.from(statusSet);
        const hasStatus = (re) => statusKeys.some((key) => re.test(key));
        const deadByStatus = hasStatus(/dead|defeat|dying|사망|죽음/);
        const hpKnown = Number.isFinite(hpValue);
        const hpZero = hpKnown && hpValue <= 0;

        return {
          hp: {
            value: hpKnown ? hpValue : null,
            max: Number.isFinite(hpMax) ? hpMax : null,
            temp: Number.isFinite(hpTemp) ? hpTemp : 0,
          },
          defeated,
          isDeadLike: hpZero || defeated || deadByStatus,
          inCombat: Boolean(combatant),
          combatantId: String(combatant?.id || ""),
          conditions: {
            concentrating: hasStatus(/concentr|집중/),
            bleeding: hasStatus(/bleed|hemorr|출혈/),
            dead: deadByStatus,
            unconscious: hasStatus(/unconscious|기절|의식없|빈사/),
          },
          effects: labels.slice(0, 12),
          statusKeys: statusKeys.slice(0, 20),
          actorName: String(actor?.name || game.actors.get(tokenDoc?.actorId)?.name || ""),
        };
      }

      const actor = findActor();
      if (!actor) {
        return { ok: false, error: "Actor not found for combat state." };
      }

      const { scene, token } = findTokenForActor(actor);
      const combat = pickCombat(scene);
      if (!combat) {
        return {
          ok: true,
          inCombat: false,
          actor: { id: actor.id, name: actor.name },
          token: token
            ? {
                id: token.id,
                name: token.name || token.id,
                sceneId: scene?.id || "",
                sceneName: scene?.name || "",
              }
            : null,
        };
      }

      const combatants = Array.isArray(combat.combatants?.contents)
        ? combat.combatants.contents
        : Array.isArray(combat.combatants)
          ? combat.combatants
          : [];
      const turnOrder = combatTurnOrder(combat);

      const actorIdText = String(actor.id || "");
      const actorTokenId = String(token?.id || "");
      const actorCombatants = combatants.filter((combatant) => {
        const combatantActorId = String(combatant?.actorId || combatant?.actor?.id || "");
        const combatantTokenId = String(combatant?.tokenId || combatant?.token?.id || "");
        if (combatantActorId && combatantActorId === actorIdText) return true;
        if (actorTokenId && combatantTokenId && combatantTokenId === actorTokenId) return true;
        return false;
      });

      const currentCombatant = currentCombatantOf(combat, turnOrder);

      const currentCombatantId = String(currentCombatant?.id || "");
      const isActorTurn = actorCombatants.some((combatant) => String(combatant?.id || "") === currentCombatantId);
      const round = Number.isFinite(Number(combat.round)) ? Number(combat.round) : 0;
      const turn = Number.isFinite(Number(combat.turn)) ? Number(combat.turn) : -1;
      const combatId = String(combat.id || "");
      const turnKey = combatId && currentCombatantId ? `${combatId}:${round}:${turn}:${currentCombatantId}` : "";
      const combatActive = Boolean(combat && !combat?.ended && (combat?.started || combat?.active));

      const actorScene = scene || combat.scene || canvas?.scene || game.scenes.current || null;
      const actorToken = token || sceneTokens(actorScene).find((doc) => String(doc?.actorId || "") === actorIdText) || null;
      const actorDisposition = Number(actorToken?.disposition ?? 0);

      const nearbyHostiles = actorScene
        ? sceneTokens(actorScene)
            .filter((tokenDoc) => {
              if (!tokenDoc) return false;
              if (String(tokenDoc.id || "") === String(actorToken?.id || "")) return false;
              if (Boolean(tokenDoc.hidden)) return false;
              const combatant = findCombatantForToken(tokenDoc, combat, combatants);
              const tokenState = summarizeTokenState(tokenDoc, combatant);
              if (tokenState.isDeadLike) return false;
              if (combatActive && actorCombatants.length > 0 && !tokenState.inCombat) return false;
              if (!actorToken) return true;
              const tokenDisposition = Number(tokenDoc?.disposition ?? 0);
              if (actorDisposition === 0 || tokenDisposition === 0) return true;
              return tokenDisposition !== actorDisposition;
            })
            .map((tokenDoc) => {
              const info = distanceInfo(actorToken, tokenDoc, actorScene);
              const combatant = findCombatantForToken(tokenDoc, combat, combatants);
              const tokenState = summarizeTokenState(tokenDoc, combatant);
              return {
                id: String(tokenDoc.id || ""),
                name: String(tokenDoc.name || tokenDoc.id || ""),
                actorId: String(tokenDoc.actorId || ""),
                actorName: tokenState.actorName,
                disposition: Number(tokenDoc?.disposition ?? 0),
                hp: tokenState.hp,
                inCombat: tokenState.inCombat,
                combatantId: tokenState.combatantId,
                defeated: tokenState.defeated,
                isDeadLike: tokenState.isDeadLike,
                conditions: tokenState.conditions,
                effects: tokenState.effects,
                statusKeys: tokenState.statusKeys,
                distanceFt: info.distanceFt,
                orthDistanceFt: info.orthDistanceFt,
              };
            })
            .sort((a, b) => {
              const ad = Number.isFinite(Number(a.distanceFt)) ? Number(a.distanceFt) : Number.POSITIVE_INFINITY;
              const bd = Number.isFinite(Number(b.distanceFt)) ? Number(b.distanceFt) : Number.POSITIVE_INFINITY;
              if (ad !== bd) return ad - bd;
              return String(a.name || "").localeCompare(String(b.name || ""), "ko");
            })
            .slice(0, 10)
        : [];

      return {
        ok: true,
        inCombat: true,
        actorInCombat: actorCombatants.length > 0,
        isActorTurn,
        turnKey,
        round,
        turn,
        combat: {
          id: combatId,
          sceneId: String(combat?.scene?.id || combat?.sceneId || ""),
          sceneName: String(combat?.scene?.name || ""),
          started: Boolean(combat?.started),
          active: Boolean(combat?.active),
          round,
          turn,
        },
        actor: {
          id: actor.id,
          name: actor.name,
        },
        token: actorToken
          ? {
              id: String(actorToken.id || ""),
              name: String(actorToken.name || actorToken.id || ""),
              sceneId: String(actorScene?.id || ""),
              sceneName: String(actorScene?.name || ""),
              disposition: Number(actorToken?.disposition ?? 0),
            }
          : null,
        actorCombatants: actorCombatants.map((combatant) => summarizeCombatant(combatant, combat)),
        currentCombatant: summarizeCombatant(currentCombatant, combat),
        nearbyHostiles,
      };
    }, this._actorSelector());
  }

  async endActorCombatTurn(expectedTurnKey = "") {
    await this._waitForGameReady();
    return this.page.evaluate(
      async ({ actorId, actorName, expectedTurnKey: rawExpectedTurnKey }) => {
        function sceneTokens(scene) {
          if (!scene) return [];
          if (Array.isArray(scene.tokens?.contents)) return scene.tokens.contents;
          if (Array.isArray(scene.tokens)) return scene.tokens;
          return [];
        }

        function findActor() {
          if (actorId) return game.actors.get(actorId) ?? null;
          if (!actorName) return null;
          const named = game.actors.filter((actor) => actor.name === actorName);
          if (named.length <= 1) return named[0] ?? null;

          const preferredScenes = [];
          const pushUnique = (scene) => {
            if (!scene?.id) return;
            if (!preferredScenes.some((entry) => entry.id === scene.id)) preferredScenes.push(scene);
          };
          pushUnique(canvas?.scene || null);
          pushUnique(game.scenes.current || null);
          pushUnique(game.scenes.active || null);

          for (const scene of preferredScenes) {
            const actorIdsOnScene = new Set(sceneTokens(scene).map((token) => String(token?.actorId || "")));
            const sceneMatch = named.find((candidate) => actorIdsOnScene.has(String(candidate?.id || "")));
            if (sceneMatch) return sceneMatch;
          }
          return named[0] ?? null;
        }

        function findTokenForActor(actor) {
          if (!actor) return { scene: null, token: null };
          const preferredScenes = [];
          const pushUnique = (scene) => {
            if (!scene?.id) return;
            if (!preferredScenes.some((entry) => entry.id === scene.id)) preferredScenes.push(scene);
          };

          pushUnique(canvas?.scene || null);
          pushUnique(game.scenes.current || null);
          pushUnique(game.scenes.active || null);

          for (const scene of preferredScenes) {
            const found = sceneTokens(scene).find((token) => token.actorId === actor.id);
            if (found) return { scene, token: found };
          }
          for (const scene of game.scenes.contents) {
            const found = sceneTokens(scene).find((token) => token.actorId === actor.id);
            if (found) return { scene, token: found };
          }
          return { scene: null, token: null };
        }

        function pickCombat(scene) {
          const all = Array.isArray(game.combats?.contents) ? game.combats.contents : [];
          if (!all.length) return null;
          const sceneId = String(scene?.id || canvas?.scene?.id || game.scenes.current?.id || "");
          const open = all.filter((combat) => !combat?.ended);
          const byScene = open.filter((combat) => String(combat?.scene?.id || combat?.sceneId || "") === sceneId);
          return (
            game.combat ||
            byScene.find((combat) => Boolean(combat?.started || combat?.active)) ||
            byScene[0] ||
            open.find((combat) => Boolean(combat?.started || combat?.active)) ||
            open[0] ||
            null
          );
        }

        function combatTurnOrder(combat) {
          if (!combat) return [];
          if (Array.isArray(combat.turns)) return combat.turns;
          if (Array.isArray(combat.combatants?.contents)) return combat.combatants.contents;
          if (Array.isArray(combat.combatants)) return combat.combatants;
          return [];
        }

        function currentCombatantOf(combat, turnOrder = []) {
          if (!combat) return null;
          // Prefer Foundry's active combatant pointer; collection order can differ from initiative turn order.
          if (combat.combatant) return combat.combatant;
          const turn = Number(combat.turn);
          if (Number.isInteger(turn) && turn >= 0 && turn < turnOrder.length) {
            return turnOrder[turn] || null;
          }
          return null;
        }

        const actor = findActor();
        if (!actor) {
          return { ok: false, error: "Actor not found for combat turn end." };
        }

        const { scene, token } = findTokenForActor(actor);
        const combat = pickCombat(scene);
        if (!combat) {
          return { ok: false, error: "No active combat found." };
        }

        const combatants = Array.isArray(combat.combatants?.contents)
          ? combat.combatants.contents
          : Array.isArray(combat.combatants)
            ? combat.combatants
            : [];
        const turnOrderBefore = combatTurnOrder(combat);

        const roundBefore = Number.isFinite(Number(combat.round)) ? Number(combat.round) : 0;
        const turnBefore = Number.isFinite(Number(combat.turn)) ? Number(combat.turn) : -1;
        const currentCombatant = currentCombatantOf(combat, turnOrderBefore);
        const currentCombatantId = String(currentCombatant?.id || "");
        const turnKeyBefore = `${String(combat.id || "")}:${roundBefore}:${turnBefore}:${currentCombatantId}`;

        const expectedTurnKey = String(rawExpectedTurnKey || "").trim();
        if (expectedTurnKey && turnKeyBefore !== expectedTurnKey) {
          return {
            ok: true,
            skipped: true,
            reason: "turn-already-advanced",
            expectedTurnKey,
            turnKeyBefore,
          };
        }

        const actorIdText = String(actor.id || "");
        const actorTokenId = String(token?.id || "");
        const ownsCurrentTurn =
          String(currentCombatant?.actorId || currentCombatant?.actor?.id || "") === actorIdText ||
          (actorTokenId && String(currentCombatant?.tokenId || currentCombatant?.token?.id || "") === actorTokenId);

        if (!ownsCurrentTurn) {
          return {
            ok: true,
            skipped: true,
            reason: "not-actor-turn",
            turnKeyBefore,
          };
        }

        if (typeof combat.nextTurn !== "function") {
          return { ok: false, error: "combat.nextTurn is unavailable." };
        }

        try {
          await combat.nextTurn();
        } catch (error) {
          return { ok: false, error: error?.message || String(error), turnKeyBefore };
        }

        const roundAfter = Number.isFinite(Number(combat.round)) ? Number(combat.round) : roundBefore;
        const turnAfter = Number.isFinite(Number(combat.turn)) ? Number(combat.turn) : turnBefore;
        const turnOrderAfter = combatTurnOrder(combat);
        const nextCombatant = currentCombatantOf(combat, turnOrderAfter);
        const nextCombatantId = String(nextCombatant?.id || "");
        const turnKeyAfter = `${String(combat.id || "")}:${roundAfter}:${turnAfter}:${nextCombatantId}`;

        return {
          ok: true,
          skipped: false,
          combatId: String(combat.id || ""),
          roundBefore,
          turnBefore,
          roundAfter,
          turnAfter,
          turnKeyBefore,
          turnKeyAfter,
        };
      },
      { ...this._actorSelector(), expectedTurnKey: String(expectedTurnKey || "") }
    );
  }
  async setActorTarget(targetTokenRef) {
    await this._waitForGameReady();
    return this.page.evaluate(
      async ({ actorId, actorName, targetTokenRef: rawTargetTokenRef }) => {
        function sceneTokens(scene) {
          if (!scene) return [];
          if (Array.isArray(scene.tokens?.contents)) return scene.tokens.contents;
          if (Array.isArray(scene.tokens)) return scene.tokens;
          return [];
        }

        function normalize(value) {
          return String(value || "")
            .toLowerCase()
            .trim()
            .replace(/\s+/g, "")
            .replace(/[^\p{L}\p{N}]+/gu, "");
        }

        function findActor() {
          if (actorId) return game.actors.get(actorId) ?? null;
          if (!actorName) return null;
          const named = game.actors.filter((actor) => actor.name === actorName);
          if (named.length <= 1) return named[0] ?? null;

          const preferredScenes = [];
          const pushUnique = (scene) => {
            if (!scene?.id) return;
            if (!preferredScenes.some((entry) => entry.id === scene.id)) preferredScenes.push(scene);
          };
          pushUnique(canvas?.scene || null);
          pushUnique(game.scenes.current || null);
          pushUnique(game.scenes.active || null);

          for (const scene of preferredScenes) {
            const actorIdsOnScene = new Set(sceneTokens(scene).map((token) => String(token?.actorId || "")));
            const sceneMatch = named.find((candidate) => actorIdsOnScene.has(String(candidate?.id || "")));
            if (sceneMatch) return sceneMatch;
          }
          return named[0] ?? null;
        }

        function findTokenForActor(actor) {
          if (!actor) return { scene: null, token: null };
          const preferredScenes = [];
          const pushUnique = (scene) => {
            if (!scene?.id) return;
            if (!preferredScenes.some((entry) => entry.id === scene.id)) preferredScenes.push(scene);
          };

          pushUnique(canvas?.scene || null);
          pushUnique(game.scenes.current || null);
          pushUnique(game.scenes.active || null);

          for (const scene of preferredScenes) {
            const found = sceneTokens(scene).find((token) => token.actorId === actor.id);
            if (found) return { scene, token: found };
          }
          for (const scene of game.scenes.contents) {
            const found = sceneTokens(scene).find((token) => token.actorId === actor.id);
            if (found) return { scene, token: found };
          }
          return { scene: null, token: null };
        }

        function tokenCenter(token, scene) {
          const gridSizePx = Number(scene?.grid?.size ?? canvas?.grid?.size ?? 100) || 100;
          return {
            x: Number(token?.x || 0) + (Number(token?.width || 1) * gridSizePx) / 2,
            y: Number(token?.y || 0) + (Number(token?.height || 1) * gridSizePx) / 2,
          };
        }

        function distanceFtBetweenTokens(a, b, scene) {
          const gridSizePx = Number(scene?.grid?.size ?? canvas?.grid?.size ?? 100) || 100;
          const gridDistance = Number(scene?.grid?.distance ?? canvas?.scene?.grid?.distance ?? 5) || 5;
          const ac = tokenCenter(a, scene);
          const bc = tokenCenter(b, scene);
          try {
            const measured = canvas?.grid?.measurePath?.([ac, bc]);
            const distanceFt = Number(measured?.distance ?? measured?.cost);
            if (Number.isFinite(distanceFt)) return distanceFt;
          } catch {
            // ignore measure failures
          }

          const px = Math.hypot(bc.x - ac.x, bc.y - ac.y);
          return (px / gridSizePx) * gridDistance;
        }

        function distanceFtBetweenCenters(centerA, centerB, gridSizePx, gridDistance) {
          const ax = Number(centerA?.x || 0);
          const ay = Number(centerA?.y || 0);
          const bx = Number(centerB?.x || 0);
          const by = Number(centerB?.y || 0);
          try {
            const measured = canvas?.grid?.measurePath?.([{ x: ax, y: ay }, { x: bx, y: by }]);
            const distanceFt = Number(measured?.distance ?? measured?.cost);
            if (Number.isFinite(distanceFt)) return distanceFt;
          } catch {
            // ignore measure failures
          }

          const px = Math.hypot(bx - ax, by - ay);
          return (px / gridSizePx) * gridDistance;
        }

        function pickNearest(matches, originToken, originScene) {
          if (!originToken || !originScene || !Array.isArray(matches) || matches.length === 0) return null;
          const scoped = matches.filter((entry) => entry.scene?.id === originScene.id);
          if (scoped.length === 0) return null;
          const origin = tokenCenter(originToken, originScene);
          const sorted = [...scoped].sort((a, b) => {
            const da = Math.hypot(
              tokenCenter(a.token, a.scene).x - origin.x,
              tokenCenter(a.token, a.scene).y - origin.y
            );
            const db = Math.hypot(
              tokenCenter(b.token, b.scene).x - origin.x,
              tokenCenter(b.token, b.scene).y - origin.y
            );
            return da - db;
          });
          return sorted[0] || null;
        }

        function findTokenByRef(rawRef, options = {}) {
          const raw = String(rawRef || "").trim();
          const key = normalize(raw);
          const matches = [];

          for (const scene of game.scenes.contents) {
            for (const token of sceneTokens(scene)) {
              const tokenId = String(token.id || "");
              const actorIdValue = String(token.actorId || "");
              const tokenName = normalize(token.name);

              let score = 0;
              if (tokenId === raw) score = 10_000;
              else if (actorIdValue && actorIdValue === raw) score = 9_000;
              else if (key && tokenName && tokenName === key) score = 8_000;
              else if (key && tokenName && tokenName.startsWith(key)) score = 7_000;
              else if (key && tokenName && tokenName.includes(key)) score = 6_000;

              if (score > 0) {
                matches.push({ scene, token, score });
              }
            }
          }

          if (!matches.length) {
            return { ok: false, error: "Token not found." };
          }

          matches.sort((a, b) => b.score - a.score);
          const best = matches[0];
          let tied = matches.filter((candidate) => candidate.score === best.score);
          if (tied.length > 1 && best.score < 10_000) {
            const selectedTargetIds = Array.from(game.user?.targets || [])
              .map((target) => String(target?.document?.id || target?.id || "").trim())
              .filter(Boolean);
            if (selectedTargetIds.length > 0) {
              const selectedTied = tied.filter((candidate) => selectedTargetIds.includes(String(candidate.token.id || "")));
              if (selectedTied.length === 1) {
                const only = selectedTied[0];
                return { ok: true, scene: only.scene, token: only.token, autoResolved: "existing-target" };
              }
              if (selectedTied.length > 1) {
                tied = selectedTied;
              }
            }

            if (options.preferSceneId) {
              const sameScene = tied.filter((candidate) => candidate.scene?.id === options.preferSceneId);
              if (sameScene.length === 1) {
                const only = sameScene[0];
                return { ok: true, scene: only.scene, token: only.token, autoResolved: "same-scene" };
              }
              if (sameScene.length > 1) {
                tied = sameScene;
              }
            }

            const nearest = pickNearest(tied, options.originToken, options.originScene);
            if (nearest) {
              return { ok: true, scene: nearest.scene, token: nearest.token, autoResolved: "nearest" };
            }

            return {
              ok: false,
              error: "?대쫫??媛숈? ?좏겙???щ윭 媛쒖엯?덈떎. ?좏겙 ID濡?吏?뺥빐 二쇱꽭??",
              candidates: tied.slice(0, 8).map((candidate) => ({
                scene: candidate.scene.name,
                tokenName: candidate.token.name || candidate.token.id,
                tokenId: candidate.token.id,
              })),
            };
          }

          return { ok: true, scene: best.scene, token: best.token, autoResolved: null };
        }

        function combatantsOf(combat) {
          if (!combat) return [];
          if (Array.isArray(combat.combatants?.contents)) return combat.combatants.contents;
          if (Array.isArray(combat.combatants)) return combat.combatants;
          return [];
        }

        function pickCombat(scene) {
          const all = Array.isArray(game.combats?.contents) ? game.combats.contents : [];
          if (!all.length) return null;
          const sceneId = String(scene?.id || canvas?.scene?.id || game.scenes.current?.id || "");
          const open = all.filter((combat) => !combat?.ended);
          const byScene = open.filter((combat) => String(combat?.scene?.id || combat?.sceneId || "") === sceneId);
          return (
            game.combat ||
            byScene.find((combat) => Boolean(combat?.started || combat?.active)) ||
            byScene[0] ||
            open.find((combat) => Boolean(combat?.started || combat?.active)) ||
            open[0] ||
            null
          );
        }

        function findCombatantForToken(tokenDoc, combat) {
          if (!tokenDoc || !combat) return null;
          const tokenId = String(tokenDoc?.id || tokenDoc?.tokenId || "");
          const actorId = String(tokenDoc?.actorId || tokenDoc?.actor?.id || "");
          for (const combatant of combatantsOf(combat)) {
            const combatantTokenId = String(combatant?.tokenId || combatant?.token?.id || "");
            const combatantActorId = String(combatant?.actorId || combatant?.actor?.id || "");
            if (tokenId && combatantTokenId && tokenId === combatantTokenId) return combatant;
            if (actorId && combatantActorId && actorId === combatantActorId) return combatant;
          }
          return null;
        }

        function tokenHasDeadStatus(tokenDoc) {
          const actor = tokenDoc?.actor || game.actors.get(tokenDoc?.actorId) || null;
          const statuses = new Set();
          const pushStatus = (raw) => {
            const key = String(raw || "")
              .toLowerCase()
              .trim()
              .replace(/\s+/g, "")
              .replace(/[^\p{L}\p{N}._-]+/gu, "");
            if (!key) return;
            statuses.add(key);
          };
          const pushIterable = (iterable) => {
            if (!iterable || typeof iterable[Symbol.iterator] !== "function") return;
            for (const entry of iterable) pushStatus(entry);
          };
          pushIterable(actor?.statuses);
          pushIterable(tokenDoc?.statuses);
          const activeEffects = Array.isArray(actor?.effects?.contents)
            ? actor.effects.contents
            : Array.isArray(actor?.effects)
              ? actor.effects
              : [];
          for (const effect of activeEffects) {
            if (!effect || effect.disabled === true) continue;
            pushStatus(effect?.name || effect?.label || "");
            pushIterable(effect?.statuses);
          }
          return Array.from(statuses).some((key) => /dead|defeat|dying|사망|죽음/.test(key));
        }

        function isDeadLikeTarget(tokenDoc, combatant) {
          const actor = tokenDoc?.actor || game.actors.get(tokenDoc?.actorId) || null;
          const hp = actor?.system?.attributes?.hp ?? {};
          const hpValue = Number(hp?.value);
          const hpZero = Number.isFinite(hpValue) && hpValue <= 0;
          const defeated = Boolean(combatant?.defeated || tokenDoc?.combatant?.defeated);
          return hpZero || defeated || tokenHasDeadStatus(tokenDoc);
        }

        function validateTargetEligibility({ actorScene, actorToken, targetToken }) {
          const combat = pickCombat(actorScene || targetToken?.parent || null);
          const actorCombatant = findCombatantForToken(actorToken, combat);
          const targetCombatant = findCombatantForToken(targetToken, combat);
          if (isDeadLikeTarget(targetToken, targetCombatant)) {
            return {
              ok: false,
              error: "Target is invalid: HP is 0 or the target is dead/defeated.",
              errorCode: "TARGET_DEAD",
            };
          }
          if (actorCombatant && combat && !targetCombatant) {
            return {
              ok: false,
              error: "Target is not an active combat participant during combat.",
              errorCode: "TARGET_NOT_IN_COMBAT",
            };
          }
          return { ok: true };
        }

        function summarizeTargets() {
          return Array.from(game.user?.targets || []).map((target) => {
            const document = target?.document || target;
            const scene = document?.parent || null;
            return {
              id: String(document?.id || ""),
              name: String(document?.name || document?.id || ""),
              sceneId: String(scene?.id || ""),
              sceneName: String(scene?.name || ""),
            };
          });
        }

        const actor = findActor();
        if (!actor) {
          return { ok: false, error: "Actor not found for target selection." };
        }

        const { scene: actorScene, token: actorToken } = findTokenForActor(actor);
        if (!actorScene || !actorToken) {
          return {
            ok: false,
            error: "Actor token is not available on any scene.",
          };
        }

        const targetResult = findTokenByRef(rawTargetTokenRef, {
          preferSceneId: actorScene.id,
          originToken: actorToken,
          originScene: actorScene,
        });
        if (!targetResult.ok) {
          return {
            ok: false,
            error: targetResult.error,
            candidates: targetResult.candidates || [],
          };
        }

        if (targetResult.scene.id !== actorScene.id) {
          return {
            ok: false,
            error: `Target token is in a different scene (${targetResult.scene.name}) than actor token (${actorScene.name}).`,
          };
        }

        const eligibility = validateTargetEligibility({
          actorScene,
          actorToken,
          targetToken: targetResult.token,
        });
        if (!eligibility.ok) {
          return {
            ok: false,
            error: eligibility.error,
            errorCode: eligibility.errorCode || "TARGET_INVALID",
          };
        }

        if (!canvas.scene || canvas.scene.id !== actorScene.id) {
          await actorScene.view();
          await new Promise((resolve) => setTimeout(resolve, 250));
        }

        const actorPlaceable = canvas.tokens.placeables.find(
          (token) => token.document.id === actorToken.id
        );
        if (actorPlaceable?.control) {
          actorPlaceable.control({ releaseOthers: true });
        }

        const targetPlaceable = canvas.tokens.placeables.find(
          (token) => token.document.id === targetResult.token.id
        );
        if (!targetPlaceable?.setTarget) {
          return { ok: false, error: "Target token placeable is not available on canvas." };
        }

        for (const oldTarget of Array.from(game.user?.targets || [])) {
          if (oldTarget?.setTarget) {
            oldTarget.setTarget(false, { releaseOthers: false, user: game.user });
          }
        }

        targetPlaceable.setTarget(true, { releaseOthers: true, user: game.user });
        if (typeof game.user?.updateTokenTargets === "function") {
          game.user.updateTokenTargets([targetResult.token.id]);
        }

        return {
          ok: true,
          actor: {
            id: actor.id,
            name: actor.name,
            sceneId: actorScene.id,
            sceneName: actorScene.name,
          },
          target: {
            id: targetResult.token.id,
            name: targetResult.token.name || targetResult.token.id,
            sceneId: targetResult.scene.id,
            sceneName: targetResult.scene.name,
            autoResolved: targetResult.autoResolved || null,
          },
          targets: summarizeTargets(),
        };
      },
      { ...this._actorSelector(), targetTokenRef }
    );
  }

  async clearActorTargets() {
    await this._waitForGameReady();
    return this.page.evaluate(() => {
      const before = Array.from(game.user?.targets || []);
      for (const target of before) {
        if (target?.setTarget) {
          target.setTarget(false, { releaseOthers: false, user: game.user });
        }
      }
      if (typeof game.user?.updateTokenTargets === "function") {
        game.user.updateTokenTargets([]);
      }

      return {
        ok: true,
        cleared: before.length,
        targets: [],
      };
    });
  }

  async setActorAoeTargets(aoeSpec = {}) {
    await this._waitForGameReady();
    return this.page.evaluate(
      async ({ actorId, actorName, aoeSpec: rawAoeSpec }) => {
        function sceneTokens(scene) {
          if (!scene) return [];
          if (Array.isArray(scene.tokens?.contents)) return scene.tokens.contents;
          if (Array.isArray(scene.tokens)) return scene.tokens;
          return [];
        }

        function normalize(value) {
          return String(value || "")
            .toLowerCase()
            .trim()
            .replace(/\s+/g, "")
            .replace(/[^\p{L}\p{N}]+/gu, "");
        }

        function directionToDegrees(value, fallback = null) {
          const key = normalize(value).toUpperCase();
          const table = {
            E: 0,
            SE: 45,
            S: 90,
            SW: 135,
            W: 180,
            NW: 225,
            N: 270,
            NE: 315,
          };
          if (Object.prototype.hasOwnProperty.call(table, key)) {
            return table[key];
          }
          const numeric = Number(value);
          if (Number.isFinite(numeric)) return numeric;
          return fallback;
        }

        function findActor() {
          if (actorId) return game.actors.get(actorId) ?? null;
          if (!actorName) return null;
          const named = game.actors.filter((actor) => actor.name === actorName);
          if (named.length <= 1) return named[0] ?? null;

          const preferredScenes = [];
          const pushUnique = (scene) => {
            if (!scene?.id) return;
            if (!preferredScenes.some((entry) => entry.id === scene.id)) preferredScenes.push(scene);
          };
          pushUnique(canvas?.scene || null);
          pushUnique(game.scenes.current || null);
          pushUnique(game.scenes.active || null);

          for (const scene of preferredScenes) {
            const actorIdsOnScene = new Set(sceneTokens(scene).map((token) => String(token?.actorId || "")));
            const sceneMatch = named.find((candidate) => actorIdsOnScene.has(String(candidate?.id || "")));
            if (sceneMatch) return sceneMatch;
          }
          return named[0] ?? null;
        }

        function findTokenForActor(actor) {
          if (!actor) return { scene: null, token: null };
          const preferredScenes = [];
          const pushUnique = (scene) => {
            if (!scene?.id) return;
            if (!preferredScenes.some((entry) => entry.id === scene.id)) preferredScenes.push(scene);
          };

          pushUnique(canvas?.scene || null);
          pushUnique(game.scenes.current || null);
          pushUnique(game.scenes.active || null);

          for (const scene of preferredScenes) {
            const found = sceneTokens(scene).find((token) => token.actorId === actor.id);
            if (found) return { scene, token: found };
          }
          for (const scene of game.scenes.contents) {
            const found = sceneTokens(scene).find((token) => token.actorId === actor.id);
            if (found) return { scene, token: found };
          }
          return { scene: null, token: null };
        }

        function tokenCenter(token, scene) {
          const gridSizePx = Number(scene?.grid?.size ?? canvas?.grid?.size ?? 100) || 100;
          return {
            x: Number(token?.x || 0) + (Number(token?.width || 1) * gridSizePx) / 2,
            y: Number(token?.y || 0) + (Number(token?.height || 1) * gridSizePx) / 2,
          };
        }

        function distanceFtBetweenTokens(a, b, scene) {
          const gridSizePx = Number(scene?.grid?.size ?? canvas?.grid?.size ?? 100) || 100;
          const gridDistance = Number(scene?.grid?.distance ?? canvas?.scene?.grid?.distance ?? 5) || 5;
          const ac = tokenCenter(a, scene);
          const bc = tokenCenter(b, scene);
          try {
            const measured = canvas?.grid?.measurePath?.([ac, bc]);
            const distanceFt = Number(measured?.distance ?? measured?.cost);
            if (Number.isFinite(distanceFt)) return distanceFt;
          } catch {
            // ignore measure failures
          }

          const px = Math.hypot(bc.x - ac.x, bc.y - ac.y);
          return (px / gridSizePx) * gridDistance;
        }

        function distanceFtBetweenCenters(centerA, centerB, gridSizePx, gridDistance) {
          const ax = Number(centerA?.x || 0);
          const ay = Number(centerA?.y || 0);
          const bx = Number(centerB?.x || 0);
          const by = Number(centerB?.y || 0);
          try {
            const measured = canvas?.grid?.measurePath?.([{ x: ax, y: ay }, { x: bx, y: by }]);
            const distanceFt = Number(measured?.distance ?? measured?.cost);
            if (Number.isFinite(distanceFt)) return distanceFt;
          } catch {
            // ignore measure failures
          }

          const px = Math.hypot(bx - ax, by - ay);
          return (px / gridSizePx) * gridDistance;
        }

        function pickNearest(matches, originToken, originScene) {
          if (!originToken || !originScene || !Array.isArray(matches) || matches.length === 0) return null;
          const scoped = matches.filter((entry) => entry.scene?.id === originScene.id);
          if (scoped.length === 0) return null;
          const origin = tokenCenter(originToken, originScene);
          const sorted = [...scoped].sort((a, b) => {
            const da = Math.hypot(
              tokenCenter(a.token, a.scene).x - origin.x,
              tokenCenter(a.token, a.scene).y - origin.y
            );
            const db = Math.hypot(
              tokenCenter(b.token, b.scene).x - origin.x,
              tokenCenter(b.token, b.scene).y - origin.y
            );
            return da - db;
          });
          return sorted[0] || null;
        }

        function findTokenByRef(rawRef, options = {}) {
          const raw = String(rawRef || "").trim();
          const key = normalize(raw);
          const matches = [];

          for (const scene of game.scenes.contents) {
            for (const token of sceneTokens(scene)) {
              const tokenId = String(token.id || "");
              const actorIdValue = String(token.actorId || "");
              const tokenName = normalize(token.name);

              let score = 0;
              if (tokenId === raw) score = 10_000;
              else if (actorIdValue && actorIdValue === raw) score = 9_000;
              else if (key && tokenName && tokenName === key) score = 8_000;
              else if (key && tokenName && tokenName.startsWith(key)) score = 7_000;
              else if (key && tokenName && tokenName.includes(key)) score = 6_000;

              if (score > 0) {
                matches.push({ scene, token, score });
              }
            }
          }

          if (!matches.length) {
            return { ok: false, error: "?좏겙??李얠? 紐삵뻽?듬땲??" };
          }

          matches.sort((a, b) => b.score - a.score);
          const best = matches[0];
          let tied = matches.filter((candidate) => candidate.score === best.score);
          if (tied.length > 1 && best.score < 10_000) {
            if (options.preferSceneId) {
              const sameScene = tied.filter((candidate) => candidate.scene?.id === options.preferSceneId);
              if (sameScene.length === 1) {
                const only = sameScene[0];
                return { ok: true, scene: only.scene, token: only.token, autoResolved: "same-scene" };
              }
              if (sameScene.length > 1) {
                tied = sameScene;
              }
            }

            const nearest = pickNearest(tied, options.originToken, options.originScene);
            if (nearest) {
              return { ok: true, scene: nearest.scene, token: nearest.token, autoResolved: "nearest" };
            }

            return {
              ok: false,
              error: "?대쫫??媛숈? ?좏겙???щ윭 媛쒖엯?덈떎. ?좏겙 ID濡?吏?뺥빐 二쇱꽭??",
              candidates: tied.slice(0, 8).map((candidate) => ({
                scene: candidate.scene.name,
                tokenName: candidate.token.name || candidate.token.id,
                tokenId: candidate.token.id,
              })),
            };
          }

          return { ok: true, scene: best.scene, token: best.token, autoResolved: null };
        }

        function combatantsOf(combat) {
          if (!combat) return [];
          if (Array.isArray(combat.combatants?.contents)) return combat.combatants.contents;
          if (Array.isArray(combat.combatants)) return combat.combatants;
          return [];
        }

        function pickCombat(scene) {
          const all = Array.isArray(game.combats?.contents) ? game.combats.contents : [];
          if (!all.length) return null;
          const sceneId = String(scene?.id || canvas?.scene?.id || game.scenes.current?.id || "");
          const open = all.filter((combat) => !combat?.ended);
          const byScene = open.filter((combat) => String(combat?.scene?.id || combat?.sceneId || "") === sceneId);
          return (
            game.combat ||
            byScene.find((combat) => Boolean(combat?.started || combat?.active)) ||
            byScene[0] ||
            open.find((combat) => Boolean(combat?.started || combat?.active)) ||
            open[0] ||
            null
          );
        }

        function findCombatantForToken(tokenDoc, combat) {
          if (!tokenDoc || !combat) return null;
          const tokenId = String(tokenDoc?.id || tokenDoc?.tokenId || "");
          const actorId = String(tokenDoc?.actorId || tokenDoc?.actor?.id || "");
          for (const combatant of combatantsOf(combat)) {
            const combatantTokenId = String(combatant?.tokenId || combatant?.token?.id || "");
            const combatantActorId = String(combatant?.actorId || combatant?.actor?.id || "");
            if (tokenId && combatantTokenId && tokenId === combatantTokenId) return combatant;
            if (actorId && combatantActorId && actorId === combatantActorId) return combatant;
          }
          return null;
        }

        function tokenHasDeadStatus(tokenDoc) {
          const actor = tokenDoc?.actor || game.actors.get(tokenDoc?.actorId) || null;
          const statuses = new Set();
          const pushStatus = (raw) => {
            const key = String(raw || "")
              .toLowerCase()
              .trim()
              .replace(/\s+/g, "")
              .replace(/[^\p{L}\p{N}._-]+/gu, "");
            if (!key) return;
            statuses.add(key);
          };
          const pushIterable = (iterable) => {
            if (!iterable || typeof iterable[Symbol.iterator] !== "function") return;
            for (const entry of iterable) pushStatus(entry);
          };
          pushIterable(actor?.statuses);
          pushIterable(tokenDoc?.statuses);
          const activeEffects = Array.isArray(actor?.effects?.contents)
            ? actor.effects.contents
            : Array.isArray(actor?.effects)
              ? actor.effects
              : [];
          for (const effect of activeEffects) {
            if (!effect || effect.disabled === true) continue;
            pushStatus(effect?.name || effect?.label || "");
            pushIterable(effect?.statuses);
          }
          return Array.from(statuses).some((key) => /dead|defeat|dying|사망|죽음/.test(key));
        }

        function isDeadLikeTarget(tokenDoc, combatant) {
          const actor = tokenDoc?.actor || game.actors.get(tokenDoc?.actorId) || null;
          const hp = actor?.system?.attributes?.hp ?? {};
          const hpValue = Number(hp?.value);
          const hpZero = Number.isFinite(hpValue) && hpValue <= 0;
          const defeated = Boolean(combatant?.defeated || tokenDoc?.combatant?.defeated);
          return hpZero || defeated || tokenHasDeadStatus(tokenDoc);
        }

        function summarizeTargets() {
          return Array.from(game.user?.targets || []).map((target) => {
            const document = target?.document || target;
            const scene = document?.parent || null;
            return {
              id: String(document?.id || ""),
              name: String(document?.name || document?.id || ""),
              sceneId: String(scene?.id || ""),
              sceneName: String(scene?.name || ""),
            };
          });
        }

        const actor = findActor();
        if (!actor) {
          return { ok: false, error: "踰붿쐞 吏??二쇱껜 ?≫꽣瑜?李얠? 紐삵뻽?듬땲??" };
        }

        const { scene: actorScene, token: actorToken } = findTokenForActor(actor);
        if (!actorScene || !actorToken) {
          return {
            ok: false,
            error: "踰붿쐞 吏?뺤쓣 ?꾪빐 ?≫꽣 ?좏겙??留듭뿉 ?덉뼱???⑸땲??",
          };
        }

        if (!canvas.scene || canvas.scene.id !== actorScene.id) {
          await actorScene.view();
          await new Promise((resolve) => setTimeout(resolve, 250));
        }

        const actorPlaceable = canvas.tokens.placeables.find(
          (token) => token.document.id === actorToken.id
        );
        if (!actorPlaceable) {
          return { ok: false, error: "罹붾쾭?ㅼ뿉???≫꽣 ?좏겙??李얠? 紐삵뻽?듬땲??" };
        }

        const combat = pickCombat(actorScene);
        const actorCombatant = findCombatantForToken(actorToken, combat);

        const spec = rawAoeSpec && typeof rawAoeSpec === "object" ? rawAoeSpec : {};
        const shapeRaw = normalize(spec.shape || spec.type || "circle");
        const shape =
          shapeRaw === "cone"
            ? "cone"
            : shapeRaw === "line" || shapeRaw === "ray"
              ? "line"
              : "circle";
        const includeSelf = Boolean(spec.includeSelf);
        const includeHostileOnly = Boolean(spec.includeHostileOnly);
        const placeTemplate = spec.placeTemplate !== false;

        const gridDistance = Number(canvas.scene?.grid?.distance ?? actorScene.grid?.distance ?? 5) || 5;
        const gridSizePx = Number(canvas.grid?.size ?? 100) || 100;

        const radiusFt = Math.max(1, Number(spec.radiusFt ?? spec.distanceFt ?? spec.radius ?? 15) || 15);
        const lengthFt = Math.max(1, Number(spec.lengthFt ?? spec.distanceFt ?? spec.length ?? radiusFt) || radiusFt);
        const widthFt = Math.max(1, Number(spec.widthFt ?? spec.width ?? 5) || 5);
        const angleDeg = Math.max(1, Math.min(360, Number(spec.angleDeg ?? spec.angle ?? 60) || 60));

        const centerTokenRef = String(spec.centerTokenRef || spec.targetTokenRef || "").trim();
        let centerPoint = { x: actorPlaceable.center.x, y: actorPlaceable.center.y };
        let centerToken = null;
        if (centerTokenRef) {
          const centerResolved = findTokenByRef(centerTokenRef, {
            preferSceneId: actorScene.id,
            originToken: actorToken,
            originScene: actorScene,
          });
          if (!centerResolved.ok) {
            return {
              ok: false,
              error: `踰붿쐞 以묒떖 ?좏겙 吏???ㅽ뙣: ${centerResolved.error}`,
              candidates: centerResolved.candidates || [],
            };
          }
          if (centerResolved.scene.id !== actorScene.id) {
            return {
              ok: false,
              error: "踰붿쐞 以묒떖 ?좏겙???ㅻⅨ ?ъ뿉 ?덉뒿?덈떎. 媛숈? ?ъ쓽 ?좏겙留?吏?뺥븷 ???덉뒿?덈떎.",
            };
          }
          const centerCombatant = findCombatantForToken(centerResolved.token, combat);
          if (isDeadLikeTarget(centerResolved.token, centerCombatant)) {
            return {
              ok: false,
              error: "Center target is invalid: HP is 0 or the target is dead/defeated.",
              errorCode: "TARGET_DEAD",
            };
          }
          if (actorCombatant && combat && !centerCombatant) {
            return {
              ok: false,
              error: "Center target is not an active combat participant during combat.",
              errorCode: "TARGET_NOT_IN_COMBAT",
            };
          }
          centerToken = centerResolved.token;
          const centerPlaceable = canvas.tokens.placeables.find(
            (token) => token.document.id === centerResolved.token.id
          );
          if (!centerPlaceable) {
            return { ok: false, error: "罹붾쾭?ㅼ뿉??踰붿쐞 以묒떖 ?좏겙??李얠? 紐삵뻽?듬땲??" };
          }
          centerPoint = {
            x: Number(centerPlaceable.center.x),
            y: Number(centerPlaceable.center.y),
          };
        } else if (Number.isFinite(Number(spec.centerX)) && Number.isFinite(Number(spec.centerY))) {
          centerPoint = {
            x: Number(spec.centerX),
            y: Number(spec.centerY),
          };
        }

        let directionDeg = directionToDegrees(spec.direction, null);
        if (!Number.isFinite(directionDeg) && centerToken) {
          directionDeg =
            ((Math.atan2(
              centerPoint.y - Number(actorPlaceable.center.y),
              centerPoint.x - Number(actorPlaceable.center.x)
            ) *
              180) /
              Math.PI +
              360) %
            360;
        }
        if (!Number.isFinite(directionDeg)) {
          directionDeg = 0;
        }

        for (const oldTarget of Array.from(game.user?.targets || [])) {
          if (oldTarget?.setTarget) {
            oldTarget.setTarget(false, { releaseOthers: false, user: game.user });
          }
        }

        const selectedTargets = [];
        for (const token of canvas.tokens.placeables) {
          const document = token?.document;
          if (!document) continue;

          if (!includeSelf && document.id === actorToken.id) continue;
          if (includeHostileOnly && Number(document.disposition ?? 0) !== -1) continue;
          const targetCombatant = findCombatantForToken(document, combat);
          if (isDeadLikeTarget(document, targetCombatant)) continue;
          if (actorCombatant && combat && !targetCombatant) continue;

          const dx = Number(token.center.x) - centerPoint.x;
          const dy = Number(token.center.y) - centerPoint.y;
          const distanceFt = (Math.hypot(dx, dy) / gridSizePx) * gridDistance;

          let hit = false;
          if (shape === "circle") {
            hit = distanceFt <= radiusFt + 0.01;
          } else if (shape === "cone") {
            const angleToTarget = (((Math.atan2(dy, dx) * 180) / Math.PI) + 360) % 360;
            let delta = Math.abs(angleToTarget - directionDeg);
            if (delta > 180) delta = 360 - delta;
            hit = distanceFt <= lengthFt + 0.01 && delta <= angleDeg / 2 + 0.01;
          } else {
            const rad = (directionDeg * Math.PI) / 180;
            const unitX = Math.cos(rad);
            const unitY = Math.sin(rad);
            const projectionPx = dx * unitX + dy * unitY;
            const perpendicularPx = Math.abs(dx * -unitY + dy * unitX);
            const projectionFt = (projectionPx / gridSizePx) * gridDistance;
            const perpendicularFt = (perpendicularPx / gridSizePx) * gridDistance;
            hit =
              projectionFt >= -0.01 &&
              projectionFt <= lengthFt + 0.01 &&
              perpendicularFt <= widthFt / 2 + 0.01;
          }

          if (!hit) continue;
          if (token.setTarget) {
            token.setTarget(true, { releaseOthers: false, user: game.user });
          }
          selectedTargets.push({
            id: String(document.id || ""),
            name: String(document.name || document.id || ""),
            x: Number(document.x || 0),
            y: Number(document.y || 0),
            distanceFt: Number(distanceFt.toFixed(1)),
          });
        }

        if (typeof game.user?.updateTokenTargets === "function") {
          game.user.updateTokenTargets(selectedTargets.map((target) => target.id));
        }

        let templateId = null;
        if (placeTemplate && canvas.scene?.createEmbeddedDocuments) {
          const templateData = {
            user: game.user?.id,
            x: centerPoint.x,
            y: centerPoint.y,
            direction: directionDeg,
            fillColor: game.user?.color || "#ff5555",
          };

          if (shape === "circle") {
            templateData.t = "circle";
            templateData.distance = radiusFt;
          } else if (shape === "cone") {
            templateData.t = "cone";
            templateData.distance = lengthFt;
            templateData.angle = angleDeg;
          } else {
            templateData.t = "ray";
            templateData.distance = lengthFt;
            templateData.width = widthFt;
          }

          try {
            const created = await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [templateData]);
            const first = Array.isArray(created) ? created[0] : null;
            templateId = first?.id || null;
          } catch {
            // Template placement is best-effort.
          }
        }

        return {
          ok: true,
          actor: {
            id: actor.id,
            name: actor.name,
            sceneId: actorScene.id,
            sceneName: actorScene.name,
          },
          aoe: {
            shape,
            radiusFt,
            lengthFt,
            widthFt,
            angleDeg,
            directionDeg,
            center: centerPoint,
            centerToken: centerToken
              ? {
                  id: centerToken.id,
                  name: centerToken.name || centerToken.id,
                }
              : null,
            includeSelf,
            includeHostileOnly,
            templateId,
          },
          targets: summarizeTargets(),
          selectedTargets,
        };
      },
      { ...this._actorSelector(), aoeSpec }
    );
  }

  async useActorActionAoe(actionName, aoeSpec = {}) {
    await this._waitForGameReady();
    const prep = await this.setActorAoeTargets(aoeSpec);
    if (!prep?.ok) return prep;
    const actionResult = await this.useActorAction(actionName);
    return {
      ...actionResult,
      aoe: prep.aoe,
      selectedTargets: prep.selectedTargets || [],
      targets: prep.targets || [],
    };
  }

  async moveTokenByRef(tokenRef, moveIntent, difficultTerrainMultiplier) {
    await this._waitForGameReady();
    return this.page.evaluate(
      async ({ tokenRef: rawTokenRef, move, difficultTerrainMultiplier: terrainMultiplier }) => {
        function sceneTokens(scene) {
          if (!scene) return [];
          if (Array.isArray(scene.tokens?.contents)) return scene.tokens.contents;
          if (Array.isArray(scene.tokens)) return scene.tokens;
          return [];
        }

        function normalize(value) {
          return String(value || "")
            .toLowerCase()
            .trim()
            .replace(/\s+/g, "")
            .replace(/[^\p{L}\p{N}]+/gu, "");
        }

        function findTokenByRef(tokenRef) {
          const raw = String(tokenRef || "").trim();
          const key = normalize(raw);
          const matches = [];

          for (const scene of game.scenes.contents) {
            for (const token of sceneTokens(scene)) {
              const tokenId = String(token.id || "");
              const actorId = String(token.actorId || "");
              const tokenName = normalize(token.name);

              let score = 0;
              if (tokenId === raw) score = 10_000;
              else if (actorId && actorId === raw) score = 9_000;
              else if (key && tokenName && tokenName === key) score = 8_000;
              else if (key && tokenName && tokenName.startsWith(key)) score = 7_000;
              else if (key && tokenName && tokenName.includes(key)) score = 6_000;

              if (score > 0) {
                matches.push({ scene, token, score });
              }
            }
          }

          if (matches.length === 0) {
            return { ok: false, error: "?좏겙??李얠? 紐삵뻽?듬땲??" };
          }

          matches.sort((a, b) => b.score - a.score);
          const best = matches[0];
          const tied = matches.filter((m) => m.score === best.score);

          if (tied.length > 1 && best.score < 10_000) {
            return {
              ok: false,
              error: "Multiple tokens share that name. Use a specific token id.",
              candidates: tied.slice(0, 8).map((m) => ({
                scene: m.scene.name,
                tokenName: m.token.name || m.token.id,
                tokenId: m.token.id,
              })),
            };
          }

          return { ok: true, scene: best.scene, token: best.token };
        }

        function directionVector(direction) {
          const table = {
            N: [0, -1],
            S: [0, 1],
            E: [1, 0],
            W: [-1, 0],
            NE: [1, -1],
            NW: [-1, -1],
            SE: [1, 1],
            SW: [-1, 1],
          };
          return table[direction] ?? null;
        }

        const resolved = findTokenByRef(rawTokenRef);
        if (!resolved.ok) {
          return {
            ok: false,
            error: resolved.error,
            candidates: resolved.candidates || [],
          };
        }

        const { scene, token } = resolved;
        const vector = directionVector(move.direction);
        if (!vector) {
          return { ok: false, error: "?대룞 諛⑺뼢 ?댁꽍???ㅽ뙣?덉뒿?덈떎." };
        }

        if (!canvas.scene || canvas.scene.id !== scene.id) {
          await scene.view();
          await new Promise((resolve) => setTimeout(resolve, 250));
        }

        const placeable = canvas.tokens.placeables.find((t) => t.document.id === token.id);
        if (!placeable) {
          return {
            ok: false,
            error: "罹붾쾭?ㅼ뿉???좏겙??李얠? 紐삵뻽?듬땲?? ?대떦 ?ъ씠 ?대젮 ?덈뒗吏 ?뺤씤??二쇱꽭??",
          };
        }

        const actor = token.actor || game.actors.get(token.actorId) || null;
        const movement = actor?.system?.attributes?.movement ?? {};
        const walkSpeedFt = Number(
          movement.walk ?? movement.land ?? movement.fly ?? movement.swim ?? movement.burrow ?? 30
        ) || 30;
        const sceneGridDistance = Number(canvas.scene.grid.distance ?? 5) || 5;
        const gridSizePx = Number(canvas.grid.size ?? 100) || 100;
        const difficultMultiplier = Number(terrainMultiplier) > 1 ? Number(terrainMultiplier) : 2;
        const costMultiplier = move.difficult ? difficultMultiplier : 1;
        const stepBudgetFt = walkSpeedFt / costMultiplier;

        let requestedDistanceFt;
        if (move.maxRequested) {
          requestedDistanceFt = stepBudgetFt;
        } else if (move.amount === null || move.amount === undefined) {
          requestedDistanceFt = sceneGridDistance;
        } else if (move.unit === "ft") {
          requestedDistanceFt = Number(move.amount);
        } else {
          requestedDistanceFt = Number(move.amount) * sceneGridDistance;
        }

        if (!Number.isFinite(requestedDistanceFt) || requestedDistanceFt <= 0) {
          requestedDistanceFt = sceneGridDistance;
        }

        let requestedSteps = Math.max(1, Math.floor(requestedDistanceFt / sceneGridDistance));
        const maxByBudgetSteps = Math.max(1, Math.floor(stepBudgetFt / sceneGridDistance));
        if (move.maxRequested) {
          requestedSteps = maxByBudgetSteps;
        }

        const tokenWidthPx = Number(placeable.document.width ?? 1) * gridSizePx;
        const tokenHeightPx = Number(placeable.document.height ?? 1) * gridSizePx;
        const [vx, vy] = vector;
        const startX = Number(placeable.document.x);
        const startY = Number(placeable.document.y);
        const isDiagonal = vx !== 0 && vy !== 0;

        if (isDiagonal) {
          const budgetSteps = Math.max(0, Math.floor(stepBudgetFt / sceneGridDistance));
          const xSteps = Math.min(requestedSteps, budgetSteps);
          const ySteps = Math.min(requestedSteps, Math.max(0, budgetSteps - xSteps));
          const totalSteps = xSteps + ySteps;

          if (totalSteps <= 0) {
            return {
              ok: false,
              error: "?대쾲 ???대룞 媛??嫄곕━ ?덉뿉???대룞?????놁뒿?덈떎.",
              details: {
                walkSpeedFt,
                difficultApplied: move.difficult,
              },
            };
          }

          const points = [placeable.center];
          let x = startX;
          let y = startY;
          for (let i = 0; i < xSteps; i += 1) {
            x += vx * gridSizePx;
            points.push({
              x: x + tokenWidthPx / 2,
              y: startY + tokenHeightPx / 2,
            });
          }
          const midX = startX + vx * xSteps * gridSizePx;
          y = startY;
          for (let i = 0; i < ySteps; i += 1) {
            y += vy * gridSizePx;
            points.push({
              x: midX + tokenWidthPx / 2,
              y: y + tokenHeightPx / 2,
            });
          }

          const measured = canvas.grid.measurePath(points);
          const measuredDistanceFt = Number(
            measured?.distance ?? measured?.cost ?? totalSteps * sceneGridDistance
          );
          const costFt = measuredDistanceFt * costMultiplier;

          if (xSteps > 0) {
            await placeable.document.update({ x: midX, y: startY }, { animate: true });
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          if (ySteps > 0) {
            const finalY = startY + vy * ySteps * gridSizePx;
            await placeable.document.update({ x: midX, y: finalY }, { animate: true });
          }

          return {
            ok: true,
            actorName: actor?.name || token.name || token.id,
            tokenId: token.id,
            tokenName: token.name || token.id,
            sceneName: scene.name,
            stepsMoved: totalSteps,
            xSteps,
            ySteps,
            xDir: vx > 0 ? "E" : "W",
            yDir: vy > 0 ? "S" : "N",
            distanceFt: Number(measuredDistanceFt.toFixed(2)),
            costFt: Number(costFt.toFixed(2)),
            walkSpeedFt,
            remainingFt: Number(Math.max(0, walkSpeedFt - costFt).toFixed(2)),
            clipped: xSteps < requestedSteps || ySteps < requestedSteps,
            difficultApplied: move.difficult,
            difficultMultiplier: costMultiplier,
            note: move.difficult ? `difficult terrain: cost x${costMultiplier}` : "",
          };
        }

        function measureSteps(steps) {
          let x = startX;
          let y = startY;
          const points = [placeable.center];

          for (let i = 0; i < steps; i += 1) {
            x += vx * gridSizePx;
            y += vy * gridSizePx;
            points.push({
              x: x + tokenWidthPx / 2,
              y: y + tokenHeightPx / 2,
            });
          }

          const measured = canvas.grid.measurePath(points);
          const measuredDistanceFt = Number(
            measured?.distance ?? measured?.cost ?? steps * sceneGridDistance
          );
          const costFt = measuredDistanceFt * costMultiplier;
          return {
            steps,
            targetX: x,
            targetY: y,
            measuredDistanceFt,
            costFt,
          };
        }

        let current = measureSteps(requestedSteps);
        while (current.steps > 0 && current.costFt > walkSpeedFt) {
          current = measureSteps(current.steps - 1);
        }

        if (current.steps <= 0) {
          return {
            ok: false,
            error: "?대쾲 ???대룞 媛??嫄곕━ ?덉뿉???대룞?????놁뒿?덈떎.",
            details: {
              walkSpeedFt,
              difficultApplied: move.difficult,
            },
          };
        }

        await placeable.document.update(
          {
            x: current.targetX,
            y: current.targetY,
          },
          { animate: true }
        );

        return {
          ok: true,
          actorName: actor?.name || token.name || token.id,
          tokenId: token.id,
          tokenName: token.name || token.id,
          sceneName: scene.name,
          stepsMoved: current.steps,
          distanceFt: Number(current.measuredDistanceFt.toFixed(2)),
          costFt: Number(current.costFt.toFixed(2)),
          walkSpeedFt,
          remainingFt: Number(Math.max(0, walkSpeedFt - current.costFt).toFixed(2)),
          clipped: current.steps < requestedSteps,
          difficultApplied: move.difficult,
          difficultMultiplier: costMultiplier,
          note: move.difficult
            ? `?대젮??吏??媛?뺤쑝濡??대룞 鍮꾩슜 x${costMultiplier}瑜??곸슜?덉뒿?덈떎.`
            : "?대젮??吏???먮룞 媛먯????쒗븳?곸엯?덈떎. ?꾩슂?섎㈃ '?대젮??吏?? 議곌굔???④퍡 留먰빐 二쇱꽭??",
        };
      },
      {
        tokenRef,
        move: moveIntent,
        difficultTerrainMultiplier,
      }
    );
  }

  async getActorSheet() {
    await this._waitForGameReady();
    return this.page.evaluate(({ actorId, actorName }) => {
      function sceneTokens(scene) {
        if (!scene) return [];
        if (Array.isArray(scene.tokens?.contents)) return scene.tokens.contents;
        if (Array.isArray(scene.tokens)) return scene.tokens;
        return [];
      }

      function findActor() {
        if (actorId) return game.actors.get(actorId) ?? null;
        if (!actorName) return null;
        const named = game.actors.filter((a) => a.name === actorName);
        if (named.length <= 1) return named[0] ?? null;

        const preferredScenes = [];
        const pushUnique = (scene) => {
          if (!scene?.id) return;
          if (!preferredScenes.some((entry) => entry.id === scene.id)) preferredScenes.push(scene);
        };
        pushUnique(canvas?.scene || null);
        pushUnique(game.scenes.current || null);
        pushUnique(game.scenes.active || null);

        for (const scene of preferredScenes) {
          const actorIdsOnScene = new Set(sceneTokens(scene).map((token) => String(token?.actorId || "")));
          const sceneMatch = named.find((candidate) => actorIdsOnScene.has(String(candidate?.id || "")));
          if (sceneMatch) return sceneMatch;
        }
        return named[0] ?? null;
      }

      function findTokenForActor(actor) {
        if (!actor) return { scene: null, token: null };
        const preferredScenes = [];
        const pushUnique = (scene) => {
          if (!scene?.id) return;
          if (!preferredScenes.some((entry) => entry.id === scene.id)) preferredScenes.push(scene);
        };

        pushUnique(canvas?.scene || null);
        pushUnique(game.scenes.current || null);
        pushUnique(game.scenes.active || null);

        for (const scene of preferredScenes) {
          const found = sceneTokens(scene).find((t) => t.actorId === actor.id);
          if (found) return { scene, token: found };
        }
        for (const scene of game.scenes.contents) {
          const found = sceneTokens(scene).find((t) => t.actorId === actor.id);
          if (found) return { scene, token: found };
        }
        return { scene: null, token: null };
      }

        function summarizeActor(actor) {
        const hp = actor.system?.attributes?.hp ?? {};
        const acValue = actor.system?.attributes?.ac?.value ?? actor.system?.attributes?.ac ?? null;
        const movement = actor.system?.attributes?.movement ?? {};
        const spellDc = actor.system?.attributes?.spelldc ?? null;
        const proficiency = actor.system?.attributes?.prof ?? null;
        const level =
          actor.system?.details?.level ?? actor.system?.details?.cr ?? actor.system?.details?.xp?.value ?? null;
        const allItems = Array.isArray(actor.items?.contents) ? actor.items.contents : [];

        const abilities = Object.entries(actor.system?.abilities ?? {})
          .map(([key, value]) => ({
            key,
            score: Number(value?.value ?? 0),
            mod: Number(value?.mod ?? 0),
          }))
          .filter((ability) => Number.isFinite(ability.score));

        const actions = allItems
          .filter((item) => {
            const activation = item.system?.activation?.type;
            const actionType = item.system?.actionType;
            const activityCount = Array.isArray(item.system?.activities?.contents)
              ? item.system.activities.contents.length
              : 0;
            return Boolean(activation) || Boolean(actionType) || activityCount > 0;
          })
          .map((item) => {
            const damageParts = item.system?.damage?.parts ?? item.system?.damage?.base?.parts ?? [];
            const damage = Array.isArray(damageParts)
              ? damageParts
                  .map((part) => (Array.isArray(part) ? part[0] : String(part || "")))
                  .filter(Boolean)
                  .join(", ")
              : "";
            return {
              id: item.id,
              name: item.name,
              type: item.type,
              activation: item.system?.activation?.type || "",
              actionType: item.system?.actionType || "",
              range: [
                item.system?.range?.value !== undefined ? item.system?.range?.value : "",
                item.system?.range?.units || "",
              ]
                .join(" ")
                .trim(),
              damage,
              activityCount: Array.isArray(item.system?.activities?.contents)
                ? item.system.activities.contents.length
                : 0,
            };
          })
          .sort((a, b) => a.name.localeCompare(b.name, "ko"))
          .slice(0, 30);

        const spellItems = allItems
          .filter((item) => item.type === "spell")
          .map((item) => {
            const level = Number(item.system?.level ?? 0);
            const prepMode = String(item.system?.preparation?.mode || "");
            const prepared = Boolean(item.system?.preparation?.prepared) || prepMode.toLowerCase() === "always";
            const uses = Number(item.system?.uses?.value ?? 0);
            const usesMax = Number(item.system?.uses?.max ?? 0);
            const activityCount = Array.isArray(item.system?.activities?.contents)
              ? item.system.activities.contents.length
              : 0;
            return {
              id: item.id,
              name: item.name,
              level: Number.isFinite(level) ? level : 0,
              prepared,
              prepMode,
              school: String(item.system?.school || item.system?.school?.value || ""),
              concentration: Boolean(item.system?.components?.concentration),
              ritual: Boolean(item.system?.components?.ritual),
              uses: Number.isFinite(uses) ? uses : 0,
              usesMax: Number.isFinite(usesMax) ? usesMax : 0,
              activityCount,
            };
          })
          .sort((a, b) => {
            if (a.prepared !== b.prepared) return a.prepared ? -1 : 1;
            if (a.level !== b.level) return a.level - b.level;
            return String(a.name).localeCompare(String(b.name), "ko");
          });

          const spellSlotsRaw = actor.system?.spells ?? {};
          const spellSlots = {};
          for (const [key, slot] of Object.entries(spellSlotsRaw)) {
            if (!slot || typeof slot !== "object") continue;
            const value = Number(slot.value ?? 0);
            const max = Number(slot.max ?? 0);
            if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) continue;
            spellSlots[key] = { value, max };
          }

          const statusSet = new Set();
          const labels = [];
          const labelSet = new Set();
          const pushStatus = (raw) => {
            const key = String(raw || "")
              .toLowerCase()
              .trim()
              .replace(/\s+/g, "")
              .replace(/[^\p{L}\p{N}._-]+/gu, "");
            if (!key) return;
            statusSet.add(key);
          };
          const pushLabel = (raw) => {
            const label = String(raw || "").trim();
            if (!label) return;
            if (!labelSet.has(label)) {
              labelSet.add(label);
              labels.push(label);
            }
            pushStatus(label);
          };
          const pushIterable = (iterable) => {
            if (!iterable || typeof iterable[Symbol.iterator] !== "function") return;
            for (const entry of iterable) pushStatus(entry);
          };
          pushIterable(actor?.statuses);
          const effects = Array.isArray(actor?.effects?.contents)
            ? actor.effects.contents
            : Array.isArray(actor?.effects)
              ? actor.effects
              : [];
          for (const effect of effects) {
            if (!effect || effect.disabled === true) continue;
            pushLabel(effect?.name || effect?.label || "");
            pushIterable(effect?.statuses);
          }
          const statusKeys = Array.from(statusSet);
          const hasStatus = (re) => statusKeys.some((key) => re.test(key));
          const hpValueNum = Number(hp.value);
          const hpZero = Number.isFinite(hpValueNum) && hpValueNum <= 0;

          return {
            id: actor.id,
            name: actor.name,
            type: actor.type,
          level,
          hp: {
            value: Number(hp.value ?? 0),
            max: Number(hp.max ?? 0),
            temp: Number(hp.temp ?? 0),
          },
          ac: acValue !== null ? Number(acValue) : null,
          proficiency: proficiency !== null ? Number(proficiency) : null,
          movement: {
            walk: Number(movement.walk ?? movement.land ?? 0),
            fly: Number(movement.fly ?? 0),
            swim: Number(movement.swim ?? 0),
            burrow: Number(movement.burrow ?? 0),
            climb: Number(movement.climb ?? 0),
            units: "ft",
          },
          spellDc: spellDc !== null ? Number(spellDc) : null,
          spellSlots,
            spells: {
              count: spellItems.length,
              preparedCount: spellItems.filter((spell) => spell.prepared).length,
              items: spellItems.slice(0, 40),
            },
            conditions: {
              concentrating: hasStatus(/concentr|집중/),
              bleeding: hasStatus(/bleed|hemorr|출혈/),
              dead: hasStatus(/dead|defeat|dying|사망|죽음/) || hpZero,
              unconscious: hasStatus(/unconscious|기절|의식없|빈사/),
            },
            statusKeys: statusKeys.slice(0, 24),
            effects: labels.slice(0, 16),
            abilities,
            actions,
          };
        }

      const actor = findActor();
      if (!actor) {
        return { ok: false, error: "?≫꽣瑜?李얠? 紐삵뻽?듬땲??" };
      }

      const { scene, token } = findTokenForActor(actor);
      return {
        ok: true,
        actor: summarizeActor(actor),
        token: token
          ? {
              id: token.id,
              name: token.name || token.id,
              x: Number(token.x || 0),
              y: Number(token.y || 0),
              sceneId: scene?.id || "",
              sceneName: scene?.name || "",
            }
          : null,
      };
    }, this._actorSelector());
  }

  async getTokenSheet(tokenRef) {
    await this._waitForGameReady();
    return this.page.evaluate(({ tokenRef: rawTokenRef }) => {
      function sceneTokens(scene) {
        if (!scene) return [];
        if (Array.isArray(scene.tokens?.contents)) return scene.tokens.contents;
        if (Array.isArray(scene.tokens)) return scene.tokens;
        return [];
      }

      function normalize(value) {
        return String(value || "")
          .toLowerCase()
          .trim()
          .replace(/\s+/g, "")
          .replace(/[^\p{L}\p{N}]+/gu, "");
      }

      function findTokenByRef(tokenRef) {
        const raw = String(tokenRef || "").trim();
        const key = normalize(raw);
        const matches = [];

        for (const scene of game.scenes.contents) {
          for (const token of sceneTokens(scene)) {
            const tokenId = String(token.id || "");
            const actorId = String(token.actorId || "");
            const tokenName = normalize(token.name);

            let score = 0;
            if (tokenId === raw) score = 10_000;
            else if (actorId && actorId === raw) score = 9_000;
            else if (key && tokenName && tokenName === key) score = 8_000;
            else if (key && tokenName && tokenName.startsWith(key)) score = 7_000;
            else if (key && tokenName && tokenName.includes(key)) score = 6_000;

            if (score > 0) {
              matches.push({ scene, token, score });
            }
          }
        }

        if (matches.length === 0) {
          return { ok: false, error: "?좏겙??李얠? 紐삵뻽?듬땲??" };
        }

        matches.sort((a, b) => b.score - a.score);
        const best = matches[0];
        const tied = matches.filter((m) => m.score === best.score);
        if (tied.length > 1 && best.score < 10_000) {
          return {
            ok: false,
            error: "?대쫫??媛숈? ?좏겙???щ윭 媛쒖엯?덈떎. ?좏겙 ID濡?吏?뺥빐 二쇱꽭??",
            candidates: tied.slice(0, 8).map((m) => ({
              scene: m.scene.name,
              tokenName: m.token.name || m.token.id,
              tokenId: m.token.id,
            })),
          };
        }

        return { ok: true, scene: best.scene, token: best.token };
      }

      function summarizeActor(actor) {
        const hp = actor.system?.attributes?.hp ?? {};
        const acValue = actor.system?.attributes?.ac?.value ?? actor.system?.attributes?.ac ?? null;
        const movement = actor.system?.attributes?.movement ?? {};
        const spellDc = actor.system?.attributes?.spelldc ?? null;
        const proficiency = actor.system?.attributes?.prof ?? null;
        const level =
          actor.system?.details?.level ?? actor.system?.details?.cr ?? actor.system?.details?.xp?.value ?? null;
        const allItems = Array.isArray(actor.items?.contents) ? actor.items.contents : [];

        const actions = allItems
          .filter((item) => {
            const activation = item.system?.activation?.type;
            const actionType = item.system?.actionType;
            const activityCount = Array.isArray(item.system?.activities?.contents)
              ? item.system.activities.contents.length
              : 0;
            return Boolean(activation) || Boolean(actionType) || activityCount > 0;
          })
          .map((item) => {
            const damageParts = item.system?.damage?.parts ?? item.system?.damage?.base?.parts ?? [];
            const damage = Array.isArray(damageParts)
              ? damageParts
                  .map((part) => (Array.isArray(part) ? part[0] : String(part || "")))
                  .filter(Boolean)
                  .join(", ")
              : "";
            return {
              id: item.id,
              name: item.name,
              type: item.type,
              activation: item.system?.activation?.type || "",
              actionType: item.system?.actionType || "",
              range: [
                item.system?.range?.value !== undefined ? item.system?.range?.value : "",
                item.system?.range?.units || "",
              ]
                .join(" ")
                .trim(),
              damage,
              activityCount: Array.isArray(item.system?.activities?.contents)
                ? item.system.activities.contents.length
                : 0,
            };
          })
          .sort((a, b) => a.name.localeCompare(b.name, "ko"))
          .slice(0, 30);

        const spellItems = allItems
          .filter((item) => item.type === "spell")
          .map((item) => {
            const level = Number(item.system?.level ?? 0);
            const prepMode = String(item.system?.preparation?.mode || "");
            const prepared = Boolean(item.system?.preparation?.prepared) || prepMode.toLowerCase() === "always";
            const uses = Number(item.system?.uses?.value ?? 0);
            const usesMax = Number(item.system?.uses?.max ?? 0);
            const activityCount = Array.isArray(item.system?.activities?.contents)
              ? item.system.activities.contents.length
              : 0;
            return {
              id: item.id,
              name: item.name,
              level: Number.isFinite(level) ? level : 0,
              prepared,
              prepMode,
              school: String(item.system?.school || item.system?.school?.value || ""),
              concentration: Boolean(item.system?.components?.concentration),
              ritual: Boolean(item.system?.components?.ritual),
              uses: Number.isFinite(uses) ? uses : 0,
              usesMax: Number.isFinite(usesMax) ? usesMax : 0,
              activityCount,
            };
          })
          .sort((a, b) => {
            if (a.prepared !== b.prepared) return a.prepared ? -1 : 1;
            if (a.level !== b.level) return a.level - b.level;
            return String(a.name).localeCompare(String(b.name), "ko");
          });

        const spellSlotsRaw = actor.system?.spells ?? {};
        const spellSlots = {};
        for (const [key, slot] of Object.entries(spellSlotsRaw)) {
          if (!slot || typeof slot !== "object") continue;
          const value = Number(slot.value ?? 0);
          const max = Number(slot.max ?? 0);
          if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) continue;
          spellSlots[key] = { value, max };
        }

        const statusSet = new Set();
        const labels = [];
        const labelSet = new Set();
        const pushStatus = (raw) => {
          const key = String(raw || "")
            .toLowerCase()
            .trim()
            .replace(/\s+/g, "")
            .replace(/[^\p{L}\p{N}._-]+/gu, "");
          if (!key) return;
          statusSet.add(key);
        };
        const pushLabel = (raw) => {
          const label = String(raw || "").trim();
          if (!label) return;
          if (!labelSet.has(label)) {
            labelSet.add(label);
            labels.push(label);
          }
          pushStatus(label);
        };
        const pushIterable = (iterable) => {
          if (!iterable || typeof iterable[Symbol.iterator] !== "function") return;
          for (const entry of iterable) pushStatus(entry);
        };
        pushIterable(actor?.statuses);
        const effects = Array.isArray(actor?.effects?.contents)
          ? actor.effects.contents
          : Array.isArray(actor?.effects)
            ? actor.effects
            : [];
        for (const effect of effects) {
          if (!effect || effect.disabled === true) continue;
          pushLabel(effect?.name || effect?.label || "");
          pushIterable(effect?.statuses);
        }
        const statusKeys = Array.from(statusSet);
        const hasStatus = (re) => statusKeys.some((key) => re.test(key));
        const hpValueNum = Number(hp.value);
        const hpZero = Number.isFinite(hpValueNum) && hpValueNum <= 0;

        return {
          id: actor.id,
          name: actor.name,
          type: actor.type,
          level,
          hp: {
            value: Number(hp.value ?? 0),
            max: Number(hp.max ?? 0),
            temp: Number(hp.temp ?? 0),
          },
          ac: acValue !== null ? Number(acValue) : null,
          proficiency: proficiency !== null ? Number(proficiency) : null,
          movement: {
            walk: Number(movement.walk ?? movement.land ?? 0),
            fly: Number(movement.fly ?? 0),
            swim: Number(movement.swim ?? 0),
            burrow: Number(movement.burrow ?? 0),
            climb: Number(movement.climb ?? 0),
            units: "ft",
          },
          spellDc: spellDc !== null ? Number(spellDc) : null,
          spellSlots,
          spells: {
            count: spellItems.length,
            preparedCount: spellItems.filter((spell) => spell.prepared).length,
            items: spellItems.slice(0, 40),
          },
          conditions: {
            concentrating: hasStatus(/concentr|집중/),
            bleeding: hasStatus(/bleed|hemorr|출혈/),
            dead: hasStatus(/dead|defeat|dying|사망|죽음/) || hpZero,
            unconscious: hasStatus(/unconscious|기절|의식없|빈사/),
          },
          statusKeys: statusKeys.slice(0, 24),
          effects: labels.slice(0, 16),
          actions,
        };
      }

      const resolved = findTokenByRef(rawTokenRef);
      if (!resolved.ok) {
        return {
          ok: false,
          error: resolved.error,
          candidates: resolved.candidates || [],
        };
      }

      const { scene, token } = resolved;
      const actor = token.actor || game.actors.get(token.actorId) || null;
      if (!actor) {
        return {
          ok: false,
          error: "?대떦 ?좏겙???곌껐???≫꽣媛 ?놁뒿?덈떎.",
        };
      }

      return {
        ok: true,
        actor: summarizeActor(actor),
        token: {
          id: token.id,
          name: token.name || token.id,
          x: Number(token.x || 0),
          y: Number(token.y || 0),
          sceneId: scene.id,
          sceneName: scene.name,
        },
      };
    }, { tokenRef });
  }

  async useActorAction(actionName, targetTokenRef = null) {
    await this._waitForGameReady();
    return this._performAction({
      mode: "actor",
      ...this._actorSelector(),
      actionName,
      targetTokenRef,
    });
  }

  async useTokenAction(tokenRef, actionName, targetTokenRef = null) {
    await this._waitForGameReady();
    return this._performAction({
      mode: "token",
      tokenRef,
      actionName,
      targetTokenRef,
    });
  }

  async useActorActionSmart(actionName, targetTokenRef = null) {
    await this._waitForGameReady();
    return this._performAction({
      mode: "actor",
      ...this._actorSelector(),
      actionName,
      targetTokenRef,
      autoApproach: true,
    });
  }

  async useTokenActionSmart(tokenRef, actionName, targetTokenRef = null) {
    await this._waitForGameReady();
    return this._performAction({
      mode: "token",
      tokenRef,
      actionName,
      targetTokenRef,
      autoApproach: true,
    });
  }

  async _performAction(request) {
    return this.page.evaluate(
      async ({ mode, actorId, actorName, tokenRef, actionName: rawActionName, targetTokenRef, autoApproach }) => {
        function sceneTokens(scene) {
          if (!scene) return [];
          if (Array.isArray(scene.tokens?.contents)) return scene.tokens.contents;
          if (Array.isArray(scene.tokens)) return scene.tokens;
          return [];
        }

        function normalize(value) {
          return String(value || "")
            .toLowerCase()
            .trim()
            .replace(/\s+/g, "")
            .replace(/[^\p{L}\p{N}]+/gu, "");
        }

        function toPlainText(html) {
          const div = document.createElement("div");
          div.innerHTML = String(html || "");
          return (div.textContent || "")
            .replace(/\s+/g, " ")
            .trim();
        }

        function tokenCenter(token, scene) {
          const gridSizePx = Number(scene?.grid?.size ?? canvas?.grid?.size ?? 100) || 100;
          return {
            x: Number(token?.x || 0) + (Number(token?.width || 1) * gridSizePx) / 2,
            y: Number(token?.y || 0) + (Number(token?.height || 1) * gridSizePx) / 2,
          };
        }

        function distanceFtBetweenTokens(a, b, scene) {
          const gridSizePx = Number(scene?.grid?.size ?? canvas?.grid?.size ?? 100) || 100;
          const gridDistance = Number(scene?.grid?.distance ?? canvas?.scene?.grid?.distance ?? 5) || 5;
          const ac = tokenCenter(a, scene);
          const bc = tokenCenter(b, scene);
          try {
            const measured = canvas?.grid?.measurePath?.([ac, bc]);
            const distanceFt = Number(measured?.distance ?? measured?.cost);
            if (Number.isFinite(distanceFt)) return distanceFt;
          } catch {
            // ignore measure failures
          }

          const px = Math.hypot(bc.x - ac.x, bc.y - ac.y);
          return (px / gridSizePx) * gridDistance;
        }

        function distanceFtBetweenCenters(centerA, centerB, gridSizePx, gridDistance) {
          const ax = Number(centerA?.x || 0);
          const ay = Number(centerA?.y || 0);
          const bx = Number(centerB?.x || 0);
          const by = Number(centerB?.y || 0);
          try {
            const measured = canvas?.grid?.measurePath?.([{ x: ax, y: ay }, { x: bx, y: by }]);
            const distanceFt = Number(measured?.distance ?? measured?.cost);
            if (Number.isFinite(distanceFt)) return distanceFt;
          } catch {
            // ignore measure failures
          }

          const px = Math.hypot(bx - ax, by - ay);
          return (px / gridSizePx) * gridDistance;
        }

        function pickNearest(matches, originToken, originScene) {
          if (!originToken || !originScene || !Array.isArray(matches) || matches.length === 0) return null;
          const scoped = matches.filter((entry) => entry.scene?.id === originScene.id);
          if (scoped.length === 0) return null;
          const origin = tokenCenter(originToken, originScene);
          const sorted = [...scoped].sort((a, b) => {
            const da = Math.hypot(
              tokenCenter(a.token, a.scene).x - origin.x,
              tokenCenter(a.token, a.scene).y - origin.y
            );
            const db = Math.hypot(
              tokenCenter(b.token, b.scene).x - origin.x,
              tokenCenter(b.token, b.scene).y - origin.y
            );
            return da - db;
          });
          return sorted[0] || null;
        }

        function findTokenByRef(rawRef, options = {}) {
          const raw = String(rawRef || "").trim();
          const key = normalize(raw);
          const matches = [];

          for (const scene of game.scenes.contents) {
            for (const token of sceneTokens(scene)) {
              const tokenId = String(token.id || "");
              const actorId = String(token.actorId || "");
              const tokenName = normalize(token.name);

              let score = 0;
              if (tokenId === raw) score = 10_000;
              else if (actorId && actorId === raw) score = 9_000;
              else if (key && tokenName && tokenName === key) score = 8_000;
              else if (key && tokenName && tokenName.startsWith(key)) score = 7_000;
              else if (key && tokenName && tokenName.includes(key)) score = 6_000;

              if (score > 0) {
                matches.push({ scene, token, score });
              }
            }
          }

          if (!matches.length) {
            return { ok: false, error: "?좏겙??李얠? 紐삵뻽?듬땲??" };
          }

          matches.sort((a, b) => b.score - a.score);
          const best = matches[0];
          let tied = matches.filter((m) => m.score === best.score);
          if (tied.length > 1 && best.score < 10_000) {
            if (options.preferSceneId) {
              const sameScene = tied.filter((candidate) => candidate.scene?.id === options.preferSceneId);
              if (sameScene.length === 1) {
                const only = sameScene[0];
                return { ok: true, scene: only.scene, token: only.token, autoResolved: "same-scene" };
              }
              if (sameScene.length > 1) {
                tied = sameScene;
              }
            }

            const nearest = pickNearest(tied, options.originToken, options.originScene);
            if (nearest) {
              return { ok: true, scene: nearest.scene, token: nearest.token, autoResolved: "nearest" };
            }

            return {
              ok: false,
              error: "?대쫫??媛숈? ?좏겙???щ윭 媛쒖엯?덈떎. ?좏겙 ID濡?吏?뺥빐 二쇱꽭??",
              candidates: tied.slice(0, 8).map((m) => ({
                scene: m.scene.name,
                tokenName: m.token.name || m.token.id,
                tokenId: m.token.id,
              })),
            };
          }

          return { ok: true, scene: best.scene, token: best.token, autoResolved: null };
        }

        function combatantsOf(combat) {
          if (!combat) return [];
          if (Array.isArray(combat.combatants?.contents)) return combat.combatants.contents;
          if (Array.isArray(combat.combatants)) return combat.combatants;
          return [];
        }

        function pickCombat(scene) {
          const all = Array.isArray(game.combats?.contents) ? game.combats.contents : [];
          if (!all.length) return null;
          const sceneId = String(scene?.id || canvas?.scene?.id || game.scenes.current?.id || "");
          const open = all.filter((combat) => !combat?.ended);
          const byScene = open.filter((combat) => String(combat?.scene?.id || combat?.sceneId || "") === sceneId);
          return (
            game.combat ||
            byScene.find((combat) => Boolean(combat?.started || combat?.active)) ||
            byScene[0] ||
            open.find((combat) => Boolean(combat?.started || combat?.active)) ||
            open[0] ||
            null
          );
        }

        function findCombatantForToken(tokenDoc, combat) {
          if (!tokenDoc || !combat) return null;
          const tokenId = String(tokenDoc?.id || tokenDoc?.tokenId || "");
          const actorId = String(tokenDoc?.actorId || tokenDoc?.actor?.id || "");
          for (const combatant of combatantsOf(combat)) {
            const combatantTokenId = String(combatant?.tokenId || combatant?.token?.id || "");
            const combatantActorId = String(combatant?.actorId || combatant?.actor?.id || "");
            if (tokenId && combatantTokenId && tokenId === combatantTokenId) return combatant;
            if (actorId && combatantActorId && actorId === combatantActorId) return combatant;
          }
          return null;
        }

        function tokenHasDeadStatus(tokenDoc) {
          const actor = tokenDoc?.actor || game.actors.get(tokenDoc?.actorId) || null;
          const statuses = new Set();
          const pushStatus = (raw) => {
            const key = String(raw || "")
              .toLowerCase()
              .trim()
              .replace(/\s+/g, "")
              .replace(/[^\p{L}\p{N}._-]+/gu, "");
            if (!key) return;
            statuses.add(key);
          };
          const pushIterable = (iterable) => {
            if (!iterable || typeof iterable[Symbol.iterator] !== "function") return;
            for (const entry of iterable) pushStatus(entry);
          };
          pushIterable(actor?.statuses);
          pushIterable(tokenDoc?.statuses);
          const activeEffects = Array.isArray(actor?.effects?.contents)
            ? actor.effects.contents
            : Array.isArray(actor?.effects)
              ? actor.effects
              : [];
          for (const effect of activeEffects) {
            if (!effect || effect.disabled === true) continue;
            pushStatus(effect?.name || effect?.label || "");
            pushIterable(effect?.statuses);
          }
          return Array.from(statuses).some((key) => /dead|defeat|dying|사망|죽음/.test(key));
        }

        function isDeadLikeTarget(tokenDoc, combatant) {
          const actor = tokenDoc?.actor || game.actors.get(tokenDoc?.actorId) || null;
          const hp = actor?.system?.attributes?.hp ?? {};
          const hpValue = Number(hp?.value);
          const hpZero = Number.isFinite(hpValue) && hpValue <= 0;
          const defeated = Boolean(combatant?.defeated || tokenDoc?.combatant?.defeated);
          return hpZero || defeated || tokenHasDeadStatus(tokenDoc);
        }

        function validateTargetEligibility({ actorScene, actorToken, targetToken }) {
          const combat = pickCombat(actorScene || targetToken?.parent || null);
          const actorCombatant = findCombatantForToken(actorToken, combat);
          const targetCombatant = findCombatantForToken(targetToken, combat);
          if (isDeadLikeTarget(targetToken, targetCombatant)) {
            return {
              ok: false,
              error: "Target is invalid: HP is 0 or the target is dead/defeated.",
              errorCode: "TARGET_DEAD",
            };
          }
          if (actorCombatant && combat && !targetCombatant) {
            return {
              ok: false,
              error: "Target is not an active combat participant during combat.",
              errorCode: "TARGET_NOT_IN_COMBAT",
            };
          }
          return { ok: true };
        }

        function findActorBySelector() {
          if (actorId) return game.actors.get(actorId) ?? null;
          if (!actorName) return null;
          const named = game.actors.filter((a) => a.name === actorName);
          if (named.length <= 1) return named[0] ?? null;

          const preferredScenes = [];
          const pushUnique = (scene) => {
            if (!scene?.id) return;
            if (!preferredScenes.some((entry) => entry.id === scene.id)) preferredScenes.push(scene);
          };
          pushUnique(canvas?.scene || null);
          pushUnique(game.scenes.current || null);
          pushUnique(game.scenes.active || null);

          for (const scene of preferredScenes) {
            const actorIdsOnScene = new Set(sceneTokens(scene).map((token) => String(token?.actorId || "")));
            const sceneMatch = named.find((candidate) => actorIdsOnScene.has(String(candidate?.id || "")));
            if (sceneMatch) return sceneMatch;
          }
          return named[0] ?? null;
        }

        function findTokenForActor(actor) {
          if (!actor) return { scene: null, token: null };
          const preferredScenes = [];
          const pushUnique = (scene) => {
            if (!scene?.id) return;
            if (!preferredScenes.some((entry) => entry.id === scene.id)) preferredScenes.push(scene);
          };

          pushUnique(canvas?.scene || null);
          pushUnique(game.scenes.current || null);
          pushUnique(game.scenes.active || null);

          for (const scene of preferredScenes) {
            const found = sceneTokens(scene).find((token) => token.actorId === actor.id);
            if (found) return { scene, token: found };
          }
          for (const scene of game.scenes.contents) {
            const found = sceneTokens(scene).find((token) => token.actorId === actor.id);
            if (found) return { scene, token: found };
          }
          return { scene: null, token: null };
        }

        function listActionItems(actor) {
          const items = Array.isArray(actor?.items?.contents) ? actor.items.contents : [];
          return items.filter((item) => {
            const activation = item.system?.activation?.type;
            const actionType = item.system?.actionType;
            const activityCount = Array.isArray(item.system?.activities?.contents)
              ? item.system.activities.contents.length
              : 0;
            return (
              Boolean(activation) ||
              Boolean(actionType) ||
              activityCount > 0 ||
              ["weapon", "spell", "feat", "equipment", "consumable", "tool"].includes(item.type)
            );
          });
        }

        function listItemActivities(item) {
          if (!item) return [];
          if (Array.isArray(item.system?.activities?.contents)) return item.system.activities.contents;
          if (Array.isArray(item.system?.activities)) return item.system.activities;
          return [];
        }

        function summarizeActionItem(item) {
          const damageParts = item.system?.damage?.parts ?? item.system?.damage?.base?.parts ?? [];
          const damage = Array.isArray(damageParts)
            ? damageParts
                .map((part) => (Array.isArray(part) ? part[0] : String(part || "")))
                .filter(Boolean)
                .join(", ")
            : "";
          const levelRaw = Number(item?.system?.level ?? item?.system?.spellLevel ?? 0);
          const spellLevel = Number.isFinite(levelRaw) ? Math.max(0, Math.floor(levelRaw)) : 0;
          const templateFromActivity = listItemActivities(item)
            .map((activity) => activity?.target?.template)
            .find((template) => Boolean(template?.type));
          const templateFromItem = item?.system?.target?.template;
          const templateSpec = templateFromActivity?.type ? templateFromActivity : templateFromItem;

          return {
            id: item.id,
            name: item.name,
            type: item.type,
            spellLevel,
            activation: item.system?.activation?.type || "",
            actionType: item.system?.actionType || "",
            range: [
              item.system?.range?.value !== undefined ? item.system?.range?.value : "",
              item.system?.range?.units || "",
            ]
              .join(" ")
              .trim(),
            damage,
            activityCount: listItemActivities(item).length,
            activities: listItemActivities(item)
              .slice(0, 8)
              .map((activity) => ({
                id: String(activity.id || ""),
                name: String(activity.name || activity.id || ""),
                type: String(activity.type || activity.activation?.type || ""),
              })),
            template: templateSpec?.type
              ? {
                  type: String(templateSpec.type || ""),
                  size: Number(templateSpec.size ?? 0) || 0,
                  width: Number(templateSpec.width ?? 0) || 0,
                  height: Number(templateSpec.height ?? 0) || 0,
                  units: String(templateSpec.units || ""),
                }
              : null,
          };
        }

        function getSpellCastAvailability(item, actor) {
          const itemType = String(item?.type || "")
            .trim()
            .toLowerCase();
          if (itemType !== "spell") {
            return { ok: true, spell: false };
          }

          const levelRaw = Number(item?.system?.level ?? item?.system?.spellLevel ?? 0);
          const level = Number.isFinite(levelRaw) ? Math.max(0, Math.floor(levelRaw)) : 0;
          if (level <= 0) {
            return { ok: true, spell: true, level, cantrip: true };
          }

          const spells = actor?.system?.spells ?? {};
          const slotKey = `spell${level}`;
          const normal = spells?.[slotKey] || {};
          const pact = spells?.pact || {};

          const normalValue = Number(normal?.value ?? 0) || 0;
          const normalMax = Number(normal?.max ?? 0) || 0;
          const pactValue = Number(pact?.value ?? 0) || 0;
          const pactMax = Number(pact?.max ?? 0) || 0;
          const pactLevel = Number(pact?.level ?? 0) || 0;

          const hasNormal = normalValue > 0;
          const hasPact = pactValue > 0 && pactLevel >= level;
          const ok = hasNormal || hasPact;

          return {
            ok,
            spell: true,
            level,
            cantrip: false,
            slotKey,
            normalValue,
            normalMax,
            pactValue,
            pactMax,
            pactLevel,
            hasNormal,
            hasPact,
          };
        }

        function itemHasProperty(item, key) {
          const props = item?.system?.properties;
          if (!props) return false;
          if (Array.isArray(props)) return props.includes(key);
          if (typeof props?.has === "function") return props.has(key);
          if (typeof props === "object") return Boolean(props[key]);
          return false;
        }

        function itemRangeSpec(item) {
          const actionType = String(item?.system?.actionType || "")
            .trim()
            .toLowerCase();
          const range = item?.system?.range ?? {};
          const units = String(range?.units || range?.unit || "")
            .trim()
            .toLowerCase();
          let normalFt = Number(range?.value);
          let longFt = Number(range?.long);

          if (!Number.isFinite(normalFt) || normalFt <= 0) normalFt = null;
          if (!Number.isFinite(longFt) || longFt <= 0) longFt = null;

          if (!normalFt && units === "touch") normalFt = 5;
          if (!normalFt && (actionType === "mwak" || actionType === "msak")) normalFt = 5;

          let maxFt = normalFt;
          if (longFt && (!maxFt || longFt > maxFt)) maxFt = longFt;

          if (itemHasProperty(item, "rch") && (!maxFt || maxFt < 10)) {
            maxFt = 10;
          }

          // Units like self/spec don't describe a targetable range.
          if (units === "self" || units === "spec") {
            maxFt = null;
          }

          return { units, normalFt, longFt, maxFt };
        }

        function inRangeScore(item, targetDistanceFt) {
          if (!Number.isFinite(targetDistanceFt) || targetDistanceFt <= 0) return 0;
          const range = itemRangeSpec(item);
          const maxFt = Number(range.maxFt);
          if (!Number.isFinite(maxFt) || maxFt <= 0) return 0;
          return targetDistanceFt <= maxFt + 0.1 ? 120 : -120;
        }

        function findActionItem(actor, actionQuery, options = {}) {
          const raw = String(actionQuery || "").trim();
          const key = normalize(raw);
          const targetDistanceFt = Number(options?.targetDistanceFt);
          const matches = [];
          const isGenericAttack = /(일반\s*공격|공격|attack|타격)/i.test(raw);
          const isGenericSpell = /(주문|spell|시전|마법|캐스트)/i.test(raw);

          function equippedScore(item) {
            const equippedRaw = item.system?.equipped;
            const equipped = Boolean(
              (typeof equippedRaw === "object" ? equippedRaw?.value : equippedRaw) ||
                item.system?.attuned ||
                item.system?.prepared
            );
            return equipped ? 1 : 0;
          }

          for (const item of listActionItems(actor)) {
            const itemId = String(item.id || "");
            const itemName = normalize(item.name);
            let score = 0;
            let preferredActivityId = null;
            let preferredActivityName = null;
            if (itemId === raw) score = 10_000;
            else if (itemName && itemName === key) score = 9_000;
            else if (itemName && itemName.startsWith(key)) score = 8_000;
            else if (itemName && itemName.includes(key)) score = 7_000;

            for (const activity of listItemActivities(item)) {
              const activityName = String(activity?.name || "").trim();
              const activityKey = normalize(activityName);
              let activityScore = 0;
              if (activityName && activityName === raw) activityScore = 9_800;
              else if (activityKey && activityKey === key) activityScore = 9_700;
              else if (activityKey && activityKey.startsWith(key)) activityScore = 8_700;
              else if (activityKey && activityKey.includes(key)) activityScore = 7_700;
              else if (isGenericAttack && /(attack|공격|타격|weapon)/i.test(activityName)) activityScore = 6_600;
              else if (isGenericSpell && /(cast|spell|주문|시전|마법)/i.test(activityName)) activityScore = 6_500;
              if (activityScore > score) {
                score = activityScore;
                preferredActivityId = String(activity.id || "");
                preferredActivityName = activityName || null;
              }
            }

            if (score > 0) {
              if (isGenericAttack || isGenericSpell) {
                score += inRangeScore(item, targetDistanceFt);
                score += equippedScore(item) * 4;
              }
              matches.push({ item, score, preferredActivityId, preferredActivityName });
            }
          }

          if (!matches.length) {
            if (isGenericAttack) {
              const weaponItems = listActionItems(actor)
                .filter((item) => String(item.type || "").toLowerCase() === "weapon")
                .sort((a, b) => {
                  const ar = inRangeScore(a, targetDistanceFt);
                  const br = inRangeScore(b, targetDistanceFt);
                  if (ar !== br) return br - ar;
                  const ae = equippedScore(a);
                  const be = equippedScore(b);
                  if (ae !== be) return be - ae;
                  const aRange = Number(itemRangeSpec(a).maxFt || 0);
                  const bRange = Number(itemRangeSpec(b).maxFt || 0);
                  if (aRange !== bRange) return bRange - aRange;
                  return String(a.name || "").localeCompare(String(b.name || ""), "ko");
                });
              if (weaponItems.length > 0) {
                const item = weaponItems[0];
                const firstActivity = listItemActivities(item)[0] || null;
                return {
                  ok: true,
                  item,
                  preferredActivityId: firstActivity ? String(firstActivity.id || "") : null,
                  preferredActivityName: firstActivity?.name || null,
                  autoResolved: "generic-attack",
                };
              }
            }

            if (isGenericSpell) {
              const spellItems = listActionItems(actor)
                .filter((item) => String(item.type || "").toLowerCase() === "spell")
                .sort((a, b) => {
                  const ap = Boolean(a.system?.preparation?.prepared) ? 1 : 0;
                  const bp = Boolean(b.system?.preparation?.prepared) ? 1 : 0;
                  if (ap !== bp) return bp - ap;
                  const al = Number(a.system?.level ?? 0);
                  const bl = Number(b.system?.level ?? 0);
                  return al - bl;
                });
              if (spellItems.length > 0) {
                const item = spellItems[0];
                const firstActivity = listItemActivities(item)[0] || null;
                return {
                  ok: true,
                  item,
                  preferredActivityId: firstActivity ? String(firstActivity.id || "") : null,
                  preferredActivityName: firstActivity?.name || null,
                  autoResolved: "generic-spell",
                };
              }
            }

            return { ok: false, error: "Action not found." };
          }

          matches.sort((a, b) => b.score - a.score);
          const best = matches[0];
          const tied = matches.filter((m) => m.score === best.score);
          if (tied.length > 1 && best.score < 10_000) {
            if (isGenericAttack || isGenericSpell) {
              let pool = tied;
              if (isGenericAttack) {
                const weaponsOnly = pool.filter((m) => String(m.item?.type || "").toLowerCase() === "weapon");
                if (weaponsOnly.length > 0) pool = weaponsOnly;
              }
              if (isGenericSpell) {
                const spellsOnly = pool.filter((m) => String(m.item?.type || "").toLowerCase() === "spell");
                if (spellsOnly.length > 0) pool = spellsOnly;
              }

              pool.sort((a, b) => {
                const ae = equippedScore(a.item);
                const be = equippedScore(b.item);
                if (ae !== be) return be - ae;
                const ar = inRangeScore(a.item, targetDistanceFt);
                const br = inRangeScore(b.item, targetDistanceFt);
                if (ar !== br) return br - ar;
                const aRange = Number(itemRangeSpec(a.item).maxFt || 0);
                const bRange = Number(itemRangeSpec(b.item).maxFt || 0);
                if (aRange !== bRange) return bRange - aRange;
                return String(a.item?.name || "").localeCompare(String(b.item?.name || ""), "ko");
              });
              const picked = pool[0] || best;
              return {
                ok: true,
                item: picked.item,
                preferredActivityId: picked.preferredActivityId || null,
                preferredActivityName: picked.preferredActivityName || null,
                autoResolved: isGenericAttack ? "generic-attack" : "generic-spell",
              };
            }

            return {
              ok: false,
              error: "Multiple actions matched this name. Please use a more specific action name.",
              candidates: tied.slice(0, 8).map((m) => summarizeActionItem(m.item)),
            };
          }

          return {
            ok: true,
            item: best.item,
            preferredActivityId: best.preferredActivityId || null,
            preferredActivityName: best.preferredActivityName || null,
            autoResolved: null,
          };
        }

        const actionName = String(rawActionName || "").trim();
        if (!actionName) {
          return { ok: false, error: "Action name is missing." };
        }

        const autoApproachEnabled = Boolean(autoApproach);

        let actor = null;
        let actorScene = null;
        let actorToken = null;

        if (mode === "token") {
          const tokenResolved = findTokenByRef(tokenRef);
          if (!tokenResolved.ok) {
            return {
              ok: false,
              error: tokenResolved.error,
              candidates: tokenResolved.candidates || [],
            };
          }
          actorScene = tokenResolved.scene;
          actorToken = tokenResolved.token;
          actor = actorToken.actor || game.actors.get(actorToken.actorId) || null;
        } else {
          actor = findActorBySelector();
          const tokenInfo = findTokenForActor(actor);
          actorScene = tokenInfo.scene;
          actorToken = tokenInfo.token;
        }

        if (!actor) {
          return { ok: false, error: "Actor not found for action execution." };
        }

        if (actorScene && (!canvas.scene || canvas.scene.id !== actorScene.id)) {
          await actorScene.view();
          await new Promise((resolve) => setTimeout(resolve, 250));
        }

        let actorPlaceable = null;
        if (actorToken) {
          actorPlaceable = canvas.tokens.placeables.find((token) => token.document.id === actorToken.id);
          if (actorPlaceable?.control) {
            actorPlaceable.control({ releaseOthers: true });
          }
        }

        let resolvedTarget = null;
        let targetPlaceable = null;
        let targetDistanceFt = null;
        if (targetTokenRef && String(targetTokenRef).trim()) {
          const targetResult = findTokenByRef(targetTokenRef, {
            preferSceneId: actorScene?.id || canvas.scene?.id || null,
            originToken: actorToken || null,
            originScene: actorScene || null,
          });
          if (!targetResult.ok) {
            return {
              ok: false,
              error: `Target resolution failed: ${targetResult.error}`,
              candidates: targetResult.candidates || [],
            };
          }

          if (actorScene && targetResult.scene.id !== actorScene.id) {
            return {
              ok: false,
              error: `Target token is in a different scene (${targetResult.scene.name}) than actor token (${actorScene.name}).`,
            };
          }

          const eligibility = validateTargetEligibility({
            actorScene,
            actorToken,
            targetToken: targetResult.token,
          });
          if (!eligibility.ok) {
            return {
              ok: false,
              error: eligibility.error,
              errorCode: eligibility.errorCode || "TARGET_INVALID",
            };
          }

          resolvedTarget = targetResult;
          if (!canvas.scene || canvas.scene.id !== targetResult.scene.id) {
            await targetResult.scene.view();
            await new Promise((resolve) => setTimeout(resolve, 250));
          }

          targetPlaceable = canvas.tokens.placeables.find(
            (token) => token.document.id === targetResult.token.id
          );
          if (targetPlaceable?.setTarget) {
            targetPlaceable.setTarget(true, { releaseOthers: true, user: game.user });
            if (typeof game.user?.updateTokenTargets === "function") {
              game.user.updateTokenTargets([targetResult.token.id]);
            }
          }

          if (actorToken && actorScene) {
            try {
              targetDistanceFt = distanceFtBetweenTokens(actorToken, targetResult.token, actorScene);
            } catch {
              targetDistanceFt = null;
            }
          }
        }

        const actionResolved = findActionItem(actor, actionName, { targetDistanceFt });
        if (!actionResolved.ok) {
          return {
            ok: false,
            error: actionResolved.error,
            candidates:
              actionResolved.candidates ||
              listActionItems(actor)
                .slice(0, 12)
                .map((item) => summarizeActionItem(item)),
          };
        }

        const item = actionResolved.item;
        const spellAvailability = getSpellCastAvailability(item, actor);
        if (!spellAvailability.ok) {
          return {
            ok: false,
            error: `No available spell slot for ${item.name}.`,
            detail: `required=Lv${spellAvailability.level} ${spellAvailability.slotKey}=${spellAvailability.normalValue}/${spellAvailability.normalMax} pact=${spellAvailability.pactValue}/${spellAvailability.pactMax} (level ${spellAvailability.pactLevel})`,
            errorCode: "NO_SPELL_SLOT",
            spellSlot: spellAvailability,
            action: summarizeActionItem(item),
          };
        }

        const orderedActivitiesPreview = listItemActivities(item);
        const templateFromActivity = orderedActivitiesPreview
          .map((activity) => activity?.target?.template)
          .find((template) => Boolean(template?.type));
        const templateFromItem = item?.system?.target?.template;
        const templateSpec = templateFromActivity?.type ? templateFromActivity : templateFromItem;
        const templateType = String(templateSpec?.type || "")
          .trim()
          .toLowerCase();
        const templateSizeFt = Math.max(0, Number(templateSpec?.size ?? 0) || 0);
        const hasPromptedTemplate =
          Boolean(templateType) &&
          (Boolean(item?.system?.target?.prompt) ||
            orderedActivitiesPreview.some(
              (activity) =>
                Boolean(activity?.target?.template?.type) &&
                (activity?.target?.prompt !== false)
            ));
        const itemRangeUnits = String(item?.system?.range?.units || "")
          .trim()
          .toLowerCase();
        const preferActorCenterForTemplate =
          hasPromptedTemplate &&
          !resolvedTarget &&
          (itemRangeUnits === "self" || itemRangeUnits === "spec");

        let approach = null;

        async function approachActorToTargetRange(desiredRangeFt) {
          if (!actorPlaceable?.center || !targetPlaceable?.center) {
            return { ok: false, reason: "no-placeable" };
          }

          const gridDistance = Number(canvas.scene?.grid?.distance ?? actorScene?.grid?.distance ?? 5) || 5;
          const gridSizePx = Number(canvas.grid?.size ?? actorScene?.grid?.size ?? 100) || 100;
          const beforeDistanceFt = distanceFtBetweenCenters(
            actorPlaceable.center,
            targetPlaceable.center,
            gridSizePx,
            gridDistance
          );
          if (!Number.isFinite(beforeDistanceFt)) {
            return { ok: false, reason: "distance-unknown" };
          }
          if (beforeDistanceFt <= desiredRangeFt + 0.1) {
            return {
              ok: true,
              moved: false,
              steps: 0,
              xSteps: 0,
              ySteps: 0,
              xDir: "",
              yDir: "",
              costFt: 0,
              beforeDistanceFt,
              afterDistanceFt: beforeDistanceFt,
              desiredRangeFt,
            };
          }

          const movement = actor?.system?.attributes?.movement ?? {};
          const walkSpeedFt =
            Number(movement.walk ?? movement.land ?? movement.fly ?? movement.swim ?? movement.burrow ?? 30) || 30;

          const tokenWidthPx = Number(actorPlaceable.document.width ?? 1) * gridSizePx;
          const tokenHeightPx = Number(actorPlaceable.document.height ?? 1) * gridSizePx;
          const startX = Number(actorPlaceable.document.x || 0);
          const startY = Number(actorPlaceable.document.y || 0);
          const startCenter = actorPlaceable.center;
          const targetCenter = targetPlaceable.center;

          const dxCells = Math.round((Number(targetCenter.x) - Number(startCenter.x)) / gridSizePx);
          const dyCells = Math.round((Number(targetCenter.y) - Number(startCenter.y)) / gridSizePx);
          if (dxCells === 0 && dyCells === 0) {
            return {
              ok: true,
              moved: false,
              steps: 0,
              xSteps: 0,
              ySteps: 0,
              xDir: "",
              yDir: "",
              costFt: 0,
              beforeDistanceFt,
              afterDistanceFt: beforeDistanceFt,
              desiredRangeFt,
              walkSpeedFt,
            };
          }

          const sx = dxCells === 0 ? 0 : dxCells > 0 ? 1 : -1;
          const sy = dyCells === 0 ? 0 : dyCells > 0 ? 1 : -1;
          const xStepsTotal = Math.abs(dxCells);
          const yStepsTotal = Math.abs(dyCells);
          const xDir = sx > 0 ? "E" : sx < 0 ? "W" : "";
          const yDir = sy > 0 ? "S" : sy < 0 ? "N" : "";

          const vectors = [];
          // Prefer orthogonal movement (x then y). Diagonal directions are intentionally avoided because
          // they are harder to reason about in Discord text commands and can be less accurate.
          for (let i = 0; i < xStepsTotal; i += 1) vectors.push([sx, 0]);
          for (let i = 0; i < yStepsTotal; i += 1) vectors.push([0, sy]);

          function centerAt(x, y) {
            return {
              x: Number(x) + tokenWidthPx / 2,
              y: Number(y) + tokenHeightPx / 2,
            };
          }

          let neededSteps = 0;
          let testX = startX;
          let testY = startY;
          for (let i = 0; i < vectors.length; i += 1) {
            testX += vectors[i][0] * gridSizePx;
            testY += vectors[i][1] * gridSizePx;
            const testDistanceFt = distanceFtBetweenCenters(centerAt(testX, testY), targetCenter, gridSizePx, gridDistance);
            if (testDistanceFt <= desiredRangeFt + 0.1) {
              neededSteps = i + 1;
              break;
            }
          }
          if (neededSteps === 0) {
            neededSteps = vectors.length;
          }

          function measurePrefix(stepCount) {
            let x = startX;
            let y = startY;
            const points = [startCenter];
            for (let i = 0; i < stepCount; i += 1) {
              x += vectors[i][0] * gridSizePx;
              y += vectors[i][1] * gridSizePx;
              points.push(centerAt(x, y));
            }
            const measured = canvas.grid.measurePath(points);
            const distanceFt = Number(measured?.distance ?? measured?.cost ?? stepCount * gridDistance);
            return { stepCount, x, y, distanceFt };
          }

          let current = measurePrefix(neededSteps);
          while (current.stepCount > 0 && current.distanceFt > walkSpeedFt) {
            current = measurePrefix(current.stepCount - 1);
          }

          if (current.stepCount <= 0) {
            return {
              ok: false,
              reason: "no-move-budget",
              xDir,
              yDir,
              beforeDistanceFt,
              desiredRangeFt,
              walkSpeedFt,
            };
          }

          const xStepsUsed = Math.min(current.stepCount, xStepsTotal);
          const yStepsUsed = Math.max(0, current.stepCount - xStepsTotal);

          // Execute movement in at most two axis-aligned updates: X then Y.
          if (xStepsUsed > 0) {
            const midX = startX + sx * xStepsUsed * gridSizePx;
            await actorPlaceable.document.update({ x: midX, y: startY }, { animate: true });
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          if (yStepsUsed > 0) {
            const midX = startX + sx * xStepsUsed * gridSizePx;
            const finalY = startY + sy * yStepsUsed * gridSizePx;
            await actorPlaceable.document.update({ x: midX, y: finalY }, { animate: true });
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          if (xStepsUsed === 0 && yStepsUsed === 0) {
            await actorPlaceable.document.update({ x: current.x, y: current.y }, { animate: true });
            await new Promise((resolve) => setTimeout(resolve, 200));
          }

          const afterDistanceFt = distanceFtBetweenCenters(centerAt(current.x, current.y), targetCenter, gridSizePx, gridDistance);
          return {
            ok: true,
            moved: true,
            steps: current.stepCount,
            xSteps: xStepsUsed,
            ySteps: yStepsUsed,
            xDir,
            yDir,
            costFt: Number(current.distanceFt.toFixed(2)),
            walkSpeedFt,
            beforeDistanceFt: Number(beforeDistanceFt.toFixed(1)),
            afterDistanceFt: Number(afterDistanceFt.toFixed(1)),
            desiredRangeFt,
          };
        }

        if (autoApproachEnabled && resolvedTarget && actorPlaceable?.center && targetPlaceable?.center) {
          const rangeSpec = itemRangeSpec(item);
          const maxRangeFt = Number(rangeSpec.maxFt);
          const beforeDistanceFt = distanceFtBetweenCenters(
            actorPlaceable.center,
            targetPlaceable.center,
            Number(canvas.grid?.size ?? 100) || 100,
            Number(canvas.scene?.grid?.distance ?? 5) || 5
          );

          if (Number.isFinite(maxRangeFt) && maxRangeFt > 0) {
            const approachResult = await approachActorToTargetRange(maxRangeFt);
            approach = {
              ...approachResult,
              units: rangeSpec.units || "ft",
              rangeFt: maxRangeFt,
              beforeDistanceFt: Number.isFinite(beforeDistanceFt) ? Number(beforeDistanceFt.toFixed(1)) : null,
            };

            if (approachResult.ok && approachResult.moved) {
              try {
                targetPlaceable.setTarget?.(true, { releaseOthers: true, user: game.user });
                game.user?.updateTokenTargets?.([resolvedTarget.token.id]);
              } catch {
                // ignore retarget failures
              }
            }

            if (!approachResult.ok) {
              return {
                ok: false,
                error: "대상 사거리까지 접근에 실패했습니다.",
                detail: `range=${maxRangeFt}ft dist=${Number.isFinite(beforeDistanceFt) ? beforeDistanceFt.toFixed(1) : "?"}ft reason=${approachResult.reason || "unknown"}`,
                approach,
                action: summarizeActionItem(item),
              };
            }

            if (
              approachResult.ok &&
              Number.isFinite(approachResult.afterDistanceFt) &&
              approachResult.afterDistanceFt > maxRangeFt + 0.1
            ) {
              return {
                ok: false,
                error: "대상이 너무 멀어 이번 턴 이동으로는 사거리 안에 들어갈 수 없습니다.",
                detail: `range=${maxRangeFt}ft dist=${approachResult.afterDistanceFt}ft walk=${approachResult.walkSpeedFt || "?"}ft`,
                approach,
                action: summarizeActionItem(item),
              };
            }
          } else {
            approach = {
              ok: true,
              moved: false,
              skipped: true,
              reason: "no-range",
              units: rangeSpec.units || "",
              rangeFt: null,
              beforeDistanceFt: Number.isFinite(beforeDistanceFt) ? Number(beforeDistanceFt.toFixed(1)) : null,
            };
          }
        }

        function selectSelfCenteredTemplateTargets() {
          if (!preferActorCenterForTemplate || !actorToken?.id || !templateType || templateSizeFt <= 0) return;

          const actorPlaceable = canvas.tokens.placeables.find((token) => token.document.id === actorToken.id);
          if (!actorPlaceable?.center) return;

          const includeSelf =
            String(item?.system?.target?.affects?.type || "").toLowerCase() === "self" ||
            orderedActivitiesPreview.some(
              (activity) => String(activity?.target?.affects?.type || "").toLowerCase() === "self"
            );

          const gridDistance = Number(canvas.scene?.grid?.distance ?? 5) || 5;
          const gridSizePx = Number(canvas.grid?.size ?? 100) || 100;
          const halfSize = templateSizeFt / 2;

          for (const oldTarget of Array.from(game.user?.targets || [])) {
            if (oldTarget?.setTarget) {
              oldTarget.setTarget(false, { releaseOthers: false, user: game.user });
            }
          }

          const selected = [];
          for (const candidate of canvas.tokens.placeables) {
            const doc = candidate?.document;
            if (!doc) continue;
            if (!includeSelf && doc.id === actorToken.id) continue;

            const dxFt = ((Number(candidate.center?.x || 0) - Number(actorPlaceable.center.x)) / gridSizePx) * gridDistance;
            const dyFt = ((Number(candidate.center?.y || 0) - Number(actorPlaceable.center.y)) / gridSizePx) * gridDistance;
            const radialFt = Math.hypot(dxFt, dyFt);

            let hit = false;
            if (templateType === "cube" || templateType === "square") {
              hit = Math.abs(dxFt) <= halfSize + 0.01 && Math.abs(dyFt) <= halfSize + 0.01;
            } else if (templateType === "sphere" || templateType === "circle") {
              hit = radialFt <= templateSizeFt + 0.01;
            } else {
              hit = radialFt <= Math.max(templateSizeFt, 5) + 0.01;
            }

            if (!hit) continue;
            candidate.setTarget?.(true, { releaseOthers: false, user: game.user });
            selected.push(doc.id);
          }

          game.user?.updateTokenTargets?.(selected);
        }

        selectSelfCenteredTemplateTargets();

        let targetUuids =
          resolvedTarget?.token?.uuid && String(resolvedTarget.token.uuid).trim()
            ? [String(resolvedTarget.token.uuid).trim()]
            : [];
        if (!targetUuids.length) {
          targetUuids = Array.from(game.user?.targets || [])
            .map((target) => {
              const document = target?.document || target;
              return String(document?.uuid || "").trim();
            })
            .filter(Boolean);
        }
        const targetTokens = new Set(Array.from(game.user?.targets || []).filter(Boolean));
        const targetTokenDocs = new Set(
          Array.from(targetTokens)
            .map((target) => target?.document || target)
            .filter(Boolean)
        );
        function messageSignature(message) {
          const html = String(message?.content || "");
          const isRoll = Boolean(message?.isRoll);
          const rollCount = Array.isArray(message?.rolls) ? message.rolls.length : 0;
          const flags = message?.flags || {};
          const hasMidiWorkflow = Boolean(flags?.["midi-qol"] || flags?.midiqol);
          const hasDnd5eCard = Boolean(flags?.dnd5e);
          const timestamp = Number(message?.timestamp || 0);
          return `${html}::roll=${isRoll ? 1 : 0}:${rollCount}::midi=${hasMidiWorkflow ? 1 : 0}::dnd5e=${
            hasDnd5eCard ? 1 : 0
          }::ts=${timestamp}`;
        }

        const beforeMessageState = new Map(
          (Array.isArray(game.messages?.contents) ? game.messages.contents : [])
            .map((message) => [String(message?.id || ""), messageSignature(message)])
            .filter((entry) => Boolean(entry[0]))
        );
        const attempts = [];
        const activities = listItemActivities(item);
        const orderedActivities = [...activities].sort((a, b) => {
          if (!actionResolved.preferredActivityId) return 0;
          const aHit = String(a?.id || "") === actionResolved.preferredActivityId ? 1 : 0;
          const bHit = String(b?.id || "") === actionResolved.preferredActivityId ? 1 : 0;
          return bHit - aHit;
        });

        function summarizeMessage(message) {
          const html = String(message?.content || "");
          const plain = toPlainText(html) || "(no content)";
          const flags = message?.flags || {};
          const hasMidiWorkflow = Boolean(flags?.["midi-qol"] || flags?.midiqol);
          const hasPlaceTemplateAction = /data-action\s*=\s*["']placeTemplate["']/i.test(html);
          return {
            id: String(message?.id || ""),
            speaker: message?.speaker?.alias || message?.alias || message?.user?.name || actor.name,
            content: plain,
            isRoll: Boolean(message?.isRoll),
            timestamp: Number(message?.timestamp || Date.now()),
            hasMidiWorkflow,
            hasDnd5eCard: Boolean(flags?.dnd5e),
            hasPlaceTemplateAction,
          };
        }

        function isNoiseMessage(message) {
          const text = String(message?.content || "")
            .replace(/\s+/g, " ")
            .trim();
          if (!text) return false;
          return /Welcome to Plutonium/i.test(text);
        }

        async function collectChangedMessages(waitMs = 900) {
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          const changed = [];
          const messages = Array.isArray(game.messages?.contents) ? game.messages.contents : [];
          for (const message of messages) {
            const id = String(message?.id || "");
            if (!id) continue;
            const signature = messageSignature(message);
            const previous = beforeMessageState.get(id);
            if (previous === undefined || previous !== signature) {
              beforeMessageState.set(id, signature);
              changed.push(summarizeMessage(message));
            }
          }
          return changed
            .filter((message) => !isNoiseMessage(message))
            .slice(-10);
        }

        function hasResolutionSignals(messages = []) {
          for (const message of messages) {
            if (!message) continue;
            if (message.hasMidiWorkflow || message.isRoll) return true;
            const content = String(message.content || "");
            if (!content) continue;
            if (/HP Updated/i.test(content)) return true;
            if (/Base Damage/i.test(content)) return true;
            if (/\bSaving Throw\b/i.test(content)) return true;
            if (/\bTargets?\b/i.test(content) && /\bAttack\b/i.test(content)) return true;
          }
          return false;
        }

        function hasTemplateAction(messages = []) {
          return messages.some((message) => Boolean(message?.hasPlaceTemplateAction));
        }

        function collectRecentActionMessages({ sinceTsMs = 0, maxCount = 20 } = {}) {
          const all = Array.isArray(game.messages?.contents) ? game.messages.contents : [];
          const actorIdText = String(actor?.id || "");
          const itemIdText = String(item?.id || "");
          const actorUuidText = actorIdText ? `Actor.${actorIdText}` : "";
          const itemUuidText = actorUuidText && itemIdText ? `${actorUuidText}.Item.${itemIdText}` : "";
          const recent = [];

          for (const message of [...all].reverse()) {
            if (recent.length >= maxCount) break;

            const timestamp = Number(message?.timestamp || 0);
            if (sinceTsMs > 0 && Number.isFinite(timestamp) && timestamp + 2500 < sinceTsMs) break;

            const speakerActorId = String(message?.speaker?.actor || "");
            const flags = message?.flags || {};
            const html = String(message?.content || "");
            const flagItemId = String(flags?.dnd5e?.itemId || flags?.["midi-qol"]?.itemId || flags?.midiqol?.itemId || "");

            const bySpeaker = Boolean(actorIdText) && speakerActorId === actorIdText;
            const byItemIdInHtml =
              Boolean(itemIdText) &&
              (html.includes(`data-item-id="${itemIdText}"`) ||
                html.includes(`data-item-id='${itemIdText}'`) ||
                (itemUuidText && html.includes(itemUuidText)));
            const byItemFlag = Boolean(itemIdText) && flagItemId === itemIdText;

            if (!bySpeaker && !byItemIdInHtml && !byItemFlag) continue;

            const summary = summarizeMessage(message);
            if (isNoiseMessage(summary)) continue;
            recent.push(summary);
          }

          return recent.reverse();
        }

        function resolveTemplateCenter() {
          if (preferActorCenterForTemplate && actorToken?.id) {
            const actorPlaceable = canvas.tokens.placeables.find((token) => token.document.id === actorToken.id);
            if (actorPlaceable?.center) {
              return { x: Number(actorPlaceable.center.x), y: Number(actorPlaceable.center.y) };
            }
          }

          if (resolvedTarget?.token?.id) {
            const targetPlaceable = canvas.tokens.placeables.find(
              (token) => token.document.id === resolvedTarget.token.id
            );
            if (targetPlaceable?.center) {
              return { x: Number(targetPlaceable.center.x), y: Number(targetPlaceable.center.y) };
            }
          }

          const firstTarget = Array.from(game.user?.targets || [])[0];
          if (firstTarget?.center) {
            return { x: Number(firstTarget.center.x), y: Number(firstTarget.center.y) };
          }

          if (actorToken?.id) {
            const actorPlaceable = canvas.tokens.placeables.find((token) => token.document.id === actorToken.id);
            if (actorPlaceable?.center) {
              return { x: Number(actorPlaceable.center.x), y: Number(actorPlaceable.center.y) };
            }
          }

          return null;
        }

        function resolveTemplateDirection(center) {
          if (!center) return null;

          const targetCenter = (() => {
            if (resolvedTarget?.token?.id) {
              const targetPlaceable = canvas.tokens.placeables.find(
                (token) => token.document.id === resolvedTarget.token.id
              );
              if (targetPlaceable?.center) return targetPlaceable.center;
            }

            const firstTarget = Array.from(game.user?.targets || [])[0];
            if (firstTarget?.center) return firstTarget.center;
            return null;
          })();

          if (!targetCenter) return null;

          const dx = Number(targetCenter.x) - Number(center.x);
          const dy = Number(targetCenter.y) - Number(center.y);
          if (Math.hypot(dx, dy) < 1) return null;
          return (((Math.atan2(dy, dx) * 180) / Math.PI) + 360) % 360;
        }

        function buildUsageConfig({ includeTargetUuids = false } = {}) {
          const usage = {
            create: {
              message: true,
              measuredTemplate: hasPromptedTemplate,
            },
            midiOptions: {
              configureDialog: false,
              workflowOptions: {
                targetConfirmation: "none",
                fastForward: true,
                autoRollAttack: true,
                autoRollDamage: "always",
                autoFastDamage: true,
              },
            },
          };

          if (includeTargetUuids && targetUuids.length > 0) {
            usage.targetUuids = targetUuids;
          }

          if (!hasPromptedTemplate && targetTokens.size > 0) {
            usage.midiOptions.targetsToUse = targetTokens;
          } else if (!hasPromptedTemplate && targetTokenDocs.size > 0) {
            usage.midiOptions.targetsToUse = targetTokenDocs;
          }

          return usage;
        }
        async function runAttempt(attempt, timeoutMs = 15_000) {
          let timeoutHandle = null;
          const timeoutPromise = new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => reject(new Error(`attempt-timeout:${timeoutMs}ms`)), timeoutMs);
          });
          try {
            const result = await Promise.race([attempt.fn(), timeoutPromise]);
            return { ok: true, result };
          } catch (error) {
            const message = error?.message || String(error);
            if (String(message).startsWith("attempt-timeout:")) {
              return { ok: false, timedOut: true, error: message };
            }
            throw error;
          } finally {
            if (timeoutHandle) clearTimeout(timeoutHandle);
          }
        }

        function findTemplatePreview() {
          const containers = [canvas.templates?.preview, canvas.activeLayer?.preview].filter(Boolean);
          for (const container of containers) {
            const children = Array.isArray(container?.children) ? container.children : [];
            const preview = children.find((child) => Boolean(child?.document));
            if (preview?.document) {
              return { preview, container };
            }
          }
          return null;
        }

        async function waitForTemplatePreview(maxWaitMs = 1200, intervalMs = 120) {
          const startedAt = Date.now();
          let pending = findTemplatePreview();
          while (!pending && Date.now() - startedAt < maxWaitMs) {
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
            pending = findTemplatePreview();
          }
          return pending;
        }

        async function confirmTemplatePreviewAtCenter() {
          const pending = await waitForTemplatePreview();
          if (!pending) return { confirmed: false, reason: "no-preview" };

          const center = resolveTemplateCenter();
          if (!center) return { confirmed: false, reason: "no-center" };

          const beforeTemplateIds = new Set(
            (Array.isArray(canvas.scene?.templates?.contents) ? canvas.scene.templates.contents : [])
              .map((t) => String(t?.id || "").trim())
              .filter(Boolean)
          );

          let templateData = null;
          if (typeof pending.preview.document?.toObject === "function") {
            templateData = pending.preview.document.toObject();
          } else if (pending.preview.document?._source) {
            templateData = foundry?.utils?.deepClone
              ? foundry.utils.deepClone(pending.preview.document._source)
              : JSON.parse(JSON.stringify(pending.preview.document._source));
          }
          if (!templateData) return { confirmed: false, reason: "no-template-data" };

          const templateKind = String(templateData.t || templateData.type || "")
            .trim()
            .toLowerCase();
          const desiredDirection = resolveTemplateDirection(center);
          if (
            Number.isFinite(desiredDirection) &&
            (templateKind === "cone" || templateKind === "ray" || templateKind === "rect")
          ) {
            templateData.direction = Number(desiredDirection);
          }

          let x = Number(center.x);
          let y = Number(center.y);

          // Rect templates are anchored at a corner; convert desired center to origin.
          if (templateKind === "rect") {
            const directionDeg = Number(templateData.direction ?? 0);
            const distanceFt = Math.max(0, Number(templateData.distance ?? 0) || 0);
            if (distanceFt > 0) {
              const gridDistance = Number(canvas.scene?.grid?.distance ?? 5) || 5;
              const gridSizePx = Number(canvas.grid?.size ?? 100) || 100;
              const distancePx = (distanceFt / gridDistance) * gridSizePx;
              const halfDiagonal = distancePx / 2;
              const rad = (directionDeg * Math.PI) / 180;
              x -= Math.cos(rad) * halfDiagonal;
              y -= Math.sin(rad) * halfDiagonal;
            }
          }

          async function trySyntheticCanvasClick() {
            const view = canvas.app?.view;
            if (!view || typeof view.getBoundingClientRect !== "function") {
              return { ok: false, reason: "no-canvas-view" };
            }
            if (!canvas.stage || typeof canvas.stage.toGlobal !== "function") {
              return { ok: false, reason: "no-canvas-stage" };
            }

            let screen = null;
            try {
              screen = canvas.stage.toGlobal(new PIXI.Point(x, y));
            } catch {
              try {
                screen = canvas.stage.toGlobal({ x, y });
              } catch {
                screen = null;
              }
            }
            if (!screen || !Number.isFinite(screen.x) || !Number.isFinite(screen.y)) {
              return { ok: false, reason: "no-global-point" };
            }

            const rect = view.getBoundingClientRect();
            const clientX = rect.left + Number(screen.x);
            const clientY = rect.top + Number(screen.y);
            const common = { bubbles: true, cancelable: true, composed: true, clientX, clientY };
            const pointerCommon = {
              ...common,
              pointerId: 1,
              pointerType: "mouse",
              isPrimary: true,
            };

            const fire = (ev) => {
              try {
                view.dispatchEvent(ev);
              } catch {
                // ignore
              }
            };

            // Move then click at the desired location. Some workflows listen to pointer events,
            // others listen to mouse events; dispatch both.
            try {
              fire(new PointerEvent("pointermove", { ...pointerCommon, button: -1, buttons: 0 }));
            } catch {
              // ignore
            }
            try {
              fire(new MouseEvent("mousemove", { ...common, button: 0, buttons: 0 }));
            } catch {
              // ignore
            }
            try {
              fire(new PointerEvent("pointerdown", { ...pointerCommon, button: 0, buttons: 1 }));
            } catch {
              // ignore
            }
            try {
              fire(new MouseEvent("mousedown", { ...common, button: 0, buttons: 1 }));
            } catch {
              // ignore
            }
            try {
              fire(new PointerEvent("pointerup", { ...pointerCommon, button: 0, buttons: 0 }));
            } catch {
              // ignore
            }
            try {
              fire(new MouseEvent("mouseup", { ...common, button: 0, buttons: 0 }));
            } catch {
              // ignore
            }
            try {
              fire(new MouseEvent("click", { ...common, button: 0, buttons: 0 }));
            } catch {
              // ignore
            }

            // Wait for Foundry to commit the template + clear the preview.
            await new Promise((resolve) => setTimeout(resolve, 350));
            const startedAt = Date.now();
            while (findTemplatePreview() && Date.now() - startedAt < 1500) {
              await new Promise((resolve) => setTimeout(resolve, 120));
            }

            return { ok: true };
          }

          function cleanupPreview() {
            try {
              if (pending.preview?.destroy) pending.preview.destroy({ children: true });
            } catch {
              // ignore cleanup failures
            }
            try {
              if (pending.container?.removeChildren) {
                const removed = pending.container.removeChildren();
                for (const child of removed) {
                  try {
                    child.destroy({ children: true });
                  } catch {
                    // ignore cleanup failures
                  }
                }
              }
            } catch {
              // ignore cleanup failures
            }
          }

          // Prefer committing the preview via synthetic click (this usually resolves workflows waiting on placement).
          try {
            const previewDoc = pending.preview?.document;
            if (previewDoc) {
              const update = { x, y };
              if (
                Number.isFinite(desiredDirection) &&
                (templateKind === "cone" || templateKind === "ray" || templateKind === "rect")
              ) {
                update.direction = Number(desiredDirection);
              }
              if (typeof previewDoc.updateSource === "function") {
                previewDoc.updateSource(update);
              } else {
                Object.assign(previewDoc, update);
              }
              pending.preview.refresh?.();
            }
          } catch {
            // ignore preview mutation failures
          }

          const clickAttempt = await trySyntheticCanvasClick();
          const afterTemplates = Array.isArray(canvas.scene?.templates?.contents) ? canvas.scene.templates.contents : [];
          const newTemplate = afterTemplates.find((tpl) => {
            const id = String(tpl?.id || "").trim();
            return id && !beforeTemplateIds.has(id);
          });

          if (clickAttempt.ok && (newTemplate || !findTemplatePreview())) {
            cleanupPreview();
            return {
              confirmed: true,
              templateId: newTemplate ? String(newTemplate.id || "") : "",
              method: "synthetic-click",
            };
          }

          templateData.x = x;
          templateData.y = y;
          templateData.user = game.user?.id || templateData.user;

          try {
            const created = await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [templateData]);
            cleanupPreview();
            return {
              confirmed: true,
              templateId: Array.isArray(created) && created[0] ? String(created[0].id || "") : "",
              method: clickAttempt.ok ? `createEmbeddedDocuments (after ${clickAttempt.reason || "click"})` : "createEmbeddedDocuments",
            };
          } catch (error) {
            return {
              confirmed: false,
              reason: `template-confirm-failed: ${error?.message || String(error)}`,
            };
          }
        }

        function mergeMessages(base, extra) {
          const merged = [];
          const seen = new Set();
          for (const message of [...(Array.isArray(base) ? base : []), ...(Array.isArray(extra) ? extra : [])]) {
            const key = String(message?.id || "");
            if (!key || seen.has(key)) continue;
            seen.add(key);
            merged.push(message);
          }
          return merged;
        }

        function findTemplateActionMessageId(messages = []) {
          for (const entry of [...messages].reverse()) {
            const id = String(entry?.id || "").trim();
            if (!id) continue;
            const message = game.messages?.get?.(id);
            const html = String(message?.content || "");
            if (/data-action\s*=\s*["']placeTemplate["']/i.test(html)) {
              return id;
            }
          }
          return "";
        }

        async function triggerPlaceTemplateAction(messageId) {
          const id = String(messageId || "").trim();
          if (!id) return { ok: false, reason: "no-message-id" };
          const button = document.querySelector(
            `li.chat-message[data-message-id="${CSS.escape(id)}"] button[data-action="placeTemplate"]`
          );
          if (!button) return { ok: false, reason: "no-place-template-button" };
          try {
            button.click();
            await new Promise((resolve) => setTimeout(resolve, 450));
            return { ok: true };
          } catch (error) {
            return { ok: false, reason: error?.message || String(error) };
          }
        }

        function findRollActionMessageId(messages = []) {
          const wantedActorId = String(actor?.id || "");
          const entries = [...messages].reverse();

          function scan(ignoreActorFilter) {
            for (const entry of entries) {
              const id = String(entry?.id || "").trim();
              if (!id) continue;
              const message = game.messages?.get?.(id);
              if (!message) continue;
              const speakerActorId = String(message.speaker?.actor || "");
              if (!ignoreActorFilter && wantedActorId && speakerActorId && speakerActorId !== wantedActorId) continue;

              const html = String(message.content || "");
              if (/data-action\\s*=\\s*[\"'](attack|damage|save|rollAttack|rollDamage|rollSave)[\"']/i.test(html)) {
                return id;
              }
              if (Boolean(entry?.hasDnd5eCard)) {
                return id;
              }
            }
            return "";
          }

          return scan(false) || scan(true);
        }

        async function clickChatCardButton(messageId, { actions = [], textRe = null } = {}) {
          const id = String(messageId || "").trim();
          if (!id) return { ok: false, clicked: false, reason: "no-message-id" };
          const root = document.querySelector(`li.chat-message[data-message-id="${CSS.escape(id)}"]`);
          if (!root) return { ok: false, clicked: false, reason: "no-chat-element" };

          const buttons = Array.from(root.querySelectorAll("button")).filter((btn) => btn && !btn.disabled);
          const wanted = new Set((Array.isArray(actions) ? actions : []).map((a) => String(a || "").toLowerCase()));

          let candidate = null;
          if (wanted.size > 0) {
            candidate = buttons.find((btn) => {
              const raw = String(btn.getAttribute("data-action") || btn.dataset?.action || "").toLowerCase();
              return raw && wanted.has(raw);
            });
          }

          if (!candidate && textRe) {
            candidate = buttons.find((btn) => {
              const label = String(btn.textContent || btn.innerText || "").trim();
              return label && textRe.test(label);
            });
          }

          if (!candidate) return { ok: true, clicked: false, reason: "no-button-match" };

          try {
            candidate.click();
            await new Promise((resolve) => setTimeout(resolve, 450));
            return { ok: true, clicked: true, action: String(candidate.getAttribute("data-action") || "") };
          } catch (error) {
            return { ok: false, clicked: false, reason: error?.message || String(error) };
          }
        }

        async function resolveRollsForCardMessage(messageId, existingMessages = []) {
          let messages = Array.isArray(existingMessages) ? existingMessages : [];
          const steps = [
            { name: "attack", actions: ["attack", "rollattack", "rollAttack"], textRe: /attack|공격/i },
            { name: "save", actions: ["save", "rollsave", "rollSave"], textRe: /save|saving\\s*throw|내성/i },
            { name: "damage", actions: ["damage", "rolldamage", "rollDamage"], textRe: /damage|피해|dmg/i },
            { name: "roll", actions: ["roll"], textRe: /roll|굴림/i },
          ];

          const clicked = [];
          for (const step of steps) {
            const clickResult = await clickChatCardButton(messageId, step);
            if (!clickResult.ok) continue;
            if (!clickResult.clicked) continue;

            clicked.push(step.name);
            const more = await collectChangedMessages(900);
            messages = mergeMessages(messages, more);

            // If a template preview got spawned by a roll action, confirm it as well.
            const settled = await settleTemplateAndCollectMessages(messages);
            if (settled.confirmed) {
              messages = mergeMessages(settled.messages, await collectChangedMessages(900));
            }
          }

          return { ok: true, clicked, messages };
        }

        async function settleTemplateAndCollectMessages(existingMessages = []) {
          const templateResult = await confirmTemplatePreviewAtCenter();
          if (!templateResult.confirmed) {
            return {
              confirmed: false,
              reason: templateResult.reason,
              messages: Array.isArray(existingMessages) ? existingMessages : [],
            };
          }
          const templateMessages = await collectChangedMessages(900);
          return {
            confirmed: true,
            reason: "",
            templateId: templateResult.templateId || "",
            messages: mergeMessages(existingMessages, templateMessages),
          };
        }

        for (const activity of orderedActivities.slice(0, 6)) {
          const activityName = String(activity.name || activity.id || "activity");
          if (typeof activity.use === "function") {
            if (targetUuids.length > 0) {
              attempts.push({
                name: `activity-use-targeted:${activityName}`,
                fn: async () =>
                  activity.use(
                    buildUsageConfig({ includeTargetUuids: true }),
                    { configure: false, configureDialog: false },
                    { create: true, createMessage: true }
                  ),
              });
            }
            attempts.push({
              name: `activity-use-fast:${activityName}`,
              fn: async () =>
                activity.use(
                  buildUsageConfig({ includeTargetUuids: false }),
                  { configure: false, configureDialog: false },
                  { create: true, createMessage: true }
                ),
            });
            attempts.push({
              name: `activity-use-default:${activityName}`,
              fn: async () => activity.use(),
            });
          }
          if (typeof activity.roll === "function") {
            attempts.push({
              name: `activity-roll:${activityName}`,
              fn: async () => activity.roll({ configure: false, configureDialog: false }),
            });
          }
          if (typeof activity.rollAttack === "function") {
            attempts.push({
              name: `activity-rollAttack:${activityName}`,
              fn: async () => activity.rollAttack({ configure: false, configureDialog: false }),
            });
          }
          if (typeof activity.rollDamage === "function") {
            attempts.push({
              name: `activity-rollDamage:${activityName}`,
              fn: async () => activity.rollDamage({ configure: false, configureDialog: false }),
            });
          }
        }

        if (typeof item.use === "function") {
          if (targetUuids.length > 0) {
            attempts.push({
              name: "use-targeted",
              fn: async () => item.use(buildUsageConfig({ includeTargetUuids: true })),
            });
            attempts.push({
              name: "use-targeted-workflow",
              fn: async () => item.use(buildUsageConfig({ includeTargetUuids: true })),
            });
          }
          attempts.push({
            name: "use-fast",
            fn: async () => item.use(buildUsageConfig({ includeTargetUuids: false })),
          });
          attempts.push({
            name: "use-default",
            fn: async () => item.use(),
          });
        }

        if (typeof item.roll === "function") {
          attempts.push({
            name: "roll",
            fn: async () => item.roll({ configureDialog: false }),
          });
        }

        if (typeof item.rollAttack === "function") {
          attempts.push({
            name: "rollAttack",
            fn: async () => item.rollAttack({ configureDialog: false }),
          });
        }

        if (typeof item.rollDamage === "function") {
          attempts.push({
            name: "rollDamage",
            fn: async () => item.rollDamage({ configureDialog: false }),
          });
        }

        if (typeof item.displayCard === "function") {
          attempts.push({
            name: "displayCard",
            fn: async () => item.displayCard({ createMessage: true }),
          });
        }

        if (!attempts.length) {
          return {
            ok: false,
            error: "No executable action method was found for this item.",
            action: summarizeActionItem(item),
          };
        }

        const executionErrors = [];
        const requiresWorkflowResolution = Boolean(hasPromptedTemplate || targetUuids.length > 0);
        const actionStartedAt = Date.now();
        let methodUsed = "";
        let success = false;
        let producedMessages = [];
        let executedWithoutMessage = false;

        for (const attempt of attempts) {
          try {
            const run = await runAttempt(attempt);
            if (!run.ok && run.timedOut) {
              executionErrors.push(`${attempt.name}: ${run.error}`);
              continue;
            }
            const result = run.result;
            if (result === false) {
              executionErrors.push(`${attempt.name}: returned false`);
              continue;
            }
            const newMessages = await collectChangedMessages();
            const placeTemplateMessageId = findTemplateActionMessageId(newMessages);
            if (placeTemplateMessageId) {
              const triggerResult = await triggerPlaceTemplateAction(placeTemplateMessageId);
              if (!triggerResult.ok && triggerResult.reason !== "no-place-template-button") {
                executionErrors.push(`${attempt.name}: placeTemplate trigger failed (${triggerResult.reason})`);
              }
            }
            const templateSettled = await settleTemplateAndCollectMessages(newMessages);
            if (templateSettled.confirmed) {
              let postTemplateMessages = mergeMessages(
                templateSettled.messages,
                await collectChangedMessages(900)
              );
              producedMessages = postTemplateMessages;
              methodUsed = placeTemplateMessageId
                ? `${attempt.name}+placeTemplate+template-confirm`
                : `${attempt.name}+template-confirm`;
              if (!requiresWorkflowResolution || hasResolutionSignals(postTemplateMessages)) {
                success = true;
                break;
              }
              const rollMessageId = placeTemplateMessageId || findRollActionMessageId(postTemplateMessages);
              if (rollMessageId) {
                const rollResolved = await resolveRollsForCardMessage(rollMessageId, postTemplateMessages);
                postTemplateMessages = rollResolved.messages;
                producedMessages = postTemplateMessages;
                if (Array.isArray(rollResolved.clicked) && rollResolved.clicked.length > 0) {
                  methodUsed = `${methodUsed}+rollButtons(${rollResolved.clicked.join(",")})`;
                }
                if (!requiresWorkflowResolution || hasResolutionSignals(postTemplateMessages)) {
                  success = true;
                  break;
                }
              }

              executionErrors.push(`${attempt.name}: template placed but no resolved workflow message`);
              continue;
            }
            if (newMessages.length) {
              if (!requiresWorkflowResolution || hasResolutionSignals(newMessages)) {
                producedMessages = newMessages;
                methodUsed = attempt.name;
                success = true;
                break;
              }

              const rollMessageId = findRollActionMessageId(newMessages);
              if (rollMessageId) {
                const rollResolved = await resolveRollsForCardMessage(rollMessageId, newMessages);
                if (Array.isArray(rollResolved.clicked) && rollResolved.clicked.length > 0) {
                  const rolledMessages = rollResolved.messages;
                  if (!requiresWorkflowResolution || hasResolutionSignals(rolledMessages)) {
                    producedMessages = rolledMessages;
                    methodUsed = `${attempt.name}+rollButtons(${rollResolved.clicked.join(",")})`;
                    success = true;
                    break;
                  }
                }
              }

              if (hasTemplateAction(newMessages)) {
                executionErrors.push(`${attempt.name}: template action card detected but workflow did not resolve`);
              } else {
                executionErrors.push(`${attempt.name}: unresolved card message without roll/save result`);
              }
            }

            if (!newMessages.length) {
              executedWithoutMessage = true;
            }
            if (templateSettled.reason !== "no-preview") {
              executionErrors.push(`${attempt.name}: ${templateSettled.reason}`);
            }

            if (typeof item.displayCard === "function") {
              try {
                await item.displayCard({ createMessage: true });
              } catch (displayError) {
                executionErrors.push(
                  `${attempt.name}: no chat message generated; displayCard failed: ${
                    displayError?.message || String(displayError)
                  }`
                );
                continue;
              }

              const fallbackMessages = await collectChangedMessages();
              const fallbackTemplateMessageId = findTemplateActionMessageId(fallbackMessages);
              if (fallbackTemplateMessageId) {
                const fallbackTriggerResult = await triggerPlaceTemplateAction(fallbackTemplateMessageId);
                if (!fallbackTriggerResult.ok && fallbackTriggerResult.reason !== "no-place-template-button") {
                  executionErrors.push(
                    `${attempt.name}: placeTemplate trigger failed (${fallbackTriggerResult.reason})`
                  );
                }
              }
              const fallbackTemplateSettled = await settleTemplateAndCollectMessages(fallbackMessages);
              if (fallbackTemplateSettled.confirmed) {
                let postFallbackTemplateMessages = mergeMessages(
                  fallbackTemplateSettled.messages,
                  await collectChangedMessages(900)
                );
                producedMessages = postFallbackTemplateMessages;
                methodUsed = fallbackTemplateMessageId
                  ? `${attempt.name}+displayCard+placeTemplate+template-confirm`
                  : `${attempt.name}+displayCard+template-confirm`;
                if (!requiresWorkflowResolution || hasResolutionSignals(postFallbackTemplateMessages)) {
                  success = true;
                  break;
                }
                const rollMessageId =
                  fallbackTemplateMessageId || findRollActionMessageId(postFallbackTemplateMessages);
                if (rollMessageId) {
                  const rollResolved = await resolveRollsForCardMessage(
                    rollMessageId,
                    postFallbackTemplateMessages
                  );
                  postFallbackTemplateMessages = rollResolved.messages;
                  producedMessages = postFallbackTemplateMessages;
                  if (Array.isArray(rollResolved.clicked) && rollResolved.clicked.length > 0) {
                    methodUsed = `${methodUsed}+rollButtons(${rollResolved.clicked.join(",")})`;
                  }
                  if (!requiresWorkflowResolution || hasResolutionSignals(postFallbackTemplateMessages)) {
                    success = true;
                    break;
                  }
                }
                executionErrors.push(`${attempt.name}: displayCard template placed but no workflow resolution`);
                continue;
              }
              if (fallbackMessages.length) {
                if (!requiresWorkflowResolution || hasResolutionSignals(fallbackMessages)) {
                  producedMessages = fallbackMessages;
                  methodUsed = `${attempt.name}+displayCard`;
                  success = true;
                  break;
                }
                const rollMessageId = findRollActionMessageId(fallbackMessages);
                if (rollMessageId) {
                  const rollResolved = await resolveRollsForCardMessage(rollMessageId, fallbackMessages);
                  if (Array.isArray(rollResolved.clicked) && rollResolved.clicked.length > 0) {
                    const rolledMessages = rollResolved.messages;
                    if (!requiresWorkflowResolution || hasResolutionSignals(rolledMessages)) {
                      producedMessages = rolledMessages;
                      methodUsed = `${attempt.name}+displayCard+rollButtons(${rollResolved.clicked.join(",")})`;
                      success = true;
                      break;
                    }
                  }
                }
                executionErrors.push(`${attempt.name}: displayCard produced unresolved message only`);
                continue;
              }
              if (fallbackTemplateSettled.reason !== "no-preview") {
                executionErrors.push(`${attempt.name}: ${fallbackTemplateSettled.reason}`);
              }
            }

            executionErrors.push(`${attempt.name}: no chat message generated`);
            continue;
          } catch (error) {
            executionErrors.push(`${attempt.name}: ${error?.message || String(error)}`);
          }
        }

        if (!success) {
          const recentActionMessages = collectRecentActionMessages({
            sinceTsMs: actionStartedAt - 1500,
            maxCount: 24,
          });
          const hasRecentResolution = hasResolutionSignals(recentActionMessages);
          const unresolvedDisplayCardOnly =
            executionErrors.length > 0 &&
            executionErrors.every((entry) => {
              const text = String(entry || "").toLowerCase();
              return (
                text.includes("displaycard produced unresolved message only") ||
                text.includes("unresolved card message without roll/save result") ||
                text.includes("no chat message generated")
              );
            });

          if (hasRecentResolution) {
            success = true;
            producedMessages = recentActionMessages;
            methodUsed = "post-verify-chat-resolution";
          } else if (recentActionMessages.length > 0 && unresolvedDisplayCardOnly) {
            // Some Midi workflows leave a completed card but do not emit explicit roll/save follow-up messages.
            success = true;
            producedMessages = recentActionMessages;
            methodUsed = "post-verify-chat-card";
          }
        }

        if (!success) {
          return {
            ok: false,
            error: "Action execution failed.",
            detail: executionErrors.slice(0, 10).join(" | "),
            executedWithoutMessage,
            approach,
            action: summarizeActionItem(item),
            messages: producedMessages,
          };
        }

        return {
          ok: true,
          actor: {
            id: actor.id,
            name: actor.name,
          },
          token: actorToken
            ? {
                id: actorToken.id,
                name: actorToken.name || actorToken.id,
                sceneId: actorScene?.id || "",
                sceneName: actorScene?.name || "",
              }
            : null,
          action: summarizeActionItem(item),
          preferredActivityName: actionResolved.preferredActivityName || null,
          autoResolved: actionResolved.autoResolved || null,
          target: resolvedTarget
            ? {
                id: resolvedTarget.token.id,
                name: resolvedTarget.token.name || resolvedTarget.token.id,
                sceneId: resolvedTarget.scene.id,
                sceneName: resolvedTarget.scene.name,
                autoResolved: resolvedTarget.autoResolved || null,
              }
            : null,
          approach,
          methodUsed,
          messages: producedMessages,
        };
      },
      request
    );
  }
  _actorSelector() {
    return {
      actorId: this.config.foundry.actorId,
      actorName: this.config.foundry.actorName,
    };
  }

  async _waitForGameReady() {
    if (!this.page) {
      throw new Error("FVTT not connected");
    }
    await this.page.waitForFunction(() => Boolean(globalThis.game?.ready), {
      timeout: this.config.foundry.loginTimeoutMs,
    });
  }

  async _diagnosePage() {
    return this.page.evaluate(() => {
      const text = (document.body?.innerText || "").trim().slice(0, 1200);
      const qCount = (sel) => document.querySelectorAll(sel).length;
      return {
        href: location.href,
        title: document.title,
        bodySample: text,
        gameExists: Boolean(globalThis.game),
        gameReady: Boolean(globalThis.game?.ready),
        canvasReady: Boolean(globalThis.canvas?.ready),
        hasUserSelect: qCount('select[name=\"userid\"]'),
        hasPassInput: qCount('input[name=\"password\"]'),
        hasJoinBtn: qCount('button[name=\"join\"]'),
      };
    });
  }

  async _loginIfNeeded() {
    const readyNow = await this.page.evaluate(() => Boolean(globalThis.game?.ready));
    if (readyNow) return;

    // Foundry renders the join form asynchronously after DOMContentLoaded.
    await this.page
      .waitForFunction(
        () =>
          Boolean(globalThis.game?.ready) ||
          Boolean(
            document.querySelector('select[name="userid"]') ||
              document.querySelector('input[name="userid"], input[name="username"]') ||
              document.querySelector('input[name="password"]') ||
              document.querySelector('button[name="join"], #join-game-form button[type="submit"]')
          ),
        { timeout: 15_000 }
      )
      .catch(() => {});

    const readyAfterWait = await this.page.evaluate(() => Boolean(globalThis.game?.ready));
    if (readyAfterWait) return;

    const userInput = this.page.locator('input[name="userid"], input[name="username"]');
    const userSelect = this.page.locator('select[name="userid"]');
    const passInput = this.page.locator('input[name="password"]');
    const joinSubmit = this.page.locator('button[name="join"], #join-game-form button[type="submit"]');

    const hasJoinControls =
      (await userInput.count()) > 0 ||
      (await userSelect.count()) > 0 ||
      (await passInput.count()) > 0 ||
      (await joinSubmit.count()) > 0;

    // Already on /game with an existing session: no join form to submit.
    if (!hasJoinControls) return;

    if ((await userInput.count()) > 0) {
      await userInput.first().fill(this.config.foundry.username);
    } else if ((await userSelect.count()) > 0) {
      const selected = await this.page.evaluate(({ username }) => {
        const select = document.querySelector('select[name="userid"]');
        if (!select) return { ok: false, reason: "no-select", options: [] };

        const norm = (value) =>
          String(value || "")
            .trim()
            .toLowerCase()
            .replace(/\s+/g, "");

        const wanted = String(username || "").trim();
        const wantedNorm = norm(wanted);
        const options = Array.from(select.options || []);

        const byExactText = options.find((opt) => String(opt.text || "").trim() === wanted);
        const byNormText = options.find((opt) => norm(opt.text) === wantedNorm);
        const byNormValue = options.find((opt) => norm(opt.value) === wantedNorm);
        const hit = byExactText || byNormText || byNormValue || null;

        if (!hit || hit.value === undefined || hit.value === null) {
          return {
            ok: false,
            reason: "not-found",
            options: options.map((opt) => ({
              text: String(opt.text || "").trim(),
              value: String(opt.value || ""),
              disabled: Boolean(opt.disabled),
            })),
          };
        }

        // Foundry marks already-active users as disabled, but we still want to reuse that identity
        // for this automation session when explicitly configured.
        const wasDisabled = Boolean(hit.disabled);
        if (hit.disabled) {
          hit.disabled = false;
        }
        if (select.disabled) {
          select.disabled = false;
        }

        select.value = String(hit.value);
        select.dispatchEvent(new Event("input", { bubbles: true }));
        select.dispatchEvent(new Event("change", { bubbles: true }));

        return {
          ok: true,
          selectedValue: String(hit.value),
          selectedLabel: String(hit.text || "").trim(),
          wasDisabled,
        };
      }, { username: this.config.foundry.username });

      if (!selected?.ok) {
        const optionSummary = Array.isArray(selected?.options)
          ? selected.options.map((opt) => `${opt.text || "(blank)"}${opt.disabled ? "[disabled]" : ""}`).join(", ")
          : "";
        throw new Error(
          `FVTT user '${this.config.foundry.username}' not found in join form.${optionSummary ? ` options=${optionSummary}` : ""}`
        );
      }
    }

    if ((await passInput.count()) > 0) {
      await passInput.first().fill(this.config.foundry.password);
    }

    if ((await joinSubmit.count()) > 0) {
      await joinSubmit.first().click();
    } else {
      throw new Error("Could not find FVTT join submit button.");
    }
  }
}

module.exports = { FvttClient };





