import {
  isValidIsoDate,
  normalizeCrawlSettings,
  sourceUrls,
  type CrawlSettings,
  type CrawlSource,
} from "./crawl-settings";

export type CrawlValidationInput = {
  settings: Partial<CrawlSettings>;
  sources?: readonly CrawlSource[];
  eventDate?: unknown;
  activeEventSelected?: boolean;
  modelErrors?: readonly string[];
  authErrors?: readonly string[];
};

export type CrawlValidationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  settings: CrawlSettings;
};

export const MAX_CRAWL_DAYS = 3650;

function rawDayValue(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string" && value.trim() === "") return Number.NaN;
  return Number(value);
}

/**
 * 実行直前に表示/UIと同じ条件で検証する。disabled UIの値を信頼せず、
 * source・日付・検索期間・モデル/認証を fail-closed で扱う。
 */
export function validateCrawlRequest(input: CrawlValidationInput): CrawlValidationResult {
  const settings = normalizeCrawlSettings(input.settings);
  const errors: string[] = [];
  const warnings: string[] = [];
  const urls = sourceUrls(input.sources || []);
  const raw = input.settings && typeof input.settings === "object"
    ? input.settings as Record<string, unknown>
    : {};

  if (!input.activeEventSelected) {
    errors.push(settings.reprocess
      ? "再処理には既存イベントの選択が必要です"
      : "実行対象のイベントを選択してください");
  }
  if (!settings.reprocess && urls.length === 0) {
    errors.push("収集対象URLを1件以上指定してください");
  }
  for (const source of input.sources || []) {
    if (!/^https?:\/\//i.test(source.url.trim())) {
      errors.push(`収集対象URLが不正です: ${source.url || "(空)"}`);
    }
  }
  if (!settings.reprocess && !isValidIsoDate(input.eventDate)) {
    errors.push("イベント日をYYYY-MM-DD形式で指定してください");
  }
  const daysBefore = rawDayValue(raw.days_before, settings.days_before);
  const daysAfter = rawDayValue(raw.days_after, settings.days_after);
  if (!Number.isInteger(daysBefore) || daysBefore < 0 || daysBefore > MAX_CRAWL_DAYS) {
    errors.push("開催日前の日数は0以上3650以下の整数で指定してください");
  }
  if (!Number.isInteger(daysAfter) || daysAfter < 0 || daysAfter > MAX_CRAWL_DAYS) {
    errors.push("開催日後の日数は0以上3650以下の整数で指定してください");
  }
  if (
    settings.reprocess &&
    !settings.collect_catalogs &&
    !settings.regenerate_coordinates
  ) {
    errors.push("再処理で実行する収集・座標処理がありません");
  }
  for (const error of input.modelErrors || []) {
    if (error.trim()) errors.push(error.trim());
  }
  for (const error of input.authErrors || []) {
    if (error.trim()) errors.push(error.trim());
  }
  if (settings.reprocess && urls.length > 0) {
    warnings.push("再処理ではURLを使用せず、選択イベントの既存データを対象にします");
  }
  if (!settings.enable_twitter_catalog && settings.use_grok_search) {
    warnings.push("Twitter/X収集が無効のため、Grok検索は今回使用されません");
  }
  return { ok: errors.length === 0, errors, warnings, settings };
}

export function crawlValidationMessage(result: CrawlValidationResult): string {
  if (result.ok) {
    return result.warnings.length
      ? `実行可能（${result.warnings.join(" / ")}）`
      : "実行可能";
  }
  return result.errors.join(" / ");
}
