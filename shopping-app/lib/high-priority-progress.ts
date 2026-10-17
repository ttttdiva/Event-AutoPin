import { PURCHASE_STATUS, type Circle } from "./types";

export type HighPriorityProgress = {
  done: number;
  total: number;
  remaining: number;
};

type HighPriorityCircle = Pick<Circle, "priorityColor" | "purchaseStatus">;
type HighPriorityEventCircle = Pick<
  Circle,
  "priorityColor" | "purchaseStatus" | "eventId"
>;

const HIGH_PRIORITY_COLORS = new Set<number>([10, 15]);

function isHighPriorityColor(value: unknown): boolean {
  return typeof value === "number" && HIGH_PRIORITY_COLORS.has(value);
}

function finiteCount(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export function summarizeHighPriorityProgress(
  circles: readonly HighPriorityCircle[],
): HighPriorityProgress {
  let total = 0;
  let done = 0;
  let remaining = 0;
  for (const circle of circles) {
    if (!isHighPriorityColor(circle.priorityColor)) continue;
    total += 1;
    const status = circle.purchaseStatus;
    if (
      status === PURCHASE_STATUS.BOUGHT ||
      status === PURCHASE_STATUS.COULDNT_BUY ||
      status === PURCHASE_STATUS.SKIPPED
    ) {
      done += 1;
    } else {
      remaining += 1;
    }
  }
  return { done, total, remaining };
}

export function highPriorityProgressRatio(
  progress: Pick<HighPriorityProgress, "done" | "total">,
): number {
  const total = progress.total;
  const done = progress.done;
  if (!(total > 0) || !Number.isFinite(total) || !Number.isFinite(done)) {
    return 0;
  }
  const ratio = done / total;
  if (!Number.isFinite(ratio)) return 0;
  if (ratio <= 0) return 0;
  if (ratio >= 1) return 1;
  return ratio;
}

export function selectHighPriorityProgress(
  circles: readonly HighPriorityEventCircle[],
  eventId: number,
): HighPriorityProgress {
  return summarizeHighPriorityProgress(
    circles.filter((circle) => circle.eventId === eventId),
  );
}

function labelCounts(progress: HighPriorityProgress): HighPriorityProgress {
  return {
    done: finiteCount(progress.done),
    total: finiteCount(progress.total),
    remaining: finiteCount(progress.remaining),
  };
}

export function fullHighPriorityProgressLabel(
  progress: HighPriorityProgress,
): string {
  const { done, total, remaining } = labelCounts(progress);
  if (total <= 0) return "高・最優先 対象なし";
  return `高・最優先 対応済み ${done}/${total}・残り ${remaining}`;
}

export function formatHighPriorityProgressLabel(
  progress: HighPriorityProgress,
  width?: number,
): string {
  const { done, total, remaining } = labelCounts(progress);
  const unmeasured = width == null || !Number.isFinite(width);
  if (unmeasured || width >= 200) {
    return fullHighPriorityProgressLabel(progress);
  }
  if (width >= 72) {
    if (total <= 0) return "対象なし";
    return `高・最優先 ${done}/${total} 残${remaining}`;
  }
  if (total <= 0) return "0/0";
  return `${done}/${total}`;
}
