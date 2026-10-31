/**
 * アプリ設定ストア
 *
 * - APIキーは expo-secure-store で暗号化保存
 * - モデル選択・Cookie一覧等の非機密設定は SQLite app_settings (getSetting/setSetting)
 */
import * as SecureStore from "expo-secure-store";
import { getSetting, setSetting } from "./database";
import {
  normalizeHex,
  normalizePriorityPalette,
  tintColor,
  type PriorityPalette,
} from "./priority-colors";
import { PRIORITY_COLORS } from "./types";

// --- APIキー（secure-store） ---

export type ApiKeyProvider = "openai" | "gemini" | "xai";

const API_KEY_STORAGE_PREFIX = "apikey_";

export async function getApiKey(
  provider: ApiKeyProvider,
): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(API_KEY_STORAGE_PREFIX + provider);
  } catch {
    return null;
  }
}

export async function setApiKey(
  provider: ApiKeyProvider,
  key: string,
): Promise<void> {
  if (!key) {
    await SecureStore.deleteItemAsync(API_KEY_STORAGE_PREFIX + provider);
    return;
  }
  await SecureStore.setItemAsync(API_KEY_STORAGE_PREFIX + provider, key);
}

export async function getAllApiKeys(): Promise<
  Record<ApiKeyProvider, string | null>
> {
  const [openai, gemini, xai] = await Promise.all([
    getApiKey("openai"),
    getApiKey("gemini"),
    getApiKey("xai"),
  ]);
  return { openai, gemini, xai };
}

/** マスク表示（末尾4桁のみ） */
export function maskApiKey(key: string | null | undefined): string {
  if (!key) return "(未設定)";
  if (key.length < 8) return "****";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

// --- LLMモデル設定（SQLite） ---

export const MODEL_SETTING_KEY = "llm_primary_model";
export const MODEL_FALLBACK_KEY = "llm_fallback_model";
export const VISION_MODEL_KEY = "llm_vision_model";
export const SITE_PARSING_MODEL_KEY = "llm_site_parsing_model";
export const GROK_SEARCH_MODEL_KEY = "llm_grok_search_model";
/** モデル ID と別 SQLite キーに provider を保存し、同名 ID の取り違えを防ぐ。 */
export const MODEL_PROVIDER_KEY = "llm_primary_model_provider";
export const MODEL_FALLBACK_PROVIDER_KEY = "llm_fallback_model_provider";
export const VISION_MODEL_PROVIDER_KEY = "llm_vision_model_provider";
export const SITE_PARSING_MODEL_PROVIDER_KEY = "llm_site_parsing_model_provider";
export const TEXT_REASONING_EFFORT_KEY = "llm_text_reasoning_effort";
export const VISION_REASONING_EFFORT_KEY = "llm_vision_reasoning_effort";
export const SITE_PARSING_REASONING_EFFORT_KEY =
  "llm_site_parsing_reasoning_effort";
export const GROK_ENABLED_KEY = "grok_enabled";
export const VISION_ANALYSIS_ENABLED_KEY = "vision_analysis_enabled";
export const PRIORITY_PALETTE_KEY = "settings_priority_palette_json";
export const GLOBAL_SEARCH_ENABLED_KEY = "settings_global_search_enabled";
let globalSearchCache: boolean | null = null;
const LEGACY_PRIORITY_PALETTE_KEY = "priority_palette_json";

// Gemini 3 Flash がデフォルト（テキスト + 画像両用）
export const DEFAULT_PRIMARY_MODEL = "gpt-5.6-sol";
export const DEFAULT_FALLBACK_MODEL = "gpt-5-mini";
export const DEFAULT_VISION_MODEL = "gemini-3-flash-preview";
export const DEFAULT_SITE_PARSING_MODEL = "gpt-5.6-sol";
export const DEFAULT_GROK_SEARCH_MODEL = "grok-2-latest";
export const DEFAULT_REASONING_EFFORT = "medium";

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface ReasoningEffortChoice {
  id: ReasoningEffort;
  label: string;
  description: string;
}

export const REASONING_EFFORT_OPTIONS: ReasoningEffortChoice[] = [
  {
    id: "none",
    label: "指定なし",
    description: "API既定値を使用",
  },
  {
    id: "minimal",
    label: "minimal",
    description: "軽量・高速",
  },
  {
    id: "low",
    label: "low",
    description: "低め",
  },
  {
    id: "medium",
    label: "medium",
    description: "標準",
  },
  {
    id: "high",
    label: "high",
    description: "高精度寄り",
  },
  {
    id: "xhigh",
    label: "xhigh",
    description: "最大寄り",
  },
  {
    id: "max",
    label: "max",
    description: "最大",
  },
];

export interface ModelChoice {
  id: string;
  label: string;
  provider: ApiKeyProvider;
  vision: boolean;
}

/** 保存済みモデル。provider を必ず解決した状態で各 client へ渡す。 */
export interface SavedModelSelection {
  id: string;
  apiType: ApiKeyProvider;
}

/** 選択可能モデル一覧 */
export const AVAILABLE_MODELS: ModelChoice[] = [
  {
    id: "gemini-3-flash-preview",
    label: "Gemini 3 Flash (推奨・安価)",
    provider: "gemini",
    vision: true,
  },
  {
    id: "gemini-3.1-pro-preview",
    label: "Gemini 3 Pro (高性能)",
    provider: "gemini",
    vision: true,
  },
  {
    id: "gemini-3.1-flash-lite-preview",
    label: "Gemini 3 Flash Lite (最安)",
    provider: "gemini",
    vision: true,
  },
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol (高性能)",
    provider: "openai",
    vision: true,
  },
  {
    id: "gpt-5-mini",
    label: "GPT-5 Mini",
    provider: "openai",
    vision: true,
  },
  {
    id: "gpt-5.4",
    label: "GPT-5.4 (高性能)",
    provider: "openai",
    vision: true,
  },
];

