import {
  ABSENT_PRIORITY_COLOR,
  effectiveCirclePriority,
  enforceAbsentCirclePriorities,
  isCircleAbsent,
  setCircleAbsent,
} from "./circle-absence";
import { buildEventJsonSnapshot, type TableState } from "./event-document";

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`PASS ${name}`);
}

test("欠席未設定は出席扱い", () => {
  for (const circle of [undefined, null, {}, { absence_status: null }, { absence_status: "" }]) {
    equal(isCircleAbsent(circle), false);
  }
});

test("既存の欠席値も認識する", () => {
  for (const value of ["absent", "欠席", "announced_absent"]) {
    equal(isCircleAbsent({ absence_status: value }), true);
  }
});

test("欠席にするとJSONと表示行の両方が低になる", () => {
  const circle = { absence_status: null as string | null, priority_color: 15 };
  const row = { 色: "15.0", サークル名: "テスト" };
  setCircleAbsent(circle, true, row);
  equal(circle, { absence_status: "absent", priority_color: 5 });
  equal(row, { 色: "5.0", サークル名: "テスト" });
});

test("欠席解除後も低を維持する", () => {
  const circle = { absence_status: "absent" as string | null, priority_color: 5 };
  const row = { 色: "5.0" };
  setCircleAbsent(circle, false, row);
  equal(circle, { absence_status: null, priority_color: 5 });
  equal(isCircleAbsent(circle), false);
  equal(row.色, "5.0");
});

test("旧データの高優先度を欠席解除で復元しない", () => {
  const circle = { absence_status: "absent" as string | null, priority_color: 15 };
  const row = { 色: "15.0" };
  setCircleAbsent(circle, false, row);
  equal(circle.priority_color, 5);
  equal(row.色, "5.0");
});

test("繰り返しトグルしても欠席と低優先度が整合する", () => {
  const circle = { absence_status: null as string | null, priority_color: 10 };
  const row = { 色: "10.0" };
  for (let i = 0; i < 10; i += 1) {
    setCircleAbsent(circle, !isCircleAbsent(circle), row);
    equal(isCircleAbsent(circle), i % 2 === 0);
    equal(circle.priority_color, ABSENT_PRIORITY_COLOR);
    equal(row.色, "5.0");
  }
});

test("購入状態とアイテムを変更しない", () => {
  const circle = {
    absence_status: null as string | null,
    priority_color: 11,
    checked: 2,
    memo: "残すメモ",
    items: [{ name: "本", price: 1000, checked: 1 }],
  };
  const items = circle.items;
  setCircleAbsent(circle, true);
  setCircleAbsent(circle, false);
  equal(circle.checked, 2);
  equal(circle.memo, "残すメモ");
  equal(circle.items === items, true);
  equal(circle.items, [{ name: "本", price: 1000, checked: 1 }]);
});

test("出席中の明示解除は既存優先度を変えない", () => {
  const circle = { absence_status: null, priority_color: 15 };
  setCircleAbsent(circle, false);
  equal(circle.priority_color, 15);
});

test("再読込した欠席サークルも低として表示する", () => {
  const circle = JSON.parse('{"absence_status":"absent","priority_color":15}');
  equal(effectiveCirclePriority(circle), 5);
  equal(circle.priority_color, 15);
});

test("出席中の優先度と未設定の既定値を維持する", () => {
  equal(effectiveCirclePriority({ priority_color: 10 }), 10);
  equal(effectiveCirclePriority({ priority_color: "11" }), "11");
  equal(effectiveCirclePriority({}), 5);
  equal(effectiveCirclePriority(undefined), 5);
});

test("保存直前に欠席サークルだけ低へ正規化する", () => {
  const circles = [
    { absence_status: "absent", priority_color: 15, checked: 1 },
    { absence_status: "欠席", priority_color: 11, checked: 3 },
    { absence_status: null, priority_color: 10, checked: 0 },
    { priority_color: 15, checked: 2 },
  ];
  enforceAbsentCirclePriorities(circles);
  equal(circles.map((c) => c.priority_color), [5, 5, 10, 15]);
  equal(circles.map((c) => c.checked), [1, 3, 0, 2]);
});

test("未設定・空データの正規化は安全", () => {
  for (const value of [undefined, null, {}, [], [null, undefined, "", {}]]) {
    enforceAbsentCirclePriorities(value);
  }
});

test("保存と再読込を繰り返しても低を維持する", () => {
  const circle = { absence_status: null as string | null, priority_color: 15 };
  setCircleAbsent(circle, true);
  const loaded = JSON.parse(JSON.stringify(circle));
  loaded.priority_color = 10;
  enforceAbsentCirclePriorities([loaded]);
  const reloaded = JSON.parse(JSON.stringify(loaded));
  equal(isCircleAbsent(reloaded), true);
  equal(effectiveCirclePriority(reloaded), 5);
  equal(reloaded.priority_color, 5);
});

test("実際の保存境界で表の優先度変更を無効化し、非表示の旧データも低にする", () => {
  const data = { circles: [
    { name: "対象", absence_status: "absent", priority_color: 15, checked: 2,
      memo: "保持するメモ", items: [{ name: "本", price: 1000, checked: 1 }] },
    { name: "表にない旧データ", absence_status: "欠席", priority_color: 11 },
    { name: "出席", priority_color: 10 },
  ] };
  const before = JSON.stringify(data);
  const baseline: TableState = { headers: ["色"], rows: [{ 色: "5.0" }] };
  const edited: TableState = { headers: ["色"], rows: [{ 色: "15.0" }] };
  const saved = buildEventJsonSnapshot(data, edited, baseline);
  const reloaded = JSON.parse(JSON.stringify(saved));
  equal(reloaded.circles.map((circle: { priority_color: number }) => circle.priority_color), [5, 5, 10]);
  equal(reloaded.circles[0], { ...data.circles[0], priority_color: 5 });
  equal(JSON.stringify(data), before);
});

test("切替後の保存・再読込・解除でも低を維持し、解除後は優先度を変更できる", () => {
  const data = { circles: [{ absence_status: null as string | null, priority_color: 15,
    checked: 3, memo: "残す", items: [{ name: "既存商品", checked: 2 }] }] };
  const baseline: TableState = { headers: ["色"], rows: [{ 色: "15.0" }] };
  const table: TableState = { headers: ["色"], rows: [{ 色: "15.0" }] };
  setCircleAbsent(data.circles[0], true, table.rows[0]);
  const saved = buildEventJsonSnapshot(data, table, baseline);
  const reloaded = JSON.parse(JSON.stringify(saved));
  equal(reloaded.circles[0].absence_status, "absent");
  equal(reloaded.circles[0].priority_color, 5);
  setCircleAbsent(reloaded.circles[0], false, table.rows[0]);
  const cleared = buildEventJsonSnapshot(reloaded, table, table);
  equal(cleared.circles?.[0], { ...data.circles[0], absence_status: null });
  const edited: TableState = { headers: ["色"], rows: [{ 色: "10.0" }] };
  equal(buildEventJsonSnapshot(cleared, edited, table).circles?.[0].priority_color, 10);
});

console.log(`欠席状態のテスト ${passed} 件が成功しました`);
