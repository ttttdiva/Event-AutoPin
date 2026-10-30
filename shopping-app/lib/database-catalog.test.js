const assert = require("node:assert/strict");
const Module = require("node:module");
const { DatabaseSync } = require("node:sqlite");

// SQLを模倣せずSQLiteで実行し、ネイティブの接続・ZIP・FS境界だけを置き換える。
async function runDatabaseCatalogTests() {
  const sqlite = new DatabaseSync(":memory:");
  const database = {
    execAsync: async (sql) => sqlite.exec(sql),
    getAllAsync: async (sql, ...params) => sqlite.prepare(sql).all(...params),
    getFirstAsync: async (sql, ...params) => sqlite.prepare(sql).get(...params) ?? null,
    runAsync: async (sql, ...params) => {
      const result = sqlite.prepare(sql).run(...params);
      return { lastInsertRowId: Number(result.lastInsertRowid), changes: Number(result.changes) };
    },
    withTransactionAsync: async (callback) => transaction(callback),
    withExclusiveTransactionAsync: async (callback) => transaction(() => callback(database)),
  };
  async function transaction(callback) {
    sqlite.exec("BEGIN");
    try { await callback(); sqlite.exec("COMMIT"); }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  }
  const post = "https://x.com/example/status/123";
  let payload = {
    event: { name: "併催テスト", url: "https://example.com", future_event: { value: 1 } },
    metadata: { generated_at: "2026-10-30", format_version: "1.0", total_circles: 8, future_metadata: true },
    future_root: { keep: [1, 2] },
    circles: [
      { name: "Miotec", space: "C-23,C-24", catalog_status: "confirmed", sub_event: "併催A", menu_url: post, pin_x: null, pin_y: null },
      { name: "Miotec", space: "D-15,D-16", catalog_status: "preview", sub_event: "併催B", menu_url: post, pin_x: 0, pin_y: 1 },
      // 画像・品目・投稿URLがあっても予告/要確認を「あり」に戻さない。
      { name: "予告の既存資料", catalog_status: "preview", items: [{ name: "旧品目" }], item_images: [{ path: "old.png", source: "test" }], memo: post, pin_x: 0.25, pin_y: 0.75 },
      { name: "要確認", catalog_status: "needs_recheck", items: [{ name: "旧品目" }], memo: post },
      { name: "未設定で品目あり", catalog_status: null, items: [{ name: "本", future_item: { keep: true } }] },
      { name: "未設定で資料なし", catalog_status: null },
      { name: "未設定で投稿あり", memo: post },
      { name: "旧状態値", catalog_status: "done" },
    ].map((circle) => ({ ...circle, circle_cut_origin: { provider: "future", revision: 2 }, future_circle: ["保持"] })),
  };
  const original = structuredClone(payload);
  const fileSystem = {
    documentDirectory: "file:///documents/", cacheDirectory: "file:///cache/",
    getInfoAsync: async () => ({ exists: false }),
    readDirectoryAsync: async () => [],
    makeDirectoryAsync: async () => {}, deleteAsync: async () => {},
    readAsStringAsync: async (filename) => {
      if (filename.endsWith("/event.json")) return JSON.stringify(payload);
      throw new Error(`テストに存在しないファイル: ${filename}`);
    },
  };
  const originalLoad = Module._load;
  const databasePath = require.resolve("./database");
  Module._load = function (request, parent, isMain) {
    if (request === "expo-sqlite") return { openDatabaseAsync: async () => database };
    if (request === "expo-file-system/legacy") return fileSystem;
    if (request === "expo-image-picker") return {};
    if (request === "react-native-zip-archive") return { unzip: async () => {} };
    if (request === "./performance") return { __sqlMetricsDevOnly: false };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const db = require("./database");
    const eventId = await db.importFromZip("file:///fixture.zip");
    const rows = await db.getCircleListRows(eventId);
    assert.equal(rows.length, 8, "同名でもスペースの違うサークルを統合しない");
    const miotec = rows.filter((row) => row.name === "Miotec");
    assert.deepEqual(miotec.map((row) => row.space), ["C-23,C-24", "D-15,D-16"]);
    assert.notEqual(miotec[0].id, miotec[1].id);
    const expected = [true, false, false, false, true, false, true, true];
    for (const [index, source] of original.circles.entries()) {
      const row = rows.find((row) => row.name === source.name && row.space === (source.space ?? null));
      assert.equal(row.hasCatalogPost, expected[index], `${source.name}: おしながき判定`);
      assert.equal(row.subEvent, source.sub_event ?? null);
      assert.equal(row.menuUrl, source.menu_url ?? null);
      assert.equal(row.pinX, source.pin_x ?? null);
      assert.equal(row.pinY, source.pin_y ?? null);
      assert.equal(row.rawJson, undefined, "一覧にはraw全体を返さない");
    }
    const fullRows = await db.getCirclesByEvent(eventId);
    for (const row of rows) {
      const full = fullRows.find((entry) => entry.id === row.id);
      const single = await db.getCircle(row.id);
      for (const value of [full, single]) {
        assert.equal(value.subEvent, row.subEvent);
        assert.equal(value.menuUrl, row.menuUrl);
      }
      assert.equal(full.hasCatalogPost, row.hasCatalogPost);
    }
    for (const [field, value] of [["sub_event", "更新された併催"], ["menu_url", "https://example.com/menu"]]) {
      await database.runAsync("UPDATE circles SET raw_json = json_set(raw_json, ?, ?) WHERE id = ?", `$.${field}`, value, miotec[0].id);
      const updated = (await db.getCircleListRows(eventId)).find((row) => row.id === miotec[0].id);
      assert.notEqual(updated.renderRevision, miotec[0].renderRevision, `${field}変更は再描画対象`);
      await database.runAsync("UPDATE circles SET raw_json = ? WHERE id = ?", JSON.stringify(original.circles[0]), miotec[0].id);
    }
    let currentEventId = eventId;
    for (let round = 0; round < 2; round++) {
      payload = JSON.parse(JSON.stringify(await db.exportEventData(currentEventId)));
      assert.deepEqual(payload.future_root, original.future_root);
      assert.deepEqual(payload.event.future_event, original.event.future_event);
      assert.equal(payload.metadata.future_metadata, true);
      assert.equal(payload.circles.length, 8);
      for (const source of original.circles) {
        const circle = payload.circles.find((circle) => circle.name === source.name && circle.space === source.space);
        for (const field of ["catalog_status", "sub_event", "menu_url", "circle_cut_origin", "future_circle", "pin_x", "pin_y"]) {
          assert.deepEqual(circle[field], source[field], `${round + 1}往復目: ${source.name}/${field}`);
        }
        if (source.items) assert.deepEqual(circle.items[0].future_item, source.items[0].future_item);
      }
      if (round === 0) currentEventId = await db.importFromZip("file:///roundtrip.zip");
    }
    console.log("おしながきDB: 8サークルの実SQL判定・同名別スペース・projection更新・未知項目とnull/座標の2往復 PASS");
  } finally {
    Module._load = originalLoad;
    delete require.cache[databasePath];
    sqlite.close();
  }
}

module.exports = { runDatabaseCatalogTests };
