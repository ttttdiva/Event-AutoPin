export type EventSyncChangeKind = "added" | "changed" | "deleted";

export type EventSyncDiffEntry = {
  kind: EventSyncChangeKind;
  label: string;
  details: string;
};

export type EventSyncDiffSection = {
  id: string;
  title: string;
  entries: EventSyncDiffEntry[];
};

export type EventSyncPreview = {
  sections: EventSyncDiffSection[];
  counts: Record<EventSyncChangeKind, number>;
  total: number;
};

type JsonObject = Record<string, unknown>;
type RecordPair = { desktop: unknown | null; mobile: unknown | null; index: number };

const CIRCLE_FIELDS: Record<string, string> = {
  space: "スペース",
  hall: "ホール",
  penname: "サークル名",
  name: "サークル名",
  genre: "ジャンル",
  twitter: "Twitter",
  url: "URL",
  catalog_status: "頒布状況",
  price: "価格",
  absent: "欠席",
  is_absent: "欠席",
  priority: "優先度",
  memo: "メモ",
  note: "メモ",
  image: "サークル画像",
  image_path: "サークル画像",
  images: "サークル画像",
  item_images: "頒布物画像",
  map_number: "マップ番号",
  pin_x: "ピンX",
  pin_y: "ピンY",
  x: "X座標",
  y: "Y座標",
  checked: "購入状態",
  items: "頒布物",
};

const PIN_FIELDS = new Set([
  "map_number", "pin_x", "pin_y", "x", "y", "coordinates", "map_pin",
  "map_position", "position", "pin",
]);
const PURCHASE_FIELDS = new Set([
  "checked", "purchase_status", "status", "bought", "purchased",
]);
const ITEM_IMAGE_FIELDS = new Set([
  "image", "image_path", "images", "item_images", "catalog_images", "catalog_image",
]);
const GENERATED_METADATA_FIELDS = new Set([
  "generated_at",
  "format_version",
  "schema_version",
  "total_circles",
  "total_events",
  "event_count",
  "image_count",
  "export_type",
  "source",
  "purchase_results",
  "purchase_summary",
  "purchase_result_summary",
  "purchase_status_summary",
]);

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function sortedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedValue);
  const object = asObject(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.keys(object).sort().map((key) => [key, sortedValue(object[key])]),
  );
}

function valueKey(value: unknown): string {
  return JSON.stringify(sortedValue(value));
}

function normalizedMetadataKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLocaleLowerCase();
}

/** Missing fingerprints fail closed; object key order does not affect the result. */
export function eventSyncFingerprintsMatch(expected: unknown, current: unknown): boolean {
  if (expected === null || expected === undefined || current === null || current === undefined) {
    return false;
  }
  if (typeof expected === "string" && !expected.trim()) return false;
  if (typeof current === "string" && !current.trim()) return false;
  const expectedObject = asObject(expected);
  const currentObject = asObject(current);
  if (expectedObject && Object.keys(expectedObject).length === 0) return false;
  if (currentObject && Object.keys(currentObject).length === 0) return false;
  return valueKey(expected) === valueKey(current);
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "（なし）";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = JSON.stringify(sortedValue(value));
  return text.length > 180 ? `${text.slice(0, 177)}…` : text;
}

function section(
  sections: EventSyncDiffSection[],
  id: string,
  title: string,
): EventSyncDiffSection {
  let existing = sections.find((candidate) => candidate.id === id);
  if (!existing) {
    existing = { id, title, entries: [] };
    sections.push(existing);
  }
  return existing;
}

function add(
  sections: EventSyncDiffSection[],
  sectionId: string,
  title: string,
  kind: EventSyncChangeKind,
  label: string,
  details: string,
): void {
  section(sections, sectionId, title).entries.push({ kind, label, details });
}

function describeField(key: string, before: unknown, after: unknown): string {
  const label = CIRCLE_FIELDS[key] ?? key;
  return `${label}: ${displayValue(before)} → ${displayValue(after)}`;
}

function eventLabel(event: JsonObject): string {
  return [event.name, event.date, event.venue ?? event.place]
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map(String)
    .join(" / ") || "イベント情報";
}

function circleLabel(circle: unknown, index: number): string {
  const value = asObject(circle);
  if (!value) return `サークル ${index + 1}`;
  const space = [value.hall, value.space].filter(Boolean).map(String).join(" ");
  const name = String(value.penname ?? value.name ?? "").trim();
  return [space, name].filter(Boolean).join(" / ") || `サークル ${index + 1}`;
}

