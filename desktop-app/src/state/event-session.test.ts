import {
  EventSelectionState,
  existingEventUid,
  prepareFullSyncEventDocument,
  reconcileSessionEventDocument,
  type EventSession,
} from "./event-session";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function session(slug: string): EventSession {
  return {
    slug,
    eventDir: `${slug}/`,
    eventJsonPath: `${slug}/event.json`,
    meta: {},
    eventJsonData: {},
    tableState: {},
    tableBaseline: {},
    purchasedItemIndex: new Set(),
    mapImages: [],
    sourceFingerprint: {},
  };
}

const state = new EventSelectionState();
const a = state.request("A");
const b = state.request("B");
assert(!state.isCurrent(a, "A"), "古いepochがcurrent扱いされています");
assert(state.isCurrent(b, "B"), "最新epochがcurrent判定されません");
assert(!state.commit(a, session("A")), "古いAのloadがcommitされました");
assert(state.commit(b, session("B")), "最新Bのsessionをcommitできません");
assert(state.committedEventSession?.slug === "B", "B sessionが確定されません");

const activeWithoutUid = {
  event: { name: "同期前", unknown_event_field: { keep: true } },
  circles: [{ name: "A", image: "images/a.png" }],
  metadata: { raw_json: { vendor: "untouched" } },
  unknown_root_field: ["must-survive"],
};
const prepared = prepareFullSyncEventDocument(
  activeWithoutUid,
  () => "00112233445566778899aabbccddeeff",
);
assert(prepared.changed, "UIDなしdocumentがpreflight変更扱いになりません");
assert(
  prepared.eventUid === "00112233445566778899aabbccddeeff",
  "生成UIDがrootへ固定されません",
);
activeWithoutUid.event.name = "同期中の後続編集";
assert(
  (prepared.data.event as { name: string }).name === "同期前",
  "preflight snapshotが同期中の編集で変化しました",
);
assert(
  JSON.stringify(prepared.data.metadata) === JSON.stringify({ raw_json: { vendor: "untouched" } }) &&
    JSON.stringify(prepared.data.unknown_root_field) === JSON.stringify(["must-survive"]),
  "preflightで未知field/raw_jsonが失われました",
);

const reconciled = reconcileSessionEventDocument(
  session("active"),
  prepared.data,
  { modifiedMs: 123, fileSize: 456 },
);
(prepared.data.event as { name: string }).name = "保存後編集";
assert(
  existingEventUid(reconciled.eventJsonData) === "00112233445566778899aabbccddeeff",
  "active committed sessionへUIDがreconcileされません",
);
assert(
  (reconciled.eventJsonData as typeof prepared.data).event.name === "同期前",
  "reconcile済みsessionが後続編集と参照共有しています",
);
const editedAfterSync = JSON.parse(JSON.stringify(reconciled.eventJsonData));
editedAfterSync.event.name = "同期後の編集";
const savedAfterEdit = prepareFullSyncEventDocument(editedAfterSync, () => {
  throw new Error("UID保持済みdocumentで再採番されました");
});
assert(!savedAfterEdit.changed, "同期後の通常saveでUIDが再採番されました");
assert(
  existingEventUid(savedAfterEdit.data) === "00112233445566778899aabbccddeeff",
  "同期後の編集/saveでUIDが失われました",
);

const legacy = prepareFullSyncEventDocument(
  { event: { id: "legacy-event-id" }, unknown: true },
  () => "should-not-be-used",
);
assert(legacy.eventUid === "legacy-event-id", "legacy event idがUIDとして継承されません");
assert(
  (legacy.data as Record<string, unknown>).event_uid === "legacy-event-id",
  "legacy UIDがrootへpreflightされません",
);
console.log("event-session tests passed");
