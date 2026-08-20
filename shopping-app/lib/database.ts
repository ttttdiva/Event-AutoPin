import * as SQLite from "expo-sqlite";
import * as FileSystem from "expo-file-system/legacy";
import * as ImagePicker from "expo-image-picker";
import { unzip, zip as zipDirectory } from "react-native-zip-archive";
import type {
  Event,
  EventMap,
  Circle,
  Item,
  ItemImage,
  ImportData,
  ImportEventMap,
  ImportCircle,
  ImportItemImage,
  CircleMasterData,
  BudgetSummary,
  PurchaseStatusValue,
} from "./types";
import { PURCHASE_STATUS } from "./types";
import {
  __sqlMetricsDevOnly,
  estimateSqlResultBytes,
  recordSqlMetric,
} from "./performance";
import {
  advanceImportPublishPhase,
  assertSqlBindCount,
  buildLegacyBootstrapBookkeeping,
  buildImportPublishPlan,
  buildSharedBundleFingerprint,
  isPathContainedBy,
  isSafeRelativeArchivePath,
  normalizeLookupKey,
  sha256Hex,
  isAssetMappingComplete,
  matchStableIdentityRows,
  shouldRollbackPublishedFiles,
  type ImportPublishPhase,
} from "./database-core";

const DB_NAME = "doujin_shopping.db";
const LATEST_SCHEMA_VERSION = 7;

let db: SQLite.SQLiteDatabase | null = null;
let dbInitPromise: Promise<SQLite.SQLiteDatabase> | null = null;
let itemFtsAvailable = false;
let itemFtsBackfilled = false;
let itemFtsBackfillPromise: Promise<void> | null = null;
const purchaseLookupCache = new Map<string, Set<string>>();
const PURCHASE_LOOKUP_CACHE_LIMIT = 128;
const instrumentedDatabases = new WeakMap<object, SQLite.SQLiteDatabase>();
const rawDatabaseByProxy = new WeakMap<object, SQLite.SQLiteDatabase>();

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function renderRevisionHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

async function measuredGetAll<T>(
  database: SQLite.SQLiteDatabase,
  sql: string,
  ...params: unknown[]
): Promise<T[]> {
  return database.getAllAsync<T>(sql, ...(params as SQLite.SQLiteVariadicBindParams));
}

async function measuredGetFirst<T>(
  database: SQLite.SQLiteDatabase,
  sql: string,
  ...params: unknown[]
): Promise<T | null> {
  return database.getFirstAsync<T>(sql, ...(params as SQLite.SQLiteVariadicBindParams));
}

async function measuredRun(
  database: SQLite.SQLiteDatabase,
  sql: string,
  ...params: unknown[]
): Promise<SQLite.SQLiteRunResult> {
  return database.runAsync(sql, ...(params as SQLite.SQLiteVariadicBindParams));
}

/** DB への直接呼び出しも漏れなく SQL metrics に入れる development-only proxy。 */
export function instrumentDatabase<T extends SQLite.SQLiteDatabase>(database: T): T {
  // Production must preserve object identity and avoid Proxy/Promise/clock overhead.
  if (!__sqlMetricsDevOnly) return database;
  const existing = instrumentedDatabases.get(database as unknown as object);
  if (existing) return existing as T;
  const wrapped = new Proxy(database as T, {
    get(target, property, receiver) {
      if (property === "getAllAsync" || property === "getFirstAsync" || property === "runAsync" || property === "execAsync") {
        const original = Reflect.get(target, property, receiver) as (...args: any[]) => Promise<any>;
        return async (...args: any[]) => {
          const sql = typeof args[0] === "string" ? args[0] : "";
          const started = nowMs();
          let result: any;
          try {
            result = await original.apply(target, args);
            return result;
          } finally {
            const rows = property === "getAllAsync" && Array.isArray(result)
              ? result.length
              : property === "getFirstAsync" && result ? 1 : 0;
            recordSqlMetric(sql, nowMs() - started, rows, estimateSqlResultBytes(result));
          }
        };
      }
      if (property === "withTransactionAsync") {
        const original = Reflect.get(target, property, receiver) as (callback: () => Promise<void>) => Promise<void>;
        // expo-sqlite does not pass a transaction object here. Queries in the
        // callback use this instrumented outer database and remain measured.
        return (callback: () => Promise<void>) => original.call(target, () => callback());
      }
      if (property === "withExclusiveTransactionAsync") {
        const original = Reflect.get(target, property, receiver) as (callback: (txn: SQLite.SQLiteDatabase) => Promise<void>) => Promise<void>;
        return (callback: (txn: SQLite.SQLiteDatabase) => Promise<void>) => original.call(target, (txn) => callback(instrumentDatabase(txn)));
      }
      return Reflect.get(target, property, receiver);
    },
  });
  instrumentedDatabases.set(database as unknown as object, wrapped);
  rawDatabaseByProxy.set(wrapped as unknown as object, database);
  return wrapped;
}

function rawDatabase(database: SQLite.SQLiteDatabase): SQLite.SQLiteDatabase {
  return rawDatabaseByProxy.get(database as unknown as object) ?? database;
}

async function tableColumns(
  database: SQLite.SQLiteDatabase,
  table: string,
): Promise<Set<string>> {
  const rows = await database.getAllAsync<{ name: string }>(
    `PRAGMA table_info(${table})`,
  );
  return new Set(rows.map((row) => row.name));
}

async function addColumnIfMissing(
  database: SQLite.SQLiteDatabase,
  table: string,
  column: string,
  definition: string,
  columnsCache?: Map<string, Set<string>>,
): Promise<void> {
  const columns = columnsCache?.get(table) ?? (await tableColumns(database, table));
  columnsCache?.set(table, columns);
  if (columns.has(column)) return;
  await database.execAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  columns.add(column);
}

/** データベースを開いて初期化 */
export async function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;
  if (!dbInitPromise) {
    dbInitPromise = (async () => {
      const rawDatabase = await SQLite.openDatabaseAsync(DB_NAME);
      const database = instrumentDatabase(rawDatabase);
      await initDatabase(database);
      db = database;
      return database;
    })().finally(() => {
      dbInitPromise = null;
    });
  }
  return dbInitPromise;
}

/** テーブル作成 */
async function initDatabase(database: SQLite.SQLiteDatabase, options?: { recover?: boolean }): Promise<void> {
  await database.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      date TEXT,
      venue TEXT,
      organizer TEXT,
      raw_json TEXT,
      metadata_json TEXT,
      sync_root_json TEXT,
      imported_at TEXT NOT NULL DEFAULT (datetime('now')),
      sync_uid TEXT,
      content_hash TEXT,
      asset_set_hash TEXT
    );

    CREATE TABLE IF NOT EXISTS event_maps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      map_number INTEGER NOT NULL DEFAULT 1,
      raw_json TEXT
    );

    CREATE TABLE IF NOT EXISTS circles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      penname TEXT,
      space TEXT,
      hall TEXT,
      twitter_url TEXT,
      website_url TEXT,
      pixiv_url TEXT,
      description TEXT,
      genres TEXT DEFAULT '[]',
      tags TEXT DEFAULT '[]',
      circle_cut_filename TEXT,
      priority_color INTEGER NOT NULL DEFAULT 5,
      memo TEXT NOT NULL DEFAULT '',
      checked INTEGER NOT NULL DEFAULT 0,
      pin_x REAL,
      pin_y REAL,
      map_number INTEGER,
      absence_status TEXT,
      existing_only_status TEXT,
      catalog_status TEXT,
      raw_json TEXT,
      name_key TEXT NOT NULL DEFAULT '',
      penname_key TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      price REAL,
      type TEXT,
      description TEXT,
      purchase_status_source TEXT,
      raw_json TEXT,
      name_key TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS item_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'unknown',
      raw_json TEXT
    );

    CREATE TABLE IF NOT EXISTS favorite_circles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '',
      tag TEXT NOT NULL DEFAULT '',
      added_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_circles_event ON circles(event_id);
    CREATE INDEX IF NOT EXISTS idx_circles_space ON circles(space);
    CREATE INDEX IF NOT EXISTS idx_items_circle ON items(circle_id);
    CREATE INDEX IF NOT EXISTS idx_item_images_circle ON item_images(circle_id);
    CREATE TABLE IF NOT EXISTS sync_import_staging (
      event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
      sync_uid TEXT NOT NULL,
      previous_event_id INTEGER,
      stage_root TEXT NOT NULL,
      backup_dir TEXT,
      phase TEXT NOT NULL DEFAULT 'staging',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS asset_local_map (
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      logical_path TEXT NOT NULL,
      local_path TEXT NOT NULL,
      algorithm TEXT,
      expected_hash TEXT,
      actual_hash TEXT,
      size INTEGER,
      modified_at REAL,
      PRIMARY KEY (event_id, logical_path, local_path)
    );
    CREATE INDEX IF NOT EXISTS idx_asset_local_map_event ON asset_local_map(event_id);
    CREATE INDEX IF NOT EXISTS idx_sync_import_staging_phase ON sync_import_staging(phase);
    CREATE TABLE IF NOT EXISTS sync_import_cleanup (
      event_id INTEGER PRIMARY KEY,
      stage_root TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sync_import_cleanup_stage ON sync_import_cleanup(stage_root, phase);
    CREATE TABLE IF NOT EXISTS sync_import_shared_staging (
      stage_root TEXT PRIMARY KEY,
      previous_circle_master TEXT,
      previous_favorites_json TEXT NOT NULL DEFAULT '[]',
      cuts_backup TEXT NOT NULL,
      cuts_had_live INTEGER NOT NULL DEFAULT 0,
      cuts_backup_ready INTEGER NOT NULL DEFAULT 0,
      phase TEXT NOT NULL DEFAULT 'intent',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sync_import_shared_phase ON sync_import_shared_staging(phase);
  `);
  await addColumnIfMissing(database, "sync_import_staging", "backup_dir", "TEXT");

  // 旧版は起動のたび ALTER TABLE を試していたため、user_version で一度だけ
  // versioned migration を実行する。DDL と backfill は同一 transaction で行い、
  // 途中失敗時には version を進めない。
  const currentVersionRow = await database.getFirstAsync<{ user_version: number }>(
    "PRAGMA user_version",
  );
  const currentVersion = Number(currentVersionRow?.user_version ?? 0);
  if (currentVersion < LATEST_SCHEMA_VERSION) {
    await database.withTransactionAsync(async () => {
      const cache = new Map<string, Set<string>>();
      // v1: 既存アプリの optional columns を安全に追加。
      if (currentVersion < 1) {
        for (const [table, column, definition] of [
          ["items", "purchase_status", "INTEGER NOT NULL DEFAULT 0"],
          ["items", "sort_order", "INTEGER NOT NULL DEFAULT 0"],
          ["items", "purchase_status_source", "TEXT"],
          ["events", "shopping_started_at", "TEXT"],
          ["events", "shopping_ended_at", "TEXT"],
          ["events", "memo", "TEXT NOT NULL DEFAULT ''"],
          ["events", "completed", "INTEGER NOT NULL DEFAULT 0"],
          ["events", "event_image_filename", "TEXT"],
          ["events", "raw_json", "TEXT"],
          ["events", "metadata_json", "TEXT"],
          ["events", "sync_root_json", "TEXT"],
          ["event_maps", "raw_json", "TEXT"],
          ["circles", "catalog_status", "TEXT"],
          ["circles", "raw_json", "TEXT"],
          ["items", "raw_json", "TEXT"],
          ["item_images", "raw_json", "TEXT"],
        ] as const) {
          await addColumnIfMissing(database, table, column, definition, cache);
        }
      }

      // v2: 正規化キー。既存行も transaction 内で backfill する。
      if (currentVersion < 2) {
        await addColumnIfMissing(database, "circles", "name_key", "TEXT NOT NULL DEFAULT ''", cache);
        await addColumnIfMissing(database, "circles", "penname_key", "TEXT NOT NULL DEFAULT ''", cache);
        await addColumnIfMissing(database, "items", "name_key", "TEXT NOT NULL DEFAULT ''", cache);
        const circles = await database.getAllAsync<{ id: number; name: string; penname: string | null }>(
          "SELECT id, name, penname FROM circles",
        );
        for (const circle of circles) {
          await database.runAsync(
            "UPDATE circles SET name_key = ?, penname_key = ? WHERE id = ?",
            normalizePurchaseLookupKey(circle.name),
            normalizePurchaseLookupKey(circle.penname),
            circle.id,
          );
        }
        const items = await database.getAllAsync<{ id: number; name: string }>(
          "SELECT id, name FROM items",
        );
        for (const item of items) {
          await database.runAsync(
            "UPDATE items SET name_key = ? WHERE id = ?",
            normalizePurchaseLookupKey(item.name),
            item.id,
          );
        }
      }

      // v3: 同期 manifest の stable uid/content hash。NULL は旧 bundle の印。
      if (currentVersion < 3) {
        await addColumnIfMissing(database, "events", "sync_uid", "TEXT", cache);
        await addColumnIfMissing(database, "events", "content_hash", "TEXT", cache);
        await addColumnIfMissing(database, "events", "asset_set_hash", "TEXT", cache);
      }

      // v4: 複合 index は CREATE IF NOT EXISTS なので再実行安全。
      if (currentVersion < 4) {
        await database.execAsync(`
          CREATE INDEX IF NOT EXISTS idx_circles_event_checked ON circles(event_id, checked);
          CREATE INDEX IF NOT EXISTS idx_circles_event_space ON circles(event_id, space);
          CREATE INDEX IF NOT EXISTS idx_circles_name_penname ON circles(name_key, penname_key);
          CREATE INDEX IF NOT EXISTS idx_circles_name_key ON circles(name_key);
          CREATE INDEX IF NOT EXISTS idx_circles_penname_key ON circles(penname_key);
          CREATE INDEX IF NOT EXISTS idx_items_circle_purchase ON items(circle_id, purchase_status);
          CREATE INDEX IF NOT EXISTS idx_items_name_purchase ON items(name_key, purchase_status);
          CREATE INDEX IF NOT EXISTS idx_event_maps_event_number ON event_maps(event_id, map_number);
          CREATE INDEX IF NOT EXISTS idx_favorite_circles_name ON favorite_circles(name);
          CREATE INDEX IF NOT EXISTS idx_favorite_circles_tag ON favorite_circles(tag);
          -- 同一 stable UID は live event で一意。staging 行は reserved UID を
          -- 使い、publish transaction 内で実 UIDへ戻すため競合しない。
          UPDATE events SET sync_uid = NULL
           WHERE sync_uid IS NOT NULL AND id NOT IN (
             SELECT MIN(id) FROM events WHERE sync_uid IS NOT NULL GROUP BY sync_uid
           );
          CREATE UNIQUE INDEX IF NOT EXISTS idx_events_sync_uid_unique
            ON events(sync_uid) WHERE sync_uid IS NOT NULL;
        `);
      }

      // v5 は将来の projection 拡張に備えた marker。データを変更しない。
      // v6 は FTS の作成を別関数で行うため、ここでは version のみ進める。
      // v7: preserve the complete imported root document for unknown fields.
      if (currentVersion < 7) {
        await addColumnIfMissing(database, "events", "sync_root_json", "TEXT", cache);
      }
      await database.execAsync(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION}`);
    });
  }
  // v4 を既に適用済みの DB にも stable UID unique 制約を遡及適用する。
  // 旧 duplicate は最古の live 行を残し、他は legacy 扱い (NULL) に戻す。
  await database.runAsync(
      `UPDATE events SET sync_uid = NULL
       WHERE sync_uid IS NOT NULL AND id NOT IN (
         SELECT MIN(id) FROM events WHERE sync_uid IS NOT NULL GROUP BY sync_uid
       )`,
    );
  await database.execAsync(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_events_sync_uid_unique ON events(sync_uid) WHERE sync_uid IS NOT NULL",
    );
  await database.execAsync(
    "CREATE INDEX IF NOT EXISTS idx_circles_name_key ON circles(name_key); CREATE INDEX IF NOT EXISTS idx_circles_penname_key ON circles(penname_key);",
  );

  // FTS5 は端末 SQLite build により無い場合があるため、起動時に一度だけ能力を
  // 検出する。利用できない場合は searchItemsByEvent の indexed LIKE に fallback。
  try {
    await database.execAsync(
      "CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(name, description, item_id UNINDEXED)",
    );
    itemFtsAvailable = true;
    itemFtsBackfilled = false;
  } catch {
    itemFtsAvailable = false;
    itemFtsBackfilled = false;
  }
  // 前回プロセスが staging 中に終了しても、次回起動時に新規行/画像だけを
  // rollback し、旧 live event と画像を保持する。
  if (options?.recover !== false) await recoverImportStages(database);
}

// --- Event CRUD ---

/** イベント一覧専用の軽量 projection。raw_json/metadata_json は返さない。 */
export interface EventSummary {
  id: number;
  name: string;
  url: string;
  date: string | null;
  venue: string | null;
  organizer: string | null;
  memo: string;
  completed: boolean;
  importedAt: string;
  shoppingStartedAt: string | null;
  shoppingEndedAt: string | null;
  eventImageFilename: string | null;
  totalCircles: number;
  boughtCircles: number;
  couldntBuyCircles: number;
  skippedCircles: number;
  remainingCircles: number;
  totalItems: number;
  boughtItems: number;
  remainingItems: number;
}

export async function getEventIds(): Promise<number[]> {
  const txDb = await getDatabase();
  const rows = await measuredGetAll<{ id: number }>(
    txDb,
    "SELECT id FROM events ORDER BY imported_at DESC",
  );
  return rows.map((row) => Number(row.id));
}

/** イベント数に依存しない 1 SQL の一覧取得。 */
export async function getEventSummaries(eventId?: number): Promise<EventSummary[]> {
  const txDb = await getDatabase();
  const circleScope = eventId == null ? "" : " WHERE event_id = ?";
  const itemScope = eventId == null ? "" : " WHERE c.event_id = ?";
  const eventScope = eventId == null ? "" : " WHERE e.id = ?";
  const params = eventId == null ? [] : [eventId, eventId, eventId];
  const rows = await measuredGetAll<any>(
    txDb,
    `WITH circle_stats AS (
      SELECT event_id,
        COUNT(*) AS total_circles,
        SUM(CASE WHEN checked = 1 THEN 1 ELSE 0 END) AS bought_circles,
        SUM(CASE WHEN checked = 2 THEN 1 ELSE 0 END) AS couldnt_buy_circles,
        SUM(CASE WHEN checked = 3 THEN 1 ELSE 0 END) AS skipped_circles
      FROM circles${circleScope} GROUP BY event_id
    ), item_stats AS (
      SELECT c.event_id,
        COUNT(i.id) AS total_items,
        SUM(CASE WHEN i.purchase_status = 1 THEN 1 ELSE 0 END) AS bought_items
      FROM circles c LEFT JOIN items i ON i.circle_id = c.id${itemScope}
      GROUP BY c.event_id
    )
    SELECT e.id, e.name, e.url, e.date, e.venue, e.organizer, e.memo,
      e.completed, e.imported_at, e.shopping_started_at, e.shopping_ended_at,
      e.event_image_filename,
      COALESCE(cs.total_circles, 0) AS total_circles,
      COALESCE(cs.bought_circles, 0) AS bought_circles,
      COALESCE(cs.couldnt_buy_circles, 0) AS couldnt_buy_circles,
      COALESCE(cs.skipped_circles, 0) AS skipped_circles,
      COALESCE(cs.total_circles, 0) - COALESCE(cs.bought_circles, 0)
        - COALESCE(cs.couldnt_buy_circles, 0) - COALESCE(cs.skipped_circles, 0) AS remaining_circles,
      COALESCE(isx.total_items, 0) AS total_items,
      COALESCE(isx.bought_items, 0) AS bought_items,
      COALESCE(isx.total_items, 0) - COALESCE(isx.bought_items, 0) AS remaining_items
    FROM events e
    LEFT JOIN circle_stats cs ON cs.event_id = e.id
    LEFT JOIN item_stats isx ON isx.event_id = e.id${eventScope}
    ORDER BY e.imported_at DESC, e.id DESC`,
    ...params,
  );
  return rows.map((row) => ({
    id: Number(row.id),
    name: String(row.name ?? ""),
    url: String(row.url ?? ""),
    date: row.date ?? null,
    venue: row.venue ?? null,
    organizer: row.organizer ?? null,
    memo: row.memo ?? "",
    completed: !!row.completed,
    importedAt: row.imported_at,
    shoppingStartedAt: row.shopping_started_at ?? null,
    shoppingEndedAt: row.shopping_ended_at ?? null,
    eventImageFilename: row.event_image_filename ?? null,
    totalCircles: Number(row.total_circles ?? 0),
    boughtCircles: Number(row.bought_circles ?? 0),
    couldntBuyCircles: Number(row.couldnt_buy_circles ?? 0),
    skippedCircles: Number(row.skipped_circles ?? 0),
    remainingCircles: Number(row.remaining_circles ?? 0),
    totalItems: Number(row.total_items ?? 0),
    boughtItems: Number(row.bought_items ?? 0),
    remainingItems: Number(row.remaining_items ?? 0),
  }));
}

export async function getEventSummary(eventId: number): Promise<EventSummary | null> {
  const summaries = await getEventSummaries(eventId);
  return summaries.find((summary) => summary.id === eventId) ?? null;
}

export async function getAllEvents(): Promise<Event[]> {
  const txDb = await getDatabase();
  const rows = await measuredGetAll<any>(
    txDb,
    `SELECT id, name, url, date, venue, organizer, memo, completed,
      imported_at, shopping_started_at, shopping_ended_at, event_image_filename
     FROM events ORDER BY imported_at DESC`,
  );
  return rows.map(mapEvent);
}

export async function getEvent(id: number): Promise<Event | null> {
  const txDb = await getDatabase();
  const row = await measuredGetFirst<any>(
    txDb,
    `SELECT id, name, url, date, venue, organizer, memo, completed,
      imported_at, shopping_started_at, shopping_ended_at, event_image_filename
     FROM events WHERE id = ?`,
    id,
  );
  return row ? mapEvent(row) : null;
}

/** イベントを手動作成 */
export async function createEvent(
  name: string,
  date?: string | null,
  venue?: string | null,
  organizer?: string | null,
  url?: string | null,
  memo?: string | null,
): Promise<number> {
  const txDb = await getDatabase();
  const result = await txDb.runAsync(
    `INSERT INTO events (name, url, date, venue, organizer, memo) VALUES (?, ?, ?, ?, ?, ?)`,
    name,
    url ?? "",
    date ?? null,
    venue ?? null,
    organizer ?? null,
    memo ?? "",
  );
  return result.lastInsertRowId;
}

/** イベント情報を更新 */
export async function updateEvent(
  id: number,
  name: string,
  date?: string | null,
  venue?: string | null,
  organizer?: string | null,
  url?: string | null,
): Promise<void> {
  const txDb = await getDatabase();
  await txDb.runAsync(
    `UPDATE events SET name = ?, url = ?, date = ?, venue = ?, organizer = ? WHERE id = ?`,
    name,
    url ?? "",
    date ?? null,
    venue ?? null,
    organizer ?? null,
    id,
  );
}

/** イベント画像パスを更新 */
export async function updateEventImage(
  id: number,
  imagePath: string | null,
): Promise<void> {
  const txDb = await getDatabase();
  await txDb.runAsync(
    `UPDATE events SET event_image_filename = ? WHERE id = ?`,
    imagePath,
    id,
  );
}

/** イメージピッカーでイベント画像を選択・保存 */
export async function pickAndSaveEventImage(
  eventId: number,
): Promise<string | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    quality: 0.8,
    allowsEditing: true,
    aspect: [1, 1],
  });
  if (result.canceled || !result.assets?.[0]) return null;

  const asset = result.assets[0];
  const ext = asset.uri.split(".").pop() ?? "jpg";
  const imgDir = await ensureImagesDir(eventId);
  const destPath = `${imgDir}event_image_${Date.now()}.${ext}`;
  const existingEvent = await getEvent(eventId);
  const stagePath = `${imgDir}.staging_event_${Date.now()}.${ext}`;
  try {
    await FileSystem.copyAsync({ from: asset.uri, to: stagePath });
    await FileSystem.moveAsync({ from: stagePath, to: destPath });
    await updateEventImage(eventId, destPath);
  } catch (error) {
    await FileSystem.deleteAsync(stagePath, { idempotent: true }).catch(() => undefined);
    await FileSystem.deleteAsync(destPath, { idempotent: true }).catch(() => undefined);
    throw error;
  }
  if (existingEvent?.eventImageFilename && existingEvent.eventImageFilename !== destPath) {
    await deleteFileIfExists(existingEvent.eventImageFilename);
  }
  return destPath;
}

/** イベント画像を削除 */
export async function removeEventImage(eventId: number): Promise<void> {
  const event = await getEvent(eventId);
  await updateEventImage(eventId, null);
  if (event?.eventImageFilename) await deleteFileIfExists(event.eventImageFilename);
}

function getPickedImageExtension(asset: ImagePicker.ImagePickerAsset): string {
  const rawName = asset.fileName ?? asset.uri.split("/").pop() ?? "";
  const rawExt = rawName.split("?")[0].split(".").pop()?.toLowerCase();
  if (!rawExt || rawExt.length > 5 || rawExt === rawName.toLowerCase()) {
    return "jpg";
  }
  return rawExt === "jpeg" ? "jpg" : rawExt;
}

async function deleteFileIfExists(path: string | null | undefined): Promise<void> {
  if (!path) return;
  const info = await FileSystem.getInfoAsync(path);
  if (info.exists) {
    await FileSystem.deleteAsync(path, { idempotent: true });
  }
}

/** 画像ピッカーでサークルカットを選択して保存 */
export async function pickAndSaveCircleCut(
  circleId: number,
): Promise<string | null> {
  const circle = await getCircle(circleId);
  if (!circle) return null;

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    quality: 0.85,
    allowsEditing: false,
  });
  if (result.canceled || !result.assets?.[0]) return null;

  const asset = result.assets[0];
  const ext = getPickedImageExtension(asset);
  const imgDir = await ensureImagesDir(circle.eventId);
  const cutsDir = `${imgDir}cuts/`;
  await ensureDirectory(cutsDir);
  const destPath = `${cutsDir}manual_cut_${circleId}_${Date.now()}.${ext}`;

  const stagePath = `${cutsDir}.staging_cut_${circleId}_${Date.now()}.${ext}`;
  const previousCircleMaster = await getSetting("circle_master_json");
  await FileSystem.copyAsync({ from: asset.uri, to: stagePath });
  try {
    const txDb = await getDatabase();
    await FileSystem.moveAsync({ from: stagePath, to: destPath });
    await txDb.runAsync("UPDATE circles SET circle_cut_filename = ? WHERE id = ?", destPath, circleId);
    try {
      await registerDefaultCutFromImage(circle.name, circle.penname, destPath, {
        overwriteExisting: true,
      });
    } catch (registerError) {
      await txDb.runAsync("UPDATE circles SET circle_cut_filename = ? WHERE id = ?", circle.circleCutFilename, circleId);
      if (previousCircleMaster == null) await txDb.runAsync("DELETE FROM app_settings WHERE key = ?", "circle_master_json");
      else await setSetting("circle_master_json", previousCircleMaster);
      await deleteFileIfExists(destPath);
      throw registerError;
    }
  } catch (error) {
    await FileSystem.deleteAsync(stagePath, { idempotent: true }).catch(() => undefined);
    await FileSystem.deleteAsync(destPath, { idempotent: true }).catch(() => undefined);
    throw error;
  }
  await deleteFileIfExists(circle.circleCutFilename);
  return destPath;
}

/** 画像ピッカーでおしながき画像を差し替える */
export async function pickAndReplaceItemImage(
  imageId: number,
): Promise<ItemImage | null> {
  const txDb = await getDatabase();
  const row = await txDb.getFirstAsync<any>(
    `SELECT ii.id, ii.circle_id, ii.filename, ii.source, c.event_id
     FROM item_images ii
     JOIN circles c ON c.id = ii.circle_id
     WHERE ii.id = ?`,
    imageId,
  );
  if (!row) return null;

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    quality: 0.9,
    allowsEditing: false,
  });
  if (result.canceled || !result.assets?.[0]) return null;

  const asset = result.assets[0];
  const ext = getPickedImageExtension(asset);
  const imgDir = await ensureImagesDir(row.event_id);
  const itemsDir = `${imgDir}items/`;
  await ensureDirectory(itemsDir);
  const destPath = `${itemsDir}manual_catalog_${row.circle_id}_${Date.now()}.${ext}`;

  const stagePath = `${itemsDir}.staging_item_${imageId}_${Date.now()}.${ext}`;
  try {
    await FileSystem.copyAsync({ from: asset.uri, to: stagePath });
    await FileSystem.moveAsync({ from: stagePath, to: destPath });
    await txDb.runAsync("UPDATE item_images SET filename = ?, source = ? WHERE id = ?", destPath, "manual", imageId);
  } catch (error) {
    await FileSystem.deleteAsync(stagePath, { idempotent: true }).catch(() => undefined);
    await FileSystem.deleteAsync(destPath, { idempotent: true }).catch(() => undefined);
    throw error;
  }
  if (row.filename !== destPath) await deleteFileIfExists(row.filename);

  return mapItemImage({ ...row, filename: destPath, source: "manual" });
}