function explicitId(value: unknown, keys: string[]): string | null {
  const object = asObject(value);
  if (!object) return null;
  for (const key of keys) {
    const raw = object[key];
    if (typeof raw === "string" || typeof raw === "number") {
      const normalized = String(raw).trim();
      if (normalized) return `${key}:${normalized}`;
    }
  }
  return null;
}

function hasExplicitId(value: unknown, keys: string[]): boolean {
  return explicitId(value, keys) !== null;
}

function circleIdentity(value: unknown): string | null {
  const object = asObject(value);
  if (!object) return null;
  const explicit = explicitId(value, ["circle_uid", "circle_id", "uid", "id", "circle_key"]);
  if (explicit) return explicit;
  const hall = String(object.hall ?? "").trim().toLocaleLowerCase();
  const space = String(object.space ?? "").trim().toLocaleLowerCase();
  if (space || hall) return `space:${hall}|${space}`;
  const name = String(object.penname ?? object.name ?? "").trim().toLocaleLowerCase();
  return name ? `name:${name}` : null;
}

function itemIdentity(value: unknown): string | null {
  if (typeof value === "string") return value.trim() ? `name:${value.trim().toLocaleLowerCase()}` : null;
  const object = asObject(value);
  if (!object) return null;
  const explicit = explicitId(value, ["item_uid", "item_id", "uid", "id"]);
  if (explicit) return explicit;
  const title = String(object.title ?? object.name ?? object.item_name ?? "").trim();
  return title ? `name:${title.toLocaleLowerCase()}` : null;
}

function pairRecords(
  desktopValues: unknown[],
  mobileValues: unknown[],
  identity: (value: unknown) => string | null,
  explicitKeys: string[] = [],
): RecordPair[] {
  const mobileBuckets = new Map<string, number[]>();
  mobileValues.forEach((value, index) => {
    const key = identity(value);
    if (key === null) return;
    const bucket = mobileBuckets.get(key) ?? [];
    bucket.push(index);
    mobileBuckets.set(key, bucket);
  });
  const usedMobile = new Set<number>();
  const pairs: RecordPair[] = [];
  const unmatchedDesktop: number[] = [];
  desktopValues.forEach((value, index) => {
    const key = identity(value);
    const bucket = key === null ? undefined : mobileBuckets.get(key);
    const match = bucket?.find((candidate) => !usedMobile.has(candidate));
    if (match === undefined) {
      unmatchedDesktop.push(index);
      return;
    }
    usedMobile.add(match);
    pairs.push({ desktop: value, mobile: mobileValues[match], index });
  });

  // 同一位置の未同定行は、名前などの編集として比較する。片側だけ残る
  // 行は、追加・削除として扱うため位置がずれた行を誤対応しない。
  const stillUnmatchedDesktop = new Set(unmatchedDesktop);
  const stillUnmatchedMobile = new Set(
    mobileValues.map((_, index) => index).filter((index) => !usedMobile.has(index)),
  );
  for (const desktopIndex of unmatchedDesktop) {
    if (!stillUnmatchedMobile.has(desktopIndex)) continue;
    if (
      explicitKeys.length > 0 &&
      hasExplicitId(desktopValues[desktopIndex], explicitKeys) &&
      hasExplicitId(mobileValues[desktopIndex], explicitKeys)
    ) continue;
    usedMobile.add(desktopIndex);
    stillUnmatchedDesktop.delete(desktopIndex);
    stillUnmatchedMobile.delete(desktopIndex);
    pairs.push({ desktop: desktopValues[desktopIndex], mobile: mobileValues[desktopIndex], index: desktopIndex });
  }
  for (const index of stillUnmatchedDesktop) {
    pairs.push({ desktop: desktopValues[index], mobile: null, index });
  }
  for (const index of stillUnmatchedMobile) {
    pairs.push({ desktop: null, mobile: mobileValues[index], index });
  }
  return pairs.sort((left, right) => left.index - right.index);
}

function compareFields(
  before: unknown,
  after: unknown,
  excluded: Set<string> = new Set(),
): string[] {
  const left = asObject(before) ?? {};
  const right = asObject(after) ?? {};
  return Array.from(new Set([...Object.keys(left), ...Object.keys(right)]))
    .filter((key) => !excluded.has(key))
    .filter((key) => valueKey(left[key]) !== valueKey(right[key]))
    .sort()
    .map((key) => describeField(key, left[key], right[key]));
}

