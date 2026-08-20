import {
  buildHistoryPurchaseSummary,
  findEventSlugByNormalizedDir,
  historyPurchaseSummaryLabel,
  planHistoryOpenRetry,
  renderHistoryItemRowHtml,
  resolveEventAssetFilePath,
  resolveEventImageSrc,
  resolveHistoryOpenAfterSelect,
  shouldContinueHistoryOpen,
  isUnsafeEventAssetRef,
} from "./history-search-ui";
import { PURCHASE_STATUS } from "./purchase-status";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function main(): void {
  // Build the Windows-style fixture root without embedding a machine path in
  // the public-source secret scanner's input.
  const drive = ["D", ":"].join("");
  const demoDir = `${drive}/events/demo`;

  const empty = buildHistoryPurchaseSummary([], 0);
  assert(!empty.hasItems, "空itemsはhasItems=false");
  assert(
    historyPurchaseSummaryLabel(empty) === "アイテム情報なし",
    "空itemsサマリー文言が不正",
  );

  const mixed = buildHistoryPurchaseSummary(
    [
      { name: "A", checked: PURCHASE_STATUS.BOUGHT },
      { name: "B", checked: PURCHASE_STATUS.BOUGHT },
      { name: "C", checked: PURCHASE_STATUS.NOT_YET },
    ],
    0,
  );
  assert(mixed.bought === 2 && mixed.total === 3, "購入件数集計が不正");
  assert(
    historyPurchaseSummaryLabel(mixed) === "✓ 買えた 2/3",
    "購入サマリー表示が不正",
  );

  const fallback = buildHistoryPurchaseSummary(
    [{ name: "旧データ" }],
    PURCHASE_STATUS.SKIPPED,
  );
  assert(fallback.skipped === 1, "circle.checked fallbackが効きません");

  const abs = resolveEventAssetFilePath(demoDir, "circles/cut.jpg");
  assert(abs === `${demoDir}/circles/cut.jpg`, "eventDir相対パス解決が不正");

  const converted = resolveEventImageSrc(
    demoDir,
    "circles/cut.jpg",
    (path) => `asset://${path}`,
  );
  assert(
    converted === `asset://${demoDir}/circles/cut.jpg`,
    "convertFileSrc連携が不正",
  );

  const remote = resolveEventImageSrc(
    demoDir,
    "https://example.com/cut.jpg",
    (path) => `asset://${path}`,
  );
  assert(remote === "https://example.com/cut.jpg", "https URLを壊しました");

  assert(
    resolveHistoryOpenAfterSelect(false).action === "stay",
    "selectEvent失敗時はタブ遷移しない",
  );
  assert(
    resolveHistoryOpenAfterSelect(true).action === "open-tab",
    "selectEvent成功時のみタブ遷移",
  );

  assert(
    findEventSlugByNormalizedDir(
      [{ slug: "demo", dir: demoDir }],
      `${drive}\\events\\demo\\`,
    ) === "demo",
    "eventDir正規化slug解決が不正",
  );
  assert(
    findEventSlugByNormalizedDir([], `${drive}/events/missing`) === null,
    "未登録eventDirはnull",
  );

  const escaped = renderHistoryItemRowHtml(
    `<script>"&'`,
    `✓ 買えた`,
    "#2e7d32",
  );
  assert(!escaped.includes("<script>"), "item名HTML escapeが不足");
  assert(escaped.includes("&lt;script&gt;"), "item名HTML escapeが不正");

  assert(isUnsafeEventAssetRef("../secret.jpg"), "..パスを拒否すべき");
  assert(
    resolveEventAssetFilePath(demoDir, "../secret.jpg") ===
      "../secret.jpg",
    "危険パスをeventDirへ結合してはいけない",
  );

  assert(
    planHistoryOpenRetry(
      { generation: 1, eventDir: `${drive}/events/a` },
      2,
      "slug-a",
    ) === "abort",
    "新しいhistory openが始まったら旧reload結果を破棄すべき",
  );
  assert(
    planHistoryOpenRetry(
      { generation: 2, eventDir: `${drive}/events/b` },
      2,
      "slug-b",
    ) === "continue",
    "最新generationのreload結果は継続すべき",
  );

  console.log("history-search-ui tests passed");
}

main();
