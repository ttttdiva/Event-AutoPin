import {
  PurchaseHistoryIndexService,
  buildPurchasedItemIndex,
  normalizePurchaseLookupKey,
  purchasedItemKey,
} from "./purchase-history-index";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const eventA = {
  circles: [
    { name: "ＡＢＣ", penname: "Pen Name", items: [{ name: "新刊", checked: 1 }] },
    { name: "未購入", items: [{ name: "別本", checked: 0 }] },
  ],
};

function main(): void {
  assert(normalizePurchaseLookupKey(" ＡＢＣ ") === "abc", "NFKC/空白除去が不正です");
  const index = buildPurchasedItemIndex(eventA);
  assert(index.has(purchasedItemKey("abc", "新刊")), "circle name購入履歴が欠落しています");
  assert(index.has(purchasedItemKey("penname", "新刊")), "penname購入履歴が欠落しています");
  assert(!index.has(purchasedItemKey("未購入", "別本")), "未購入itemをindexへ追加しました");

  const service = new PurchaseHistoryIndexService();
  service.replace("A", eventA, { modifiedMs: 10, fileSize: 20 });
  service.replace("B", { circles: [{ name: "B", items: [{ name: "item", checked: 1 }] }] });
  assert(service.size === 2, "イベント単位cacheが分離されていません");
  assert(service.get("A").has(purchasedItemKey("abc", "新刊")), "A cacheが不正です");
  assert(service.fingerprint("A")?.modifiedMs === 10, "A fingerprintが保存されていません");
  service.replace(
    "A",
    { circles: [{ name: "ＡＢＣ", items: [{ name: "更新刊", checked: 1 }] }] },
    { modifiedMs: 11, fileSize: 21 },
  );
  assert(!service.get("A").has(purchasedItemKey("abc", "新刊")), "外部変更前の購入履歴が残っています");
  assert(service.get("A").has(purchasedItemKey("abc", "更新刊")), "外部変更後の購入履歴へ更新されません");
  assert(service.fingerprint("A")?.fileSize === 21, "外部変更fingerprintが更新されません");
  service.rename("A", "A2");
  assert(service.get("A").size === 0 && service.get("A2").size > 0, "renameでcache ownerが移動しません");
  service.remove("A2");
  assert(service.get("A2").size === 0 && service.get("B").size > 0, "deleteで他event cacheを壊しました");
  console.log("purchase-history-index tests passed");
}

main();
