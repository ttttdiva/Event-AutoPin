/** 動的モデルカタログの HTTP 固定応答 / 世代管理回帰テスト。 */

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type CatalogModule = typeof import("./model-catalog");

function response(body: unknown, status = 200): import("./model-catalog").CatalogResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function loadCatalog(): CatalogModule {
  const runtimeRequire = eval("require") as (id: string) => any;
  const Module = runtimeRequire("module");
  const originalLoad = Module._load;
  Module._load = function mockLoad(
    request: string,
    parent: unknown,
    isMain: boolean,
  ) {
    if (request === "expo-secure-store") {
      return {
        getItemAsync: async () => null,
        setItemAsync: async () => undefined,
        deleteItemAsync: async () => undefined,
      };
    }
    if (request === "./database") {
      return {
        getSetting: async () => null,
        setSetting: async () => undefined,
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return runtimeRequire("./model-catalog") as CatalogModule;
  } finally {
    Module._load = originalLoad;
  }
}

export async function runModelCatalogTests(): Promise<void> {
  const catalog = loadCatalog();
  catalog.resetModelCatalogForTests();

  const openAiRequests: Array<{ url: string; headers: Record<string, string> }> = [];
  const openAi = await catalog.fetchProviderModels("openai", "dummy-key", {
    fetchImpl: async (url, init) => {
      openAiRequests.push({ url, headers: init?.headers ?? {} });
      return response({
        data: [
          { id: "gpt-5.6-luna" },
          { id: "future-gpt-2026" },
          { id: "text-embedding-3-small" },
          { id: "gpt-retired", status: "retired" },
        ],
      });
    },
  });
  assert(openAi.some((model) => model.id === "future-gpt-2026"), "未知のOpenAI live IDを除外しない");
  assert(!openAi.some((model) => model.id.includes("embedding")), "embedding専用モデルをrole候補へ混ぜない");
  assert(!openAi.some((model) => model.id === "gpt-retired"), "retiredモデルを候補へ混ぜない");
  const future = openAi.find((model) => model.id === "future-gpt-2026");
  assert(
    future?.text === "unknown" && future.vision === "unknown",
    "能力metadataなしの新IDはtext/vision能力未確認にする",
  );
  assert(openAiRequests.length === 1, "OpenAIモデル一覧は1回だけ読む");
  assert(openAiRequests[0].url === "https://api.openai.com/v1/models", "OpenAI read-only endpointを使う");
  assert(openAiRequests[0].url.includes("dummy-key") === false, "OpenAI keyをURLへ含めない");
  assert(openAiRequests[0].headers.Authorization === "Bearer dummy-key", "OpenAI keyはAuthorization headerだけで送る");

  const geminiRequests: Array<{ url: string; key: string }> = [];
  const gemini = await catalog.fetchProviderModels("gemini", "dummy-key", {
    fetchImpl: async (url, init) => {
      geminiRequests.push({
        url,
        key: init?.headers?.["x-goog-api-key"] ?? "",
      });
      if (url.includes("pageToken=next-page")) {
        return response({
          models: [
            {
              name: "models/gemini-future",
              supportedGenerationMethods: ["generateContent"],
            },
          ],
        });
      }
      return response({
        models: [
          {
            name: "models/gemini-live",
            displayName: "Gemini Live",
            supportedGenerationMethods: ["generateContent"],
          },
          {
            name: "models/gemini-embedding",
            supportedGenerationMethods: ["embedContent"],
          },
        ],
        nextPageToken: "next-page",
      });
    },
  });
  assert(gemini.length === 2, "Gemini models.listのページング結果を結合する");
  assert(gemini.some((model) => model.id === "gemini-future"), "Gemini 2ページ目を含める");
  assert(!gemini.some((model) => model.id === "gemini-embedding"), "generateContent非対応Geminiを除外する");
  assert(geminiRequests.length === 2, "Gemini nextPageTokenを使って2ページ取得する");
  assert(geminiRequests[0].url.includes("dummy-key") === false, "Gemini keyをURLへ含めない");
  assert(geminiRequests.every((request) => request.key === "dummy-key"), "Gemini keyはx-goog-api-key headerだけで送る");

  const xai = await catalog.fetchProviderModels("xai", "dummy-key", {
    fetchImpl: async () =>
      response([
        { id: "grok-future", modalities: ["text", "image"] },
        { id: "grok-audio", modalities: ["audio"] },
      ]),
  });
  assert(xai.length === 1 && xai[0].provider === "xai", "xAI language-modelsのprovider identityを保持する");
  assert(xai[0].vision === "verified", "xAI modalitiesのimageをvision能力として扱う");

  catalog.resetModelCatalogForTests();
  let callCount = 0;
  const cached = await catalog.refreshModelCatalog("openai", {
    apiKey: "dummy-key",
    now: () => new Date("2026-10-31T00:00:00.000Z"),
    fetchImpl: async () => {
      callCount += 1;
      return callCount === 1
        ? response({ data: [{ id: "future-cached" }] })
        : response({ error: { message: "private error body must not surface" } }, 429);
    },
  });
  assert(cached.providers.openai.status === "ready", "初回取得をreadyにする");
  const liveList = catalog.getModelCatalogModels();
  assert(
    liveList.find((model) => model.id === "future-cached")?.source === "provider-api",
    "live取得済み候補はseedより優先して表示する",
  );
  const failed = await catalog.refreshModelCatalog("openai", {
    apiKey: "dummy-key",
    fetchImpl: async () => response({ error: { secret: "not shown" } }, 429),
  });
  assert(failed.providers.openai.status === "error", "429をerror状態にする");
  assert(failed.providers.openai.error?.kind === "rate-limit", "429をrate-limitとして表示する");
  assert(failed.providers.openai.stale, "取得失敗でも前回候補をstale保持する");
  assert(failed.providers.openai.models.some((model) => model.id === "future-cached"), "失敗時に候補を消さない");
  assert(!JSON.stringify(failed.providers.openai.error).includes("secret"), "error response bodyを表示しない");

  const missing = await catalog.refreshModelCatalog("xai", {
    apiKey: null,
    fetchImpl: async () => response({ data: [] }),
  });
  assert(missing.providers.xai.status === "credential-missing", "認証情報未設定を専用状態にする");

  const unauthorized = await catalog.refreshModelCatalog("gemini", {
    apiKey: "dummy-key",
    fetchImpl: async () => response({}, 401),
  });
  assert(unauthorized.providers.gemini.error?.kind === "auth", "401をauthとして表示する");

  const network = await catalog.refreshModelCatalog("xai", {
    apiKey: "dummy-key",
    fetchImpl: async () => {
      throw new Error("transport secret");
    },
  });
  assert(network.providers.xai.error?.kind === "network", "通信失敗をnetworkとして表示する");
  assert(!JSON.stringify(network.providers.xai.error).includes("transport secret"), "通信例外本文を表示しない");

  const capability = catalog.getModelCapabilities("openai", "gpt-5.6-luna", openAi);
  assert(capability.reasoningEfforts.includes("max"), "GPT-5.6 Lunaはmax effortを選べる");
  const unknownCapability = catalog.getModelCapabilities("openai", "future-gpt-2026", openAi);
  assert(
    unknownCapability.reasoningEfforts.length === 1 && unknownCapability.reasoningEfforts[0] === "none",
    "未知liveモデルはAPI既定（指定なし）だけを広告する",
  );
  const specializedCapability = catalog.getModelCapabilities("openai", "gpt-5.6-cyber");
  assert(
    specializedCapability.reasoningEfforts.length === 1 && specializedCapability.reasoningEfforts[0] === "none",
    "既知general以外のGPT-5.6 IDへeffortを推測しない",
  );

  let resolveSlow!: (value: import("./model-catalog").CatalogResponse) => void;
  const slow = new Promise<import("./model-catalog").CatalogResponse>((resolve) => {
    resolveSlow = resolve;
  });
  let raceCall = 0;
  const first = catalog.refreshModelCatalog("openai", {
    apiKey: "dummy-key",
    fetchImpl: async () => {
      raceCall += 1;
      return raceCall === 1 ? slow : response({ data: [{ id: "new-key-model" }] });
    },
  });
  const second = catalog.refreshModelCatalog("openai", {
    apiKey: "dummy-key",
    fetchImpl: async () => response({ data: [{ id: "new-key-model" }] }),
  });
  await second;
  resolveSlow(response({ data: [{ id: "old-key-model" }] }));
  await first;
  const raced = catalog.getModelCatalogSnapshot();
  assert(raced.providers.openai.models.some((model) => model.id === "new-key-model"), "新しいrefresh結果を保持する");
  assert(!raced.providers.openai.models.some((model) => model.id === "old-key-model"), "遅延した古い結果で上書きしない");
}

