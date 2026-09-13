import type { BridgeJobResult } from "./bridge-job";
import { mergeReprocessEdits } from "./reprocess-edits";
import { buildEventJsonSnapshot } from "./state/event-document";
import {
  attachReprocessRunId,
  attachReprocessRuntimePayload,
  classifyBridgeTerminalOutcome,
  createReprocessRunId,
  extractReprocessErrorMessage,
  formatReprocessTelemetry,
  monotonicElapsedMs,
  POST_REPROCESS_BRIDGE_GRACE_MS,
  POST_REPROCESS_DEADLINE_MS,
  POST_REPROCESS_TIMEOUT_MS,
  POST_REPROCESS_WORK_BUDGET_MS,
  telemetryOutcomeForBridgeTerminal,
  timeoutMsForReprocessSource,
  reprocessProgressLabel,
} from "./reprocess-runtime";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

let uuidCounter = 0;
assertEqual(reprocessProgressLabel(
  "[EAP_REPROCESS] run_id=run-1 stage=catalog.verify outcome=begin elapsed_ms=0", "run-1",
), "商品名・価格を読み取り中", "処理段階を表示する");
assertEqual(reprocessProgressLabel(
  "[EAP_REPROCESS] run_id=run-2 stage=catalog.verify outcome=begin elapsed_ms=0", "run-1",
), null, "別の再処理ログは混ぜない");
assertEqual(reprocessProgressLabel(
  "[EAP_REPROCESS] run_id=run-1 stage=catalog.verify outcome=end elapsed_ms=100", "run-1",
), null, "終了ログで段階を巻き戻さない");
const firstRunId = createReprocessRunId(() => `uuid-${++uuidCounter}`);
const secondRunId = createReprocessRunId(() => `uuid-${++uuidCounter}`);
assert(firstRunId !== secondRunId, "run_id must differ for every generated run");
assert(/^reprocess-post-[A-Za-z0-9-]+$/.test(firstRunId), "run_id must be opaque");
assert(firstRunId.startsWith("reprocess-post-"), "run_id prefix is missing");

assertEqual(monotonicElapsedMs(10, 25), 15, "elapsed milliseconds");
assertEqual(monotonicElapsedMs(25, 10), 0, "elapsed milliseconds must be non-negative");
assertEqual(monotonicElapsedMs(Number.NaN, 10), 0, "invalid elapsed start must be safe");

assert(
  POST_REPROCESS_TIMEOUT_MS > 0 && POST_REPROCESS_TIMEOUT_MS < 3_600_000,
  "post timeout must be finite and below the generic one-hour timeout",
);
assertEqual(POST_REPROCESS_WORK_BUDGET_MS, 600_000, "post work budget");
assertEqual(POST_REPROCESS_BRIDGE_GRACE_MS, 20_000, "post bridge grace");
assertEqual(POST_REPROCESS_TIMEOUT_MS, 620_000, "post bridge timeout");
assert(
  POST_REPROCESS_DEADLINE_MS > 0 &&
    POST_REPROCESS_DEADLINE_MS < POST_REPROCESS_TIMEOUT_MS,
  "post analysis deadline must leave cleanup margin",
);
assertEqual(
  POST_REPROCESS_WORK_BUDGET_MS,
  POST_REPROCESS_DEADLINE_MS,
  "post work budget is the Python deadline",
);
assertEqual(
  POST_REPROCESS_TIMEOUT_MS - POST_REPROCESS_DEADLINE_MS,
  POST_REPROCESS_BRIDGE_GRACE_MS,
  "post analysis deadline cleanup margin",
);
assertEqual(
  timeoutMsForReprocessSource("post", 1234),
  POST_REPROCESS_TIMEOUT_MS,
  "post source uses the production timeout",
);
assertEqual(
  timeoutMsForReprocessSource("image", 1234),
  1234,
  "image source preserves the configured timeout",
);

