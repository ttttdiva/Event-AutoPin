export type OperationKind =
  | "idle"
  | "pipeline-starting"
  | "pipeline-running"
  | "map-auto-starting"
  | "map-auto-running"
  | "map-auto-recovery"
  | "event-document-running"
  | "reprocess-starting"
  | "reprocess-running";

export type OperationState = {
  kind: OperationKind;
  /** 実行中の1件を除いた、再処理待ちキューの件数。 */
  queuedReprocess: number;
};

export type OperationEvent =
  | { type: "request-pipeline" }
  | { type: "pipeline-started" }
  | { type: "finish-pipeline" }
  | { type: "request-map-auto" }
  | { type: "map-auto-started" }
  | { type: "map-auto-reload-failed" }
  | { type: "retry-map-auto-reload" }
  | { type: "finish-map-auto" }
  | { type: "start-event-document" }
  | { type: "finish-event-document" }
  | { type: "enqueue-reprocess" }
  | { type: "start-reprocess" }
  | { type: "dequeue-reprocess" }
  | { type: "finish-reprocess" }
  | { type: "abort-reprocess" };

export function createOperationState(): OperationState {
  return { kind: "idle", queuedReprocess: 0 };
}

export function canStartPipeline(state: OperationState): boolean {
  return state.kind === "idle" && state.queuedReprocess === 0;
}

export function canStartMapAuto(state: OperationState): boolean {
  return state.kind === "idle" && state.queuedReprocess === 0;
}

export function canStartEventDocumentMutation(state: OperationState): boolean {
  return state.kind === "idle" && state.queuedReprocess === 0;
}

export function canEnqueueReprocess(state: OperationState): boolean {
  return (
    state.kind !== "pipeline-starting" &&
    state.kind !== "pipeline-running" &&
    state.kind !== "map-auto-starting" &&
    state.kind !== "map-auto-running" &&
    state.kind !== "map-auto-recovery" &&
    state.kind !== "event-document-running"
  );
}

export function canStartReprocess(state: OperationState): boolean {
  return state.kind === "idle" && state.queuedReprocess > 0;
}

export function canAutoSave(state: OperationState): boolean {
  return state.kind === "idle" && state.queuedReprocess === 0;
}

export function isPipelineOperation(state: OperationState): boolean {
  return state.kind === "pipeline-starting" || state.kind === "pipeline-running";
}

export function isMapAutoOperation(state: OperationState): boolean {
  return (
    state.kind === "map-auto-starting" ||
    state.kind === "map-auto-running" ||
    state.kind === "map-auto-recovery"
  );
}

export function isReprocessOperation(state: OperationState): boolean {
  return (
    state.kind === "reprocess-starting" || state.kind === "reprocess-running"
  );
}

export function isOperationBusy(state: OperationState): boolean {
  return state.kind !== "idle" || state.queuedReprocess > 0;
}

function invalidTransition(
  state: OperationState,
  event: OperationEvent,
): never {
  throw new Error(
    `不正な操作状態遷移: ${state.kind}/${state.queuedReprocess} + ${event.type}`,
  );
}

/**
 * パイプラインと1サークル再処理の排他関係を表す純粋な状態遷移。
 * DOM、Tauri、タイマーには依存しないため単体テストで検証できる。
 */
export function transitionOperationState(
  state: OperationState,
  event: OperationEvent,
): OperationState {
  switch (event.type) {
    case "request-pipeline":
      if (!canStartPipeline(state)) invalidTransition(state, event);
      return { kind: "pipeline-starting", queuedReprocess: 0 };

    case "pipeline-started":
      if (state.kind !== "pipeline-starting") invalidTransition(state, event);
      return { kind: "pipeline-running", queuedReprocess: 0 };

    case "finish-pipeline":
      if (!isPipelineOperation(state) || state.queuedReprocess !== 0) {
        invalidTransition(state, event);
      }
      return createOperationState();

    case "request-map-auto":
      if (!canStartMapAuto(state)) invalidTransition(state, event);
      return { kind: "map-auto-starting", queuedReprocess: 0 };

    case "map-auto-started":
      if (state.kind !== "map-auto-starting") invalidTransition(state, event);
      return { kind: "map-auto-running", queuedReprocess: 0 };

    case "map-auto-reload-failed":
      if (state.kind !== "map-auto-running") invalidTransition(state, event);
      return { kind: "map-auto-recovery", queuedReprocess: 0 };

    case "retry-map-auto-reload":
      if (state.kind !== "map-auto-recovery") invalidTransition(state, event);
      return { kind: "map-auto-running", queuedReprocess: 0 };

    case "finish-map-auto":
      if (!isMapAutoOperation(state) || state.queuedReprocess !== 0) {
        invalidTransition(state, event);
      }
      return createOperationState();

    case "start-event-document":
      if (!canStartEventDocumentMutation(state)) invalidTransition(state, event);
      return { kind: "event-document-running", queuedReprocess: 0 };

    case "finish-event-document":
      if (
        state.kind !== "event-document-running" ||
        state.queuedReprocess !== 0
      ) {
        invalidTransition(state, event);
      }
      return createOperationState();

    case "enqueue-reprocess":
      if (!canEnqueueReprocess(state)) invalidTransition(state, event);
      return {
        ...state,
        queuedReprocess: state.queuedReprocess + 1,
      };

    case "start-reprocess":
      if (!canStartReprocess(state)) invalidTransition(state, event);
      return {
        kind: "reprocess-starting",
        queuedReprocess: state.queuedReprocess,
      };

    case "dequeue-reprocess":
      if (
        (state.kind !== "reprocess-starting" &&
          state.kind !== "reprocess-running") ||
        state.queuedReprocess <= 0
      ) {
        invalidTransition(state, event);
      }
      return {
        kind: "reprocess-running",
        queuedReprocess: state.queuedReprocess - 1,
      };

    case "finish-reprocess":
      if (!isReprocessOperation(state) || state.queuedReprocess !== 0) {
        invalidTransition(state, event);
      }
      return createOperationState();

    case "abort-reprocess":
      if (!isReprocessOperation(state)) invalidTransition(state, event);
      return createOperationState();
  }
}
