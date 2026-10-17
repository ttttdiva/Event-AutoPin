import type { Circle } from "./types";
import {
  formatHighPriorityProgressLabel,
  fullHighPriorityProgressLabel,
  highPriorityProgressRatio,
  selectHighPriorityProgress,
  summarizeHighPriorityProgress,
  type HighPriorityProgress,
} from "./high-priority-progress";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function circle(fields: {
  priorityColor: unknown;
  purchaseStatus: unknown;
  eventId?: number;
}): Pick<Circle, "priorityColor" | "purchaseStatus" | "eventId"> {
  return {
    priorityColor: fields.priorityColor,
    purchaseStatus: fields.purchaseStatus,
    eventId: fields.eventId ?? 1,
  } as Pick<Circle, "priorityColor" | "purchaseStatus" | "eventId">;
}

function assertNoBadLabel(label: string, context: string) {
  assert(!label.includes("NaN"), `${context}: NaNを出さないこと`);
  assert(!label.includes("訪問"), `${context}: 「訪問」を入れないこと`);
}

export function runHighPriorityProgressTests() {
  const mixed = [
    circle({ priorityColor: 15, purchaseStatus: 1 }),
    circle({ priorityColor: 15, purchaseStatus: 0 }),
    circle({ priorityColor: 10, purchaseStatus: 2 }),
    circle({ priorityColor: 10, purchaseStatus: 3 }),
    circle({ priorityColor: 10, purchaseStatus: 0 }),
    circle({ priorityColor: 5, purchaseStatus: 1 }),
    circle({ priorityColor: 5, purchaseStatus: 0 }),
    circle({ priorityColor: 11, purchaseStatus: 2 }),
    circle({ priorityColor: 11, purchaseStatus: 3 }),
    circle({ priorityColor: "10", purchaseStatus: 1 }),
  ];
  const mixedProgress = summarizeHighPriorityProgress(mixed);
  assert(mixedProgress.total === 5, "mixed: 高・最優先だけを母数にすること");
  assert(mixedProgress.done === 3, "mixed: 1/2/3 を対応済みにすること");
  assert(mixedProgress.remaining === 2, "mixed: 0は残りにすること");
  assert(
    mixedProgress.total === mixedProgress.done + mixedProgress.remaining,
    "mixed: total === done + remaining",
  );
  assert(highPriorityProgressRatio(mixedProgress) === 0.6, "mixed: ratio は 0.6");
  const withoutSkipped = mixed.filter((entry) => entry.purchaseStatus !== 3);
  const skippedSubset = summarizeHighPriorityProgress(withoutSkipped);
  assert(
    skippedSubset.total !== mixedProgress.total,
    "見送りを除いた部分集合では total が変わること",
  );
  assert(
    summarizeHighPriorityProgress(mixed).total === 5,
    "関数は全件入力の total 5 のままであること",
  );

  const zero = summarizeHighPriorityProgress([]);
  assert(zero.done === 0 && zero.total === 0 && zero.remaining === 0, "空配列は 0/0/0");
  const zeroRatio = highPriorityProgressRatio(zero);
  assert(Number.isFinite(zeroRatio), "total 0 の ratio は有限");
  assert(zeroRatio === 0, "total 0 のバー比率は 0");
  assert(highPriorityProgressRatio({ done: 0, total: 0 }) !== 1, "total 0 を 1 にしない");
  assert(
    fullHighPriorityProgressLabel(zero) === "高・最優先 対象なし",
    "zero: full句は対象なし",
  );
  assert(
    formatHighPriorityProgressLabel(zero, 60) === "0/0",
    "zero: 幅60は 0/0",
  );

  const otherEvent = [
    circle({ priorityColor: 15, purchaseStatus: 1, eventId: 2 }),
    circle({ priorityColor: 10, purchaseStatus: 0, eventId: 2 }),
  ];
  const emptyEvent = selectHighPriorityProgress(otherEvent, 1);
  assert(
    emptyEvent.done === 0 && emptyEvent.total === 0 && emptyEvent.remaining === 0,
    "別eventIdだけなら 0",
  );
  const mixedEvents = [
    circle({ priorityColor: 15, purchaseStatus: 1, eventId: 1 }),
    circle({ priorityColor: 10, purchaseStatus: 0, eventId: 1 }),
    circle({ priorityColor: 15, purchaseStatus: 3, eventId: 9 }),
    circle({ priorityColor: 10, purchaseStatus: 1, eventId: 9 }),
  ];
  const currentOnly = selectHighPriorityProgress(mixedEvents, 1);
  assert(
    currentOnly.total === 2 && currentOnly.done === 1 && currentOnly.remaining === 1,
    "混在なら現eventIdだけを数えること",
  );

  const reactiveCircle = circle({ priorityColor: 10, purchaseStatus: 0, eventId: 1 });
  const before = summarizeHighPriorityProgress([reactiveCircle]);
  assert(before.done === 0 && before.remaining === 1 && before.total === 1, "reactive: 未購入");
  const afterStatus = summarizeHighPriorityProgress([
    { ...reactiveCircle, purchaseStatus: 1 },
  ]);
  assert(afterStatus.done === 1 && afterStatus.remaining === 0, "status 0→1 で done が増える");
  const afterPriority = summarizeHighPriorityProgress([
    { ...reactiveCircle, purchaseStatus: 1, priorityColor: 5 },
  ]);
  assert(afterPriority.total === 0 && afterPriority.done === 0, "priority 10→5 で total から外れる");

  const unknown = summarizeHighPriorityProgress([
    circle({ priorityColor: 10, purchaseStatus: 9 }),
  ]);
  assert(unknown.total === 1, "不明statusは total に入れる");
  assert(unknown.done === 0, "不明statusは done にしない");
  assert(unknown.remaining === 1, "不明statusは remaining に入れる");
  assert(
    unknown.total === unknown.done + unknown.remaining,
    "不明status: total === done + remaining",
  );
  assert(highPriorityProgressRatio(unknown) === 0, "不明statusの ratio は 0");

  const labeled: HighPriorityProgress = { done: 3, total: 5, remaining: 2 };
  const fullLabeled = "高・最優先 対応済み 3/5・残り 2";
  assert(formatHighPriorityProgressLabel(labeled, 220) === fullLabeled, "幅220は full");
  assert(formatHighPriorityProgressLabel(labeled, 220).includes("残り"), "幅220は「残り」を含む");
  assert(formatHighPriorityProgressLabel(labeled, 200) === fullLabeled, "幅200は full");
  assert(formatHighPriorityProgressLabel(labeled, 200).includes("残り"), "幅200は「残り」を含む");
  assert(formatHighPriorityProgressLabel(labeled, 250) === fullLabeled, "幅250は full");
  assert(formatHighPriorityProgressLabel(labeled, 250).includes("残り"), "幅250は「残り」を含む");
  assert(
    formatHighPriorityProgressLabel(labeled, 150) === "高・最優先 3/5 残2",
    "幅150は short",
  );
  assert(
    formatHighPriorityProgressLabel(labeled, 168) === "高・最優先 3/5 残2",
    "幅168は short",
  );
  assert(formatHighPriorityProgressLabel(labeled, 60) === "3/5", "幅60は tiny");
  assert(
    formatHighPriorityProgressLabel(zero, 220) === "高・最優先 対象なし",
    "total 0 の full",
  );
  assert(formatHighPriorityProgressLabel(zero, 150) === "対象なし", "total 0 の short");
  assert(formatHighPriorityProgressLabel(zero, 60) === "0/0", "total 0 の tiny");
  for (const width of [220, 150, 60, undefined]) {
    assertNoBadLabel(formatHighPriorityProgressLabel(labeled, width), `labeled width=${width}`);
    assertNoBadLabel(formatHighPriorityProgressLabel(zero, width), `zero width=${width}`);
  }
  assertNoBadLabel(fullHighPriorityProgressLabel(labeled), "full labeled");
  assertNoBadLabel(fullHighPriorityProgressLabel(zero), "full zero");

  console.log("高・最優先サークル進捗の集計・文言・比率を検証しました");
}
