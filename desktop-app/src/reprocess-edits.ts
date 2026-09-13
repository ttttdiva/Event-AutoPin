import { cloneJsonSnapshot } from "./state/revisioned-save-queue";
import type { EventJsonData } from "./state/event-document";

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function identity(circle: Record<string, unknown>): string {
  return JSON.stringify(["name", "penname", "space", "hall"].map(
    (key) => String(circle[key] ?? "").trim(),
  ));
}

function copyEdits(
  base: Record<string, any>, current: Record<string, any>, result: Record<string, any>,
  excluded: ReadonlySet<string> = new Set(),
): void {
  for (const key of new Set([...Object.keys(base), ...Object.keys(current)])) {
    if (excluded.has(key) || equal(base[key], current[key])) continue;
    if (Object.prototype.hasOwnProperty.call(current, key)) {
      result[key] = cloneJsonSnapshot(current[key]);
    } else {
      delete result[key];
    }
  }
}

/** 対象サークルの再処理結果と、待ち時間中に編集した他の欄を統合する。 */
export function mergeReprocessEdits(
  base: EventJsonData,
  current: EventJsonData,
  incoming: EventJsonData,
  targetIndex: number,
  replacedFields: ReadonlySet<string>,
): { data: EventJsonData; circleIndices: number[] } {
  const data = cloneJsonSnapshot(incoming);
  const baseCircles = base.circles ?? [];
  const currentCircles = current.circles ?? [];
  const incomingCircles = data.circles ?? [];
  if (baseCircles.length !== currentCircles.length) {
    throw new Error("再処理中にサークルの件数が変わったため、編集結果を自動統合できません");
  }
  const sameOrder = baseCircles.length === incomingCircles.length && baseCircles.every(
    (circle, index) => identity(circle) === identity(incomingCircles[index]),
  );
  // 名前などの編集中でも、処理開始時のidentityでディスク上の行を解決する。
  const circleIndices = baseCircles.map((circle, index) => {
    if (sameOrder) return index;
    const matches = incomingCircles.map((item, i) => ({ item, i }))
      .filter(({ item }) => identity(item) === identity(circle));
    if (matches.length !== 1) throw new Error("再処理中に対象サークルの対応関係が変わりました");
    return matches[0].i;
  });
  baseCircles.forEach((circle, index) => {
    copyEdits(circle, currentCircles[index], incomingCircles[circleIndices[index]],
      index === targetIndex ? replacedFields : undefined);
  });
  copyEdits(base, current, data, new Set(["circles", "event"]));
  if (!equal(base.event, current.event)) {
    data.event = { ...data.event };
    copyEdits(base.event ?? {}, current.event ?? {}, data.event);
  }
  return { data, circleIndices };
}
