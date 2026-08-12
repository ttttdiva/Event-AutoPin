/**
 * インポート/エクスポート用の型定義
 * ZIPインポート（event.json + 画像）で使用
 */

// --- インポート/エクスポートの型 ---

/** データ構造のルート */
export interface ImportData {
  event: ImportEvent;
  circles: ImportCircle[];
  metadata: ImportMetadata;
}

export interface ImportEvent {
  name: string;
  url: string;
  date?: string;
  venue?: string;
  organizer?: string;
  memo?: string;
  completed?: boolean;
  maps?: ImportEventMap[];
  extracted_at?: string;
  // エクスポート時の買い物モード情報
  shopping_started_at?: string;
  shopping_ended_at?: string;
  // イベント画像
  event_image?: string;
  event_image_filename?: string;
  source_urls?: string[];
  source_events?: { name?: string; url?: string; circle_count?: number }[];
  additional_prompt?: string;
  event_sources?: unknown[];
  [key: string]: unknown;
}

export interface ImportEventMap {
  url?: string;
  filename?: string;
  map_number?: number;
  [key: string]: unknown;
}

export interface ImportCircle {
  name: string;
  penname?: string;
  space?: string;
  hall?: string;
  twitter_url?: string;
  website_url?: string;
  pixiv_url?: string;
  description?: string;
  genres?: string[];
  tags?: string[];
  items?: ImportItem[];
  circle_cut_url?: string;
  circle_cut_filename?: string;
  item_images?: ImportItemImage[];
  priority_color?: number;
  memo?: string;
  absence_status?: string;
  existing_only_status?: string;
  catalog_status?: string;
  source_event_name?: string | null;
  source_event_url?: string | null;
  extracted_at?: string;
  // マップ座標
  pin_x?: number;
  pin_y?: number;
  map_number?: number;
  // エクスポート時の購入状態
  checked?: number; // 0=未購入, 1=買えた, 2=買えなかった, 3=見送り
  [key: string]: unknown;
}

export interface ImportItem {
  name: string;
  price?: number;
  type?: string;
  description?: string;
  genre?: string;
  checked?: number; // 0=未購入, 1=買えた, 2=買えなかった, 3=見送り
  [key: string]: unknown;
}

export interface ImportItemImage {
  path: string;
  source: string;
  [key: string]: unknown;
}

export interface ImportMetadata {
  generated_at: string;
  format_version: string;
  total_circles: number;
  export_type?: string; // "result" = 購入結果付きエクスポート
  [key: string]: unknown;
}

// --- サークルマスター（デスクトップ↔モバイル共有） ---

export interface CircleMasterEntry {
  penname: string;
  favorite: boolean;
  genre: string;
  default_cut: string | null;
  [key: string]: unknown;
}

export interface CircleMasterData {
  circles: Record<string, CircleMasterEntry>;
}

// --- 購入状態 ---

/** 購入ステータス: 0=未購入, 1=買えた, 2=買えなかった, 3=見送り */
export const PURCHASE_STATUS = {
  NOT_YET: 0,
  BOUGHT: 1,
  COULDNT_BUY: 2,
  SKIPPED: 3,
} as const;

export type PurchaseStatusValue =
  (typeof PURCHASE_STATUS)[keyof typeof PURCHASE_STATUS];

export const PURCHASE_STATUS_LABELS: Record<
  PurchaseStatusValue,
  { label: string; icon: string; color: string; bgColor: string }
> = {
  [PURCHASE_STATUS.NOT_YET]: {
    label: "未購入",
    icon: "○",
    color: "#757575",
    bgColor: "#f5f5f5",
  },
  [PURCHASE_STATUS.BOUGHT]: {
    label: "買えた",
    icon: "✓",
    color: "#2e7d32",
    bgColor: "#e8f5e9",
  },
  [PURCHASE_STATUS.COULDNT_BUY]: {
    label: "買えなかった",
    icon: "✗",
    color: "#c62828",
    bgColor: "#fce4ec",
  },
  [PURCHASE_STATUS.SKIPPED]: {
    label: "見送り",
    icon: "−",
    color: "#9333ea",
    bgColor: "#f3e8ff",
  },
};

