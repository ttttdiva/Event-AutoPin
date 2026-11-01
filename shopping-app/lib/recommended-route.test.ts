import { calculateRecommendedRoute, FOLLOWER_FRESH_MS, routePopularity, type RouteCircle } from "./recommended-route";
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const now = Date.parse("2026-10-01T00:00:00Z");
const options = { mapNumber: 1, imageWidth: 1000, imageHeight: 100, now };
function circle(id: number, fields: Partial<RouteCircle> = {}): RouteCircle {
  return { id, priorityColor: 5, purchaseStatus: 0, absenceStatus: null, mapNumber: 1, pinX: 0.5, pinY: 0.5, followerCount: null, followerObservedAt: null, followerSource: null, ...fields };
}
const fresh = { followerCount: 1_000_000, followerObservedAt: "2026-09-30T00:00:00Z", followerSource: "twitter" };
const ids = (rows: RouteCircle[], overrides = {}) => calculateRecommendedRoute(rows, { ...options, ...overrides }).steps.map(s => s.circle.id).join(",");
export function runRecommendedRouteTests(): void {
  assert(calculateRecommendedRoute([], options).steps.length === 0, "empty");
  const single = calculateRecommendedRoute([circle(1)], options);
  assert(single.steps.length === 1 && single.startPoint?.kind === "heuristic" && single.startPoint.x === 0, "deterministic heuristic");
  assert(ids([circle(1, { pinX: 0.9, priorityColor: 15 }), circle(2, { pinX: 0, priorityColor: 10, ...fresh })]) === "1,2", "priority always dominates");
  assert(ids([circle(1, { pinX: 0.1, pinY: 0 }), circle(2, { pinX: 0, pinY: 0.2 })]) === "2,1", "pixel aspect ratio");
  assert(ids([circle(1, { pinX: 0.2, pinY: 0 }), circle(2, { pinX: 0.22, pinY: 0, ...fresh })]) === "2,1", "popularity may influence nearby targets");
  assert(ids([circle(1, { pinX: 0.1, pinY: 0 }), circle(2, { pinX: 0.5, pinY: 0, followerCount: Number.MAX_SAFE_INTEGER, followerObservedAt: fresh.followerObservedAt, followerSource: fresh.followerSource })]) === "1,2", "popularity is bounded");
  assert(ids([circle(2), circle(1)]) === "1,2", "stable id tie");
  assert(ids([circle(1, { pinX: 0 }), circle(2, { pinX: 1 })], { startPoint: { x: 1, y: 0.5 } }) === "2,1", "explicit start");
  const old = circle(1, { ...fresh, followerObservedAt: new Date(now - FOLLOWER_FRESH_MS - 1).toISOString() });
  assert(routePopularity(old, now).status === "stale", "old metric");
  for (const bad of [null, -1, NaN, 0.1]) assert(routePopularity(circle(1, { ...fresh, followerCount: bad }), now).status === "unknown", "malformed or unknown");
  assert(routePopularity(circle(1, { ...fresh, followerCount: 0 }), now).status === "fresh", "zero is observed");
  assert(routePopularity(circle(1, { ...fresh, followerObservedAt: "invalid" }), now).status === "unknown", "malformed date");
  assert(routePopularity(circle(1, { ...fresh, followerSource: null }), now).status === "unknown", "source required");
  for (const timestamp of ["2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-04-31T00:00:00Z", "2026-01-01T24:00:00Z", "2025-02-29T00:00:00Z", "2026-09-30T00:00:00", "2026-09-30", "2027-02-30T00:00:00Z", "2026-09-30T00:00:00+24:00"]) {
    assert(routePopularity(circle(1, { ...fresh, followerObservedAt: timestamp }), now).status === "unknown", `invalid timestamp ${timestamp}`);
  }
  for (const timestamp of ["2026-09-30T00:00:00Z", "2026-09-30T00:00:00+00:00", "2026-09-30T09:00:00+09:00", "2026-09-29T19:00:00-05:00"]) {
    assert(routePopularity(circle(1, { ...fresh, followerObservedAt: timestamp }), now).status === "fresh", `equivalent instant ${timestamp}`);
  }
  assert(routePopularity(circle(1, { ...fresh, followerObservedAt: "2024-02-29T00:00:00Z" }), now).status === "stale", "valid leap day");
  assert(routePopularity(circle(1, { ...fresh, followerObservedAt: "2026-10-02T00:00:00Z" }), now).status === "unknown", "future observation");
  const ambiguous = calculateRecommendedRoute([circle(1, { pinX: .1, pinY: 0 }), circle(2, { pinX: 0, pinY: .2 }), circle(3, { mapNumber: null })], { ...options, mapNumberUnique: false });
  assert(ambiguous.ambiguousMap && ambiguous.steps.length === 0 && ambiguous.startPoint === null && ambiguous.unavailableCount === 3, "duplicate number has no route");
  assert(ids([circle(1, { pinX: .1, pinY: 0 }), circle(2, { pinX: 0, pinY: .2 })], { imageWidth: 100, imageHeight: 1000, mapNumberUnique: true }) === "1,2", "unique map uses its aspect ratio");

  const neutral = calculateRecommendedRoute([old, circle(2, { ...fresh, followerCount: null })], options);
  assert(neutral.popularityCounts.stale === 1 && neutral.popularityCounts.unknown === 1, "stale and unknown disclosed");
  const boundaries = calculateRecommendedRoute([
    circle(1), circle(2, { purchaseStatus: 2 }), circle(3, { purchaseStatus: 1 }), circle(4, { purchaseStatus: 3 }), circle(5, { absenceStatus: "欠席" }), circle(6, { mapNumber: null }), circle(7, { pinX: null }), circle(8, { mapNumber: 2 }), circle(9, { pinY: 1.1 }), circle(10, { mapNumber: 0 }),
  ], options);
  assert(boundaries.steps.map(s => s.circle.id).join(",") === "1,2", "only eligible selected-map circles");
  assert(boundaries.unavailableCount === 4 && boundaries.excludedCount === 3, "ambiguous and excluded counts");
  assert(calculateRecommendedRoute([circle(1)], { ...options, imageWidth: 0 }).unavailableCount === 1, "missing image size");
  assert(calculateRecommendedRoute([circle(1, { mapNumber: null })], { ...options, mapNumber: null }).unavailableCount === 1, "no selected map");
  assert(ids([circle(1), circle(2)].filter(c => c.id === 2)) === "2", "uses caller-filtered candidates");
}
