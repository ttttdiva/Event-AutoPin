export type ReprocessBridgeTerminalOutcome =
  | "success"
  | "error"
  | "timeout"
  | "cancel"
  | "rejected";

export type ReprocessSource = "post" | "image";

export type ReprocessBridgeResultLike = {
  ok?: boolean;
  timedOut?: boolean;
  cancelled?: boolean;
  error?: unknown;
  bridge?: unknown;
  stderr?: unknown;
  stdout?: unknown;
} | null | undefined;

export type ReprocessTelemetryStage =
  | "frontend.enqueue"
  | "frontend.start"
  | "frontend.bridge_response"
  | "frontend.patch"
  | "frontend.cleanup"
  | "frontend.job_cleanup";

export type ReprocessTelemetryOutcome =
  | "begin"
  | "end"
  | "error"
  | "timeout"
  | "cancel";

/** URL post再処理専用のPython work budget（407全verification passを許容する）。 */
export const POST_REPROCESS_WORK_BUDGET_MS = 10 * 60 * 1000;
/** Pythonがtyped timeoutを返すためのRust側cleanup余白。 */
export const POST_REPROCESS_BRIDGE_GRACE_MS = 20 * 1000;
export const POST_REPROCESS_TIMEOUT_MS =
  POST_REPROCESS_WORK_BUDGET_MS + POST_REPROCESS_BRIDGE_GRACE_MS;
export const POST_REPROCESS_DEADLINE_MS = POST_REPROCESS_WORK_BUDGET_MS;

function defaultUuidFactory(): string {
  const cryptoApi = globalThis.crypto as Crypto & {
    randomUUID?: () => string;
  };
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return Array.from(bytes, (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

/** frontendでのみ使う、保存対象データに混ぜないopaque run idを生成する。 */
export function createReprocessRunId(
  uuidFactory: () => string = defaultUuidFactory,
): string {
  const uuid = uuidFactory();
  if (!uuid || typeof uuid !== "string") {
    throw new Error("再処理run_id生成に失敗しました");
  }
  return `reprocess-post-${uuid}`;
}

/** performance.now()等のmonotonic clock差分をログ用の非負整数msへ整形する。 */
export function monotonicElapsedMs(startMs: number, endMs: number): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  return Math.max(0, Math.round(endMs - startMs));
}

/** postだけ固定deadlineを使い、imageと既存ジョブの設定値は変更しない。 */
export function timeoutMsForReprocessSource(
  source: ReprocessSource,
  configuredTimeoutMs: number,
): number {
  return source === "post" ? POST_REPROCESS_TIMEOUT_MS : configuredTimeoutMs;
}

export function classifyBridgeTerminalOutcome(
  response: ReprocessBridgeResultLike,
  invokeRejected = false,
): ReprocessBridgeTerminalOutcome {
  if (invokeRejected) return "rejected";
  if (response?.cancelled === true) return "cancel";
  const bridge = recordValue(response?.bridge);
  const bridgeStatus = nonEmptyText(bridge?.status)?.toLowerCase();
  const bridgeCode = nonEmptyText(bridge?.code)?.toLowerCase();
  const bridgeErrorCode = nonEmptyText(bridge?.error_code)?.toLowerCase();
  if (
    response?.timedOut === true ||
    bridgeCode === "timeout" ||
    bridgeCode === "timed_out" ||
    bridgeErrorCode === "deadline_exceeded" ||
    bridgeStatus === "timeout"
  ) {
    return "timeout";
  }
  if (response?.ok === true && bridgeStatus === "ok") return "success";
  return "error";
}

export function telemetryOutcomeForBridgeTerminal(
  outcome: ReprocessBridgeTerminalOutcome,
): Exclude<ReprocessTelemetryOutcome, "begin"> {
  switch (outcome) {
    case "success":
      return "end";
    case "timeout":
      return "timeout";
    case "cancel":
      return "cancel";
    case "error":
    case "rejected":
      return "error";
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function nonEmptyText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const text = value.trim();
    return text || undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

/** Bridgeの構造化error/stderrから表示用の詳細を取り出す。文字列解析で分類しない。 */
export function extractReprocessErrorMessage(
  response: ReprocessBridgeResultLike,
  fallback = "ブリッジからエラー詳細が返されませんでした",
): string {
  if (!response) return fallback;
  const bridge = recordValue(response.bridge);
  return (
    nonEmptyText(response.error) ??
    nonEmptyText(bridge?.error) ??
    nonEmptyText(response.stderr) ??
    nonEmptyText(response.stdout) ??
    fallback
  );
}

/** 別ジョブのログを混ぜず、ユーザーが待っている段階だけを表示する。 */
export function reprocessProgressLabel(line: string, runId: string): string | null {
  const match = line.match(/\[EAP_REPROCESS\] run_id=(\S+) stage=(\S+) outcome=(\S+)/);
  if (!match || match[1] !== runId || match[3] !== "begin") return null;
  const labels: Record<string, string> = {
    "python.job": "実行環境を準備中",
    "twitter.initialize": "Xへの接続を準備中",
    "twitter.tweet_details": "指定ポストを取得中",
    "media.download": "画像を取得中",
    "image.analysis": "画像から商品を読み取り中",
    "catalog.initial": "画像から商品を読み取り中",
    "catalog.verify": "商品名・価格を読み取り中",
    "catalog.joint": "投稿本文と全画像から商品・価格を確認中",
    "text.detail": "投稿本文を確認中",
    "text.items": "投稿本文から商品を読み取り中",
    "python.return": "結果を反映中",
  };
  return labels[match[2]] ?? null;
}

/** postだけにrun_idを付け、image payloadはそのまま返す。 */
export function attachReprocessRunId(
  source: ReprocessSource,
  payload: Record<string, unknown>,
  runId?: string,
): Record<string, unknown> {
  if (source !== "post" || !runId) return payload;
  return { ...payload, run_id: runId };
}

/** postだけにopaque run_idとPython分析deadlineを付け、image payloadはそのまま返す。 */
export function attachReprocessRuntimePayload(
  source: ReprocessSource,
  payload: Record<string, unknown>,
  runId?: string,
): Record<string, unknown> {
  if (source !== "post") return payload;
  return {
    ...attachReprocessRunId(source, payload, runId),
    reprocess_deadline_ms: POST_REPROCESS_DEADLINE_MS,
  };
}

export function formatReprocessTelemetry(
  runId: string,
  stage: ReprocessTelemetryStage,
  outcome: ReprocessTelemetryOutcome,
  startMs: number,
  nowMs: number,
): string {
  return `[EAP_REPROCESS] run_id=${runId} stage=${stage} outcome=${outcome} elapsed_ms=${monotonicElapsedMs(startMs, nowMs)}`;
}
