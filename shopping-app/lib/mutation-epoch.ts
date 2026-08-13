/**
 * Per-key mutation sequencing for optimistic UI updates.
 *
 * A token identifies the latest intent for one entity while enqueue() keeps
 * database writes for that entity serialized. This prevents rapid taps from
 * reading the same old value and lets callers ignore stale completions.
 */
export interface MutationToken {
  readonly generation: number;
  readonly sequence: number;
}

export interface MutationEpochGuard<Key> {
  next(key: Key): MutationToken;
  isCurrent(key: Key, token: MutationToken): boolean;
  enqueue<T>(key: Key, task: () => Promise<T>): Promise<T>;
  reset(): void;
}

export function createMutationEpochGuard<Key>(): MutationEpochGuard<Key> {
  const sequences = new Map<Key, number>();
  const queue = new Map<Key, Promise<unknown>>();
  let generation = 0;

  return {
    next(key) {
      const sequence = (sequences.get(key) ?? 0) + 1;
      sequences.set(key, sequence);
      return { generation, sequence };
    },
    isCurrent(key, token) {
      return (
        token.generation === generation && sequences.get(key) === token.sequence
      );
    },
    enqueue<T>(key: Key, task: () => Promise<T>): Promise<T> {
      const previous = queue.get(key) ?? Promise.resolve();
      // A failed task must not poison the queue for the next user intent.
      const run: Promise<T> = previous.catch(() => undefined).then(task);
      queue.set(key, run);
      const cleanup = () => {
        if (queue.get(key) === run) queue.delete(key);
      };
      void run.then(cleanup, cleanup);
      return run;
    },
    reset() {
      generation += 1;
      sequences.clear();
      // Keep in-flight per-key chains alive across route resets. Clearing the
      // map would let an A→B→A navigation start a second write before the
      // first A write settles. Generation invalidates old UI commits while the
      // retained promise chain still serializes database writes.
    },
  };
}
