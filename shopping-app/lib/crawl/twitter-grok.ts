/** X (Twitter) の「おしながき」投稿をGrok APIで検索する。 */
import { getApiKey, isGrokEnabled } from "../settings-store";
import { extractXScreenName, normalizeXPostUrl } from "./url-validation";

const GROK_ENDPOINT = "https://api.x.ai/v1/chat/completions";

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
    const res = await fetch(GROK_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "grok-2-latest",
        messages: [
          { role: "system", content: "常にJSON形式で回答してください。" },
          { role: "user", content: prompt },
        ],
        temperature: 0.2,
      }),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 160).trim();
      return {
        status: "error",
        reason: `Grok API HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
      };
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? "";
    if (!content) return { status: "error", reason: "Grok APIの応答本文が空です" };
    const parsed = JSON.parse(stripFences(String(content).trim()));
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
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn("Grok検索失敗:", circleName, reason);
    return { status: "error", reason: `Grok検索失敗: ${reason}` };
  }
}

function stripFences(text: string): string {
  let value = text.trim();
  if (value.startsWith("```json")) value = value.slice(7);
  else if (value.startsWith("```")) value = value.slice(3);
  if (value.endsWith("```")) value = value.slice(0, -3);
  return value.trim();
}
