export type SaveRequest<T> = {
  revision: number;
  snapshot: T;
};

export type SaveReceipt = {
  revision: number;
  completed: Promise<void>;
};

export type SaveExecutor<T> = (request: SaveRequest<T>) => Promise<void>;

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

  constructor(private readonly execute: SaveExecutor<T>) {}

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
      }
    }
    this.running = false;
    const idleWaiters = this.idleWaiters.splice(0);
    idleWaiters.forEach((resolve) => resolve());
  }
}

/** JSONとして保存するデータを、保存開始時点の値へ固定する。 */
export function cloneJsonSnapshot<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}
