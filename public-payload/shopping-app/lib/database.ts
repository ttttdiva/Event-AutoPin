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

const DB_NAME = "doujin_shopping.db";

let db: SQLite.SQLiteDatabase | null = null;
let dbInitPromise: Promise<SQLite.SQLiteDatabase> | null = null;

/** データベースを開いて初期化 */
export async function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;
  if (!dbInitPromise) {
    dbInitPromise = (async () => {
      const database = await SQLite.openDatabaseAsync(DB_NAME);
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
async function initDatabase(database: SQLite.SQLiteDatabase): Promise<void> {
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
      imported_at TEXT NOT NULL DEFAULT (datetime('now'))
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
      raw_json TEXT
    );

    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      price REAL,
      type TEXT,
      description TEXT,
      purchase_status_source TEXT,
      raw_json TEXT
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
  `);

  // --- マイグレーション: items テーブルに purchase_status カラム追加 ---
  try {
    await database.execAsync(`
      ALTER TABLE items ADD COLUMN purchase_status INTEGER NOT NULL DEFAULT 0;
    `);
  } catch {
    /* カラム既存なら無視 */
  }

  // --- マイグレーション: items テーブルに sort_order カラム追加 ---
  try {
    await database.execAsync(`
      ALTER TABLE items ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
    `);
  } catch {
    /* カラム既存なら無視 */
  }

  // --- マイグレーション: items テーブルに購入ステータス連動元カラム追加 ---
  try {
    await database.execAsync(`
      ALTER TABLE items ADD COLUMN purchase_status_source TEXT;
    `);
  } catch {
    /* カラム既存なら無視 */
  }

  // --- マイグレーション: events テーブルに買い物モード用カラム追加 ---
  try {
    await database.execAsync(`
      ALTER TABLE events ADD COLUMN shopping_started_at TEXT;
    `);
  } catch {
    /* カラム既存なら無視 */
  }
  try {
    await database.execAsync(`
      ALTER TABLE events ADD COLUMN shopping_ended_at TEXT;
    `);
  } catch {
    /* カラム既存なら無視 */
  }

  // --- マイグレーション: events テーブルにメモカラム追加 ---
  try {
    await database.execAsync(`
      ALTER TABLE events ADD COLUMN memo TEXT NOT NULL DEFAULT '';
    `);
  } catch {
    /* カラム既存なら無視 */
  }

  // --- マイグレーション: events テーブルに完了フラグ追加 ---
  try {
    await database.execAsync(`
      ALTER TABLE events ADD COLUMN completed INTEGER NOT NULL DEFAULT 0;
    `);
  } catch {
    /* カラム既存なら無視 */
  }

  // --- マイグレーション: events テーブルにイベント画像カラム追加 ---
  try {
    await database.execAsync(`
      ALTER TABLE events ADD COLUMN event_image_filename TEXT;
    `);
  } catch {
    /* カラム既存なら無視 */
  }

  for (const sql of [
    "ALTER TABLE events ADD COLUMN raw_json TEXT;",
    "ALTER TABLE events ADD COLUMN metadata_json TEXT;",
    "ALTER TABLE event_maps ADD COLUMN raw_json TEXT;",
    "ALTER TABLE circles ADD COLUMN catalog_status TEXT;",
    "ALTER TABLE circles ADD COLUMN raw_json TEXT;",
    "ALTER TABLE items ADD COLUMN raw_json TEXT;",
    "ALTER TABLE item_images ADD COLUMN raw_json TEXT;",
  ]) {
    try {
      await database.execAsync(sql);
    } catch {
      /* カラム既存なら無視 */
    }
  }
}

// --- Event CRUD ---

export async function getAllEvents(): Promise<Event[]> {
  const database = await getDatabase();
  const rows = await database.getAllAsync<any>(
    "SELECT * FROM events ORDER BY imported_at DESC",
  );
  return rows.map(mapEvent);
}

export async function getEvent(id: number): Promise<Event | null> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<any>(
    "SELECT * FROM events WHERE id = ?",
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
  const database = await getDatabase();
  const result = await database.runAsync(
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
  const database = await getDatabase();
  await database.runAsync(
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
  const database = await getDatabase();
  await database.runAsync(
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
  const destPath = `${imgDir}event_image.${ext}`;

  // 既存の画像があれば削除
  const existingEvent = await getEvent(eventId);
  if (existingEvent?.eventImageFilename) {
    const oldInfo = await FileSystem.getInfoAsync(
      existingEvent.eventImageFilename,
    );
    if (oldInfo.exists) {
      await FileSystem.deleteAsync(existingEvent.eventImageFilename, {
        idempotent: true,
      });
    }
  }

  await FileSystem.copyAsync({ from: asset.uri, to: destPath });
  await updateEventImage(eventId, destPath);
  return destPath;
}

/** イベント画像を削除 */
export async function removeEventImage(eventId: number): Promise<void> {
  const event = await getEvent(eventId);
  if (event?.eventImageFilename) {
    const info = await FileSystem.getInfoAsync(event.eventImageFilename);
    if (info.exists) {
      await FileSystem.deleteAsync(event.eventImageFilename, {
        idempotent: true,
      });
    }
  }
  await updateEventImage(eventId, null);
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

  await deleteFileIfExists(circle.circleCutFilename);
  await FileSystem.copyAsync({ from: asset.uri, to: destPath });

  const database = await getDatabase();
  await database.runAsync(
    "UPDATE circles SET circle_cut_filename = ? WHERE id = ?",
    destPath,
    circleId,
  );
  await registerDefaultCutFromImage(circle.name, circle.penname, destPath, {
    overwriteExisting: true,
  });
  return destPath;
}

/** 画像ピッカーでおしながき画像を差し替える */
export async function pickAndReplaceItemImage(
  imageId: number,
): Promise<ItemImage | null> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<any>(
    `SELECT ii.*, c.event_id
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

  await deleteFileIfExists(row.filename);
  await FileSystem.copyAsync({ from: asset.uri, to: destPath });
  await database.runAsync(
    "UPDATE item_images SET filename = ?, source = ? WHERE id = ?",
    destPath,
    "manual",
    imageId,
  );

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

  await FileSystem.copyAsync({ from: asset.uri, to: destPath });
  const database = await getDatabase();
  const resultRow = await database.runAsync(
    "INSERT INTO item_images (circle_id, filename, source) VALUES (?, ?, ?)",
    circleId,
    destPath,
    "manual",
  );
  if (!circle.circleCutFilename) {
    await database.runAsync(
      "UPDATE circles SET circle_cut_filename = ? WHERE id = ?",
      destPath,
      circleId,
    );
    await registerDefaultCutFromImage(circle.name, circle.penname, destPath);
  }

  return {
    id: resultRow.lastInsertRowId,
    circleId,
    filename: destPath,
    source: "manual",
    rawJson: null,
  };
}

export async function deleteEvent(id: number): Promise<void> {
  const database = await getDatabase();
  await database.runAsync("DELETE FROM events WHERE id = ?", id);
}

// --- Circle CRUD ---

export async function getCirclesByEvent(eventId: number): Promise<Circle[]> {
  const database = await getDatabase();
  const rows = await database.getAllAsync<any>(
    `SELECT
      c.*,
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

export async function getCircle(id: number): Promise<Circle | null> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<any>(
    "SELECT * FROM circles WHERE id = ?",
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
  const database = await getDatabase();
  const result = await database.runAsync(
    `INSERT INTO circles (event_id, name, penname, space, hall, priority_color, memo, twitter_url, website_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    eventId,
    name,
    penname ?? null,
    space ?? null,
    hall ?? null,
    priorityColor ?? 5,
    memo ?? "",
    twitterUrl ?? null,
    websiteUrl ?? null,
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
  const database = await getDatabase();
  await database.runAsync(
    `UPDATE circles SET
      name = ?, penname = ?, space = ?, hall = ?,
      priority_color = ?, memo = ?,
      twitter_url = ?, website_url = ?, pixiv_url = ?,
      description = ?, absence_status = ?, existing_only_status = ?
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
    id,
  );
}

/** サークルを削除 */
export async function deleteCircle(id: number): Promise<void> {
  const database = await getDatabase();
  await database.runAsync("DELETE FROM circles WHERE id = ?", id);
}

/** 購入状態を更新（0=未購入, 1=買えた, 2=買えなかった） */
export async function updateCirclePurchaseStatus(
  id: number,
  status: PurchaseStatusValue,
): Promise<void> {
  const database = await getDatabase();
  await database.runAsync(
    "UPDATE circles SET checked = ? WHERE id = ?",
    status,
    id,
  );
}

// Keep only untouched or circle-linked items in sync with the circle status.
async function updateLinkedItemsFromCircleStatus(
  database: SQLite.SQLiteDatabase,
  circleId: number,
  status: PurchaseStatusValue,
): Promise<void> {
  if (status === PURCHASE_STATUS.NOT_YET) return;

  await database.runAsync(
    `UPDATE items
     SET purchase_status = ?, purchase_status_source = 'circle'
     WHERE circle_id = ?
       AND (purchase_status = ? OR purchase_status_source = 'circle')`,
    status,
    circleId,
    PURCHASE_STATUS.NOT_YET,
  );
}

export async function updateItemsFromCirclePurchaseStatus(
  circleId: number,
  status: PurchaseStatusValue,
): Promise<void> {
  const database = await getDatabase();
  await updateLinkedItemsFromCircleStatus(database, circleId, status);
}

/** 購入状態を次の状態にトグル（0→1→2→3→0） */
export async function cycleCirclePurchaseStatus(
  id: number,
): Promise<PurchaseStatusValue> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<any>(
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
  await database.runAsync(
    "UPDATE circles SET checked = ? WHERE id = ?",
    next,
    id,
  );
  await updateLinkedItemsFromCircleStatus(database, id, next);
  return next;
}

export async function updateCircleMemo(
  id: number,
  memo: string,
): Promise<void> {
  const database = await getDatabase();
  await database.runAsync("UPDATE circles SET memo = ? WHERE id = ?", memo, id);
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
  const database = await getDatabase();
  const row = await database.getFirstAsync<{ memo: string | null }>(
    "SELECT memo FROM circles WHERE id = ?",
    id,
  );
  const memo = removeStatusUrlsFromMemo(row?.memo ?? "");
  await database.runAsync(
    "UPDATE circles SET memo = ?, catalog_status = ? WHERE id = ?",
    memo,
    "needs_recheck",
    id,
  );
  return { memo, catalogStatus: "needs_recheck" };
}

export async function updateEventMemo(id: number, memo: string): Promise<void> {
  const database = await getDatabase();
  await database.runAsync("UPDATE events SET memo = ? WHERE id = ?", memo, id);
}

export async function toggleEventCompleted(id: number): Promise<boolean> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<any>(
    "SELECT completed FROM events WHERE id = ?",
    id,
  );
  const next = row?.completed ? 0 : 1;
  await database.runAsync(
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
  const database = await getDatabase();
  await database.runAsync(
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
  const database = await getDatabase();
  await database.runAsync(
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
  const database = await getDatabase();
  await database.runAsync(
    "UPDATE circles SET pin_x = ?, pin_y = ?, map_number = ? WHERE id = ?",
    pinX,
    pinY,
    mapNumber,
    id,
  );
}

// --- Item / ItemImage ---

export async function getItemsByCircle(circleId: number): Promise<Item[]> {
  const database = await getDatabase();
  const rows = await database.getAllAsync<any>(
    "SELECT * FROM items WHERE circle_id = ? ORDER BY sort_order ASC, id ASC",
    circleId,
  );
  return rows.map(mapItem);
}

export async function getItemImagesByCircle(
  circleId: number,
): Promise<ItemImage[]> {
  const database = await getDatabase();
  const rows = await database.getAllAsync<any>(
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
  const database = await getDatabase();
  const result = await database.runAsync(
    "INSERT INTO items (circle_id, name, price, type, description) VALUES (?, ?, ?, ?, ?)",
    circleId,
    name,
    price,
    type,
    description,
  );
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
  const database = await getDatabase();
  await database.runAsync(
    "UPDATE items SET name = ?, price = ?, type = ?, description = ? WHERE id = ?",
    name,
    price,
    type,
    description,
    itemId,
  );
}

export async function updateItemPurchaseStatus(
  itemId: number,
  status: PurchaseStatusValue,
): Promise<void> {
  const database = await getDatabase();
  await database.runAsync(
    "UPDATE items SET purchase_status = ?, purchase_status_source = 'manual' WHERE id = ?",
    status,
    itemId,
  );
}

export function normalizePurchaseLookupKey(
  value: string | null | undefined,
): string {
  const raw = String(value ?? "");
  const normalized =
    typeof raw.normalize === "function" ? raw.normalize("NFKC") : raw;
  return normalized
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

export async function getBoughtItemNameKeysForCircle(
  circleName: string,
  penname: string | null | undefined,
): Promise<Set<string>> {
  const database = await getDatabase();
  const targetCircleName = normalizePurchaseLookupKey(circleName);
  const targetPenname = normalizePurchaseLookupKey(penname);
  if (!targetCircleName && !targetPenname) return new Set();

  const rows = await database.getAllAsync<any>(
    `SELECT c.name as circle_name, c.penname as penname, i.name as item_name
     FROM items i
     JOIN circles c ON c.id = i.circle_id
     WHERE i.purchase_status = ?`,
    PURCHASE_STATUS.BOUGHT,
  );

  const keys = new Set<string>();
  for (const row of rows) {
    const rowCircleName = normalizePurchaseLookupKey(row.circle_name);
    const rowPenname = normalizePurchaseLookupKey(row.penname);
    const circleMatches =
      (!!targetCircleName && rowCircleName === targetCircleName) ||
      (!!targetPenname && rowPenname === targetPenname);
    if (!circleMatches) continue;

    const itemKey = normalizePurchaseLookupKey(row.item_name);
    if (itemKey) keys.add(itemKey);
  }
  return keys;
}

export async function deleteItem(itemId: number): Promise<void> {
  const database = await getDatabase();
  await database.runAsync("DELETE FROM items WHERE id = ?", itemId);
}

/** アイテムの並び順を入れ替え */
export async function reorderItem(
  circleId: number,
  fromIndex: number,
  toIndex: number,
): Promise<void> {
  const database = await getDatabase();
  const items = await database.getAllAsync<any>(
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
    await database.runAsync(
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
  const database = await getDatabase();
  const rows = await database.getAllAsync<any>(
    "SELECT * FROM favorite_circles ORDER BY added_at DESC",
  );
  return rows.map((r: any) => ({ id: r.id, name: r.name, tag: r.tag }));
}

export async function addFavoriteCircle(
  name: string,
  tag: string,
): Promise<void> {
  const database = await getDatabase();
  await database.runAsync(
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
  const database = await getDatabase();
  await database.runAsync(
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
  const database = await getDatabase();
  const row = await database.getFirstAsync<any>(
    "SELECT 1 FROM favorite_circles WHERE (name != '' AND name = ?) OR (tag != '' AND tag = ?) LIMIT 1",
    name,
    tag,
  );
  return !!row;
}

// --- EventMap ---

export async function getEventMaps(eventId: number): Promise<EventMap[]> {
  const database = await getDatabase();
  const rows = await database.getAllAsync<any>(
    "SELECT * FROM event_maps WHERE event_id = ? ORDER BY map_number",
    eventId,
  );
  return rows.map(mapEventMap);
}

// --- 画像保存ヘルパー ---

const IMAGES_DIR = `${FileSystem.documentDirectory}images/`;
const DEFAULT_CUTS_DIR = `${FileSystem.documentDirectory}default_cuts/`;

function basenameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function resolveExportImagePath(path: string, fallbackPath: string): string {
  if (path.startsWith("file:///")) return path;
  if (path.startsWith("/")) return `file://${path}`;
  return fallbackPath;
}

async function ensureImagesDir(eventId: number): Promise<string> {
  const dir = `${IMAGES_DIR}${eventId}/`;
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

interface SyncBundleManifest {
  format?: string;
  format_version?: number;
  event_count?: number;
  events?: Array<{
    slug: string;
    path: string;
    name?: string;
    date?: string;
  }>;
}

interface AssetManifestEntry {
  algorithm?: string;
  hash?: string;
  path?: string;
  size?: number;
  original_names?: string[];
}

interface AssetManifest {
  format?: string;
  format_version?: number;
  assets?: Record<string, AssetManifestEntry>;
  aliases?: Record<string, string>;
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
    return parsed?.aliases && typeof parsed.aliases === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function resolveImportedAsset(
  extractDir: string,
  manifest: AssetManifest | null,
  candidates: Array<string | undefined | null>,
): Promise<string | null> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const logical = normalizeArchivePath(candidate);
    const direct = `${extractDir}${logical}`;
    const directInfo = await FileSystem.getInfoAsync(direct);
    if (directInfo.exists) return direct;

    const alias = manifest?.aliases?.[logical];
    if (!alias) continue;
    const assetPath = `${extractDir}${normalizeArchivePath(alias)}`;
    const assetInfo = await FileSystem.getInfoAsync(assetPath);
    if (assetInfo.exists) return assetPath;
  }
  return null;
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
  database: SQLite.SQLiteDatabase,
  tableName: "events" | "circles",
): Promise<number> {
  const cached = importRowIdSeeds.get(tableName);
  if (cached != null) {
    const next = cached + 1;
    importRowIdSeeds.set(tableName, next);
    return next;
  }

  const row = await database.getFirstAsync<{ max_id: number | null }>(
    `SELECT COALESCE(MAX(id), 0) AS max_id FROM ${tableName}`,
  );
  const currentMax = Number(row?.max_id ?? 0);
  const seed = Number.isSafeInteger(currentMax) ? currentMax : 0;
  const next = seed + 1;
  importRowIdSeeds.set(tableName, next);
  return next;
}

async function runImportSql(
  database: SQLite.SQLiteDatabase,
  label: string,
  sql: string,
  ...params: unknown[]
): Promise<SQLite.SQLiteRunResult> {
  try {
    return await database.runAsync(sql, ...params.map((value) => toSqlBind(value)));
  } catch (e: any) {
    throw new Error(`${label}: ${e?.message ?? String(e)}`);
  }
}

async function tryRunImportSql(
  database: SQLite.SQLiteDatabase,
  sql: string,
  ...params: unknown[]
): Promise<void> {
  try {
    await database.runAsync(sql, ...params.map((value) => toSqlBind(value)));
  } catch {
    // Optional imported fields must not block the base event import on older DBs.
  }
}

async function updateImportedEventOptionalFields(
  database: SQLite.SQLiteDatabase,
  eventId: number,
  event: ImportData["event"],
): Promise<void> {
  await tryRunImportSql(
    database,
    "UPDATE events SET memo = ? WHERE id = ?",
    toSqlValue(event.memo, ""),
    toSqlValue(eventId),
  );
  await tryRunImportSql(
    database,
    "UPDATE events SET completed = ? WHERE id = ?",
    toSqlValue(event.completed, 0),
    toSqlValue(eventId),
  );
  await tryRunImportSql(
    database,
    "UPDATE events SET shopping_started_at = ? WHERE id = ?",
    toSqlValue(event.shopping_started_at),
    toSqlValue(eventId),
  );
  await tryRunImportSql(
    database,
    "UPDATE events SET shopping_ended_at = ? WHERE id = ?",
    toSqlValue(event.shopping_ended_at),
    toSqlValue(eventId),
  );
}

async function copyDefaultCutsFromBundle(extractDir: string): Promise<void> {
  const sourceDir = `${extractDir}default_cuts/`;
  const sourceInfo = await FileSystem.getInfoAsync(sourceDir);
  if (!sourceInfo.exists) return;

  await ensureDirectory(DEFAULT_CUTS_DIR);
  const entries = await FileSystem.readDirectoryAsync(sourceDir);
  for (const entry of entries) {
    const source = `${sourceDir}${entry}`;
    const info = await FileSystem.getInfoAsync(source);
    if (!info.exists || (info as any).isDirectory) continue;
    const dest = `${DEFAULT_CUTS_DIR}${entry}`;
    await FileSystem.deleteAsync(dest, { idempotent: true });
    await FileSystem.copyAsync({
      from: source,
      to: dest,
    });
  }
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

  const dest = `${DEFAULT_CUTS_DIR}${filename}`;
  await FileSystem.deleteAsync(dest, { idempotent: true });
  await FileSystem.copyAsync({ from: imagePath, to: dest });
  data.circles[circleName] = {
    ...entry,
    penname: entry.penname || penname || "",
    default_cut: filename,
  };
  await writeStoredCircleMasterData(data);
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

async function importSharedBundleSettings(extractDir: string): Promise<void> {
  try {
    await importCircleMasterFromBundle(extractDir);
    await copyDefaultCutsFromBundle(extractDir);
  } catch {
    /* Shared settings are optional. */
  }
}

function normalizeDir(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}

function eventDirFromManifestPath(extractDir: string, eventPath: string): string {
  const normalizedPath = eventPath.replace(/\\/g, "/");
  const eventBaseDir = normalizedPath.replace(/event\.json$/, "");
  return normalizeDir(`${extractDir}${eventBaseDir}`);
}

async function importEventFromExtractDir(
  sourceDir: string,
  onProgress?: (progress: ImportProgress) => void,
): Promise<number> {
  const extractDir = normalizeDir(sourceDir);

  // event.json を読み込み
  const eventJsonText = await FileSystem.readAsStringAsync(
    `${extractDir}event.json`,
  );
  const data = JSON.parse(eventJsonText) as ImportData;
  const assetManifest = await readAssetManifest(extractDir);

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
  await runImportSql(
    database,
    `イベント登録 ${String(data.event.name ?? "")}`,
    `INSERT INTO events (
      id, name, url, date, venue, organizer, raw_json, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    toSqlValue(eventId),
    toSqlValue(data.event.name, "不明なイベント"),
    toSqlValue(data.event.url, ""),
    toSqlValue(data.event.date),
    toSqlValue(data.event.venue),
    toSqlValue(data.event.organizer),
    toSqlValue(serializeRaw(data.event)),
    toSqlValue(serializeRaw(data.metadata)),
  );
  await updateImportedEventOptionalFields(database, eventId, data.event);
  const imgDir = await ensureImagesDir(eventId);

  // マップ画像を保存（ファイル移動、JSメモリ不使用）
  for (const mapInfo of data.event.maps ?? []) {
    if (!mapInfo.filename) continue;
    const mapSrc = await resolveImportedAsset(extractDir, assetManifest, [
      mapInfo.filename,
    ]);
    if (mapSrc) {
      const mapPath = `${imgDir}${mapInfo.filename}`;
      await ensureDirectory(mapPath.slice(0, mapPath.lastIndexOf("/") + 1));
      await FileSystem.copyAsync({ from: mapSrc, to: mapPath });
      await runImportSql(
        database,
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
    const eventImgSrc = await resolveImportedAsset(extractDir, assetManifest, [
      `event_image/${eventImageFilename}`,
      eventImageFilename,
    ]);
    if (eventImgSrc) {
      const ext = eventImageFilename.split(".").pop() ?? "jpg";
      const eventImgDest = `${imgDir}event_image.${ext}`;
      await FileSystem.copyAsync({ from: eventImgSrc, to: eventImgDest });
      await runImportSql(
        database,
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
    let cutFilePath: string | null = null;
    if (circle.circle_cut_filename) {
      const cutSrc = await resolveImportedAsset(extractDir, assetManifest, [
        circle.circle_cut_filename,
      ]);
      if (cutSrc) {
        const cutName = basenameFromPath(circle.circle_cut_filename);
        cutFilePath = `${imgDir}cuts/${cutName}`;
        const cutsDir = `${imgDir}cuts/`;
        const cutsDirInfo = await FileSystem.getInfoAsync(cutsDir);
        if (!cutsDirInfo.exists) {
          await FileSystem.makeDirectoryAsync(cutsDir, {
            intermediates: true,
          });
        }
        await FileSystem.copyAsync({ from: cutSrc, to: cutFilePath });
      }
    }

    const circleId = await nextImportRowId(database, "circles");
    await runImportSql(
      database,
      `サークル登録 ${String(circle.name ?? "")}`,
      `INSERT INTO circles (
          id, event_id, name, penname, space, hall,
          twitter_url, website_url, pixiv_url,
          description, genres, tags,
          circle_cut_filename, priority_color, memo,
          pin_x, pin_y, map_number,
          absence_status, existing_only_status, catalog_status,
          checked, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    );

    // アイテム挿入
    if (circle.items) {
      for (const item of circle.items) {
        await runImportSql(
          database,
          `頒布物登録 ${String(circle.name ?? "")}`,
          "INSERT INTO items (circle_id, name, price, type, description, purchase_status, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
          toSqlValue(circleId),
          toSqlValue(item.name, "不明"),
          toSqlValue(item.price),
          toSqlValue(item.type ?? item.genre),
          toSqlValue(item.description),
          toSqlValue(item.checked, 0),
          toSqlValue(serializeRaw(item)),
        );
      }
    }

    // アイテム画像を移動
    if (circle.item_images) {
      const itemsImgDir = `${imgDir}items/`;
      const itemsDirInfo = await FileSystem.getInfoAsync(itemsImgDir);
      if (!itemsDirInfo.exists) {
        await FileSystem.makeDirectoryAsync(itemsImgDir, {
          intermediates: true,
        });
      }
      for (const img of circle.item_images) {
        if (!img.path) continue;
        const imgSrc = await resolveImportedAsset(extractDir, assetManifest, [
          img.path,
        ]);
        let imgFilePath = img.path;
        if (imgSrc) {
          const imgName = basenameFromPath(img.path);
          imgFilePath = `${itemsImgDir}${imgName}`;
          await FileSystem.copyAsync({ from: imgSrc, to: imgFilePath });
        }
        await runImportSql(
          database,
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

  if (onProgress) {
    onProgress({
      current: totalCircles,
      total: totalCircles,
      phase: "circles",
    });
  }

  return eventId;
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
      let lastEventId: number | null = null;

      await resetDatabaseForFullSync();
      await importSharedBundleSettings(extractDir);
      for (let i = 0; i < events.length; i++) {
        onProgress?.({ current: i + 1, total: events.length, phase: "events" });
        lastEventId = await importEventFromExtractDir(
          eventDirFromManifestPath(extractDir, events[i].path),
          onProgress,
        );
      }

      if (lastEventId == null) {
        throw new Error("同期ZIPにイベントが含まれていません");
      }
      return lastEventId;
    }

    const eventId = await importEventFromExtractDir(extractDir, onProgress);
    await importSharedBundleSettings(extractDir);
    return eventId;
  } finally {
    // 展開用一時ディレクトリを削除
    await FileSystem.deleteAsync(extractDir, { idempotent: true });
  }
}

/** イベント削除時に画像ディレクトリも削除 */
export async function deleteEventWithImages(eventId: number): Promise<void> {
  const database = await getDatabase();
  await database.runAsync("DELETE FROM events WHERE id = ?", eventId);
  // 画像ディレクトリを削除
  const dir = `${IMAGES_DIR}${eventId}/`;
  const dirInfo = await FileSystem.getInfoAsync(dir);
  if (dirInfo.exists) {
    await FileSystem.deleteAsync(dir, { idempotent: true });
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
  const rows = await database.getAllAsync<any>(
    `
    SELECT
      c.id as circle_id,
      c.priority_color,
      c.checked as circle_status,
      i.price as item_price,
      i.purchase_status as item_status
    FROM circles c
    LEFT JOIN items i ON i.circle_id = c.id
    WHERE c.event_id = ?
  `,
    eventId,
  );

  let totalListPrice = 0;
  let totalPlanned = 0;
  let totalBought = 0;
  let totalCouldntBuy = 0;
  let totalSkipped = 0;
  let totalRemaining = 0;
  const priorityMap = new Map<
    number,
    {
      total: number;
      planned: number;
      bought: number;
      couldntBuy: number;
      skipped: number;
      remaining: number;
      circleCount: number;
      circleIds: Set<number>;
    }
  >();

  const normalizeStatus = (value: unknown): PurchaseStatusValue => {
    const status = Number(value ?? PURCHASE_STATUS.NOT_YET);
    return status === PURCHASE_STATUS.BOUGHT ||
      status === PURCHASE_STATUS.COULDNT_BUY ||
      status === PURCHASE_STATUS.SKIPPED
      ? (status as PurchaseStatusValue)
      : PURCHASE_STATUS.NOT_YET;
  };

  for (const row of rows) {
    const price = Number(row.item_price ?? 0) || 0;
    const itemStatus = normalizeStatus(row.item_status);
    const circleStatus = normalizeStatus(row.circle_status);
    const status =
      row.item_status !== null && row.item_status !== undefined
        ? itemStatus
        : circleStatus;
    const pc = row.priority_color as number;

    totalListPrice += price;
    if (status === PURCHASE_STATUS.BOUGHT) totalBought += price;
    else if (status === PURCHASE_STATUS.COULDNT_BUY) totalCouldntBuy += price;
    else if (status === PURCHASE_STATUS.SKIPPED) totalSkipped += price;
    else totalRemaining += price;

    if (!priorityMap.has(pc)) {
      priorityMap.set(pc, {
        total: 0,
        planned: 0,
        bought: 0,
        couldntBuy: 0,
        skipped: 0,
        remaining: 0,
        circleCount: 0,
        circleIds: new Set<number>(),
      });
    }
    const entry = priorityMap.get(pc)!;
    entry.total += price;
    entry.circleIds.add(row.circle_id);
    if (status === PURCHASE_STATUS.BOUGHT) entry.bought += price;
    else if (status === PURCHASE_STATUS.COULDNT_BUY) entry.couldntBuy += price;
    else if (status === PURCHASE_STATUS.SKIPPED) entry.skipped += price;
    else entry.remaining += price;
  }

  totalPlanned = totalBought + totalRemaining;

  return {
    totalListPrice,
    totalPlanned,
    totalBought,
    totalCouldntBuy,
    totalSkipped,
    totalRemaining,
    byPriority: Array.from(priorityMap.entries()).map(
      ([priorityColor, data]) => ({
        priorityColor,
        total: data.total,
        planned: data.bought + data.remaining,
        bought: data.bought,
        couldntBuy: data.couldntBuy,
        skipped: data.skipped,
        remaining: data.remaining,
        circleCount: data.circleIds.size,
      }),
    ),
  };
}

export async function exportEventData(
  eventId: number,
): Promise<ImportData | null> {
  const database = await getDatabase();
  const event = await getEvent(eventId);
  if (!event) return null;

  const maps = await getEventMaps(eventId);
  const circles = await getCirclesByEvent(eventId);

  const exportCircles: ImportCircle[] = [];
  for (const c of circles) {
    const items = await getItemsByCircle(c.id);
    const images = await getItemImagesByCircle(c.id);
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

  return {
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

// --- 統計 ---

export async function getEventStats(eventId: number): Promise<{
  totalCircles: number;
  boughtCircles: number;
  couldntBuyCircles: number;
  skippedCircles: number;
  remainingCircles: number;
}> {
  const database = await getDatabase();
  const total = await database.getFirstAsync<any>(
    "SELECT COUNT(*) as count FROM circles WHERE event_id = ?",
    eventId,
  );
  const bought = await database.getFirstAsync<any>(
    "SELECT COUNT(*) as count FROM circles WHERE event_id = ? AND checked = 1",
    eventId,
  );
  const couldntBuy = await database.getFirstAsync<any>(
    "SELECT COUNT(*) as count FROM circles WHERE event_id = ? AND checked = 2",
    eventId,
  );
  const skipped = await database.getFirstAsync<any>(
    "SELECT COUNT(*) as count FROM circles WHERE event_id = ? AND checked = 3",
    eventId,
  );
  const totalCount = total?.count ?? 0;
  const boughtCount = bought?.count ?? 0;
  const couldntBuyCount = couldntBuy?.count ?? 0;
  const skippedCount = skipped?.count ?? 0;
  return {
    totalCircles: totalCount,
    boughtCircles: boughtCount,
    couldntBuyCircles: couldntBuyCount,
    skippedCircles: skippedCount,
    remainingCircles: totalCount - boughtCount - couldntBuyCount - skippedCount,
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
