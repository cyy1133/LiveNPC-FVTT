const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeCodexBin } = require("../runtime/llm/codex-cli-client");

test("normalizeCodexBin falls back to default command when configured path is missing", () => {
  const missingPath =
    process.platform === "win32"
      ? "C:\\definitely-missing\\codex.exe"
      : "/definitely-missing/codex";

  const normalized = normalizeCodexBin(missingPath);
  assert.notEqual(normalized, missingPath);
  if (process.platform === "win32") {
    assert.match(normalized, /(codex\.cmd|codex\.exe)$/i);
  } else {
    assert.equal(normalized, "codex");
  }
});

test("normalizeCodexBin keeps bare command names so PATH lookup still works", () => {
  const normalized = normalizeCodexBin(process.platform === "win32" ? "codex.exe" : "codex");
  const expected = process.platform === "win32" ? "codex.exe" : "codex";
  assert.equal(normalized, expected);
});
