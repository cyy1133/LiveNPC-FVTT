const test = require("node:test");
const assert = require("node:assert/strict");

const { AppRuntime } = require("../runtime/app-runtime");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("stop invalidates queued runtime tasks before they touch FVTT state", async () => {
  const runtime = new AppRuntime();
  runtime.started = true;
  const runToken = runtime._beginRunToken();
  let executed = false;

  runtime._enqueueSerialTask(async (token) => {
    await delay(25);
    runtime._throwIfRuntimeStopped(token);
    executed = true;
  }, runToken).catch(() => {});

  await delay(5);
  await runtime.stop();
  await runtime.queue.catch(() => {});

  assert.equal(executed, false);
  assert.equal(runtime.started, false);
});
