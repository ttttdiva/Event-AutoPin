import { reprocessProgressLabel } from "./reprocess-runtime";

const cases: Array<[string, string, string | null]> = [
  ["[EAP_REPROCESS] run_id=joint-1 stage=catalog.joint outcome=begin elapsed_ms=0", "joint-1", "投稿本文と全画像から商品・価格を確認中"],
  ["[EAP_REPROCESS] run_id=other stage=catalog.joint outcome=begin elapsed_ms=0", "joint-1", null],
  ["[EAP_REPROCESS] run_id=joint-1 stage=catalog.joint outcome=end elapsed_ms=300", "joint-1", null],
  ["[EAP_REPROCESS] run_id=joint-1 stage=catalog.verify outcome=begin elapsed_ms=0", "joint-1", "商品名・価格を読み取り中"],
];
for (const [line, runId, expected] of cases) {
  const actual = reprocessProgressLabel(line, runId);
  if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
}
console.log("catalog-joint-runtime: 4 checks passed");
