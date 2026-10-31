const assert = require("node:assert/strict");
const Module = require("node:module");

const apiKeys = { openai: "dummy-key-openai", gemini: "dummy-key-gemini", xai: "dummy-key-xai" };
const settingsMock = {
  getApiKey: async (provider) => apiKeys[provider] ?? null,
};

// llm-client.ts/model-catalog.ts は実行時にsettings-storeを読むため、
// API疎通を行わずにクライアントのdispatchだけを検証する。
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "../settings-store" || /[\\/]settings-store$/.test(request)) {
    return settingsMock;
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { LlmClient, testApiKey } = require("./llm-client");
Module._load = originalLoad;

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; },
    async text() { return "server-body-secret-should-not-leak"; },
  };
}

function jsonBody(call) {
  return JSON.parse(call.init.body);
}

async function withFetch(queue, run) {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return queue.length ? queue.shift() : response({ output_text: '{"ok":true}' });
  };
  try {
    return await run(calls);
  } finally {
    global.fetch = originalFetch;
  }
}

async function withoutWarnings(run) {
  const originalWarn = console.warn;
  console.warn = () => {};
  try { return await run(); } finally { console.warn = originalWarn; }
}

async function runOpenAiResponsesTests() {
  await withFetch([response({ output_text: '{"ok":true}' })], async (calls) => {
    const client = new LlmClient({ id: "gpt-5.6-luna", apiType: "openai" });
    assert.equal(await client.extractData("text", { reasoningEffort: "max" }), '{"ok":true}');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
    const body = jsonBody(calls[0]);
    assert.equal(body.model, "gpt-5.6-luna");
    assert.deepEqual(body.reasoning, { effort: "max" });
    assert.equal(calls[0].init.headers.Authorization, "Bearer dummy-key-openai");
  });

  await withFetch([response({ output_text: '{"image":true}' })], async (calls) => {
    const client = new LlmClient({ id: "gpt-5.6-luna", apiType: "openai" });
    await client.analyzeImage("QUJD", "image/png", "describe", { reasoningEffort: "max" });
    assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
    const body = jsonBody(calls[0]);
    assert.deepEqual(body.reasoning, { effort: "max" });
    assert.equal(body.input[0].content[1].type, "input_image");
    assert.equal(body.input[0].content[1].image_url, "data:image/png;base64,QUJD");
  });
}

async function runFutureAndLegacyRoutingTests() {
  await withFetch([response({ output_text: '{"future":true}' })], async (calls) => {
    const client = new LlmClient({ id: "gpt-new-live-generative", apiType: "openai" });
    await client.extractData("future", { reasoningEffort: "medium" });
    assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
    const body = jsonBody(calls[0]);
    assert.equal(body.model, "gpt-new-live-generative");
    assert.equal(Object.hasOwn(body, "reasoning"), false, "未知IDへmediumを自動送信しない");
  });

  await withFetch([response({ choices: [{ message: { content: '{"legacy":true}' } }] })], async (calls) => {
    const client = new LlmClient("gpt-4o");
    await client.extractData("legacy");
    assert.equal(calls[0].url, "https://api.openai.com/v1/chat/completions");
  });
}

