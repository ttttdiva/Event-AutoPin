import { KeyedSerialExecutor } from "./async-mutation-guard";

export type CoordinatedWriteResult = {
  written: boolean;
  committed: boolean;
};

export type EventLifecycleLease = {
  readonly key: string;
  release(): void;
};

type LifecycleEntry = {
  state: "open" | "closing" | "closed";
  active: number;
  waiters: Array<() => void>;
};

export class EventLifecycleGate {
  private readonly entries = new Map<string, LifecycleEntry>();

  private entry(key: string): LifecycleEntry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { state: "open", active: 0, waiters: [] };
      this.entries.set(key, entry);
    }
    return entry;
  }

  isOpen(key: string): boolean {
    return this.entry(key).state === "open";
  }

  open(key: string): void {
    const entry = this.entry(key);
    entry.state = "open";
  }

  acquire(key: string): EventLifecycleLease | null {
    const entry = this.entry(key);
    if (entry.state !== "open") return null;
    entry.active += 1;
    let released = false;
    return {
      key,
      release: () => {
        if (released) return;
        released = true;
        entry.active -= 1;
        if (entry.active === 0 && entry.state !== "open") {
          entry.state = "closed";
          entry.waiters.splice(0).forEach((resolve) => resolve());
        }
      },
    };
  }

  closeAndDrain(key: string): Promise<void> {
    const entry = this.entry(key);
    if (entry.state === "closed") return Promise.resolve();
    entry.state = "closing";
    if (entry.active === 0) {
      entry.state = "closed";
      return Promise.resolve();
    }
    return new Promise((resolve) => entry.waiters.push(resolve));
  }

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const lease = this.acquire(key);
    if (!lease) throw new Error("イベントは削除処理中または削除済みです");
    try {
      return await task();
    } finally {
      lease.release();
    }
  }
}

type CoordinatedWriteOptions<T> = {
  key: string;
  snapshot: T;
  isCurrent: () => boolean;
  write: (snapshot: T) => Promise<void>;
  commit: (snapshot: T) => void;
};

function cloneSnapshot<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * 同一イベントへの書き込みを直列化し、後発snapshotが存在する場合は旧要求を
 * fail-closedにする。write/commitへ渡す値は呼び出し時点のcloneで固定される。
 */
export class EventWriteCoordinator {
  private readonly serial = new KeyedSerialExecutor();
  private readonly generations = new Map<string, number>();
  private readonly committedSnapshots = new Map<string, unknown>();

  constructor(private readonly lifecycle = new EventLifecycleGate()) {}

  invalidate(key: string): void {
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
  }

  revision(key: string): number {
    return this.generations.get(key) ?? 0;
  }

  isRevision(key: string, revision: number): boolean {
    return this.revision(key) === revision;
  }

  runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    return this.lifecycle.run(key, () => this.serial.run(key, task));
  }

  runExclusiveAccepted<T>(key: string, task: () => Promise<T>): Promise<T> {
    return this.serial.run(key, task);
  }

  committedSnapshot<T>(key: string): T | null {
    const snapshot = this.committedSnapshots.get(key);
    return snapshot === undefined ? null : cloneSnapshot(snapshot as T);
  }

  recordCommitted<T>(key: string, snapshot: T): void {
    this.committedSnapshots.set(key, cloneSnapshot(snapshot));
  }

  run<T>(options: CoordinatedWriteOptions<T>): Promise<CoordinatedWriteResult> {
    const snapshot = cloneSnapshot(options.snapshot);
    const lease = this.lifecycle.acquire(options.key);
    if (!lease) {
      return Promise.reject(
        new Error("イベントは削除処理中または削除済みです"),
      );
    }
    const generation = (this.generations.get(options.key) ?? 0) + 1;
    this.generations.set(options.key, generation);

    return this.serial
      .run(options.key, async () => {
        const isLatest = () =>
          this.generations.get(options.key) === generation && options.isCurrent();
        if (!isLatest()) return { written: false, committed: false };

        await options.write(cloneSnapshot(snapshot));
        if (!isLatest()) return { written: true, committed: false };

        options.commit(cloneSnapshot(snapshot));
        this.recordCommitted(options.key, snapshot);
        return { written: true, committed: true };
      })
      .finally(() => lease.release());
  }
}