function normalizeApiKeyProvider(value: string | null): ApiKeyProvider | null {
  if (value === "openai" || value === "gemini" || value === "xai") return value;
  return null;
}

/** 旧バージョンの ID-only 設定を壊さずに provider へ移行する。 */
export function inferApiKeyProvider(modelId: string): ApiKeyProvider {
  const normalized = modelId.trim().toLowerCase();
  if (normalized.startsWith("gemini")) return "gemini";
  if (normalized.startsWith("grok")) return "xai";
  return "openai";
}

interface ModelSettingDefinition {
  modelKey: string;
  providerKey: string;
  defaultId: string;
  defaultProvider: ApiKeyProvider;
}

async function getSavedModelSelection(
  definition: ModelSettingDefinition,
): Promise<SavedModelSelection> {
  const [storedId, storedProvider] = await Promise.all([
    getSetting(definition.modelKey),
    getSetting(definition.providerKey),
  ]);
  const id = storedId?.trim() || definition.defaultId;
  // 明示 provider を ID の接頭辞推測より常に優先する。
  const apiType =
    normalizeApiKeyProvider(storedProvider) ??
    (storedId ? inferApiKeyProvider(id) : definition.defaultProvider);
  // provider 列がない旧データだけ別キーへ移行する。ID/effort/API key は変更しない。
  if (!storedProvider) {
    try {
      await setSetting(definition.providerKey, apiType);
    } catch {
      // 読み取り自体は成功しているため、保存領域の一時エラーで設定を失わない。
    }
  }
  return { id, apiType };
}

async function setSavedModelSelection(
  definition: ModelSettingDefinition,
  modelId: string,
  provider?: ApiKeyProvider,
): Promise<void> {
  const id = modelId.trim();
  if (!id) return;
  // provider を明示して保存する呼び出し元（動的 picker）を優先する。
  const apiType = provider ?? inferApiKeyProvider(id);
  await setSetting(definition.modelKey, id);
  await setSetting(definition.providerKey, apiType);
}

