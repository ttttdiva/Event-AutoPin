import {
  PURCHASE_STATUS,
  PURCHASE_STATUS_VIEWS,
  getEffectiveItemStatus,
  type PurchaseStatusValue,
} from "./purchase-status";

export type HistorySearchItemDto = {
  name: string;
  checked?: number | null;
};

export type HistoryPurchaseSummary = {
  total: number;
  bought: number;
  couldntBuy: number;
  skipped: number;
  hasItems: boolean;
};

export function buildHistoryPurchaseSummary(
  items: HistorySearchItemDto[],
  circleChecked: unknown,
): HistoryPurchaseSummary {
  if (!items.length) {
    return {
      total: 0,
      bought: 0,
      couldntBuy: 0,
      skipped: 0,
      hasItems: false,
    };
  }

  const circle = { checked: circleChecked };
  let bought = 0;
  let couldntBuy = 0;
  let skipped = 0;
  for (const item of items) {
    const status = getEffectiveItemStatus(item, circle);
    if (status === PURCHASE_STATUS.BOUGHT) bought += 1;
    else if (status === PURCHASE_STATUS.COULDNT_BUY) couldntBuy += 1;
    else if (status === PURCHASE_STATUS.SKIPPED) skipped += 1;
  }

  return {
    total: items.length,
    bought,
    couldntBuy,
    skipped,
    hasItems: true,
  };
}

export function historyPurchaseSummaryLabel(
  summary: HistoryPurchaseSummary,
): string {
  if (!summary.hasItems) return "アイテム情報なし";
  const view = PURCHASE_STATUS_VIEWS[PURCHASE_STATUS.BOUGHT];
  return `${view.icon} ${view.label} ${summary.bought}/${summary.total}`;
}

export function historyItemStatusLabel(status: PurchaseStatusValue): string {
  const view = PURCHASE_STATUS_VIEWS[status];
  return `${view.icon} ${view.label}`;
}

export function normalizeEventPath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

export function findEventSlugByNormalizedDir(
  events: Array<{ slug: string; dir: string }>,
  eventDir: string,
): string | null {
  const normalized = normalizeEventPath(eventDir);
  const match = events.find(
    (event) => normalizeEventPath(event.dir) === normalized,
  );
  return match?.slug ?? null;
}

export type HistoryOpenAfterSelectResult =
  | { action: "open-tab" }
  | { action: "stay" };

export function resolveHistoryOpenAfterSelect(
  selectOk: boolean,
): HistoryOpenAfterSelectResult {
  return selectOk ? { action: "open-tab" } : { action: "stay" };
}

export function shouldContinueHistoryOpen(
  generation: number,
  latestGeneration: number,
): boolean {
  return generation === latestGeneration;
}

export type HistoryOpenPlan = {
  generation: number;
  eventDir: string;
};

export function planHistoryOpenRetry(
  plan: HistoryOpenPlan,
  latestGeneration: number,
  slugAfterReload: string | null,
): "continue" | "abort" | "error" {
  if (!shouldContinueHistoryOpen(plan.generation, latestGeneration)) {
    return "abort";
  }
  if (!slugAfterReload) {
    return "error";
  }
  return "continue";
}

export function escapeHtmlForDisplay(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderHistoryItemRowHtml(
  itemName: string,
  statusLabel: string,
  statusColor: string,
): string {
  return `<span class="history-item-name">${escapeHtmlForDisplay(itemName)}</span><span class="history-item-status" style="color:${statusColor}">${escapeHtmlForDisplay(statusLabel)}</span>`;
}

export function isUnsafeEventAssetRef(ref: string): boolean {
  const normalized = normalizeEventAssetRef(ref);
  return normalized.split("/").some((segment) => segment === "..");
}

export function normalizeEventAssetRef(ref: string): string {
  return String(ref || "").replace(/\\/g, "/");
}

export function resolveEventAssetFilePath(eventDir: string, ref: string): string {
  const normalized = normalizeEventAssetRef(ref);
  if (
    !normalized ||
    normalized.startsWith("file://") ||
    normalized.startsWith("http://") ||
    normalized.startsWith("https://") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.startsWith("data:image") ||
    isUnsafeEventAssetRef(normalized)
  ) {
    return normalized;
  }
  const baseDir = eventDir.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return baseDir ? `${baseDir}/${normalized}` : normalized;
}

export function resolveEventImageSrc(
  eventDir: string,
  pathOrUrl: string,
  convertFileSrc: (absPath: string) => string,
): string {
  if (!pathOrUrl) return "";
  if (
    pathOrUrl.startsWith("http://") ||
    pathOrUrl.startsWith("https://") ||
    pathOrUrl.startsWith("data:image")
  ) {
    return pathOrUrl;
  }
  const absPath = resolveEventAssetFilePath(eventDir, pathOrUrl);
  if (
    absPath.startsWith("http://") ||
    absPath.startsWith("https://") ||
    absPath.startsWith("data:image")
  ) {
    return absPath;
  }
  return convertFileSrc(absPath);
}