async function runProviderAndFallbackTests() {
  await withFetch([
    response({ choices: [{ message: { content: '{"xai":true}' } }] }),
    response({ choices: [{ message: { content: '{"xaiImage":true}' } }] }),
  ], async (calls) => {
    const client = new LlmClient({ id: "gpt-5.6-luna", apiType: "xai" });
    await client.extractData("xai", { reasoningEffort: "max" });
    assert.equal(calls[0].url, "https://api.x.ai/v1/chat/completions");
    const textBody = jsonBody(calls[0]);
    assert.equal(textBody.model, "gpt-5.6-luna");
    assert.equal(Object.hasOwn(textBody, "reasoning_effort"), false, "xAIへOpenAI effortを転送しない");
    assert.equal(calls[0].init.headers.Authorization, "Bearer dummy-key-xai");

    await client.analyzeImage("QUJD", "image/jpeg", "xai image", { reasoningEffort: "max" });
    assert.equal(calls[1].url, "https://api.x.ai/v1/chat/completions");
    const imageBody = jsonBody(calls[1]);
    assert.equal(imageBody.messages[1].content[1].image_url.url, "data:image/jpeg;base64,QUJD");
    assert.equal(Object.hasOwn(imageBody, "reasoning_effort"), false);
  });

  await withFetch([
    response({ candidates: [{ content: { parts: [{ text: '{"gemini":true}' }] } }] }),
    response({ candidates: [{ content: { parts: [{ text: '{"geminiImage":true}' }] } }] }),
  ], async (calls) => {
    const client = new LlmClient({ id: "gemini-3-flash-preview", apiType: "gemini" });
    await client.extractData("gemini", { reasoningEffort: "max" });
    const textBody = jsonBody(calls[0]);
    assert.equal(Object.hasOwn(textBody, "reasoning_effort"), false, "GeminiへOpenAI effortを転送しない");
    assert.equal(Object.hasOwn(textBody, "reasoning"), false);
    assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent");
    assert.equal(calls[0].url.includes("dummy-key"), false, "Gemini keyをURLへ載せない");
    assert.equal(calls[0].init.headers["x-goog-api-key"], "dummy-key-gemini");
    await client.analyzeImage("QUJD", "image/png", "gemini image", { reasoningEffort: "max" });
    const imageBody = jsonBody(calls[1]);
    assert.equal(Object.hasOwn(imageBody, "reasoning_effort"), false);
    assert.equal(Object.hasOwn(imageBody, "reasoning"), false);
    assert.equal(calls[1].url.includes("dummy-key"), false);
    assert.equal(calls[1].init.headers["x-goog-api-key"], "dummy-key-gemini");
  });

  await withFetch([
    response({ candidates: [{ content: { parts: [{ text: '{"geminiHigh":true}' }] } }] }),
    response({ candidates: [{ content: { parts: [{ text: '{"geminiImageHigh":true}' }] } }] }),
  ], async (calls) => {
    const client = new LlmClient({ id: "gemini-3-flash-preview", apiType: "gemini" });
    await client.extractData("gemini high", { reasoningEffort: "high" });
    assert.deepEqual(jsonBody(calls[0]).generationConfig, {
      thinkingConfig: { thinkingLevel: "high" },
    });
    await client.analyzeImage("QUJD", "image/png", "gemini image high", { reasoningEffort: "high" });
    assert.deepEqual(jsonBody(calls[1]).generationConfig, {
      thinkingConfig: { thinkingLevel: "high" },
    });
  });

  await withFetch([
    response({ candidates: [{ content: { parts: [{ text: '{"geminiUnknown":true}' }] } }] }),
  ], async (calls) => {
    const client = new LlmClient({ id: "gemini-future-model", apiType: "gemini" });
    await client.extractData("gemini unknown", { reasoningEffort: "medium" });
    assert.equal(Object.hasOwn(jsonBody(calls[0]), "generationConfig"), false, "未知GeminiはthinkingConfigを省略");
  });

  // 同一provider+IDだけ重複排除し、同じIDでもproviderが違えば候補として残す。
  const client = new LlmClient([
    { id: "same-id", apiType: "openai" },
    { id: "same-id", apiType: "xai" },
    { id: "same-id", apiType: "openai" },
  ]);
  assert.deepEqual(client.models.map((model) => `${model.apiType}:${model.id}`), [
    "openai:same-id",
    "xai:same-id",
  ]);

  apiKeys.openai = null;
  await withFetch([response({ choices: [{ message: { content: '{"fallback":true}' } }] })], async (calls) => {
    await withoutWarnings(async () => {
      const fallback = new LlmClient([
        { id: "gpt-5.6-luna", apiType: "openai", reasoningEffort: "max" },
        { id: "grok-4-latest", apiType: "xai", reasoningEffort: "max" },
      ]);
      assert.equal(await fallback.extractData("fallback"), '{"fallback":true}');
    });
    assert.equal(calls.length, 1, "キー未設定候補はfetchせず次の候補へ進む");
    assert.equal(calls[0].url, "https://api.x.ai/v1/chat/completions");
  });
  apiKeys.openai = "dummy-key-openai";

  await withFetch([
    response({}, 503),
    response({ output_text: '{"fallbackEffort":true}' }),
  ], async (calls) => {
    await withoutWarnings(async () => {
      const fallback = new LlmClient([
        { id: "gpt-5.6-luna", apiType: "openai", reasoningEffort: "max" },
        { id: "gpt-5-mini", apiType: "openai", reasoningEffort: "low" },
      ]);
      assert.equal(await fallback.extractData("fallback effort"), '{"fallbackEffort":true}');
    });
    assert.equal(calls.length, 2, "request errorは通常のfallbackへ進む");
    assert.deepEqual(jsonBody(calls[0]).reasoning, { effort: "max" });
    assert.deepEqual(jsonBody(calls[1]).reasoning, { effort: "low" });
  });
}

async function runCompatibilityAndSanitizationTests() {
  const legacy = new LlmClient(["gemini-3-flash-preview", "grok-2-latest", "custom-model"]);
  assert.deepEqual(legacy.models.map((model) => model.apiType), ["gemini", "xai", "openai"]);

  await withFetch([response({}, 401)], async () => {
    await withoutWarnings(async () => {
      await assert.rejects(
        () => new LlmClient({ id: "gpt-new-live", apiType: "openai" }).extractData("secret prompt"),
        (error) => {
          assert.equal(error.message.includes("server-body-secret"), false);
          assert.equal(error.message.includes("secret prompt"), false);
          return true;
        },
      );
    });
  });
}

