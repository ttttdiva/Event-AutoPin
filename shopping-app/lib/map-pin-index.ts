/**
 * Pure map-pin indexing/filtering helpers.
 *
 * Keeping this work outside MapView makes the hot path easy to benchmark and
 * prevents a chain of `filter()` allocations for every map render.
 */
export interface MapPinRecord {
  id: number;
  pinX: number | null;
  pinY: number | null;
  mapNumber: number | null;
  purchaseStatus: number;
  priorityColor: number;
  hall: string | null;
  space?: string | null;
  name: string;
  penname: string | null;
  memo: string;
  description: string | null;
  hasCatalogPost: boolean;
}

export interface MapPinFilters {
  /** Current map number. `null` means that all indexed maps are candidates. */
  mapNumber: number | null;
  /** Empty/null status keeps only not-yet circles (the default map behavior). */
  status: number | null | undefined;
  colors?: ReadonlySet<number>;
  priorities?: ReadonlySet<number>;
  hall?: string | null;
  catalogPostOnly?: boolean;
  hideSkipped?: boolean;
  searchQuery?: string;
  globalSearchEnabled?: boolean;
  itemSearchText?: ReadonlyMap<number, readonly string[]>;
}

export function buildMapPinIndex<T extends MapPinRecord>(
  circles: readonly T[],
): Map<number, T[]> {
  const index = new Map<number, T[]>();
  for (const circle of circles) {
    if (circle.pinX == null || circle.pinY == null) continue;
    const key = circle.mapNumber ?? 0;
    const bucket = index.get(key);
    if (bucket) bucket.push(circle);
    else index.set(key, [circle]);
  }
  return index;
}

/**
 * Select visible pins in a single pass. Map 0 is the unassigned bucket and is
 * shown together with a numbered map, matching the legacy MapView behavior.
 */
export function selectMapPins<T extends MapPinRecord>(
  index: ReadonlyMap<number, readonly T[]>,
  filters: MapPinFilters,
): T[] {
  const candidates: readonly T[] =
    filters.mapNumber == null
      ? Array.from(index.values()).flat()
      : filters.mapNumber === 0
        ? index.get(0) ?? []
        : [
            ...(index.get(filters.mapNumber) ?? []),
            ...(index.get(0) ?? []),
          ];
  const query = filters.searchQuery?.trim().toLowerCase() ?? "";
  const hasQuery = query.length > 0;
  const colors = filters.colors;
  const priorities = filters.priorities;
  const itemSearchText = filters.itemSearchText;
  const result: T[] = [];

  for (const circle of candidates) {
    // M4: without an explicit status filter only unpurchased circles are
    // shown by default.
    if (
      filters.status == null
        ? circle.purchaseStatus !== 0
        : circle.purchaseStatus !== filters.status
    ) {
      continue;
    }
    if (colors && colors.size > 0 && !colors.has(circle.priorityColor)) {
      continue;
    }
    if (
      priorities &&
      priorities.size > 0 &&
      !priorities.has(circle.priorityColor)
    ) {
      continue;
    }
    if (filters.hall && circle.hall !== filters.hall) continue;
    if (filters.catalogPostOnly && !circle.hasCatalogPost) continue;
    if (filters.hideSkipped && circle.purchaseStatus === 3) continue;

    if (hasQuery) {
      const itemMatches = (itemSearchText?.get(circle.id) ?? []).some((text) =>
        text.toLowerCase().includes(query),
      );
      const nameMatches = circle.name.toLowerCase().includes(query);
      const pennameMatches =
        circle.penname?.toLowerCase().includes(query) ?? false;
      const memoMatches = circle.memo.toLowerCase().includes(query);
      const descriptionMatches =
        circle.description?.toLowerCase().includes(query) ?? false;
      if (filters.globalSearchEnabled) {
        if (
          !nameMatches &&
          !pennameMatches &&
          !memoMatches &&
          !descriptionMatches &&
          !itemMatches
        ) {
          continue;
        }
      } else {
        const spaceMatches = circle.space?.toLowerCase().includes(query) ?? false;
        const hallMatches = circle.hall?.toLowerCase().includes(query) ?? false;
        if (
          !nameMatches &&
          !spaceMatches &&
          !pennameMatches &&
          !hallMatches &&
          !memoMatches &&
          !itemMatches
        ) {
          continue;
        }
      }
    }
    result.push(circle);
  }
  return result;
}
