/** X (Twitter) の「おしながき」投稿をGrok APIで検索する。 */
import {
  getApiKey,
  getGrokSearchModelSelection,
  isGrokEnabled,
} from "../settings-store";
import { LlmClient } from "./llm-client";
import { extractXScreenName, normalizeXPostUrl } from "./url-validation";

export interface OshinagakiResult {
  tweetUrl: string | null;
  imageUrls: string[];
  items: { name: string; price?: number | null; type?: string | null }[];
  rawText: string | null;
}

export type OshinagakiOutcome =
  | { status: "skipped"; reason: string }
  | { status: "not_found" }
  | { status: "success"; data: OshinagakiResult }
  | { status: "error"; reason: string };

function parseItems(value: unknown): OshinagakiResult["items"] | null {
  if (!Array.isArray(value)) return null;
  const items: OshinagakiResult["items"] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return null;
    const item = raw as Record<string, unknown>;
    if (typeof item.name !== "string" || !item.name.trim()) return null;
    if (
      item.price !== undefined &&
      item.price !== null &&
      (typeof item.price !== "number" || !Number.isFinite(item.price))
    ) {
      return null;
    }
    if (item.type !== undefined && item.type !== null && typeof item.type !== "string") {
      return null;
    }
    items.push({
      name: item.name.trim(),
      price: typeof item.price === "number" ? item.price : null,
      type: typeof item.type === "string" ? item.type : null,
    });
  }
  return items;
}

function parseImageUrls(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const urls: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") return null;
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      urls.push(parsed.toString());
    } catch {
      return null;
    }
  }
  return urls;
}

/** Grok APIでサークルのおしながき投稿を検索し、失敗理由を失わず返す。 */
export async function fetchOshinagaki(
  circleName: string,
  twitterUrl: string | null,
  eventName: string | null,
): Promise<OshinagakiOutcome> {
  if (!(await isGrokEnabled())) {
    return { status: "skipped", reason: "設定でGrok検索が無効です" };
  }
  const apiKey = await getApiKey("xai");
  if (!apiKey) {
    return { status: "skipped", reason: "xAI(Grok) APIキーが未設定です" };
  }

  const screenName = extractXScreenName(twitterUrl);
  const target = screenName ? `@${screenName}` : `"${circleName}"`;
  const eventClause = eventName ? ` ${eventName}` : "";
  const query = `${target} おしながき${eventClause}`;
  const prompt = `Xで次の検索クエリに該当する最新のツイートを1件だけ探してください。
クエリ: ${query}

見つかった投稿から頒布物一覧を抽出し、以下のJSON形式で返してください。
{
  "tweet_url": "ツイートのURL",
  "image_urls": ["画像URL1", "画像URL2"],
  "items": [{ "name": "頒布物名", "price": 500, "type": "新刊(漫画)" }],
  "raw_text": "ツイート本文"
}
見つからなければ {"tweet_url": null, "image_urls": [], "items": [], "raw_text": null} を返してください。
JSONのみを返してください。`;

  try {
    // 設定済みのGrok候補をprovider付きで渡し、同名IDでもOpenAI endpointへ
    // 誤送信しない。設定値が未選択ならstore側の互換defaultを使う。
    const model = await getGrokSearchModelSelection();
    const llm = new LlmClient(model);
    const content = await llm.extractData(prompt, {
      temperature: 0.2,
      reasoningEffort: "none",
    });
    const parsed = JSON.parse(stripFences(content));
    if (parsed.tweet_url === null || parsed.tweet_url === undefined || parsed.tweet_url === "") {
      return { status: "not_found" };
    }
    const tweetUrl = normalizeXPostUrl(parsed.tweet_url);
    if (!tweetUrl) {
      return { status: "error", reason: "Grok APIが不正なXポストURLを返しました" };
    }
    const imageUrls = parseImageUrls(parsed.image_urls);
    const items = parseItems(parsed.items);
    if (!imageUrls || !items) {
      return { status: "error", reason: "Grok APIのお品書きデータ形式が不正です" };
    }
    if (
      parsed.raw_text !== undefined &&
      parsed.raw_text !== null &&
      typeof parsed.raw_text !== "string"
    ) {
      return { status: "error", reason: "Grok APIの投稿本文形式が不正です" };
    }
    return {
      status: "success",
      data: {
        tweetUrl,
        imageUrls,
        items,
        rawText: typeof parsed.raw_text === "string" ? parsed.raw_text : null,
      },
    };
  } catch {
    // 応答本文・認証情報を理由やログへ流さない。
    console.warn("Grok検索失敗:", circleName);
    return { status: "error", reason: "Grok APIでおしながき検索に失敗しました" };
  }
}

function stripFences(text: string): string {
  let value = text.trim();
  if (value.startsWith("```json")) value = value.slice(7);
  else if (value.startsWith("```")) value = value.slice(3);
  if (value.endsWith("```")) value = value.slice(0, -3);
  return value.trim();
}