async function runCatalogConnectionTestTests() {
  await withFetch([response({ data: [{ id: "gpt-new-live" }] })], async (calls) => {
    const result = await testApiKey("openai", "dummy-key-openai", "retired-fixed-model");
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.openai.com/v1/models");
    assert.equal(calls[0].init.method, "GET");
    assert.equal(Object.hasOwn(calls[0].init, "body"), false, "completion probeのbodyを送らない");
    assert.equal(result.message.includes("1件"), true);
  });

  await withFetch([response([{ id: "grok-current-live" }])], async (calls) => {
    const result = await testApiKey("xai", "dummy-key-xai", "grok-retired-fixed-model");
    assert.equal(result.ok, true);
    assert.equal(calls[0].url, "https://api.x.ai/v1/language-models");
    assert.equal(calls[0].init.method, "GET");
    assert.equal(Object.hasOwn(calls[0].init, "body"), false);
  });

  await withFetch([response({ models: [{ name: "models/gemini-current", supportedGenerationMethods: ["generateContent"] }] })], async (calls) => {
    const result = await testApiKey("gemini", "dummy-key-gemini", "gemini-retired-fixed-model");
    assert.equal(result.ok, true);
    assert.equal(calls[0].url.startsWith("https://generativelanguage.googleapis.com/v1beta/models?"), true);
    assert.equal(calls[0].init.method, "GET");
    assert.equal(Object.hasOwn(calls[0].init, "body"), false);
  });

  await withFetch([response({ error: { message: "server-body-secret" } }, 401)], async (calls) => {
    const result = await testApiKey("openai", "dummy-key-openai", "fixed-model-id");
    assert.equal(result.ok, false);
    assert.equal(result.message.includes("HTTP 401"), true);
    assert.equal(result.message.includes("server-body-secret"), false);
    assert.equal(result.message.includes("dummy-key"), false);
    assert.equal(calls.length, 1);
  });

  await withFetch([], async (calls) => {
    const result = await testApiKey("openai", "", "fixed-model-id");
    assert.equal(result.ok, false);
    assert.equal(result.message.includes("未設定"), true);
    assert.equal(calls.length, 0, "未保存キーではcatalog fetchも実行しない");
  });
}

async function runGenericEffortDispatchTest() {
  const captured = { models: null, options: null };
  class FakeClient {
    constructor(models) { captured.models = models; }
    async extractData(_prompt, options) {
      captured.options = options;
      return JSON.stringify({ table_index: 0, columns: { name: 0 } });
    }
  }
  const genericSettings = {
    getPrimaryModelSelection: async () => ({ id: "primary", apiType: "openai" }),
    getFallbackModelSelection: async () => ({ id: "fallback", apiType: "xai" }),
    getSiteParsingModelSelection: async () => ({ id: "site", apiType: "openai" }),
    getTextReasoningEffort: async () => "max",
    getSiteParsingReasoningEffort: async () => "high",
  };
  const genericMocks = {
    "../llm-client": { LlmClient: FakeClient },
    "../../settings-store": genericSettings,
    "../html-fetcher": { fetchHtml: async () => "<table><tr><th>Name</th><th>Space</th></tr><tr><td>A</td><td>1</td></tr><tr><td>B</td><td>2</td></tr></table>" },
    "../site-schema-store": {
      findExactTableSchema: async () => null,
      normalizeHeaders: (headers) => headers.map((header) => String(header).trim().toLowerCase()),
    },
    "../url-validation": { normalizeXProfileUrl: () => null },
  };
  const previousLoad = Module._load;
  Module._load = function genericLoad(request, parent, isMain) {
    if (genericMocks[request]) return genericMocks[request];
    if (request.endsWith("/settings-store") || request.endsWith("\\settings-store")) return genericSettings;
    return previousLoad.call(this, request, parent, isMain);
  };
  let generic;
  try {
    generic = require("./adapters/generic");
  } finally {
    Module._load = previousLoad;
  }
  await generic.crawlGeneric("https://example.test/catalog");
  assert.equal(captured.options.reasoningEffort, "max", "genericへ保存済みtext effortを渡す");
  assert.deepEqual(captured.models.map((model) => [model.id, model.apiType, model.reasoningEffort]), [
    ["site", "openai", "high"],
    ["primary", "openai", "max"],
    ["fallback", "xai", "max"],
  ]);
}

async function runLlmClientTests() {
  await runOpenAiResponsesTests();
  await runFutureAndLegacyRoutingTests();
  await runProviderAndFallbackTests();
  await runCompatibilityAndSanitizationTests();
  await runCatalogConnectionTestTests();
  await runGenericEffortDispatchTest();
}

module.exports = { runLlmClientTests };