const PRIMARY_MODEL_DEFINITION: ModelSettingDefinition = {
  modelKey: MODEL_SETTING_KEY,
  providerKey: MODEL_PROVIDER_KEY,
  defaultId: DEFAULT_PRIMARY_MODEL,
  defaultProvider: "openai",
};
const FALLBACK_MODEL_DEFINITION: ModelSettingDefinition = {
  modelKey: MODEL_FALLBACK_KEY,
  providerKey: MODEL_FALLBACK_PROVIDER_KEY,
  defaultId: DEFAULT_FALLBACK_MODEL,
  defaultProvider: "openai",
};
const VISION_MODEL_DEFINITION: ModelSettingDefinition = {
  modelKey: VISION_MODEL_KEY,
  providerKey: VISION_MODEL_PROVIDER_KEY,
  defaultId: DEFAULT_VISION_MODEL,
  defaultProvider: "gemini",
};
const SITE_PARSING_MODEL_DEFINITION: ModelSettingDefinition = {
  modelKey: SITE_PARSING_MODEL_KEY,
  providerKey: SITE_PARSING_MODEL_PROVIDER_KEY,
  defaultId: DEFAULT_SITE_PARSING_MODEL,
  defaultProvider: "openai",
};

export function getPrimaryModelSelection(): Promise<SavedModelSelection> {
  return getSavedModelSelection(PRIMARY_MODEL_DEFINITION);
}

export function getFallbackModelSelection(): Promise<SavedModelSelection> {
  return getSavedModelSelection(FALLBACK_MODEL_DEFINITION);
}

export function getVisionModelSelection(): Promise<SavedModelSelection> {
  return getSavedModelSelection(VISION_MODEL_DEFINITION);
}

export function getSiteParsingModelSelection(): Promise<SavedModelSelection> {
  return getSavedModelSelection(SITE_PARSING_MODEL_DEFINITION);
}

/** Grok検索は xAI 固定。旧バージョンの暗黙 grok-2-latest も保存値として扱う。 */
export async function getGrokSearchModelSelection(): Promise<SavedModelSelection> {
  const stored = await getSetting(GROK_SEARCH_MODEL_KEY);
  return {
    id: stored?.trim() || DEFAULT_GROK_SEARCH_MODEL,
    apiType: "xai",
  };
}

export async function getGrokSearchModel(): Promise<string> {
  return (await getGrokSearchModelSelection()).id;
}

export async function setGrokSearchModel(modelId: string): Promise<void> {
  const id = modelId.trim();
  if (!id) return;
  await setSetting(GROK_SEARCH_MODEL_KEY, id);
}

export async function getPrimaryModel(): Promise<string> {
  return (await getPrimaryModelSelection()).id;
}

export async function setPrimaryModel(
  model: string,
  provider?: ApiKeyProvider,
): Promise<void> {
  await setSavedModelSelection(PRIMARY_MODEL_DEFINITION, model, provider);
}

export async function getFallbackModel(): Promise<string> {
  return (await getFallbackModelSelection()).id;
}

export async function setFallbackModel(
  model: string,
  provider?: ApiKeyProvider,
): Promise<void> {
  await setSavedModelSelection(FALLBACK_MODEL_DEFINITION, model, provider);
}

export async function getVisionModel(): Promise<string> {
  return (await getVisionModelSelection()).id;
}

export async function setVisionModel(
  model: string,
  provider?: ApiKeyProvider,
): Promise<void> {
  await setSavedModelSelection(VISION_MODEL_DEFINITION, model, provider);
}

export async function getSiteParsingModel(): Promise<string> {
  return (await getSiteParsingModelSelection()).id;
}

export async function setSiteParsingModel(
  model: string,
  provider?: ApiKeyProvider,
): Promise<void> {
  await setSavedModelSelection(SITE_PARSING_MODEL_DEFINITION, model, provider);
}

function normalizeReasoningEffort(value: string | null): ReasoningEffort {
  return REASONING_EFFORT_OPTIONS.some((option) => option.id === value)
    ? (value as ReasoningEffort)
    : DEFAULT_REASONING_EFFORT;
}

export async function getTextReasoningEffort(): Promise<ReasoningEffort> {
  return normalizeReasoningEffort(await getSetting(TEXT_REASONING_EFFORT_KEY));
}

export async function setTextReasoningEffort(
  effort: ReasoningEffort,
): Promise<void> {
  await setSetting(TEXT_REASONING_EFFORT_KEY, effort);
}

