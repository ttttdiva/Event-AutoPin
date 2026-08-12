/**
 * Picrea (picrea.jp) 専用アダプター
 *
 * React SPAのためHTMLパースではなくAPIを直接叩く。
 * Cookie認証が必要なケースあり。
 */
import type { CrawlResult, CrawlCircle, CrawlEventInfo } from "../types";
import { fetchJson } from "../html-fetcher";
import { normalizeXProfileUrl } from "../url-validation";

export function canHandlePicrea(url: string): boolean {
  return /picrea\.jp/i.test(url);
}

function extractEventKey(url: string): string {
  const m = url.match(/\/event\/([a-f0-9]+)/i);
  if (!m) {
    throw new Error(`PicreaのURLからevent_keyを抽出できませんでした: ${url}`);
  }
  return m[1];
}

export async function crawlPicrea(
  url: string,
  cookieHeader?: string,
): Promise<CrawlResult> {
  const eventKey = extractEventKey(url);
  const api = "https://api.picrea.jp/api/apply/circle_cut";
  const payload = { event_key: eventKey, paid: true };

  const data = await fetchJson<any>(api, {
    method: "POST",
    body: payload,
    cookieHeader,
  });
  if (!data?.response) {
    throw new Error(`Picrea APIレスポンスが不正です: ${JSON.stringify(Object.keys(data ?? {}))}`);
  }
  const resp = data.response;
  const eventData = resp.event ?? {};

  const event: CrawlEventInfo = {
    name: eventData.title ?? eventData.name ?? "Picreaイベント",
    url,
    date: eventData.date ?? eventData.event_date ?? null,
    venue: eventData.venue ?? null,
    organizer: eventData.organizer ?? null,
  };

  const circles: CrawlCircle[] = [];
  for (const item of resp.list ?? []) {
    const name = (item.name ?? "").trim();
    if (!name) continue;
    let penname: string | null = null;
    if (Array.isArray(item.pennames)) {
      penname = item.pennames.filter((p: any) => !!p).join(", ") || null;
    } else if (typeof item.pennames === "string") {
      penname = item.pennames;
    }
    const cutUrl =
      typeof item.circle_cut === "string" && item.circle_cut.startsWith("http")
        ? item.circle_cut
        : null;
    const rawTwitterUrl = typeof item.twitter_url === "string" ? item.twitter_url : null;
    const twitterUrl = normalizeXProfileUrl(rawTwitterUrl);
    circles.push({
      name,
      penname,
      space: item.circle_space ? String(item.circle_space) : null,
      hall: item.map_name ?? null,
      twitter_url: twitterUrl,
      twitter_url_rejected: !!rawTwitterUrl && !twitterUrl,
      website_url: item.website_url || item.web_url || null,
      description: item.description || item.circleDescription || null,
      circle_cut_url: cutUrl,
    });
  }

  return { event, circles, adapterName: "picrea" };
}
