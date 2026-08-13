export type SaveRequest<T> = {
  revision: number;
  snapshot: T;
};

export type SaveReceipt = {
  revision: number;
  completed: Promise<void>;
};

export type SaveExecutor<T> = (request: SaveRequest<T>) => Promise<void>;

/** UI側のperformance counterへclone計測を通知するための任意observer。*
 * state pure tests/consumerはobserver未設定のまま従来どおり動作する。 */
export type CloneObserver = (snapshot: unknown) => void;
let cloneObserver: CloneObserver | null = null;

export function setCloneObserver(observer: CloneObserver | null): void {
  cloneObserver = observer;
}

/**
 * イベント単位で独立した保存キューへ渡す要求。
 *
 * `RevisionedSaveQueue` は既存の circle-master など単一所有者の保存に
 * 互換のため残し、event.json の保存には下記 keyed queue を使用する。
 */
export type KeyedSaveRequest<T> = SaveRequest<T> & { key: string };

export type KeyedSaveExecutor<T> = (
  request: KeyedSaveRequest<T>,
) => Promise<void>;

export type KeyedSaveStatus = {
  key: string;
  running: boolean;
  pending: boolean;
  /** RevisionedSaveQueue互換の別名。 */
  isRunning: boolean;
  hasPending: boolean;
  latestRevision: number;
  savedRevision: number;
  /** 最後の保存失敗（retryKeyで再試行できる間は保持）。 */
  error: unknown;
  lastError: unknown;
  /** 保存が必要なsnapshotが残っているか。 */
  dirty: boolean;
};

type Waiter = {
  revision: number;
  resolve: () => void;
  reject: (error: unknown) => void;
};

/**
 * 最新スナップショットを順番に保存するキュー。
 * 保存中の更新は捨てず、pendingを最新revisionで置き換えて必ず後続保存する。
 */
export class RevisionedSaveQueue<T> {
  private nextRevision = 0;
  private pending: SaveRequest<T> | null = null;
  private running = false;
  private waiters: Waiter[] = [];
  private lastSavedRevision = 0;
  private lastError: unknown = null;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly execute: SaveExecutor<T>,
    private readonly disposeSnapshot?: (snapshot: T) => void,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  get hasPending(): boolean {
    return this.pending !== null;
  }

  get latestRevision(): number {
    return this.nextRevision;
  }

  get savedRevision(): number {
    return this.lastSavedRevision;
  }

  get error(): unknown {
    return this.lastError;
  }

  enqueue(snapshot: T): SaveReceipt {
    const revision = ++this.nextRevision;
    let resolveReceipt!: () => void;
    let rejectReceipt!: (error: unknown) => void;
    const completed = new Promise<void>((resolve, reject) => {
      resolveReceipt = resolve;
      rejectReceipt = reject;
    });

    this.waiters.push({
      revision,
      resolve: resolveReceipt,
      reject: rejectReceipt,
    });
    // pendingは最新だけを保持する。置き換えられたrevisionのreceiptは、
    // より新しいスナップショットが保存された時点で完了させる。
    if (this.pending) this.disposeSnapshot?.(this.pending.snapshot);
    this.pending = { revision, snapshot };
    if (!this.running) void this.drain();
    return { revision, completed };
  }

  /** 現在実行中およびpendingの保存がすべて完了するまで待つ。 */
  flush(): Promise<void> {
    if (!this.running && !this.pending) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private settleThrough(
    revision: number,
    failed: boolean,
    error?: unknown,
  ): void {
    const remaining: Waiter[] = [];
    for (const waiter of this.waiters) {
      if (waiter.revision > revision) {
        remaining.push(waiter);
      } else if (!failed) {
        waiter.resolve();
      } else {
        waiter.reject(error);
      }
    }
    this.waiters = remaining;
  }

  private async drain(): Promise<void> {
    this.running = true;
    while (this.pending) {
      const request = this.pending;
      this.pending = null;
      try {
        await this.execute(request);
        this.lastSavedRevision = request.revision;
        this.lastError = null;
        this.settleThrough(request.revision, false);
      } catch (error) {
        this.lastError = error;
        this.settleThrough(request.revision, true, error);
      } finally {
        this.disposeSnapshot?.(request.snapshot);
      }
    }
    this.running = false;
    const idleWaiters = this.idleWaiters.splice(0);
    idleWaiters.forEach((resolve) => resolve());
  }
}

type KeyedWaiter = {
  revision: number;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type KeyedEntry<T> = {
  nextRevision: number;
  pending: KeyedSaveRequest<T> | null;
  running: boolean;
  waiters: KeyedWaiter[];
  idleWaiters: Array<() => void>;
  savedRevision: number;
  lastError: unknown;
  /** 失敗時だけ保持し、retryKeyで再利用するsnapshot。 */
  failed: KeyedSaveRequest<T> | null;
};

/**
 * イベントslug（またはその他の所有者）ごとに独立したRevisionedSaveQueue。
 *
 * - 同じkeyでは最新revisionをpendingへcoalesceする。
 * - 異なるkeyは互いのpendingを置換せず、独立してdrainする。
 * - `flushKey` は指定keyだけを待ち、イベント切替の待ち合わせで
 *   別イベントの保存を止めない。
 * - 保存失敗は対象keyのstatusへ残り、他keyの保存を妨げない。
 */
export class KeyedRevisionedSaveQueue<T> {
  private readonly entries = new Map<string, KeyedEntry<T>>();

  constructor(
    private readonly execute: KeyedSaveExecutor<T>,
    private readonly disposeSnapshot?: (snapshot: T) => void,
    /**
     * 失敗snapshotの再試行時に、所有権token/leaseなどを再取得して
     * 新しいsnapshotを生成する。nullならretryを拒否する。
     */
    private readonly recreateRetrySnapshot?: (key: string, snapshot: T) => T | null,
  ) {}

  private entry(key: string): KeyedEntry<T> {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        nextRevision: 0,
        pending: null,
        running: false,
        waiters: [],
        idleWaiters: [],
        savedRevision: 0,
        lastError: null,
        failed: null,
      };
      this.entries.set(key, entry);
    }
    return entry;
  }

