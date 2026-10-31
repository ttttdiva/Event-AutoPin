import { InputTextInput as TextInput } from "@/components/KeyboardLayout";
import { InputScrollView } from "@/components/KeyboardLayout";
import { useEffect, useState } from "react";
import {
  Alert,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  ActivityIndicator,
  ScrollView,
} from "react-native";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { ScreenSafeArea } from "@/components/ScreenSafeArea";
import { useTheme, type ThemeMode } from "@/lib/theme-context";
import { getColors } from "@/constants/Colors";
import { usePriorityColors } from "@/lib/priority-color-context";
import {
  type ApiKeyProvider,
  getApiKey,
  setApiKey,
  maskApiKey,
  type SavedModelSelection,
  REASONING_EFFORT_OPTIONS,
  type ReasoningEffort,
  getPrimaryModelSelection,
  setPrimaryModel,
  getFallbackModelSelection,
  setFallbackModel,
  getVisionModelSelection,
  setVisionModel,
  getSiteParsingModelSelection,
  setSiteParsingModel,
  getGrokSearchModelSelection,
  setGrokSearchModel,
  getTextReasoningEffort,
  setTextReasoningEffort,
  getVisionReasoningEffort,
  setVisionReasoningEffort,
  getSiteParsingReasoningEffort,
  setSiteParsingReasoningEffort,
  isGrokEnabled,
  setGrokEnabled,
  isVisionAnalysisEnabled,
  setVisionAnalysisEnabled,
  isGlobalSearchEnabled,
  setGlobalSearchEnabled,
} from "@/lib/settings-store";
import {
  getModelCatalogModels,
  getModelCatalogSnapshot,
  getModelCapabilities,
  refreshModelCatalog,
  subscribeModelCatalog,
  type ModelCatalogEntry,
  type ModelCatalogSnapshot,
} from "@/lib/model-catalog";
import { testApiKey } from "@/lib/crawl/llm-client";
import {
  getCurrentVersion,
  checkForUpdate,
  showUpdateAlert,
} from "@/lib/update-service";

type ProviderInfo = {
  id: ApiKeyProvider;
  label: string;
  placeholder: string;
  url: string;
};

const PROVIDERS: ProviderInfo[] = [
  {
    id: "gemini",
    label: "Google Gemini",
    placeholder: "AIzaSy...",
    url: "https://aistudio.google.com/apikey",
  },
  {
    id: "openai",
    label: "OpenAI",
    placeholder: "sk-...",
    url: "https://platform.openai.com/api-keys",
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    placeholder: "xai-...",
    url: "https://console.x.ai/",
  },
];