export async function pickAndAddItemImage(
  circleId: number,
): Promise<ItemImage | null> {
  const circle = await getCircle(circleId);
  if (!circle) return null;

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    quality: 0.9,
    allowsEditing: false,
  });
  if (result.canceled || !result.assets?.[0]) return null;

  const asset = result.assets[0];
  const ext = getPickedImageExtension(asset);
  const imgDir = await ensureImagesDir(circle.eventId);
  const itemsDir = `${imgDir}items/`;
  await ensureDirectory(itemsDir);
  const destPath = `${itemsDir}manual_catalog_${circleId}_${Date.now()}.${ext}`;
  const stagePath = `${itemsDir}.staging_add_${circleId}_${Date.now()}.${ext}`;
  await FileSystem.copyAsync({ from: asset.uri, to: stagePath });
  let insertedId: number | null = null;
  const previousCut = circle.circleCutFilename;
  const previousCircleMaster = await getSetting("circle_master_json");
  try {
    await FileSystem.moveAsync({ from: stagePath, to: destPath });
    const txDb = await getDatabase();
    let shouldRegisterDefault = false;
    await txDb.withExclusiveTransactionAsync(async (txn) => {
      const resultRow = await txn.runAsync(
        "INSERT INTO item_images (circle_id, filename, source) VALUES (?, ?, ?)",
        circleId,
        destPath,
        "manual",
      );
      insertedId = resultRow.lastInsertRowId;
      shouldRegisterDefault = !previousCut;
      if (shouldRegisterDefault) {
        await txn.runAsync(
          "UPDATE circles SET circle_cut_filename = ? WHERE id = ?",
          destPath,
          circleId,
        );
      }
    });
    if (shouldRegisterDefault) {
      try {
        await registerDefaultCutFromImage(circle.name, circle.penname, destPath);
      } catch (registerError) {
        // registerDefaultCutFromImage may fail after copying its own file.  A
        // second transaction restores both DB references before deleting the
        // newly staged image; the old cut remains untouched.
        await txDb.withExclusiveTransactionAsync(async (txn) => {
          if (insertedId != null) await txn.runAsync("DELETE FROM item_images WHERE id = ?", insertedId);
          await txn.runAsync("UPDATE circles SET circle_cut_filename = ? WHERE id = ?", previousCut, circleId);
        });
        if (previousCircleMaster == null) {
          await txDb.runAsync("DELETE FROM app_settings WHERE key = ?", "circle_master_json");
        } else {
          await setSetting("circle_master_json", previousCircleMaster);
        }
        await deleteFileIfExists(destPath);
        throw registerError;
      }
    }

    if (insertedId == null) throw new Error("item image insert id がありません");
    return {
      id: insertedId,
      circleId,
      filename: destPath,
      source: "manual",
      rawJson: null,
    };
  } catch (error) {
    await FileSystem.deleteAsync(stagePath, { idempotent: true }).catch(() => undefined);
    await FileSystem.deleteAsync(destPath, { idempotent: true }).catch(() => undefined);
    throw error;
  }
}

export async function deleteEvent(id: number): Promise<void> {
  const txDb = await getDatabase();
  await txDb.runAsync("DELETE FROM events WHERE id = ?", id);
}

// --- Circle CRUD ---

export interface CircleListRow {
  id: number;
  eventId: number;
  name: string;
  penname: string | null;
  space: string | null;
  hall: string | null;
  twitterUrl: string | null;
  websiteUrl: string | null;
  pixivUrl: string | null;
  description: string | null;
  genres: string;
  tags: string;
  circleCutFilename: string | null;
  priorityColor: number;
  memo: string;
  hasCatalogPost: boolean;
  purchaseStatus: PurchaseStatusValue;
  pinX: number | null;
  pinY: number | null;
  mapNumber: number | null;
  absenceStatus: string | null;
  existingOnlyStatus: string | null;
  catalogStatus: string | null;
  renderRevision: number;
}

async function getEventForExport(id: number): Promise<Event | null> {
  const txDb = await getDatabase();
  const row = await measuredGetFirst<any>(txDb, "SELECT * FROM events WHERE id = ?", id);
  return row ? mapEvent(row) : null;
}

/** 一覧用明示 projection。raw_json は export/sync API からのみ取得する。 */
export async function getCircleListRows(eventId: number): Promise<CircleListRow[]> {
  const txDb = await getDatabase();
  const rows = await measuredGetAll<any>(
    txDb,
    `SELECT c.id, c.event_id, c.name, c.penname, c.space, c.hall,
      c.twitter_url, c.website_url, c.pixiv_url, c.description,
      c.genres, c.tags, c.circle_cut_filename, c.priority_color, c.memo,
      c.checked, c.pin_x, c.pin_y, c.map_number, c.absence_status,
      c.existing_only_status, c.catalog_status,
      CASE
        WHEN c.catalog_status = 'needs_recheck' THEN 0
        WHEN c.catalog_status IS NOT NULL AND c.catalog_status != '' THEN 1
        WHEN EXISTS (SELECT 1 FROM item_images ii WHERE ii.circle_id = c.id)
          OR EXISTS (SELECT 1 FROM items i WHERE i.circle_id = c.id)
          OR (c.memo LIKE '%/status/%' AND (c.memo LIKE '%x.com/%' OR c.memo LIKE '%twitter.com/%'))
        THEN 1 ELSE 0 END AS has_catalog_post
      FROM circles c WHERE c.event_id = ? ORDER BY c.space ASC, c.name ASC`,
    eventId,
  );
  return rows.map((row) => ({
    id: Number(row.id),
    eventId: Number(row.event_id),
    name: String(row.name ?? ""),
    penname: row.penname ?? null,
    space: row.space ?? null,
    hall: row.hall ?? null,
    twitterUrl: row.twitter_url ?? null,
    websiteUrl: row.website_url ?? null,
    pixivUrl: row.pixiv_url ?? null,
    description: row.description ?? null,
    genres: row.genres ?? "[]",
    tags: row.tags ?? "[]",
    circleCutFilename: row.circle_cut_filename ?? null,
    priorityColor: Number(row.priority_color ?? 5),
    memo: row.memo ?? "",
    hasCatalogPost: !!row.has_catalog_post,
    purchaseStatus: Number(row.checked ?? 0) as PurchaseStatusValue,
    pinX: row.pin_x ?? null,
    pinY: row.pin_y ?? null,
    mapNumber: row.map_number ?? null,
    absenceStatus: row.absence_status ?? null,
    existingOnlyStatus: row.existing_only_status ?? null,
    catalogStatus: row.catalog_status ?? null,
    // UI VM の comparator 用。表示・フィルター・アクションに関わる全フィールドを
    // revisionへ含め、編集後にmemo行が古いまま残らないようにする。
    renderRevision: renderRevisionHash([
      row.id, row.event_id, row.name, row.penname, row.space, row.hall,
      row.twitter_url, row.website_url, row.pixiv_url, row.description,
      row.genres, row.tags, row.circle_cut_filename, row.priority_color,
      row.memo, row.has_catalog_post, row.checked, row.pin_x, row.pin_y,
      row.map_number, row.absence_status, row.existing_only_status,
      row.catalog_status,
    ].map((value) => String(value ?? "")).join("\u0001")),
  }));
}

export async function getCirclesByEvent(eventId: number): Promise<Circle[]> {
  const txDb = await getDatabase();
  const rows = await measuredGetAll<any>(
    txDb,
    `SELECT
      c.id, c.event_id, c.name, c.penname, c.space, c.hall,
      c.twitter_url, c.website_url, c.pixiv_url, c.description,
      c.genres, c.tags, c.circle_cut_filename, c.priority_color, c.memo,
      c.checked, c.pin_x, c.pin_y, c.map_number, c.absence_status,
      c.existing_only_status, c.catalog_status,
      CASE
        WHEN c.catalog_status = 'needs_recheck' THEN 0
        WHEN c.catalog_status IS NOT NULL AND c.catalog_status != '' THEN 1
        WHEN EXISTS (SELECT 1 FROM item_images ii WHERE ii.circle_id = c.id)
          OR EXISTS (SELECT 1 FROM items i WHERE i.circle_id = c.id)
          OR (
            c.memo LIKE '%/status/%'
            AND (c.memo LIKE '%x.com/%' OR c.memo LIKE '%twitter.com/%')
          )
        THEN 1
        ELSE 0
      END AS has_catalog_post
    FROM circles c
    WHERE c.event_id = ?
    ORDER BY c.space ASC, c.name ASC`,
    eventId,
  );
  return rows.map(mapCircle);
}

/** export/sync 専用。互換性保持のため raw_json を含める。 */
async function getCirclesByEventForExport(eventId: number): Promise<Circle[]> {
  const txDb = await getDatabase();
  const rows = await measuredGetAll<any>(
    txDb,
    `SELECT c.*, CASE
      WHEN c.catalog_status = 'needs_recheck' THEN 0
      WHEN c.catalog_status IS NOT NULL AND c.catalog_status != '' THEN 1
      WHEN EXISTS (SELECT 1 FROM item_images ii WHERE ii.circle_id = c.id)
        OR EXISTS (SELECT 1 FROM items i WHERE i.circle_id = c.id)
        OR (c.memo LIKE '%/status/%' AND (c.memo LIKE '%x.com/%' OR c.memo LIKE '%twitter.com/%'))
      THEN 1 ELSE 0 END AS has_catalog_post
     FROM circles c WHERE c.event_id = ? ORDER BY c.space ASC, c.name ASC`,
    eventId,
  );
  return rows.map(mapCircle);
}

export async function getCircle(id: number): Promise<Circle | null> {
  const txDb = await getDatabase();
  const row = await measuredGetFirst<any>(
    txDb,
    `SELECT id, event_id, name, penname, space, hall,
      twitter_url, website_url, pixiv_url, description, genres, tags,
      circle_cut_filename, priority_color, memo, checked, pin_x, pin_y,
      map_number, absence_status, existing_only_status, catalog_status
     FROM circles WHERE id = ?`,
    id,
  );
  return row ? mapCircle(row) : null;
}

/** サークルを手動追加 */
export async function addCircle(
  eventId: number,
  name: string,
  penname?: string | null,
  space?: string | null,
  hall?: string | null,
  priorityColor?: number,
  memo?: string | null,
  twitterUrl?: string | null,
  websiteUrl?: string | null,
): Promise<Circle> {
  const txDb = await getDatabase();
  const result = await txDb.runAsync(
    `INSERT INTO circles (
      event_id, name, penname, space, hall, priority_color, memo, twitter_url, website_url,
      name_key, penname_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    eventId,
    name,
    penname ?? null,
    space ?? null,
    hall ?? null,
    priorityColor ?? 5,
    memo ?? "",
    twitterUrl ?? null,
    websiteUrl ?? null,
    normalizePurchaseLookupKey(name),
    normalizePurchaseLookupKey(penname),
  );
  return mapCircle({
    id: result.lastInsertRowId,
    event_id: eventId,
    name,
    penname: penname ?? null,
    space: space ?? null,
    hall: hall ?? null,
    twitter_url: twitterUrl ?? null,
    website_url: websiteUrl ?? null,
    pixiv_url: null,
    description: null,
    genres: "[]",
    tags: "[]",
    circle_cut_filename: null,
    priority_color: priorityColor ?? 5,
    memo: memo ?? "",
    checked: 0,
    pin_x: null,
    pin_y: null,
    map_number: null,
    absence_status: null,
    existing_only_status: null,
    catalog_status: null,
    raw_json: null,
    has_catalog_post: false,
  });
}

/** サークル情報を更新 */
export async function updateCircle(
  id: number,
  name: string,
  penname?: string | null,
  space?: string | null,
  hall?: string | null,
  priorityColor?: number,
  memo?: string | null,
  twitterUrl?: string | null,
  websiteUrl?: string | null,
  pixivUrl?: string | null,
  description?: string | null,
  absenceStatus?: string | null,
  existingOnlyStatus?: string | null,
): Promise<void> {
  const txDb = await getDatabase();
  await txDb.runAsync(
    `UPDATE circles SET
      name = ?, penname = ?, space = ?, hall = ?,
      priority_color = ?, memo = ?,
      twitter_url = ?, website_url = ?, pixiv_url = ?,
      description = ?, absence_status = ?, existing_only_status = ?,
      name_key = ?, penname_key = ?
     WHERE id = ?`,
    name,
    penname ?? null,
    space ?? null,
    hall ?? null,
    priorityColor ?? 5,
    memo ?? "",
    twitterUrl ?? null,
    websiteUrl ?? null,
    pixivUrl ?? null,
    description ?? null,
    absenceStatus ?? null,
    existingOnlyStatus ?? null,
    normalizePurchaseLookupKey(name),
    normalizePurchaseLookupKey(penname),
    id,
  );
  invalidatePurchaseLookupCache();
}

/** サークルを削除 */
export async function deleteCircle(id: number): Promise<void> {
  const txDb = await getDatabase();
  await deleteItemSearchIndexForCircle(id, txDb);
  await txDb.runAsync("DELETE FROM circles WHERE id = ?", id);
  invalidatePurchaseLookupCache();
}

/** 購入状態を更新（0=未購入, 1=買えた, 2=買えなかった） */
export async function updateCirclePurchaseStatus(
  id: number,
  status: PurchaseStatusValue,
): Promise<void> {
  const txDb = await getDatabase();
  await txDb.runAsync(
    "UPDATE circles SET checked = ? WHERE id = ?",
    status,
    id,
  );
  invalidatePurchaseLookupCache();
}

// Keep only untouched or circle-linked items in sync with the circle status.
async function updateLinkedItemsFromCircleStatus(
  txDb: SQLite.SQLiteDatabase,
  circleId: number,
  status: PurchaseStatusValue,
): Promise<void> {
  if (status === PURCHASE_STATUS.NOT_YET) return;

  await txDb.runAsync(
    `UPDATE items
     SET purchase_status = ?, purchase_status_source = 'circle'
     WHERE circle_id = ?
       AND (purchase_status = ? OR purchase_status_source = 'circle')`,
    status,
    circleId,
    PURCHASE_STATUS.NOT_YET,
  );
  invalidatePurchaseLookupCache();
}

export async function updateItemsFromCirclePurchaseStatus(
  circleId: number,
  status: PurchaseStatusValue,
): Promise<void> {
  const txDb = await getDatabase();
  await updateLinkedItemsFromCircleStatus(txDb, circleId, status);
}

/** 購入状態を次の状態にトグル（0→1→2→3→0） */
export async function cycleCirclePurchaseStatus(
  id: number,
): Promise<PurchaseStatusValue> {
  const txDb = await getDatabase();
  const row = await txDb.getFirstAsync<any>(
    "SELECT checked FROM circles WHERE id = ?",
    id,
  );
  const current = (row?.checked ?? 0) as PurchaseStatusValue;
  const next: PurchaseStatusValue =
    current === PURCHASE_STATUS.NOT_YET
      ? PURCHASE_STATUS.BOUGHT
      : current === PURCHASE_STATUS.BOUGHT
        ? PURCHASE_STATUS.COULDNT_BUY
        : current === PURCHASE_STATUS.COULDNT_BUY
          ? PURCHASE_STATUS.SKIPPED
          : PURCHASE_STATUS.NOT_YET;
  await txDb.runAsync(
    "UPDATE circles SET checked = ? WHERE id = ?",
    next,
    id,
  );
  await updateLinkedItemsFromCircleStatus(txDb, id, next);
  invalidatePurchaseLookupCache();
  return next;
}

export async function updateCircleMemo(
  id: number,
  memo: string,
): Promise<void> {
  const txDb = await getDatabase();
  await txDb.runAsync("UPDATE circles SET memo = ? WHERE id = ?", memo, id);
}

const STATUS_URL_RE =
  /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^\s]+\/status(?:es)?\/\d+[^\s]*/gi;

function removeStatusUrlsFromMemo(memo: string): string {
  return memo
    .split(/\r?\n/)
    .map((line) => line.replace(STATUS_URL_RE, "").trim())
    .filter(Boolean)
    .join("\n");
}

export async function markCircleCatalogNeedsRecheck(
  id: number,
): Promise<{ memo: string; catalogStatus: string }> {
  const txDb = await getDatabase();
  const row = await txDb.getFirstAsync<{ memo: string | null }>(
    "SELECT memo FROM circles WHERE id = ?",
    id,
  );
  const memo = removeStatusUrlsFromMemo(row?.memo ?? "");
  await txDb.runAsync(
    "UPDATE circles SET memo = ?, catalog_status = ? WHERE id = ?",
    memo,
    "needs_recheck",
    id,
  );
  return { memo, catalogStatus: "needs_recheck" };
}

export async function updateEventMemo(id: number, memo: string): Promise<void> {
  const txDb = await getDatabase();
  await txDb.runAsync("UPDATE events SET memo = ? WHERE id = ?", memo, id);
}

export async function toggleEventCompleted(id: number): Promise<boolean> {
  const txDb = await getDatabase();
  const row = await txDb.getFirstAsync<any>(
    "SELECT completed FROM events WHERE id = ?",
    id,
  );
  const next = row?.completed ? 0 : 1;
  await txDb.runAsync(
    "UPDATE events SET completed = ? WHERE id = ?",
    next,
    id,
  );
  return !!next;
}

export async function updateCirclePriority(
  id: number,
  priorityColor: number,
): Promise<void> {
  const txDb = await getDatabase();
  await txDb.runAsync(
    "UPDATE circles SET priority_color = ? WHERE id = ?",
    priorityColor,
    id,
  );
}

/** ジャンルを更新 */
export async function updateCircleGenres(
  id: number,
  genres: string[],
): Promise<void> {
  const txDb = await getDatabase();
  await txDb.runAsync(
    "UPDATE circles SET genres = ? WHERE id = ?",
    JSON.stringify(genres),
    id,
  );
}

/** ピン座標を更新 */
export async function updateCirclePin(
  id: number,
  pinX: number | null,
  pinY: number | null,
  mapNumber: number | null,
): Promise<void> {
  const txDb = await getDatabase();
  await txDb.runAsync(
    "UPDATE circles SET pin_x = ?, pin_y = ?, map_number = ? WHERE id = ?",
    pinX,
    pinY,
    mapNumber,
    id,
  );
}

// --- Item / ItemImage ---

export interface ItemDetailRow {
  id: number;
  circleId: number;
  name: string;
  price: number | null;
  type: string | null;
  description: string | null;
  purchaseStatusSource: "circle" | "manual" | null;
  purchaseStatus: PurchaseStatusValue;
  sortOrder: number;
}

export async function getItemDetailRows(circleId: number): Promise<ItemDetailRow[]> {
  const txDb = await getDatabase();
  const rows = await measuredGetAll<any>(
    txDb,
    `SELECT id, circle_id, name, price, type, description,
      purchase_status_source, purchase_status, sort_order
     FROM items WHERE circle_id = ? ORDER BY sort_order ASC, id ASC`,
    circleId,
  );
  return rows.map((row) => ({
    id: Number(row.id),
    circleId: Number(row.circle_id),
    name: String(row.name ?? ""),
    price: row.price == null ? null : Number(row.price),
    type: row.type ?? null,
    description: row.description ?? null,
    purchaseStatusSource: row.purchase_status_source ?? null,
    purchaseStatus: Number(row.purchase_status ?? 0) as PurchaseStatusValue,
    sortOrder: Number(row.sort_order ?? 0),
  }));
}

export async function getItemsByCircle(circleId: number): Promise<Item[]> {
  const txDb = await getDatabase();
  const rows = await measuredGetAll<any>(
    txDb,
    `SELECT id, circle_id, name, price, type, description,
      purchase_status_source, purchase_status, sort_order
     FROM items WHERE circle_id = ? ORDER BY sort_order ASC, id ASC`,
    circleId,
  );
  return rows.map(mapItem);
}

async function getItemsByCircleForExport(circleId: number): Promise<Item[]> {
  const txDb = await getDatabase();
  const rows = await measuredGetAll<any>(
    txDb,
    "SELECT * FROM items WHERE circle_id = ? ORDER BY sort_order ASC, id ASC",
    circleId,
  );
  return rows.map(mapItem);
}

export async function getItemImagesByCircle(
  circleId: number,
): Promise<ItemImage[]> {
  const txDb = await getDatabase();
  const rows = await measuredGetAll<any>(
    txDb,
    "SELECT id, circle_id, filename, source FROM item_images WHERE circle_id = ?",
    circleId,
  );
  return rows.map(mapItemImage);
}

async function getItemImagesByCircleForExport(circleId: number): Promise<ItemImage[]> {
  const txDb = await getDatabase();
  const rows = await measuredGetAll<any>(
    txDb,
    "SELECT * FROM item_images WHERE circle_id = ?",
    circleId,
  );
  return rows.map(mapItemImage);
}

export async function addItem(
  circleId: number,
  name: string,
  price: number | null,
  type: string | null,
  description: string | null,
): Promise<Item> {
  const txDb = await getDatabase();
  const result = await txDb.runAsync(
    "INSERT INTO items (circle_id, name, price, type, description, name_key) VALUES (?, ?, ?, ?, ?, ?)",
    circleId,
    name,
    price,
    type,
    description,
    normalizePurchaseLookupKey(name),
  );
  await updateItemFts(txDb, result.lastInsertRowId, name, description);
  return {
    id: result.lastInsertRowId,
    circleId,
    name,
    price,
    type,
    description,
    purchaseStatus: 0 as import("./types").PurchaseStatusValue,
    purchaseStatusSource: null,
    rawJson: null,
  };
}

export async function updateItem(
  itemId: number,
  name: string,
  price: number | null,
  type: string | null,
  description: string | null,
): Promise<void> {
  const txDb = await getDatabase();
  await txDb.runAsync(
    "UPDATE items SET name = ?, price = ?, type = ?, description = ?, name_key = ? WHERE id = ?",
    name,
    price,
    type,
    description,
    normalizePurchaseLookupKey(name),
    itemId,
  );
  await updateItemFts(txDb, itemId, name, description);
  invalidatePurchaseLookupCache();
}

export async function updateItemPurchaseStatus(
  itemId: number,
  status: PurchaseStatusValue,
): Promise<void> {
  const txDb = await getDatabase();
  await txDb.runAsync(
    "UPDATE items SET purchase_status = ?, purchase_status_source = 'manual' WHERE id = ?",
    status,
    itemId,
  );
  invalidatePurchaseLookupCache();
}

export const normalizePurchaseLookupKey = normalizeLookupKey;

/** name_key/penname_key/items.name_key に共通で使う正規化契約。 */
export const normalizeNameKey = normalizePurchaseLookupKey;

export function invalidatePurchaseLookupCache(): void {
  purchaseLookupCache.clear();
}

function purchaseLookupCacheKey(
  circleName: string,
  penname: string | null | undefined,
): string {
  return `${normalizePurchaseLookupKey(circleName)}\u0000${normalizePurchaseLookupKey(penname)}`;
}

async function updateItemFts(
  txDb: SQLite.SQLiteDatabase,
  itemId: number,
  name: string,
  description: string | null,
): Promise<void> {
  // 初回 backfill は検索時に遅延実行する。backfill 前の個別更新を入れると
  // count>0 と誤認して旧行を欠落させるため、派生行は ready 後だけ書く。
  if (!itemFtsAvailable || !itemFtsBackfilled) return;
  try {
    await txDb.runAsync("DELETE FROM items_fts WHERE item_id = ?", itemId);
    await txDb.runAsync(
      "INSERT INTO items_fts(name, description, item_id) VALUES (?, ?, ?)",
      name,
      description ?? "",
      itemId,
    );
  } catch {
    itemFtsAvailable = false;
  }
}

/** 直接 SQL import/reprocess 後に FTS 派生表を再構築する。失敗しても本体は保持。 */
export async function refreshItemSearchIndexForCircle(circleId: number): Promise<void> {
  if (!itemFtsAvailable || !itemFtsBackfilled) return;
  const txDb = await getDatabase();
  try {
    await txDb.runAsync(
      "DELETE FROM items_fts WHERE item_id IN (SELECT id FROM items WHERE circle_id = ?)",
      circleId,
    );
    const rows = await txDb.getAllAsync<{ id: number; name: string; description: string | null }>(
      "SELECT id, name, description FROM items WHERE circle_id = ?",
      circleId,
    );
    for (const row of rows) {
      await txDb.runAsync(
        "INSERT INTO items_fts(name, description, item_id) VALUES (?, ?, ?)",
        row.name,
        row.description ?? "",
        row.id,
      );
    }
  } catch {
    itemFtsAvailable = false;
  }
}

export async function getBoughtItemNameKeysForCircle(
  circleName: string,
  penname: string | null | undefined,
  itemNameKeys?: string[],
): Promise<Set<string>> {
  const txDb = await getDatabase();
  const targetCircleName = normalizePurchaseLookupKey(circleName);
  const targetPenname = normalizePurchaseLookupKey(penname);
  if (!targetCircleName && !targetPenname) return new Set();
  const targetItemKeys = itemNameKeys
    ? [...new Set(itemNameKeys.map((value) => normalizePurchaseLookupKey(value)).filter(Boolean))]
    : null;
  if (targetItemKeys && targetItemKeys.length === 0) return new Set();

  const cacheKey = `${purchaseLookupCacheKey(circleName, penname)}\u0000${targetItemKeys ? targetItemKeys.slice().sort().join(",") : "*"}`;
  const cached = purchaseLookupCache.get(cacheKey);
  if (cached) return new Set(cached);

  const rows: Array<{ item_name_key: string }> = [];
  const chunks = targetItemKeys ? Array.from({ length: Math.ceil(targetItemKeys.length / 400) }, (_, i) => targetItemKeys.slice(i * 400, (i + 1) * 400)) : [null];
  for (const chunk of chunks) {
    const itemFilter = chunk ? ` AND i.name_key IN (${chunk.map(() => "?").join(",")})` : "";
    rows.push(...await measuredGetAll<{ item_name_key: string }>(
      txDb,
      `SELECT DISTINCT i.name_key AS item_name_key
       FROM items i
       JOIN circles c ON c.id = i.circle_id
       WHERE i.purchase_status = ?
         AND ((? != '' AND c.name_key = ?) OR (? != '' AND c.penname_key = ?))${itemFilter}`,
      PURCHASE_STATUS.BOUGHT,
      targetCircleName,
      targetCircleName,
      targetPenname,
      targetPenname,
      ...(chunk ?? []),
    ));
  }

  const keys = new Set<string>();
  for (const row of rows) {
    if (row.item_name_key) keys.add(row.item_name_key);
  }
  if (purchaseLookupCache.size >= PURCHASE_LOOKUP_CACHE_LIMIT) {
    const first = purchaseLookupCache.keys().next().value;
    if (first) purchaseLookupCache.delete(first);
  }
  purchaseLookupCache.set(cacheKey, new Set(keys));
  return keys;
}

export async function deleteItem(itemId: number): Promise<void> {
  const txDb = await getDatabase();
  await txDb.withExclusiveTransactionAsync(async (txn) => {
    if (itemFtsAvailable) {
      await txn.runAsync("DELETE FROM items_fts WHERE item_id = ?", itemId);
    }
    await txn.runAsync("DELETE FROM items WHERE id = ?", itemId);
  });
  invalidatePurchaseLookupCache();
}

/** アイテムの並び順を入れ替え */
export async function reorderItem(
  circleId: number,
  fromIndex: number,
  toIndex: number,
): Promise<void> {
  const txDb = await getDatabase();
  const items = await txDb.getAllAsync<any>(
    "SELECT id FROM items WHERE circle_id = ? ORDER BY sort_order ASC, id ASC",
    circleId,
  );
  if (
    fromIndex < 0 ||
    fromIndex >= items.length ||
    toIndex < 0 ||
    toIndex >= items.length
  )
    return;
  const ids = items.map((r: any) => r.id as number);
  const [moved] = ids.splice(fromIndex, 1);
  ids.splice(toIndex, 0, moved);
  for (let i = 0; i < ids.length; i++) {
    await txDb.runAsync(
      "UPDATE items SET sort_order = ? WHERE id = ?",
      i,
      ids[i],
    );
  }
}

// --- お気に入りサークル ---

export interface FavoriteCircle {
  id: number;
  name: string;
  tag: string;
}

export async function getFavoriteCircles(): Promise<FavoriteCircle[]> {
  const txDb = await getDatabase();
  const rows = await txDb.getAllAsync<any>(
    "SELECT * FROM favorite_circles ORDER BY added_at DESC",
  );
  return rows.map((r: any) => ({ id: r.id, name: r.name, tag: r.tag }));
}

export async function addFavoriteCircle(
  name: string,
  tag: string,
): Promise<void> {
  const txDb = await getDatabase();
  await txDb.runAsync(
    "INSERT INTO favorite_circles (name, tag) VALUES (?, ?)",
    name,
    tag,
  );
  await updateStoredCircleMasterFavorite(name, tag, true);
}

export async function removeFavoriteCircle(
  name: string,
  tag: string,
): Promise<void> {
  const txDb = await getDatabase();
  await txDb.runAsync(
    "DELETE FROM favorite_circles WHERE (name != '' AND name = ?) OR (tag != '' AND tag = ?)",
    name,
    tag,
  );
  await updateStoredCircleMasterFavorite(name, tag, false);
}

export async function isFavoriteCircle(
  name: string,
  tag: string,
): Promise<boolean> {
  const txDb = await getDatabase();
  const row = await txDb.getFirstAsync<any>(
    "SELECT 1 FROM favorite_circles WHERE (name != '' AND name = ?) OR (tag != '' AND tag = ?) LIMIT 1",
    name,
    tag,
  );
  return !!row;
}

// --- EventMap ---

export interface EventMapSummary {
  id: number;
  eventId: number;
  filename: string;
  mapNumber: number;
}

export async function getEventMapSummaries(eventId: number): Promise<EventMapSummary[]> {
  const txDb = await getDatabase();
  const rows = await measuredGetAll<any>(
    txDb,
    "SELECT id, event_id, filename, map_number FROM event_maps WHERE event_id = ? ORDER BY map_number, id",
    eventId,
  );
  return rows.map((row) => ({
    id: Number(row.id),
    eventId: Number(row.event_id),
    filename: String(row.filename ?? ""),
    mapNumber: Number(row.map_number ?? 1),
  }));
}

export async function getEventMaps(eventId: number): Promise<EventMap[]> {
  const txDb = await getDatabase();
  const rows = await measuredGetAll<any>(
    txDb,
    "SELECT id, event_id, filename, map_number FROM event_maps WHERE event_id = ? ORDER BY map_number",
    eventId,
  );
  return rows.map(mapEventMap);
}

async function getEventMapsForExport(eventId: number): Promise<EventMap[]> {
  const txDb = await getDatabase();
  const rows = await measuredGetAll<any>(
    txDb,
    "SELECT * FROM event_maps WHERE event_id = ? ORDER BY map_number",
    eventId,
  );
  return rows.map(mapEventMap);
}

// --- 画像保存ヘルパー ---

const IMAGES_DIR = `${FileSystem.documentDirectory}images/`;
const DEFAULT_CUTS_DIR = `${FileSystem.documentDirectory}default_cuts/`;
const SHARED_BUNDLE_FINGERPRINT_KEY = "shared_bundle_fingerprint_v1";

function basenameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function resolveExportImagePath(path: string, fallbackPath: string): string {
  if (path.startsWith("file:///")) return path;
  if (path.startsWith("/")) return `file://${path}`;
  return fallbackPath;
}

async function ensureImagesDir(eventId: number, imagesRoot = IMAGES_DIR): Promise<string> {
  const dir = `${normalizeDir(imagesRoot)}${eventId}/`;
  const dirInfo = await FileSystem.getInfoAsync(dir);
  if (!dirInfo.exists) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }
  return dir;
}

// --- データインポート ---

export interface ImportProgress {
  current: number;
  total: number;
  phase: "download" | "events" | "maps" | "circles";
}