export async function getVisionReasoningEffort(): Promise<ReasoningEffort> {
  return normalizeReasoningEffort(await getSetting(VISION_REASONING_EFFORT_KEY));
}

export async function setVisionReasoningEffort(
  effort: ReasoningEffort,
): Promise<void> {
  await setSetting(VISION_REASONING_EFFORT_KEY, effort);
}

export async function getSiteParsingReasoningEffort(): Promise<ReasoningEffort> {
  return normalizeReasoningEffort(
    await getSetting(SITE_PARSING_REASONING_EFFORT_KEY),
  );
}

export async function setSiteParsingReasoningEffort(
  effort: ReasoningEffort,
): Promise<void> {
  await setSetting(SITE_PARSING_REASONING_EFFORT_KEY, effort);
}

export async function isGrokEnabled(): Promise<boolean> {
  return (await getSetting(GROK_ENABLED_KEY)) === "1";
}

export async function setGrokEnabled(enabled: boolean): Promise<void> {
  await setSetting(GROK_ENABLED_KEY, enabled ? "1" : "0");
}

export async function isVisionAnalysisEnabled(): Promise<boolean> {
  return (await getSetting(VISION_ANALYSIS_ENABLED_KEY)) !== "0";
}

export async function setVisionAnalysisEnabled(enabled: boolean): Promise<void> {
  await setSetting(VISION_ANALYSIS_ENABLED_KEY, enabled ? "1" : "0");
}

export async function isGlobalSearchEnabled(): Promise<boolean> {
  if (globalSearchCache != null) return globalSearchCache;
  globalSearchCache = (await getSetting(GLOBAL_SEARCH_ENABLED_KEY)) === "1";
  return globalSearchCache;
}

export async function setGlobalSearchEnabled(enabled: boolean): Promise<void> {
  globalSearchCache = enabled;
  await setSetting(GLOBAL_SEARCH_ENABLED_KEY, enabled ? "1" : "0");
}

export async function getPriorityPaletteSetting(): Promise<PriorityPalette> {
  const raw =
    (await getSetting(PRIORITY_PALETTE_KEY)) ??
    (await getSetting(LEGACY_PRIORITY_PALETTE_KEY));
  if (!raw) return normalizePriorityPalette(PRIORITY_COLORS);
  try {
    const palette = normalizePriorityPalette(JSON.parse(raw));
    await setSetting(PRIORITY_PALETTE_KEY, JSON.stringify(palette));
    return palette;
  } catch {
    return normalizePriorityPalette(PRIORITY_COLORS);
  }
}

export async function setPriorityPaletteSetting(
  priority: number,
  colorInput: string,
): Promise<PriorityPalette | null> {
  const color = normalizeHex(colorInput);
  if (!color || !PRIORITY_COLORS[priority]) return null;
  const current = await getPriorityPaletteSetting();
  const next = normalizePriorityPalette({
    ...current,
    [priority]: {
      ...current[priority],
      color,
      bgColor: tintColor(color),
    },
  });
  await setSetting(PRIORITY_PALETTE_KEY, JSON.stringify(next));
  return next;
}

export async function resetPriorityPaletteSetting(): Promise<PriorityPalette> {
  const next = normalizePriorityPalette(PRIORITY_COLORS);
  await setSetting(PRIORITY_PALETTE_KEY, JSON.stringify(next));
  return next;
}

// --- Cookie一覧 ---

const COOKIE_LIST_KEY = "cookie_files";

export interface CookieFile {
  domain: string;
  path: string;
}

export async function getCookieFiles(): Promise<CookieFile[]> {
  const raw = await getSetting(COOKIE_LIST_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as CookieFile[];
  } catch {
    return [];
  }
}

export async function addCookieFile(file: CookieFile): Promise<void> {
  const current = await getCookieFiles();
  const filtered = current.filter((f) => f.domain !== file.domain);
  filtered.push(file);
  await setSetting(COOKIE_LIST_KEY, JSON.stringify(filtered));
}

export async function removeCookieFile(domain: string): Promise<void> {
  const current = await getCookieFiles();
  const filtered = current.filter((f) => f.domain !== domain);
  await setSetting(COOKIE_LIST_KEY, JSON.stringify(filtered));
}
