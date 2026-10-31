import assert from "node:assert/strict";
import {
  buildSingleEventSyncDiff,
  parseSingleEventSyncDownloadUrl,
  parseSingleEventSyncUploadUrl,
  parseSingleEventSyncSessionResponse,
  redactSyncUrl,
  redactSyncText,
  resolveSingleEventSyncIdentity,
  resolveSingleEventSyncUid,
  shouldRetrySingleEventSyncCancellation,
  singleEventSyncImageRefs,
} from "./single-event-sync";
import type { ImportData } from "./types";

const base = "http://192.168.1.25:43123/upload?token=secret&mode=single-event-sync&target_uid=event-a&target_name=Test&target_date=2026-10-31&direction=receive";

export function runSingleEventSyncTests(): void {
  const upload = parseSingleEventSyncUploadUrl(base);
  assert.equal(upload.targetUid, "event-a");
  assert.equal(upload.token, "secret");
  assert.equal(resolveSingleEventSyncIdentity({
    selectedUid: "event-a",
    targetUid: "event-a",
    selectedName: "Other name",
    selectedDate: "2020-01-01",
    targetName: null,
    targetDate: null,
  }), "matched");
  const pairingAction = resolveSingleEventSyncIdentity({
    selectedUid: null,
    targetUid: "event-a",
    selectedName: "Test",
    selectedDate: "2026-10-31",
    targetName: "Test",
    targetDate: "2026-10-31",
  });
  assert.equal(pairingAction, "link-required");
  assert.equal(resolveSingleEventSyncUid({
    selectedUid: null,
    targetUid: "event-a",
    identityAction: pairingAction,
  }), "event-a");

  const rejectedUrls = [
    base.replace("http://", "https://"),
    base.replace("192.168.1.25", "example.com"),
    base.replace("192.168.1.25", "8.8.8.8"),
    base.replace("http://", "http://user:pass@"),
    base.replace("/upload?", "/other?").replace("http://", "http://"),
    base.replace("token=secret", "token=secret&token=duplicate"),
    base.replace("&mode=single-event-sync", ""),
    base.replace("&target_uid=event-a", ""),
    `${base}&unexpected=1`,
    base.replace("&direction=receive", ""),
    base.replace("direction=receive", "direction=sideways"),
    `${base}&direction=send`,
  ];
  for (const [index, rejected] of rejectedUrls.entries()) {
    let accepted = false;
    try { parseSingleEventSyncUploadUrl(rejected); accepted = true; } catch { /* expected */ }
    assert.equal(accepted, false, `accepted unsafe URL ${index}: ${rejected}`);
  }
  assert.throws(() => resolveSingleEventSyncIdentity({
    selectedUid: "different",
    targetUid: "event-a",
    selectedName: "Test",
    selectedDate: "2026-10-31",
    targetName: "Test",
    targetDate: "2026-10-31",
  }));
  assert.throws(() => resolveSingleEventSyncIdentity({
    selectedUid: null,
    targetUid: "event-a",
    selectedName: "Test",
    selectedDate: null,
    targetName: "Test",
    targetDate: null,
  }));
  assert.equal(
    parseSingleEventSyncDownloadUrl("http://10.0.0.5:8080/mobile_export.zip?token=x&mode=single-event-sync&target_uid=event-a").targetUid,
    "event-a",
  );
  const outboundUrl = "http://10.0.0.5:8080/mobile_export.zip?token=outbound&mode=single-event-sync&target_uid=event-a";
  assert.equal(
    parseSingleEventSyncSessionResponse(JSON.stringify({ status: "pc-ready", target_uid: "event-a", download_url: outboundUrl }), "event-a").state,
    "pc-ready",
  );
  assert.equal(
    parseSingleEventSyncSessionResponse(JSON.stringify({ state: "mobile-applied", targetUid: "event-a" }), "event-a").state,
    "mobile-applied",
  );
  assert.equal(
    parseSingleEventSyncSessionResponse(JSON.stringify({ state: "mobile-applied", target_uid: "event-a", delivered: true }), "event-a").delivered,
    true,
  );
  assert.equal(
    parseSingleEventSyncSessionResponse(JSON.stringify({ decision: "mobile-selected", target_uid: "event-a" }), "event-a").state,
    "mobile-applied",
  );
  assert.equal(
    parseSingleEventSyncSessionResponse(JSON.stringify({ status: "pending", target_uid: "event-a" }), "event-a").state,
    "pending",
  );
  assert.equal(
    parseSingleEventSyncSessionResponse(JSON.stringify({ status: "cancelled", target_uid: "event-a", error: "user cancelled" }), "event-a").state,
    "cancelled",
  );
  assert.equal(
    parseSingleEventSyncSessionResponse(JSON.stringify({ status: "error", target_uid: "event-a", error: "upload too large" }), "event-a").state,
    "error",
  );
  assert.equal(shouldRetrySingleEventSyncCancellation("pending"), true);
  assert.equal(shouldRetrySingleEventSyncCancellation("error"), false);
  assert.equal(shouldRetrySingleEventSyncCancellation("cancelled"), false);
  assert.equal(shouldRetrySingleEventSyncCancellation("mobile-applied"), false);
  assert.throws(() => parseSingleEventSyncSessionResponse(JSON.stringify({ download_url: outboundUrl.replace("event-a", "other") }), "event-a"));
  assert.throws(() => parseSingleEventSyncSessionResponse(JSON.stringify({ target_uid: "other" }), "event-a"));
  for (const rejected of [
    "https://192.168.1.25:8080/mobile_export.zip?token=x&mode=single-event-sync&target_uid=event-a",
    "http://public.example/mobile_export.zip?token=x&mode=single-event-sync&target_uid=event-a",
    "http://192.168.1.25:8080/mobile_export.zip?token=x&mode=full&target_uid=event-a",
    "http://192.168.1.25:8080/mobile_export.zip?token=x&mode=single-event-sync&target_uid=event-a&extra=x",
  ]) assert.throws(() => parseSingleEventSyncDownloadUrl(rejected));
  const redactedUrl = redactSyncUrl(base);
  const redactedText = redactSyncText(`failed ${base}`);
  for (const sensitive of ["secret", "event-a", "Test", "2026-10-31"]) {
    assert.equal(redactedUrl.includes(sensitive), false);
    assert.equal(redactedText.includes(sensitive), false);
  }

  const local: ImportData = {
    event: { name: "Event", url: "https://example.test", date: "2026-10-31", maps: [{ map_number: 1, filename: "map.png" }] },
    metadata: {
      generated_at: "mobile export time", format_version: "1.0", total_circles: 2,
      export_type: "result", source: "mobile", purchase_results: { bought: 1 }, user_note: "same",
    },
    circles: [
      {
        name: "Circle A", space: "A-01", checked: 0, pin_x: 0.1, pin_y: 0.2, map_number: 1,
        items: [{ name: "Book", price: 500, checked: 0, image: "book-cover.jpg" }],
        item_images: [{ path: "book.jpg", source: "catalog" }],
      },
      { name: "Circle Gone", space: "C-09", items: [{ name: "Old book" }] },
    ],
  };
  const incoming: ImportData = {
    event: { name: "Event Updated", url: "https://example.test", date: "2026-10-31", maps: [{ map_number: 1, filename: "map.png" }], map_calibration_points: [{ x: 0.1, y: 0.2 }] },
    metadata: {
      generated_at: "desktop export time", format_version: "2.0", total_circles: 3,
      export_type: "sync", source: "desktop", purchase_results: { bought: 20 }, user_note: "same",
    },
    circles: [
      {
        name: "Circle A", space: "A-01", checked: 1, pin_x: 0.3, pin_y: 0.2, map_number: 1,
        items: [{ name: "Book", price: 600, checked: 1, image: "book-cover.jpg" }, { name: "New book", checked: 0 }],
        item_images: [{ path: "book.jpg", source: "catalog" }],
      },
      { name: "Circle B", space: "B-01", items: [{ name: "B book" }] },
    ],
  };
  const diff = buildSingleEventSyncDiff(local, incoming, {
    local: { "item-image:a-01\u001fcircle a\u001f:0": "old" },
    incoming: { "item-image:a-01\u001fcircle a\u001f:0": "new" },
  });
  assert.deepEqual(diff.metadata, ["イベント名"]);
  assert.equal(diff.circles.added.length, 1);
  assert.equal(diff.circles.removed.length, 1);
  assert.equal(diff.items.added.length, 2);
  assert.equal(diff.items.changed.length, 1);
  assert.equal(diff.items.removed.length, 1);
  assert.equal(diff.purchase.length, 3);
  assert.equal(diff.mapPins.length, 2);
  assert.equal(diff.images.changed.length, 1);
  assert.equal(singleEventSyncImageRefs(incoming).some((image) => image.key.startsWith("item-image-ref:")), true);
  const metadataEdited = structuredClone(incoming);
  metadataEdited.metadata.user_note = "desktop edited";
  const metadataDiff = buildSingleEventSyncDiff(local, metadataEdited);
  assert.equal(metadataDiff.metadata.includes("イベント補足メタデータ"), true);
}
