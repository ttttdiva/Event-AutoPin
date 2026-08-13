/**
 * アダプター選択
 *
 * - Picrea等の既知サイトは専用アダプター
 * - それ以外はLLM汎用アダプター
 */
import type { CrawlResult } from "./types";
import { canHandlePicrea, crawlPicrea } from "./adapters/picrea";
import { crawlGeneric } from "./adapters/generic";
import { getCookieFiles } from "../settings-store";
import * as FileSystem from "expo-file-system/legacy";
import { normalizeXProfileUrl } from "./url-validation";

async function loadCookieHeaderFor(url: string): Promise<string | undefined> {
  try {
    const files = await getCookieFiles();
    if (!files.length) return undefined;
    const host = new URL(url).hostname.toLowerCase();
    for (const file of files) {
      if (host.includes(file.domain.toLowerCase())) {
        const info = await FileSystem.getInfoAsync(file.path);
        if (!info.exists) continue;
        const text = await FileSystem.readAsStringAsync(file.path);
        return parseNetscapeCookies(text, host);
      }
    }
  } catch (e) {
    console.warn("Cookie読み込み失敗:", e);
  }
  return undefined;
}

/** Netscape形式 (.txt) のcookieファイルをCookieヘッダに変換 */
function parseNetscapeCookies(text: string, host: string): string {
  const kv: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length < 7) continue;
    const [domain, , , , , name, value] = parts;
    if (!domain || !name) continue;
    const d = domain.replace(/^\./, "").toLowerCase();
    if (host.includes(d)) {
      kv.push(`${name}=${value}`);
    }
  }
  return kv.join("; ");
}

export interface AdapterRunOptions {
  url: string;
  eventNameHint?: string;
  cookieHeader?: string;
}

export async function runAdapter(
  options: AdapterRunOptions,
): Promise<CrawlResult> {
  const { url, eventNameHint } = options;
  const cookieHeader =
    options.cookieHeader ?? (await loadCookieHeaderFor(url));

  const result = canHandlePicrea(url)
    ? await crawlPicrea(url, cookieHeader)
    : await crawlGeneric(url, cookieHeader, eventNameHint);
  return {
    ...result,
    circles: result.circles.map((circle) => ({
      ...circle,
      twitter_url: normalizeXProfileUrl(circle.twitter_url),
      twitter_url_rejected:
        circle.twitter_url_rejected ||
        (!!circle.twitter_url && !normalizeXProfileUrl(circle.twitter_url)),
    })),
  };
}
