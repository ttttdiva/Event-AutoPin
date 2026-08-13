import {
  PerformanceMetricsCore,
  isRawJsonSql,
  redactSql,
} from "./performance-core";
import {
  beginSqlMetricsScope as beginProductionSqlScope,
  estimateSqlResultBytes as estimateProductionBytes,
  getPerformanceSnapshot as getProductionSnapshot,
  installDevPerformanceBridge as installProductionBridge,
  recordSqlMetric as recordProductionSql,
  recordUiMetric as recordProductionUi,
  startUiMetric as startProductionUiMetric,
} from "./performance";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected=${String(expected)} actual=${String(actual)}`);
  }
}

export function runPerformanceCoreTests(): void {
  let now = 0;
  const metrics = new PerformanceMetricsCore({ clock: () => now, maxSamples: 200 });

  const wholeScope = metrics.beginSqlScope();
  for (let index = 0; index < 205; index += 1) {
    now += 1;
    metrics.recordSql(
      index === 204 ? "SELECT raw_json FROM events WHERE id = 123" : "SELECT id FROM events",
      0.5,
      2,
      10,
    );
  }
  now += 5;
  const whole = wholeScope();
  assertEqual(whole.count, 205, "205+ query scope count must use cumulative counters");
  assertEqual(whole.queries.length, 200, "query samples must remain bounded");
  assertEqual(whole.droppedQueries, 5, "evicted query count must be explicit");
  assertEqual(whole.sqlElapsedMs, 102.5, "SQL elapsed time must be accumulated");
  assertEqual(whole.elapsedMs, whole.sqlElapsedMs, "legacy elapsedMs alias must remain SQL time");
  assertEqual(whole.wallElapsedMs, 210, "wall time must be separate from SQL time");
  assertEqual(whole.rows, 410, "rows must be accumulated");
  assertEqual(whole.bytes, 2050, "bytes must be accumulated");
  assertEqual(whole.rawJsonQueries, 1, "raw_json queries must be counted");
  assert(whole.queries[199].sql.includes("id = ?"), "numeric SQL literals must be redacted");

  // The old array-index implementation returned an empty scope once the ring was full.
  const afterFull = metrics.beginSqlScope();
  for (let index = 0; index < 5; index += 1) {
    now += 2;
    metrics.recordSql("SELECT id FROM circles", 1, 1, 4);
  }
  const afterFullSnapshot = afterFull();
  assertEqual(afterFullSnapshot.count, 5, "scope after full ring must count new queries");
  assertEqual(afterFullSnapshot.queries.length, 5, "new query samples must remain discoverable");
  assertEqual(afterFullSnapshot.droppedQueries, 0, "new five-query scope must not report drops");

  const acrossReset = metrics.beginSqlScope();
  metrics.recordSql("SELECT id FROM before_reset", 3, 7, 11);
  metrics.recordSql("SELECT id FROM before_reset_2", 4, 8, 12);
  metrics.reset();
  metrics.recordSql("SELECT metadata_json FROM after_reset", 5, 9, 13);
  const overlap = acrossReset();
  assertEqual(overlap.count, 3, "reset must not corrupt an already-open scope");
  assertEqual(overlap.sqlElapsedMs, 12, "reset-overlap SQL total must remain exact");
  assertEqual(overlap.rows, 24, "reset-overlap row total must remain exact");
  assertEqual(overlap.bytes, 36, "reset-overlap byte total must remain exact");
  assertEqual(overlap.rawJsonQueries, 1, "reset-overlap raw query total must remain exact");
  assertEqual(overlap.queries.length, 1, "reset may intentionally clear retained samples");
  assertEqual(overlap.droppedQueries, 2, "cleared overlap samples must be reported as dropped");
  assertEqual(metrics.getSqlSnapshot().count, 1, "post-reset snapshot must start at reset boundary");

  assert(isRawJsonSql("SELECT * FROM circles"), "SELECT * must be treated as raw projection");
  assert(isRawJsonSql("SELECT metadata_json FROM events"), "metadata_json must be treated as raw");
  assert(
    !redactSql("SELECT * FROM events WHERE name = 'private event' AND id = 42").includes("private event"),
    "SQL samples must not retain user-derived string literals",
  );

  // Node has no __DEV__, so the public wrapper must exercise its production path.
  recordProductionSql("SELECT raw_json FROM private_event", 10, 2, 100);
  recordProductionUi("event-list-fmp", 10);
  const productionScope = beginProductionSqlScope("event-list");
  const productionSnapshot = productionScope();
  assertEqual(productionSnapshot.count, 0, "production SQL scope must be a no-op");
  assertEqual(productionSnapshot.wallElapsedMs, 0, "production scope must not touch the clock");
  assertEqual(estimateProductionBytes([{ private: true }]), 0, "production byte estimation must be skipped");
  assertEqual(startProductionUiMetric(), null, "production UI timer must not touch the clock");
  installProductionBridge();
  assert(
    globalThis.__EVENT_AUTOPIN_PERF__ === undefined,
    "production must not expose the debugger global",
  );
  assertEqual(getProductionSnapshot().ui.count, 0, "production UI metrics must remain empty");
}

function runAfterPaintRaceTests(): void {
  const runtimeRequire = eval("require") as NodeRequire;
  const performancePath = runtimeRequire.resolve("./performance");
  const targetGlobal = globalThis as typeof globalThis & { __DEV__?: boolean };
  const previousDev = targetGlobal.__DEV__;
  const previousRaf = globalThis.requestAnimationFrame;
  const previousCancelRaf = globalThis.cancelAnimationFrame;
  const previousConsoleInfo = console.info;
  const callbacks: Array<(timestamp: number) => void> = [];
  try {
    targetGlobal.__DEV__ = true;
    globalThis.requestAnimationFrame = ((callback: (timestamp: number) => void) => {
      callbacks.push(callback);
      return callbacks.length;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => undefined) as typeof cancelAnimationFrame;
    console.info = () => undefined;
    delete runtimeRequire.cache[performancePath];
    const devPerformance = runtimeRequire("./performance") as typeof import("./performance");

    devPerformance.recordUiMetricAfterPaint(
      "stale-event-fmp",
      devPerformance.startUiMetric(),
      () => false,
    );
    callbacks.shift()?.(0);
    assertEqual(
      devPerformance.getUiMetrics().length,
      0,
      "callback-time request guard must reject stale metrics",
    );

    const cancel = devPerformance.recordUiMetricAfterPaint(
      "cancelled-event-fmp",
      devPerformance.startUiMetric(),
      () => true,
    );
    const cancelledCallback = callbacks.shift();
    cancel();
    cancelledCallback?.(0);
    assertEqual(
      devPerformance.getUiMetrics().length,
      0,
      "cleanup cancellation must reject an already-queued animation frame",
    );

    devPerformance.recordUiMetricAfterPaint(
      "current-event-fmp",
      devPerformance.startUiMetric(),
      () => true,
    );
    callbacks.shift()?.(0);
    assertEqual(
      devPerformance.getUiMetrics()[0]?.name,
      "current-event-fmp",
      "current guarded metric must be recorded",
    );
  } finally {
    console.info = previousConsoleInfo;
    globalThis.requestAnimationFrame = previousRaf;
    globalThis.cancelAnimationFrame = previousCancelRaf;
    if (previousDev === undefined) delete targetGlobal.__DEV__;
    else targetGlobal.__DEV__ = previousDev;
    delete globalThis.__EVENT_AUTOPIN_PERF__;
    delete runtimeRequire.cache[performancePath];
  }
}

runPerformanceCoreTests();
runAfterPaintRaceTests();
