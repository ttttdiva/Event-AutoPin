/**
 * HTMLフェッチャ
 *
 * - UA偽装
 * - Cookie付きリクエスト
 * - タイムアウト
 */

const DEFAULT_UA =
  "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

export async function fetchHtml(
  url: string,
  options: {
    cookieHeader?: string;
    timeoutMs?: number;
    additionalHeaders?: Record<string, string>;
  } = {},
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 30000,
  );
  try {
    const headers: Record<string, string> = {
      "User-Agent": DEFAULT_UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
      ...(options.additionalHeaders ?? {}),
    };
    if (options.cookieHeader) {
      headers.Cookie = options.cookieHeader;
    }
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${url}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchJson<T = any>(
  url: string,
  options: {
    method?: "GET" | "POST";
    body?: any;
    cookieHeader?: string;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 60000,
  );
  try {
    const headers: Record<string, string> = {
      "User-Agent": DEFAULT_UA,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (options.cookieHeader) headers.Cookie = options.cookieHeader;
    const res = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `HTTP ${res.status}: ${url}\n${text.slice(0, 300)}`,
      );
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}
