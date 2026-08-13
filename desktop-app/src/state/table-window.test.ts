import { tableDataStartIndex, tableWindowForScroll } from "./table-window";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function main(): void {
  // circles-only tableでは先頭サークル名が空でも行0は実データ。内容から
  // event-information行と推測してskipすると、indices/row編集対象がずれる。
  const circlesOnly = [
    { "サークル名": "", "ホール": "A" },
    { "サークル名": "二つ目", "ホール": "B" },
  ];
  assert(tableDataStartIndex(false) === 0, "空名の先頭circleをevent行としてskipしました");
  assert(tableDataStartIndex(true) === 1, "明示legacy event行のstart indexが不正です");
  const circleIndices = circlesOnly.map((_, index) => index);
  const firstCircleWindow = tableWindowForScroll(
    circleIndices,
    tableDataStartIndex(false),
    0,
    600,
    { windowSize: 120 },
  );
  assert(firstCircleWindow.start === 0, "空名の先頭circleがvirtual windowから欠落しました");

  const all = Array.from({ length: 1000 }, (_, i) => i);
  const atBottom = tableWindowForScroll(all, 0, 1_000_000, 600);
  assert(atBottom.start <= 880, `末尾windowが候補数を越えました: ${atBottom.start}`);
  assert(atBottom.end === 1000, `末尾windowが末尾まで描画されません: ${atBottom.end}`);

  // filter後に1000→200へ縮んでも、旧scrollTopで空windowにならない。
  const filtered = all.slice(0, 200);
  const filteredBottom = tableWindowForScroll(filtered, 0, 40_000, 600);
  assert(filteredBottom.start <= 80, `filter後startがwindow上限を越えました: ${filteredBottom.start}`);
  assert(filteredBottom.end === 200, `filter後windowが空/途中で終わりました: ${filteredBottom.end}`);
  assert(filteredBottom.topHeight > 0 && filteredBottom.bottomHeight === 0, "filter後spacerが不正です");

  const expandedRows = new Map<number, number>([[80, 360]]);
  const expanded = tableWindowForScroll(filtered, 0, 40_000, 600, {
    rowHeights: expandedRows,
  });
  assert(expanded.end > expanded.start, "expanded row windowが空です");
  assert(expanded.topHeight >= 80 * 42, "expanded row前のtop spacerが不正です");

  // event ownerごとに実測height cacheを分離し、Aの末尾scroll/expanded heightを
  // Bへ持ち越さない（UI側はowner変更時にmapをclearする）。
  const ownerHeights = new Map<string, Map<number, number>>();
  ownerHeights.set("A", new Map([[5, 500]]));
  ownerHeights.set("B", new Map());
  const bWindow = tableWindowForScroll(filtered, 0, 0, 600, {
    rowHeights: ownerHeights.get("B"),
  });
  assert(bWindow.topHeight === 0, "Aのrow heightをBのtop spacerへ持ち越しました");
  console.log("table-window tests passed");
}

main();
