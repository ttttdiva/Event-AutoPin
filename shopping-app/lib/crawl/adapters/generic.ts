/**
 * 汎用テーブルアダプター
 *
 * 初見のヘッダー構造だけをLLMに渡して列対応を判定し、行データは端末内で抽出する。
 * 同一ホストかつヘッダー完全一致の保存済み構造はLLMを介さず再利用する。
 */
import { parse, type HTMLElement } from "node-html-parser";
import type { CrawlResult, CrawlCircle, CrawlEventInfo } from "../types";
import { fetchHtml } from "../html-fetcher";
import { LlmClient } from "../llm-client";
import {
  getPrimaryModel,
  getFallbackModel,
  getSiteParsingModel,
  getSiteParsingReasoningEffort,
} from "../../settings-store";
import {
  findExactTableSchema,
  normalizeHeaders,
  type CircleColumnKey,
  type CircleColumnMapping,
} from "../site-schema-store";
import { normalizeXProfileUrl } from "../url-validation";

const COLUMN_KEYS: CircleColumnKey[] = [
  "name",
  "penname",
  "space",
  "hall",
  "twitter_url",
  "website_url",
  "pixiv_url",
  "description",
  "genres",
  "circle_cut_url",
];

interface TableCandidate {
  table: HTMLElement;
  headers: string[];
  headerRowIndex: number;
}

interface SelectedTable {
  candidate: TableCandidate;
  mapping: CircleColumnMapping;
  source: "saved" | "llm";
}

export function canHandleGeneric(_url: string): boolean {
  return true;
}

function extractTitle(html: string): string {
  try {
    const root = parse(html);
    return root.querySelector("title")?.text?.replace(/\s+/g, " ").trim() ||
      root.querySelector("h1")?.text?.replace(/\s+/g, " ").trim() ||
      "イベント";
  } catch {
    return "イベント";
  }
}

function collectTableCandidates(html: string): TableCandidate[] {
  const root = parse(html);
  const candidates: TableCandidate[] = [];
  for (const table of root.querySelectorAll("table")) {
    const hasSpans = table.querySelectorAll("th, td").some((cell) => {
      const rowSpan = Number(cell.getAttribute("rowspan") ?? "1");
      const colSpan = Number(cell.getAttribute("colspan") ?? "1");
      return rowSpan > 1 || colSpan > 1;
    });
    if (hasSpans) continue;
    const rows = table.querySelectorAll("tr");
    const headerRowIndex = rows.findIndex((row) => row.querySelectorAll("th").length > 0);
    if (headerRowIndex < 0) continue;
    const headerRow = rows[headerRowIndex];
    if (!headerRow) continue;
    const headerCells = headerRow.querySelectorAll("th, td");
    const headers = normalizeHeaders(headerCells.map((cell) => cell.text));
    if (headers.length < 2 || headers.every((header) => !header)) continue;
    candidates.push({ table, headers, headerRowIndex });
  }
  return candidates;
}

function mappingPrompt(hostname: string, candidates: TableCandidate[]): string {
  const headerData = candidates.map((candidate, tableIndex) => ({
    table_index: tableIndex,
    headers: candidate.headers,
  }));
  return `同人誌即売会サイトの表ヘッダーだけを見て、サークル一覧の表と列番号を判定してください。
ホスト名: ${hostname}
表ヘッダー(JSON):
${JSON.stringify(headerData)}

行データは提供されていません。推測で存在しない列を補わないでください。
以下のJSONだけを返してください。列がなければnullにしてください。
{
  "table_index": 0,
  "columns": {
    "name": 1,
    "penname": 2,
    "space": 0,
    "hall": null,
    "twitter_url": 4,
    "website_url": 3,
    "pixiv_url": null,
    "description": null,
    "genres": null,
    "circle_cut_url": null
  }
}`;
}

function parseMapping(value: unknown, candidate: TableCandidate): CircleColumnMapping | null {
  if (!value || typeof value !== "object") return null;
  const columns = (value as { columns?: unknown }).columns;
  if (!columns || typeof columns !== "object") return null;
  const mapping: Partial<Record<CircleColumnKey, number>> = {};
  for (const key of COLUMN_KEYS) {
    const raw = (columns as Record<string, unknown>)[key];
    let index: number | null = null;
    if (Number.isInteger(raw)) index = raw as number;
    if (typeof raw === "string") {
      const normalized = normalizeHeaders([raw])[0];
      const found = candidate.headers.indexOf(normalized);
      if (found >= 0) index = found;
    }
    if (index !== null && index >= 0 && index < candidate.headers.length) mapping[key] = index;
  }
  return Number.isInteger(mapping.name) ? (mapping as CircleColumnMapping) : null;
}

