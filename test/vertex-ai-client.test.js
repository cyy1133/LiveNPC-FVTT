const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildVertexBaseUrl,
  resolveVertexRequestConfig,
  getVertexProviderStatus,
} = require("../runtime/llm/vertex-ai-client");

test("buildVertexBaseUrl creates the documented Vertex OpenAI-compatible endpoint", () => {
  const url = buildVertexBaseUrl({
    projectId: "demo-project",
    location: "global",
  });

  assert.equal(
    url,
    "https://aiplatform.googleapis.com/v1/projects/demo-project/locations/global/endpoints/openapi"
  );
});

test("resolveVertexRequestConfig can use a manual access token", async () => {
  const result = await resolveVertexRequestConfig({
    config: {
      llm: {
        vertexAi: {
          projectId: "demo-project",
          location: "asia-northeast3",
          model: "google/gemini-2.5-flash",
          authMode: "access-token",
          accessToken: "manual-token",
        },
      },
    },
  });

  assert.equal(result.apiKey, "manual-token");
  assert.equal(result.authMode, "access-token");
  assert.equal(result.authSource, "config-access-token");
  assert.match(result.baseUrl, /projects\/demo-project\/locations\/asia-northeast3\/endpoints\/openapi$/);
});

test("resolveVertexRequestConfig can obtain a gcloud token via injected execFile", async () => {
  const execFileImpl = async () => ({ stdout: "gcloud-token\n" });

  const result = await resolveVertexRequestConfig({
    config: {
      llm: {
        vertexAi: {
          projectId: "demo-project",
          authMode: "gcloud-cli",
        },
      },
    },
    execFileImpl,
  });

  assert.equal(result.apiKey, "gcloud-token");
  assert.equal(result.authSource, "gcloud-cli");
  assert.equal(result.location, "global");
});

test("getVertexProviderStatus reports missing project id before trying auth", async () => {
  const result = await getVertexProviderStatus({
    config: {
      llm: {
        vertexAi: {
          authMode: "gcloud-cli",
        },
      },
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.detail, /project id/i);
});
