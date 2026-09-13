import {
  PURCHASE_STATUS,
  PURCHASE_STATUS_LABELS,
  type PurchaseStatusValue,
} from "./types";

/** 保存値は既存の0〜3を維持し、表示だけを分かりやすくする。 */
export const ITEM_PURCHASE_OPTIONS = [
  { value: PURCHASE_STATUS.BOUGHT, label: "購入済み" },
  { value: PURCHASE_STATUS.COULDNT_BUY, label: "買えなかった" },
  { value: PURCHASE_STATUS.SKIPPED, label: "見送り" },
] as const;

export function itemPurchaseStatusLabel(status: PurchaseStatusValue): string {
  return status === PURCHASE_STATUS.BOUGHT
    ? "購入済み"
    : PURCHASE_STATUS_LABELS[status].label;
}

export function formatItemPrice(price: number | null): string {
  return price == null ? "価格不明" : `${price.toLocaleString("ja-JP")}円`;
}

export interface MenuAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface MenuViewport {
  width: number;
  height: number;
}

interface MenuInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** 右端に揃えて開く。下に収まらなければ上、長いメニューは内部でスクロール。 */
export function getItemPurchaseMenuLayout(
  anchor: MenuAnchor,
  viewport: MenuViewport,
  insets: MenuInsets,
  measuredHeight: number,
) {
  const margin = 8;
  const gap = 6;
  const leftEdge = insets.left + margin;
  const topEdge = insets.top + margin;
  const rightEdge = Math.max(leftEdge, viewport.width - insets.right - margin);
  const bottomEdge = Math.max(topEdge, viewport.height - insets.bottom - margin);
  const width = Math.min(296, rightEdge - leftEdge);
  const maxHeight = bottomEdge - topEdge;
  const height = Math.min(Math.max(0, measuredHeight), maxHeight);
  const below = anchor.y + anchor.height + gap;
  const above = anchor.y - gap - height;
  const desiredTop = below + height <= bottomEdge ? below : above;
  return {
    width,
    maxHeight,
    left: Math.max(leftEdge, Math.min(anchor.x + anchor.width - width, rightEdge - width)),
    top: Math.max(topEdge, Math.min(desiredTop, bottomEdge - height)),
  };
}
