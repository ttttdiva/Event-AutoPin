const X_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);
const RESERVED_SCREEN_NAMES = new Set([
  "home",
  "explore",
  "search",
  "notifications",
  "messages",
  "settings",
  "compose",
  "intent",
  "share",
  "i",
]);

/** X/TwitterのプロフィールURLだけを正規化して返す。投稿URLやルートURLは拒否する。 */
export function normalizeXProfileUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!X_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length !== 1) return null;
  const screenName = parts[0];
  if (!/^[A-Za-z0-9_]{1,15}$/.test(screenName)) return null;
  if (RESERVED_SCREEN_NAMES.has(screenName.toLowerCase())) return null;
  return `https://x.com/${screenName}`;
}

export function extractXScreenName(value: unknown): string | null {
  const normalized = normalizeXProfileUrl(value);
  return normalized ? new URL(normalized).pathname.slice(1) : null;
}

export function normalizeXPostUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value.trim());
    if (!X_HOSTS.has(parsed.hostname.toLowerCase())) return null;
    const match = parsed.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d+)\/?$/i);
    return match ? `https://x.com/${match[1]}/status/${match[2]}` : null;
  } catch {
    return null;
  }
}
