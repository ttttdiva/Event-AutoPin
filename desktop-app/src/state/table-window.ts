/**
 * 可変row height対応のtable virtual window計算。
 * DOMへ依存しないため、filter/sortで候補数が変わった時のclampを
 * desktop UIの外からもテストできる。
 */
export type TableWindowResult = {
  start: number;
  end: number;
  topHeight: number;
  bottomHeight: number;
};

export type TableWindowOptions = {
  windowSize?: number;
  overscanRows?: number;
  estimatedRowHeight?: number;
  rowHeights?: ReadonlyMap<number, number>;
};

/**
 * Return the index of the first circle row in the table data.
 *
 * `circlesToTableState` builds rows directly from `event.json.circles`; it does
 * not prepend a synthetic event-information row.  Do not infer this from an
 * empty サークル名 because a real circle may legitimately have an empty name.
 * A caller that owns a legacy table with an explicit event row can opt in.
 */
export function tableDataStartIndex(hasEventInfoRow = false): number {
  return hasEventInfoRow ? 1 : 0;
}

function rowHeight(
  rowIndex: number,
  rowHeights: ReadonlyMap<number, number> | undefined,
  estimated: number,
): number {
  return Math.max(24, rowHeights?.get(rowIndex) ?? estimated);
}

export function tablePrefixHeight(
  indices: number[],
  startIdx: number,
  end: number,
  options: TableWindowOptions = {},
): number {
  const estimated = options.estimatedRowHeight ?? 42;
  const rowHeights = options.rowHeights;
  let height = 0;
  const safeEnd = Math.max(0, Math.min(indices.length, end));
  for (let i = 0; i < safeEnd; i += 1) {
    height += rowHeight(startIdx + indices[i], rowHeights, estimated);
  }
  return height;
}

export function tableWindowForScroll(
  indices: number[],
  startIdx: number,
  scrollTop: number,
  viewportHeight: number,
  options: TableWindowOptions = {},
): TableWindowResult {
  const windowSize = Math.max(1, options.windowSize ?? 120);
  const overscanRows = Math.max(0, options.overscanRows ?? 24);
  const estimated = Math.max(24, options.estimatedRowHeight ?? 42);
  if (indices.length <= windowSize) {
    return { start: 0, end: indices.length, topHeight: 0, bottomHeight: 0 };
  }

  const totalHeight = tablePrefixHeight(indices, startIdx, indices.length, {
    ...options,
    estimatedRowHeight: estimated,
  });
  const safeViewport = Math.max(1, viewportHeight || 0);
  // Filter後に古いscrollTopが残っても、まず物理的な最大値へclampする。
  const safeScrollTop = Math.min(
    Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0),
    Math.max(0, totalHeight - safeViewport),
  );
  const overscanPx = overscanRows * estimated;
  const targetTop = Math.max(0, safeScrollTop - overscanPx);
  const maxStart = Math.max(0, indices.length - windowSize);
  let cursor = 0;
  let start = 0;
  while (
    start < indices.length &&
    cursor + rowHeight(startIdx + indices[start], options.rowHeights, estimated) <= targetTop
  ) {
    cursor += rowHeight(startIdx + indices[start], options.rowHeights, estimated);
    start += 1;
  }
  // startを候補末尾へ置かない。windowSize分は常に表示可能にする。
  start = Math.max(0, Math.min(start, maxStart));
  const targetBottom =
    safeScrollTop + Math.max(safeViewport, windowSize * estimated) + overscanPx;
  let end = start;
  let visibleHeight = tablePrefixHeight(indices, startIdx, start, options);
  while (end < indices.length && visibleHeight < targetBottom) {
    visibleHeight += rowHeight(startIdx + indices[end], options.rowHeights, estimated);
    end += 1;
  }
  end = Math.min(indices.length, Math.max(start + 1, end));
  const topHeight = tablePrefixHeight(indices, startIdx, start, options);
  const bottomHeight = Math.max(
    0,
    totalHeight - tablePrefixHeight(indices, startIdx, end, options),
  );
  return { start, end, topHeight, bottomHeight };
}
