const test = require("node:test");
const assert = require("node:assert/strict");

const { AppRuntime } = require("../runtime/app-runtime");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createNpc(id, displayName) {
  return {
    id,
    displayName,
    actor: {
      type: "name",
      value: displayName,
    },
  };
}

test("smoke: out-of-combat tavern scene serializes two NPC performances on the shared FVTT client", async () => {
  const runtime = new AppRuntime();
  runtime.started = true;
  const runToken = runtime._beginRunToken();

  const barkeep = createNpc("barkeep", "Barkeep");
  const guard = createNpc("guard", "Town Guard");

  const events = [];
  let inFlight = 0;
  let peakConcurrency = 0;

  runtime.fvtt = {
    config: {
      foundry: {
        actorId: "",
        actorName: "",
      },
    },
    async ensureConnected() {
      return { ok: true };
    },
    async speakAsActor(text) {
      const activeActor = String(this.config.foundry.actorName || "");
      events.push(`start:${activeActor}:${text}`);
      inFlight += 1;
      peakConcurrency = Math.max(peakConcurrency, inFlight);
      await delay(30);
      events.push(`end:${activeActor}:${text}`);
      inFlight -= 1;
      return { ok: true, actorName: activeActor, text };
    },
  };

  const first = runtime._enqueueSerialTask((token) =>
    runtime._withNpcActor(barkeep, () => runtime.fvtt.speakAsActor("Guests, your tables are over there."), {
      runToken: token,
    }), runToken);

  const second = runtime._enqueueSerialTask((token) =>
    runtime._withNpcActor(guard, () => runtime.fvtt.speakAsActor("Closing soon. Keep the peace."), {
      runToken: token,
    }), runToken);

  await Promise.all([first, second]);

  assert.equal(peakConcurrency, 1);
  assert.deepEqual(events, [
    "start:Barkeep:Guests, your tables are over there.",
    "end:Barkeep:Guests, your tables are over there.",
    "start:Town Guard:Closing soon. Keep the peace.",
    "end:Town Guard:Closing soon. Keep the peace.",
  ]);
  assert.equal(runtime.fvtt.config.foundry.actorName, "");
});
