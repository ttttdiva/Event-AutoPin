/** Development-only performance instrumentation. Production calls are no-ops. */
import {
  PerformanceMetricsCore,
  isRawJsonSql,
  type PerformanceSnapshot,
  type SqlMetric,
  type SqlMetricsSnapshot,
  type UiMetric,
} from "./performance-core";

export { isRawJsonSql };
export type { PerformanceSnapshot, SqlMetric, SqlMetricsSnapshot, UiMetric };

export interface EventAutoPinPerformanceBridge {
  snapshot: () => PerformanceSnapshot;
  reset: () => void;
  dump: () => PerformanceSnapshot;
}

declare global {
  // eslint-disable-next-line no-var
  var __EVENT_AUTOPIN_PERF__: EventAutoPinPerformanceBridge | undefined;
}

const MAX_SAMPLES = 200;
const PERF_LOG_TAG = "EAP_PERF_V1";
const isDevBuild =
  typeof globalThis !== "undefined" &&
  ((globalThis as { __DEV__?: boolean }).__DEV__ ?? false);

function monotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

const core = isDevBuild
  ? new PerformanceMetricsCore({ maxSamples: MAX_SAMPLES, clock: monotonicNow })
  : null;

const EMPTY_SQL_SNAPSHOT: Readonly<SqlMetricsSnapshot> = {
  count: 0,
  sequence: 0,
  totalCount: 0,
  sqlElapsedMs: 0,
  elapsedMs: 0,
  wallElapsedMs: 0,
  rows: 0,
  bytes: 0,
  rawJsonQueries: 0,
  droppedQueries: 0,
  queries: [],
};

const EMPTY_PERFORMANCE_SNAPSHOT: Readonly<PerformanceSnapshot> = {
  sql: EMPTY_SQL_SNAPSHOT,
  ui: { count: 0, sequence: 0, totalCount: 0, droppedMetrics: 0, metrics: [] },
};

function emptySqlSnapshot(): SqlMetricsSnapshot {
  return EMPTY_SQL_SNAPSHOT as SqlMetricsSnapshot;
}

function safeMetricName(name: string): string {
  return name.replace(/[^a-z0-9_.:-]/gi, "_").slice(0, 80);
}

function logMetric(payload: Record<string, unknown>): void {
  if (!isDevBuild) return;
  // One tagged JSON object per line is intentionally easy to filter with adb logcat.
  console.info(`${PERF_LOG_TAG} ${JSON.stringify(payload)}`);
}

export function recordSqlMetric(
  sql: string,
  elapsedMs: number,
  rows: number,
  bytes: number,
): void {
  if (!core) return;
  core.recordSql(sql, elapsedMs, rows, bytes);
}

export function getSqlMetrics(): SqlMetricsSnapshot {
  return core?.getSqlSnapshot() ?? emptySqlSnapshot();
}

export function resetSqlMetrics(): void {
  core?.resetSql();
}

/** Screen-level scope. The optional name must be a fixed, non-user-derived label. */
export function beginSqlMetricsScope(scopeName?: string): () => SqlMetricsSnapshot {
  if (!core) return emptySqlSnapshot;
  const finish = core.beginSqlScope();
  return () => {
    const snapshot = finish();
    if (scopeName) {
      logMetric({
        kind: "sql-scope",
        name: safeMetricName(scopeName),
        count: snapshot.count,
        sqlElapsedMs: snapshot.sqlElapsedMs,
        wallElapsedMs: snapshot.wallElapsedMs,
        rows: snapshot.rows,
        bytes: snapshot.bytes,
        rawJsonQueries: snapshot.rawJsonQueries,
        droppedQueries: snapshot.droppedQueries,
      });
    }
    return snapshot;
  };
}

export const startSqlMetricsScope = beginSqlMetricsScope;

export function estimateSqlResultBytes(rows: unknown): number {
  if (!core || rows == null) return 0;
  try {
    return JSON.stringify(rows).length * 2;
  } catch {
    return 0;
  }
}

export const __sqlMetricsDevOnly = isDevBuild;

/** FMP/map/render instrumentation. The name must be a fixed label. */
export function recordUiMetric(name: string, value = 0): void {
  if (!core) return;
  const safeName = safeMetricName(name);
  core.recordUi(safeName, value);
  logMetric({ kind: "ui", name: safeName, value });
}

/** Capture a monotonic start time without touching the clock in production. */
export function startUiMetric(): number | null {
  return core ? monotonicNow() : null;
}

/** Record after the next animation frame, i.e. after React committed visible state. */
export function recordUiMetricAfterPaint(
  name: string,
  startedAt: number | null,
  shouldRecord?: () => boolean,
): () => void {
  if (!core || startedAt == null) return () => undefined;
  let cancelled = false;
  const callback = () => {
    if (!cancelled && (shouldRecord?.() ?? true)) {
      recordUiMetric(name, Math.max(0, monotonicNow() - startedAt));
    }
  };
  const raf = globalThis.requestAnimationFrame;
  if (typeof raf === "function") {
    const frame = raf(callback);
    return () => {
      cancelled = true;
      globalThis.cancelAnimationFrame?.(frame);
    };
  }
  const timer = setTimeout(callback, 0);
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}

export function getUiMetrics(): UiMetric[] {
  return core?.getUiSnapshot().metrics ?? [];
}

export function resetUiMetrics(): void {
  core?.resetUi();
}

export function getPerformanceSnapshot(): PerformanceSnapshot {
  return core?.snapshot() ?? (EMPTY_PERFORMANCE_SNAPSHOT as PerformanceSnapshot);
}

export function resetPerformanceMetrics(): void {
  core?.reset();
}

/** Install a debugger-console bridge in development only. */
export function installDevPerformanceBridge(): void {
  if (!core || globalThis.__EVENT_AUTOPIN_PERF__) return;
  globalThis.__EVENT_AUTOPIN_PERF__ = {
    snapshot: getPerformanceSnapshot,
    reset: resetPerformanceMetrics,
    dump: () => {
      const snapshot = getPerformanceSnapshot();
      logMetric({
        kind: "snapshot",
        sql: {
          count: snapshot.sql.count,
          sqlElapsedMs: snapshot.sql.sqlElapsedMs,
          wallElapsedMs: snapshot.sql.wallElapsedMs,
          rows: snapshot.sql.rows,
          bytes: snapshot.sql.bytes,
          rawJsonQueries: snapshot.sql.rawJsonQueries,
          droppedQueries: snapshot.sql.droppedQueries,
        },
        ui: {
          count: snapshot.ui.count,
          droppedMetrics: snapshot.ui.droppedMetrics,
          metrics: snapshot.ui.metrics.map(({ name, value }) => ({ name, value })),
        },
      });
      return snapshot;
    },
  };
}