export default function SettingsScreen() {
  const { themeMode, effectiveScheme, setThemeMode } = useTheme();
  const colors = getColors(effectiveScheme);
  const {
    options: priorityOptions,
    setColor: setPriorityColor,
    reset: resetPriorityColors,
  } = usePriorityColors();

  const [apiKeys, setApiKeys] = useState<Record<ApiKeyProvider, string>>({
    openai: "",
    gemini: "",
    xai: "",
  });
  const [keyMasked, setKeyMasked] = useState<Record<ApiKeyProvider, boolean>>({
    openai: true,
    gemini: true,
    xai: true,
  });
  const [testing, setTesting] = useState<ApiKeyProvider | null>(null);

  const [primary, setPrimary] = useState<SavedModelSelection>({
    id: "",
    apiType: "openai",
  });
  const [fallback, setFallback] = useState<SavedModelSelection>({
    id: "",
    apiType: "openai",
  });
  const [vision, setVision] = useState<SavedModelSelection>({
    id: "",
    apiType: "gemini",
  });
  const [siteParsing, setSiteParsing] = useState<SavedModelSelection>({
    id: "",
    apiType: "openai",
  });
  const [grokSearch, setGrokSearch] = useState<SavedModelSelection>({
    id: "",
    apiType: "xai",
  });
  const [catalog, setCatalog] = useState<ModelCatalogSnapshot>(() =>
    getModelCatalogSnapshot(),
  );
  const [catalogRefreshing, setCatalogRefreshing] = useState(false);
  const [textEffort, setTextEffort] = useState<ReasoningEffort>("medium");
  const [visionEffort, setVisionEffort] = useState<ReasoningEffort>("medium");
  const [siteParsingEffort, setSiteParsingEffortState] =
    useState<ReasoningEffort>("medium");
  const [grokEnabled, setGrokEnabledState] = useState(false);
  const [visionEnabled, setVisionEnabledState] = useState(true);
  const [globalSearchEnabled, setGlobalSearchEnabledState] = useState(false);
  const [priorityColorInputs, setPriorityColorInputs] = useState<
    Record<number, string>
  >({});

  const [modelPickerFor, setModelPickerFor] = useState<
    null | "primary" | "fallback" | "vision" | "siteParsing" | "grokSearch"
  >(null);
  const [modelPickerQuery, setModelPickerQuery] = useState("");
  const [modelPickerProvider, setModelPickerProvider] = useState<
    ApiKeyProvider | "all"
  >("all");
  const [effortPickerFor, setEffortPickerFor] = useState<
    null | "text" | "vision" | "siteParsing"
  >(null);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = subscribeModelCatalog(() => {
      if (!cancelled) setCatalog(getModelCatalogSnapshot());
    });
    void (async () => {
      const [
        openai,
        gemini,
        xai,
        p,
        fb,
        v,
        sp,
        grokSearchSelection,
        textReasoning,
        visionReasoning,
        siteReasoning,
        grok,
        vis,
        globalSearch,
      ] = await Promise.all([
        getApiKey("openai"),
        getApiKey("gemini"),
        getApiKey("xai"),
        getPrimaryModelSelection(),
        getFallbackModelSelection(),
        getVisionModelSelection(),
        getSiteParsingModelSelection(),
        getGrokSearchModelSelection(),
        getTextReasoningEffort(),
        getVisionReasoningEffort(),
        getSiteParsingReasoningEffort(),
        isGrokEnabled(),
        isVisionAnalysisEnabled(),
        isGlobalSearchEnabled(),
      ]);
      if (cancelled) return;
      setApiKeys({
        openai: openai ?? "",
        gemini: gemini ?? "",
        xai: xai ?? "",
      });
      setPrimary(p);
      setFallback(fb);
      setVision(v);
      setSiteParsing(sp);
      setGrokSearch(grokSearchSelection);
      setTextEffort(textReasoning);
      setVisionEffort(visionReasoning);
      setSiteParsingEffortState(siteReasoning);
      setGrokEnabledState(grok);
      setVisionEnabledState(vis);
      setGlobalSearchEnabledState(globalSearch);
      const nextCatalog = await refreshModelCatalog();
      if (!cancelled) setCatalog(nextCatalog);
    })().catch(() => {
      // 個別 provider のエラーは catalog state に表示し、設定画面自体は開ける。
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    setPriorityColorInputs(
      Object.fromEntries(
        priorityOptions.map((option) => [option.value, option.color]),
      ) as Record<number, string>,
    );
  }, [priorityOptions]);

  const handleSaveKey = async (provider: ApiKeyProvider) => {
    try {
      await setApiKey(provider, apiKeys[provider].trim());
      const nextCatalog = await refreshModelCatalog(provider);
      setCatalog(nextCatalog);
      Alert.alert(
        "保存しました",
        `${provider} のAPIキーを保存し、モデル一覧を更新しました`,
      );
    } catch (e: any) {
      Alert.alert("保存エラー", e?.message ?? String(e));
    }
  };

  const handleTestKey = async (provider: ProviderInfo) => {
    const key = apiKeys[provider.id].trim();
    if (!key) {
      Alert.alert("未入力", "APIキーを入力してください");
      return;
    }
    setTesting(provider.id);
    try {
      const result = await testApiKey(provider.id, key);
      Alert.alert(
        result.ok ? "接続成功" : "接続失敗",
        result.message,
      );
    } finally {
      setTesting(null);
    }
  };

  const handleCheckUpdate = async () => {
    const result = await checkForUpdate();
    if (result.available) {
      showUpdateAlert(result);
    } else if (result.errorMessage) {
      Alert.alert(
        "更新確認に失敗しました",
        `現在のバージョン: v${result.currentVersion}\n\n${result.errorMessage}`,
      );
    } else {
      Alert.alert(
        "最新版です",
        `現在のバージョン: v${result.currentVersion}`,
      );
    }
  };

  const handleSavePriorityColor = async (priority: number) => {
    const ok = await setPriorityColor(priority, priorityColorInputs[priority] ?? "");
    if (!ok) {
      Alert.alert("カラーエラー", "#RRGGBB 形式で入力してください。");
    }
  };

  const handleResetPriorityColors = async () => {
    await resetPriorityColors();
    Alert.alert("リセットしました", "優先度カラーを初期値に戻しました。");
  };

  const openModelPicker = (
    target: "primary" | "fallback" | "vision" | "siteParsing" | "grokSearch",
  ) => {
    setModelPickerQuery("");
    setModelPickerProvider(target === "grokSearch" ? "xai" : "all");
    setModelPickerFor(target);
  };

  const onPickModel = async (
    target: "primary" | "fallback" | "vision" | "siteParsing" | "grokSearch",
    model: ModelCatalogEntry,
  ) => {
    setModelPickerFor(null);
    const selection: SavedModelSelection = {
      id: model.id,
      apiType: model.provider,
    };
    if (target === "primary") {
      setPrimary(selection);
      await setPrimaryModel(model.id, model.provider);
    } else if (target === "fallback") {
      setFallback(selection);
      await setFallbackModel(model.id, model.provider);
    } else if (target === "vision") {
      setVision(selection);
      await setVisionModel(model.id, model.provider);
    } else if (target === "siteParsing") {
      setSiteParsing(selection);
      await setSiteParsingModel(model.id, model.provider);
    } else {
      setGrokSearch(selection);
      await setGrokSearchModel(model.id);
    }
  };

  const onPickEffort = async (
    target: "text" | "vision" | "siteParsing",
    effort: ReasoningEffort,
  ) => {
    setEffortPickerFor(null);
    if (target === "text") {
      setTextEffort(effort);
      await setTextReasoningEffort(effort);
    } else if (target === "vision") {
      setVisionEffort(effort);
      await setVisionReasoningEffort(effort);
    } else {
      setSiteParsingEffortState(effort);
      await setSiteParsingReasoningEffort(effort);
    }
  };

  const renderThemeButton = (mode: ThemeMode, label: string) => {
    const selected = themeMode === mode;
    return (
      <TouchableOpacity
        key={mode}
        onPress={() => setThemeMode(mode)}
        style={[
          styles.themeBtn,
          {
            backgroundColor: selected ? colors.tint : colors.card,
            borderColor: selected ? colors.tint : colors.border,
          },
        ]}
      >
        <Text
          style={{
            color: selected ? "#fff" : colors.text,
            fontWeight: selected ? "700" : "500",
          }}
        >
          {label}
        </Text>
      </TouchableOpacity>
    );
  };

  const savedSelections = [primary, fallback, vision, siteParsing, grokSearch];

  const modelLabel = (selection: SavedModelSelection) => {
    const entry = getModelCatalogModels({ savedSelections }).find(
      (model) =>
        model.id === selection.id && model.provider === selection.apiType,
    );
    return entry?.label ?? selection.id;
  };

  const selectionForEffort = (
    target: "text" | "vision" | "siteParsing",
  ): SavedModelSelection => {
    if (target === "vision") return vision;
    if (target === "siteParsing") return siteParsing;
    return primary;
  };

  const effortOptionsForTarget = (
    target: "text" | "vision" | "siteParsing",
  ) => {
    const selection = selectionForEffort(target);
    const capabilities = getModelCapabilities(
      selection.apiType,
      selection.id,
      getModelCatalogModels({ savedSelections }),
    );
    const supported = new Set(capabilities.reasoningEfforts);
    return REASONING_EFFORT_OPTIONS.filter((option) => supported.has(option.id));
  };

  const effortLabel = (id: ReasoningEffort) => {
    const option = REASONING_EFFORT_OPTIONS.find((e) => e.id === id);
    return option ? `${option.label} - ${option.description}` : id;
  };

  const renderModelRow = (
    title: string,
    desc: string,
    current: SavedModelSelection,
    target: "primary" | "fallback" | "vision" | "siteParsing" | "grokSearch",
  ) => (
    <TouchableOpacity
      onPress={() => openModelPicker(target)}
      style={[
        styles.modelRow,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
    >
      <View style={{ flex: 1 }}>
        <Text style={[styles.modelTitle, { color: colors.text }]}>{title}</Text>
        <Text style={[styles.modelDesc, { color: colors.textSecondary }]}>
          {desc}
        </Text>
        <Text style={[styles.modelValue, { color: colors.tint }]}>
          {modelLabel(current)} ({current.apiType})
        </Text>
      </View>
      <FontAwesome name="chevron-right" size={14} color={colors.textSecondary} />
    </TouchableOpacity>
  );

  const renderEffortRow = (
    title: string,
    desc: string,
    current: ReasoningEffort,
    target: "text" | "vision" | "siteParsing",
  ) => (
    <TouchableOpacity
      onPress={() => setEffortPickerFor(target)}
      style={[
        styles.modelRow,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
    >
      <View style={{ flex: 1 }}>
        <Text style={[styles.modelTitle, { color: colors.text }]}>{title}</Text>
        <Text style={[styles.modelDesc, { color: colors.textSecondary }]}>
          {desc}
        </Text>
        <Text style={[styles.modelValue, { color: colors.tint }]}>
          {effortLabel(current)}
        </Text>
        {effortOptionsForTarget(target).every((option) => option.id !== current) && (
          <Text style={[styles.modelDesc, { color: colors.textSecondary }]}>
            選択モデルでは能力未確認のため、実行時はAPI既定値を使用
          </Text>
        )}
      </View>
      <FontAwesome name="chevron-right" size={14} color={colors.textSecondary} />
    </TouchableOpacity>
  );

  const refreshCatalog = async () => {
    setCatalogRefreshing(true);
    try {
      const nextCatalog = await refreshModelCatalog();
      setCatalog(nextCatalog);
    } finally {
      setCatalogRefreshing(false);
    }
  };

  const catalogStatusLabel = (provider: ApiKeyProvider): string => {
    const state = catalog.providers[provider];
    if (state.status === "loading") return "取得中…";
    if (state.status === "credential-missing") return "認証情報未設定";
    if (state.status === "error") {
      return state.stale ? "取得失敗・前回候補を表示中" : "取得失敗";
    }
    if (state.status === "ready") {
      const suffix = state.fetchedAt
        ? `（${new Date(state.fetchedAt).toLocaleString()}）`
        : "";
      return `${state.models.length}件・取得済み${suffix}`;
    }
    return "未取得（初期候補を表示）";
  };

  const modelSourceLabel = (model: ModelCatalogEntry): string => {
    if (model.source === "stale-cache") return "前回取得候補（更新失敗）";
    if (model.source === "provider-api") {
      return model.capabilityStatus === "unknown"
        ? "API取得・能力未確認"
        : "API取得・能力確認済み";
    }
    if (model.source === "saved") return "保存済み（一覧未確認）";
    return "初期候補（未取得）";
  };

  const pickerModels = modelPickerFor
    ? getModelCatalogModels({
        role: modelPickerFor === "vision" ? "vision" : "text",
        savedSelections,
      }).filter((model) => {
        const matchesProvider =
          modelPickerFor === "grokSearch"
            ? model.provider === "xai"
            : modelPickerProvider === "all" || model.provider === modelPickerProvider;
        const query = modelPickerQuery.trim().toLowerCase();
        const matchesQuery =
          !query ||
          model.id.toLowerCase().includes(query) ||
          model.label.toLowerCase().includes(query);
        return matchesProvider && matchesQuery;
      })
    : [];

  return (
    <ScreenSafeArea
      style={[styles.container, { backgroundColor: colors.background }]}
    >
      <InputScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
      >
        <Text style={[styles.h1, { color: colors.text }]}>設定</Text>

        {/* テーマ */}
        <Text style={[styles.sectionTitle, { color: colors.text }]}>
          テーマ
        </Text>
        <View style={styles.themeRow}>
          {renderThemeButton("light", "ライト")}
          {renderThemeButton("dark", "ダーク")}
          {renderThemeButton("auto", "システム")}
        </View>

        <Text style={[styles.sectionTitle, { color: colors.text }]}>
          優先度カラー
        </Text>
        <View
          style={[
            styles.card,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          {priorityOptions.map((option) => (
            <View key={option.value} style={styles.priorityColorRow}>
              <View
                style={[
                  styles.priorityColorSwatch,
                  { backgroundColor: option.color },
                ]}
              />
              <Text style={[styles.priorityColorLabel, { color: colors.text }]}>
                {option.label}
              </Text>
              <TextInput
                style={[
                  styles.priorityColorInput,
                  {
                    color: colors.text,
                    borderColor: colors.border,
                    backgroundColor: colors.inputBackground,
                  },
                ]}
                value={priorityColorInputs[option.value] ?? option.color}
                onChangeText={(text) =>
                  setPriorityColorInputs((prev) => ({
                    ...prev,
                    [option.value]: text,
                  }))
                }
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="#ff6600"
                placeholderTextColor={colors.textSecondary}
              />
              <TouchableOpacity
                style={[styles.priorityColorSave, { borderColor: colors.tint }]}
                onPress={() => handleSavePriorityColor(option.value)}
              >
                <FontAwesome name="check" size={14} color={colors.tint} />
              </TouchableOpacity>
            </View>
          ))}
          <TouchableOpacity
            style={[styles.resetBtn, { borderColor: colors.border }]}
            onPress={handleResetPriorityColors}
          >
            <Text style={[styles.resetBtnText, { color: colors.textSecondary }]}>
              初期値に戻す
            </Text>
          </TouchableOpacity>
        </View>

        {/* APIキー */}
        <Text style={[styles.sectionTitle, { color: colors.text }]}>
          APIキー
        </Text>
        <Text style={[styles.description, { color: colors.textSecondary }]}>
          クロール機能でAI解析を行うために必要です。端末内に暗号化保存されます。
        </Text>

        {PROVIDERS.map((p) => {
          const value = apiKeys[p.id];
          const masked = keyMasked[p.id];
          return (
            <View
              key={p.id}
              style={[
                styles.card,
                { backgroundColor: colors.card, borderColor: colors.border },
              ]}
            >
              <Text style={[styles.label, { color: colors.text }]}>
                {p.label}
              </Text>
              <View style={styles.inputRow}>
                <TextInput
                  style={[
                    styles.input,
                    {
                      color: colors.text,
                      backgroundColor: colors.inputBackground,
                      borderColor: colors.border,
                    },
                  ]}
                  placeholder={p.placeholder}
                  placeholderTextColor={colors.textSecondary}
                  value={value}
                  secureTextEntry={masked}
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={(t) =>
                    setApiKeys((prev) => ({ ...prev, [p.id]: t }))
                  }
                />
                <TouchableOpacity
                  onPress={() =>
                    setKeyMasked((prev) => ({ ...prev, [p.id]: !prev[p.id] }))
                  }
                  style={styles.eyeBtn}
                >
                  <FontAwesome
                    name={masked ? "eye" : "eye-slash"}
                    size={18}
                    color={colors.textSecondary}
                  />
                </TouchableOpacity>
              </View>
              <Text style={[styles.maskedText, { color: colors.textSecondary }]}>
                保存済み: {maskApiKey(value || null)}
              </Text>
              <View style={styles.btnRow}>
                <TouchableOpacity
                  style={[styles.btn, { backgroundColor: colors.tint }]}
                  onPress={() => handleSaveKey(p.id)}
                >
                  <Text style={styles.btnText}>保存</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.btn,
                    {
                      backgroundColor: colors.card,
                      borderWidth: 1,
                      borderColor: colors.tint,
                    },
                  ]}
                  onPress={() => handleTestKey(p)}
                  disabled={testing === p.id}
                >
                  {testing === p.id ? (
                    <ActivityIndicator size="small" color={colors.tint} />
                  ) : (
                    <Text style={[styles.btnText, { color: colors.tint }]}>
                      接続テスト
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          );
        })}

        {/* モデル選択 */}
        <Text style={[styles.sectionTitle, { color: colors.text }]}>
          LLMモデル
        </Text>
        <View
          style={[
            styles.catalogStatusCard,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <Text style={[styles.modelDesc, { color: colors.textSecondary }]}>
            APIのモデル一覧を読み取り専用で取得します。未取得の初期候補と、能力未確認の新しいIDは明示して表示します。
          </Text>
          {PROVIDERS.map((provider) => (
            <Text
              key={provider.id}
              style={[styles.catalogStatusText, { color: colors.textSecondary }]}
            >
              {provider.label}: {catalogStatusLabel(provider.id)}
            </Text>
          ))}
          <TouchableOpacity
            style={[styles.btn, { backgroundColor: colors.tint, marginTop: 10 }]}
            onPress={refreshCatalog}
            disabled={catalogRefreshing}
          >
            {catalogRefreshing ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.btnText}>モデル一覧を再取得</Text>
            )}
          </TouchableOpacity>
        </View>
        {renderModelRow(
          "メインモデル",
          "クロール時の第一選択（保存済み設定を維持）",
          primary,
          "primary",
        )}
        {renderModelRow(
          "フォールバックモデル",
          "メインが失敗した時に自動で切り替え",
          fallback,
          "fallback",
        )}
        {renderModelRow(
          "画像解析モデル",
          "サークルカットの画像解析（ジャンル判定等）",
          vision,
          "vision",
        )}
        {renderModelRow(
          "サイト解析モデル",
          "未知サイトのパターン推測（高性能モデル推奨）",
          siteParsing,
          "siteParsing",
        )}
        {renderEffortRow(
          "テキスト処理effort",
          "OpenAI APIモデル利用時の推論量",
          textEffort,
          "text",
        )}
        {renderEffortRow(
          "画像解析effort",
          "OpenAI APIで画像解析する場合の推論量",
          visionEffort,
          "vision",
        )}
        {renderEffortRow(
          "サイト解析effort",
          "未知サイト抽出でOpenAI APIを使う場合の推論量",
          siteParsingEffort,
          "siteParsing",
        )}

        {/* 機能フラグ */}
        <Text style={[styles.sectionTitle, { color: colors.text }]}>
          機能
        </Text>
        <TouchableOpacity
          style={[
            styles.toggleRow,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
          onPress={async () => {
            const next = !globalSearchEnabled;
            setGlobalSearchEnabledState(next);
            await setGlobalSearchEnabled(next);
          }}
        >
          <View style={{ flex: 1 }}>
            <Text style={[styles.modelTitle, { color: colors.text }]}>
              全体検索をON
            </Text>
            <Text style={[styles.modelDesc, { color: colors.textSecondary }]}>
              サークル名・ペンネーム・アイテム名・メモを検索
            </Text>
          </View>
          <FontAwesome
            name={globalSearchEnabled ? "toggle-on" : "toggle-off"}
            size={32}
            color={globalSearchEnabled ? colors.tint : colors.textSecondary}
          />
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.toggleRow,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
          onPress={async () => {
            const next = !visionEnabled;
            setVisionEnabledState(next);
            await setVisionAnalysisEnabled(next);
          }}
        >
          <View style={{ flex: 1 }}>
            <Text style={[styles.modelTitle, { color: colors.text }]}>
              画像解析を有効化
            </Text>
            <Text style={[styles.modelDesc, { color: colors.textSecondary }]}>
              サークルカットからジャンル情報を推定
            </Text>
          </View>
          <FontAwesome
            name={visionEnabled ? "toggle-on" : "toggle-off"}
            size={32}
            color={visionEnabled ? colors.tint : colors.textSecondary}
          />
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.toggleRow,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
          onPress={async () => {
            const next = !grokEnabled;
            setGrokEnabledState(next);
            await setGrokEnabled(next);
          }}
        >
          <View style={{ flex: 1 }}>
            <Text style={[styles.modelTitle, { color: colors.text }]}>
              Grok（X）おしながき取得を有効化
            </Text>
            <Text style={[styles.modelDesc, { color: colors.textSecondary }]}>
              xAI APIでXのおしながき投稿を検索
            </Text>
          </View>
          <FontAwesome
            name={grokEnabled ? "toggle-on" : "toggle-off"}
            size={32}
            color={grokEnabled ? colors.tint : colors.textSecondary}
          />
        </TouchableOpacity>

        {renderModelRow(
          "Grok検索モデル",
          "Xのおしながき検索で使うxAIモデル。未取得の保存値も保持します",
          grokSearch,
          "grokSearch",
        )}

        {/* バージョン */}
        <Text style={[styles.sectionTitle, { color: colors.text }]}>
          アプリ情報
        </Text>
        <View
          style={[
            styles.card,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <Text style={[styles.label, { color: colors.text }]}>
            バージョン: v{getCurrentVersion()}
          </Text>
          <TouchableOpacity
            style={[
              styles.btn,
              { backgroundColor: colors.tint, marginTop: 12 },
            ]}
            onPress={handleCheckUpdate}
          >
            <Text style={styles.btnText}>更新を確認</Text>
          </TouchableOpacity>
        </View>

        <View style={{ height: 40 }} />

        {/* モデルピッカー（インラインモーダル相当） */}
        {modelPickerFor && (
          <View
            style={[
              styles.pickerOverlay,
              { backgroundColor: effectiveScheme === "dark" ? "#000a" : "#0006" },
            ]}
          >
            <View
              style={[
                styles.pickerBox,
                { backgroundColor: colors.card, borderColor: colors.border },
              ]}
            >
              <Text style={[styles.pickerTitle, { color: colors.text }]}>
                モデルを選択
              </Text>
              <TextInput
                style={[
                  styles.pickerSearch,
                  {
                    color: colors.text,
                    backgroundColor: colors.inputBackground,
                    borderColor: colors.border,
                  },
                ]}
                value={modelPickerQuery}
                onChangeText={setModelPickerQuery}
                placeholder="モデルID・表示名で検索"
                placeholderTextColor={colors.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <View style={styles.providerFilterRow}>
                {(["all", ...PROVIDERS.map((provider) => provider.id)] as const).map(
                  (provider) => {
                    const selected = modelPickerProvider === provider;
                    const label =
                      provider === "all"
                        ? "すべて"
                        : PROVIDERS.find((item) => item.id === provider)?.label ??
                          provider;
                    return (
                      <TouchableOpacity
                        key={provider}
                        onPress={() => setModelPickerProvider(provider)}
                        style={[
                          styles.providerFilterButton,
                          {
                            backgroundColor: selected
                              ? colors.tint
                              : colors.inputBackground,
                            borderColor: selected ? colors.tint : colors.border,
                          },
                        ]}
                      >
                        <Text
                          style={{
                            color: selected ? "#fff" : colors.text,
                            fontSize: 12,
                          }}
                        >
                          {label}
                        </Text>
                      </TouchableOpacity>
                    );
                  },
                )}
              </View>
              <ScrollView style={styles.pickerList}>
                {pickerModels.length === 0 ? (
                  <Text style={[styles.modelDesc, { color: colors.textSecondary }]}>
                    条件に一致する候補がありません
                  </Text>
                ) : (
                  pickerModels.map((m) => (
                    <TouchableOpacity
                      key={`${m.provider}:${m.id}`}
                      style={[
                        styles.pickerItem,
                        { borderBottomColor: colors.border },
                      ]}
                      onPress={() => onPickModel(modelPickerFor, m)}
                    >
                      <Text style={{ color: colors.text, fontSize: 15 }}>
                        {m.label}
                      </Text>
                      <Text
                        style={{ color: colors.textSecondary, fontSize: 12 }}
                      >
                        {m.id} ({m.provider}) · {modelSourceLabel(m)}
                      </Text>
                    </TouchableOpacity>
                  ))
                )}
              </ScrollView>
              <TouchableOpacity
                style={[styles.btn, { backgroundColor: colors.border }]}
                onPress={() => {
                  setModelPickerFor(null);
                  setModelPickerQuery("");
                  setModelPickerProvider("all");
                }}
              >
                <Text style={[styles.btnText, { color: colors.text }]}>
                  キャンセル
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {effortPickerFor && (
          <View
            style={[
              styles.pickerOverlay,
              { backgroundColor: effectiveScheme === "dark" ? "#000a" : "#0006" },
            ]}
          >
            <View
              style={[
                styles.pickerBox,
                { backgroundColor: colors.card, borderColor: colors.border },
              ]}
            >
              <Text style={[styles.pickerTitle, { color: colors.text }]}>
                effortを選択
              </Text>
              {effortOptionsForTarget(effortPickerFor).map((effort) => (
                <TouchableOpacity
                  key={effort.id}
                  style={[
                    styles.pickerItem,
                    { borderBottomColor: colors.border },
                  ]}
                  onPress={() => onPickEffort(effortPickerFor, effort.id)}
                >
                  <Text style={{ color: colors.text, fontSize: 15 }}>
                    {effort.label}
                  </Text>
                  <Text
                    style={{ color: colors.textSecondary, fontSize: 12 }}
                  >
                    {effort.description}
                  </Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity
                style={[styles.btn, { backgroundColor: colors.border }]}
                onPress={() => setEffortPickerFor(null)}
              >
                <Text style={[styles.btnText, { color: colors.text }]}>
                  キャンセル
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </InputScrollView>
    </ScreenSafeArea>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16, paddingBottom: 60 },
  h1: { fontSize: 24, fontWeight: "700", marginBottom: 8 },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "700",
    marginTop: 20,
    marginBottom: 8,
  },
  description: { fontSize: 13, marginBottom: 12, lineHeight: 18 },
  themeRow: { flexDirection: "row", gap: 8 },
  themeBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
  },
  priorityColorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 10,
  },
  priorityColorSwatch: {
    width: 22,
    height: 22,
    borderRadius: 11,
  },
  priorityColorLabel: {
    width: 64,
    fontSize: 13,
    fontWeight: "600",
  },
  priorityColorInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 13,
  },
  priorityColorSave: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  resetBtn: {
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 6,
    paddingVertical: 9,
    marginTop: 2,
  },
  resetBtnText: {
    fontSize: 13,
    fontWeight: "600",
  },
  card: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
  },
  catalogStatusCard: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
  },
  catalogStatusText: { fontSize: 12, marginTop: 4 },
  label: { fontSize: 14, fontWeight: "600", marginBottom: 8 },
  inputRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
  },
  eyeBtn: { padding: 8 },
  maskedText: { fontSize: 12, marginTop: 4 },
  btnRow: { flexDirection: "row", gap: 8, marginTop: 10 },
  btn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: "center",
  },
  btnText: { color: "#fff", fontWeight: "600" },
  modelRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    borderWidth: 1,
    borderRadius: 10,
    marginBottom: 8,
  },
  modelTitle: { fontSize: 14, fontWeight: "600" },
  modelDesc: { fontSize: 12, marginTop: 2 },
  modelValue: { fontSize: 13, marginTop: 4, fontWeight: "600" },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    borderWidth: 1,
    borderRadius: 10,
    marginBottom: 8,
  },
  pickerOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: "center",
    padding: 20,
  },
  pickerBox: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    maxHeight: "80%",
  },
  pickerTitle: { fontSize: 16, fontWeight: "700", marginBottom: 12 },
  pickerSearch: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    marginBottom: 8,
  },
  providerFilterRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginBottom: 8,
  },
  providerFilterButton: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  pickerList: { maxHeight: 420 },
  pickerItem: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
