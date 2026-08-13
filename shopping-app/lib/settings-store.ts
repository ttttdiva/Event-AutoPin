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
export const DEFAULT_REASONING_EFFORT = "medium";

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

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
];

export interface ModelChoice {
  id: string;
  label: string;
  provider: ApiKeyProvider;
  vision: boolean;
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

export async function getPrimaryModel(): Promise<string> {
  return (await getSetting(MODEL_SETTING_KEY)) ?? DEFAULT_PRIMARY_MODEL;
}

export async function setPrimaryModel(model: string): Promise<void> {
  await setSetting(MODEL_SETTING_KEY, model);
}

export async function getFallbackModel(): Promise<string> {
  return (await getSetting(MODEL_FALLBACK_KEY)) ?? DEFAULT_FALLBACK_MODEL;
}

export async function setFallbackModel(model: string): Promise<void> {
  await setSetting(MODEL_FALLBACK_KEY, model);
}

export async function getVisionModel(): Promise<string> {
  return (await getSetting(VISION_MODEL_KEY)) ?? DEFAULT_VISION_MODEL;
}

export async function setVisionModel(model: string): Promise<void> {
  await setSetting(VISION_MODEL_KEY, model);
}

export async function getSiteParsingModel(): Promise<string> {
  return (await getSetting(SITE_PARSING_MODEL_KEY)) ?? DEFAULT_SITE_PARSING_MODEL;
}

export async function setSiteParsingModel(model: string): Promise<void> {
  await setSetting(SITE_PARSING_MODEL_KEY, model);
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
