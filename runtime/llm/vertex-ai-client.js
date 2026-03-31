const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

function normalizeVertexAuthMode(value) {
  const raw = String(value || "gcloud-cli").trim().toLowerCase();
  if (raw === "access-token" || raw === "token" || raw === "manual") return "access-token";
  return "gcloud-cli";
}

function normalizeVertexLocation(value) {
  return String(value || "global").trim() || "global";
}

function normalizeVertexModel(value) {
  return String(value || "google/gemini-2.5-flash").trim() || "google/gemini-2.5-flash";
}

function resolveVertexProjectId(rawProjectId) {
  return (
    String(rawProjectId || "").trim() ||
    String(process.env.GOOGLE_CLOUD_PROJECT || "").trim() ||
    String(process.env.GCLOUD_PROJECT || "").trim()
  );
}

function buildVertexBaseUrl({ projectId, location } = {}) {
  const resolvedProjectId = resolveVertexProjectId(projectId);
  if (!resolvedProjectId) {
    throw new Error("Missing Vertex AI project ID");
  }
  const resolvedLocation = normalizeVertexLocation(location);
  return `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(
    resolvedProjectId
  )}/locations/${encodeURIComponent(resolvedLocation)}/endpoints/openapi`;
}

function defaultGcloudCommand() {
  return process.platform === "win32" ? "gcloud.cmd" : "gcloud";
}

async function getAccessTokenFromGcloud({ gcloudPath = "", timeoutMs = 20_000, execFileImpl = execFileAsync } = {}) {
  const command = String(gcloudPath || "").trim() || defaultGcloudCommand();
  try {
    const result = await execFileImpl(command, ["auth", "print-access-token"], {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 512 * 1024,
      encoding: "utf8",
    });
    const token = String(result?.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (!token) {
      throw new Error("gcloud returned an empty access token");
    }
    return { token, command };
  } catch (error) {
    throw new Error(`Vertex AI gcloud auth failed: ${error?.message || error}`);
  }
}

function readManualAccessToken(vertexConfig = {}) {
  const configured = String(vertexConfig?.accessToken || "").trim();
  const envToken = String(process.env.GOOGLE_ACCESS_TOKEN || "").trim();
  const token = configured || envToken;
  if (!token) {
    throw new Error("Missing Vertex AI access token");
  }
  return {
    token,
    source: configured ? "config-access-token" : "env-access-token",
  };
}

function resolveVertexConfig(config) {
  const vertex = config?.llm?.vertexAi || {};
  return {
    projectId: resolveVertexProjectId(vertex.projectId),
    location: normalizeVertexLocation(vertex.location),
    model: normalizeVertexModel(vertex.model),
    authMode: normalizeVertexAuthMode(vertex.authMode),
    accessToken: String(vertex.accessToken || "").trim(),
    gcloudPath: String(vertex.gcloudPath || "").trim(),
  };
}

async function resolveVertexRequestConfig({ config, timeoutMs = 20_000, execFileImpl = execFileAsync } = {}) {
  const vertex = resolveVertexConfig(config);
  const baseUrl = buildVertexBaseUrl(vertex);

  if (vertex.authMode === "access-token") {
    const manual = readManualAccessToken(vertex);
    return {
      provider: "vertex-ai",
      baseUrl,
      apiKey: manual.token,
      model: vertex.model,
      projectId: vertex.projectId,
      location: vertex.location,
      authMode: vertex.authMode,
      authSource: manual.source,
    };
  }

  const gcloud = await getAccessTokenFromGcloud({
    gcloudPath: vertex.gcloudPath,
    timeoutMs,
    execFileImpl,
  });
  return {
    provider: "vertex-ai",
    baseUrl,
    apiKey: gcloud.token,
    model: vertex.model,
    projectId: vertex.projectId,
    location: vertex.location,
    authMode: vertex.authMode,
    authSource: "gcloud-cli",
    gcloudPath: gcloud.command,
  };
}

async function getVertexProviderStatus({ config, execFileImpl = execFileAsync } = {}) {
  const vertex = resolveVertexConfig(config);
  if (!vertex.projectId) {
    return { ok: false, detail: "Vertex project ID is missing" };
  }

  if (vertex.authMode === "access-token") {
    try {
      const manual = readManualAccessToken(vertex);
      return {
        ok: true,
        detail: `Vertex token configured (${manual.source}, ${vertex.location})`,
      };
    } catch (error) {
      return { ok: false, detail: error?.message || String(error) };
    }
  }

  try {
    const gcloud = await getAccessTokenFromGcloud({
      gcloudPath: vertex.gcloudPath,
      execFileImpl,
      timeoutMs: 15_000,
    });
    return {
      ok: true,
      detail: `gcloud token ok (${vertex.location}, ${gcloud.command})`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: error?.message || String(error),
    };
  }
}

function launchVertexGcloudLogin({ gcloudPath = "" } = {}) {
  const command = String(gcloudPath || "").trim() || defaultGcloudCommand();

  if (process.platform === "win32") {
    const cmdLine = `start "Vertex AI Login" cmd /k "${command}" auth login`;
    const child = spawn("cmd.exe", ["/c", cmdLine], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    return { ok: true };
  }

  const child = spawn(command, ["auth", "login"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { ok: true };
}

module.exports = {
  normalizeVertexAuthMode,
  normalizeVertexLocation,
  normalizeVertexModel,
  buildVertexBaseUrl,
  resolveVertexConfig,
  resolveVertexRequestConfig,
  getVertexProviderStatus,
  launchVertexGcloudLogin,
};
