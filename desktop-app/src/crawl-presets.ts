/** クロール設定プリセットの純粋なlocalStorageアダプタ。 */

export type CrawlPreset<T = Record<string, unknown>> = {
  name: string;
  value: T;
  updatedAt: string;
};

export const CRAWL_PRESETS_STORAGE_KEY = "eventtrail-crawl-presets-v1";

/** AIモデルpresetだけが所有するDOM value。実行オプションはイベント設定なので含めない。 */
export const CRAWL_MODEL_PRESET_FORM_IDS = [
  "modelProvider", "model", "textReasoningEffort", "textFallbackModelProvider",
  "textFallbackModel", "textFallbackReasoningEffort", "textFallbackEnabled",
  "visionModel", "visionModelId", "visionReasoningEffort", "visionFallbackModelProvider",
  "visionFallbackModel", "visionFallbackReasoningEffort", "imageFallbackEnabled",
  "siteStructureModelProvider", "siteStructureModel", "siteStructureReasoningEffort",
  "siteStructureFallbackModelProvider", "siteStructureFallbackModel",
  "siteStructureFallbackReasoningEffort", "siteStructureFallbackEnabled",
  "catalogPostModelProvider", "catalogPostModel", "catalogPostReasoningEffort",
  "catalogPostFallbackModelProvider", "catalogPostFallbackModel",
  "catalogPostFallbackReasoningEffort", "catalogPostFallbackEnabled",
] as const;

export function filterCrawlModelPresetForm(
  form: Record<string, string>,
): Record<string, string> {
  const allowed = new Set<string>(CRAWL_MODEL_PRESET_FORM_IDS);
  return Object.fromEntries(Object.entries(form).filter(([id]) => allowed.has(id)));
}

export function normalizePresetName(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 80) : "";
}

export function parseCrawlPresets<T>(raw: string | null | undefined): CrawlPreset<T>[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const value = entry as Record<string, unknown>;
      const name = normalizePresetName(value.name);
      if (!name || !("value" in value)) return [];
      return [{
        name,
        value: value.value as T,
        updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
      }];
    });
  } catch {
    return [];
  }
}

export function serializeCrawlPresets<T>(presets: readonly CrawlPreset<T>[]): string {
  return JSON.stringify(presets);
}

/** 同名保存は上書き、別名は末尾追加。入力配列は変更しない。 */
export function upsertCrawlPreset<T>(
  presets: readonly CrawlPreset<T>[],
  nameValue: unknown,
  value: T,
  now = new Date(),
): CrawlPreset<T>[] {
  const name = normalizePresetName(nameValue);
  if (!name) return [...presets];
  const next: CrawlPreset<T> = {
    name,
    value,
    updatedAt: now.toISOString(),
  };
  const existing = presets.findIndex((preset) => preset.name === name);
  if (existing < 0) return [...presets, next];
  return presets.map((preset, index) => index === existing ? next : preset);
}

export function removeCrawlPreset<T>(
  presets: readonly CrawlPreset<T>[],
  nameValue: unknown,
): CrawlPreset<T>[] {
  const name = normalizePresetName(nameValue);
  return presets.filter((preset) => preset.name !== name);
}

export function readCrawlPresets<T>(
  storage: Pick<Storage, "getItem"> | null | undefined,
  key = CRAWL_PRESETS_STORAGE_KEY,
): CrawlPreset<T>[] {
  try {
    return parseCrawlPresets<T>(storage?.getItem(key));
  } catch {
    return [];
  }
}

export function writeCrawlPresets<T>(
  storage: Pick<Storage, "setItem"> | null | undefined,
  presets: readonly CrawlPreset<T>[],
  key = CRAWL_PRESETS_STORAGE_KEY,
): void {
  try {
    storage?.setItem(key, serializeCrawlPresets(presets));
  } catch {
    // private browsing等でStorageが使えない場合でもUI設定を壊さない。
  }
}
