export const ABSENT_PRIORITY_COLOR = 5;

export type CircleAbsenceState = {
  absence_status?: unknown;
  priority_color?: number | string | null;
};

export function isCircleAbsent(circle: CircleAbsenceState | null | undefined): boolean {
  return Boolean(circle?.absence_status);
}

export function effectiveCirclePriority(
  circle: CircleAbsenceState | null | undefined,
): number | string {
  return isCircleAbsent(circle)
    ? ABSENT_PRIORITY_COLOR
    : circle?.priority_color ?? ABSENT_PRIORITY_COLOR;
}

export function setCircleAbsent(
  circle: CircleAbsenceState,
  absent: boolean,
  row?: Record<string, string>,
): void {
  const wasAbsent = isCircleAbsent(circle);
  circle.absence_status = absent ? "absent" : null;
  // 解除時も低を維持し、欠席前の優先度には戻さない。
  if (absent || wasAbsent) {
    circle.priority_color = ABSENT_PRIORITY_COLOR;
    if (row) row["色"] = `${ABSENT_PRIORITY_COLOR}.0`;
  }
}

export function enforceAbsentCirclePriorities(circles: unknown): void {
  if (!Array.isArray(circles)) return;
  for (const circle of circles) {
    if (circle && typeof circle === "object" && isCircleAbsent(circle)) {
      circle.priority_color = ABSENT_PRIORITY_COLOR;
    }
  }
}
