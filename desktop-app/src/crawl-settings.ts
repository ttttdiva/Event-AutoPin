/**
 * クロール画面で共有する、保存可能な設定とイベントソースの純粋な型/変換。
 * DOM や Tauri に依存しないため、設定の復元・payload生成・検証を同じ契約で
 * テストできます。
 */

export type GrokSearchMode = "api" | "build" | "bot";

export type CrawlSource = {
  name: string;
  url: string;
  map_urls: string[];
  catalog_additional_prompt: string;
};

export type CrawlSettings = {
  collect_catalogs: boolean;
  enable_twitter_catalog: boolean;
  use_grok_search: boolean;
  grok_search_mode: GrokSearchMode;
  days_before: number;
  days_after: number;
  backup: boolean;
  reprocess: boolean;
  regenerate_coordinates: boolean;
  skip_circle_images: boolean;
  verbose: boolean;
};

export const DEFAULT_CRAWL_SETTINGS: Readonly<CrawlSettings> = {
  collect_catalogs: true,
  enable_twitter_catalog: true,
  use_grok_search: true,
  grok_search_mode: "api",
  days_before: 30,
  days_after: 7,
  backup: false,
  reprocess: false,
  regenerate_coordinates: false,
  skip_circle_images: false,
  verbose: true,
};

export const CRAWL_SETTINGS_KEYS = [
  "collect_catalogs",
  "enable_twitter_catalog",
  "use_grok_search",
  "grok_search_mode",
  "days_before",
  "days_after",
  "backup",
  "reprocess",
  "regenerate_coordinates",
  "skip_circle_images",
  "verbose",
] as const;

export type CrawlSettingsKey = (typeof CRAWL_SETTINGS_KEYS)[number];

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.trim().toLowerCase() === "true") return true;
    if (value.trim().toLowerCase() === "false") return false;
  }
  if (typeof value === "number") return value !== 0;
  return fallback;
}

export function nonNegativeInteger(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.floor(number);
}

export function normalizeGrokSearchMode(value: unknown, fallback: GrokSearchMode = "api"): GrokSearchMode {
  return value === "api" || value === "build" || value === "bot" ? value : fallback;
}

/** 保存値が欠けていても、既存の設定/グローバル初期値を壊さず補完する。 */
export function normalizeCrawlSettings(
  value: unknown,
  fallback: Partial<CrawlSettings> = {},
): CrawlSettings {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const base = { ...DEFAULT_CRAWL_SETTINGS, ...fallback };
  return {
    collect_catalogs: booleanValue(raw.collect_catalogs, base.collect_catalogs),
    enable_twitter_catalog: booleanValue(raw.enable_twitter_catalog, base.enable_twitter_catalog),
    use_grok_search: booleanValue(raw.use_grok_search, base.use_grok_search),
    grok_search_mode: normalizeGrokSearchMode(raw.grok_search_mode, base.grok_search_mode),
    days_before: nonNegativeInteger(raw.days_before, nonNegativeInteger(base.days_before, 30)),
    days_after: nonNegativeInteger(raw.days_after, nonNegativeInteger(base.days_after, 7)),
    backup: booleanValue(raw.backup, base.backup),
    reprocess: booleanValue(raw.reprocess, base.reprocess),
    regenerate_coordinates: booleanValue(raw.regenerate_coordinates, base.regenerate_coordinates),
    skip_circle_images: booleanValue(raw.skip_circle_images, base.skip_circle_images),
    verbose: booleanValue(raw.verbose, base.verbose),
  };
}

export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
}

