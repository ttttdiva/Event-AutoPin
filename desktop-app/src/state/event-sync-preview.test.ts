import {
  buildEventSyncPreview,
  eventSyncFingerprintsMatch,
} from "./event-sync-preview";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const preview = buildEventSyncPreview(
  {
    event: {
      name: "夏イベント",
      date: "2026-07-01",
      map_calibration_points: [{ space: "A01", pin_x: 10, pin_y: 20 }],
    },
    circles: [
      {
        circle_uid: "one",
        space: "A01",
        penname: "青空書店",
        genre: "小説",
        pin_x: 0.2,
        map_number: 1,
        items: [{ item_uid: "book", title: "新刊", price: 500, checked: "0" }],
      },
      { circle_uid: "gone", space: "A02", penname: "削除予定", items: [] },
    ],
  },
  {
    event: {
      name: "夏イベント 改",
      date: "2026-07-01",
      map_calibration_points: [{ space: "A01", pin_x: 12, pin_y: 20 }],
    },
    circles: [
      {
        circle_uid: "one",
        space: "A01",
        penname: "青空書店",
        genre: "評論",
        pin_x: 0.4,
        map_number: 2,
        items: [{ item_uid: "book", title: "新刊", price: 600, checked: "1" }],
      },
      { circle_uid: "new", space: "B01", penname: "新規追加", items: [{ title: "グッズ", checked: "3" }] },
    ],
  },
  {
    added: [{ key: "circle:new", path: "events/summer/circle_new.png", mobileDigest: "aaa" }],
    changed: [{ key: "map:1", path: "events/summer/map_01.png", desktopDigest: "old", mobileDigest: "new" }],
    deleted: [{ key: "item:gone", path: "events/summer/item_old.png", desktopDigest: "gone" }],
  },
);

const categories = new Map(preview.sections.map((entry) => [entry.id, entry]));
assert(categories.get("event-meta")?.entries.some((entry) => entry.details.includes("夏イベント 改")), "イベントメタ差分が必要です");
assert(categories.get("circles")?.entries.some((entry) => entry.kind === "added"), "サークル追加が必要です");
assert(categories.get("circles")?.entries.some((entry) => entry.kind === "deleted"), "サークル削除が必要です");
assert(categories.get("circles")?.entries.some((entry) => entry.details.includes("ジャンル")), "サークルの変更fieldが必要です");
assert(categories.get("items")?.entries.some((entry) => entry.details.includes("価格")), "頒布物の変更fieldが必要です");
assert(categories.get("purchase-status")?.entries.some((entry) => entry.details.includes("状態")), "購入状態差分が必要です");
assert(categories.get("map-pins")?.entries.some((entry) => entry.details.includes("ピンX")), "マップピン差分が必要です");
assert(categories.get("map-pins")?.entries.some((entry) => entry.label === "校正点"), "校正点差分が必要です");
assert(categories.get("images")?.entries.length === 3, "追加・変更・削除の画像差分が必要です");
assert(preview.counts.added > 0 && preview.counts.changed > 0 && preview.counts.deleted > 0, "差分件数が必要です");

const identical = buildEventSyncPreview({ event: { name: "A" }, circles: [] }, { event: { name: "A" }, circles: [] });
assert(identical.total === 0 && identical.sections.length === 0, "同一データは差分0である必要があります");

const metadataPreview = buildEventSyncPreview(
  {
    event: { name: "A" },
    circles: [],
    metadata: {
      custom_campaign_code: "desk",
      generated_at: "2026-01-01T00:00:00Z",
      format_version: 1,
      total_circles: 10,
      export_type: "desktop",
      source: "pc",
      purchase_results: { bought: 2 },
    },
  },
  {
    event: { name: "A" },
    circles: [],
    metadata: {
      custom_campaign_code: "mobile",
      generated_at: "2026-02-01T00:00:00Z",
      format_version: 2,
      total_circles: 12,
      export_type: "mobile",
      source: "phone",
      purchase_results: { bought: 4 },
    },
  },
);
const metadataEntries = metadataPreview.sections.find((entry) => entry.id === "event-meta")?.entries ?? [];
assert(
  metadataEntries.some((entry) => entry.details.includes("custom_campaign_code") && entry.details.includes("desk") && entry.details.includes("mobile")),
  "トップレベルmetadataの任意field差分が必要です",
);
assert(
  !metadataEntries.some((entry) => /generated_at|format_version|total_circles|export_type|source|purchase_results/.test(entry.details)),
  "生成・集計metadataを差分から除外する必要があります",
);

assert(
  eventSyncFingerprintsMatch({ contentHash: "abc", fileSize: 10 }, { fileSize: 10, contentHash: "abc" }),
  "fingerprintはobject key順が異なっても一致させる必要があります",
);
assert(
  !eventSyncFingerprintsMatch({ contentHash: "before" }, { contentHash: "after" }) &&
    !eventSyncFingerprintsMatch(undefined, undefined),
  "変更または欠落したfingerprintは不一致として扱う必要があります",
);

console.log("event-sync-preview tests passed");