assertEqual(
  classifyBridgeTerminalOutcome({ ok: true, bridge: { status: "ok" } }),
  "success",
  "ok response classification",
);
assertEqual(
  classifyBridgeTerminalOutcome({ ok: true, bridge: { status: "error" } }),
  "error",
  "nested bridge error classification",
);
assertEqual(
  classifyBridgeTerminalOutcome({
    ok: false,
    bridge: { status: "error", error_code: "deadline_exceeded" },
  }),
  "timeout",
  "nested Python deadline classification",
);
assertEqual(
  classifyBridgeTerminalOutcome({
    ok: false,
    bridge: { status: "error", code: "timeout" },
  }),
  "timeout",
  "nested bridge timeout classification",
);
assertEqual(
  classifyBridgeTerminalOutcome({ ok: false }),
  "error",
  "error response classification",
);
assertEqual(
  classifyBridgeTerminalOutcome({ ok: false, timedOut: true }),
  "timeout",
  "timedOut response classification",
);
assertEqual(
  classifyBridgeTerminalOutcome({ ok: false, cancelled: true }),
  "cancel",
  "cancelled response classification",
);
assertEqual(
  classifyBridgeTerminalOutcome(undefined, true),
  "rejected",
  "invoke rejection classification",
);
assertEqual(
  classifyBridgeTerminalOutcome(null, true),
  "rejected",
  "null invoke rejection classification",
);
assertEqual(telemetryOutcomeForBridgeTerminal("success"), "end", "success telemetry outcome");
assertEqual(telemetryOutcomeForBridgeTerminal("rejected"), "error", "rejected telemetry outcome");

assertEqual(
  extractReprocessErrorMessage({
    ok: false,
    bridge: { error: "structured bridge failure" },
    stderr: "stderr fallback",
  }),
  "structured bridge failure",
  "structured bridge error extraction",
);
assertEqual(
  extractReprocessErrorMessage({ ok: false, stderr: "stderr failure" }),
  "stderr failure",
  "stderr error extraction",
);
assertEqual(
  extractReprocessErrorMessage(null),
  "ブリッジからエラー詳細が返されませんでした",
  "missing bridge error extraction",
);

const timedOutBridgeResult: BridgeJobResult = { ok: false, timedOut: true };
const cancelledBridgeResult: BridgeJobResult = { ok: false, cancelled: true };
assert(timedOutBridgeResult.timedOut === true, "BridgeJobResult timedOut contract");
assert(cancelledBridgeResult.cancelled === true, "BridgeJobResult cancelled contract");

const basePayload = { event_json: "event.json" };
const postPayload = attachReprocessRunId("post", basePayload, firstRunId);
assertEqual(postPayload.run_id, firstRunId, "post payload run_id");
assert(!Object.prototype.hasOwnProperty.call(basePayload, "run_id"), "payload must not mutate");
const imagePayload = attachReprocessRunId("image", basePayload, secondRunId);
assert(imagePayload === basePayload, "image payload must not be forced to include run_id");
assert(!Object.prototype.hasOwnProperty.call(imagePayload, "run_id"), "image payload run_id");
const postRuntimePayload = attachReprocessRuntimePayload(
  "post",
  basePayload,
  firstRunId,
);
assertEqual(postRuntimePayload.run_id, firstRunId, "post runtime payload run_id");
assertEqual(
  postRuntimePayload.reprocess_deadline_ms,
  POST_REPROCESS_DEADLINE_MS,
  "post runtime payload deadline",
);
const imageRuntimePayload = attachReprocessRuntimePayload(
  "image",
  basePayload,
  secondRunId,
);
assert(imageRuntimePayload === basePayload, "image runtime payload must be unchanged");
assert(
  !Object.prototype.hasOwnProperty.call(imageRuntimePayload, "run_id") &&
    !Object.prototype.hasOwnProperty.call(
      imageRuntimePayload,
      "reprocess_deadline_ms",
    ),
  "image runtime payload must omit post-only fields",
);

assertEqual(
  formatReprocessTelemetry(firstRunId, "frontend.patch", "begin", 100, 99),
  `[EAP_REPROCESS] run_id=${firstRunId} stage=frontend.patch outcome=begin elapsed_ms=0`,
  "telemetry format",
);

