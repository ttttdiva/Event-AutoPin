export const COOKIE_DROP_MAX_BYTES = 2 * 1024 * 1024;

export type CookieDropCandidate = {
  name: string;
  size: number;
  isDirectory?: boolean;
};

export type CookieDropDecision =
  | { accepted: true; candidate: CookieDropCandidate }
  | {
      accepted: false;
      reason: "missing" | "multiple" | "directory" | "unsupported" | "too_large";
    };

/**
 * Cookie専用DOM drop zoneのmetadataだけを判定する。本文はこの判定を通過した
 * 1件に限り呼び出し側がarrayBufferで読み、Rustの同一validatorへ渡す。
 */
export function decideCookieDrop(
  candidates: readonly CookieDropCandidate[],
): CookieDropDecision {
  if (candidates.length === 0) return { accepted: false, reason: "missing" };
  if (candidates.length !== 1) return { accepted: false, reason: "multiple" };
  const candidate = candidates[0];
  if (candidate.isDirectory) return { accepted: false, reason: "directory" };
  if (!candidate.name.toLowerCase().endsWith(".txt")) {
    return { accepted: false, reason: "unsupported" };
  }
  if (!Number.isFinite(candidate.size) || candidate.size < 0) {
    return { accepted: false, reason: "missing" };
  }
  if (candidate.size > COOKIE_DROP_MAX_BYTES) {
    return { accepted: false, reason: "too_large" };
  }
  return { accepted: true, candidate };
}
