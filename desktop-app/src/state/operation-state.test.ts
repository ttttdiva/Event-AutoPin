import {
  canAutoSave,
  canEnqueueReprocess,
  canStartMapAuto,
  canStartEventDocumentMutation,
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

assert(canStartEventDocumentMutation(state), "idleではイベント管理操作を開始できる必要があります");
state = transitionOperationState(state, { type: "start-event-document" });
assertState(state, "event-document-running", 0);
assert(!canAutoSave(state), "イベント管理操作中はautosaveを許可してはいけません");
assert(!canStartPipeline(state), "イベント管理操作中はpipelineを開始できません");
assert(!canEnqueueReprocess(state), "イベント管理操作中はreprocessを追加できません");
assert(!canStartEventDocumentMutation(state), "イベント管理操作の再入を許可してはいけません");
state = transitionOperationState(state, { type: "finish-event-document" });
assertState(state, "idle", 0);

state = transitionOperationState(state, { type: "request-map-auto" });
assertState(state, "map-auto-starting", 0);
assert(!canAutoSave(state), "map自動配置開始中のautosaveを許可してはいけません");
assert(!canStartPipeline(state), "map自動配置中のpipeline開始を許可してはいけません");
assert(!canEnqueueReprocess(state), "map自動配置中のreprocess追加を許可してはいけません");
state = transitionOperationState(state, { type: "map-auto-started" });
assertState(state, "map-auto-running", 0);
assert(!canStartMapAuto(state), "map自動配置の再入を許可してはいけません");
state = transitionOperationState(state, { type: "map-auto-reload-failed" });
assertState(state, "map-auto-recovery", 0);
assert(!canAutoSave(state), "reload recovery中のautosaveを許可してはいけません");
assert(!canStartPipeline(state), "reload recovery中のpipeline開始を許可してはいけません");
assert(!canEnqueueReprocess(state), "reload recovery中のreprocess追加を許可してはいけません");
state = transitionOperationState(state, { type: "retry-map-auto-reload" });
assertState(state, "map-auto-running", 0);
state = transitionOperationState(state, { type: "finish-map-auto" });
assertState(state, "idle", 0);
assert(canAutoSave(state), "map自動配置完了後にautosaveが再開できません");

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
assert(!canStartMapAuto(state), "再処理待ち中のmap自動配置開始を許可してはいけません");
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
