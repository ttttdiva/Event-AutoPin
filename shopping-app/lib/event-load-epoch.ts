/** 最新ルート要求だけを state へ commit するための小さな pure guard。 */
export interface LoadEpochGuard {
  next(): number;
  isCurrent(epoch: number): boolean;
}

export function createLoadEpochGuard(): LoadEpochGuard {
  let current = 0;
  return {
    next() {
      current += 1;
      return current;
    },
    isCurrent(epoch) {
      return epoch === current;
    },
  };
}
