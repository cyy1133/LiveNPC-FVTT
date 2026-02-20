const http = require("node:http");
const crypto = require("node:crypto");

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function randomHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString("hex");
}

function generatePkce() {
  const verifier = base64Url(crypto.randomBytes(32));
  const hash = crypto.createHash("sha256").update(verifier).digest();
  const challenge = base64Url(hash);
  return { verifier, challenge };
}

function parseRedirectInput(input) {
  const value = String(input || "").trim();
  if (!value) return {};

  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") || undefined,
      state: url.searchParams.get("state") || undefined,
    };
  } catch {
    // not a URL
  }

  // Fallback: querystring-ish
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") || undefined,
      state: params.get("state") || undefined,
    };
  }

  return { code: value };
}

function buildAuthorizeUrl({ state, challenge, originator = "pi" }) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", originator);
  return url.toString();
}

async function exchangeCodeForToken({ code, verifier }) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI OAuth token exchange failed: HTTP ${res.status} ${text}`);
  }

  const json = await res.json();
  const accessToken = json?.access_token;
  const refreshToken = json?.refresh_token;
  const expiresIn = json?.expires_in;
  if (!accessToken || !refreshToken || typeof expiresIn !== "number") {
    throw new Error("OpenAI OAuth token response missing required fields.");
  }

  return {
    accessToken,
    refreshToken,
    expiresAtMs: Date.now() + expiresIn * 1000,
  };
}

async function refreshToken({ refreshToken }) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI OAuth refresh failed: HTTP ${res.status} ${text}`);
  }

  const json = await res.json();
  const accessToken = json?.access_token;
  const nextRefresh = json?.refresh_token;
  const expiresIn = json?.expires_in;
  if (!accessToken || !nextRefresh || typeof expiresIn !== "number") {
    throw new Error("OpenAI OAuth refresh response missing required fields.");
  }

  return {
    accessToken,
    refreshToken: nextRefresh,
    expiresAtMs: Date.now() + expiresIn * 1000,
  };
}

function startCallbackServer({ expectedState, onCode }) {
  // Matches REDIRECT_URI (fixed): http://localhost:1455/auth/callback
  let lastCode = null;
  let cancelled = false;

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || "", "http://localhost");
      if (url.pathname !== "/auth/callback") {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      if (url.searchParams.get("state") !== expectedState) {
        res.statusCode = 400;
        res.end("State mismatch");
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        res.statusCode = 400;
        res.end("Missing code");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end("<!doctype html><html><body><p>Authentication successful. You may close this tab.</p></body></html>");
      lastCode = code;
      if (typeof onCode === "function") onCode(code);
    } catch {
      res.statusCode = 500;
      res.end("Internal error");
    }
  });

  const ready = new Promise((resolve) => {
    server
      .listen(1455, "127.0.0.1", () => resolve({ ok: true }))
      .on("error", (err) => resolve({ ok: false, error: err?.code || err?.message || String(err) }));
  });

  async function waitForCode(timeoutMs = 60_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (lastCode) return lastCode;
      if (cancelled) return null;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }

  return {
    ready,
    waitForCode,
    cancelWait: () => {
      cancelled = true;
    },
    close: () => {
      try {
        server.close();
      } catch {
        // ignore
      }
    },
  };
}

async function login({
  openUrl,
  prompt,
  originator = "pi",
  waitTimeoutMs = 90_000,
  allowManualPaste = true,
} = {}) {
  const { verifier, challenge } = generatePkce();
  const state = randomHex(16);
  const url = buildAuthorizeUrl({ state, challenge, originator });

  let code = null;
  const server = startCallbackServer({ expectedState: state });
  const bind = await server.ready;

  if (typeof openUrl === "function") {
    await openUrl(url);
  }

  try {
    code = await server.waitForCode(waitTimeoutMs);
    if (!code && allowManualPaste && typeof prompt === "function") {
      const input = await prompt({
        message: "브라우저에서 로그인 후, 리다이렉트된 URL(또는 code)을 붙여 넣어 주세요:",
      });
      const parsed = parseRedirectInput(input);
      if (parsed.state && parsed.state !== state) {
        throw new Error("State mismatch");
      }
      code = parsed.code || null;
    }

    if (!code) {
      const note = bind?.ok ? "callback timed out" : `callback server failed to bind (${bind?.error})`;
      throw new Error(`OAuth login failed: ${note}`);
    }

    return exchangeCodeForToken({ code, verifier });
  } finally {
    server.close();
  }
}

module.exports = {
  CLIENT_ID,
  AUTHORIZE_URL,
  TOKEN_URL,
  REDIRECT_URI,
  SCOPE,
  login,
  refreshToken,
};

