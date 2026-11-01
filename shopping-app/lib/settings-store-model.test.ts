/** モデル provider 分離保存・旧 ID-only 設定移行の回帰テスト。 */

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type SettingsModule = typeof import("./settings-store");

function loadSettings(settings: Record<string, string>): {
  module: SettingsModule;
  writes: Array<[string, string]>;
} {
  const runtimeRequire = eval("require") as NodeRequire;
  delete runtimeRequire.cache[runtimeRequire.resolve("./settings-store")];
  const Module = runtimeRequire("module");
  const originalLoad = Module._load;
  const writes: Array<[string, string]> = [];
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
        getSetting: async (key: string) => settings[key] ?? null,
        setSetting: async (key: string, value: string) => {
          settings[key] = value;
          writes.push([key, value]);
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return {
      module: runtimeRequire("./settings-store") as SettingsModule,
      writes,
    };
  } finally {
    Module._load = originalLoad;
  }
}

export async function runSettingsStoreModelTests(): Promise<void> {
  const settings: Record<string, string> = {
    llm_primary_model: "latest",
    llm_fallback_model: "grok-4.7",
    llm_vision_model: "same-model-id",
    llm_vision_model_provider: "xai",
    llm_text_reasoning_effort: "max",
  };
  const loaded = loadSettings(settings);
  const store = loaded.module;

  const primary = await store.getPrimaryModelSelection();
  assert(primary.id === "latest" && primary.apiType === "openai", "prefixなし旧IDはopenaiへ移行する");
  assert(settings.llm_primary_model_provider === "openai", "旧ID-only設定へproviderキーを追加する");

  const fallback = await store.getFallbackModelSelection();
  assert(fallback.id === "grok-4.7" && fallback.apiType === "xai", "grok prefix旧IDはxaiへ移行する");
  assert(settings.llm_fallback_model_provider === "xai", "grok旧IDのproviderを保存する");

  const explicit = await store.getVisionModelSelection();
  assert(explicit.apiType === "xai", "明示providerはID推測より優先する");

  await store.setPrimaryModel("latest", "xai");
  const sameIdDifferentProvider = await store.getPrimaryModelSelection();
  assert(
    sameIdDifferentProvider.id === "latest" && sameIdDifferentProvider.apiType === "xai",
    "同じIDでもpickerの明示providerを保持する",
  );

  await store.setGrokSearchModel("grok-future");
  const grok = await store.getGrokSearchModelSelection();
  assert(grok.id === "grok-future" && grok.apiType === "xai", "Grok検索モデルはxai固定で保存する");
  assert(settings.llm_grok_search_model === "grok-future", "Grok検索モデルの専用キーへ保存する");

  const inherited = await store.getCatalogPostModelSelection();
  assert(inherited.id === "latest" && inherited.apiType === "xai", "未設定の投稿処理はGrok検索でなくPrimaryを継承する");
  assert(await store.getCatalogPostReasoningEffort() === "max", "未設定の投稿effortはテキスト設定を継承する");
  assert(!settings.llm_catalog_post_model && !settings.llm_catalog_post_reasoning_effort, "読み取りだけでは上書きを作らない");
  await store.setPrimaryModel("primary-next", "openai");
  await store.setTextReasoningEffort("high");
  assert((await store.getCatalogPostModelSelection()).id === "primary-next", "未設定時はPrimary変更を継承する");
  assert(await store.getCatalogPostReasoningEffort() === "high", "未設定時はeffort変更を継承する");
  await store.setCatalogPostModel("same-model-id", "openai");
  await store.setCatalogPostReasoningEffort("low");
  await store.setPrimaryModel("other", "gemini");
  await store.setTextReasoningEffort("medium");
  let post = await store.getCatalogPostModelSelection();
  assert(post.id === "same-model-id" && post.apiType === "openai", "明示したOpenAI選択はPrimary変更後も独立する");
  assert(await store.getCatalogPostReasoningEffort() === "low", "明示した投稿effortは独立する");
  await store.setCatalogPostModel("same-model-id", "xai");
  const reloaded = loadSettings(settings).module;
  post = await reloaded.getCatalogPostModelSelection();
  assert(await reloaded.getCatalogPostReasoningEffort() === "low", "再読み込み後も投稿effortを保持する");
  assert(post.id === "same-model-id" && post.apiType === "xai", "同じモデルIDでもxAI providerを保持する");
  assert((await store.getVisionModelSelection()).apiType === "xai" && (await store.getFallbackModelSelection()).id === "grok-4.7", "他の役割設定を変更しない");
  assert((await store.getGrokSearchModelSelection()).id === "grok-future", "Grok検索設定を変更しない");
  await store.setTextReasoningEffort("max");
  const max = await store.getTextReasoningEffort();
  assert(max === "max", "既存保存effort maxを読み戻す");
  await store.setVisionReasoningEffort("max");
  assert(settings.llm_vision_reasoning_effort === "max", "max effortを保存できる");
  assert(loaded.writes.length > 0, "provider移行・選択保存をSQLiteへ書く");
}