// 再処理していないサークルの入力・ジャンル・商品編集は結果反映で失わない。
const beforeReprocess = {
  event: { memo: "元のイベントメモ", venue: "元の会場" },
  circles: [
    { name: "対象", space: "A-01", priority_color: 5, genres: [], items: [{ name: "元の商品" }] },
    { name: "別サークル", space: "A-02", priority_color: 5, genres: ["漫画"], items: [{ name: "既存商品", price: 500 }] },
    { name: "未編集", space: "A-03", priority_color: 3, items: [] },
  ],
};
const untouchedTable = { headers: [], rows: [{}, {}, {}] };
const localDraft = buildEventJsonSnapshot(beforeReprocess, {
  headers: [], rows: [
    { "サークル名": "対象の変更名", "色": "1.0" },
    { "サークル名": "別サークルの変更名", "ペンネーム": "新しい名義", "ジャンル": "音楽", "アイテムメモ": "編集中のメモ", "色": "4.0" },
    {},
  ],
}, untouchedTable);
localDraft.circles![0].items = [{ name: "対象の手動入力" }];
localDraft.circles![1].items = [{ name: "価格を編集した商品", price: 800 }, { name: "手動追加", price: 300 }];
localDraft.event.memo = "待ち時間中のイベントメモ";
const savedBridgeData = {
  event: { memo: "元のイベントメモ", venue: "更新された会場" },
  circles: [
    beforeReprocess.circles[1],
    { ...beforeReprocess.circles[0], items: [{ name: "再処理の商品", price: 700 }], catalog_status: "confirmed" },
    { ...beforeReprocess.circles[2], priority_color: 2 },
  ],
};
const mergedEdits = mergeReprocessEdits(beforeReprocess, localDraft, savedBridgeData, 0, new Set(["items", "catalog_status"]));
assertEqual(mergedEdits.data.circles![0].name, "別サークルの変更名", "他のサークル名を保持する");
assertEqual(mergedEdits.data.circles![0].penname, "新しい名義", "他の入力欄を保持する");
assertEqual(mergedEdits.data.circles![0].genres[0], "音楽", "ジャンル選択を保持する");
assertEqual(mergedEdits.data.circles![0].memo, "編集中のメモ", "メモ入力を保持する");
assertEqual(mergedEdits.data.circles![0].priority_color, 4, "優先度も保持する");
assertEqual(mergedEdits.data.circles![0].items.length, 2, "他サークルの商品追加を保持する");
assertEqual(mergedEdits.data.circles![0].items[0].price, 800, "他サークルの価格編集を保持する");
assertEqual(mergedEdits.data.circles![1].items[0].name, "再処理の商品", "対象商品の上書きは許可する");
assertEqual(mergedEdits.data.circles![1].name, "対象の変更名", "再処理が変更しない入力欄は保持する");
assertEqual(mergedEdits.data.circles![2].priority_color, 2, "未編集の欄は最新ディスク値を保持する");
assertEqual(mergedEdits.data.event.memo, "待ち時間中のイベントメモ", "イベントメモを保持する");
assertEqual(mergedEdits.data.event.venue, "更新された会場", "未編集のイベント情報を保持する");
assertEqual(mergedEdits.circleIndices.join(","), "1,0,2", "次のキューを並び替え後の正しい行へ対応させる");
assertEqual(savedBridgeData.circles[0].name, "別サークル", "保存済みsnapshotを変更しない");
const finalSnapshot = buildEventJsonSnapshot(
  mergedEdits.data, { headers: [], rows: [] }, { headers: [], rows: [] },
);
assertEqual(finalSnapshot.circles?.[0].genres[0], "音楽", "終了時の保存にジャンル変更を含める");
assertEqual(finalSnapshot.circles?.[1].items?.[0].name, "再処理の商品", "終了時の保存で商品を巻き戻さない");

console.log("reprocess runtime tests passed");
