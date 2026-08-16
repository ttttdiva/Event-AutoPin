export type AsyncMutationState = {
  owner: string;
  revision: number;
  document: object | null;
  targets: Array<object | null>;
};

export type AsyncMutationGuard = {
  isCurrent: () => boolean;
};

/** 非同期UI操作の開始時stateと現在stateをidentity込みで照合する。 */
export function createAsyncMutationGuard(
  captured: AsyncMutationState,
  readCurrent: () => AsyncMutationState,
): AsyncMutationGuard {
  return {
    isCurrent: () => {
      const current = readCurrent();
      return (
        current.owner === captured.owner &&
        current.revision === captured.revision &&
        current.document === captured.document &&
        current.targets.length === captured.targets.length &&
        current.targets.every((target, index) => target === captured.targets[index])
      );
    },
  };
}

/** 同じkeyへの非同期writeを要求順に完了させる。 */
export class KeyedSerialExecutor {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    const tail = current.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    void tail.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return current;
  }
}

/** 成功値が得られるまでlockを保持する呼び出し側向けのretry loop。 */
export async function retryUntilValue<T>(options: {
  attempt: () => Promise<T | null>;
  onFailure: (attempt: number) => void | Promise<void>;
  wait: () => Promise<void>;
  maxAttempts?: number;
}): Promise<T> {
  let count = 0;
  for (;;) {
    const value = await options.attempt();
    if (value !== null) return value;
    count += 1;
    if (options.maxAttempts !== undefined && count >= options.maxAttempts) {
      throw new Error(`retryUntilValue exceeded maxAttempts=${options.maxAttempts}`);
    }
    await options.onFailure(count);
    await options.wait();
  }
}
