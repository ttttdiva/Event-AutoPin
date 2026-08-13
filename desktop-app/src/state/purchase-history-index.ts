/** 購入履歴をイベント単位で保持する派生インデックス。 */
export const PURCHASE_STATUS_BOUGHT = 1;

export function normalizePurchaseLookupKey(value: unknown): string {
  const raw = String(value ?? "");
  const normalized = typeof raw.normalize === "function" ? raw.normalize("NFKC") : raw;
  return normalized.trim().toLowerCase().replace(/\s+/g, "");
}

export function purchasedItemKey(circleKey: string, itemKey: string): string {
  return `${circleKey}\u0000${itemKey}`;
}

export function buildPurchasedItemIndex(data: any): Set<string> {
  const index = new Set<string>();
  for (const circle of data?.circles ?? []) {
    const circleKeys = [circle?.name, circle?.penname]
      .map(normalizePurchaseLookupKey)
      .filter(Boolean);
    if (!circleKeys.length) continue;
    for (const item of circle.items ?? []) {
      const status = Number(item?.checked ?? circle?.checked ?? 0);
      if (status !== PURCHASE_STATUS_BOUGHT) continue;
      const itemKey = normalizePurchaseLookupKey(item?.name);
      if (!itemKey) continue;
      for (const circleKey of circleKeys) index.add(purchasedItemKey(circleKey, itemKey));
    }
  }
  return index;
}

export type PurchaseHistoryFingerprint = {
  modifiedMs?: number;
  fileSize?: number;
};

type Entry = {
  keys: Set<string>;
  fingerprint?: PurchaseHistoryFingerprint;
};

/**
 * 他イベントのevent.jsonを通常切替で読まないためのper-eventキャッシュ。
 * cacheは派生値なので破棄・再構築でき、delete/rename/importも局所更新する。
 */
export class PurchaseHistoryIndexService {
  private readonly entries = new Map<string, Entry>();

  get(slug: string): ReadonlySet<string> {
    return this.entries.get(slug)?.keys ?? EMPTY_INDEX;
  }

  replace(slug: string, data: any, fingerprint?: PurchaseHistoryFingerprint): ReadonlySet<string> {
    const keys = buildPurchasedItemIndex(data);
    this.entries.set(slug, { keys, fingerprint });
    return keys;
  }

  setIndex(slug: string, keys: Iterable<string>, fingerprint?: PurchaseHistoryFingerprint): void {
    this.entries.set(slug, { keys: new Set(keys), fingerprint });
  }

  remove(slug: string): void {
    this.entries.delete(slug);
  }

  rename(oldSlug: string, newSlug: string): void {
    const value = this.entries.get(oldSlug);
    if (!value) return;
    this.entries.delete(oldSlug);
    this.entries.set(newSlug, value);
  }

  fingerprint(slug: string): PurchaseHistoryFingerprint | undefined {
    return this.entries.get(slug)?.fingerprint;
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

const EMPTY_INDEX: ReadonlySet<string> = new Set<string>();