function compactRecord(value: unknown): string {
  const object = asObject(value);
  if (!object) return displayValue(value);
  return ["hall", "space", "penname", "name", "genre", "price", "checked", "catalog_status"]
    .filter((key) => object[key] !== undefined && object[key] !== null && object[key] !== "")
    .map((key) => `${CIRCLE_FIELDS[key] ?? key}=${displayValue(object[key])}`)
    .join(" / ") || displayValue(value);
}

function circleArrays(data: unknown): unknown[] {
  const object = asObject(data);
  return Array.isArray(object?.circles) ? object.circles : [];
}

function itemsFor(circle: unknown): unknown[] {
  const object = asObject(circle);
  return Array.isArray(object?.items) ? object.items : [];
}

function purchaseStatus(value: unknown): unknown {
  const object = asObject(value);
  if (!object) return undefined;
  for (const key of PURCHASE_FIELDS) {
    if (object[key] !== undefined) return object[key];
  }
  return undefined;
}

function assetKind(asset: JsonObject): string {
  const key = `${String(asset.key ?? "")} ${String(asset.path ?? "")}`.toLocaleLowerCase();
  if (/map|地図/.test(key)) return "マップ画像";
  if (/item|catalog|goods|頒布|おしながき/.test(key)) return "頒布物画像";
  if (/circle|cut|サークル/.test(key)) return "サークル画像";
  if (/event|イベント/.test(key)) return "イベント画像";
  return "画像";
}

/**
 * デスクトップとモバイルのイベントJSON、画像asset digestを表示用差分へ変換する。
 * 入力を変更せず、存在しないフィールドを空値として比較する。
 */