// --- アプリ内部の型 ---

/** イベント */
export interface Event {
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
  rawJson: string | null;
  metadataJson: string | null;
}

/** イベントマップ画像 */
export interface EventMap {
  id: number;
  eventId: number;
  filename: string;
  mapNumber: number;
  rawJson: string | null;
}

/** サークル */
export interface Circle {
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
  genres: string; // JSON文字列
  tags: string; // JSON文字列
  circleCutFilename: string | null;
  priorityColor: number; // 5=低, 11=中, 10=高, 15=最優先
  memo: string;
  hasCatalogPost: boolean;
  purchaseStatus: PurchaseStatusValue; // 0=未購入, 1=買えた, 2=買えなかった, 3=見送り
  pinX: number | null;
  pinY: number | null;
  mapNumber: number | null;
  absenceStatus: string | null;
  existingOnlyStatus: string | null;
  catalogStatus: string | null;
  rawJson: string | null;
}

/** アイテム（頒布物） */
export interface Item {
  id: number;
  circleId: number;
  name: string;
  price: number | null;
  type: string | null;
  description: string | null;
  purchaseStatusSource: "circle" | "manual" | null;
  purchaseStatus: PurchaseStatusValue; // 0=未購入, 1=買えた, 2=買えなかった, 3=見送り
  rawJson: string | null;
}

/** アイテム画像（お品書き等） */
export interface ItemImage {
  id: number;
  circleId: number;
  filename: string;
  source: string;
  rawJson: string | null;
}

// --- UI用の型 ---

export type PriorityColorDefinition = {
  label: string;
  color: string;
  bgColor: string;
};

/** 優先度カラーの定義 */
export const PRIORITY_COLORS: Record<number, PriorityColorDefinition> = {
  5: { label: "低", color: "#0277bd", bgColor: "#e1f5fe" },
  11: { label: "中", color: "#2e7d32", bgColor: "#e8f5e9" },
  10: { label: "高", color: "#f57f17", bgColor: "#fffde7" },
  15: { label: "最優先", color: "#c62828", bgColor: "#fce4ec" },
};

/** デフォルト優先度 */
export const DEFAULT_PRIORITY = 5;

/** 予算サマリー */
export interface BudgetSummary {
  totalListPrice: number; // リストに載っている全アイテムの金額合計
  totalPlanned: number; // 見送り/買えなかったを除いた予定金額合計
  totalBought: number; // 買えたアイテムの金額合計
  totalCouldntBuy: number; // 買えなかったアイテムの金額合計
  totalSkipped: number; // 見送りアイテムの金額合計
  totalRemaining: number; // 未購入アイテムの予定金額合計
  byPriority: {
    priorityColor: number;
    total: number;
    planned: number;
    bought: number;
    couldntBuy: number;
    skipped: number;
    remaining: number;
    circleCount: number;
  }[];
}

/** アイテムカテゴリ（デスクトップと共通） */
export const ITEM_CATEGORIES = [
  "",
  "新刊(漫画)",
  "新刊(イラスト)",
  "小説",
  "合同誌",
  "雑誌",
  "音楽",
  "グッズ",
  "その他",
];

/** サークルジャンル（デスクトップと共通） */
export const CIRCLE_GENRES = [
  "漫画",
  "イラスト",
  "音楽",
  "小説",
  "雑誌",
  "グッズ",
  "その他",
];

/** フィルター/ソート用 */
export type SortField = "space" | "name" | "priority" | "favorite";
export type SortOrder = "asc" | "desc";

export interface FilterState {
  searchQuery: string;
  statusFilter: PurchaseStatusValue | null; // null = 全て
  priorityFilter: number | null; // null = 全て
  hallFilter: string | null; // null = 全て
}
