export const PURCHASE_STATUS = {
  NOT_YET: 0,
  BOUGHT: 1,
  COULDNT_BUY: 2,
  SKIPPED: 3,
} as const;

export type PurchaseStatusValue =
  (typeof PURCHASE_STATUS)[keyof typeof PURCHASE_STATUS];

export const PURCHASE_STATUS_VIEWS: Record<
  PurchaseStatusValue,
  { icon: string; label: string; color: string; bg: string }
> = {
  [PURCHASE_STATUS.NOT_YET]: {
    icon: "○",
    label: "未購入",
    color: "#757575",
    bg: "",
  },
  [PURCHASE_STATUS.BOUGHT]: {
    icon: "✓",
    label: "買えた",
    color: "#2e7d32",
    bg: "rgba(46,125,50,0.12)",
  },
  [PURCHASE_STATUS.COULDNT_BUY]: {
    icon: "✗",
    label: "買えなかった",
    color: "#c62828",
    bg: "rgba(198,40,40,0.12)",
  },
  [PURCHASE_STATUS.SKIPPED]: {
    icon: "−",
    label: "見送り",
    color: "#6d4c41",
    bg: "rgba(109,76,65,0.12)",
  },
};

export function normalizePurchaseStatus(value: unknown): PurchaseStatusValue {
  const n = Number(value ?? PURCHASE_STATUS.NOT_YET);
  if (
    n === PURCHASE_STATUS.BOUGHT ||
    n === PURCHASE_STATUS.COULDNT_BUY ||
    n === PURCHASE_STATUS.SKIPPED
  ) {
    return n as PurchaseStatusValue;
  }
  return PURCHASE_STATUS.NOT_YET;
}

export function nextPurchaseStatus(value: unknown): PurchaseStatusValue {
  const current = normalizePurchaseStatus(value);
  if (current === PURCHASE_STATUS.NOT_YET) return PURCHASE_STATUS.BOUGHT;
  if (current === PURCHASE_STATUS.BOUGHT) return PURCHASE_STATUS.COULDNT_BUY;
  if (current === PURCHASE_STATUS.COULDNT_BUY) return PURCHASE_STATUS.SKIPPED;
  return PURCHASE_STATUS.NOT_YET;
}

export function getEffectiveItemStatus(
  item: { checked?: unknown } | null | undefined,
  circle: { checked?: unknown } | null | undefined,
): PurchaseStatusValue {
  if (item && item.checked !== undefined && item.checked !== null) {
    return normalizePurchaseStatus(item.checked);
  }
  return normalizePurchaseStatus(circle?.checked);
}
