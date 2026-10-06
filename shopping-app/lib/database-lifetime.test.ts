import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

function deferred() {
  let resolve!: () => void;
  let settled = false;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = () => { settled = true; yes(); };
    reject = (error) => { settled = true; no(error); };
  });
  return { promise, resolve, reject, get settled() { return settled; } };
}

async function flushUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("非同期処理が期待する境界へ到達しませんでした");
}

type Row = Record<string, any>;

// 実DB/端末データを使わず、接続identity・closeとpublish先を検証する。
function createHarness(options: {
  liveInit?: ReturnType<typeof deferred>;
  stageInit?: ReturnType<typeof deferred>;
  eventRead?: ReturnType<typeof deferred>;
  backfill?: ReturnType<typeof deferred>;
  restoreError?: Error;
  stageClose?: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> };
  restoreMove?: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> };
  closeError?: Error;
  publishError?: Error;
} = {}) {
  const opened: MockDatabase[] = [];
  const backups: Array<{ source: MockDatabase; destination: MockDatabase }> = [];
  const files = new Map<string, string | null>();
  const key = (path: string) => path.replace(/\/$/, "");
  const mkdir = (path: string) => {
    const value = key(path);
    const parent = value.slice(0, value.lastIndexOf("/"));
    if (parent.length > "file://".length && !files.has(parent)) mkdir(parent);
    files.set(value, null);
  };
  mkdir("file:///cache/");
  mkdir("file:///documents/");
  class MockDatabase {
    closeCount = 0;
    closed = false;
    queries: Array<{ sql: string; params: any[] }> = [];
    events: Row[] = [];
    favorites: Row[] = [];
    settings = new Map<string, string>();
    constructor(readonly name: string) {}
    check(sql: string, params: any[] = []) {
      assert.equal(this.closed, false, `close済み接続の利用: ${this.name}`);
      this.queries.push({ sql, params });
    }
    async execAsync(sql: string) {
      this.check(sql);
      if (sql.includes("CREATE TABLE IF NOT EXISTS events")) {
        const gate = this.name === "doujin_shopping.db"
          ? (opened.filter((entry) => entry.name === this.name).length === 1 ? options.liveInit : undefined)
          : options.stageInit;
        if (gate) await gate.promise;
      }
    }
    async getFirstAsync(sql: string, ...params: any[]) {
      this.check(sql, params);
      if (sql === "PRAGMA user_version") return { user_version: 7 };
      if (sql === "PRAGMA integrity_check") return { integrity_check: "ok" };
      if (sql.includes("AS max_id")) return { max_id: Math.max(0, ...this.events.map((row) => row.id)) };
      if (sql.includes("SELECT value FROM app_settings")) {
        const value = this.settings.get(params[0]);
        return value == null ? null : { value };
      }
      if (sql.includes("SELECT 1 FROM favorite_circles")) {
        return this.favorites.find((row) => row.name === params[0] || row.tag === params[1]) ?? null;
      }
      return null;
    }
    async getAllAsync(sql: string, ...params: any[]) {
      this.check(sql, params);
      if (sql.startsWith("PRAGMA table_info")) return [{ name: "backup_dir" }];
      if (sql.includes("SELECT * FROM favorite_circles")) return this.favorites.map((row) => ({ ...row }));
      if (sql.includes("SELECT id FROM events")) return this.events.map((row) => ({ id: row.id }));
      return [];
    }
    async runAsync(sql: string, ...params: any[]) {
      this.check(sql, params);
      if (sql === "DELETE FROM items_fts" && this.name === "doujin_shopping.db" && this.queries.filter((query) => query.sql === sql).length === 1) {
        await options.backfill?.promise;
      }
      if (/INSERT INTO events \(/.test(sql)) this.events.push({ id: params[0], name: params[1] });
      if (/INSERT(?: OR REPLACE)? INTO app_settings/.test(sql)) this.settings.set(params[0], params[1]);
      if (sql.startsWith("DELETE FROM app_settings")) this.settings.delete(params[0]);
      if (sql.startsWith("INSERT INTO favorite_circles")) this.favorites.push({ id: this.favorites.length + 1, name: params[0], tag: params[1] });
      if (sql === "DELETE FROM favorite_circles") this.favorites = [];
      return { lastInsertRowId: 1, changes: 1 };
    }
    async withTransactionAsync(task: () => Promise<void>) { await task(); }
    async withExclusiveTransactionAsync(task: (database: MockDatabase) => Promise<void>) { await task(this); }
    async prepareAsync(sql: string) {
      this.check(sql);
      return {
        executeAsync: async () => ({ getFirstAsync: async () => ({ integrity_check: "ok" }) }),
        finalizeAsync: async () => undefined,
      };
    }
    async closeAsync() {
      if (this.name.startsWith("eventtrail_legacy_stage_") && options.stageClose) {
        options.stageClose.entered.resolve();
        await options.stageClose.release.promise;
      }
      if (this.name === "doujin_shopping.db") assert(opened.includes(this), "raw接続自身でcloseする");
      this.closeCount += 1;
      this.closed = true;
      if (options.closeError) throw options.closeError;
    }
  }
  const move = ({ from, to }: { from: string; to: string }, remove: boolean) => {
    const src = key(from), dst = key(to);
    assert(files.has(src), `存在しない転送元: ${from}`);
    for (const [path, content] of [...files]) {
      if (path === src || path.startsWith(`${src}/`)) {
        files.set(dst + path.slice(src.length), content);
        if (remove) files.delete(path);
      }
    }
  };
  const fileSystem = {
    documentDirectory: "file:///documents/", cacheDirectory: "file:///cache/",
    async getInfoAsync(path: string) {
      const content = files.get(key(path));
      return content === undefined ? { exists: false } : {
        exists: true, isDirectory: content === null, size: content?.length ?? 0,
        modificationTime: 1, md5: "fixture-md5",
      };
    },
    async makeDirectoryAsync(path: string) { mkdir(path); },
    async readDirectoryAsync(path: string) {
      const prefix = `${key(path)}/`;
      return [...new Set([...files.keys()].filter((entry) => entry.startsWith(prefix))
        .map((entry) => entry.slice(prefix.length).split("/")[0]))];
    },
    async readAsStringAsync(path: string) {
      if (path.endsWith("/event.json")) await options.eventRead?.promise;
      const content = files.get(key(path));
      assert.equal(typeof content, "string", `存在しないファイル: ${path}`);
      return content as string;
    },
    async writeAsStringAsync(path: string, content: string) { files.set(key(path), content); },
    async moveAsync(paths: { from: string; to: string }) {
      if (paths.from.includes(".restore_") && options.restoreMove) {
        options.restoreMove.entered.resolve();
        await options.restoreMove.release.promise;
      }
      move(paths, true);
    },
    async copyAsync(paths: { from: string; to: string }) { move(paths, false); },
    async deleteAsync(path: string) {
      for (const entry of [...files.keys()]) if (entry === key(path) || entry.startsWith(`${key(path)}/`)) files.delete(entry);
    },
  };
  const sqlite = {
    async openDatabaseAsync(name: string, config: Row) {
      assert.equal(config.finalizeUnusedStatementsBeforeClosing, false);
      const result = new MockDatabase(name);
      const previous = opened.filter((entry) => entry.name === name).at(-1);
      if (previous) {
        result.events = structuredClone(previous.events);
        result.favorites = structuredClone(previous.favorites);
        result.settings = new Map(previous.settings);
      }
      opened.push(result);
      return result;
    },
    async backupDatabaseAsync({ sourceDatabase, destDatabase }: { sourceDatabase: MockDatabase; destDatabase: MockDatabase }) {
      sourceDatabase.check("backup_source"); destDatabase.check("backup_destination");
      backups.push({ source: sourceDatabase, destination: destDatabase });
      if (options.restoreError && sourceDatabase.name.startsWith("eventtrail_legacy_old_") && destDatabase.name === "doujin_shopping.db") throw options.restoreError;
      destDatabase.events = structuredClone(sourceDatabase.events);
      destDatabase.favorites = structuredClone(sourceDatabase.favorites);
      destDatabase.settings = new Map(sourceDatabase.settings);
      if (options.publishError && sourceDatabase.name.startsWith("eventtrail_legacy_stage_")) throw options.publishError;
    },
    async deleteDatabaseAsync(name: string) {
      assert(opened.filter((database) => database.name === name).every((database) => database.closed), "削除前に一時DBをcloseする");
    },
  };
  const runtimeRequire = eval("require") as NodeRequire;
  const Module = runtimeRequire("module");
  const originalLoad = Module._load;
  Module._load = function(request: string, parent: unknown, isMain: boolean) {
    if (request === "expo-sqlite") return sqlite;
    if (request === "expo-file-system/legacy") return fileSystem;
    if (request === "expo-image-picker") return {};
    if (request === "./performance") return { __sqlMetricsDevOnly: true, estimateSqlResultBytes: () => 0, recordSqlMetric: () => undefined };
    if (request === "react-native-zip-archive") return {
      async unzip(_source: string, destination: string) {
        const root = `file://${destination}`;
        mkdir(root);
        files.set(`${root}sync_bundle.json`, JSON.stringify({ sync_mode: "full", events: [{ path: "event.json" }] }));
        files.set(`${root}event.json`, JSON.stringify({ event: { name: "imported", url: "", maps: [] }, circles: [{ name: "circle", penname: "artist", items: [{ name: "book", price: 500 }] }], metadata: {} }));
        files.set(`${root}circle_master.json`, JSON.stringify({ circles: { favorite: { penname: "tag", favorite: true } } }));
      },
      async zip() {},
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  const modulePath = runtimeRequire.resolve("./database");
  delete runtimeRequire.cache[modulePath];
  const api = runtimeRequire("./database") as typeof import("./database");
  Module._load = originalLoad;
  return { api, opened, backups, files };
}

async function run(): Promise<void> {
  const checks: Array<[string, () => Promise<void>]> = [
    ["FTS検索は実SQLiteで表名MATCH・イベント分離・件数制限を保持", async () => {
      const native = new DatabaseSync(":memory:");
      try {
        native.exec(`
          CREATE TABLE circles (id INTEGER PRIMARY KEY, event_id INTEGER);
          CREATE TABLE items (id INTEGER PRIMARY KEY, circle_id INTEGER, name TEXT,
            name_key TEXT, description TEXT, price INTEGER, type TEXT, purchase_status INTEGER);
          CREATE VIRTUAL TABLE items_fts USING fts5(name, description, item_id UNINDEXED);
          INSERT INTO circles VALUES (1, 10), (2, 20);
          INSERT INTO items VALUES
            (1, 1, 'Alpha book', 'alpha book', 'first title', 500, 'book', 1),
            (2, 1, 'Beta item', 'beta item', 'book in description', NULL, NULL, 0),
            (3, 2, 'Other book', 'other book', 'another event', 700, 'book', 2);
        `);
        const { api, opened } = createHarness();
        await api.getDatabase();
        const live = opened[0];
        // 接続寿命のstubを維持し、検索と遅延backfillのSQL自体は実SQLiteへ渡す。
        live.getAllAsync = async (sql: string, ...params: any[]) => {
          live.check(sql, params);
          return native.prepare(sql).all(...params);
        };
        live.runAsync = async (sql: string, ...params: any[]) => {
          live.check(sql, params);
          const result = native.prepare(sql).run(...params);
          return { lastInsertRowId: Number(result.lastInsertRowid), changes: Number(result.changes) };
        };
        assert.equal(api.isItemSearchFtsAvailable(), true, "LIKEへのfallbackで検索失敗を隠さない");
        assert.deepEqual(await api.searchItemsByEvent(10, "book"), [
          { id: 1, circleId: 1, name: "Alpha book", description: "first title", price: 500, type: "book", purchaseStatus: 1 },
          { id: 2, circleId: 1, name: "Beta item", description: "book in description", price: null, type: null, purchaseStatus: 0 },
        ]);
        assert.deepEqual((await api.searchItemsByEvent(20, "book")).map((row) => row.id), [3]);
        assert.deepEqual((await api.searchItemsByEvent(10, "boo", 1)).map((row) => row.id), [1]);
        assert.deepEqual(await api.searchItemsByEvent(10, "missing"), []);
        const queriesBeforeEmptySearch = live.queries.length;
        assert.deepEqual(await api.searchItemsByEvent(10, "  "), []);
        assert.equal(live.queries.length, queriesBeforeEmptySearch, "空の検索はSQLを発行しない");
        assert.equal(api.isItemSearchFtsAvailable(), true, "検索後もFTS5を利用している");
        assert.equal(live.queries.filter((query) => query.sql.includes("FROM items_fts f")).length, 4, "全検索を実FTS5で検証する");
        assert.equal(live.queries.filter((query) => query.sql === "DELETE FROM items_fts").length, 1, "backfillは一度だけ行う");
      } finally {
        native.close();
      }
    }],
    ["並行getDatabaseは一つの初期化を共有", async () => {
      const gate = deferred();
      const { api, opened } = createHarness({ liveInit: gate });
      const first = api.getDatabase(), second = api.getDatabase();
      await flushUntil(() => opened.length === 1 && opened[0].queries.length > 0);
      assert.equal(opened.length, 1);
      gate.resolve();
      assert.equal(await first, await second);
      assert.equal(await api.getDatabase(), await first);
      assert.equal(opened[0].closeCount, 0);
    }],
    ...[false, true].map((closeFails): [string, () => Promise<void>] => [
      `初期化失敗は所有raw接続を一度closeし元の例外を保持(close失敗=${closeFails})`, async () => {
        const gate = deferred();
        const initError = new Error("schema failed");
        const { api, opened } = createHarness({ liveInit: gate, closeError: closeFails ? new Error("close failed") : undefined });
        const first = api.getDatabase(), second = api.getDatabase();
        const failures = Promise.allSettled([first, second]);
        await flushUntil(() => opened.length === 1 && opened[0].queries.length > 0);
        gate.reject(initError);
        for (const result of await failures) {
          assert.equal(result.status, "rejected");
          if (result.status === "rejected") assert.equal(result.reason, initError);
        }
        assert.equal(opened[0].closeCount, 1);
        const [retry, retryWaiter] = await Promise.all([api.getDatabase(), api.getDatabase()]);
        assert(retry === retryWaiter, "再初期化も一つのpromiseへ合流する");
        assert.equal(opened.length, 2);
        assert.equal(opened[1].closeCount, 0);
      },
    ]),
    ["stage構築中のUI読み込みはlive接続を保持しstageのclose後も利用可能", async () => {
      const stage = deferred();
      const { api, opened } = createHarness({ stageInit: stage });
      const live = await api.getDatabase();
      opened[0].events = [{ id: 91, name: "old" }];
      const imported = api.importFromZip("file:///fixture.zip");
      await flushUntil(() => opened.some((entry) => entry.name.startsWith("eventtrail_legacy_stage_") && entry.queries.length > 0));
      const ui = await api.getDatabase();
      stage.resolve();
      await imported;
      assert(ui === live, "UIへstageを公開しない");
      await ui.getAllAsync("SELECT id FROM events");
      assert(await api.getDatabase() === live, "live接続のidentityを保持する");
      assert.equal(opened.filter((entry) => entry.name === "doujin_shopping.db").length, 1);
      assert.equal(opened[0].closeCount, 0);
      assert.equal(opened[0].queries.some((query) => /INSERT INTO events|INSERT INTO favorite_circles|INSERT OR REPLACE INTO app_settings/.test(query.sql)), false, "stage取込SQLをliveへ流さない");
      assert.deepEqual(opened[0].events, [{ id: 1, name: "imported" }]);
      assert.equal(opened[0].favorites[0]?.name, "favorite");
      assert(opened[0].settings.get("circle_master_json")?.includes("favorite"));
      assert(opened.filter((entry) => entry.name !== "doujin_shopping.db").every((entry) => entry.closeCount === 1));
    }],
    ["初期化pendingとfull importの並行実行でもliveを二重openしない", async () => {
      const gate = deferred();
      const { api, opened } = createHarness({ liveInit: gate });
      const pending = api.getDatabase();
      await flushUntil(() => opened.length === 1 && opened[0].queries.length > 0);
      const imported = api.importFromZip("file:///fixture.zip");
      await new Promise<void>((resolve) => setImmediate(resolve));
      const stageBeforeLiveReady = opened.some((entry) => entry.name.startsWith("eventtrail_legacy_stage_"));
      gate.resolve();
      const live = await pending;
      await imported;
      assert.equal(stageBeforeLiveReady, false, "startup recovery完了前にstageを構築しない");
      assert.equal(opened.filter((entry) => entry.name === "doujin_shopping.db").length, 1);
      assert(await api.getDatabase() === live, "live接続のidentityを保持する");
      assert.equal(opened[0].closeCount, 0);
    }],
    ["未初期化のfull importもlive singletonを一度だけ開く", async () => {
      const { api, opened } = createHarness();
      await api.importFromZip("file:///fixture.zip");
      await api.getDatabase();
      assert.equal(opened.filter((entry) => entry.name === "doujin_shopping.db").length, 1);
      assert.equal(opened.find((entry) => entry.name === "doujin_shopping.db")?.closeCount, 0);
    }],
    ["stage初期化はliveのFTS状態を変更せずpublish後に再構築", async () => {
      const read = deferred();
      const { api, opened } = createHarness({ eventRead: read });
      await api.getDatabase();
      const backfills = () => opened[0].queries.filter((query) => query.sql === "DELETE FROM items_fts").length;
      await api.searchItemsByEvent(1, "old");
      assert.equal(backfills(), 1);
      const imported = api.importFromZip("file:///fixture.zip");
      await flushUntil(() => opened.some((entry) => entry.name.startsWith("eventtrail_legacy_stage_") && entry.queries.some((query) => query.sql.includes("CREATE VIRTUAL TABLE"))));
      await api.searchItemsByEvent(1, "old");
      assert.equal(backfills(), 1, "stage初期化ではliveを再backfillしない");
      read.resolve();
      await imported;
      await api.searchItemsByEvent(1, "new");
      assert.equal(backfills(), 2, "publish後は新しいitemsから再構築する");
      const staged = opened.find((entry) => entry.name.startsWith("eventtrail_legacy_stage_"))!;
      assert(staged.queries.some((query) => query.sql.startsWith("INSERT INTO items (")), "stageに頒布物を取り込む");
      assert.equal(staged.queries.some((query) => /(?:INSERT INTO|DELETE FROM) items_fts/.test(query.sql)), false, "stageはliveのready状態で派生索引を書かない");
    }],
    ["publishを跨ぐ旧backfill完了は新世代を準備済みにしない", async () => {
      const gate = deferred();
      const { api, opened } = createHarness({ backfill: gate });
      await api.getDatabase();
      const search = api.searchItemsByEvent(1, "old");
      await flushUntil(() => opened[0].queries.some((query) => query.sql === "DELETE FROM items_fts"));
      await api.importFromZip("file:///fixture.zip");
      gate.resolve();
      await search;
      assert.equal(opened[0].queries.filter((query) => query.sql === "DELETE FROM items_fts").length, 2);
      const stage = opened.find((entry) => entry.name.startsWith("eventtrail_legacy_stage_"))!;
      assert.equal(stage.queries.some((query) => query.sql === "DELETE FROM items_fts"), false);
    }],
    ["DB復旧失敗はjournalと借用liveを保持して以後の利用をブロック", async () => {
      const { api, opened, files } = createHarness({ publishError: new Error("publish failed"), restoreError: new Error("restore failed") });
      await assert.rejects(api.importFromZip("file:///fixture.zip"), /DB rollback failed/);
      await assert.rejects(api.getDatabase(), /再起動して復旧/);
      await assert.rejects(api.getEventIds(), /再起動して復旧/);
      assert.equal(opened.filter((entry) => entry.name === "doujin_shopping.db").length, 1);
      assert.equal(opened.find((entry) => entry.name === "doujin_shopping.db")?.closeCount, 0);
      assert([...files.keys()].some((path) => path.endsWith("/journal.json")), "復旧用journalを保持する");
    }],
    ...(["image", "close"] as const).flatMap((boundary) => [true, false].map((restoreFails): [string, () => Promise<void>] => [
      `復旧${restoreFails ? "失敗" : "成功"}の${boundary === "image" ? "画像復旧" : "stage close"}待機境界でlive公開を制御`, async () => {
        const pause = { entered: deferred(), release: deferred() };
        const { api, opened, files } = createHarness({
          publishError: new Error("publish failed"),
          restoreError: restoreFails ? new Error("restore failed") : undefined,
          ...(boundary === "image" ? { restoreMove: pause } : { stageClose: pause }),
        });
        const live = await api.getDatabase();
        opened[0].events = [{ id: 91, name: "old" }];
        files.set("file:///documents/images", null);
        files.set("file:///documents/images/old.txt", "old-image");
        const imported = assert.rejects(api.importFromZip("file:///fixture.zip"), /publish failed/);
        await flushUntil(() => pause.entered.settled);
        try {
          if (restoreFails || boundary === "image") {
            await assert.rejects(api.getDatabase(), /復旧/);
            await assert.rejects(api.getEventIds(), /復旧/);
          } else {
            assert(await api.getDatabase() === live, "全復旧を検証済みならstage closeを待たず利用可");
          }
          assert.equal(opened[0].closeCount, 0);
          assert.equal(opened.filter((entry) => entry.name === "doujin_shopping.db").length, 1);
        } finally {
          pause.release.resolve();
          await imported;
        }
        if (restoreFails) {
          await assert.rejects(api.getDatabase(), /再起動して復旧/);
          assert([...files.keys()].some((path) => path.endsWith("/journal.json")));
        } else {
          assert(await api.getDatabase() === live, "検証済み復旧は自分のgateを解除する");
          assert.deepEqual(opened[0].events, [{ id: 91, name: "old" }]);
          assert.equal(files.get("file:///documents/images/old.txt"), "old-image");
        }
      },
    ])),
    ["stage初期化失敗はlive内容と接続を保持", async () => {
      const stage = deferred();
      const { api, opened } = createHarness({ stageInit: stage });
      const live = await api.getDatabase();
      opened[0].events = [{ id: 91, name: "old" }];
      const imported = api.importFromZip("file:///fixture.zip");
      const rejected = assert.rejects(imported, /stage failed/);
      await flushUntil(() => opened.some((entry) => entry.name.startsWith("eventtrail_legacy_stage_") && entry.queries.length > 0));
      stage.reject(new Error("stage failed"));
      await rejected;
      assert(await api.getDatabase() === live, "live接続のidentityを保持する");
      assert.deepEqual(opened[0].events, [{ id: 91, name: "old" }]);
      assert.equal(opened[0].closeCount, 0);
      assert.equal(opened[1].closeCount, 1);
    }],
    ["publish失敗は旧データへrollbackし借用liveをcloseしない", async () => {
      const { api, opened } = createHarness({ publishError: new Error("publish failed") });
      const live = await api.getDatabase();
      opened[0].events = [{ id: 91, name: "old" }];
      opened[0].settings.set("circle_master_json", "old-settings");
      opened[0].settings.set("unrelated", "keep-me");
      opened[0].favorites = [{ id: 4, name: "old-favorite", tag: "old-tag" }];
      await assert.rejects(api.importFromZip("file:///fixture.zip"), /publish failed/);
      assert(await api.getDatabase() === live, "live接続のidentityを保持する");
      assert.deepEqual(opened[0].events, [{ id: 91, name: "old" }]);
      assert.equal(opened[0].settings.get("circle_master_json"), "old-settings");
      assert.equal(opened[0].settings.get("unrelated"), "keep-me");
      assert.deepEqual(opened[0].favorites, [{ id: 4, name: "old-favorite", tag: "old-tag" }]);
      assert.equal(opened[0].closeCount, 0);
      assert(opened.filter((entry) => entry.name !== "doujin_shopping.db").every((entry) => entry.closeCount === 1));
    }],
  ];
  let failures = 0;
  for (const [name, check] of checks) {
    try { await check(); console.log(`PASS ${name}`); }
    catch (error) { failures += 1; console.error(`FAIL ${name}`, error); }
  }
  assert.equal(failures, 0, `${failures}件のDB寿命テストが失敗`);
}

void run().catch((error) => { console.error(error); process.exitCode = 1; });