interface SyncManifestEvent {
  slug?: string;
  path: string;
  name?: string;
  date?: string;
  uid?: string;
  stable_uid?: string;
  event_uid?: string;
  hash?: string;
  content_hash?: string;
  asset_hash?: string;
  asset_set_hash?: string;
}

interface SyncBundleManifest {
  format?: string;
  format_version?: number;
  manifest_version?: number;
  sync_mode?: string;
  event_count?: number;
  events?: SyncManifestEvent[];
}

export type ImportKind = "full" | "single";

export interface ImportDiffResult {
  kind: ImportKind;
  incremental: boolean;
  fallbackReason?: string;
  /** Event rows staged by the importer (added + changed, live IDs). */
  importedEventIds: number[];
  /** New event rows that did not replace an existing stable UID. */
  addedEventIds: number[];
  changedEventIds: number[];
  unchangedEventIds: number[];
  removedEventIds: number[];
  /** Current event rows covered by the import (removed rows are excluded). */
  targetEventIds: number[];
  /** Reserved for a future best-effort importer; successful imports are empty. */
  failedEventIds: number[];
}

let lastImportDiff: ImportDiffResult = {
  kind: "single",
  incremental: false,
  importedEventIds: [],
  addedEventIds: [],
  changedEventIds: [],
  unchangedEventIds: [],
  removedEventIds: [],
  targetEventIds: [],
  failedEventIds: [],
};

export function getLastImportDiff(): ImportDiffResult {
  return {
    ...lastImportDiff,
    importedEventIds: [...lastImportDiff.importedEventIds],
    addedEventIds: [...lastImportDiff.addedEventIds],
    changedEventIds: [...lastImportDiff.changedEventIds],
    unchangedEventIds: [...lastImportDiff.unchangedEventIds],
    removedEventIds: [...lastImportDiff.removedEventIds],
    targetEventIds: [...lastImportDiff.targetEventIds],
    failedEventIds: [...lastImportDiff.failedEventIds],
  };
}

interface AssetManifestEntry {
  algorithm?: string;
  hash?: string;
  path?: string;
  size?: number;
  original_names?: string[];
  paths?: string[];
}

interface AssetManifest {
  format?: string;
  format_version?: number;
  assets?: Record<string, AssetManifestEntry>;
  aliases?: Record<string, string>;
  events?: Record<string, { assets?: AssetManifestEntry[]; asset_set_hash?: string; event_uid?: string }>;
  strict?: boolean;
}

function stripFileUri(path: string): string {
  return path.replace(/^file:\/\/\//, "/").replace(/^file:\/\//, "");
}

async function ensureDirectory(path: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(path, { intermediates: true });
  }
}

async function ensureItemFtsReady(): Promise<void> {
  if (!itemFtsAvailable || itemFtsBackfilled) return;
  if (!itemFtsBackfillPromise) {
    itemFtsBackfillPromise = (async () => {
      try {
        const txDb = await getDatabase();
        // COUNT(*) cannot tell whether an earlier process died after a partial
        // backfill.  Rebuild from the authoritative items table once per DB
        // lifetime, lazily on first non-empty search, so every row is covered.
        await measuredRun(txDb, "DELETE FROM items_fts");
        await measuredRun(
          txDb,
          "INSERT INTO items_fts(name, description, item_id) SELECT name, COALESCE(description, ''), id FROM items",
        );
        itemFtsBackfilled = true;
      } catch {
        itemFtsAvailable = false;
      } finally {
        itemFtsBackfillPromise = null;
      }
    })();
  }
  await itemFtsBackfillPromise;
}

/** items を削除する前に派生 FTS 行を除去する。旧 item_id の stale 検索を残さない。 */
export async function deleteItemSearchIndexForCircle(
  circleId: number,
  transactionDb?: SQLite.SQLiteDatabase,
): Promise<void> {
  if (!itemFtsAvailable) return;
  const txDb = transactionDb ?? await getDatabase();
  await txDb.runAsync(
    "DELETE FROM items_fts WHERE item_id IN (SELECT id FROM items WHERE circle_id = ?)",
    circleId,
  );
}

async function deleteStagedEventWithFts(database: SQLite.SQLiteDatabase, eventId: number): Promise<void> {
  if (itemFtsAvailable) {
    await database.runAsync(
      "DELETE FROM items_fts WHERE item_id IN (SELECT i.id FROM items i JOIN circles c ON c.id = i.circle_id WHERE c.event_id = ?)",
      eventId,
    );
  }
  await database.runAsync("DELETE FROM events WHERE id = ?", eventId);
  const remaining = await database.getFirstAsync<{ id: number }>("SELECT id FROM events WHERE id = ?", eventId);
  if (remaining) throw new Error(`staged event の rollback delete に失敗しました: ${eventId}`);
}

function createImageStageRoot(): string {
  const base = getImportStageBaseDirectory();
  return `${normalizeDir(base)}eventtrail_import_stage_${Date.now()}_${Math.random().toString(36).slice(2)}/`;
}

function getImportStageBaseDirectory(): string {
  return FileSystem.cacheDirectory ?? FileSystem.documentDirectory ?? "";
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  // 旧 live を保持したままコピーする。rename/move は kill 窓で source を
  // 消失させるため使わず、呼び出し側が DB publish 後に明示 cleanup する。
  await FileSystem.copyAsync({ from: source, to: destination });
}

interface DirectoryFileFingerprint {
  relative: string;
  size: number;
  md5: string;
}

interface DefaultCutCopyPlan extends DirectoryFileFingerprint {
  source: string;
  dest: string;
  hadExisting: boolean;
}

interface SharedCutSnapshotEntry extends DirectoryFileFingerprint {
  hadLive: boolean;
}

interface SharedBundleInspection {
  fingerprint: string;
  circleMasterJson: string | null;
  cutFiles: DirectoryFileFingerprint[];
  changedCuts: DefaultCutCopyPlan[];
}

interface SharedCutSnapshotManifest {
  version: 1;
  entries: SharedCutSnapshotEntry[];
  previousFingerprint: string | null;
}

export async function listDirectoryFiles(root: string, prefix = ""): Promise<DirectoryFileFingerprint[]> {
  const files: DirectoryFileFingerprint[] = [];
  for (const entry of await FileSystem.readDirectoryAsync(root)) {
    const path = `${normalizeDir(root)}${entry}`;
    // Android's legacy Expo FileSystem tries to open the target through a
    // FileInputStream when md5 is requested.  Asking it to digest a directory
    // therefore throws EISDIR before we can recurse, so determine the entry
    // type without md5 first and request a digest only for a stable file.
    const info = (await FileSystem.getInfoAsync(path)) as any;
    const relative = prefix ? `${prefix}/${entry}` : entry;
    if (info.exists && info.isDirectory) {
      files.push(...await listDirectoryFiles(`${normalizeDir(path)}`, relative));
    } else {
      if (!info.exists || typeof info.size !== "number") {
        throw new Error(`画像 backup の検証に必要な file metadata がありません: ${path}`);
      }
      const digestInfo = (await FileSystem.getInfoAsync(path, { md5: true } as any)) as any;
      if (!digestInfo.exists || digestInfo.isDirectory || digestInfo.uri !== info.uri ||
          Number(digestInfo.size) !== Number(info.size) ||
          Number(digestInfo.modificationTime) !== Number(info.modificationTime) ||
          typeof digestInfo.md5 !== "string" || !digestInfo.md5) {
        throw new Error(`画像 backup の検証中に file identity が変化しました: ${path}`);
      }
      files.push({ relative, size: Number(digestInfo.size), md5: String(digestInfo.md5).toLowerCase() });
    }
  }
  return files.sort((a, b) => a.relative.localeCompare(b.relative));
}

/** Copy to a temporary directory and verify every file before it becomes a
 * rollback backup.  A partial/unchecked directory is never returned as valid. */
export async function copyDirectoryVerified(source: string, destination: string): Promise<void> {
  const sourceInfo = await FileSystem.getInfoAsync(source);
  if (!sourceInfo.exists || !(sourceInfo as any).isDirectory) throw new Error(`画像ディレクトリがありません: ${source}`);
  const fingerprint = await listDirectoryFiles(source);
  await FileSystem.deleteAsync(destination, { idempotent: true });
  try {
    await ensureDirectory(destination.slice(0, destination.lastIndexOf("/") + 1));
    await copyDirectory(source, destination);
    const copied = await listDirectoryFiles(destination);
    if (copied.length !== fingerprint.length || copied.some((entry, i) =>
      entry.relative !== fingerprint[i].relative || entry.size !== fingerprint[i].size || entry.md5 !== fingerprint[i].md5
    )) {
      throw new Error(`画像 backup の完全検証に失敗しました: ${destination}`);
    }
  } catch (error) {
    await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => undefined);
    throw error;
  }
}

async function copyStagedEventDirectories(stageRoot: string, destination: string): Promise<void> {
  await ensureDirectory(destination);
  for (const entry of await FileSystem.readDirectoryAsync(stageRoot)) {
    if (!/^\d+$/.test(entry)) continue;
    await copyDirectoryVerified(`${normalizeDir(stageRoot)}${entry}/`, `${normalizeDir(destination)}${entry}/`);
  }
}

interface PublishedImageDir {
  /** Final/live event ID. */
  eventId: number;
  /** Staging marker ID before the DB publish transaction. */
  markerEventId?: number;
  liveDir: string;
  backupDir: string | null;
  phase?: string;
}

async function updateImportStageMarker(
  database: SQLite.SQLiteDatabase,
  eventId: number,
  phase: string,
  backupDir?: string | null,
): Promise<void> {
  const result = await database.runAsync(
    "UPDATE sync_import_staging SET phase = ?, backup_dir = COALESCE(?, backup_dir) WHERE event_id = ?",
    phase,
    backupDir ?? null,
    eventId,
  );
  if (!result.changes) throw new Error(`sync_import_staging marker がありません: ${eventId}`);
}

interface ImportStageJournal {
  version: 1;
  kind?: "incremental" | "legacy";
  phase: string;
  importedEventIds: number[];
  published: PublishedImageDir[];
  cleanupEventIds?: number[];
  legacyDbBackupName?: string;
  legacyStageDbName?: string;
  legacyImagesBackup?: string;
  legacyHadLiveImages?: boolean;
  legacyDbBackupReady?: boolean;
  legacyImagesBackupReady?: boolean;
  legacyCutsStage?: string;
  legacyCutsBackup?: string;
  legacyHadLiveCuts?: boolean;
  legacyCutsBackupReady?: boolean;
  legacyCutsPublished?: boolean;
  sharedCutsBackup?: string;
  sharedCutsHadLive?: boolean;
  sharedCutsBackupReady?: boolean;
  sharedSettingsIntent?: boolean;
  sharedSettingsApplied?: boolean;
  sharedCircleMasterPrevious?: string | null;
  sharedFavoritesPrevious?: Array<{ name: string; tag: string }>;
  sharedCutSnapshots?: SharedCutSnapshotEntry[];
  sharedFingerprintPrevious?: string | null;
}

async function writeImportStageJournal(stageRoot: string, journal: ImportStageJournal): Promise<void> {
  const tempPath = `${normalizeDir(stageRoot)}journal.tmp`;
  const journalPath = `${normalizeDir(stageRoot)}journal.json`;
  const previousPath = `${normalizeDir(stageRoot)}journal.prev`;
  // Preserve durable context fields (shared-settings snapshot, cleanup IDs,
  // legacy readiness markers) when callers update only phase/published.  This
  // prevents a later progress write from accidentally erasing the rollback
  // preimage written before a live file operation.
  let mergedJournal: ImportStageJournal = journal;
  try {
    const existingInfo = await FileSystem.getInfoAsync(journalPath);
    if (existingInfo.exists) {
      const existing = parseImportStageJournal(JSON.parse(await FileSystem.readAsStringAsync(journalPath)));
      if (existing) mergedJournal = { ...existing, ...journal };
    }
  } catch {
    // If the old journal is malformed, overwrite it only after the new payload
    // has been written to its temp path; durable SQLite markers remain the
    // source of truth for recovery.
  }
  await FileSystem.writeAsStringAsync(tempPath, JSON.stringify(mergedJournal));
  // Expo legacy FileSystem has no portable replace primitive.  Move the old
  // complete journal aside, then rename the fully-written temp payload.  A
  // failure restores the old journal; a crash in the tiny no-journal window is
  // handled by durable sync_import_staging rows and leaves stage evidence.
  const oldInfo = await FileSystem.getInfoAsync(journalPath);
  if (oldInfo.exists) {
    await FileSystem.deleteAsync(previousPath, { idempotent: true });
    await FileSystem.moveAsync({ from: journalPath, to: previousPath });
  }
  try {
    await FileSystem.moveAsync({ from: tempPath, to: journalPath });
    await FileSystem.deleteAsync(previousPath, { idempotent: true });
  } catch (error) {
    await FileSystem.deleteAsync(tempPath, { idempotent: true }).catch(() => undefined);
    const prevInfo = await FileSystem.getInfoAsync(previousPath).catch(() => ({ exists: false } as any));
    if (prevInfo.exists && !(await FileSystem.getInfoAsync(journalPath).catch(() => ({ exists: false } as any))).exists) {
      await FileSystem.moveAsync({ from: previousPath, to: journalPath }).catch(() => undefined);
    }
    throw error;
  }
}

async function recoverImportStageRoot(database: SQLite.SQLiteDatabase, stageRoot: string): Promise<void> {
  const journalPath = `${normalizeDir(stageRoot)}journal.json`;
  let journal: ImportStageJournal | null = null;
  let journalCorrupt = false;
  try {
    const info = await FileSystem.getInfoAsync(journalPath);
    if (info.exists) {
      journal = parseImportStageJournal(JSON.parse(await FileSystem.readAsStringAsync(journalPath)));
      if (!journal) journalCorrupt = true;
      else if (!isJournalPathSetSafe(stageRoot, journal)) {
        journal = null;
        journalCorrupt = true;
      }
    } else {
      journalCorrupt = true;
    }
  } catch {
    journalCorrupt = true;
  }
  const durableRows = await database.getAllAsync<{ event_id: number; previous_event_id: number | null; phase: string; backup_dir: string | null }>(
    "SELECT event_id, previous_event_id, phase, backup_dir FROM sync_import_staging WHERE stage_root = ?",
    stageRoot,
  );
  const cleanupRows = await database.getAllAsync<{ event_id: number; phase: string }>(
    "SELECT event_id, phase FROM sync_import_cleanup WHERE stage_root = ?",
    stageRoot,
  );
  const sharedRows = await database.getAllAsync<{
    stage_root: string;
    previous_circle_master: string | null;
    previous_favorites_json: string;
    cuts_backup: string;
    cuts_had_live: number;
    cuts_backup_ready: number;
    phase: string;
  }>(
    "SELECT stage_root, previous_circle_master, previous_favorites_json, cuts_backup, cuts_had_live, cuts_backup_ready, phase FROM sync_import_shared_staging WHERE stage_root = ?",
    stageRoot,
  );
  const sharedRow = sharedRows[0];
  if (sharedRow && !isPathContainedBy(stageRoot, sharedRow.cuts_backup)) {
    throw new Error("shared settings snapshot path is unsafe");
  }
  const sharedCutManifest = sharedRow
    ? await readSharedCutSnapshotManifest(sharedRow.cuts_backup)
    : null;
  if (sharedRow?.cuts_backup_ready && !sharedCutManifest) {
    // Older full-directory snapshots have no manifest and remain supported;
    // a per-file snapshot is identified by the files/ child.
    const filesInfo = await FileSystem.getInfoAsync(`${normalizeDir(sharedRow.cuts_backup)}files/`).catch(() => ({ exists: false } as any));
    if (filesInfo.exists) throw new Error("shared settings snapshot manifest is corrupt");
  }
  const sharedSnapshotFromRow: ImportStageJournal | null = sharedRow
    ? {
        version: 1,
        phase: "staging",
        importedEventIds: [],
        published: [],
        sharedCutsBackup: sharedRow.cuts_backup,
        sharedCutsHadLive: !!sharedRow.cuts_had_live,
        sharedCutsBackupReady: !!sharedRow.cuts_backup_ready,
        sharedSettingsIntent: true,
        sharedSettingsApplied: sharedRow.phase === "applied",
        sharedCircleMasterPrevious: sharedRow.previous_circle_master,
        sharedCutSnapshots: sharedCutManifest?.entries,
        sharedFingerprintPrevious: sharedCutManifest?.previousFingerprint,
        sharedFavoritesPrevious: (() => {
          try {
            const parsed = JSON.parse(sharedRow.previous_favorites_json);
            return Array.isArray(parsed) ? parsed.filter((row) => row && typeof row.name === "string" && typeof row.tag === "string") : [];
          } catch {
            throw new Error("shared settings snapshot is corrupt");
          }
        })(),
      }
    : null;
  const allFinalized = durableRows.length > 0 && durableRows.every((row) => row.phase === "finalized");
  const cleanupFinalized = cleanupRows.length > 0 && cleanupRows.every((row) => row.phase === "finalized");
  // SQLite の durable marker は JSON journal より優先する。全行 finalized
  // なら live DB transaction は commit 済みなので forward cleanup のみ行う。
  if (allFinalized || cleanupFinalized || (!journalCorrupt && journal?.phase === "finalized" && durableRows.length === 0)) {
    if (journal?.kind === "legacy" && journal.legacyDbBackupName && journal.legacyDbBackupReady) {
      const backupDb = await SQLite.openDatabaseAsync(journal.legacyDbBackupName);
      const check = await backupDb.getFirstAsync<{ integrity_check: string }>("PRAGMA integrity_check");
      const schema = await backupDb.getFirstAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'");
      await backupDb.closeAsync();
      if (check?.integrity_check !== "ok" || schema?.name !== "events") throw new Error("legacy DB backup cleanup verification failed");
    }
    const cleanupIds = new Set<number>([
      ...(journal?.cleanupEventIds ?? []).map(Number),
      ...cleanupRows.map((row) => Number(row.event_id)),
    ]);
    for (const eventId of cleanupIds) {
      // Old live image deletion is post-DB-commit.  Retry it on startup and
      // retain stage/journal evidence if a file-lock/device error persists.
      await FileSystem.deleteAsync(`${IMAGES_DIR}${Number(eventId)}/`, { idempotent: true });
    }
    await database.runAsync("DELETE FROM sync_import_cleanup WHERE stage_root = ?", stageRoot);
    await database.runAsync("DELETE FROM sync_import_shared_staging WHERE stage_root = ?", stageRoot);
    await database.runAsync("DELETE FROM sync_import_staging WHERE stage_root = ?", stageRoot);
    if (journal?.legacyImagesBackup) await FileSystem.deleteAsync(journal.legacyImagesBackup, { idempotent: true });
    if (journal?.legacyStageDbName) await SQLite.deleteDatabaseAsync(journal.legacyStageDbName);
    if (journal?.legacyDbBackupName) await SQLite.deleteDatabaseAsync(journal.legacyDbBackupName);
    if (journal?.legacyCutsStage) await FileSystem.deleteAsync(journal.legacyCutsStage, { idempotent: true });
    if (journal?.legacyCutsBackup) await FileSystem.deleteAsync(journal.legacyCutsBackup, { idempotent: true });
    if (journal?.sharedCutsBackup) await FileSystem.deleteAsync(journal.sharedCutsBackup, { idempotent: true });
    await FileSystem.deleteAsync(stageRoot, { idempotent: true });
    return;
  }
  // 壊れた journal と durable rows 無しでは event/backup の集合を信頼できない。
  // stage/evidence は削除せず fail-closed とする。
  if (journalCorrupt && durableRows.length === 0 && sharedRows.length === 0) return;

  // Legacy full sync は temporary DB publish 前は live DB に staging row が
  // 無い。valid journal の backup preimage を検証してからのみ restore する。
  if (!journalCorrupt && journal?.kind === "legacy") {
    // A backup filename is allocated before SQLite backup completes.  Never
    // open that possibly-empty file as a restore source; preserve live DB and
    // stage evidence for retry until the ready marker is durable.
    if (journal.legacyHadLiveImages === undefined && journal.phase !== "staging") return;
    if (journal.legacyDbBackupName && !journal.legacyDbBackupReady && journal.phase !== "db_published" && journal.phase !== "finalized") return;
    if (journal.phase === "db_published" || journal.phase === "finalized") {
        if (journal.legacyDbBackupName && journal.legacyDbBackupReady) {
          const backupDb = await SQLite.openDatabaseAsync(journal.legacyDbBackupName);
          const check = await backupDb.getFirstAsync<{ integrity_check: string }>("PRAGMA integrity_check");
          const schema = await backupDb.getFirstAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'");
          await backupDb.closeAsync();
          if (check?.integrity_check !== "ok" || schema?.name !== "events") throw new Error("legacy DB backup cleanup verification failed");
        }
        await FileSystem.deleteAsync(stageRoot, { idempotent: true });
        if (journal.legacyImagesBackup) await FileSystem.deleteAsync(journal.legacyImagesBackup, { idempotent: true });
        if (journal.legacyCutsBackup) await FileSystem.deleteAsync(journal.legacyCutsBackup, { idempotent: true });
        if (journal.legacyCutsStage) await FileSystem.deleteAsync(journal.legacyCutsStage, { idempotent: true });
        if (journal.sharedCutsBackup) await FileSystem.deleteAsync(journal.sharedCutsBackup, { idempotent: true });
        if (journal.legacyStageDbName) await SQLite.deleteDatabaseAsync(journal.legacyStageDbName).catch(() => undefined);
        if (journal.legacyDbBackupName) await SQLite.deleteDatabaseAsync(journal.legacyDbBackupName);
        return;
    }
    try {
      if (journal.legacyImagesBackup && !journal.legacyImagesBackupReady && journal.legacyHadLiveImages && journal.phase === "image_publish_intent") {
        // Backup copy was not durably verified.  Keep the existing live tree;
        // deleting it would turn a partial backup into data loss.
        return;
      }
      if (journal.legacyDbBackupName && journal.legacyDbBackupReady) {
        const backupDb = await SQLite.openDatabaseAsync(journal.legacyDbBackupName);
        const backupCheck = await backupDb.getFirstAsync<{ integrity_check: string }>("PRAGMA integrity_check");
        if (backupCheck?.integrity_check !== "ok") throw new Error("legacy DB backup is corrupt or missing");
        const backupSchema = await backupDb.getFirstAsync<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'",
        );
        if (backupSchema?.name !== "events") throw new Error("legacy DB backup schema is missing");
        await SQLite.backupDatabaseAsync({ sourceDatabase: backupDb, destDatabase: rawDatabase(database) });
        await backupDb.closeAsync();
      }
      if (journal.legacyImagesBackup) {
        const backupInfo = await FileSystem.getInfoAsync(journal.legacyImagesBackup);
        if (backupInfo.exists && journal.legacyImagesBackupReady) await restoreDirectoryFromBackup(journal.legacyImagesBackup, IMAGES_DIR);
        else if (journal.legacyHadLiveImages) throw new Error("legacy live images backup is missing");
      } else if (journal.legacyHadLiveImages) {
        throw new Error("legacy live images backup marker is missing");
      } else {
        // Fresh install had no previous live image tree.  Remove only the
        // imported numeric dirs; never infer arbitrary names from a corrupt
        // journal.
        for (const eventId of journal.importedEventIds) {
          await FileSystem.deleteAsync(`${IMAGES_DIR}${Number(eventId)}/`, { idempotent: true });
        }
      }
      // Default cuts are published from their own verified stage.  Before the
      // DB publish boundary, always restore the verified preimage (even when
      // the process died between delete and move and the `cutsPublished`
      // marker was not flushed yet).  On a fresh install there is no preimage,
      // so removing the partial tree is safe.
      if (journal.legacyCutsBackup && journal.legacyCutsBackupReady) {
        await restoreDirectoryFromBackup(journal.legacyCutsBackup, DEFAULT_CUTS_DIR);
      } else if (journal.legacyHadLiveCuts) {
        throw new Error("legacy default cuts backup is missing");
      } else if (journal.legacyCutsStage) {
        await FileSystem.deleteAsync(DEFAULT_CUTS_DIR, { idempotent: true });
      }
      // Cleanup only after every verified restore succeeds; stageRoot/journal
      // remains as durable evidence if any delete fails and startup retries.
      if (journal.legacyStageDbName) await SQLite.deleteDatabaseAsync(journal.legacyStageDbName);
      if (journal.legacyDbBackupName) await SQLite.deleteDatabaseAsync(journal.legacyDbBackupName);
      if (journal.legacyCutsStage) await FileSystem.deleteAsync(journal.legacyCutsStage, { idempotent: true });
      if (journal.legacyCutsBackup) await FileSystem.deleteAsync(journal.legacyCutsBackup, { idempotent: true });
      if (journal.sharedCutsBackup) await FileSystem.deleteAsync(journal.sharedCutsBackup, { idempotent: true });
      await FileSystem.deleteAsync(stageRoot, { idempotent: true });
      return;
    } catch (error) {
      // Keep stage, backup and marker for a startup retry; never hide restore failure.
      throw error;
    }
  }

  const published = [
    ...(journalCorrupt ? [] : (journal?.published ?? [])),
    ...durableRows
      .filter((row) => row.phase === "backup_intent" || row.phase === "backup_done" || row.phase === "live_done" || row.phase === "rollback_intent")
      .map((row) => ({
        eventId: Number(row.previous_event_id ?? row.event_id),
        markerEventId: Number(row.event_id),
        liveDir: `${IMAGES_DIR}${Number(row.previous_event_id ?? row.event_id)}/`,
        backupDir: row.backup_dir,
        phase: row.phase,
      })),
  ];
  // Invalid/tampered published entries must fail closed, not be silently
  // dropped (dropping could leave an unknown live directory half-published).
  for (const entry of published) {
    const expectedLive = `${IMAGES_DIR}${entry.eventId}/`;
    if (entry.liveDir !== expectedLive || (entry.backupDir && !isPathContainedBy(stageRoot, entry.backupDir))) {
      throw new Error("import journal published path is unsafe");
    }
  }
  for (const row of durableRows) {
    await database.runAsync("UPDATE sync_import_staging SET phase = 'rollback_intent' WHERE event_id = ?", row.event_id);
  }
  // Throws on an unverifiable/missing backup.  In that case keep markers and
  // stage files so the next startup can retry rather than deleting evidence.
  await rollbackPublishedImageDirs(published);
  const sharedRecovery = sharedSnapshotFromRow ?? (
    journal?.sharedSettingsIntent && journal.sharedCircleMasterPrevious !== undefined ? journal : null
  );
  if (sharedRecovery) {
    await restoreSharedSettingsSnapshot(database, sharedRecovery);
  }
  for (const row of durableRows) {
    await database.runAsync("UPDATE sync_import_staging SET phase = 'rolled_back' WHERE event_id = ?", row.event_id);
  }
  // Durable rows are the minimum trustworthy imported-id set when the journal
  // is corrupt or truncated.  Numeric stage names/journal IDs are only an
  // optional supplement for a valid journal.
  let importedIds = new Set(durableRows.map((row) => Number(row.event_id)));
  if (!journalCorrupt) {
    for (const eventId of journal?.importedEventIds ?? []) importedIds.add(Number(eventId));
  }
  try {
    for (const entry of await FileSystem.readDirectoryAsync(stageRoot)) {
      if (/^\d+$/.test(entry)) importedIds.add(Number(entry));
    }
  } catch {
    /* stage directory may already be gone */
  }
  for (const eventId of importedIds) {
    await deleteStagedEventWithFts(database, eventId);
  }
  await database.runAsync("DELETE FROM sync_import_cleanup WHERE stage_root = ?", stageRoot);
  await database.runAsync("DELETE FROM sync_import_shared_staging WHERE stage_root = ?", stageRoot);
  await database.runAsync("DELETE FROM sync_import_staging WHERE stage_root = ?", stageRoot);
  await FileSystem.deleteAsync(stageRoot, { idempotent: true });
}

async function recoverImportStages(database: SQLite.SQLiteDatabase): Promise<void> {
  const base = getImportStageBaseDirectory();
  if (!base) return;
  let entries: string[];
  try {
    entries = await FileSystem.readDirectoryAsync(base);
  } catch {
    /* cache cleanup is best effort */
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith("eventtrail_import_stage_")) continue;
    // Individual recovery errors are intentionally propagated.  The stage
    // marker/evidence remains on disk and the next launch can retry instead of
    // silently claiming a successful startup.
    await recoverImportStageRoot(database, `${normalizeDir(base)}${entry}/`);
  }
  // A process may have removed the stage directory after DB finalization but
  // before deleting its marker.  Recover those roots from SQLite as well; a
  // missing directory is safe for finalized rows and must not leave zombies.
  const roots = await database.getAllAsync<{ stage_root: string }>(
    "SELECT DISTINCT stage_root FROM sync_import_staging WHERE phase = 'finalized'",
  );
  for (const row of roots) {
    if (!row.stage_root || entries.some((entry) => `${normalizeDir(base)}${entry}/` === row.stage_root)) continue;
    await database.runAsync("DELETE FROM sync_import_staging WHERE stage_root = ?", row.stage_root);
  }
  const cleanupRoots = await database.getAllAsync<{ stage_root: string }>(
    "SELECT DISTINCT stage_root FROM sync_import_cleanup WHERE phase = 'finalized'",
  );
  for (const row of cleanupRoots) {
    const cleanupIds = await database.getAllAsync<{ event_id: number }>("SELECT event_id FROM sync_import_cleanup WHERE stage_root = ?", row.stage_root);
    for (const cleanup of cleanupIds) await FileSystem.deleteAsync(`${IMAGES_DIR}${Number(cleanup.event_id)}/`, { idempotent: true });
    await database.runAsync("DELETE FROM sync_import_cleanup WHERE stage_root = ?", row.stage_root);
  }
  await database.runAsync("DELETE FROM sync_import_shared_staging WHERE stage_root IN (SELECT stage_root FROM sync_import_staging WHERE phase = 'finalized')");
  const sharedRoots = await database.getAllAsync<{ stage_root: string }>(
    "SELECT DISTINCT stage_root FROM sync_import_shared_staging",
  );
  for (const row of sharedRoots) {
    if (!row.stage_root) continue;
    await recoverImportStageRoot(database, row.stage_root);
  }
}

