import { KeyedSerialExecutor } from "./async-mutation-guard";

export type CoordinatedWriteResult = {
  written: boolean;
  committed: boolean;
};

export type EventLifecycleLease = {
  readonly key: string;
  release(): void;
};

export type EventSourceFingerprint = {
  modifiedMs?: number;
  modifiedNs?: number;
  fileSize?: number;
  contentHash?: string;
};

export type CircleIdentity = {
  name?: string;
  penname?: string;
  space?: string;
  hall?: string;
};

export type CircleIdentityPatch = {
  circleIndex: number;
  circleIdentity?: CircleIdentity;
  baseCircle?: Record<string, unknown>;
  changes: Record<string, unknown>;
};

export type EventPatchResult = {
  baseFingerprint?: EventSourceFingerprint;
  circlePatches: CircleIdentityPatch[];
};

export type AppliedEventPatch<T> = {
  data: T;
  resolvedCircleIndices: number[];
  baseFingerprintMatched: boolean;
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

function normalizedIdentityValue(value: unknown): string {
  return String(value ?? "").trim();
}

function hasCircleIdentity(identity: CircleIdentity | undefined): boolean {
  return Boolean(
    identity &&
      [identity.name, identity.penname, identity.space, identity.hall].some(
        (value) => normalizedIdentityValue(value) !== "",
      ),
  );
}

function matchesCircleIdentity(
  circle: Record<string, unknown>,
  identity: CircleIdentity,
): boolean {
  return (["name", "penname", "space", "hall"] as const).every((key) => {
    const expected = normalizedIdentityValue(identity[key]);
    return !expected || normalizedIdentityValue(circle[key]) === expected;
  });
}

function resolveCircleIndex(
  circles: unknown[],
  preferredIndex: number,
  identity: CircleIdentity | undefined,
  preferredIndexAllowed: boolean,
): number {
  const preferred = circles[preferredIndex];
  if (
    preferredIndexAllowed &&
    preferred &&
    typeof preferred === "object" &&
    !Array.isArray(preferred)
  ) {
    return preferredIndex;
  }
  if (!hasCircleIdentity(identity)) {
    throw new Error(
      `event.json変更後は空のサークルidentityでpatchを適用できません: index=${preferredIndex}`,
    );
  }
  const matches = circles
    .map((circle, index) => ({ circle, index }))
    .filter(
      ({ circle }) =>
        circle !== null &&
        typeof circle === "object" &&
        !Array.isArray(circle) &&
        matchesCircleIdentity(circle as Record<string, unknown>, identity!),
    );
  if (matches.length === 1) return matches[0].index;
  if (matches.length > 1) {
    throw new Error("サークルidentityが複数件に一致したためpatchを適用できません");
  }
  throw new Error(`対象サークルが変更または削除されています: index=${preferredIndex}`);
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function sameEventSourceFingerprint(
  expected: EventSourceFingerprint | undefined,
  actual: EventSourceFingerprint | undefined,
): boolean {
  if (!expected || !actual) return false;
  if (expected.contentHash && actual.contentHash) {
    return expected.contentHash === actual.contentHash;
  }
  if (
    expected.modifiedNs !== undefined &&
    actual.modifiedNs !== undefined
  ) {
    if (expected.modifiedNs !== actual.modifiedNs) return false;
    return (
      expected.fileSize !== undefined &&
      actual.fileSize !== undefined &&
      expected.fileSize === actual.fileSize
    );
  }
  return (
    expected.modifiedMs !== undefined &&
    actual.modifiedMs !== undefined &&
    expected.fileSize !== undefined &&
    actual.fileSize !== undefined &&
    expected.modifiedMs === actual.modifiedMs &&
    expected.fileSize === actual.fileSize
  );
}

/**
 * Apply only identity-addressed circle fields to the latest event document.
 * A base fingerprint mismatch is reported but does not reject unrelated edits:
 * resolving every target against the latest circles is the field-level CAS.
 */
export function applyEventPatchToLatest<T extends { circles?: unknown[] }>(
  latest: T,
  patch: EventPatchResult,
  latestFingerprint?: EventSourceFingerprint,
): AppliedEventPatch<T> {
  const data = cloneSnapshot(latest);
  if (!Array.isArray(data.circles)) {
    throw new Error("event.json circlesが配列ではありません");
  }
  const resolvedCircleIndices: number[] = [];
  const baseFingerprintMatched = sameEventSourceFingerprint(
    patch.baseFingerprint,
    latestFingerprint,
  );
  for (const circlePatch of patch.circlePatches) {
    const resolved = resolveCircleIndex(
      data.circles,
      circlePatch.circleIndex,
      circlePatch.circleIdentity,
      baseFingerprintMatched,
    );
    const circle = data.circles[resolved];
    if (!circle || typeof circle !== "object" || Array.isArray(circle)) {
      throw new Error(`対象サークルがobjectではありません: index=${resolved}`);
    }
    const current = circle as Record<string, unknown>;
    if (!baseFingerprintMatched && circlePatch.baseCircle) {
      for (const [field, desired] of Object.entries(circlePatch.changes)) {
        const baseValue = circlePatch.baseCircle[field];
        if (
          !jsonValuesEqual(current[field], baseValue) &&
          !jsonValuesEqual(current[field], desired)
        ) {
          throw new Error(
            `対象サークルの「${field}」がjob実行中に変更されたためpatchを適用できません`,
          );
        }
      }
    }
    Object.assign(current, cloneSnapshot(circlePatch.changes));
    resolvedCircleIndices.push(resolved);
  }
  return {
    data,
    resolvedCircleIndices,
    baseFingerprintMatched,
  };
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

  forgetCommitted(key: string): void {
    this.committedSnapshots.delete(key);
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
