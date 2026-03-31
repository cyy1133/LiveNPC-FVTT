const test = require("node:test");
const assert = require("node:assert/strict");

const { completeJson, normalizePreferredApi } = require("../runtime/llm/openai-client");

test("normalizePreferredApi maps chat aliases to chat-completions", () => {
  assert.equal(normalizePreferredApi("chat"), "chat-completions");
  assert.equal(normalizePreferredApi("chat.completions"), "chat-completions");
  assert.equal(normalizePreferredApi("responses"), "responses");
  assert.equal(normalizePreferredApi(""), "auto");
});

test("completeJson can skip responses API and use chat completions directly", async () => {
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: '{"replyText":"ok","intent":{"type":"none","args":{}}}',
              },
            },
          ],
        };
      },
    };
  };

  try {
    const result = await completeJson({
      baseUrl: "https://example.com/root",
      apiKey: "secret",
      model: "test-model",
      prompt: "Return JSON",
      timeoutMs: 1000,
      preferredApi: "chat-completions",
    });

    assert.equal(result.api, "chat.completions");
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\/v1\/chat\/completions$/);
    assert.equal(result.parsed.replyText, "ok");
  } finally {
    global.fetch = originalFetch;
  }
});
