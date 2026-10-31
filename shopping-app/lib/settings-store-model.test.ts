/** モデル provider 分離保存・旧 ID-only 設定移行の回帰テスト。 */

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type SettingsModule = typeof import("./settings-store");

function loadSettings(settings: Record<string, string>): {
  module: SettingsModule;
  writes: Array<[string, string]>;
} {
  const runtimeRequire = eval("require") as (id: string) => any;
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

  const max = await store.getTextReasoningEffort();
  assert(max === "max", "既存保存effort maxを読み戻す");
  await store.setVisionReasoningEffort("max");
  assert(settings.llm_vision_reasoning_effort === "max", "max effortを保存できる");
  assert(loaded.writes.length > 0, "provider移行・選択保存をSQLiteへ書く");
}