async function publishStagedImageDir(
  stageRoot: string,
  stagingEventId: number,
  database: SQLite.SQLiteDatabase,
  liveEventId = stagingEventId,
): Promise<PublishedImageDir> {
  await ensureDirectory(IMAGES_DIR);
  const stageDir = `${normalizeDir(stageRoot)}${stagingEventId}/`;
  const liveDir = `${IMAGES_DIR}${liveEventId}/`;
  const stageInfo = await FileSystem.getInfoAsync(stageDir);
  if (!stageInfo.exists) throw new Error(`画像 staging が見つかりません: ${stagingEventId}`);

  const liveInfo = await FileSystem.getInfoAsync(liveDir);
  const backupDir = liveInfo.exists
    ? `${normalizeDir(stageRoot)}__old_${liveEventId}_${Date.now()}/`
    : null;
  // file operation 前に durable intent を書く。kill/restart はこの marker と
  // backup_dir を source of truth として old live を restore する。backup は
  // 一時ディレクトリへ完全検証してから rename するため、partial backup を
  // recovery が有効な preimage として扱うことはない。
  const backupTemp = backupDir ? `${backupDir}.tmp` : null;
  let backupReady = !backupDir;
  try {
    await updateImportStageMarker(database, stagingEventId, "backup_intent", backupDir);
    if (backupDir && backupTemp) {
      await copyDirectoryVerified(liveDir, backupTemp);
      await FileSystem.moveAsync({ from: backupTemp, to: backupDir });
      backupReady = true;
      await updateImportStageMarker(database, stagingEventId, "backup_done", backupDir);
    }
    const liveTemp = `${normalizeDir(stageRoot)}__live_${liveEventId}_${Date.now()}/`;
    await copyDirectoryVerified(stageDir, liveTemp);
    // The old live directory is removed only after a complete staged copy is
    // ready.  A rename then makes the publish boundary a single filesystem op.
    await FileSystem.deleteAsync(liveDir, { idempotent: true });
    await FileSystem.moveAsync({ from: liveTemp, to: liveDir });
    const publishedInfo = await FileSystem.getInfoAsync(liveDir);
    if (!publishedInfo.exists) throw new Error(`画像 publish に失敗しました: ${liveEventId}`);
    await updateImportStageMarker(database, stagingEventId, "live_done", backupDir);
    return { eventId: liveEventId, markerEventId: stagingEventId, liveDir, backupDir };
  } catch (error) {
    await FileSystem.deleteAsync(backupTemp ?? "", { idempotent: true }).catch(() => undefined);
    if (backupDir && backupReady) {
      try {
        await restoreDirectoryFromBackup(backupDir, liveDir);
      } catch (restoreError) {
        // Do not hide a failed restore: the durable marker/stage evidence must
        // remain for startup recovery to retry from the verified backup.
        throw new Error(`${String((error as any)?.message ?? error)}; 画像 rollback に失敗しました: ${String((restoreError as any)?.message ?? restoreError)}`);
      }
    } else if (!backupDir) {
      // New event had no prior live directory, therefore removing its partial
      // publish cannot destroy an old user file.
      await FileSystem.deleteAsync(liveDir, { idempotent: true });
    }
    throw error;
  }
}

async function restoreDirectoryFromBackup(backupDir: string, liveDir: string): Promise<void> {
  const backupInfo = await FileSystem.getInfoAsync(backupDir).catch(() => ({ exists: false } as any));
  if (!backupInfo.exists || !(backupInfo as any).isDirectory) throw new Error(`画像 backup がありません: ${backupDir}`);
  // Verify both the backup and a fresh temporary restore before touching live.
  const fingerprint = await listDirectoryFiles(backupDir);
  const restoreTemp = `${liveDir}.restore_${Date.now()}/`;
  await copyDirectoryVerified(backupDir, restoreTemp);
  const restoredFingerprint = await listDirectoryFiles(restoreTemp);
  if (JSON.stringify(fingerprint) !== JSON.stringify(restoredFingerprint)) {
    await FileSystem.deleteAsync(restoreTemp, { idempotent: true }).catch(() => undefined);
    throw new Error(`画像 backup restore の検証に失敗しました: ${backupDir}`);
  }
  await FileSystem.deleteAsync(liveDir, { idempotent: true });
  await FileSystem.moveAsync({ from: restoreTemp, to: liveDir });
}

const SHARED_CUT_SNAPSHOT_MANIFEST = "snapshot.json";

async function readSharedCutSnapshotManifest(backupDir: string): Promise<SharedCutSnapshotManifest | null> {
  try {
    const path = `${normalizeDir(backupDir)}${SHARED_CUT_SNAPSHOT_MANIFEST}`;
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists || (info as any).isDirectory) return null;
    const value = JSON.parse(await FileSystem.readAsStringAsync(path)) as Partial<SharedCutSnapshotManifest>;
    if (value.version !== 1 || !Array.isArray(value.entries) ||
        (value.previousFingerprint !== null && typeof value.previousFingerprint !== "string")) return null;
    for (const entry of value.entries) {
      if (!entry || typeof entry.relative !== "string" || basenameFromPath(entry.relative) !== entry.relative ||
          !isSafeArchivePath(entry.relative) || typeof entry.hadLive !== "boolean" ||
          typeof entry.size !== "number" || typeof entry.md5 !== "string") return null;
    }
    return value as SharedCutSnapshotManifest;
  } catch {
    return null;
  }
}

async function restoreSharedCutSnapshots(
  backupDir: string,
  entries: SharedCutSnapshotEntry[],
): Promise<void> {
  for (const entry of [...entries].reverse()) {
    if (!isSafeArchivePath(entry.relative) || basenameFromPath(entry.relative) !== entry.relative) {
      throw new Error("shared default cut snapshot path is unsafe");
    }
    const destination = `${normalizeDir(DEFAULT_CUTS_DIR)}${entry.relative}`;
    if (!isPathContainedBy(DEFAULT_CUTS_DIR, destination)) throw new Error("shared default cut restore path is unsafe");
    if (!entry.hadLive) {
      await FileSystem.deleteAsync(destination, { idempotent: true });
      continue;
    }
    const source = `${normalizeDir(backupDir)}files/${entry.relative}`;
    if (!isPathContainedBy(backupDir, source)) throw new Error("shared default cut backup path is unsafe");
    const sourceInfo = (await FileSystem.getInfoAsync(source, { md5: true } as any)) as any;
    if (!sourceInfo.exists || sourceInfo.isDirectory || Number(sourceInfo.size) !== entry.size ||
        String(sourceInfo.md5 ?? "").toLowerCase() !== entry.md5.toLowerCase()) {
      throw new Error(`shared default cut backup is corrupt: ${entry.relative}`);
    }
    await ensureDirectory(DEFAULT_CUTS_DIR);
    const staged = `${destination}.restore_${Date.now()}`;
    await FileSystem.copyAsync({ from: source, to: staged });
    const stagedInfo = (await FileSystem.getInfoAsync(staged, { md5: true } as any)) as any;
    if (!stagedInfo.exists || Number(stagedInfo.size) !== entry.size ||
        String(stagedInfo.md5 ?? "").toLowerCase() !== entry.md5.toLowerCase()) {
      await FileSystem.deleteAsync(staged, { idempotent: true }).catch(() => undefined);
      throw new Error(`shared default cut restore verification failed: ${entry.relative}`);
    }
    await FileSystem.deleteAsync(destination, { idempotent: true });
    await FileSystem.moveAsync({ from: staged, to: destination });
  }
}

/** Restore the shared circle-master/default-cut preimage captured for an
 * incremental import.  This is deliberately fail-closed: a missing verified
 * backup with a prior live tree is an error and leaves the journal/stage for a
 * startup retry instead of deleting the current files. */
async function restoreSharedSettingsSnapshot(
  database: SQLite.SQLiteDatabase,
  journal: ImportStageJournal,
): Promise<void> {
  if (journal.sharedCutsBackup && journal.sharedCutsBackupReady && journal.sharedCutSnapshots !== undefined) {
    const backupInfo = await FileSystem.getInfoAsync(journal.sharedCutsBackup);
    if (!backupInfo.exists || !(backupInfo as any).isDirectory) throw new Error("shared default cuts backup is missing");
    await restoreSharedCutSnapshots(journal.sharedCutsBackup, journal.sharedCutSnapshots);
  } else if (journal.sharedCutsBackup && journal.sharedCutsBackupReady) {
    // Backward-compatible recovery for journals written before per-file
    // snapshots were introduced.
    const backupInfo = await FileSystem.getInfoAsync(journal.sharedCutsBackup);
    if (!backupInfo.exists) {
      if (journal.sharedCutsHadLive) throw new Error("shared default cuts backup is missing");
      await FileSystem.deleteAsync(DEFAULT_CUTS_DIR, { idempotent: true });
    } else {
      await restoreDirectoryFromBackup(journal.sharedCutsBackup, DEFAULT_CUTS_DIR);
    }
  } else if (journal.sharedCutsHadLive) {
    throw new Error("shared default cuts backup marker is missing");
  } else if (journal.sharedCutsBackup) {
    await FileSystem.deleteAsync(DEFAULT_CUTS_DIR, { idempotent: true });
  }
  await database.withExclusiveTransactionAsync(async (txn) => {
    const tx = txn as unknown as SQLite.SQLiteDatabase;
    if (journal.sharedCircleMasterPrevious == null) {
      await tx.runAsync("DELETE FROM app_settings WHERE key = ?", "circle_master_json");
    } else {
      await tx.runAsync(
        "INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, ?)",
        "circle_master_json",
        journal.sharedCircleMasterPrevious,
      );
    }
    await tx.runAsync("DELETE FROM favorite_circles");
    for (const row of journal.sharedFavoritesPrevious ?? []) {
      await tx.runAsync("INSERT INTO favorite_circles(name, tag) VALUES (?, ?)", row.name, row.tag);
    }
    if (journal.sharedFingerprintPrevious == null) {
      await tx.runAsync("DELETE FROM app_settings WHERE key = ?", SHARED_BUNDLE_FINGERPRINT_KEY);
    } else {
      await tx.runAsync(
        "INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, ?)",
        SHARED_BUNDLE_FINGERPRINT_KEY,
        journal.sharedFingerprintPrevious,
      );
    }
  });
}

async function prepareSharedSettingsSnapshot(
  stageRoot: string,
  inspection: SharedBundleInspection,
): Promise<ImportStageJournal> {
  const sharedCutsBackup = `${normalizeDir(stageRoot)}__shared_cuts_old/`;
  const cutsInfo = await FileSystem.getInfoAsync(DEFAULT_CUTS_DIR);
  const sharedCutsHadLive = cutsInfo.exists;
  const sharedFingerprintPrevious = await getSetting(SHARED_BUNDLE_FINGERPRINT_KEY);
  const sharedCutSnapshots: SharedCutSnapshotEntry[] = [];
  await ensureDirectory(`${normalizeDir(sharedCutsBackup)}files/`);
  for (const plan of inspection.changedCuts) {
    if (!plan.hadExisting) {
      sharedCutSnapshots.push({ relative: plan.relative, size: 0, md5: "", hadLive: false });
      continue;
    }
    const current = (await FileSystem.getInfoAsync(plan.dest, { md5: true } as any)) as any;
    if (!current.exists || current.isDirectory || typeof current.size !== "number" ||
        typeof current.md5 !== "string" || !current.md5) {
      throw new Error(`shared default cut snapshot digest is missing: ${plan.relative}`);
    }
    const snapshot = {
      relative: plan.relative,
      size: Number(current.size),
      md5: String(current.md5).toLowerCase(),
      hadLive: true,
    };
    const backupPath = `${normalizeDir(sharedCutsBackup)}files/${plan.relative}`;
    await FileSystem.copyAsync({ from: plan.dest, to: backupPath });
    const copied = (await FileSystem.getInfoAsync(backupPath, { md5: true } as any)) as any;
    if (!copied.exists || Number(copied.size) !== snapshot.size ||
        String(copied.md5 ?? "").toLowerCase() !== snapshot.md5) {
      throw new Error(`shared default cut snapshot verification failed: ${plan.relative}`);
    }
    sharedCutSnapshots.push(snapshot);
  }
  const snapshotManifest: SharedCutSnapshotManifest = {
    version: 1,
    entries: sharedCutSnapshots,
    previousFingerprint: sharedFingerprintPrevious,
  };
  await FileSystem.writeAsStringAsync(
    `${normalizeDir(sharedCutsBackup)}${SHARED_CUT_SNAPSHOT_MANIFEST}`,
    JSON.stringify(snapshotManifest),
  );
  return {
    version: 1,
    phase: "staging",
    importedEventIds: [],
    published: [],
    sharedCutsBackup,
    sharedCutsHadLive,
    sharedCutsBackupReady: true,
    sharedSettingsIntent: true,
    sharedSettingsApplied: false,
    sharedCircleMasterPrevious: await getSetting("circle_master_json"),
    sharedFavoritesPrevious: (await getFavoriteCircles()).map((row) => ({ name: row.name, tag: row.tag })),
    sharedCutSnapshots,
    sharedFingerprintPrevious,
  };
}

async function rollbackPublishedImageDirs(published: PublishedImageDir[]): Promise<void> {
  for (const entry of [...published].reverse()) {
    const backupInfo = entry.backupDir
      ? await FileSystem.getInfoAsync(entry.backupDir).catch(() => ({ exists: false } as any))
      : ({ exists: false } as any);
    if (entry.backupDir && backupInfo.exists) {
      await restoreDirectoryFromBackup(entry.backupDir, entry.liveDir);
    } else if (entry.backupDir) {
      // Marker is written before copying the old live tree.  If the process
      // died in this intent window and the old live dir still exists, no
      // rollback is necessary yet; never delete it as if it were a new event.
      if (entry.phase === "backup_intent" && (await FileSystem.getInfoAsync(entry.liveDir).catch(() => ({ exists: false } as any))).exists) continue;
      throw new Error(`画像 rollback backup が見つかりません: ${entry.backupDir}`);
    } else if (!entry.backupDir) {
      await FileSystem.deleteAsync(entry.liveDir, { idempotent: true });
    }
  }
}

interface ChangedEventIdentityMap {
  stagedEventId: number;
  liveEventId: number;
  circleIds: Map<number, number>;
  itemIds: Map<number, number>;
}

function stableCompositeKey(...values: Array<string | null | undefined>): string {
  return values.map((value) => normalizePurchaseLookupKey(value)).join("|");
}

/**
 * Copy mobile-owned state onto the isolated staged graph. Desktop/incoming
 * columns and raw/root JSON stay authoritative. The returned one-to-one ID map
 * is applied only in the final deferred-FK publish transaction.
 */
async function reconcileChangedEventState(
  database: SQLite.SQLiteDatabase,
  stageRoot: string,
  stagedEventId: number,
  previousEventId: number,
): Promise<ChangedEventIdentityMap> {
  const previousEvent = await database.getFirstAsync<any>(
    `SELECT memo, completed, shopping_started_at, shopping_ended_at,
       event_image_filename FROM events WHERE id = ?`,
    previousEventId,
  );
  if (!previousEvent) throw new Error(`変更前イベントがありません: ${previousEventId}`);

  let localEventImage = previousEvent.event_image_filename as string | null;
  if (localEventImage) {
    const sourceInfo = await FileSystem.getInfoAsync(localEventImage);
    if (sourceInfo.exists && !(sourceInfo as any).isDirectory) {
      const localDir = `${normalizeDir(stageRoot)}${stagedEventId}/mobile-local/`;
      await ensureDirectory(localDir);
      const extension = extensionFromPath(localEventImage);
      const stagedLocalImage = `${localDir}event_image.${extension}`;
      await FileSystem.copyAsync({ from: localEventImage, to: stagedLocalImage });
      const copiedInfo = await FileSystem.getInfoAsync(stagedLocalImage);
      if (!copiedInfo.exists || (copiedInfo as any).size !== (sourceInfo as any).size) {
        throw new Error(`mobile event image staging の検証に失敗しました: ${previousEventId}`);
      }
      localEventImage = stagedLocalImage;
    }
  }

  const previousCircles = await database.getAllAsync<any>(
    `SELECT id, name, penname, space, raw_json, memo, checked, pin_x, pin_y,
       map_number, priority_color FROM circles WHERE event_id = ?`,
    previousEventId,
  );
  const stagedCircles = await database.getAllAsync<any>(
    "SELECT id, name, penname, space, raw_json FROM circles WHERE event_id = ?",
    stagedEventId,
  );
  const circleIds = matchStableIdentityRows(
    previousCircles.map((row) => ({
      id: Number(row.id),
      rawJson: row.raw_json,
      fallbackKey: stableCompositeKey(row.name, row.penname, row.space),
    })),
    stagedCircles.map((row) => ({
      id: Number(row.id),
      rawJson: row.raw_json,
      fallbackKey: stableCompositeKey(row.name, row.penname, row.space),
    })),
    "circle",
  );

  const itemIds = new Map<number, number>();
  for (const [stagedCircleId, previousCircleId] of circleIds) {
    const previousItems = await database.getAllAsync<any>(
      "SELECT id, name, raw_json, purchase_status, purchase_status_source FROM items WHERE circle_id = ?",
      previousCircleId,
    );
    const stagedItems = await database.getAllAsync<any>(
      "SELECT id, name, raw_json FROM items WHERE circle_id = ?",
      stagedCircleId,
    );
    const matches = matchStableIdentityRows(
      previousItems.map((row) => ({
        id: Number(row.id), rawJson: row.raw_json,
        fallbackKey: stableCompositeKey(row.name),
      })),
      stagedItems.map((row) => ({
        id: Number(row.id), rawJson: row.raw_json,
        fallbackKey: stableCompositeKey(row.name),
      })),
      "item",
    );
    for (const [stagedItemId, previousItemId] of matches) itemIds.set(stagedItemId, previousItemId);
  }

  await database.withExclusiveTransactionAsync(async (txn) => {
    const txDb = txn as unknown as SQLite.SQLiteDatabase;
    await txDb.runAsync(
      `UPDATE events SET memo = ?, completed = ?, shopping_started_at = ?,
         shopping_ended_at = ?, event_image_filename = ? WHERE id = ?`,
      previousEvent.memo ?? "",
      Number(previousEvent.completed ?? 0),
      previousEvent.shopping_started_at ?? null,
      previousEvent.shopping_ended_at ?? null,
      localEventImage,
      stagedEventId,
    );
    for (const [stagedCircleId, previousCircleId] of circleIds) {
      const previous = previousCircles.find((row) => Number(row.id) === previousCircleId);
      if (!previous) continue;
      await txDb.runAsync(
        `UPDATE circles SET memo = ?, checked = ?, pin_x = ?, pin_y = ?,
           map_number = ?, priority_color = ? WHERE id = ?`,
        previous.memo ?? "",
        Number(previous.checked ?? 0),
        previous.pin_x ?? null,
        previous.pin_y ?? null,
        previous.map_number ?? null,
        Number(previous.priority_color ?? 5),
        stagedCircleId,
      );
    }
    for (const [stagedItemId, previousItemId] of itemIds) {
      const previous = await txDb.getFirstAsync<any>(
        "SELECT purchase_status, purchase_status_source FROM items WHERE id = ?",
        previousItemId,
      );
      if (!previous) continue;
      await txDb.runAsync(
        "UPDATE items SET purchase_status = ?, purchase_status_source = ? WHERE id = ?",
        Number(previous.purchase_status ?? 0),
        previous.purchase_status_source ?? null,
        stagedItemId,
      );
    }
  });
  return { stagedEventId, liveEventId: previousEventId, circleIds, itemIds };
}

async function finalizeIncrementalDb(
  database: SQLite.SQLiteDatabase,
  stageRoot: string,
  publishIds: number[],
  deleteIds: number[],
  stableUidByEventId: Map<number, string>,
  changedIdentityByStagedId: Map<number, ChangedEventIdentityMap>,
): Promise<void> {
  await database.withExclusiveTransactionAsync(async (txn) => {
    const txDb = txn as unknown as SQLite.SQLiteDatabase;
    // Primary/FK identities are moved as one graph. SQLite checks the final
    // state at COMMIT, so no route can observe a half-renamed event graph.
    await txDb.execAsync("PRAGMA defer_foreign_keys = ON");
    // 旧 changed/missing 行を同一 transaction 内で削除してから、staging UID を
    // stable UID に昇格する。unique index により二重 live UID は残らない。
    for (const eventId of deleteIds) {
      if (itemFtsAvailable) {
        await txDb.runAsync(
          "DELETE FROM items_fts WHERE item_id IN (SELECT i.id FROM items i JOIN circles c ON c.id = i.circle_id WHERE c.event_id = ?)",
          eventId,
        );
      }
      await txDb.runAsync("DELETE FROM events WHERE id = ?", eventId);
      await txDb.runAsync("UPDATE sync_import_cleanup SET phase = 'finalized' WHERE event_id = ? AND stage_root = ?", eventId, stageRoot);
    }
    for (const stagedEventId of publishIds) {
      const identity = changedIdentityByStagedId.get(stagedEventId);
      const liveEventId = identity?.liveEventId ?? stagedEventId;
      if (itemFtsAvailable) {
        await txDb.runAsync(
          "DELETE FROM items_fts WHERE item_id IN (SELECT i.id FROM items i JOIN circles c ON c.id = i.circle_id WHERE c.event_id = ?)",
          stagedEventId,
        );
      }
      const stagedDir = `${normalizeDir(stageRoot)}${stagedEventId}/`;
      const liveDir = `${IMAGES_DIR}${liveEventId}/`;
      // New rows still point to stageRoot until all image copies have succeeded.
      // Rewrite every user-facing filename in one transaction immediately before
      // deleting changed/missing old rows.
      await txDb.runAsync(
        "UPDATE events SET event_image_filename = REPLACE(event_image_filename, ?, ?) WHERE id = ?",
        stagedDir,
        liveDir,
        stagedEventId,
      );
      await txDb.runAsync(
        "UPDATE event_maps SET filename = REPLACE(filename, ?, ?) WHERE event_id = ?",
        stagedDir,
        liveDir,
        stagedEventId,
      );
      await txDb.runAsync(
        "UPDATE circles SET circle_cut_filename = REPLACE(circle_cut_filename, ?, ?) WHERE event_id = ?",
        stagedDir,
        liveDir,
        stagedEventId,
      );
      await txDb.runAsync(
        "UPDATE item_images SET filename = REPLACE(filename, ?, ?) WHERE circle_id IN (SELECT id FROM circles WHERE event_id = ?)",
        stagedDir,
        liveDir,
        stagedEventId,
      );
      await txDb.runAsync(
        "UPDATE asset_local_map SET local_path = REPLACE(local_path, ?, ?) WHERE event_id = ?",
        stagedDir,
        liveDir,
        stagedEventId,
      );
      const stableUid = stableUidByEventId.get(stagedEventId);
      if (!stableUid) throw new Error(`staging UID がありません: ${stagedEventId}`);
      await txDb.runAsync("UPDATE events SET sync_uid = ? WHERE id = ?", stableUid, stagedEventId);

      if (identity) {
        await txDb.runAsync("UPDATE events SET id = ? WHERE id = ?", liveEventId, stagedEventId);
        await txDb.runAsync("UPDATE event_maps SET event_id = ? WHERE event_id = ?", liveEventId, stagedEventId);
        await txDb.runAsync("UPDATE circles SET event_id = ? WHERE event_id = ?", liveEventId, stagedEventId);
        await txDb.runAsync("UPDATE asset_local_map SET event_id = ? WHERE event_id = ?", liveEventId, stagedEventId);
        for (const [stagedCircleId, previousCircleId] of identity.circleIds) {
          await txDb.runAsync("UPDATE items SET circle_id = ? WHERE circle_id = ?", previousCircleId, stagedCircleId);
          await txDb.runAsync("UPDATE item_images SET circle_id = ? WHERE circle_id = ?", previousCircleId, stagedCircleId);
          await txDb.runAsync("UPDATE circles SET id = ? WHERE id = ?", previousCircleId, stagedCircleId);
        }
        for (const [stagedItemId, previousItemId] of identity.itemIds) {
          await txDb.runAsync("UPDATE items SET id = ? WHERE id = ?", previousItemId, stagedItemId);
        }
        await txDb.runAsync("UPDATE sync_import_staging SET event_id = ? WHERE event_id = ?", liveEventId, stagedEventId);
      }
      // durable marker は DB publish transaction と同時に更新する。プロセスが
      // この直後に落ちても startup recovery は finalized を forward-cleanup。
      await txDb.runAsync("UPDATE sync_import_staging SET phase = 'finalized' WHERE event_id = ?", liveEventId);
      if (itemFtsAvailable) {
        await txDb.runAsync(
          `INSERT INTO items_fts(name, description, item_id)
           SELECT i.name, COALESCE(i.description, ''), i.id FROM items i
           JOIN circles c ON c.id = i.circle_id WHERE c.event_id = ?`,
          liveEventId,
        );
      }
    }
  });
}