  /** 指定イベントへsnapshotを投入する。 */
  enqueue(key: string, snapshot: T): SaveReceipt {
    const entry = this.entry(key);
    const revision = ++entry.nextRevision;
    let resolveReceipt!: () => void;
    let rejectReceipt!: (error: unknown) => void;
    const completed = new Promise<void>((resolve, reject) => {
      resolveReceipt = resolve;
      rejectReceipt = reject;
    });
    entry.waiters.push({ revision, resolve: resolveReceipt, reject: rejectReceipt });

    // 同一keyのpendingだけを置き換える。異なるkeyのentryへは触れない。
    if (entry.pending) this.disposeSnapshot?.(entry.pending.snapshot);
    entry.pending = { key, revision, snapshot };
    // 新しいsnapshotが来たら、以前の失敗は再びdirty状態として扱う。
    entry.failed = null;
    entry.lastError = null;
    if (!entry.running) void this.drain(key, entry);
    return { revision, completed };
  }

  /** 指定keyの実行中/pending保存がすべてsettleするまで待つ。 */
  flushKey(key: string): Promise<void> {
    const entry = this.entry(key);
    if (!entry.running && !entry.pending) return Promise.resolve();
    return new Promise<void>((resolve) => entry.idleWaiters.push(resolve));
  }

  /** 全keyの保存がidleになるまで待つ。 */
  async flushAll(): Promise<void> {
    // entriesはdrain中に増えない（enqueueのみが増やす）が、flushAll開始後に
    // enqueueされたkeyも次のsnapshotとして待てるよう、安定するまで再確認する。
    while (true) {
      const keys = Array.from(this.entries.keys());
      await Promise.all(keys.map((key) => this.flushKey(key)));
      if (keys.length === this.entries.size && keys.every((key) => {
        const entry = this.entry(key);
        return !entry.running && !entry.pending;
      })) return;
    }
  }

  /** 保存状態をUIへ公開する。返却値は内部entryを共有しないsnapshot。 */
  getStatus(key: string): KeyedSaveStatus {
    const entry = this.entry(key);
    return {
      key,
      running: entry.running,
      pending: entry.pending !== null,
      isRunning: entry.running,
      hasPending: entry.pending !== null,
      latestRevision: entry.nextRevision,
      savedRevision: entry.savedRevision,
      error: entry.lastError,
      lastError: entry.lastError,
      dirty: Boolean(entry.pending || entry.running || entry.failed),
    };
  }

  isRunning(key: string): boolean {
    return this.entry(key).running;
  }

  hasPending(key: string): boolean {
    return this.entry(key).pending !== null;
  }

  /** 最後に失敗したsnapshotを同一keyで再試行する。 */
  retryKey(key: string): SaveReceipt | null {
    const entry = this.entry(key);
    if (entry.running || entry.pending || !entry.failed) return null;
    const failed = entry.failed;
    const retrySnapshot = this.recreateRetrySnapshot
      ? this.recreateRetrySnapshot(key, failed.snapshot)
      : failed.snapshot;
    if (retrySnapshot === null) return null;
    // enqueueは新revisionを割り当て、失敗receiptを再利用しない。これにより
    // 呼び出し側はretryの成否を独立してawaitできる。
    return this.enqueue(key, retrySnapshot);
  }

  private settleThrough(
    entry: KeyedEntry<T>,
    revision: number,
    failed: boolean,
    error?: unknown,
  ): void {
    const remaining: KeyedWaiter[] = [];
    for (const waiter of entry.waiters) {
      if (waiter.revision > revision) {
        remaining.push(waiter);
      } else if (failed) {
        waiter.reject(error);
      } else {
        waiter.resolve();
      }
    }
    entry.waiters = remaining;
  }

  private async drain(key: string, entry: KeyedEntry<T>): Promise<void> {
    entry.running = true;
    while (entry.pending) {
      const request = entry.pending;
      entry.pending = null;
      try {
        await this.execute(request);
        entry.savedRevision = request.revision;
        entry.lastError = null;
        entry.failed = null;
        this.settleThrough(entry, request.revision, false);
        this.disposeSnapshot?.(request.snapshot);
      } catch (error) {
        entry.lastError = error;
        entry.failed = request;
        this.settleThrough(entry, request.revision, true, error);
        // lifecycle lease等実行時リソースは失敗しても解放する。失敗snapshotの
        // データ自体はfailedへ保持し、retryKeyでは同じJSONを再送できる。
        this.disposeSnapshot?.(request.snapshot);
        // 失敗snapshotはretryKeyのため保持する。次のenqueueで上書きされる。
      }
    }
    entry.running = false;
    const idleWaiters = entry.idleWaiters.splice(0);
    idleWaiters.forEach((resolve) => resolve());
    // 保存が失敗してidleになったentryはdirty状態のまま残る。成功したretryや
    // 次回enqueueでfailedがクリアされる。
    void key;
  }
}

/** JSONとして保存するデータを、保存開始時点の値へ固定する。 */
export function cloneJsonSnapshot<T>(value: T): T {
  const cloned = typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as T;
  try {
    cloneObserver?.(cloned);
  } catch {
    // 計測observerの失敗はsnapshot cloneの責務へ影響させない。
  }
  return cloned;
}
