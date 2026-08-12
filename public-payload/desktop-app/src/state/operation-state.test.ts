import {
  canAutoSave,
  canEnqueueReprocess,
  canStartPipeline,
  createOperationState,
  isOperationBusy,
  transitionOperationState,
} from "./operation-state";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertState(
  actual: ReturnType<typeof createOperationState>,
  kind: ReturnType<typeof createOperationState>["kind"],
  queuedReprocess: number,
): void {
  assert(actual.kind === kind, `kindが${kind}ではありません: ${actual.kind}`);
  assert(
    actual.queuedReprocess === queuedReprocess,
    `キュー件数が${queuedReprocess}ではありません: ${actual.queuedReprocess}`,
  );
}

let state = createOperationState();
assert(canStartPipeline(state), "idleではパイプラインを開始できる必要があります");
assert(canAutoSave(state), "idleでは自動保存できる必要があります");
assert(!isOperationBusy(state), "idleはbusyではありません");

state = transitionOperationState(state, { type: "request-pipeline" });
assertState(state, "pipeline-starting", 0);
assert(!canStartPipeline(state), "パイプライン開始中の再入を許可してはいけません");
assert(!canAutoSave(state), "パイプライン開始中の自動保存を許可してはいけません");
assert(!canEnqueueReprocess(state), "パイプライン中の再処理追加を許可してはいけません");
state = transitionOperationState(state, { type: "pipeline-started" });
assertState(state, "pipeline-running", 0);
state = transitionOperationState(state, { type: "finish-pipeline" });
assertState(state, "idle", 0);

state = transitionOperationState(state, { type: "enqueue-reprocess" });
assertState(state, "idle", 1);
assert(!canStartPipeline(state), "再処理待ち中のパイプライン開始を許可してはいけません");
assert(!canAutoSave(state), "再処理待ち中の自動保存を許可してはいけません");
state = transitionOperationState(state, { type: "start-reprocess" });
assertState(state, "reprocess-starting", 1);
state = transitionOperationState(state, { type: "dequeue-reprocess" });
assertState(state, "reprocess-running", 0);
assert(!canAutoSave(state), "再処理中の自動保存を許可してはいけません");
state = transitionOperationState(state, { type: "enqueue-reprocess" });
assertState(state, "reprocess-running", 1);
state = transitionOperationState(state, { type: "dequeue-reprocess" });
assertState(state, "reprocess-running", 0);
state = transitionOperationState(state, { type: "finish-reprocess" });
assertState(state, "idle", 0);
assert(canAutoSave(state), "再処理完了後は自動保存できる必要があります");

state = transitionOperationState(state, { type: "enqueue-reprocess" });
state = transitionOperationState(state, { type: "start-reprocess" });
state = transitionOperationState(state, { type: "abort-reprocess" });
assertState(state, "idle", 0);

console.log("operation-state tests passed");