async function finalizeLegacyFullImport(
  extractDir: string,
  events: SyncManifestEvent[],
  onProgress?: (progress: ImportProgress) => void,
  rootAssetManifest?: AssetManifest | null,
): Promise<{ lastEventId: number; importedEventIds: number[] }> {
  // legacy manifest でも reset を先行させず、temp DB/image を検証・構築してから
  // publish する。既存 live は最後まで閉じず、失敗時にも保持する。
  const stageRoot = createImageStageRoot();
  const stageDatabaseName = `eventtrail_legacy_stage_${Date.now()}.db`;
  const stageDb = instrumentDatabase(await SQLite.openDatabaseAsync(stageDatabaseName));
  const previousDb = db;
  const previousPromise = dbInitPromise;
  const oldImagesBackup = `${normalizeDir(FileSystem.cacheDirectory ?? stageRoot)}eventtrail_legacy_old_live_${Date.now()}/`;
  const legacyCutsStage = `${normalizeDir(stageRoot)}__legacy_cuts/`;
  const oldCutsBackup = `${normalizeDir(FileSystem.cacheDirectory ?? stageRoot)}eventtrail_legacy_old_cuts_${Date.now()}/`;
  const legacyDbBackupName = `eventtrail_legacy_old_${Date.now()}.db`;
  const legacyImagesStage = `${normalizeDir(stageRoot)}__legacy_live/`;
  let lastEventId: number | null = null;
  const importedEventIds: number[] = [];
  const bootstrapBookkeeping = buildLegacyBootstrapBookkeeping(events.map((event) => ({
    syncUid: manifestUid(event),
    contentHash: manifestContentHash(event),
    assetSetHash: manifestAssetHash(event),
  })));
  let imagesPublished = false;
  let imagesPublishAttempted = false;
  let legacyPhase = "staging";
  let legacyRollbackCompleted = false;
  let legacyFinalized = false;
  let legacyCutsPublished = false;
  let cutsPublishAttempted = false;
  let legacyCutsRollbackCompleted = false;
  const legacyHadLiveImages = (await FileSystem.getInfoAsync(IMAGES_DIR)).exists;
  const legacyHadLiveCuts = (await FileSystem.getInfoAsync(DEFAULT_CUTS_DIR)).exists;
  let legacyDbBackupReady = false;
  let legacyImagesBackupReady = false;
  let legacyCutsBackupReady = false;
  let legacyDestination: SQLite.SQLiteDatabase | null = null;
  let dbPublishAttempted = false;
  let dbRestoreVerified = false;
  let dbRestoreFailed = false;
  let dbRestoredToOld = false;
  await ensureDirectory(stageRoot);
  try {
    // A durable journal is mandatory before any stage mutation.  If writing it
    // fails, catch/finally closes the temporary DB while preserving the stage
    // directory for an explicit retry.
    await writeImportStageJournal(stageRoot, {
      version: 1,
      kind: "legacy",
      phase: legacyPhase,
      importedEventIds: [],
      published: [],
      legacyDbBackupName,
      legacyStageDbName: stageDatabaseName,
      legacyImagesBackup: oldImagesBackup,
      legacyHadLiveImages,
      legacyDbBackupReady,
      legacyImagesBackupReady,
      legacyCutsStage,
      legacyCutsBackup: oldCutsBackup,
      legacyHadLiveCuts,
      legacyCutsBackupReady,
      legacyCutsPublished,
    });
    // Stage DB の schema を init するため一時的に db 参照を差し替える。
    db = stageDb;
    dbInitPromise = Promise.resolve(stageDb);
    // Row-id seeds are scoped to a SQLite file; never carry a temporary stage
    // DB's max id into the live DB (or vice versa) across a full-sync swap.
    importRowIdSeeds.clear();
    // Temporary legacy DB must not attempt to recover the stage root it is
    // currently constructing; only the live DB performs startup recovery.
    await initDatabase(stageDb, { recover: false });
    await ensureDirectory(stageRoot);
    for (let i = 0; i < events.length; i++) {
      onProgress?.({ current: i + 1, total: events.length, phase: "events" });
      lastEventId = await importEventFromExtractDir(
        eventDirFromManifestPath(extractDir, events[i].path),
        onProgress,
        events[i],
        stageRoot,
        `__legacy_stage__${Date.now()}_${i}`,
        null,
        stageRoot,
        scopeAssetManifest(rootAssetManifest ?? null, events[i].path, manifestUid(events[i])),
      );
      importedEventIds.push(lastEventId);
      await writeImportStageJournal(stageRoot, {
        version: 1,
        kind: "legacy",
        phase: legacyPhase,
        importedEventIds: [...importedEventIds],
        published: [],
        legacyDbBackupName,
        legacyStageDbName: stageDatabaseName,
        legacyImagesBackup: oldImagesBackup,
        legacyCutsStage,
        legacyCutsBackup: oldCutsBackup,
        legacyHadLiveCuts,
        legacyCutsBackupReady,
        legacyCutsPublished,
        legacyHadLiveImages,
      });
    }
    if (lastEventId == null) throw new Error("同期ZIPにイベントが含まれていません");

    // Stage DB が持つ画像参照を live root へ rewrite してから、画像 publish と
    // SQLite backup を順序付ける。旧 live 画像は backup して failure で戻す。
    await stageDb.runAsync("UPDATE events SET event_image_filename = REPLACE(event_image_filename, ?, ?) WHERE event_image_filename LIKE ?", stageRoot, IMAGES_DIR, `${stageRoot}%`);
    await stageDb.runAsync("UPDATE event_maps SET filename = REPLACE(filename, ?, ?) WHERE filename LIKE ?", stageRoot, IMAGES_DIR, `${stageRoot}%`);
    await stageDb.runAsync("UPDATE circles SET circle_cut_filename = REPLACE(circle_cut_filename, ?, ?) WHERE circle_cut_filename LIKE ?", stageRoot, IMAGES_DIR, `${stageRoot}%`);
    await stageDb.runAsync("UPDATE item_images SET filename = REPLACE(filename, ?, ?) WHERE filename LIKE ?", stageRoot, IMAGES_DIR, `${stageRoot}%`);
    await stageDb.runAsync("UPDATE asset_local_map SET local_path = REPLACE(local_path, ?, ?) WHERE local_path LIKE ?", stageRoot, IMAGES_DIR, `${stageRoot}%`);
    if (importedEventIds.length !== bootstrapBookkeeping.length) {
      throw new Error("full bootstrap manifest/event mapping mismatch");
    }
    // Synthetic UIDs remain only in sync_import_staging as durable transaction
    // bookkeeping.  A complete unique v2 manifest promotes every staged event
    // row to its real UID/hash before the atomic DB publish, so the next same
    // bundle is incremental/unchanged.  Old or partial manifests deliberately
    // publish every row with NULL bookkeeping and retain the safe full fallback.
    await stageDb.withExclusiveTransactionAsync(async (txn) => {
      for (let index = 0; index < importedEventIds.length; index += 1) {
        const eventId = importedEventIds[index];
        const bookkeeping = bootstrapBookkeeping[index];
        await txn.runAsync(
          "UPDATE events SET sync_uid = ?, content_hash = ?, asset_set_hash = ? WHERE id = ?",
          bookkeeping?.syncUid ?? null,
          bookkeeping?.contentHash ?? null,
          bookkeeping?.assetSetHash ?? null,
          eventId,
        );
      }
    });
    // Shared settings are validated and committed to the temporary DB before
    // any live image/DB publish.  A failure therefore leaves live state
    // untouched and is compensated by importSharedBundleSettings itself.
    await importSharedBundleSettings(extractDir, legacyCutsStage);
    const liveInfo = await FileSystem.getInfoAsync(IMAGES_DIR);
    // Always snapshot the current live SQLite file, even when the module had
    // not initialized `db` yet.  Opening DB_NAME here creates an empty but
    // integrity-checkable preimage on a fresh install and avoids a publish
    // failure window with no same-process restore source.
    const destination = previousDb ?? await SQLite.openDatabaseAsync(DB_NAME);
    legacyDestination = destination;
    {
      const oldDb = await SQLite.openDatabaseAsync(legacyDbBackupName);
      await SQLite.backupDatabaseAsync({ sourceDatabase: rawDatabase(destination), destDatabase: oldDb });
      const integrity = await oldDb.getFirstAsync<{ integrity_check: string }>("PRAGMA integrity_check");
      await oldDb.closeAsync();
      if (integrity?.integrity_check !== "ok") throw new Error("legacy DB backup integrity check failed");
      legacyDbBackupReady = true;
    }
    legacyPhase = "image_publish_intent";
    await writeImportStageJournal(stageRoot, {
      version: 1,
      kind: "legacy",
      phase: legacyPhase,
      importedEventIds: [...importedEventIds],
      published: [],
      legacyDbBackupName,
      legacyStageDbName: stageDatabaseName,
      legacyImagesBackup: oldImagesBackup,
      legacyCutsStage,
      legacyCutsBackup: oldCutsBackup,
      legacyHadLiveCuts,
      legacyCutsBackupReady,
      legacyCutsPublished,
      legacyHadLiveImages,
      legacyDbBackupReady,
      legacyImagesBackupReady,
    });
    if (liveInfo.exists) {
      const oldBackupTemp = `${oldImagesBackup}.tmp`;
      await copyDirectoryVerified(IMAGES_DIR, oldBackupTemp);
      await FileSystem.moveAsync({ from: oldBackupTemp, to: oldImagesBackup });
      legacyImagesBackupReady = true;
    }
    const cutsStageInfo = await FileSystem.getInfoAsync(legacyCutsStage);
    if (cutsStageInfo.exists && (cutsStageInfo as any).isDirectory) {
      // Keep the old default-cut tree in place while the staged tree is being
      // verified.  A verified copy is the durable rollback preimage; only
      // after its marker is written do we remove the old live tree.
      if (legacyHadLiveCuts) {
        const oldCutsBackupTemp = `${oldCutsBackup}.tmp`;
        await copyDirectoryVerified(DEFAULT_CUTS_DIR, oldCutsBackupTemp);
        await FileSystem.moveAsync({ from: oldCutsBackupTemp, to: oldCutsBackup });
        legacyCutsBackupReady = true;
      }
      await writeImportStageJournal(stageRoot, {
        version: 1,
        kind: "legacy",
        phase: legacyPhase,
        importedEventIds: [...importedEventIds],
        published: [],
        legacyDbBackupName,
        legacyStageDbName: stageDatabaseName,
        legacyImagesBackup: oldImagesBackup,
        legacyCutsStage,
        legacyCutsBackup: oldCutsBackup,
        legacyHadLiveCuts,
        legacyCutsBackupReady,
        legacyCutsPublished,
        legacyHadLiveImages,
        legacyDbBackupReady,
        legacyImagesBackupReady,
      });
    }
    // Both rollback preimages are now fully verified.  Persist readiness
    // before deleting or moving either live tree; a kill after this marker can
    // always restore the old images/cuts from their complete backups.
    await writeImportStageJournal(stageRoot, {
      version: 1,
      kind: "legacy",
      phase: legacyPhase,
      importedEventIds: [...importedEventIds],
      published: [],
      legacyDbBackupName,
      legacyStageDbName: stageDatabaseName,
      legacyImagesBackup: oldImagesBackup,
      legacyCutsStage,
      legacyCutsBackup: oldCutsBackup,
      legacyHadLiveCuts,
      legacyCutsBackupReady,
      legacyCutsPublished,
      legacyHadLiveImages,
      legacyDbBackupReady,
      legacyImagesBackupReady,
    });
    // Build/verify the complete new image tree before touching live.  A copy
    // failure cannot leave a half-published IMAGES_DIR.
      await FileSystem.deleteAsync(legacyImagesStage, { idempotent: true });
      await copyStagedEventDirectories(stageRoot, legacyImagesStage);
    imagesPublishAttempted = true;
      await FileSystem.deleteAsync(IMAGES_DIR, { idempotent: true });
    await FileSystem.moveAsync({ from: legacyImagesStage, to: IMAGES_DIR });
    imagesPublished = true;
    if (cutsStageInfo.exists && (cutsStageInfo as any).isDirectory) {
      const cutsLiveStage = `${normalizeDir(stageRoot)}__legacy_cuts_live/`;
      await FileSystem.deleteAsync(cutsLiveStage, { idempotent: true });
      await copyDirectoryVerified(legacyCutsStage, cutsLiveStage);
      cutsPublishAttempted = true;
      await FileSystem.deleteAsync(DEFAULT_CUTS_DIR, { idempotent: true });
      await FileSystem.moveAsync({ from: cutsLiveStage, to: DEFAULT_CUTS_DIR });
      const publishedCutsInfo = await FileSystem.getInfoAsync(DEFAULT_CUTS_DIR);
      if (!publishedCutsInfo.exists || !(publishedCutsInfo as any).isDirectory) throw new Error("default cuts publish に失敗しました");
      legacyCutsPublished = true;
    }
    legacyPhase = "images_published";
    await writeImportStageJournal(stageRoot, {
      version: 1,
      kind: "legacy",
      phase: legacyPhase,
      importedEventIds: [...importedEventIds],
      published: [],
      legacyDbBackupName,
      legacyStageDbName: stageDatabaseName,
      legacyImagesBackup: oldImagesBackup,
      legacyCutsStage,
      legacyCutsBackup: oldCutsBackup,
      legacyHadLiveCuts,
      legacyCutsBackupReady,
      legacyCutsPublished,
      legacyHadLiveImages,
      legacyDbBackupReady,
      legacyImagesBackupReady,
    });
    legacyPhase = "db_publish_intent";
    await writeImportStageJournal(stageRoot, {
      version: 1,
      kind: "legacy",
      phase: legacyPhase,
      importedEventIds: [...importedEventIds],
      published: [],
      legacyDbBackupName,
      legacyStageDbName: stageDatabaseName,
      legacyImagesBackup: oldImagesBackup,
      legacyCutsStage,
      legacyCutsBackup: oldCutsBackup,
      legacyHadLiveCuts,
      legacyCutsBackupReady,
      legacyCutsPublished,
      legacyHadLiveImages,
      legacyDbBackupReady,
      legacyImagesBackupReady,
    });
    // The staging rows are durable in the temporary DB before SQLite backup.
    // If the process dies after DB copy but before journal update, recovery sees
    // all-finalized rows in the live DB and forwards cleanup safely.
    await stageDb.runAsync("UPDATE sync_import_staging SET phase = 'finalized' WHERE stage_root = ?", stageRoot);
    dbPublishAttempted = true;
    await SQLite.backupDatabaseAsync({ sourceDatabase: rawDatabase(stageDb), destDatabase: rawDatabase(destination) });
    legacyPhase = "db_published";
    await writeImportStageJournal(stageRoot, {
      version: 1,
      kind: "legacy",
      phase: legacyPhase,
      importedEventIds: [...importedEventIds],
      published: [],
      legacyDbBackupName,
      legacyStageDbName: stageDatabaseName,
      legacyImagesBackup: oldImagesBackup,
      legacyCutsStage,
      legacyCutsBackup: oldCutsBackup,
      legacyHadLiveCuts,
      legacyCutsBackupReady,
      legacyCutsPublished,
      legacyHadLiveImages,
      legacyDbBackupReady,
      legacyImagesBackupReady,
    });
    db = instrumentDatabase(destination);
    dbInitPromise = Promise.resolve(db);
    importRowIdSeeds.clear();
    await destination.runAsync("DELETE FROM sync_import_staging WHERE stage_root = ?", stageRoot);
    legacyPhase = "finalized";
    await writeImportStageJournal(stageRoot, {
      version: 1,
      kind: "legacy",
      phase: legacyPhase,
      importedEventIds: [...importedEventIds],
      published: [],
      legacyDbBackupName,
      legacyStageDbName: stageDatabaseName,
      legacyImagesBackup: oldImagesBackup,
      legacyCutsStage,
      legacyCutsBackup: oldCutsBackup,
      legacyHadLiveCuts,
      legacyCutsBackupReady,
      legacyCutsPublished,
      legacyHadLiveImages,
      legacyDbBackupReady,
      legacyImagesBackupReady,
    });
    legacyFinalized = true;
    return { lastEventId, importedEventIds: [...importedEventIds] };
  } catch (error) {
    let dbRestoreError: unknown = null;
    let rollbackIntentWritten = false;
    // Record rollback intent before touching the old DB.  If the process dies
    // during the backup restore, startup sees this marker and retries the
    // complete all-old rollback instead of forwarding a mixed state.
    try {
      await writeImportStageJournal(stageRoot, {
        version: 1,
        kind: "legacy",
        phase: "rolled_back",
        importedEventIds: [...importedEventIds],
        published: [],
        legacyDbBackupName,
        legacyStageDbName: stageDatabaseName,
        legacyImagesBackup: oldImagesBackup,
        legacyCutsStage,
        legacyCutsBackup: oldCutsBackup,
        legacyHadLiveCuts,
        legacyCutsBackupReady,
        legacyCutsPublished,
        legacyHadLiveImages,
        legacyDbBackupReady,
        legacyImagesBackupReady,
      });
      rollbackIntentWritten = true;
    } catch {
      throw new Error(`${String((error as any)?.message ?? error)}; legacy rollback intent journal failed`);
    }
    if (!rollbackIntentWritten) throw new Error("legacy rollback intent marker missing");
    if (dbPublishAttempted && legacyDestination && legacyDbBackupReady) {
      try {
        const backupDb = await SQLite.openDatabaseAsync(legacyDbBackupName);
        const backupCheck = await backupDb.getFirstAsync<{ integrity_check: string }>("PRAGMA integrity_check");
        if (backupCheck?.integrity_check !== "ok") throw new Error("legacy DB backup is corrupt");
      await SQLite.backupDatabaseAsync({ sourceDatabase: backupDb, destDatabase: rawDatabase(legacyDestination) });
        const restoredCheck = await legacyDestination.getFirstAsync<{ integrity_check: string }>("PRAGMA integrity_check");
        await backupDb.closeAsync();
        if (restoredCheck?.integrity_check !== "ok") throw new Error("legacy DB restore integrity check failed");
        dbRestoreVerified = true;
        dbRestoredToOld = true;
      } catch (restoreError) {
        dbRestoreError = restoreError;
        dbRestoreFailed = true;
        db = null;
        dbInitPromise = null;
      }
    }
    if (!dbPublishAttempted && legacyDestination && legacyDestination !== previousDb) {
      await legacyDestination.closeAsync().catch(() => undefined);
    }
    await stageDb.closeAsync().catch(() => undefined);
    let imagesRollbackOk = !imagesPublished;
    const shouldRestorePublishedFiles = shouldRollbackPublishedFiles(
      dbRestoredToOld,
      legacyPhase as "staging" | "image_publish_intent" | "images_published" | "db_publish_intent" | "db_published" | "finalized",
      imagesPublished || imagesPublishAttempted,
    );
    if (shouldRestorePublishedFiles) {
      try {
        const backupInfo = await FileSystem.getInfoAsync(oldImagesBackup);
        if (backupInfo.exists) {
          await restoreDirectoryFromBackup(oldImagesBackup, IMAGES_DIR);
        } else {
          // No prior live tree: deleting the newly published tree is safe only
          // after the publish state is known and the delete itself succeeds.
          await FileSystem.deleteAsync(IMAGES_DIR, { idempotent: true });
        }
        imagesRollbackOk = true;
      } catch (restoreError) {
        // Preserve stage, backup and journal evidence for startup retry.
        db = previousDb;
        dbInitPromise = previousPromise;
        throw new Error(`${String((error as any)?.message ?? error)}; legacy image rollback failed: ${String((restoreError as any)?.message ?? restoreError)}`);
      }
    }
    let cutsRollbackOk = !cutsPublishAttempted;
    if (shouldRollbackPublishedFiles(
      dbRestoredToOld,
      legacyPhase as "staging" | "image_publish_intent" | "images_published" | "db_publish_intent" | "db_published" | "finalized",
      cutsPublishAttempted,
    )) {
      try {
        const cutsBackupInfo = await FileSystem.getInfoAsync(oldCutsBackup);
        if (cutsBackupInfo.exists && legacyCutsBackupReady) {
          await restoreDirectoryFromBackup(oldCutsBackup, DEFAULT_CUTS_DIR);
        } else if (legacyHadLiveCuts) {
          throw new Error("legacy default cuts backup is missing");
        } else {
          await FileSystem.deleteAsync(DEFAULT_CUTS_DIR, { idempotent: true });
        }
        cutsRollbackOk = true;
        legacyCutsRollbackCompleted = true;
      } catch (restoreError) {
        db = previousDb;
        dbInitPromise = previousPromise;
        throw new Error(`${String((error as any)?.message ?? error)}; legacy default cuts rollback failed: ${String((restoreError as any)?.message ?? restoreError)}`);
      }
    }
    legacyRollbackCompleted = imagesRollbackOk && cutsRollbackOk;
    if (dbRestoreError) {
      throw new Error(`${String((error as any)?.message ?? error)}; DB rollback failed: ${String((dbRestoreError as any)?.message ?? dbRestoreError)}`);
    }
    db = previousDb;
    dbInitPromise = previousPromise;
    importRowIdSeeds.clear();
    throw error;
  } finally {
    await stageDb.closeAsync().catch(() => undefined);
    if (legacyFinalized || (legacyRollbackCompleted && !dbRestoreFailed && (!dbPublishAttempted || dbRestoreVerified))) {
      await FileSystem.deleteAsync(stageRoot, { idempotent: true });
      await FileSystem.deleteAsync(oldImagesBackup, { idempotent: true });
      await FileSystem.deleteAsync(oldCutsBackup, { idempotent: true });
      await FileSystem.deleteAsync(legacyCutsStage, { idempotent: true });
      await SQLite.deleteDatabaseAsync(stageDatabaseName).catch(() => undefined);
      await SQLite.deleteDatabaseAsync(legacyDbBackupName).catch(() => undefined);
    }
  }
}

async function copyExportFile(sourcePath: string, destPath: string): Promise<boolean> {
  try {
    const fileInfo = await FileSystem.getInfoAsync(sourcePath);
    if (!fileInfo.exists) return false;
    await ensureDirectory(destPath.slice(0, destPath.lastIndexOf("/") + 1));
    await FileSystem.deleteAsync(destPath, { idempotent: true });
    await FileSystem.copyAsync({ from: sourcePath, to: destPath });
    return true;
  } catch (e) {
    console.warn("export file copy skipped:", sourcePath, e);
    return false;
  }
}

function normalizeArchivePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function isSafeArchivePath(path: string): boolean {
  // raw 値のまま検証してから normalize する。先に先頭 slash を削ると
  // `/tmp/x`, `\\\\server\\x`, `C:foo` を相対 path と誤認してしまう。
  return isSafeRelativeArchivePath(path);
}

function resolveExtractedPath(extractDir: string, relativePath: string): string | null {
  if (!isSafeArchivePath(relativePath)) return null;
  const normalized = normalizeArchivePath(relativePath);
  const candidate = `${normalizeDir(extractDir)}${normalized}`;
  return isPathContainedBy(extractDir, candidate) ? candidate : null;
}

function extensionFromPath(path: string): string {
  const base = basenameFromPath(path);
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
  return ext.match(/^[a-z0-9]+$/) ? ext : "bin";
}

async function readAssetManifest(extractDir: string): Promise<AssetManifest | null> {
  try {
    const text = await FileSystem.readAsStringAsync(
      `${extractDir}asset_manifest.json`,
    );
    const parsed = JSON.parse(text) as AssetManifest;
    return parsed && typeof parsed === "object" &&
      ((parsed.aliases && typeof parsed.aliases === "object") ||
       (parsed.assets && typeof parsed.assets === "object") ||
       (parsed.events && typeof parsed.events === "object"))
      ? {
          ...parsed,
          // A root full-sync manifest advertises events/manifest_version; its
          // v2 hash records are mandatory.  Per-event legacy manifests remain
          // permissive for backward compatibility.
          strict: !!(parsed.events || Number((parsed as any).manifest_version ?? 0) >= 2),
        } : null;
  } catch {
    return null;
  }
}

function canonicalEventImageLogical(value: string): string {
  const normalized = normalizeArchivePath(value);
  return normalized.toLowerCase().startsWith("event_image/")
    ? `event_image/${basenameFromPath(normalized)}`
    : `event_image/${basenameFromPath(normalized)}`;
}

/** Scope a full-sync root manifest (whose paths are events/<slug>/...) to the
 * event directory passed to the importer.  Missing/hashless v2 entries are
 * marked strict so validation fails closed instead of accepting an unchecked
 * same-size local file. */
function scopeAssetManifest(
  root: AssetManifest | null,
  eventPath: string,
  eventUid?: string | null,
): AssetManifest | null {
  if (!root) return null;
  const normalizedEvent = normalizeArchivePath(eventPath);
  const prefix = normalizedEvent.replace(/event\.json$/, "");
  const scoped: AssetManifest = {
    format: root.format,
    format_version: root.format_version,
    assets: {},
    aliases: {},
    strict: !!root.strict,
  };
  const eventRecord = eventUid ? root.events?.[eventUid] : undefined;
  const candidates = eventRecord?.assets ?? Object.values(root.assets ?? {});
  let matched = 0;
  for (const [key, original] of Object.entries(root.assets ?? {})) {
    const paths = [
      ...(original.path ? [original.path] : []),
      ...(original.paths ?? []),
      ...(original.original_names ?? []),
    ].filter((path) => isSafeArchivePath(path));
    const selected = paths.filter((path) => normalizeArchivePath(path).startsWith(prefix));
    if (!selected.length) continue;
    const rel = selected.map((path) => normalizeArchivePath(path).slice(prefix.length)).filter(Boolean);
    if (!rel.length) continue;
    scoped.assets![key] = {
      ...original,
      path: rel[0],
      paths: rel,
      original_names: rel,
    };
    matched += rel.length;
    for (const logical of rel) {
      const full = `${prefix}${logical}`;
      const alias = root.aliases?.[full];
      if (alias && isSafeArchivePath(alias)) {
        const normalizedAlias = normalizeArchivePath(alias);
        scoped.aliases![logical] = normalizedAlias.startsWith(prefix)
          ? normalizedAlias.slice(prefix.length)
          : normalizedAlias;
      } else {
        scoped.aliases![logical] = logical;
      }
    }
  }
  // If a per-event record exists, include its entries even when root.assets is
  // keyed differently.  This also handles manifests emitted by older desktop
  // builds that only populated events[uid].assets.
  for (const original of candidates) {
    const fullPath = original.path ?? original.paths?.[0] ?? original.original_names?.[0];
    if (!fullPath || !isSafeArchivePath(fullPath)) continue;
    const normalized = normalizeArchivePath(fullPath);
    // `events[uid].assets` emitted by newer desktop builds is already
    // event-relative, while legacy root `assets` entries use events/<slug>/.
    const logical = normalized.startsWith(prefix)
      ? normalized.slice(prefix.length)
      : eventRecord
        ? normalized
        : "";
    if (!logical) continue;
    const key = `event:${logical}`;
    scoped.assets![key] = { ...original, path: logical, paths: [logical], original_names: [logical] };
    scoped.aliases![logical] = logical;
    matched += 1;
  }
  if (root.strict && matched === 0) return { ...scoped, strict: true };
  return scoped;
}

interface ResolvedImportedAsset {
  path: string;
  /** Logical archive path that was actually matched in the manifest. */
  logicalPath: string;
}

function manifestLogicalPathForCandidate(
  manifest: AssetManifest | null,
  candidate: string,
): string {
  // Keep the archive's logical name, not the content-addressed alias path.
  // `asset_manifest.aliases` can map `items/catalog.jpg` to an opaque
  // `assets/md5/...` path; persisting that alias would make future health
  // checks unable to match the event.json reference (and collide when several
  // logical names share one content hash).
  return normalizeArchivePath(candidate);
}

async function resolveImportedAsset(
  extractDir: string,
  manifest: AssetManifest | null,
  candidates: Array<string | undefined | null>,
): Promise<ResolvedImportedAsset | null> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    // alias 解決前に raw candidate を拒否する。normalizeArchivePath は
    // 先頭 slash を落とすため、必ず isSafeArchivePath を先に呼ぶ。
    if (!isSafeArchivePath(candidate)) continue;
    const logical = normalizeArchivePath(candidate);
    const direct = resolveExtractedPath(extractDir, candidate);
    if (!direct) continue;
    const directInfo = await FileSystem.getInfoAsync(direct);
    if (directInfo.exists && await validateImportedAsset(direct, logical, manifest)) {
      return { path: direct, logicalPath: manifestLogicalPathForCandidate(manifest, logical) };
    }

    const alias = manifest?.aliases?.[logical];
    if (!alias || !isSafeArchivePath(alias)) continue;
    const assetPath = resolveExtractedPath(extractDir, alias);
    if (!assetPath) continue;
    const assetInfo = await FileSystem.getInfoAsync(assetPath);
    if (assetInfo.exists && await validateImportedAsset(assetPath, logical, manifest)) {
      return { path: assetPath, logicalPath: manifestLogicalPathForCandidate(manifest, logical) };
    }
  }
  return null;
}

function decodeBase64(value: string): Uint8Array | null {
  // Avoid relying on a Node `Buffer` or a platform-specific atob polyfill.
  // Expo's legacy FileSystem can return base64 for binary files, so decode in
  // small, deterministic JS code before feeding the dependency-free SHA-256.
  const text = value.replace(/\s+/g, "");
  if (!text || text.length % 4 === 1) return null;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = new Uint8Array(Math.floor(text.length * 3 / 4) - (text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0));
  let out = 0;
  for (let i = 0; i < text.length; i += 4) {
    const a = alphabet.indexOf(text[i] ?? "-");
    const b = alphabet.indexOf(text[i + 1] ?? "-");
    const c = text[i + 2] === "=" ? 0 : alphabet.indexOf(text[i + 2] ?? "-");
    const d = text[i + 3] === "=" ? 0 : alphabet.indexOf(text[i + 3] ?? "-");
    if (a < 0 || b < 0 || c < 0 || d < 0) return null;
    const word = (a << 18) | (b << 12) | (c << 6) | d;
    if (out < bytes.length) bytes[out++] = (word >>> 16) & 0xff;
    if (out < bytes.length) bytes[out++] = (word >>> 8) & 0xff;
    if (out < bytes.length) bytes[out++] = word & 0xff;
  }
  return bytes;
}

async function readSha256File(path: string): Promise<string | null> {
  try {
    const encoded = await FileSystem.readAsStringAsync(path, {
      encoding: (FileSystem as any).EncodingType?.Base64 ?? "base64",
    } as any);
    const bytes = decodeBase64(encoded);
    return bytes ? sha256Hex(bytes) : null;
  } catch {
    // If a platform cannot read binary base64, callers must reject a sha256
    // manifest rather than silently treating a same-size corrupt file as good.
    return null;
  }
}
const sha256FileCache = new Map<string, string>();

async function validateImportedAsset(
  path: string,
  logicalPath: string,
  manifest: AssetManifest | null,
): Promise<boolean> {
  if (!manifest) return true;
  const alias = manifest.aliases?.[logicalPath];
  if (alias && !isSafeArchivePath(alias)) return false;
  if (!isSafeArchivePath(logicalPath)) return false;
  const assetPath = alias ? normalizeArchivePath(alias) : normalizeArchivePath(logicalPath);
  const entry = Object.values(manifest.assets ?? {}).find(
    (candidate) =>
      (candidate.path && isSafeArchivePath(candidate.path) && normalizeArchivePath(candidate.path) === assetPath) ||
      (candidate.paths ?? []).some((path) => isSafeArchivePath(path) && normalizeArchivePath(path) === assetPath),
  );
  if (!entry) return !manifest.strict;
  const info = (await FileSystem.getInfoAsync(path, { md5: true } as any)) as any;
  if (typeof entry.size === "number" && (typeof info.size !== "number" || info.size !== entry.size)) return false;
  if (!entry.hash) return !manifest.strict;
  const algorithm = String(entry.algorithm ?? "md5").toLowerCase().replace(/[-_]/g, "");
  if (algorithm === "md5") {
    // Expo's md5 metadata is available without loading the whole image.
    return !!info.md5 && String(info.md5).toLowerCase() === String(entry.hash).toLowerCase();
  }
  if (algorithm === "sha256") {
    const cacheKey = `${path}|${String(info.size ?? "")}|${String(info.md5 ?? "")}`;
    const digest = sha256FileCache.get(cacheKey) ?? await readSha256File(path);
    if (digest) {
      if (sha256FileCache.size >= 2048) sha256FileCache.delete(sha256FileCache.keys().next().value as string);
      sha256FileCache.set(cacheKey, digest);
    }
    // Unsupported/failed reads are deliberately fail-closed.
    return !!digest && digest.toLowerCase() === String(entry.hash).toLowerCase();
  }
  // Unknown digest algorithms cannot be verified on all Expo runtimes.
  return false;
}

const IMPORT_ASSET_CACHE_DIR = `${FileSystem.documentDirectory}asset_cache/`;

/** content-addressed import cache。manifest alias が同一でも毎回 source→event
 * を読み直さず、端末内 cache から stage へ複製する。cache は共有なので event
 * 削除時に消さない。 */
async function copyImportedAssetCached(sourcePath: string, destinationPath: string): Promise<void> {
  const info = (await FileSystem.getInfoAsync(sourcePath, { md5: true } as any)) as any;
  const md5 = typeof info.md5 === "string" && info.md5 ? info.md5.toLowerCase() : null;
  if (!md5) {
    await FileSystem.copyAsync({ from: sourcePath, to: destinationPath });
    const destinationInfo = await FileSystem.getInfoAsync(destinationPath);
    if (!destinationInfo.exists || (typeof info.size === "number" && destinationInfo.size !== info.size)) {
      await FileSystem.deleteAsync(destinationPath, { idempotent: true });
      throw new Error(`import asset copy size verification failed: ${destinationPath}`);
    }
    return;
  }
  const extension = extensionFromPath(sourcePath);
  const cachePath = `${IMPORT_ASSET_CACHE_DIR}${md5}.${extension}`;
  await ensureDirectory(IMPORT_ASSET_CACHE_DIR);
  const cacheInfo = (await FileSystem.getInfoAsync(cachePath, { md5: true } as any)) as any;
  if (
    !cacheInfo.exists ||
    cacheInfo.md5?.toLowerCase() !== md5 ||
    (typeof info.size === "number" && cacheInfo.size !== info.size)
  ) {
    await FileSystem.deleteAsync(cachePath, { idempotent: true });
    await FileSystem.copyAsync({ from: sourcePath, to: cachePath });
  }
  await FileSystem.copyAsync({ from: cachePath, to: destinationPath });
  const destinationInfo = (await FileSystem.getInfoAsync(destinationPath, { md5: true } as any)) as any;
  if (!destinationInfo.exists || destinationInfo.md5?.toLowerCase() !== md5 ||
      (typeof info.size === "number" && destinationInfo.size !== info.size)) {
    await FileSystem.deleteAsync(destinationPath, { idempotent: true });
    throw new Error(`import asset copy verification failed: ${destinationPath}`);
  }
}