export function parseUrlList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return uniqueStrings(value.flatMap((entry) => parseUrlList(entry)));
  }
  if (typeof value !== "string") return [];
  const matches = value.match(/https?:\/\/[^\s,]+/gi) || [];
  return uniqueStrings(matches.map((url) => url.trim().replace(/[,\]\)\};]+$/, "")));
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function sourcePrompt(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** legacy の map_url / prompt も取り込みつつ、無効な source は落とす。 */
export function normalizeCrawlSources(value: unknown): CrawlSource[] {
  const entries = Array.isArray(value) ? value : [];
  return entries.flatMap((entry, index) => {
    if (typeof entry === "string") {
      const urls = parseUrlList(entry);
      return urls.length
        ? [{ name: `ソース${index + 1}`, url: urls[0], map_urls: [], catalog_additional_prompt: "" }]
        : [];
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const raw = entry as Record<string, unknown>;
    const urls = parseUrlList(raw.url ?? raw.event_url);
    if (!urls.length) return [];
    const maps = uniqueStrings([
      ...parseUrlList(raw.map_urls),
      ...parseUrlList(raw.map_url),
    ]);
    return [{
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : `ソース${index + 1}`,
      url: urls[0],
      map_urls: maps,
      catalog_additional_prompt: sourcePrompt(
        raw.catalog_additional_prompt ?? raw.additional_prompt,
      ),
    }];
  });
}

export function sourceUrls(sources: readonly CrawlSource[]): string[] {
  return uniqueStrings(sources.map((source) => source.url));
}

export function mapUrls(sources: readonly CrawlSource[]): string[] {
  return uniqueStrings(sources.flatMap((source) => source.map_urls));
}

/**
 * source section を失わない共通/個別 prompt の分解。
 * 旧 config の `[https://...]` セクションを source metadata に移行する際にも使う。
 */
export function splitPromptSections(
  raw: unknown,
  urls: readonly string[],
): { common: string; sourcePrompts: Record<string, string>; hasSourceSections: boolean } {
  const sourceSet = new Set(urls);
  const sourceLines = new Map<string, string[]>();
  urls.forEach((url) => sourceLines.set(url, []));
  const commonLines: string[] = [];
  let targets: string[] | null = null;
  let hasSourceSections = false;
  for (const line of typeof raw === "string" ? raw.replace(/\r\n/g, "\n").split("\n") : []) {
    const section = line.match(/^\s*\[(.+?)\]\s*$/);
    if (section) {
      const label = section[1].trim();
      if (/^(default|common)$/i.test(label)) {
        targets = [];
      } else {
        targets = parseUrlList(label).filter((url) => sourceSet.has(url));
        if (targets.length) hasSourceSections = true;
      }
      continue;
    }
    if (!targets || targets.length === 0) commonLines.push(line);
    else targets.forEach((url) => sourceLines.get(url)?.push(line));
  }
  const sourcePrompts: Record<string, string> = {};
  sourceLines.forEach((lines, url) => {
    const prompt = lines.join("\n").trim();
    if (prompt) sourcePrompts[url] = prompt;
  });
  return { common: commonLines.join("\n").trim(), sourcePrompts, hasSourceSections };
}

/** source-specific prompt は common を先頭に付け、既存契約の一つの文字列にする。 */
export function promptForSource(
  commonPrompt: string,
  sourcePromptValue: string,
): string {
  return [commonPrompt.trim(), sourcePromptValue.trim()].filter(Boolean).join("\n\n");
}

export function serializePromptSections(
  commonPrompt: string,
  sources: readonly CrawlSource[],
): string {
  const lines = commonPrompt.trim() ? [commonPrompt.trim()] : [];
  for (const source of sources) {
    if (!source.catalog_additional_prompt.trim()) continue;
    lines.push(`[${source.url}]`, source.catalog_additional_prompt.trim());
  }
  return lines.join("\n\n");
}

export function normalizedSource(
  source: Partial<CrawlSource> & { url: string },
  index = 0,
): CrawlSource {
  return {
    name: source.name?.trim() || `ソース${index + 1}`,
    url: parseUrlList(source.url)[0] || source.url.trim(),
    map_urls: uniqueStrings([...(source.map_urls || [])]),
    catalog_additional_prompt: sourcePrompt(source.catalog_additional_prompt),
  };
}