async function selectTable(
  hostname: string,
  candidates: TableCandidate[],
): Promise<SelectedTable> {
  for (const candidate of candidates) {
    const mapping = await findExactTableSchema(hostname, candidate.headers);
    if (mapping) return { candidate, mapping, source: "saved" };
  }

  const [primary, fallback, siteParsing, reasoningEffort] = await Promise.all([
    getPrimaryModel(),
    getFallbackModel(),
    getSiteParsingModel(),
    getSiteParsingReasoningEffort(),
  ]);
  const models = Array.from(new Set([siteParsing, primary, fallback].filter(Boolean)));
  if (!models.length) throw new Error("LLMモデルが設定されていません");
  const llm = new LlmClient(models);
  const text = await llm.extractData(mappingPrompt(hostname, candidates), { reasoningEffort });
  const parsed = JSON.parse(text) as { table_index?: unknown };
  if (!Number.isInteger(parsed.table_index)) throw new Error("LLMの表選択結果が不正です");
  const tableIndex = parsed.table_index as number;
  const candidate = candidates[tableIndex];
  if (!candidate) throw new Error("LLMが存在しない表を選択しました");
  const mapping = parseMapping(parsed, candidate);
  if (!mapping) throw new Error("LLMの列対応に必須のサークル名がありません");
  return { candidate, mapping, source: "llm" };
}

function absoluteUrl(value: string | undefined, baseUrl: string): string | null {
  if (!value) return null;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}

function cellText(cells: HTMLElement[], index: number | undefined): string | null {
  if (index === undefined) return null;
  return cells[index]?.text?.replace(/\s+/g, " ").trim() || null;
}

function cellUrl(cells: HTMLElement[], index: number | undefined, baseUrl: string): string | null {
  if (index === undefined) return null;
  return absoluteUrl(cells[index]?.querySelector("a[href]")?.getAttribute("href"), baseUrl);
}

function parseCircles(selected: SelectedTable, baseUrl: string): CrawlCircle[] {
  const { candidate, mapping } = selected;
  const rows = candidate.table.querySelectorAll("tr").slice(candidate.headerRowIndex + 1);
  const circles: CrawlCircle[] = [];
  for (const row of rows) {
    if (row.querySelectorAll("th").length > 0) continue;
    const cells = row.querySelectorAll("th, td");
    const name = cellText(cells, mapping.name);
    if (!name) continue;
    const rowLinks = row.querySelectorAll("a[href]").map((a) => absoluteUrl(a.getAttribute("href"), baseUrl));
    const mappedTwitter = cellUrl(cells, mapping.twitter_url, baseUrl);
    const fallbackTwitter = rowLinks.find((url) =>
      typeof url === "string" && /https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(url),
    );
    const rawTwitter = mappedTwitter ?? fallbackTwitter ?? null;
    const twitterUrl =
      normalizeXProfileUrl(mappedTwitter) ?? normalizeXProfileUrl(fallbackTwitter);
    const imageSrc = mapping.circle_cut_url === undefined
      ? null
      : absoluteUrl(cells[mapping.circle_cut_url]?.querySelector("img[src]")?.getAttribute("src"), baseUrl);
    circles.push({
      name,
      penname: cellText(cells, mapping.penname),
      space: cellText(cells, mapping.space),
      hall: cellText(cells, mapping.hall),
      twitter_url: twitterUrl,
      twitter_url_rejected: !!rawTwitter && !twitterUrl,
      website_url: cellUrl(cells, mapping.website_url, baseUrl),
      pixiv_url: cellUrl(cells, mapping.pixiv_url, baseUrl),
      description: cellText(cells, mapping.description),
      genres: cellText(cells, mapping.genres)?.split(/[,、／/]/).map((v) => v.trim()).filter(Boolean) ?? [],
      circle_cut_url: imageSrc,
    });
  }
  return circles;
}

export async function crawlGeneric(
  url: string,
  cookieHeader?: string,
  eventNameHint?: string,
): Promise<CrawlResult> {
  const html = await fetchHtml(url, { cookieHeader });
  const candidates = collectTableCandidates(html);
  if (!candidates.length) {
    throw new Error("列名を確認できる表が見つかりませんでした。このサイト形式は未対応です");
  }
  const hostname = new URL(url).hostname.toLowerCase();
  const selected = await selectTable(hostname, candidates);
  const event: CrawlEventInfo = {
    name: eventNameHint ?? extractTitle(html),
    url,
  };
  const circles = parseCircles(selected, url);
  if (!circles.length) throw new Error("選択した表からサークルを抽出できませんでした");
  const plausibleNames = circles.filter(
    (circle) =>
      circle.name.length <= 200 &&
      !/^https?:\/\//i.test(circle.name) &&
      !/^\d+$/.test(circle.name),
  );
  const uniqueNames = new Set(plausibleNames.map((circle) => circle.name)).size;
  if (
    plausibleNames.length < Math.min(2, circles.length) ||
    uniqueNames / plausibleNames.length < 0.5
  ) {
    throw new Error("サークル名列の判定結果が不自然なため、列構造を保存しませんでした");
  }
  return {
    event,
    circles,
    adapterName: selected.source === "saved" ? "generic (保存済み列構造)" : "generic (ヘッダーLLM判定)",
    pendingTableSchema:
      selected.source === "llm" && circles.length >= 2
        ? {
            hostname,
            headers: selected.candidate.headers,
            mapping: selected.mapping,
          }
        : undefined,
  };
}