async function recordImportedAsset(
  txDb: SQLite.SQLiteDatabase,
  eventId: number,
  logicalPath: string,
  localPath: string,
  manifest: AssetManifest | null,
): Promise<void> {
  if (!isSafeArchivePath(logicalPath)) return;
  const normalized = normalizeArchivePath(logicalPath);
  const alias = manifest?.aliases?.[normalized];
  const entry = Object.values(manifest?.assets ?? {}).find((candidate) =>
    (candidate.path && isSafeArchivePath(candidate.path) && normalizeArchivePath(candidate.path) === normalized) ||
    (alias && candidate.path && isSafeArchivePath(candidate.path) && normalizeArchivePath(candidate.path) === normalizeArchivePath(alias)) ||
    (candidate.paths ?? []).some((path) => isSafeArchivePath(path) && normalizeArchivePath(path) === normalized) ||
    (candidate.original_names ?? []).some((path) => isSafeArchivePath(path) && normalizeArchivePath(path) === normalized),
  );
  const info = (await FileSystem.getInfoAsync(localPath, { md5: true } as any)) as any;
  if (!info.exists || typeof info.size !== "number") throw new Error(`asset local map source missing: ${localPath}`);
  const algorithm = entry?.algorithm ? String(entry.algorithm).toLowerCase() : info.md5 ? "md5" : null;
  let actualHash = typeof info.md5 === "string" ? info.md5.toLowerCase() : null;
  if (algorithm && algorithm.replace(/[-_]/g, "") === "sha256") {
    actualHash = await readSha256File(localPath);
    if (!actualHash) throw new Error(`asset sha256 unavailable: ${localPath}`);
  }
  await txDb.runAsync(
    `INSERT OR REPLACE INTO asset_local_map
      (event_id, logical_path, local_path, algorithm, expected_hash, actual_hash, size, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    eventId,
    normalized,
    localPath,
    algorithm,
    entry?.hash ? String(entry.hash).toLowerCase() : null,
    actualHash,
    Number(info.size),
    typeof info.modificationTime === "number" ? info.modificationTime : null,
  );
}

function createAssetManifest(): Required<Pick<AssetManifest, "format" | "format_version" | "assets" | "aliases">> {
  return {
    format: "eventtrail_asset_manifest",
    format_version: 1,
    assets: {},
    aliases: {},
  };
}

async function copyExportAsset(
  sourcePath: string,
  logicalPath: string,
  exportDir: string,
  manifest: ReturnType<typeof createAssetManifest>,
): Promise<boolean> {
  try {
    const fileInfo = (await FileSystem.getInfoAsync(sourcePath, {
      md5: true,
    } as any)) as any;
    if (!fileInfo.exists) return false;
    const md5 = typeof fileInfo.md5 === "string" ? fileInfo.md5 : "";
    if (!md5) {
      return copyExportFile(sourcePath, `${exportDir}${logicalPath}`);
    }
    const normalizedLogical = normalizeArchivePath(logicalPath);
    const ext = extensionFromPath(normalizedLogical || sourcePath);
    const assetPath = `assets/md5/${md5.slice(0, 2)}/${md5}.${ext}`;
    const existing = manifest.assets[md5];
    if (!existing) {
      await copyExportFile(sourcePath, `${exportDir}${assetPath}`);
      manifest.assets[md5] = {
        algorithm: "md5",
        hash: md5,
        path: assetPath,
        size: typeof fileInfo.size === "number" ? fileInfo.size : undefined,
        original_names: [],
      };
    }
    const originalNames = manifest.assets[md5].original_names ?? [];
    if (!originalNames.includes(normalizedLogical)) {
      originalNames.push(normalizedLogical);
      manifest.assets[md5].original_names = originalNames;
    }
    manifest.aliases[normalizedLogical] = assetPath;
    return true;
  } catch (e) {
    console.warn("export asset copy skipped:", sourcePath, e);
    return false;
  }
}

async function resetDatabaseForFullSync(): Promise<void> {
  if (dbInitPromise) {
    try {
      await dbInitPromise;
    } catch {
      /* A failed initialization leaves nothing reusable before reset. */
    }
  }

  const currentDb = db;
  db = null;
  dbInitPromise = null;
  importRowIdSeeds.clear();
  invalidatePurchaseLookupCache();

  if (currentDb) {
    try {
      await currentDb.closeAsync();
    } catch {
      /* Ignore close failures before recreating the local import DB. */
    }
  }

  try {
    await SQLite.deleteDatabaseAsync(DB_NAME);
  } catch (e: any) {
    const message = String(e?.message ?? e);
    if (!/not found|DatabaseNotFound/i.test(message)) {
      throw e;
    }
  }

  await FileSystem.deleteAsync(IMAGES_DIR, { idempotent: true });
  await FileSystem.deleteAsync(DEFAULT_CUTS_DIR, { idempotent: true });
}

type SqlValue = string | number | null;
const importRowIdSeeds = new Map<string, number>();

function toSqlValue(value: unknown, fallback: SqlValue = null): SqlValue {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") return value.replace(/\u0000/g, "");
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "boolean") return value ? 1 : 0;
  return String(value).replace(/\u0000/g, "");
}

function toSqlJson(value: unknown, fallback: unknown): string {
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

function parseJsonObject<T extends Record<string, unknown>>(
  raw: string | null | undefined,
): T {
  if (!raw) return {} as T;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as T)
      : ({} as T);
  } catch {
    return {} as T;
  }
}

function serializeRaw(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function toSqlBind(value: unknown): SqlValue {
  return toSqlValue(value);
}

async function nextImportRowId(
  txDb: SQLite.SQLiteDatabase,
  tableName: "events" | "circles",
): Promise<number> {
  const cached = importRowIdSeeds.get(tableName);
  if (cached != null) {
    const next = cached + 1;
    importRowIdSeeds.set(tableName, next);
    return next;
  }

  const row = await txDb.getFirstAsync<{ max_id: number | null }>(
    `SELECT COALESCE(MAX(id), 0) AS max_id FROM ${tableName}`,
  );
  const currentMax = Number(row?.max_id ?? 0);
  const seed = Number.isSafeInteger(currentMax) ? currentMax : 0;
  const next = seed + 1;
  importRowIdSeeds.set(tableName, next);
  return next;
}

async function runImportSql(
  txDb: SQLite.SQLiteDatabase,
  label: string,
  sql: string,
  ...params: unknown[]
): Promise<SQLite.SQLiteRunResult> {
  try {
    assertSqlBindCount(sql, params.length);
    return await txDb.runAsync(sql, ...params.map((value) => toSqlBind(value)));
  } catch (e: any) {
    throw new Error(`${label}: ${e?.message ?? String(e)}`);
  }
}

async function tryRunImportSql(
  txDb: SQLite.SQLiteDatabase,
  sql: string,
  ...params: unknown[]
): Promise<void> {
  // Keep optional-column imports safe as well: unsupported columns may be
  // ignored below, but a malformed bind list must never be silently accepted.
  assertSqlBindCount(sql, params.length);
  try {
    await txDb.runAsync(sql, ...params.map((value) => toSqlBind(value)));
  } catch {
    // Optional imported fields must not block the base event import on older DBs.
  }
}

async function updateImportedEventOptionalFields(
  txDb: SQLite.SQLiteDatabase,
  eventId: number,
  event: ImportData["event"],
): Promise<void> {
  await tryRunImportSql(
    txDb,
    "UPDATE events SET memo = ? WHERE id = ?",
    toSqlValue(event.memo, ""),
    toSqlValue(eventId),
  );
  await tryRunImportSql(
    txDb,
    "UPDATE events SET completed = ? WHERE id = ?",
    toSqlValue(event.completed, 0),
    toSqlValue(eventId),
  );
  await tryRunImportSql(
    txDb,
    "UPDATE events SET shopping_started_at = ? WHERE id = ?",
    toSqlValue(event.shopping_started_at),
    toSqlValue(eventId),
  );
  await tryRunImportSql(
    txDb,
    "UPDATE events SET shopping_ended_at = ? WHERE id = ?",
    toSqlValue(event.shopping_ended_at),
    toSqlValue(eventId),
  );
}

async function inspectSharedBundleSettings(
  extractDir: string,
  destinationDir = DEFAULT_CUTS_DIR,
): Promise<SharedBundleInspection> {
  const circleMasterPath = `${extractDir}circle_master.json`;
  const circleMasterInfo = await FileSystem.getInfoAsync(circleMasterPath);
  let circleMasterJson: string | null = null;
  if (circleMasterInfo.exists) {
    const raw = await FileSystem.readAsStringAsync(circleMasterPath);
    // Parse now so malformed shared settings fail before any snapshot/copy.
    circleMasterJson = JSON.stringify(JSON.parse(raw));
  }
  const sourceDir = `${extractDir}default_cuts/`;
  const sourceInfo = await FileSystem.getInfoAsync(sourceDir);
  const targetDir = normalizeDir(destinationDir);
  const cutFiles: DirectoryFileFingerprint[] = [];
  const changedCuts: DefaultCutCopyPlan[] = [];
  if (!sourceInfo.exists) {
    return {
      fingerprint: buildSharedBundleFingerprint(circleMasterJson, cutFiles),
      circleMasterJson,
      cutFiles,
      changedCuts,
    };
  }
  if (!(sourceInfo as any).isDirectory) throw new Error("default_cuts がディレクトリではありません");

  const entries = await FileSystem.readDirectoryAsync(sourceDir);
  // Validate every path before creating/deleting any destination.  ZIP entry
  // names are untrusted even though readDirectoryAsync normally returns only
  // basenames; this also protects a malicious mock/native implementation.
  for (const entry of entries) {
    if (!isSafeArchivePath(entry) || basenameFromPath(entry) !== entry) {
      throw new Error(`default_cuts のパスが不正です: ${entry}`);
    }
    const source = resolveExtractedPath(extractDir, `default_cuts/${entry}`);
    const dest = `${targetDir}${normalizeArchivePath(entry)}`;
    if (!source || !isPathContainedBy(targetDir, dest)) {
      throw new Error(`default_cuts の containment 検証に失敗しました: ${entry}`);
    }
    const sourceWithHash = (await FileSystem.getInfoAsync(source, { md5: true } as any)) as any;
    if (!sourceWithHash.exists || sourceWithHash.isDirectory) continue;
    if (typeof sourceWithHash.md5 !== "string" || !sourceWithHash.md5 || typeof sourceWithHash.size !== "number") {
      throw new Error(`default cut digest がありません: ${entry}`);
    }
    const file = {
      relative: normalizeArchivePath(entry),
      size: Number(sourceWithHash.size),
      md5: String(sourceWithHash.md5).toLowerCase(),
    };
    cutFiles.push(file);
    const existing = (await FileSystem.getInfoAsync(dest, { md5: true } as any)) as any;
    const equal = existing.exists && !existing.isDirectory &&
      Number(existing.size) === file.size &&
      typeof existing.md5 === "string" && existing.md5.toLowerCase() === file.md5;
    if (!equal) changedCuts.push({ ...file, source, dest, hadExisting: !!existing.exists && !existing.isDirectory });
  }
  cutFiles.sort((left, right) => left.relative.localeCompare(right.relative));
  return {
    fingerprint: buildSharedBundleFingerprint(circleMasterJson, cutFiles),
    circleMasterJson,
    cutFiles,
    changedCuts,
  };
}

async function copyDefaultCutsFromBundle(
  extractDir: string,
  destinationDir = DEFAULT_CUTS_DIR,
  inspection?: SharedBundleInspection,
): Promise<void> {
  const targetDir = normalizeDir(destinationDir);
  const inspected = inspection ?? await inspectSharedBundleSettings(extractDir, destinationDir);
  const plans = inspected.changedCuts;
  if (plans.length === 0) return;
  await ensureDirectory(targetDir);
  const bundleBackups: Array<{ dest: string; backup: string }> = [];
  // Hash comparison happened during inspection.  Only changed files receive
  // rollback backups; an equal 500-cut bundle performs zero copyAsync calls.
  for (const { dest, hadExisting } of plans) {
    if (!hadExisting) continue;
    const backup = `${dest}.bundle_backup_${Date.now()}_${bundleBackups.length}`;
    await FileSystem.copyAsync({ from: dest, to: backup });
    bundleBackups.push({ dest, backup });
  }
  const committedDestinations: string[] = [];
  for (const { source, dest, md5, size, hadExisting } of plans) {
    const staged = `${dest}.staging_${Date.now()}`;
    const backup = `${dest}.backup_${Date.now()}`;
    try {
      await FileSystem.copyAsync({ from: source, to: staged });
      const stagedInfo = (await FileSystem.getInfoAsync(staged, { md5: true } as any)) as any;
      if (!stagedInfo.exists || String(stagedInfo.md5).toLowerCase() !== md5 || Number(stagedInfo.size) !== size) {
        throw new Error(`default cut bundle copy verification failed: ${dest}`);
      }
      if (hadExisting) await FileSystem.moveAsync({ from: dest, to: backup });
      await FileSystem.moveAsync({ from: staged, to: dest });
      await FileSystem.deleteAsync(backup, { idempotent: true });
      committedDestinations.push(dest);
    } catch (error) {
      await FileSystem.deleteAsync(staged, { idempotent: true }).catch(() => undefined);
      try {
        if (hadExisting) {
          await FileSystem.deleteAsync(dest, { idempotent: true });
          if ((await FileSystem.getInfoAsync(backup)).exists) await FileSystem.moveAsync({ from: backup, to: dest });
        } else {
          await FileSystem.deleteAsync(dest, { idempotent: true });
        }
      } catch (restoreError) {
        throw new Error(`${String((error as any)?.message ?? error)}; default cut restore failed: ${String((restoreError as any)?.message ?? restoreError)}`);
      }
      // Restore all files changed by this bundle, including newly-created
      // destinations that have no old-file backup.
      for (const committed of [...committedDestinations].reverse()) {
        await FileSystem.deleteAsync(committed, { idempotent: true });
        const snapshot = bundleBackups.find((candidate) => candidate.dest === committed);
        if (snapshot) await FileSystem.moveAsync({ from: snapshot.backup, to: snapshot.dest });
      }
      for (const snapshot of bundleBackups) {
        await FileSystem.deleteAsync(snapshot.backup, { idempotent: true }).catch(() => undefined);
      }
      throw error;
    }
  }
  for (const snapshot of bundleBackups) await FileSystem.deleteAsync(snapshot.backup, { idempotent: true });
}

async function readStoredCircleMasterData(): Promise<CircleMasterData> {
  const raw = await getSetting("circle_master_json");
  if (!raw) return { circles: {} };
  try {
    const parsed = JSON.parse(raw) as CircleMasterData;
    return {
      ...parsed,
      circles: parsed.circles ?? {},
    };
  } catch {
    return { circles: {} };
  }
}

async function writeStoredCircleMasterData(data: CircleMasterData): Promise<void> {
  await setSetting("circle_master_json", JSON.stringify(data));
  const database = await getDatabase();
  await database.runAsync("DELETE FROM app_settings WHERE key = ?", SHARED_BUNDLE_FINGERPRINT_KEY);
}

async function updateStoredCircleMasterFavorite(
  name: string,
  penname: string,
  favorite: boolean,
): Promise<void> {
  const key = name || penname;
  if (!key) return;
  const data = await readStoredCircleMasterData();
  const existing = data.circles[key] ?? {
    penname: penname || "",
    favorite: false,
    genre: "",
    default_cut: null,
  };
  data.circles[key] = {
    ...existing,
    penname: existing.penname || penname || "",
    favorite,
  };
  await writeStoredCircleMasterData(data);
}

function nextDefaultCutFilename(data: CircleMasterData, sourcePath: string): string {
  let max = -1;
  for (const entry of Object.values(data.circles ?? {})) {
    const cut = entry.default_cut;
    if (!cut) continue;
    const stem = basenameFromPath(cut).split(".")[0] ?? "";
    const n = Number.parseInt(stem, 10);
    if (Number.isFinite(n)) max = Math.max(max, n);
  }
  const rawExt = basenameFromPath(sourcePath).split(".").pop()?.toLowerCase();
  const ext =
    rawExt && ["jpg", "jpeg", "png", "webp"].includes(rawExt)
      ? rawExt.replace("jpeg", "jpg")
      : "jpg";
  return `${String(max + 1).padStart(4, "0")}.${ext}`;
}

export async function registerDefaultCutFromImage(
  circleName: string,
  penname: string | null | undefined,
  imagePath: string,
  options?: { overwriteExisting?: boolean },
): Promise<string | null> {
  if (!circleName || !imagePath) return null;
  const sourceInfo = await FileSystem.getInfoAsync(imagePath);
  if (!sourceInfo.exists) return null;

  await ensureDirectory(DEFAULT_CUTS_DIR);
  const data = await readStoredCircleMasterData();
  const entry = data.circles[circleName] ?? {
    penname: penname ?? "",
    favorite: false,
    genre: "",
    default_cut: null,
  };
  let filename = entry.default_cut || null;
  if (filename && !options?.overwriteExisting) {
    return filename;
  }
  if (!filename) {
    filename = nextDefaultCutFilename(data, imagePath);
  }

  if (!isSafeArchivePath(filename) || basenameFromPath(filename) !== filename || !isPathContainedBy(DEFAULT_CUTS_DIR, `${normalizeDir(DEFAULT_CUTS_DIR)}${filename}`)) {
    throw new Error("default cut filename is unsafe");
  }

  const dest = `${DEFAULT_CUTS_DIR}${filename}`;
  const staged = `${dest}.staging_${Date.now()}`;
  const backup = `${dest}.backup_${Date.now()}`;
  const previousRaw = await getSetting("circle_master_json");
  const existingInfo = await FileSystem.getInfoAsync(dest);
  let backupReady = false;
  try {
    // Prepare/verify new bytes before touching the current default cut.
    await FileSystem.copyAsync({ from: imagePath, to: staged });
    const stagedInfo = await FileSystem.getInfoAsync(staged);
    if (!stagedInfo.exists || (stagedInfo as any).isDirectory) throw new Error("default cut staging が不正です");
    if (existingInfo.exists) {
      await FileSystem.copyAsync({ from: dest, to: backup });
      backupReady = true;
    }
    await FileSystem.deleteAsync(dest, { idempotent: true });
    await FileSystem.moveAsync({ from: staged, to: dest });
    data.circles[circleName] = {
      ...entry,
      penname: entry.penname || penname || "",
      default_cut: filename,
    };
    await writeStoredCircleMasterData(data);
  } catch (error) {
    // Compensate both file and circle_master setting.  Failure to restore is
    // surfaced and leaves backup evidence for manual/startup retry.
    await FileSystem.deleteAsync(staged, { idempotent: true }).catch(() => undefined);
    try {
      await FileSystem.deleteAsync(dest, { idempotent: true });
      if (backupReady) await FileSystem.moveAsync({ from: backup, to: dest });
      if (previousRaw == null) await (await getDatabase()).runAsync("DELETE FROM app_settings WHERE key = ?", "circle_master_json");
      else await setSetting("circle_master_json", previousRaw);
    } catch (restoreError) {
      throw new Error(`${String((error as any)?.message ?? error)}; default cut rollback failed: ${String((restoreError as any)?.message ?? restoreError)}`);
    }
    throw error;
  }
  await FileSystem.deleteAsync(backup, { idempotent: true }).catch(() => undefined);
  return filename;
}

async function importCircleMasterFromBundle(extractDir: string): Promise<void> {
  const cmPath = `${extractDir}circle_master.json`;
  const cmInfo = await FileSystem.getInfoAsync(cmPath);
  if (!cmInfo.exists) return;

  const cmText = await FileSystem.readAsStringAsync(cmPath);
  const cmData = JSON.parse(cmText) as CircleMasterData;
  await setSetting("circle_master_json", JSON.stringify(cmData));

  for (const [name, entry] of Object.entries(cmData.circles ?? {})) {
    if (!entry.favorite) continue;
    const alreadyFav = await isFavoriteCircle(name, entry.penname ?? "");
    if (!alreadyFav) {
      await addFavoriteCircle(name, entry.penname ?? "");
    }
  }
}

async function importSharedBundleSettings(
  extractDir: string,
  defaultCutsDestination = DEFAULT_CUTS_DIR,
  inspection?: SharedBundleInspection,
): Promise<boolean> {
  const inspected = inspection ?? await inspectSharedBundleSettings(extractDir, defaultCutsDestination);
  const previousFingerprint = await getSetting(SHARED_BUNDLE_FINGERPRINT_KEY);
  if (previousFingerprint === inspected.fingerprint) return false;
  // Validate and publish image files first; commit the JSON setting only after
  // every cut has completed its verified stage->backup->rename path.  A
  // malformed/copy-failed bundle propagates and therefore cannot report a
  // successful sync with partially updated shared settings.
  const previous = await getSetting("circle_master_json");
  const previousFavorites = await getFavoriteCircles();
  try {
    await copyDefaultCutsFromBundle(extractDir, defaultCutsDestination, inspected);
    await importCircleMasterFromBundle(extractDir);
    await setSetting(SHARED_BUNDLE_FINGERPRINT_KEY, inspected.fingerprint);
  } catch (error) {
    const database = await getDatabase();
    await database.withExclusiveTransactionAsync(async (txn) => {
      if (previous == null) await txn.runAsync("DELETE FROM app_settings WHERE key = ?", "circle_master_json");
      else await txn.runAsync("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, ?)", "circle_master_json", previous);
      if (previousFingerprint == null) await txn.runAsync("DELETE FROM app_settings WHERE key = ?", SHARED_BUNDLE_FINGERPRINT_KEY);
      else await txn.runAsync("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, ?)", SHARED_BUNDLE_FINGERPRINT_KEY, previousFingerprint);
      await txn.runAsync("DELETE FROM favorite_circles");
      for (const row of previousFavorites) await txn.runAsync("INSERT INTO favorite_circles(name, tag) VALUES (?, ?)", row.name, row.tag);
    });
    throw error;
  }
  return true;
}

// Focused runtime tests exercise the real FileSystem call boundary without
// exposing these helpers as supported application APIs.
export const databaseSharedSettingsTestHooks = {
  inspectSharedBundleSettings,
  copyDefaultCutsFromBundle,
};

function normalizeDir(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}

function eventDirFromManifestPath(extractDir: string, eventPath: string): string {
  // raw manifest path を normalize 前に検証し、canonical containment を確認。
  if (!isSafeArchivePath(eventPath)) {
    throw new Error("同期manifestのイベントパスが不正です");
  }
  const normalizedPath = normalizeArchivePath(eventPath);
  if (basenameFromPath(normalizedPath) !== "event.json") {
    throw new Error("同期manifestのイベントパスが不正です");
  }
  const eventBaseDir = normalizedPath.replace(/event\.json$/, "");
  const resolved = eventBaseDir
    ? resolveExtractedPath(extractDir, eventBaseDir)
    : normalizeDir(extractDir);
  if (!resolved) throw new Error("同期manifestのイベントパスが不正です");
  return normalizeDir(resolved);
}

function parseImportStageJournal(value: unknown): ImportStageJournal | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ImportStageJournal>;
  if (candidate.version !== 1 || typeof candidate.phase !== "string" ||
      !Array.isArray(candidate.importedEventIds) || !Array.isArray(candidate.published)) return null;
  if (candidate.cleanupEventIds !== undefined && (!Array.isArray(candidate.cleanupEventIds) || candidate.cleanupEventIds.some((id) => !Number.isSafeInteger(Number(id)) || Number(id) <= 0))) return null;
  if (!["staging", "publishing", "finalized", "rolled_back", "image_publish_intent", "images_published", "db_publish_intent", "db_published"].includes(candidate.phase)) return null;
  if (candidate.kind !== undefined && candidate.kind !== "legacy" && candidate.kind !== "incremental") return null;
  if (candidate.importedEventIds.some((id) => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) return null;
  for (const entry of candidate.published) {
    if (!entry || typeof entry !== "object" || !Number.isSafeInteger(Number((entry as PublishedImageDir).eventId)) ||
        ((entry as PublishedImageDir).markerEventId !== undefined && !Number.isSafeInteger(Number((entry as PublishedImageDir).markerEventId))) ||
        typeof (entry as PublishedImageDir).liveDir !== "string" ||
        ((entry as PublishedImageDir).backupDir !== null && typeof (entry as PublishedImageDir).backupDir !== "string")) return null;
  }
  if (candidate.kind === "legacy") {
    if (candidate.legacyHadLiveImages !== undefined && typeof candidate.legacyHadLiveImages !== "boolean") return null;
    if (candidate.legacyDbBackupName !== undefined && typeof candidate.legacyDbBackupName !== "string") return null;
    if (candidate.legacyStageDbName !== undefined && typeof candidate.legacyStageDbName !== "string") return null;
    if (candidate.legacyImagesBackup !== undefined && typeof candidate.legacyImagesBackup !== "string") return null;
    if (candidate.legacyDbBackupReady !== undefined && typeof candidate.legacyDbBackupReady !== "boolean") return null;
    if (candidate.legacyImagesBackupReady !== undefined && typeof candidate.legacyImagesBackupReady !== "boolean") return null;
    if (candidate.legacyCutsStage !== undefined && typeof candidate.legacyCutsStage !== "string") return null;
    if (candidate.legacyCutsBackup !== undefined && typeof candidate.legacyCutsBackup !== "string") return null;
    if (candidate.legacyHadLiveCuts !== undefined && typeof candidate.legacyHadLiveCuts !== "boolean") return null;
    if (candidate.legacyCutsBackupReady !== undefined && typeof candidate.legacyCutsBackupReady !== "boolean") return null;
    if (candidate.legacyCutsPublished !== undefined && typeof candidate.legacyCutsPublished !== "boolean") return null;
  }
  if (candidate.sharedCutsBackup !== undefined && typeof candidate.sharedCutsBackup !== "string") return null;
  if (candidate.sharedCutsHadLive !== undefined && typeof candidate.sharedCutsHadLive !== "boolean") return null;
  if (candidate.sharedCutsBackupReady !== undefined && typeof candidate.sharedCutsBackupReady !== "boolean") return null;
  if (candidate.sharedSettingsIntent !== undefined && typeof candidate.sharedSettingsIntent !== "boolean") return null;
  if (candidate.sharedSettingsApplied !== undefined && typeof candidate.sharedSettingsApplied !== "boolean") return null;
  if (candidate.sharedCircleMasterPrevious !== undefined && candidate.sharedCircleMasterPrevious !== null && typeof candidate.sharedCircleMasterPrevious !== "string") return null;
  if (candidate.sharedFavoritesPrevious !== undefined && (!Array.isArray(candidate.sharedFavoritesPrevious) || candidate.sharedFavoritesPrevious.some((row) => !row || typeof row.name !== "string" || typeof row.tag !== "string"))) return null;
  if (candidate.sharedFingerprintPrevious !== undefined && candidate.sharedFingerprintPrevious !== null && typeof candidate.sharedFingerprintPrevious !== "string") return null;
  if (candidate.sharedCutSnapshots !== undefined && (!Array.isArray(candidate.sharedCutSnapshots) || candidate.sharedCutSnapshots.some((entry) =>
    !entry || typeof entry.relative !== "string" || basenameFromPath(entry.relative) !== entry.relative ||
    !isSafeArchivePath(entry.relative) || typeof entry.hadLive !== "boolean" ||
    typeof entry.size !== "number" || typeof entry.md5 !== "string"
  ))) return null;
  return candidate as ImportStageJournal;
}

function isJournalPathSetSafe(stageRoot: string, journal: ImportStageJournal): boolean {
  for (const entry of journal.published) {
    if (entry.liveDir !== `${IMAGES_DIR}${Number(entry.eventId)}/`) return false;
    if (entry.backupDir && !isPathContainedBy(stageRoot, entry.backupDir)) return false;
  }
  if (journal.kind === "legacy") {
    if (journal.legacyDbBackupName && !/^[a-z0-9_.-]+$/i.test(journal.legacyDbBackupName)) return false;
    if (journal.legacyStageDbName && !/^[a-z0-9_.-]+$/i.test(journal.legacyStageDbName)) return false;
    if (journal.legacyImagesBackup) {
      const legacyBackupBase = normalizeDir(FileSystem.cacheDirectory ?? stageRoot);
      if (!isPathContainedBy(legacyBackupBase, journal.legacyImagesBackup) ||
          !/^eventtrail_legacy_old_live_[a-z0-9_.-]+\/$/i.test(normalizeDir(journal.legacyImagesBackup).slice(normalizeDir(legacyBackupBase).length))) return false;
    }
    if (journal.legacyCutsStage && !isPathContainedBy(stageRoot, journal.legacyCutsStage)) return false;
    if (journal.legacyCutsBackup) {
      const legacyBackupBase = normalizeDir(FileSystem.cacheDirectory ?? stageRoot);
      if (!isPathContainedBy(legacyBackupBase, journal.legacyCutsBackup) ||
          !/^eventtrail_legacy_old_cuts_[a-z0-9_.-]+\/$/i.test(normalizeDir(journal.legacyCutsBackup).slice(normalizeDir(legacyBackupBase).length))) return false;
    }
  }
  if (journal.sharedCutsBackup && !isPathContainedBy(stageRoot, journal.sharedCutsBackup)) return false;
  return true;
}

async function importEventFromExtractDir(
  sourceDir: string,
  onProgress?: (progress: ImportProgress) => void,
  manifestEvent?: SyncManifestEvent,
  imagesRoot = IMAGES_DIR,
  syncUidOverride?: string,
  previousEventId?: number | null,
  stageRoot?: string,
  assetManifestOverride?: AssetManifest | null,
): Promise<number> {
  const extractDir = normalizeDir(sourceDir);

  // event.json を読み込み
  const eventJsonText = await FileSystem.readAsStringAsync(
    `${extractDir}event.json`,
  );
  const data = JSON.parse(eventJsonText) as ImportData;
  const assetManifest = assetManifestOverride !== undefined
    ? assetManifestOverride
    : await readAssetManifest(extractDir);

  // マップファイル自動検出（event.jsonにmapsが無い場合のフォールバック）
  if (!data.event.maps || data.event.maps.length === 0) {
    const extractedFiles = await FileSystem.readDirectoryAsync(extractDir);
    const mapFiles = extractedFiles
      .filter((name) => name.match(/^map_\d+\.(jpg|jpeg|png)$/i))
      .sort();
    if (mapFiles.length > 0) {
      data.event.maps = mapFiles.map((f, i) => ({
        filename: f,
        map_number: i + 1,
      }));
    }
  }

  // イベント挿入
  const database = await getDatabase();
  const eventId = await nextImportRowId(database, "events");
  // event 単位で DB を atomic にする。画像コピーが途中で失敗しても SQL は
  // rollback し、呼び出し側が生成した event ディレクトリを cleanup できる。
  try {
  await database.withExclusiveTransactionAsync(async (txn) => {
    const txDb = txn as unknown as SQLite.SQLiteDatabase;
  await runImportSql(
    txDb,
    `イベント登録 ${String(data.event.name ?? "")}`,
    `INSERT INTO events (
      id, name, url, date, venue, organizer, raw_json, metadata_json, sync_root_json,
      sync_uid, content_hash, asset_set_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    toSqlValue(eventId),
    toSqlValue(data.event.name, "不明なイベント"),
    toSqlValue(data.event.url, ""),
    toSqlValue(data.event.date),
    toSqlValue(data.event.venue),
    toSqlValue(data.event.organizer),
    // Keep manifest/event unknown fields (stable/event UID, source metadata,
    // future root keys) in the raw projection.  Known columns remain the
    // authoritative editable values; export merges this raw object back with
    // current columns, so import→export round-trips fields that mobile does
    // not yet understand without adding a second schema column.
    toSqlValue(serializeRaw({ ...(manifestEvent ?? {}), ...data.event })),
    toSqlValue(serializeRaw(data.metadata)),
    toSqlValue(serializeRaw({ ...(manifestEvent ?? {}), ...data, event: { ...data.event, ...(manifestEvent ?? {}) } })),
    toSqlValue(syncUidOverride ?? manifestEvent?.stable_uid ?? manifestEvent?.event_uid ?? manifestEvent?.uid),
    toSqlValue(manifestEvent?.content_hash ?? manifestEvent?.hash),
    toSqlValue(manifestEvent?.asset_set_hash ?? manifestEvent?.asset_hash),
  );
  await updateImportedEventOptionalFields(txDb, eventId, data.event);
  const imgDir = await ensureImagesDir(eventId, imagesRoot);

  // マップ画像を保存（ファイル移動、JSメモリ不使用）
  for (let mapIndex = 0; mapIndex < (data.event.maps ?? []).length; mapIndex++) {
    const mapInfo = (data.event.maps ?? [])[mapIndex];
    if (!mapInfo.filename || !isSafeArchivePath(mapInfo.filename)) continue;
    const mapSrc = await resolveImportedAsset(extractDir, assetManifest, [
      mapInfo.filename,
    ]);
    if (mapSrc) {
      const mapPath = `${imgDir}map_${Number(mapInfo.map_number ?? mapIndex + 1)}_${basenameFromPath(mapInfo.filename)}`;
      await ensureDirectory(mapPath.slice(0, mapPath.lastIndexOf("/") + 1));
      await copyImportedAssetCached(mapSrc.path, mapPath);
      await recordImportedAsset(txDb, eventId, mapSrc.logicalPath, mapPath, assetManifest);
      await runImportSql(
        txDb,
        `マップ登録 ${String(data.event.name ?? "")}`,
        "INSERT INTO event_maps (event_id, filename, map_number, raw_json) VALUES (?, ?, ?, ?)",
        toSqlValue(eventId),
        toSqlValue(mapPath),
        toSqlValue(mapInfo.map_number, 1),
        toSqlValue(serializeRaw(mapInfo)),
      );
    }
  }

  // イベント画像を保存
  const eventImageFilename =
    data.event.event_image_filename ??
    (data.event as ImportData["event"] & { event_image?: string }).event_image;
  if (eventImageFilename) {
    if (!isSafeArchivePath(eventImageFilename)) {
      throw new Error("イベント画像パスが不正です");
    }
    const eventImageLogical = canonicalEventImageLogical(eventImageFilename);
    const eventImgSrc = await resolveImportedAsset(extractDir, assetManifest, [
      eventImageLogical,
      eventImageFilename,
    ]);
    if (eventImgSrc) {
      const ext = extensionFromPath(eventImageFilename);
      const eventImgDest = `${imgDir}event_image.${ext}`;
      await copyImportedAssetCached(eventImgSrc.path, eventImgDest);
      await recordImportedAsset(txDb, eventId, eventImgSrc.logicalPath, eventImgDest, assetManifest);
      await runImportSql(
        txDb,
        `イベント画像登録 ${String(data.event.name ?? "")}`,
        "UPDATE events SET event_image_filename = ? WHERE id = ?",
        toSqlValue(eventImgDest),
        toSqlValue(eventId),
      );
    }
  }

  // サークル挿入
  const circles = data.circles ?? [];
  const totalCircles = circles.length;
  for (let i = 0; i < totalCircles; i++) {
    const circle = circles[i];
    if (onProgress && i % 5 === 0) {
      onProgress({ current: i, total: totalCircles, phase: "circles" });
    }

    // サークルカット画像を移動
    const circleId = await nextImportRowId(txDb, "circles");
    let cutFilePath: string | null = null;
    if (circle.circle_cut_filename) {
      const cutSrc = await resolveImportedAsset(extractDir, assetManifest, [
        circle.circle_cut_filename,
      ]);
      if (cutSrc) {
        const cutName = basenameFromPath(circle.circle_cut_filename);
        cutFilePath = `${imgDir}cuts/${circleId}_${cutName}`;
        const cutsDir = `${imgDir}cuts/`;
        const cutsDirInfo = await FileSystem.getInfoAsync(cutsDir);
        if (!cutsDirInfo.exists) {
          await FileSystem.makeDirectoryAsync(cutsDir, {
            intermediates: true,
          });
        }
        await copyImportedAssetCached(cutSrc.path, cutFilePath);
        await recordImportedAsset(txDb, eventId, cutSrc.logicalPath, cutFilePath, assetManifest);
      }
    }

    await runImportSql(
      txDb,
      `サークル登録 ${String(circle.name ?? "")}`,
      `INSERT INTO circles (
          id, event_id, name, penname, space, hall,
          twitter_url, website_url, pixiv_url,
          description, genres, tags,
          circle_cut_filename, priority_color, memo,
          pin_x, pin_y, map_number,
          absence_status, existing_only_status, catalog_status,
          checked, raw_json, name_key, penname_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      toSqlValue(circleId),
      toSqlValue(eventId),
      toSqlValue(circle.name, "不明"),
      toSqlValue(circle.penname),
      toSqlValue(circle.space),
      toSqlValue(circle.hall),
      toSqlValue(circle.twitter_url),
      toSqlValue(circle.website_url),
      toSqlValue(circle.pixiv_url),
      toSqlValue(circle.description),
      toSqlJson(circle.genres, []),
      toSqlJson(circle.tags, []),
      toSqlValue(cutFilePath),
      toSqlValue(circle.priority_color, 5),
      toSqlValue(circle.memo, ""),
      toSqlValue(circle.pin_x),
      toSqlValue(circle.pin_y),
      toSqlValue(circle.map_number),
      toSqlValue(circle.absence_status),
      toSqlValue(circle.existing_only_status),
      toSqlValue(circle.catalog_status),
      toSqlValue(circle.checked, 0),
      toSqlValue(serializeRaw(circle)),
      toSqlValue(normalizePurchaseLookupKey(circle.name)),
      toSqlValue(normalizePurchaseLookupKey(circle.penname)),
    );

    // アイテム挿入
    if (circle.items) {
      for (const item of circle.items) {
        const itemResult = await runImportSql(
          txDb,
          `頒布物登録 ${String(circle.name ?? "")}`,
          "INSERT INTO items (circle_id, name, price, type, description, purchase_status, raw_json, name_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          toSqlValue(circleId),
          toSqlValue(item.name, "不明"),
          toSqlValue(item.price),
          toSqlValue(item.type ?? item.genre),
          toSqlValue(item.description),
          toSqlValue(item.checked, 0),
          toSqlValue(serializeRaw(item)),
          toSqlValue(normalizePurchaseLookupKey(item.name)),
        );
        await updateItemFts(
          txDb,
          itemResult.lastInsertRowId,
          String(item.name ?? "不明"),
          item.description ?? null,
        );
      }
    }

    // アイテム画像を移動
    if (circle.item_images?.length) {
      const itemsImgDir = `${imgDir}items/`;
      const itemsDirInfo = await FileSystem.getInfoAsync(itemsImgDir);
      if (!itemsDirInfo.exists) {
        await FileSystem.makeDirectoryAsync(itemsImgDir, {
          intermediates: true,
        });
      }
      for (const img of circle.item_images) {
        if (!img.path) continue;
        if (!isSafeArchivePath(img.path)) continue;
        const imgSrc = await resolveImportedAsset(extractDir, assetManifest, [
          img.path,
        ]);
        let imgFilePath = normalizeArchivePath(img.path);
        if (imgSrc) {
          const imgName = basenameFromPath(img.path);
          imgFilePath = `${itemsImgDir}${circleId}_${imgName}`;
          await copyImportedAssetCached(imgSrc.path, imgFilePath);
          await recordImportedAsset(txDb, eventId, imgSrc.logicalPath, imgFilePath, assetManifest);
        }
        await runImportSql(
          txDb,
          `頒布物画像登録 ${String(circle.name ?? "")}`,
          "INSERT INTO item_images (circle_id, filename, source, raw_json) VALUES (?, ?, ?, ?)",
          toSqlValue(circleId),
          toSqlValue(imgFilePath, ""),
          toSqlValue(img.source, "unknown"),
          toSqlValue(serializeRaw(img)),
        );
      }
    }
  }

  if (syncUidOverride && stageRoot) {
    await txDb.runAsync(
      "INSERT OR REPLACE INTO sync_import_staging (event_id, sync_uid, previous_event_id, stage_root, phase) VALUES (?, ?, ?, ?, 'staging')",
      eventId,
      syncUidOverride,
      previousEventId ?? null,
      stageRoot,
    );
  }
  if (onProgress) {
    onProgress({
      current: totalCircles,
      total: totalCircles,
      phase: "circles",
    });
  }
  });
  } catch (error) {
    // transaction rollback 後に、途中までコピーした画像だけを掃除する。
    await FileSystem.deleteAsync(`${normalizeDir(imagesRoot)}${eventId}/`, { idempotent: true }).catch(() => undefined);
    throw error;
  }

  return eventId;
}

function manifestUid(event: SyncManifestEvent): string | null {
  const value = event.stable_uid ?? event.event_uid ?? event.uid;
  return value ? String(value) : null;
}

function manifestContentHash(event: SyncManifestEvent): string | null {
  const value = event.content_hash ?? event.hash;
  return value ? String(value) : null;
}

function manifestAssetHash(event: SyncManifestEvent): string | null {
  const value = event.asset_set_hash ?? event.asset_hash;
  return value ? String(value) : null;
}

function hasCompleteSyncHashes(events: SyncManifestEvent[]): boolean {
  return events.length > 0 && events.every(
    (event) => !!manifestUid(event) && !!manifestContentHash(event) && !!manifestAssetHash(event),
  );
}

async function canUseIncrementalSync(database: SQLite.SQLiteDatabase): Promise<boolean> {
  // 旧 full-sync/単発 import 行には uid が無いため、混在したまま差分適用すると
  // duplicate event を残す。legacy(NULL) 行が一つでもある mixed local DB は
  // complete v2 manifest でも安全側の full bootstrap にする。bootstrap publish が
  // real UID/hash を全行へ設定するため、次回の同一 v2 bundle から incremental。
  const row = await database.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM events WHERE sync_uid IS NULL",
  );
  return Number(row?.count ?? 0) === 0;
}

async function hasHealthyLocalAssets(
  database: SQLite.SQLiteDatabase,
  extractDir: string,
  manifestEvent: SyncManifestEvent,
  eventId: number,
  rootAssetManifest?: AssetManifest | null,
): Promise<boolean> {
  try {
    const eventDir = eventDirFromManifestPath(extractDir, manifestEvent.path);
    const eventInfo = await FileSystem.getInfoAsync(`${eventDir}event.json`);
    if (!eventInfo.exists) return false;
    const eventData = JSON.parse(await FileSystem.readAsStringAsync(`${eventDir}event.json`)) as ImportData;
    const assetManifest = rootAssetManifest
      ? scopeAssetManifest(rootAssetManifest, manifestEvent.path, manifestUid(manifestEvent))
      : await readAssetManifest(eventDir);
    const expectedPaths: string[] = [];
    const resolveExpected = async (logical: string | null | undefined): Promise<boolean> => {
      if (!logical) return true;
      const resolved = await resolveImportedAsset(eventDir, assetManifest, [logical]);
      if (!resolved) return false;
      expectedPaths.push(resolved.logicalPath);
      return true;
    };
    for (const map of eventData.event.maps ?? []) {
      if (!await resolveExpected(map.filename)) return false;
    }
    const eventImage = eventData.event.event_image_filename ?? (eventData.event as ImportData["event"] & { event_image?: string }).event_image;
    if (eventImage && !await resolveExpected(canonicalEventImageLogical(eventImage))) {
      // Older event.json files store the image as a bare filename while the
      // v2 manifest records the event_image/ alias.  Resolve the raw candidate
      // as a fallback, then persist whichever manifest logical was matched.
      const resolved = await resolveImportedAsset(eventDir, assetManifest, [eventImage]);
      if (!resolved) return false;
      expectedPaths.push(resolved.logicalPath);
    }
    for (const circle of eventData.circles ?? []) {
      if (!await resolveExpected(circle.circle_cut_filename)) return false;
      for (const image of circle.item_images ?? []) {
        if (!await resolveExpected(image.path)) return false;
      }
    }
    const mappings = await measuredGetAll<{
      logical_path: string;
      local_path: string;
      algorithm: string | null;
      expected_hash: string | null;
      actual_hash: string | null;
      size: number | null;
      modified_at: number | null;
    }>(database, "SELECT logical_path, local_path, algorithm, expected_hash, actual_hash, size, modified_at FROM asset_local_map WHERE event_id = ?", eventId);
    // Older rows without a logical mapping are conservatively treated as
    // changed; this avoids accepting a same-size renamed/corrupt file.  The
    // persisted mapping is the source of truth: never infer a logical asset
    // from a basename, because two assets in one event may legitimately share
    // a basename (for example `circle-a/item.jpg` and `circle-b/item.jpg`).
    // The same logical file may be referenced by multiple rows (e.g. one
    // catalog image reused by two items); compare unique logical names while
    // still rejecting duplicate persisted mappings.
    const expectedLogicalPaths = [...new Set(expectedPaths.map((logical) => normalizeArchivePath(logical)))];
    const mappingByLogicalPath = new Map<string, typeof mappings[number]>();
    const mappingByLocalPath = new Map<string, typeof mappings[number]>();
    for (const mapping of mappings) {
      const logical = normalizeArchivePath(mapping.logical_path);
      if (mappingByLogicalPath.has(logical) || mappingByLocalPath.has(mapping.local_path)) return false;
      mappingByLogicalPath.set(logical, mapping);
      mappingByLocalPath.set(mapping.local_path, mapping);
      const info = (await FileSystem.getInfoAsync(mapping.local_path, { md5: true } as any)) as any;
      if (!info.exists || (info as any).isDirectory || (typeof mapping.size === "number" && info.size !== mapping.size)) return false;
      const unchangedFingerprint = typeof mapping.modified_at === "number" &&
        typeof info.modificationTime === "number" && info.modificationTime === mapping.modified_at &&
        mapping.actual_hash && mapping.expected_hash && mapping.actual_hash.toLowerCase() === mapping.expected_hash.toLowerCase();
      if (unchangedFingerprint) continue;
      if (!await validateImportedAsset(mapping.local_path, logical, assetManifest)) return false;
    }
    if (!isAssetMappingComplete(expectedLogicalPaths, [...mappingByLogicalPath.keys()])) return false;
    const rows = await measuredGetAll<{ filename: string | null }>(
      database,
      `SELECT event_image_filename AS filename FROM events WHERE id = ?
       UNION ALL SELECT filename FROM event_maps WHERE event_id = ?
       UNION ALL SELECT circle_cut_filename FROM circles WHERE event_id = ? AND circle_cut_filename IS NOT NULL
       UNION ALL SELECT ii.filename FROM item_images ii JOIN circles c ON c.id = ii.circle_id WHERE c.event_id = ?`,
      eventId,
      eventId,
      eventId,
      eventId,
    );
    for (const row of rows) {
      if (!row.filename) continue;
      const info = await FileSystem.getInfoAsync(row.filename);
      if (!info.exists || (info as any).isDirectory) return false;
      const sourceInfo = (await FileSystem.getInfoAsync(row.filename, { md5: true } as any)) as any;
      if (typeof sourceInfo.size !== "number" || sourceInfo.size <= 0) return false;
      // Every persisted image must have one exact logical mapping.  A
      // basename-only heuristic would conflate same-named images and could
      // accept a corrupt file when the other candidate happens to hash.
      const mapping = mappingByLocalPath.get(row.filename);
      if (!mapping) return false;
      if (!await validateImportedAsset(row.filename, mapping.logical_path, assetManifest)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function importIncrementalBundle(
  extractDir: string,
  events: SyncManifestEvent[],
  onProgress?: (progress: ImportProgress) => void,
  rootAssetManifest?: AssetManifest | null,
): Promise<number> {
  const database = await getDatabase();
  const stageRoot = createImageStageRoot();
  await ensureDirectory(stageRoot);
  const existing = await measuredGetAll<{
    id: number;
    sync_uid: string | null;
    content_hash: string | null;
    asset_set_hash: string | null;
  }>(database, "SELECT id, sync_uid, content_hash, asset_set_hash FROM events WHERE sync_uid IS NOT NULL");
  const byUid = new Map(existing.map((row) => [row.sync_uid as string, row]));
  const seen = new Set<string>();
  const importedEventIds: number[] = [];
  const changedEventIds: number[] = [];
  const unchangedEventIds: number[] = [];
  let lastEventId: number | null = null;
  const previousChangedIds: number[] = [];
  const stableUidByEventId = new Map<number, string>();
  const changedIdentityByStagedId = new Map<number, ChangedEventIdentityMap>();
  let phase: ImportPublishPhase = "staging";
  let published: PublishedImageDir[] = [];
  let finalized = false;
  let rollbackCompleted = false;
  let cleanupCompleted = false;
  let cleanupEventIds: number[] = [];
  let sharedSettingsJournal: ImportStageJournal | null = null;
    await writeImportStageJournal(stageRoot, {
      version: 1,
      phase,
      importedEventIds,
      published,
      cleanupEventIds: [],
    });
  try {
    for (let i = 0; i < events.length; i++) {
      const manifestEvent = events[i];
      const uid = manifestUid(manifestEvent);
      const hash = manifestContentHash(manifestEvent);
      if (!uid || !hash || !manifestAssetHash(manifestEvent)) {
        throw new Error("同期manifestにstable uid/content hash/asset hashがありません");
      }
      seen.add(uid);
      const previous = byUid.get(uid);
      if (
        previous &&
        previous.content_hash === hash &&
        previous.asset_set_hash === manifestAssetHash(manifestEvent)
        && await hasHealthyLocalAssets(database, extractDir, manifestEvent, Number(previous.id), rootAssetManifest)) {
        unchangedEventIds.push(Number(previous.id));
        lastEventId = Number(previous.id);
        onProgress?.({ current: i + 1, total: events.length, phase: "events" });
        continue;
      }

      onProgress?.({ current: i + 1, total: events.length, phase: "events" });
      const stagingUid = `__staging__${uid}__${Date.now()}_${i}`;
      const newEventId = await importEventFromExtractDir(
        eventDirFromManifestPath(extractDir, manifestEvent.path),
        onProgress,
        manifestEvent,
        stageRoot,
        stagingUid,
        previous ? Number(previous.id) : null,
        stageRoot,
        scopeAssetManifest(rootAssetManifest ?? null, manifestEvent.path, uid),
      );
      importedEventIds.push(newEventId);
      stableUidByEventId.set(newEventId, uid);
      await writeImportStageJournal(stageRoot, {
        version: 1,
        phase,
        importedEventIds,
        published,
      });
      lastEventId = newEventId;
      if (previous) {
        const previousId = Number(previous.id);
        previousChangedIds.push(previousId);
        changedEventIds.push(previousId);
        changedIdentityByStagedId.set(
          newEventId,
          await reconcileChangedEventState(database, stageRoot, newEventId, previousId),
        );
      }
    }

    const removedEventIds = existing
      .filter((row) => !!row.sync_uid && !seen.has(row.sync_uid))
      .map((row) => Number(row.id));
    const plan = buildImportPublishPlan(importedEventIds, previousChangedIds, removedEventIds);
    // Changed events reuse the old live directory; only truly removed events
    // are eligible for post-commit image cleanup.
    cleanupEventIds = [...removedEventIds];
    for (const eventId of cleanupEventIds) {
      await database.runAsync(
        "INSERT OR REPLACE INTO sync_import_cleanup (event_id, stage_root, phase) VALUES (?, ?, 'pending')",
        eventId,
        stageRoot,
      );
    }
    await writeImportStageJournal(stageRoot, {
      version: 1,
      phase,
      importedEventIds,
      published,
      cleanupEventIds,
    });
    const sharedInspection = await inspectSharedBundleSettings(extractDir);
    const sharedFingerprint = await getSetting(SHARED_BUNDLE_FINGERPRINT_KEY);
    if (sharedFingerprint !== sharedInspection.fingerprint) {
      // Capture only changed default-cut files.  Equal files are hash-compared
      // before this point and never staged, backed up, or copied.
      sharedSettingsJournal = await prepareSharedSettingsSnapshot(stageRoot, sharedInspection);
      await database.runAsync(
        `INSERT OR REPLACE INTO sync_import_shared_staging
         (stage_root, previous_circle_master, previous_favorites_json, cuts_backup, cuts_had_live, cuts_backup_ready, phase)
         VALUES (?, ?, ?, ?, ?, ?, 'intent')`,
        stageRoot,
        sharedSettingsJournal.sharedCircleMasterPrevious ?? null,
        JSON.stringify(sharedSettingsJournal.sharedFavoritesPrevious ?? []),
        sharedSettingsJournal.sharedCutsBackup ?? `${normalizeDir(stageRoot)}__shared_cuts_old/`,
        sharedSettingsJournal.sharedCutsHadLive ? 1 : 0,
        sharedSettingsJournal.sharedCutsBackupReady ? 1 : 0,
      );
      await writeImportStageJournal(stageRoot, {
        ...sharedSettingsJournal,
        version: 1,
        phase,
        importedEventIds,
        published,
        cleanupEventIds,
        sharedSettingsIntent: true,
        sharedSettingsApplied: false,
      });
      await importSharedBundleSettings(extractDir, DEFAULT_CUTS_DIR, sharedInspection);
      sharedSettingsJournal.sharedSettingsApplied = true;
      await database.runAsync("UPDATE sync_import_shared_staging SET phase = 'applied' WHERE stage_root = ?", stageRoot);
      await writeImportStageJournal(stageRoot, {
        ...sharedSettingsJournal,
        version: 1,
        phase,
        importedEventIds,
        published,
        cleanupEventIds,
        sharedSettingsIntent: true,
        sharedSettingsApplied: true,
      });
    }

    // すべての changed event が staging DB/画像へ成功した後にだけ画像を publish。
    // 新しい event ID の live dir が存在しても backup を stageRoot 内に保持する。
    phase = advanceImportPublishPhase(phase, "publishing");
    for (const eventId of plan.publishEventIds) {
      published.push(await publishStagedImageDir(
        stageRoot,
        eventId,
        database,
        changedIdentityByStagedId.get(eventId)?.liveEventId ?? eventId,
      ));
      await writeImportStageJournal(stageRoot, {
        version: 1,
        phase,
        importedEventIds,
        published,
        cleanupEventIds,
      });
    }
    // 画像 publish 後、DB path rewrite と旧 changed/missing row delete を同一
    // transaction にする。ここで失敗すれば旧 live DB はまだ保持される。
    await finalizeIncrementalDb(
      database,
      stageRoot,
      plan.publishEventIds,
      plan.deleteEventIds,
      stableUidByEventId,
      changedIdentityByStagedId,
    );
    finalized = true;
    phase = advanceImportPublishPhase(phase, "finalized");
    await writeImportStageJournal(stageRoot, {
      version: 1,
      phase,
      importedEventIds,
      published,
      cleanupEventIds,
    });
    // 旧画像は DB publish 完了後にだけ削除する。失敗しても旧 DB は無いが、
    // stale file は次回 cleanup 可能であり新 live を壊さない。
    for (const eventId of cleanupEventIds) {
      await FileSystem.deleteAsync(`${IMAGES_DIR}${eventId}/`, { idempotent: true });
    }
    cleanupCompleted = true;
    await database.runAsync("DELETE FROM sync_import_staging WHERE stage_root = ?", stageRoot);
    await database.runAsync("DELETE FROM sync_import_shared_staging WHERE stage_root = ?", stageRoot);
    const liveImportedEventIds = importedEventIds.map(
      (eventId) => changedIdentityByStagedId.get(eventId)?.liveEventId ?? eventId,
    );
    const changedIdSet = new Set(changedEventIds);
    const addedEventIds = liveImportedEventIds.filter((eventId) => !changedIdSet.has(eventId));
    const targetEventIds = [...new Set([
      ...liveImportedEventIds,
      ...unchangedEventIds,
    ])];
    lastImportDiff = {
      kind: "full",
      incremental: true,
      importedEventIds: liveImportedEventIds,
      addedEventIds,
      changedEventIds: [...changedEventIds],
      unchangedEventIds: [...unchangedEventIds],
      removedEventIds: [...removedEventIds],
      targetEventIds,
      failedEventIds: [],
    };
    if (lastEventId == null) throw new Error("同期ZIPにイベントが含まれていません");
    invalidatePurchaseLookupCache();
    return changedIdentityByStagedId.get(lastEventId)?.liveEventId ?? lastEventId;
  } catch (error) {
    if (!finalized) {
      // staging/import/txn/publish の失敗時は新行だけを rollback。旧 changed
      // event と missing event の DB/画像には一切触れない。
      if (phase !== "rolled_back") {
        try { phase = advanceImportPublishPhase(phase, "rolled_back"); } catch { /* no-op */ }
      }
      await writeImportStageJournal(stageRoot, {
        version: 1,
      phase,
      importedEventIds,
      published,
      cleanupEventIds,
      });
      // Include rows whose publish function failed after moving live but before
      // returning its PublishedImageDir (for example marker-write failure).
      const durablePublished = await database.getAllAsync<{ event_id: number; previous_event_id: number | null; phase: string; backup_dir: string | null }>(
        "SELECT event_id, previous_event_id, phase, backup_dir FROM sync_import_staging WHERE stage_root = ?",
        stageRoot,
      );
      const rollbackEntries = [
        ...published,
        ...durablePublished
          .filter((row) => row.phase === "backup_intent" || row.phase === "backup_done" || row.phase === "live_done" || row.phase === "rollback_intent")
          .map((row) => ({
            eventId: Number(row.previous_event_id ?? row.event_id),
            markerEventId: Number(row.event_id),
            liveDir: `${IMAGES_DIR}${Number(row.previous_event_id ?? row.event_id)}/`,
            backupDir: row.backup_dir,
          })),
      ].filter((entry, index, all) => all.findIndex((candidate) => candidate.eventId === entry.eventId) === index);
      for (const entry of rollbackEntries) {
        if (entry.liveDir !== `${IMAGES_DIR}${entry.eventId}/` || (entry.backupDir && !isPathContainedBy(stageRoot, entry.backupDir))) {
          throw new Error("rollback durable image path is unsafe");
        }
      }
      // Keep durable rows in rollback_intent until every verified image restore
      // succeeds.  A failed restore must leave stage/backup evidence for retry.
      for (const entry of rollbackEntries) {
        await updateImportStageMarker(database, entry.markerEventId ?? entry.eventId, "rollback_intent", entry.backupDir);
      }
      await rollbackPublishedImageDirs(rollbackEntries);
      if (sharedSettingsJournal?.sharedSettingsIntent) {
        await restoreSharedSettingsSnapshot(database, sharedSettingsJournal);
      }
      await database.runAsync("DELETE FROM sync_import_shared_staging WHERE stage_root = ?", stageRoot);
      for (const newEventId of importedEventIds) {
        await deleteStagedEventWithFts(database, newEventId);
      }
      for (const newEventId of importedEventIds) {
        await database.runAsync("UPDATE sync_import_staging SET phase = 'rolled_back' WHERE event_id = ?", newEventId);
      }
      await database.runAsync("DELETE FROM sync_import_cleanup WHERE stage_root = ?", stageRoot);
      rollbackCompleted = true;
    }
    throw error;
  } finally {
    if ((finalized && cleanupCompleted) || rollbackCompleted) {
      await FileSystem.deleteAsync(stageRoot, { idempotent: true });
    }
  }
}

// --- ZIPインポート ---

/**
 * ZIPファイルからデータをインポート（event.json + 画像ファイル）
 * @param onProgress 進捗コールバック
 * @returns eventId
 */
export async function importFromZip(
  zipFilePath: string,
  onProgress?: (progress: ImportProgress) => void,
): Promise<number> {
  // ネイティブ側でZIP展開（JSヒープを使わない）
  const extractDir = `${FileSystem.cacheDirectory}zip_extract_${Date.now()}/`;
  const sourcePath = zipFilePath
    .replace(/^file:\/\/\//, "/")
    .replace(/^file:\/\//, "");
  const extractPath = extractDir
    .replace(/^file:\/\/\//, "/")
    .replace(/^file:\/\//, "");
  await unzip(sourcePath, extractPath);

  try {
    const bundlePath = `${extractDir}sync_bundle.json`;
    const bundleInfo = await FileSystem.getInfoAsync(bundlePath);
    if (bundleInfo.exists) {
      const bundleText = await FileSystem.readAsStringAsync(bundlePath);
      const bundle = JSON.parse(bundleText) as SyncBundleManifest;
      const events = bundle.events ?? [];
      // A sync_bundle is a full-sync envelope only when its explicit marker is
      // `full`.  Older full bundles may omit the additive marker and are kept
      // on the legacy full fallback; a different marker must never enter the
      // full/incremental path by accident (single-event ZIPs do not contain
      // sync_bundle.json at all).
      if (bundle.sync_mode !== undefined && bundle.sync_mode !== "full") {
        throw new Error(`同期manifestのsync_modeが不正です: ${bundle.sync_mode}`);
      }
      const rootAssetManifest = await readAssetManifest(extractDir);
      if (events.length && Number((bundle as any).manifest_version ?? 0) >= 2 && !rootAssetManifest) {
        throw new Error("v2 sync manifest asset_manifest.json がありません");
      }
      let lastEventId: number | null = null;
      if (!events.length) {
        throw new Error("同期ZIPにイベントが含まれていません");
      }
      const manifestUids = events.map((event) => manifestUid(event)).filter(Boolean);
      if (manifestUids.length === events.length && new Set(manifestUids).size !== manifestUids.length) {
        throw new Error("同期manifestのイベントUIDが重複しています");
      }
      if (
        events.some(
          (event) =>
            !event.path ||
            !isSafeArchivePath(event.path) ||
            basenameFromPath(normalizeArchivePath(event.path)) !== "event.json",
        )
      ) {
        throw new Error("同期manifestに不正なイベントパスがあります");
      }

      if (hasCompleteSyncHashes(events) && await canUseIncrementalSync(await getDatabase())) {
        return await importIncrementalBundle(extractDir, events, onProgress, rootAssetManifest);
      }

      // 旧 manifest は uid/hash を持たないため、互換性優先で従来の full sync
      // に安全に fallback する。live DB を中途半端に残さない既存 reset を維持。
      lastImportDiff = {
        kind: "full",
        incremental: false,
        fallbackReason: hasCompleteSyncHashes(events)
          ? "既存DBにlegacy event（uidなし）がある"
          : "manifestにstable uid/content hashがない",
        importedEventIds: [],
        addedEventIds: [],
        changedEventIds: [],
        unchangedEventIds: [],
        removedEventIds: [],
        targetEventIds: [],
        failedEventIds: [],
      };
      const legacyResult = await finalizeLegacyFullImport(
        extractDir,
        events,
        onProgress,
        rootAssetManifest,
      );
      lastImportDiff.importedEventIds = [...legacyResult.importedEventIds];
      lastImportDiff.addedEventIds = [...legacyResult.importedEventIds];
      lastImportDiff.targetEventIds = [...legacyResult.importedEventIds];
      return legacyResult.lastEventId;
    }

    const eventId = await importEventFromExtractDir(extractDir, onProgress);
    await importSharedBundleSettings(extractDir);
    lastImportDiff = {
      kind: "single",
      incremental: false,
      importedEventIds: [eventId],
      addedEventIds: [eventId],
      changedEventIds: [],
      unchangedEventIds: [],
      removedEventIds: [],
      targetEventIds: [eventId],
      failedEventIds: [],
    };
    return eventId;
  } finally {
    // 展開用一時ディレクトリを削除
    await FileSystem.deleteAsync(extractDir, { idempotent: true });
  }
}

/** イベント削除時に画像ディレクトリも削除 */
export async function deleteEventWithImages(eventId: number): Promise<void> {
  const database = await getDatabase();
  if (itemFtsAvailable) {
    await database.runAsync(
      "DELETE FROM items_fts WHERE item_id IN (SELECT i.id FROM items i JOIN circles c ON c.id = i.circle_id WHERE c.event_id = ?)",
      eventId,
    );
  }
  await database.runAsync("DELETE FROM events WHERE id = ?", eventId);
  invalidatePurchaseLookupCache();
  // 画像ディレクトリを削除
  const dir = `${IMAGES_DIR}${eventId}/`;
  const dirInfo = await FileSystem.getInfoAsync(dir);
  if (dirInfo.exists) {
    await FileSystem.deleteAsync(dir, { idempotent: true }).catch(() => undefined);
  }
}

// --- 一括操作 ---

export async function resetAllPurchaseStatus(eventId: number): Promise<void> {
  const database = await getDatabase();
  await database.runAsync(
    "UPDATE circles SET checked = 0 WHERE event_id = ?",
    eventId,
  );
  await database.runAsync(
    "UPDATE items SET purchase_status = 0, purchase_status_source = NULL WHERE circle_id IN (SELECT id FROM circles WHERE event_id = ?)",
    eventId,
  );
  invalidatePurchaseLookupCache();
}

// --- 買い物モード ---

export async function startShopping(eventId: number): Promise<void> {
  const database = await getDatabase();
  await database.runAsync(
    "UPDATE events SET shopping_started_at = datetime('now'), shopping_ended_at = NULL WHERE id = ?",
    eventId,
  );
}

export async function endShopping(eventId: number): Promise<void> {
  const database = await getDatabase();
  await database.runAsync(
    "UPDATE events SET shopping_ended_at = datetime('now') WHERE id = ?",
    eventId,
  );
}

// --- 予算集計 ---

export async function getBudgetSummary(
  eventId: number,
): Promise<BudgetSummary> {
  const database = await getDatabase();
  const effectiveStatus = `CASE WHEN i.id IS NULL THEN c.checked ELSE COALESCE(i.purchase_status, 0) END`;
  // totals と priority GROUP BY を CTE + UNION で 1 SQL にまとめる。
  const rows = await measuredGetAll<any>(
    database,
    `WITH base AS (
      SELECT c.id AS circle_id, c.priority_color, COALESCE(i.price, 0) AS price,
        ${effectiveStatus} AS status
      FROM circles c LEFT JOIN items i ON i.circle_id = c.id WHERE c.event_id = ?
    ), grouped AS (
      SELECT priority_color, SUM(price) AS total,
        SUM(CASE WHEN status IN (0, 1) THEN price ELSE 0 END) AS planned,
        SUM(CASE WHEN status = 1 THEN price ELSE 0 END) AS bought,
        SUM(CASE WHEN status = 2 THEN price ELSE 0 END) AS couldnt_buy,
        SUM(CASE WHEN status = 3 THEN price ELSE 0 END) AS skipped,
        SUM(CASE WHEN status = 0 THEN price ELSE 0 END) AS remaining,
        COUNT(DISTINCT circle_id) AS circle_count
      FROM base GROUP BY priority_color
    ), totals AS (
      SELECT SUM(price) AS total_list_price,
        SUM(CASE WHEN status IN (0, 1) THEN price ELSE 0 END) AS total_planned,
        SUM(CASE WHEN status = 1 THEN price ELSE 0 END) AS total_bought,
        SUM(CASE WHEN status = 2 THEN price ELSE 0 END) AS total_couldnt_buy,
        SUM(CASE WHEN status = 3 THEN price ELSE 0 END) AS total_skipped,
        SUM(CASE WHEN status = 0 THEN price ELSE 0 END) AS total_remaining
      FROM base
    )
    SELECT 'total' AS row_type, NULL AS priority_color, NULL AS total,
      NULL AS planned, NULL AS bought, NULL AS couldnt_buy, NULL AS skipped,
      NULL AS remaining, NULL AS circle_count,
      total_list_price, total_planned, total_bought, total_couldnt_buy,
      total_skipped, total_remaining
    FROM totals
    UNION ALL
    SELECT 'priority', priority_color, total, planned, bought, couldnt_buy,
      skipped, remaining, circle_count, NULL, NULL, NULL, NULL, NULL, NULL
    FROM grouped ORDER BY row_type, priority_color`,
    eventId,
  );
  const totals = rows.find((row) => row.row_type === "total") ?? {};
  const groups = rows.filter((row) => row.row_type === "priority");
  return {
    totalListPrice: Number(totals?.total_list_price ?? 0),
    totalPlanned: Number(totals?.total_planned ?? 0),
    totalBought: Number(totals?.total_bought ?? 0),
    totalCouldntBuy: Number(totals?.total_couldnt_buy ?? 0),
    totalSkipped: Number(totals?.total_skipped ?? 0),
    totalRemaining: Number(totals?.total_remaining ?? 0),
    byPriority: groups.map((row) => ({
      priorityColor: Number(row.priority_color),
      total: Number(row.total ?? 0),
      planned: Number(row.planned ?? 0),
      bought: Number(row.bought ?? 0),
      couldntBuy: Number(row.couldnt_buy ?? 0),
      skipped: Number(row.skipped ?? 0),
      remaining: Number(row.remaining ?? 0),
      circleCount: Number(row.circle_count ?? 0),
    })),
  };
}

export async function exportEventData(
  eventId: number,
): Promise<ImportData | null> {
  const database = await getDatabase();
  const event = await getEventForExport(eventId);
  if (!event) return null;
  const rootRow = await measuredGetFirst<{ sync_root_json: string | null }>(
    database,
    "SELECT sync_root_json FROM events WHERE id = ?",
    eventId,
  );

  const maps = await getEventMapsForExport(eventId);
  const circles = await getCirclesByEventForExport(eventId);

  const exportCircles: ImportCircle[] = [];
  for (const c of circles) {
    const items = await getItemsByCircleForExport(c.id);
    const images = await getItemImagesByCircleForExport(c.id);
    const baseCircle = parseJsonObject<ImportCircle>(c.rawJson);

    exportCircles.push({
      ...baseCircle,
      name: c.name,
      penname: c.penname ?? undefined,
      space: c.space ?? undefined,
      hall: c.hall ?? undefined,
      twitter_url: c.twitterUrl ?? undefined,
      website_url: c.websiteUrl ?? undefined,
      pixiv_url: c.pixivUrl ?? undefined,
      description: c.description ?? undefined,
      circle_cut_filename: c.circleCutFilename ?? undefined,
      priority_color: c.priorityColor,
      memo: c.memo || undefined,
      absence_status: c.absenceStatus ?? undefined,
      existing_only_status: c.existingOnlyStatus ?? undefined,
      catalog_status: c.catalogStatus ?? undefined,
      pin_x: c.pinX ?? undefined,
      pin_y: c.pinY ?? undefined,
      map_number: c.mapNumber ?? undefined,
      checked: c.purchaseStatus,
      items: items.map((i) => ({
        ...parseJsonObject<Record<string, unknown>>(i.rawJson),
        name: i.name,
        price: i.price ?? undefined,
        type: i.type ?? undefined,
        description: i.description ?? undefined,
        checked: i.purchaseStatus,
      })),
      item_images: images.map((img) => ({
        ...parseJsonObject<Record<string, unknown>>(img.rawJson),
        path: img.filename,
        source: img.source,
      })),
    });
  }

  const baseEvent = parseJsonObject<ImportData["event"]>(event.rawJson);
  const baseMetadata = parseJsonObject<ImportData["metadata"]>(event.metadataJson);

  const preservedRoot = parseJsonObject<Record<string, unknown>>(rootRow?.sync_root_json);
  const preservedMetadata = parseJsonObject<ImportData["metadata"]>(String((preservedRoot as any).metadata ?? ""));
  return {
    ...preservedRoot,
    event: {
      ...baseEvent,
      name: event.name,
      url: event.url,
      date: event.date ?? undefined,
      venue: event.venue ?? undefined,
      organizer: event.organizer ?? undefined,
      memo: event.memo || undefined,
      completed: event.completed || undefined,
      shopping_started_at: event.shoppingStartedAt ?? undefined,
      shopping_ended_at: event.shoppingEndedAt ?? undefined,
      event_image: event.eventImageFilename
        ? event.eventImageFilename.split("/").pop()
        : undefined,
      event_image_filename: event.eventImageFilename
        ? event.eventImageFilename.split("/").pop()
        : undefined,
      maps: maps.map((m) => ({
        ...parseJsonObject<Record<string, unknown>>(m.rawJson),
        filename: m.filename,
        map_number: m.mapNumber,
      })),
    },
    circles: exportCircles,
    metadata: {
      ...preservedMetadata,
      ...baseMetadata,
      generated_at: new Date().toISOString(),
      format_version: baseMetadata.format_version ?? "1.0",
      total_circles: exportCircles.length,
      export_type: "result",
    },
  };
}

// --- ZIPエクスポート ---

export interface ExportProgress {
  current: number;
  total: number;
  phase: "images" | "zip";
}

/**
 * イベントデータをZIP形式でエクスポート（画像含む完全バックアップ）
 * @returns ZIPファイルのパス
 */
export async function exportEventAsZip(
  eventId: number,
  onProgress?: (progress: ExportProgress) => void,
): Promise<string> {
  const data = await exportEventData(eventId);
  if (!data) throw new Error("Event not found");

  const imgDir = `${IMAGES_DIR}${eventId}/`;
  const zipData = JSON.parse(JSON.stringify(data)) as ImportData;
  const exportDir = `${FileSystem.cacheDirectory}eventtrail_export_${eventId}_${Date.now()}/`;

  const mapOriginalPaths = new Map<ImportEventMap, string>();
  for (let i = 0; i < (data.event.maps ?? []).length; i++) {
    const sourceMap = data.event.maps?.[i];
    const zipMap = zipData.event.maps?.[i];
    if (sourceMap?.filename && zipMap?.filename) {
      mapOriginalPaths.set(zipMap, sourceMap.filename);
      zipMap.filename = `maps/${basenameFromPath(sourceMap.filename)}`;
    }
  }

  const circleOriginalCuts = new Map<ImportCircle, string>();
  const itemOriginalPaths = new Map<ImportItemImage, string>();
  for (let i = 0; i < data.circles.length; i++) {
    const sourceCircle = data.circles[i];
    const zipCircle = zipData.circles[i];
    if (sourceCircle.circle_cut_filename && zipCircle.circle_cut_filename) {
      circleOriginalCuts.set(zipCircle, sourceCircle.circle_cut_filename);
      zipCircle.circle_cut_filename = `circles/${basenameFromPath(sourceCircle.circle_cut_filename)}`;
    }
    for (let j = 0; j < (sourceCircle.item_images ?? []).length; j++) {
      const sourceImage = sourceCircle.item_images?.[j];
      const zipImage = zipCircle.item_images?.[j];
      if (sourceImage?.path && zipImage?.path) {
        itemOriginalPaths.set(zipImage, sourceImage.path);
        zipImage.path = `items/${basenameFromPath(sourceImage.path)}`;
      }
    }
  }

  const safeName = data.event.name.replace(
    /[^a-zA-Z0-9\u3000-\u9FFF\uF900-\uFAFF]/g,
    "_",
  );
  const filePath = `${FileSystem.cacheDirectory}${safeName}_result.zip`;

  try {
    await FileSystem.deleteAsync(exportDir, { idempotent: true });
    await ensureDirectory(exportDir);
    await FileSystem.writeAsStringAsync(
      `${exportDir}event.json`,
      JSON.stringify(zipData, null, 2),
    );

    let imageCount = 0;
    const totalImages = await countExportImages(data, imgDir);
    const assetManifest = createAssetManifest();
    const bumpProgress = () => {
      imageCount++;
      onProgress?.({ current: imageCount, total: totalImages, phase: "images" });
    };

    for (const map of zipData.event.maps ?? []) {
      if (!map.filename) continue;
      const originalPath = mapOriginalPaths.get(map) ?? map.filename;
      const filePathForMap = originalPath.startsWith("file:///")
        ? originalPath
        : resolveExportImagePath(originalPath, `${imgDir}${originalPath}`);
      if (
        await copyExportAsset(
          filePathForMap,
          map.filename,
          exportDir,
          assetManifest,
        )
      ) {
        bumpProgress();
      }
    }

    if (data.event.event_image_filename) {
      const evImgName = data.event.event_image_filename;
      const filePathForEventImage = evImgName.startsWith("file:///")
        ? evImgName
        : resolveExportImagePath(evImgName, `${imgDir}${evImgName}`);
      if (
        await copyExportAsset(
          filePathForEventImage,
          `event_image/${basenameFromPath(evImgName)}`,
          exportDir,
          assetManifest,
        )
      ) {
        bumpProgress();
      }
    }

    for (const circle of zipData.circles) {
      if (circle.circle_cut_filename) {
        const originalPath =
          circleOriginalCuts.get(circle) ?? circle.circle_cut_filename;
        const filePathForCut = originalPath.startsWith("file:///")
          ? originalPath
          : resolveExportImagePath(
              originalPath,
              `${imgDir}cuts/${basenameFromPath(originalPath)}`,
            );
        if (
          await copyExportAsset(
            filePathForCut,
            circle.circle_cut_filename,
            exportDir,
            assetManifest,
          )
        ) {
          bumpProgress();
        }
      }

      for (const img of circle.item_images ?? []) {
        const originalPath = itemOriginalPaths.get(img) ?? img.path;
        const filePathForItemImage = originalPath.startsWith("file:///")
          ? originalPath
          : resolveExportImagePath(
              originalPath,
              `${imgDir}items/${basenameFromPath(originalPath)}`,
            );
        if (
          await copyExportAsset(
            filePathForItemImage,
            img.path,
            exportDir,
            assetManifest,
          )
        ) {
          bumpProgress();
        }
      }
    }

    try {
      const favorites = await getFavoriteCircles();
      const cmData = await readStoredCircleMasterData();
      for (const fav of favorites) {
        const key = fav.name || fav.tag;
        if (key) {
          const existing = cmData.circles[key] ?? {
            penname: fav.tag,
            favorite: true,
            genre: "",
            default_cut: null,
          };
          cmData.circles[key] = {
            ...existing,
            penname: existing.penname || fav.tag,
            favorite: true,
          };
        }
      }
      await FileSystem.writeAsStringAsync(
        `${exportDir}circle_master.json`,
        JSON.stringify(cmData, null, 2),
      );
      const cutsInfo = await FileSystem.getInfoAsync(DEFAULT_CUTS_DIR);
      if (cutsInfo.exists) {
        const cutNames = await FileSystem.readDirectoryAsync(DEFAULT_CUTS_DIR);
        for (const cutName of cutNames) {
          const source = `${DEFAULT_CUTS_DIR}${cutName}`;
          const info = await FileSystem.getInfoAsync(source);
          if (!info.exists || (info as any).isDirectory) continue;
          await copyExportAsset(
            source,
            `default_cuts/${cutName}`,
            exportDir,
            assetManifest,
          );
        }
      }
    } catch (e) {
      console.warn("circle_master.json export skipped:", e);
    }

    await FileSystem.writeAsStringAsync(
      `${exportDir}asset_manifest.json`,
      JSON.stringify(assetManifest, null, 2),
    );

    onProgress?.({ current: 0, total: 1, phase: "zip" });
    await FileSystem.deleteAsync(filePath, { idempotent: true });
    await zipDirectory(exportDir, filePath);
    onProgress?.({ current: 1, total: 1, phase: "zip" });
    return filePath;
  } finally {
    await FileSystem.deleteAsync(exportDir, { idempotent: true }).catch(
      () => undefined,
    );
  }
}

/** エクスポート対象の画像数をカウント */
async function countExportImages(
  data: ImportData,
  imgDir: string,
): Promise<number> {
  let count = 0;
  // イベント画像
  if (data.event.event_image_filename) {
    const evImgName = data.event.event_image_filename;
    const filePath = evImgName.startsWith("file:///")
      ? evImgName
      : resolveExportImagePath(evImgName, `${imgDir}${evImgName}`);
    const info = await FileSystem.getInfoAsync(filePath);
    if (info.exists) count++;
  }
  for (const map of data.event.maps ?? []) {
    if (map.filename) {
      const filePath = map.filename.startsWith("file:///")
        ? map.filename
        : resolveExportImagePath(map.filename, `${imgDir}${map.filename}`);
      const info = await FileSystem.getInfoAsync(filePath);
      if (info.exists) count++;
    }
  }
  for (const circle of data.circles) {
    if (circle.circle_cut_filename) {
      const filePath = circle.circle_cut_filename.startsWith("file:///")
        ? circle.circle_cut_filename
        : resolveExportImagePath(
            circle.circle_cut_filename,
            `${imgDir}cuts/${basenameFromPath(circle.circle_cut_filename)}`,
          );
      const info = await FileSystem.getInfoAsync(filePath);
      if (info.exists) count++;
    }
    for (const img of circle.item_images ?? []) {
      const filePath = img.path.startsWith("file:///")
        ? img.path
        : resolveExportImagePath(
            img.path,
            `${imgDir}items/${basenameFromPath(img.path)}`,
          );
      const info = await FileSystem.getInfoAsync(filePath);
      if (info.exists) count++;
    }
  }
  return count;
}

// --- アイテム名一括取得 ---

/** イベント内の全サークルのアイテム名をまとめて取得 */
export async function getItemNamesByEvent(
  eventId: number,
): Promise<Map<number, string[]>> {
  const database = await getDatabase();
  const rows = await database.getAllAsync<any>(
    "SELECT circle_id, name, description FROM items WHERE circle_id IN (SELECT id FROM circles WHERE event_id = ?)",
    eventId,
  );
  const map = new Map<number, string[]>();
  for (const row of rows) {
    if (!map.has(row.circle_id)) map.set(row.circle_id, []);
    [row.name, row.description]
      .filter((value) => typeof value === "string" && value.trim() !== "")
      .forEach((value) => map.get(row.circle_id)!.push(value));
  }
  return map;
}

export interface ItemSearchResult {
  id: number;
  circleId: number;
  name: string;
  description: string | null;
  price: number | null;
  type: string | null;
  purchaseStatus: PurchaseStatusValue;
}

export function isItemSearchFtsAvailable(): boolean {
  return itemFtsAvailable;
}

/** 検索入力が空の間は SQL を発行しない on-demand 検索 API。 */
export async function searchItemsByEvent(
  eventId: number,
  query: string,
  limit = 100,
): Promise<ItemSearchResult[]> {
  const normalized = query.trim();
  if (!normalized) return [];
  const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const database = await getDatabase();
  await ensureItemFtsReady();
  const rows = itemFtsAvailable
    ? await measuredGetAll<any>(
        database,
        `SELECT i.id, i.circle_id, i.name, i.description, i.price, i.type, i.purchase_status
         FROM items_fts f
         JOIN items i ON i.id = f.item_id
         JOIN circles c ON c.id = i.circle_id
         WHERE c.event_id = ? AND f MATCH ?
         ORDER BY i.name_key LIMIT ?`,
        eventId,
        normalized.replace(/["*]/g, " ").trim() + "*",
        boundedLimit,
      )
    : await measuredGetAll<any>(
        database,
        `SELECT i.id, i.circle_id, i.name, i.description, i.price, i.type, i.purchase_status
         FROM items i JOIN circles c ON c.id = i.circle_id
         WHERE c.event_id = ? AND (i.name_key LIKE '%' || ? || '%' OR
           LOWER(COALESCE(i.description, '')) LIKE '%' || LOWER(?) || '%')
         ORDER BY i.name_key LIMIT ?`,
        eventId,
        normalizePurchaseLookupKey(normalized),
        normalized,
        boundedLimit,
      );
  return rows.map((row) => ({
    id: Number(row.id),
    circleId: Number(row.circle_id),
    name: String(row.name ?? ""),
    description: row.description ?? null,
    price: row.price == null ? null : Number(row.price),
    type: row.type ?? null,
    purchaseStatus: Number(row.purchase_status ?? 0) as PurchaseStatusValue,
  }));
}

/** インポート後の件数表示を 1 aggregate query で取得する。 */
export interface EventImportSummary {
  eventName: string;
  circleCount: number;
  mapCount: number;
  imageCount: number;
  itemCount: number;
}

export async function getEventImportSummary(eventId: number): Promise<EventImportSummary> {
  const database = await getDatabase();
  const row = await measuredGetFirst<any>(
    database,
    `SELECT e.name AS event_name,
      (SELECT COUNT(*) FROM circles c WHERE c.event_id = e.id) AS circle_count,
      (SELECT COUNT(*) FROM event_maps m WHERE m.event_id = e.id) AS map_count,
      (SELECT COUNT(*) FROM items i JOIN circles c2 ON c2.id = i.circle_id WHERE c2.event_id = e.id) AS item_count,
      (SELECT COUNT(*) FROM item_images ii JOIN circles c3 ON c3.id = ii.circle_id WHERE c3.event_id = e.id) AS image_count
     FROM events e WHERE e.id = ?`,
    eventId,
  );
  return {
    eventName: row?.event_name ?? "不明",
    circleCount: Number(row?.circle_count ?? 0),
    mapCount: Number(row?.map_count ?? 0),
    imageCount: Number(row?.image_count ?? 0),
    itemCount: Number(row?.item_count ?? 0),
  };
}

// --- 統計 ---

export async function getEventStats(eventId: number): Promise<{
  totalCircles: number;
  boughtCircles: number;
  couldntBuyCircles: number;
  skippedCircles: number;
  remainingCircles: number;
}> {
  const database = await getDatabase();
  const row = await measuredGetFirst<any>(
    database,
    `SELECT COUNT(*) AS total_count,
      SUM(CASE WHEN checked = 1 THEN 1 ELSE 0 END) AS bought_count,
      SUM(CASE WHEN checked = 2 THEN 1 ELSE 0 END) AS couldnt_buy_count,
      SUM(CASE WHEN checked = 3 THEN 1 ELSE 0 END) AS skipped_count
     FROM circles WHERE event_id = ?`,
    eventId,
  );
  const totalCount = Number(row?.total_count ?? 0);
  const boughtCount = Number(row?.bought_count ?? 0);
  const couldntBuyCount = Number(row?.couldnt_buy_count ?? 0);
  const skippedCount = Number(row?.skipped_count ?? 0);
  return {
    totalCircles: totalCount,
    boughtCircles: boughtCount,
    couldntBuyCircles: couldntBuyCount,
    skippedCircles: skippedCount,
    remainingCircles: totalCount - boughtCount - couldntBuyCount - skippedCount,
  };
}

export interface EventDashboard {
  stats: Awaited<ReturnType<typeof getEventStats>>;
  budget: BudgetSummary;
}

/** 詳細画面向け aggregate API。旧 API との互換性を保ちつつ一箇所に集約する。 */
export async function getEventDashboard(eventId: number): Promise<EventDashboard> {
  const database = await getDatabase();
  const effectiveStatus = `CASE WHEN i.id IS NULL THEN c.checked ELSE COALESCE(i.purchase_status, 0) END`;
  const rows = await measuredGetAll<any>(
    database,
    `WITH base AS (
      SELECT c.id AS circle_id, c.priority_color, COALESCE(i.price, 0) AS price,
        ${effectiveStatus} AS status
      FROM circles c LEFT JOIN items i ON i.circle_id = c.id WHERE c.event_id = ?
    ), grouped AS (
      SELECT priority_color, SUM(price) AS total,
        SUM(CASE WHEN status IN (0, 1) THEN price ELSE 0 END) AS planned,
        SUM(CASE WHEN status = 1 THEN price ELSE 0 END) AS bought,
        SUM(CASE WHEN status = 2 THEN price ELSE 0 END) AS couldnt_buy,
        SUM(CASE WHEN status = 3 THEN price ELSE 0 END) AS skipped,
        SUM(CASE WHEN status = 0 THEN price ELSE 0 END) AS remaining,
        COUNT(DISTINCT circle_id) AS circle_count
      FROM base GROUP BY priority_color
    ), totals AS (
      SELECT SUM(price) AS total_list_price,
        SUM(CASE WHEN status IN (0, 1) THEN price ELSE 0 END) AS total_planned,
        SUM(CASE WHEN status = 1 THEN price ELSE 0 END) AS total_bought,
        SUM(CASE WHEN status = 2 THEN price ELSE 0 END) AS total_couldnt_buy,
        SUM(CASE WHEN status = 3 THEN price ELSE 0 END) AS total_skipped,
        SUM(CASE WHEN status = 0 THEN price ELSE 0 END) AS total_remaining
      FROM base
    ), stats AS (
      SELECT COUNT(*) AS total_circles,
        SUM(CASE WHEN checked = 1 THEN 1 ELSE 0 END) AS bought_circles,
        SUM(CASE WHEN checked = 2 THEN 1 ELSE 0 END) AS couldnt_buy_circles,
        SUM(CASE WHEN checked = 3 THEN 1 ELSE 0 END) AS skipped_circles
      FROM circles WHERE event_id = ?
    )
    SELECT 'total' AS row_type, NULL AS priority_color, NULL AS total,
      NULL AS planned, NULL AS bought, NULL AS couldnt_buy, NULL AS skipped,
      NULL AS remaining, NULL AS circle_count,
      total_list_price, total_planned, total_bought, total_couldnt_buy,
      total_skipped, total_remaining, NULL AS total_circles,
      NULL AS bought_circles, NULL AS couldnt_buy_circles,
      NULL AS skipped_circles
    FROM totals
    UNION ALL
    SELECT 'priority', priority_color, total, planned, bought, couldnt_buy,
      skipped, remaining, circle_count, NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL
    FROM grouped
    UNION ALL
    SELECT 'stats', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL, NULL, NULL, total_circles, bought_circles,
      couldnt_buy_circles, skipped_circles
    FROM stats
    ORDER BY row_type, priority_color`,
    eventId,
    eventId,
  );
  const total = rows.find((row) => row.row_type === "total") ?? {};
  const stat = rows.find((row) => row.row_type === "stats") ?? {};
  return {
    stats: {
      totalCircles: Number(stat.total_circles ?? 0),
      boughtCircles: Number(stat.bought_circles ?? 0),
      couldntBuyCircles: Number(stat.couldnt_buy_circles ?? 0),
      skippedCircles: Number(stat.skipped_circles ?? 0),
      remainingCircles:
        Number(stat.total_circles ?? 0) - Number(stat.bought_circles ?? 0) -
        Number(stat.couldnt_buy_circles ?? 0) - Number(stat.skipped_circles ?? 0),
    },
    budget: {
      totalListPrice: Number(total.total_list_price ?? 0),
      totalPlanned: Number(total.total_planned ?? 0),
      totalBought: Number(total.total_bought ?? 0),
      totalCouldntBuy: Number(total.total_couldnt_buy ?? 0),
      totalSkipped: Number(total.total_skipped ?? 0),
      totalRemaining: Number(total.total_remaining ?? 0),
      byPriority: rows.filter((row) => row.row_type === "priority").map((row) => ({
        priorityColor: Number(row.priority_color),
        total: Number(row.total ?? 0),
        planned: Number(row.planned ?? 0),
        bought: Number(row.bought ?? 0),
        couldntBuy: Number(row.couldnt_buy ?? 0),
        skipped: Number(row.skipped ?? 0),
        remaining: Number(row.remaining ?? 0),
        circleCount: Number(row.circle_count ?? 0),
      })),
    },
  };
}

// --- マッパー ---

function mapEvent(row: any): Event {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    date: row.date,
    venue: row.venue,
    organizer: row.organizer,
    memo: row.memo ?? "",
    completed: !!row.completed,
    importedAt: row.imported_at,
    shoppingStartedAt: row.shopping_started_at ?? null,
    shoppingEndedAt: row.shopping_ended_at ?? null,
    eventImageFilename: row.event_image_filename ?? null,
    rawJson: row.raw_json ?? null,
    metadataJson: row.metadata_json ?? null,
  };
}

function mapCircle(row: any): Circle {
  return {
    id: row.id,
    eventId: row.event_id,
    name: row.name,
    penname: row.penname,
    space: row.space,
    hall: row.hall,
    twitterUrl: row.twitter_url,
    websiteUrl: row.website_url,
    pixivUrl: row.pixiv_url,
    description: row.description,
    genres: row.genres ?? "[]",
    tags: row.tags ?? "[]",
    circleCutFilename: row.circle_cut_filename,
    priorityColor: row.priority_color,
    memo: row.memo ?? "",
    hasCatalogPost: !!row.has_catalog_post,
    purchaseStatus: (row.checked ?? 0) as import("./types").PurchaseStatusValue,
    pinX: row.pin_x,
    pinY: row.pin_y,
    mapNumber: row.map_number,
    absenceStatus: row.absence_status,
    existingOnlyStatus: row.existing_only_status,
    catalogStatus: row.catalog_status ?? null,
    rawJson: row.raw_json ?? null,
  };
}

function mapItem(row: any): Item {
  return {
    id: row.id,
    circleId: row.circle_id,
    name: row.name,
    price: row.price,
    type: row.type,
    description: row.description,
    purchaseStatus: (row.purchase_status ??
      0) as import("./types").PurchaseStatusValue,
    purchaseStatusSource: row.purchase_status_source ?? null,
    rawJson: row.raw_json ?? null,
  };
}

function mapItemImage(row: any): ItemImage {
  return {
    id: row.id,
    circleId: row.circle_id,
    filename: row.filename,
    source: row.source,
    rawJson: row.raw_json ?? null,
  };
}

function mapEventMap(row: any): EventMap {
  return {
    id: row.id,
    eventId: row.event_id,
    filename: row.filename,
    mapNumber: row.map_number,
    rawJson: row.raw_json ?? null,
  };
}

// --- アプリ設定 ---

export async function getSetting(key: string): Promise<string | null> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<{ value: string }>(
    "SELECT value FROM app_settings WHERE key = ?",
    key,
  );
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const database = await getDatabase();
  await database.runAsync(
    "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)",
    key,
    value,
  );
}
