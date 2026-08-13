export interface SqlMetric {
  sequence: number;
  sql: string;
  elapsedMs: number;
  rows: number;
  bytes: number;
  includesRawJson: boolean;
  at: number;
}

export interface SqlMetricsSnapshot {
  /** Queries recorded in this snapshot's interval. */
  count: number;
  /** Lifetime query sequence; unlike the ring-buffer index this never rewinds. */
  sequence: number;
  /** Lifetime query count. Kept separately so reset does not invalidate open scopes. */
  totalCount: number;
  /** SQL execution time only. */
  sqlElapsedMs: number;
  /** Backwards-compatible alias for sqlElapsedMs. */
  elapsedMs: number;
  /** Wall-clock duration of the snapshot's interval. */
  wallElapsedMs: number;
  rows: number;
  bytes: number;
  rawJsonQueries: number;
  /** Queries in the interval that no longer fit in the bounded sample ring. */
  droppedQueries: number;
  queries: SqlMetric[];
}

export interface UiMetric {
  sequence: number;
  name: string;
  value: number;
  at: number;
}

export interface UiMetricsSnapshot {
  count: number;
  sequence: number;
  totalCount: number;
  droppedMetrics: number;
  metrics: UiMetric[];
}

export interface PerformanceSnapshot {
  sql: SqlMetricsSnapshot;
  ui: UiMetricsSnapshot;
}

interface SqlTotals {
  count: number;
  elapsedMs: number;
  rows: number;
  bytes: number;
  rawJsonQueries: number;
}

interface SqlCheckpoint {
  sequence: number;
  at: number;
  totals: SqlTotals;
}

const ZERO_TOTALS: Readonly<SqlTotals> = {
  count: 0,
  elapsedMs: 0,
  rows: 0,
  bytes: 0,
  rawJsonQueries: 0,
};

export function isRawJsonSql(sql: string): boolean {
  return /\braw_json\b|\bmetadata_json\b|(?:\bselect\b|,)\s*(?:[a-z_][a-z0-9_]*\.)?\*/i.test(sql);
}

/** Remove string/number literals before a statement can leave the process. */
export function redactSql(sql: string): string {
  return sql
    .replace(/'(?:''|[^'])*'/g, "?")
    .replace(/"(?:""|[^"])*"/g, "?")
    .replace(/\b(?:0x[0-9a-f]+|\d+(?:\.\d+)?)\b/gi, "?")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function copyTotals(totals: SqlTotals): SqlTotals {
  return { ...totals };
}

function subtractTotals(end: SqlTotals, start: SqlTotals): SqlTotals {
  return {
    count: end.count - start.count,
    elapsedMs: end.elapsedMs - start.elapsedMs,
    rows: end.rows - start.rows,
    bytes: end.bytes - start.bytes,
    rawJsonQueries: end.rawJsonQueries - start.rawJsonQueries,
  };
}

export class PerformanceMetricsCore {
  private readonly maxSamples: number;
  private readonly clock: () => number;
  private readonly sqlMetrics: SqlMetric[] = [];
  private readonly uiMetrics: UiMetric[] = [];
  private sqlSequence = 0;
  private uiSequence = 0;
  private sqlTotals: SqlTotals = copyTotals(ZERO_TOTALS);
  private sqlReset: SqlCheckpoint;
  private uiResetSequence = 0;

  constructor(options: { maxSamples?: number; clock: () => number }) {
    this.maxSamples = Math.max(1, options.maxSamples ?? 200);
    this.clock = options.clock;
    this.sqlReset = this.checkpoint();
  }

  private checkpoint(): SqlCheckpoint {
    return {
      sequence: this.sqlSequence,
      at: this.clock(),
      totals: copyTotals(this.sqlTotals),
    };
  }

  recordSql(sql: string, elapsedMs: number, rows: number, bytes: number): void {
    const includesRawJson = isRawJsonSql(sql);
    this.sqlSequence += 1;
    this.sqlTotals.count += 1;
    this.sqlTotals.elapsedMs += Math.max(0, elapsedMs);
    this.sqlTotals.rows += Math.max(0, rows);
    this.sqlTotals.bytes += Math.max(0, bytes);
    this.sqlTotals.rawJsonQueries += includesRawJson ? 1 : 0;
    this.sqlMetrics.push({
      sequence: this.sqlSequence,
      sql: redactSql(sql),
      elapsedMs: Math.max(0, elapsedMs),
      rows: Math.max(0, rows),
      bytes: Math.max(0, bytes),
      includesRawJson,
      at: this.clock(),
    });
    if (this.sqlMetrics.length > this.maxSamples) {
      this.sqlMetrics.splice(0, this.sqlMetrics.length - this.maxSamples);
    }
  }

  beginSqlScope(): () => SqlMetricsSnapshot {
    const start = this.checkpoint();
    return () => this.sqlSnapshotSince(start);
  }

  getSqlSnapshot(): SqlMetricsSnapshot {
    return this.sqlSnapshotSince(this.sqlReset);
  }

  private sqlSnapshotSince(start: SqlCheckpoint): SqlMetricsSnapshot {
    const totals = subtractTotals(this.sqlTotals, start.totals);
    const queries = this.sqlMetrics.filter((metric) => metric.sequence > start.sequence);
    return {
      count: totals.count,
      sequence: this.sqlSequence,
      totalCount: this.sqlTotals.count,
      sqlElapsedMs: totals.elapsedMs,
      elapsedMs: totals.elapsedMs,
      wallElapsedMs: Math.max(0, this.clock() - start.at),
      rows: totals.rows,
      bytes: totals.bytes,
      rawJsonQueries: totals.rawJsonQueries,
      droppedQueries: Math.max(0, totals.count - queries.length),
      queries: queries.slice(),
    };
  }

  resetSql(): void {
    // Lifetime counters deliberately survive reset so already-open scopes remain exact.
    this.sqlMetrics.length = 0;
    this.sqlReset = this.checkpoint();
  }

  recordUi(name: string, value: number): UiMetric {
    this.uiSequence += 1;
    const metric = { sequence: this.uiSequence, name, value, at: this.clock() };
    this.uiMetrics.push(metric);
    if (this.uiMetrics.length > this.maxSamples) {
      this.uiMetrics.splice(0, this.uiMetrics.length - this.maxSamples);
    }
    return metric;
  }

  getUiSnapshot(): UiMetricsSnapshot {
    const count = this.uiSequence - this.uiResetSequence;
    const metrics = this.uiMetrics.filter((metric) => metric.sequence > this.uiResetSequence);
    return {
      count,
      sequence: this.uiSequence,
      totalCount: this.uiSequence,
      droppedMetrics: Math.max(0, count - metrics.length),
      metrics: metrics.slice(),
    };
  }

  resetUi(): void {
    this.uiMetrics.length = 0;
    this.uiResetSequence = this.uiSequence;
  }

  snapshot(): PerformanceSnapshot {
    return { sql: this.getSqlSnapshot(), ui: this.getUiSnapshot() };
  }

  reset(): void {
    this.resetSql();
    this.resetUi();
  }
}
