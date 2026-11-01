/** Single-map recommendation. Distances are image pixels, not walking distances. */
export interface RouteCircle {
  id: number;
  priorityColor: number;
  purchaseStatus: number;
  absenceStatus: string | null;
  mapNumber: number | null;
  pinX: number | null;
  pinY: number | null;
  followerCount?: number | null;
  followerObservedAt?: string | null;
  followerSource?: string | null;
}

export type RoutePopularity =
  | { status: "fresh"; count: number; observedAt: string; source: string; proxy: number }
  | { status: "stale"; count: number; observedAt: string; source: string }
  | { status: "unknown" };
export interface RoutePoint { x: number; y: number }
export interface RouteOptions {
  mapNumber: number | null;
  /** False when the selected number identifies more than one image. */
  mapNumberUnique?: boolean;
  imageWidth: number;
  imageHeight: number;
  startPoint?: RoutePoint | null;
  /** Supply a fixed time to make freshness and tests deterministic. */
  now?: number;
}
export interface RouteStep<T extends RouteCircle> {
  circle: T;
  distancePixels: number;
  popularity: RoutePopularity;
}
export interface RecommendedRoute<T extends RouteCircle> {
  steps: RouteStep<T>[];
  startPoint: (RoutePoint & { kind: "explicit" | "heuristic" }) | null;
  unavailableCount: number;
  excludedCount: number;
  ambiguousMap: boolean;
  popularityCounts: { fresh: number; stale: number; unknown: number };
}

/** A 30-day observation window; old values are displayed as old, never scored. */
export const FOLLOWER_FRESH_MS = 30 * 24 * 60 * 60 * 1000;
/** The full popularity range can change the score by at most 10% of the image diagonal. */
export const POPULARITY_MAX_DIAGONAL_FRACTION = 0.1;

function parseObservation(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return NaN;
  const [, ys, mos, ds, hs, mis, ss, fraction, zone] = match;
  const year = Number(ys), month = Number(mos), day = Number(ds);
  const hour = Number(hs), minute = Number(mis), second = Number(ss);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] ||
      hour > 23 || minute > 59 || second > 59) return NaN;
  let offset = 0;
  if (zone !== "Z") {
    const oh = Number(zone.slice(1, 3)), om = Number(zone.slice(4, 6));
    if (oh > 23 || om > 59) return NaN;
    offset = (oh * 60 + om) * (zone[0] === "+" ? 1 : -1);
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, Number((fraction || "").padEnd(3, "0").slice(0, 3)));
  return date.getTime() - offset * 60_000;
}

export function routePopularity(circle: RouteCircle, now: number): RoutePopularity {
  const count = circle.followerCount;
  const observedAt = circle.followerObservedAt;
  const source = circle.followerSource;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 ||
      typeof observedAt !== "string" || typeof source !== "string" || !source.trim()) {
    return { status: "unknown" };
  }
  const observed = parseObservation(observedAt);
  if (!Number.isFinite(observed) || observed > now) return { status: "unknown" };
  if (now - observed > FOLLOWER_FRESH_MS) return { status: "stale", count, observedAt, source };
  // Fixed logarithmic scale, capped at one million; independent of the candidate set.
  return { status: "fresh", count, observedAt, source,
    proxy: Math.min(1, Math.log1p(count) / Math.log1p(1_000_000)) };
}

function validPoint(x: unknown, y: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1 &&
    typeof y === "number" && Number.isFinite(y) && y >= 0 && y <= 1;
}

function priorityRank(priority: number): number {
  switch (priority) { case 15: return 0; case 10: return 1; case 11: return 2; case 5: return 3; default: return 4; }
}

/**
 * Input must already reflect the map's user-selected filters, including rows
 * without coordinates. Map-unassigned rows are counted but never plotted.
 */
export function calculateRecommendedRoute<T extends RouteCircle>(
  circles: readonly T[], options: RouteOptions,
): RecommendedRoute<T> {
  const result: RecommendedRoute<T> = {
    steps: [], startPoint: null, unavailableCount: 0, excludedCount: 0,
    ambiguousMap: options.mapNumberUnique === false,
    popularityCounts: { fresh: 0, stale: 0, unknown: 0 },
  };
  const validMap = options.mapNumber != null && Number.isInteger(options.mapNumber) && options.mapNumber > 0;
  const validSize = Number.isFinite(options.imageWidth) && options.imageWidth > 0 &&
    Number.isFinite(options.imageHeight) && options.imageHeight > 0;
  const now = options.now ?? Date.now();
  const candidates: { circle: T; popularity: RoutePopularity }[] = [];
  for (const circle of circles) {
    // Circles assigned to another map are not part of this map's coverage.
    if (circle.mapNumber != null && circle.mapNumber !== 0 && circle.mapNumber !== options.mapNumber) continue;
    if ((circle.purchaseStatus !== 0 && circle.purchaseStatus !== 2) || !!circle.absenceStatus) {
      result.excludedCount++;
      continue;
    }
    if (result.ambiguousMap || !validMap || !validSize || circle.mapNumber !== options.mapNumber ||
        !validPoint(circle.pinX, circle.pinY)) {
      result.unavailableCount++;
      continue;
    }
    const popularity = routePopularity(circle, now);
    result.popularityCounts[popularity.status]++;
    candidates.push({ circle, popularity });
  }
  if (!candidates.length) return result;
  const explicit = options.startPoint;
  const start = explicit && validPoint(explicit.x, explicit.y)
    ? { x: explicit.x, y: explicit.y, kind: "explicit" as const }
    : { x: 0, y: 0, kind: "heuristic" as const };
  result.startPoint = start;
  let point: RoutePoint = start;
  const diagonal = Math.hypot(options.imageWidth, options.imageHeight);
  while (candidates.length) {
    let bestIndex = 0;
    let bestRank = Infinity;
    let bestScore = Infinity;
    let bestDistance = 0;
    for (let i = 0; i < candidates.length; i++) {
      const { circle, popularity } = candidates[i];
      const distance = Math.hypot((circle.pinX! - point.x) * options.imageWidth,
        (circle.pinY! - point.y) * options.imageHeight);
      const rank = priorityRank(circle.priorityColor);
      // Unknown and stale are neutral (0.5), not zero followers.
      const proxy = popularity.status === "fresh" ? popularity.proxy : 0.5;
      const score = distance - (proxy - 0.5) * POPULARITY_MAX_DIAGONAL_FRACTION * diagonal;
      if (rank < bestRank || (rank === bestRank &&
          (score < bestScore || (score === bestScore && circle.id < candidates[bestIndex].circle.id)))) {
        bestIndex = i; bestRank = rank; bestScore = score; bestDistance = distance;
      }
    }
    const [{ circle, popularity }] = candidates.splice(bestIndex, 1);
    result.steps.push({ circle, popularity, distancePixels: bestDistance });
    point = { x: circle.pinX!, y: circle.pinY! };
  }
  return result;
}
