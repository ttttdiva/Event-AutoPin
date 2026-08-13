import {
  buildMapPinIndex,
  selectMapPins,
  type MapPinRecord,
} from "./map-pin-index";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Deterministic 500-pin fixture used by the pure map rendering benchmark. */
function create500PinFixture(): MapPinRecord[] {
  return Array.from({ length: 500 }, (_, id) => ({
    id,
    pinX: ((id * 37) % 997) / 997,
    pinY: ((id * 71) % 991) / 991,
    mapNumber: id % 4,
    purchaseStatus: id % 11 === 0 ? 1 : 0,
    priorityColor: [5, 10, 11, 15][id % 4],
    hall: id % 2 === 0 ? "東" : "西",
    space: `A-${String(id + 1).padStart(3, "0")}`,
    name: `サークル${id}`,
    penname: `作家${id}`,
    memo: id % 17 === 0 ? "注目" : "",
    description: id % 13 === 0 ? "新刊" : null,
    hasCatalogPost: id % 3 === 0,
  }));
}

export function runMapPinIndexTests(): void {
  const fixture = create500PinFixture();
  const index = buildMapPinIndex(fixture);
  assert(fixture.length === 500, "fixture should contain 500 pins");
  assert(index.size === 4, "fixture should use four map buckets");

  const startedAt = Date.now();
  const mapOne = selectMapPins(index, {
    mapNumber: 1,
    status: null,
    searchQuery: "",
  });
  const elapsedMs = Date.now() - startedAt;
  assert(mapOne.length > 0, "map 1 should have visible pins");
  assert(
    mapOne.every((pin) => pin.mapNumber === 1 || pin.mapNumber === 0),
    "numbered map should include only its bucket and unassigned pins",
  );
  assert(
    mapOne.every((pin) => pin.purchaseStatus === 0),
    "default status should hide completed pins",
  );

  const searched = selectMapPins(index, {
    mapNumber: null,
    status: 0,
    searchQuery: "注目",
  });
  assert(searched.length > 0, "memo search should match fixture pins");
  assert(searched.every((pin) => pin.memo.includes("注目")), "search result mismatch");

  // This is intentionally a generous guard for CI hosts; it catches an
  // accidental O(N²) regression without making the test timing-sensitive.
  assert(elapsedMs < 1000, `500-pin selection took too long: ${elapsedMs}ms`);
  console.log(`map-pin-index.test passed (${fixture.length} pins, ${elapsedMs}ms)`);
}
