function normalizeBaseUrl(baseUrl) {
  const raw = String(baseUrl || "https://api.openai.com").trim();
  try {
    const url = new URL(raw);
    return url.origin;
  } catch {
    return "https://api.openai.com";
  }
}

function extractJsonObject(mixedText) {
  const text = String(mixedText || "").trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first < 0 || last < 0 || last < first) {
    throw new Error("JSON object not found in LLM output");
  }
  return JSON.parse(text.slice(first, last + 1));
}

function pickTextFromResponsesApi(result) {
  // Responses API returns an output array with text. We keep this forgiving.
  const output = Array.isArray(result?.output) ? result.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (part?.type === "output_text" && typeof part?.text === "string" && part.text.trim()) {
        return part.text;
      }
      if (typeof part?.text === "string" && part.text.trim()) return part.text;
    }
  }
  if (typeof result?.output_text === "string" && result.output_text.trim()) return result.output_text;
  return "";
}

async function createResponse({
  baseUrl,
  apiKey,
  model,
  inputText,
  timeoutMs = 90_000,
} = {}) {
  const origin = normalizeBaseUrl(baseUrl);
  const url = `${origin}/v1/responses`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: inputText,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const error = new Error(`OpenAI responses API failed: HTTP ${res.status} ${text}`);
      error.status = res.status;
      error.body = text;
      throw error;
    }
    const json = await res.json();
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function createChatCompletion({
  baseUrl,
  apiKey,
  model,
  inputText,
  timeoutMs = 90_000,
} = {}) {
  const origin = normalizeBaseUrl(baseUrl);
  const url = `${origin}/v1/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: inputText }],
        temperature: 0.2,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const error = new Error(`OpenAI chat.completions failed: HTTP ${res.status} ${text}`);
      error.status = res.status;
      error.body = text;
      throw error;
    }
    const json = await res.json();
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function pickTextFromChatCompletions(result) {
  const choice = Array.isArray(result?.choices) ? result.choices[0] : null;
  const text = choice?.message?.content;
  return typeof text === "string" ? text : "";
}

function shouldFallbackToChatCompletions(error) {
  const status = Number(error?.status || 0);
  const body = String(error?.body || error?.message || "").toLowerCase();

  // Strong signal: responses endpoint not supported.
  if (status === 404 || status === 405) return true;

  // If key/token itself is invalid, fallback won't help.
  if (
    body.includes("invalid_api_key") ||
    body.includes("incorrect api key") ||
    body.includes("invalid authentication credentials")
  ) {
    return false;
  }

  // Common restricted-key/org permission cases.
  if (status === 401 || status === 403) {
    if (
      body.includes("api.responses.write") ||
      body.includes("missing scopes") ||
      body.includes("insufficient permissions")
    ) {
      return true;
    }
    // Be permissive on authz errors unless clearly invalid credentials.
    return true;
  }

  return false;
}

async function completeJson({
  baseUrl,
  apiKey,
  model,
  prompt,
  timeoutMs,
} = {}) {
  try {
    const raw = await createResponse({
      baseUrl,
      apiKey,
      model,
      inputText: prompt,
      timeoutMs,
    });
    const text = pickTextFromResponsesApi(raw);
    const parsed = extractJsonObject(text);
    return { raw, text, parsed, api: "responses" };
  } catch (e) {
    if (shouldFallbackToChatCompletions(e)) {
      let fallbackError = null;
      try {
        const raw = await createChatCompletion({
          baseUrl,
          apiKey,
          model,
          inputText: prompt,
          timeoutMs,
        });
        const text = pickTextFromChatCompletions(raw);
        const parsed = extractJsonObject(text);
        return { raw, text, parsed, api: "chat.completions" };
      } catch (inner) {
        fallbackError = inner;
      }

      const combined = new Error(
        `OpenAI responses failed, and fallback chat.completions also failed. responses=[${
          e?.message || e
        }] fallback=[${fallbackError?.message || fallbackError}]`
      );
      combined.primary = e;
      combined.fallback = fallbackError;
      throw combined;
    }

    // Non-fallback errors are propagated as-is.
    throw e;
  }
}

module.exports = { createResponse, createChatCompletion, completeJson };