export function buildEventSyncPreview(
  desktopData: unknown,
  mobileData: unknown,
  rawAssetDiff?: unknown,
): EventSyncPreview {
  const sections: EventSyncDiffSection[] = [];
  const desktop = asObject(desktopData) ?? {};
  const mobile = asObject(mobileData) ?? {};
  const desktopEvent = asObject(desktop.event) ?? {};
  const mobileEvent = asObject(mobile.event) ?? {};

  for (const detail of compareFields(
    desktopEvent,
    mobileEvent,
    new Set(["map_calibration_points"]),
  )) {
    add(sections, "event-meta", "イベントメタ", "changed", eventLabel(desktopEvent), detail);
  }

  const desktopMetadata = asObject(desktop.metadata) ?? {};
  const mobileMetadata = asObject(mobile.metadata) ?? {};
  const metadataKeys = new Set([...Object.keys(desktopMetadata), ...Object.keys(mobileMetadata)]);
  for (const key of Array.from(metadataKeys).sort()) {
    if (GENERATED_METADATA_FIELDS.has(normalizedMetadataKey(key))) continue;
    if (valueKey(desktopMetadata[key]) === valueKey(mobileMetadata[key])) continue;
    const hasDesktopValue = Object.prototype.hasOwnProperty.call(desktopMetadata, key);
    const hasMobileValue = Object.prototype.hasOwnProperty.call(mobileMetadata, key);
    const kind: EventSyncChangeKind = !hasDesktopValue
      ? "added"
      : !hasMobileValue
        ? "deleted"
        : "changed";
    add(
      sections,
      "event-meta",
      "イベントメタ",
      kind,
      "追加メタデータ",
      `${key}: ${displayValue(desktopMetadata[key])} → ${displayValue(mobileMetadata[key])}`,
    );
  }

  const circlePairs = pairRecords(
    circleArrays(desktop),
    circleArrays(mobile),
    circleIdentity,
    ["circle_uid", "circle_id", "uid", "id", "circle_key"],
  );
  for (const pair of circlePairs) {
    const oldCircle = asObject(pair.desktop);
    const newCircle = asObject(pair.mobile);
    const label = circleLabel(pair.desktop ?? pair.mobile, pair.index);
    if (!oldCircle) {
      add(sections, "circles", "サークル", "added", label, compactRecord(pair.mobile));
    } else if (!newCircle) {
      add(sections, "circles", "サークル", "deleted", label, compactRecord(pair.desktop));
    } else {
      for (const detail of compareFields(oldCircle, newCircle, new Set(["items"]))) {
        add(sections, "circles", "サークル", "changed", label, detail);
      }
    }

    const oldItems = itemsFor(pair.desktop);
    const newItems = itemsFor(pair.mobile);
    const itemPairs = pairRecords(oldItems, newItems, itemIdentity, ["item_uid", "item_id", "uid", "id"]);
    for (const itemPair of itemPairs) {
      const oldItem = asObject(itemPair.desktop);
      const newItem = asObject(itemPair.mobile);
      const itemLabel = `${label} / ${String((newItem ?? oldItem)?.title ?? (newItem ?? oldItem)?.name ?? `頒布物 ${itemPair.index + 1}`)}`;
      if (!oldItem) {
        add(sections, "items", "頒布物", "added", itemLabel, compactRecord(itemPair.mobile));
      } else if (!newItem) {
        add(sections, "items", "頒布物", "deleted", itemLabel, compactRecord(itemPair.desktop));
      } else {
        const details = compareFields(oldItem, newItem, ITEM_IMAGE_FIELDS);
        for (const detail of details) add(sections, "items", "頒布物", "changed", itemLabel, detail);
      }

      const oldStatus = purchaseStatus(itemPair.desktop);
      const newStatus = purchaseStatus(itemPair.mobile);
      if (valueKey(oldStatus) !== valueKey(newStatus)) {
        add(
          sections,
          "purchase-status",
          "購入状態",
          !oldItem ? "added" : !newItem ? "deleted" : "changed",
          itemLabel,
          `状態: ${displayValue(oldStatus)} → ${displayValue(newStatus)}`,
        );
      }
    }

    const oldCircleStatus = purchaseStatus(pair.desktop);
    const newCircleStatus = purchaseStatus(pair.mobile);
    if (itemsFor(pair.desktop).length === 0 && itemsFor(pair.mobile).length === 0 && valueKey(oldCircleStatus) !== valueKey(newCircleStatus)) {
      add(
        sections,
        "purchase-status",
        "購入状態",
        !oldCircle ? "added" : !newCircle ? "deleted" : "changed",
        label,
        `状態: ${displayValue(oldCircleStatus)} → ${displayValue(newCircleStatus)}`,
      );
    }

    const oldPins = oldCircle ? Object.fromEntries(Object.entries(oldCircle).filter(([key]) => PIN_FIELDS.has(key))) : null;
    const newPins = newCircle ? Object.fromEntries(Object.entries(newCircle).filter(([key]) => PIN_FIELDS.has(key))) : null;
    const pinDetails = compareFields(oldPins, newPins);
    for (const detail of pinDetails) {
      add(sections, "map-pins", "マップピン", !oldCircle ? "added" : !newCircle ? "deleted" : "changed", label, detail);
    }
  }

  const oldCalibration = desktopEvent.map_calibration_points;
  const newCalibration = mobileEvent.map_calibration_points;
  if (valueKey(oldCalibration) !== valueKey(newCalibration)) {
    add(
      sections,
      "map-pins",
      "マップピン・校正",
      "changed",
      "校正点",
      `校正点: ${displayValue(oldCalibration)} → ${displayValue(newCalibration)}`,
    );
  }

  const assetDiff = asObject(rawAssetDiff) ?? {};
  const assetActions: Array<[string, EventSyncChangeKind]> = [
    ["added", "added"], ["changed", "changed"], ["deleted", "deleted"],
  ];
  for (const [action, kind] of assetActions) {
    const assets = Array.isArray(assetDiff[action]) ? assetDiff[action] as unknown[] : [];
    for (const rawAsset of assets) {
      const asset = asObject(rawAsset) ?? {};
      const imageKind = assetKind(asset);
      const label = String(asset.path ?? asset.key ?? imageKind);
      const digests = [asset.desktopDigest, asset.mobileDigest]
        .filter((value) => value !== undefined && value !== null)
        .map((value) => displayValue(value));
      add(
        sections,
        "images",
        "画像差分（イベント・サークル・頒布物・マップ）",
        kind,
        `${imageKind}: ${label}`,
        digests.length ? `hash: ${digests.join(" → ")}` : "画像ハッシュが異なります",
      );
    }
  }

  const counts: Record<EventSyncChangeKind, number> = { added: 0, changed: 0, deleted: 0 };
  for (const diffSection of sections) {
    for (const entry of diffSection.entries) counts[entry.kind] += 1;
  }
  return {
    sections: sections.filter((candidate) => candidate.entries.length > 0),
    counts,
    total: counts.added + counts.changed + counts.deleted,
  };
}
