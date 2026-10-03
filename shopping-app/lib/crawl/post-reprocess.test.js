const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");
const ts = require("typescript");

const filename = path.join(__dirname, "post-reprocess.ts");
const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  fileName: filename,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const coreExports = {};
new Function("exports", ts.transpileModule(
  fs.readFileSync(path.join(__dirname, "../database-core.ts"), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
).outputText)(coreExports);
const oldCut = "file:///documents/images/1/items/old-cut.jpg";
const oldImage = "file:///documents/images/1/items/old-other.jpg";
const postUrl = "https://x.com/example/status/123";

function harness(result, options = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE circles (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, name TEXT NOT NULL, penname TEXT, memo TEXT NOT NULL DEFAULT '', circle_cut_filename TEXT, catalog_status TEXT);
    CREATE TABLE items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
      name TEXT NOT NULL, price REAL, type TEXT, description TEXT,
      purchase_status_source TEXT, raw_json TEXT, name_key TEXT NOT NULL DEFAULT '',
      purchase_status INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE item_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
      filename TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'unknown', raw_json TEXT
    );
    INSERT INTO circles VALUES (1, 1, '既存サークル', '', '元のメモ', NULL, 'confirmed');
    INSERT INTO items (circle_id, name, price, type, description, purchase_status, purchase_status_source, name_key)
      VALUES (1, '既存の商品', 500, '本', '手動説明', 1, 'manual', '既存の商品');
  `);
  sqlite.prepare("UPDATE circles SET circle_cut_filename = ?").run(options.initialCut === undefined ? oldCut : options.initialCut);
  for (const image of [oldCut, oldImage]) {
    sqlite.prepare("INSERT INTO item_images(circle_id, filename, source) VALUES (1, ?, 'twitter')").run(image);
  }
  options.setup?.(sqlite);
  const files = new Set([oldCut, oldImage]);
  const deleted = [];
  const registeredCuts = [];
  let downloads = 0;
  let transactions = 0;
  let awake = 0;
  const database = {
    async getFirstAsync(sql, ...args) {
      if (options.failReferenceLookup && sql.startsWith("SELECT 1 AS present")) throw new Error("参照確認失敗");
      return sqlite.prepare(sql).get(...args) ?? null;
    },
    async getAllAsync(sql, ...args) { return sqlite.prepare(sql).all(...args); },
    async runAsync(sql, ...args) {
      if (options.failInsert && sql.startsWith("INSERT INTO items ")) throw new Error("保存失敗");
      return sqlite.prepare(sql).run(...args);
    },
    async withExclusiveTransactionAsync(callback) {
      transactions++;
      sqlite.exec("BEGIN");
      try { await callback(database); sqlite.exec("COMMIT"); }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
  const mocks = {
    "expo-file-system/legacy": {
      documentDirectory: "file:///documents/",
      async getInfoAsync(uri) { return { exists: files.has(uri) }; },
      async makeDirectoryAsync(uri) { files.add(uri); },
      async copyAsync({ from, to }) {
        assert.ok(files.has(from));
        files.add(to);
        if (options.failCopy) throw new Error("画像コピー失敗");
      },
      async deleteAsync(uri) {
        if (options.failDelete?.(uri)) throw new Error("削除失敗");
        deleted.push(uri);
        for (const entry of files) if (entry === uri || entry.startsWith(uri + (uri.endsWith("/") ? "" : "/"))) files.delete(entry);
      },
    },
    "expo-keep-awake": {
      async activateKeepAwakeAsync() { awake++; },
      deactivateKeepAwake() { awake--; },
    },
    "../database": {
      async getDatabase() { return database; },
      async registerDefaultCutFromImage(...args) {
        registeredCuts.push(args);
        if (options.failDefaultCut) throw new Error("カット登録失敗");
        return options.missingDefaultCut ? null : "0000.jpg";
      },
      normalizePurchaseLookupKey: coreExports.normalizeLookupKey,
      async refreshItemSearchIndexForCircle() {
        if (options.failSearchIndex) throw new Error("検索更新失敗");
      },
      async deleteItemSearchIndexForCircle() {},
      invalidatePurchaseLookupCache() {},
    },
    "../settings-store": { async getApiKey() { return "test-key"; }, async isGrokEnabled() { return true; } },
    "./image-downloader": {
      guessExt: () => "jpg",
      async downloadImage(url, directory, name) {
        downloads++;
        if (downloads === options.failDownloadAt) return null;
        const localPath = directory + name;
        files.add(localPath);
        return { localPath, filename: name };
      },
    },
  };
  const moduleRecord = { exports: {} };
  const mockFetch = async () => {
    options.duringFetch?.(sqlite);
    return { ok: true, async json() { return { choices: [{ message: { content: JSON.stringify(result) } }] }; } };
  };
  new Function("exports", "require", "module", "fetch", compiled)(moduleRecord.exports,
    (name) => { assert.ok(mocks[name], `予期しないimport: ${name}`); return mocks[name]; }, moduleRecord, mockFetch);
  const rows = (table) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map((row) => ({ ...row }));
  const before = { circles: rows("circles"), items: rows("items"), images: rows("item_images") };
  return {
    run: () => moduleRecord.exports.reprocessCircleFromPost(1, postUrl),
    rows, files, deleted, before, registeredCuts,
    assertPreserved() {
      assert.deepEqual(rows("items"), before.items);
      assert.deepEqual(rows("item_images"), before.images);
      assert.ok(files.has(oldCut));
      assert.ok(files.has(oldImage));
      this.assertTemporaryFilesRemoved();
    },
    assertTemporaryFilesRemoved() {
      assert.equal(awake, 0, "失敗時もkeep-awakeを解放する");
      assert.ok(![...files].some((file) => file.includes(".staging_post_") || file.includes("item_1_post_")), "新規一時画像を片付ける");
    },
    get transactions() { return transactions; },
    close() { sqlite.close(); },
  };
}

test("空の投稿解析では既存の頒布物・画像・購入状態を変更しない", async () => {
  const h = harness({ image_urls: [], items: [] });
  try {
    assert.equal((await h.run()).success, false);
    assert.equal(h.transactions, 0);
    h.assertPreserved();
  } finally { h.close(); }
});

for (const failDownloadAt of [1, 2]) test(`画像取得${failDownloadAt}件目の失敗は部分的にも公開しない`, async () => {
  const h = harness({ image_urls: ["https://example.test/a.jpg", "https://example.test/b.jpg"], items: [{ name: "新しい商品" }] }, { failDownloadAt });
  try {
    await assert.rejects(h.run(), /既存データは保持/);
    assert.equal(h.transactions, 0);
    h.assertPreserved();
  } finally { h.close(); }
});

for (const fault of ["failCopy", "failInsert"]) test(`${fault}でも旧データを保持して新規画像を片付ける`, async () => {
  const h = harness({ image_urls: ["https://example.test/a.jpg"], items: [{ name: "新しい商品" }] }, { [fault]: true });
  try { await assert.rejects(h.run()); h.assertPreserved(); }
  finally { h.close(); }
});

test("画像のみの抽出では既存商品の購入状態を保持し、参照中のカットを削除しない", async () => {
  const h = harness({ image_urls: ["https://example.test/a.jpg"], items: [] });
  try {
    assert.equal((await h.run()).success, true);
    assert.deepEqual(h.rows("items"), h.before.items);
    assert.equal(h.rows("item_images").length, 1);
    assert.ok(h.files.has(oldCut));
    assert.ok(!h.files.has(oldImage));
    assert.equal(h.rows("circles")[0].circle_cut_filename, oldCut);
  } finally { h.close(); }
});

test("文字のみの抽出では既存画像を保持し、通信中のメモ編集を失わない", async () => {
  const h = harness({ image_urls: [], items: [{ name: "新しい商品" }] }, {
    duringFetch(sqlite) { sqlite.exec("UPDATE circles SET memo = '通信中に追記したメモ'"); },
  });
  try {
    assert.equal((await h.run()).success, true);
    assert.deepEqual(h.rows("item_images"), h.before.images);
    assert.equal(h.rows("circles")[0].memo, `通信中に追記したメモ\n${postUrl}`);
    assert.ok(h.files.has(oldImage));
  } finally { h.close(); }
});

test("通信中に対象サークルが削除された場合は新しい行や画像を残さない", async () => {
  const h = harness({ image_urls: ["https://example.test/a.jpg"], items: [{ name: "新しい商品" }] }, {
    duringFetch(sqlite) { sqlite.exec("DELETE FROM circles"); },
  });
  try {
    await assert.rejects(h.run(), /削除または変更/);
    assert.deepEqual(h.rows("circles"), []);
    assert.deepEqual(h.rows("items"), []);
    assert.deepEqual(h.rows("item_images"), []);
    h.assertTemporaryFilesRemoved();
  }
  finally { h.close(); }
});

test("通信中に名前・著者を変更した場合は現在のサークル名でデフォルトカットを登録する", async () => {
  const h = harness({ image_urls: ["https://example.test/a.jpg"], items: [] }, {
    initialCut: null,
    duringFetch(sqlite) { sqlite.exec("UPDATE circles SET name = '変更後サークル', penname = '変更後著者'"); },
  });
  try {
    assert.equal((await h.run()).success, true);
    assert.deepEqual(h.registeredCuts, [["変更後サークル", "変更後著者", h.rows("circles")[0].circle_cut_filename]]);
  } finally { h.close(); }
});

test("通信中に手動カットを設定した場合は投稿画像をデフォルトカットへ登録しない", async () => {
  const manualCut = "file:///documents/images/1/cuts/manual.jpg";
  const h = harness({ image_urls: ["https://example.test/a.jpg"], items: [] }, {
    initialCut: null,
    duringFetch(sqlite) { sqlite.prepare("UPDATE circles SET circle_cut_filename = ?").run(manualCut); },
  });
  h.files.add(manualCut);
  try {
    assert.equal((await h.run()).success, true);
    assert.equal(h.rows("circles")[0].circle_cut_filename, manualCut);
    assert.ok(h.files.has(manualCut));
    assert.deepEqual(h.registeredCuts, []);
  } finally { h.close(); }
});

test("表記揺れのある同一商品でも通信中の購入済み操作・手動説明を最新行から引き継ぐ", async () => {
  const h = harness({ image_urls: [], items: [{ name: " Ａ ＢＣ ", type: " 本 ", price: 700 }] }, {
    setup(sqlite) { sqlite.exec("UPDATE items SET name = 'ABC', name_key = 'abc', purchase_status = 3"); },
    duringFetch(sqlite) {
      sqlite.exec("UPDATE items SET purchase_status = 1, purchase_status_source = 'manual', description = '通信中に編集した説明'");
    },
  });
  try {
    assert.equal((await h.run()).success, true);
    const [item] = h.rows("items");
    assert.equal(item.purchase_status, 1);
    assert.equal(item.purchase_status_source, "manual");
    assert.equal(item.description, "通信中に編集した説明");
    assert.equal(item.name_key, "abc");
    assert.equal(item.price, 700);
  } finally { h.close(); }
});

test("由来のない旧商品でも未購入の既定値0を見送り3に変えない", async () => {
  const h = harness({ image_urls: [], items: [{ name: "既存の商品" }] }, {
    setup(sqlite) { sqlite.exec("UPDATE items SET type = NULL, description = NULL, purchase_status = 0, purchase_status_source = NULL"); },
  });
  try {
    assert.equal((await h.run()).success, true);
    const [item] = h.rows("items");
    assert.equal(item.purchase_status, 0);
    assert.equal(item.purchase_status_source, null);
    assert.equal(item.description, null);
  } finally { h.close(); }
});

test("同名でも種別別に購入状態を引き継ぎ、新商品は既定値・削除商品は戻さない", async () => {
  const h = harness({ image_urls: [], items: [
    { name: "既存の商品", type: "本" },
    { name: "既存の商品", type: "グッズ" },
    { name: "既存の商品", type: "新しい種別" },
  ] }, {
    setup(sqlite) {
      sqlite.exec(`
        INSERT INTO items (circle_id, name, type, purchase_status, purchase_status_source, description)
          VALUES (1, '既存の商品', 'グッズ', 2, 'circle', 'グッズの説明');
        INSERT INTO items (circle_id, name, type, purchase_status) VALUES (1, '旧一覧だけの商品', '本', 1);
      `);
    },
  });
  try {
    const result = await h.run();
    assert.equal(result.success, true);
    assert.equal(result.itemCount, 3);
    assert.deepEqual(h.rows("items").map(({ name, type, purchase_status, purchase_status_source, description }) =>
      [name, type, purchase_status, purchase_status_source, description]), [
      ["既存の商品", "本", 1, "manual", "手動説明"],
      ["既存の商品", "グッズ", 2, "circle", "グッズの説明"],
      ["既存の商品", "新しい種別", 3, null, null],
    ]);
  } finally { h.close(); }
});

for (const duplicateSide of ["previous", "incoming"]) test(`${duplicateSide}の商品名・種別が重複する場合は旧データを保持して止める`, async () => {
  const items = [{ name: "既存の商品", type: "本" }];
  if (duplicateSide === "incoming") items.push({ name: " 既存の 商品 ", type: " 本 " });
  const h = harness({ image_urls: ["https://example.test/a.jpg"], items }, {
    setup(sqlite) {
      if (duplicateSide === "previous") sqlite.exec(`
        INSERT INTO items (circle_id, name, type, description, purchase_status, purchase_status_source)
          VALUES (1, ' 既存の 商品 ', ' 本 ', '別の説明', 2, 'manual');
      `);
    },
  });
  try {
    await assert.rejects(h.run(), /重複.*既存データは保持/);
    h.assertPreserved();
    assert.deepEqual(h.rows("circles"), h.before.circles);
  } finally { h.close(); }
});

for (const fault of ["failDefaultCut", "missingDefaultCut"]) test(`${fault}は本体保存後の登録未了として成功と警告を返す`, async () => {
  const h = harness({ image_urls: ["https://example.test/a.jpg"], items: [{ name: "新しい商品" }] }, {
    initialCut: null,
    [fault]: true,
  });
  try {
    const result = await h.run();
    assert.equal(result.success, true);
    assert.equal(result.itemCount, 1);
    assert.equal(result.imageCount, 1);
    assert.match(result.message, /保存は完了.*デフォルトカットの登録が完了していません/);
    assert.equal(h.rows("items")[0].name, "新しい商品");
    assert.ok(h.files.has(h.rows("item_images")[0].filename));
  } finally { h.close(); }
});

for (const fault of ["reference", "oldImage", "staging", "search"]) test(`${fault}の補助処理失敗は保存済みデータを残して未了内容を伝える`, async () => {
  const h = harness({ image_urls: ["https://example.test/a.jpg"], items: [] }, {
    failReferenceLookup: fault === "reference",
    failSearchIndex: fault === "search",
    failDelete: (uri) => (fault === "oldImage" && uri === oldImage) || (fault === "staging" && uri.includes(".staging_post_")),
  });
  try {
    const result = await h.run();
    assert.equal(result.success, true);
    assert.equal(result.imageCount, 1);
    const warnings = { reference: /旧画像2件の削除/, oldImage: /旧画像1件の削除/, staging: /一時画像の削除/, search: /商品検索の更新/ };
    assert.match(result.message, /保存は完了/);
    assert.match(result.message, warnings[fault]);
    assert.deepEqual(h.rows("items"), h.before.items);
    assert.ok(h.files.has(h.rows("item_images")[0].filename));
    if (fault === "reference" || fault === "oldImage") assert.ok(h.files.has(oldImage));
  } finally { h.close(); }
});
