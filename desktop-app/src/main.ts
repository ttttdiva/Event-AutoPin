import "./styles.css";
import { invoke as tauriInvoke, convertFileSrc } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";
import { appWindow } from "@tauri-apps/api/window";
import { open as dialogOpen } from "@tauri-apps/api/dialog";
import {
  invokeBridgeJob as rawInvokeBridgeJob,
  type BridgeJobResult,
} from "./bridge-job";
import {
  buildEventJsonSnapshot,
  eventJsonDocumentsEqual,
  imageColumnAssetReferences,
  runImageDeletionTransaction,
  selectActiveMapImages,
  type EventMapImage,
  type EventJsonData,
  type TableState,
} from "./state/event-document";
import {
  createAsyncMutationGuard,
  KeyedSerialExecutor,
  retryUntilValue,
  type AsyncMutationGuard,
} from "./state/async-mutation-guard";
import {
  applyEventPatchToLatest,
  EventLifecycleGate,
  EventWriteCoordinator,
  type CircleIdentityPatch,
  type EventLifecycleLease,
  type EventPatchResult,
  type EventSourceFingerprint as CoordinatedEventSourceFingerprint,
} from "./state/event-write-coordinator";
import {
  canAutoSave,
  canEnqueueReprocess,
  canStartEventDocumentMutation,
  canStartPipeline,
  canStartMapAuto,
  canStartReprocess,
  createOperationState,
  isOperationBusy,
  isPipelineOperation,
  isMapAutoOperation,
  isReprocessOperation,
  transitionOperationState,
  type OperationEvent,
  type OperationState,
} from "./state/operation-state";
import {
  cloneJsonSnapshot,
  KeyedRevisionedSaveQueue,
  RevisionedSaveQueue,
  setCloneObserver,
  type SaveReceipt,
} from "./state/revisioned-save-queue";
import { PurchaseHistoryIndexService } from "./state/purchase-history-index";
import { mergeCommittedEventMetaPreservingUnknown } from "./state/event-meta-merge";
import {
  prepareFullSyncEventDocument,
  reconcileSessionEventDocument,
} from "./state/event-session";
import {
  tablePrefixHeight as calculateTablePrefixHeight,
  tableDataStartIndex,
  tableWindowForScroll as calculateTableWindowForScroll,
} from "./state/table-window";
import {
  COOKIE_DROP_MAX_BYTES,
  decideCookieDrop,
  type CookieDropDecision,
} from "./state/cookie-drop";
import {
  createCookieFileController,
  type CookieFileStageResult,
  type CookieFileReason,
  type CookieFileSnapshot,
  type CookieFileValidationResult,
  type CookieValidationMetadata,
} from "./features/cookie-file";

// 画像読み込みエラーのグローバルハンドラ（CSP対策: インラインonerror不使用）
document.addEventListener(
  "error",
  (e) => {
    const img = e.target as HTMLImageElement;
    if (img.tagName !== "IMG" || !img.dataset.fallback) return;
    if (img.dataset.fallback === "hide") {
      img.style.display = "none";
    } else if (
      img.dataset.fallback === "outerhtml" &&
      img.dataset.fallbackHtml
    ) {
      img.outerHTML = img.dataset.fallbackHtml;
    }
  },
  true,
);

type DesktopConfig = {
  pythonExe: string;
  projectRoot: string;
  timeoutMs: number;
  foamDir: string;
  unlimitedOcrModel: string;
  unlimitedOcrModelPath: string;
  unlimitedOcrVenv: string;
  unlimitedOcrHfHome: string;
  unlimitedOcrRevision: string;
  unlimitedOcrDevice: string;
  unlimitedOcrMode: string;
  unlimitedOcrStrategy: string;
};

type EnvKeys = {
  openaiApiKey: string;
  geminiApiKey: string;
  xaiApiKey: string;
};

type ModelOption = {
  id: string;
  label: string;
  provider?: string;
  source?: string;
  source_label?: string;
};

type ModelProviderOption = {
  id: string;
  label: string;
  kind: "cli" | "api";
  available: boolean;
  source?: string;
  models: ModelOption[];
};

type ModelCatalog = {
  providers: ModelProviderOption[];
  apiModels: ModelOption[];
  apiErrors?: { provider: string; message: string }[];
};

type TextProviderSelection = {
  kind: "api" | "cli";
  provider: string;
};

type HistorySearchHit = {
  eventName: string;
  eventDate: string;
  eventDir: string;
  circleName: string;
  penname: string;
  space: string;
  hall: string;
  matchedBy: "circle" | "title";
  matchedText: string;
  matchedTitles: string[];
  score: number;
};

type HistorySearchResponse = {
  status: string;
  query: string;
  normalizedQuery: string;
  scannedEvents: number;
  scannedCircles: number;
  skippedEvents: number;
  excludedUpcomingEvents: number;
  totalMatches: number;
  truncated: boolean;
  results: HistorySearchHit[];
};

// === テーマ切り替え ===
// eventtrail-* localStorage key names are retained for upgrade compatibility.
const THEME_STORAGE_KEY = "eventtrail-theme";
function getTheme(): "dark" | "light" {
  return (
    (localStorage.getItem(THEME_STORAGE_KEY) as "dark" | "light") || "dark"
  );
}
function setTheme(theme: "dark" | "light") {
  localStorage.setItem(THEME_STORAGE_KEY, theme);
  // テーマ切替はCSS変数の再計算を確実にするためリロード
  window.location.reload();
}
function updateThemeToggleIcon() {
  const btn = document.getElementById("themeToggleBtn");
  if (btn) btn.innerHTML = getTheme() === "dark" ? "&#9788;" : "&#9790;";
}
function initThemeToggle() {
  updateThemeToggleIcon();
  document.getElementById("themeToggleBtn")?.addEventListener("click", () => {
    setTheme(getTheme() === "dark" ? "light" : "dark");
  });
}

// === 画像サイズ切り替え ===
const IMG_SIZE_STORAGE_KEY = "eventtrail-img-size";
type ImgSizeLevel = "1x" | "2x" | "4x";
const IMG_SIZE_VALUES: Record<ImgSizeLevel, { maxH: number; maxW: number }> = {
  "1x": { maxH: 40, maxW: 64 },
  "2x": { maxH: 80, maxW: 128 },
  "4x": { maxH: 160, maxW: 256 },
};
let currentImgSize: ImgSizeLevel =
  (localStorage.getItem(IMG_SIZE_STORAGE_KEY) as ImgSizeLevel) || "1x";

function applyImgSize() {
  const v = IMG_SIZE_VALUES[currentImgSize];
  document.documentElement.style.setProperty("--img-max-h", `${v.maxH}px`);
  document.documentElement.style.setProperty("--img-max-w", `${v.maxW}px`);
}
function initImgSizeSelector() {
  applyImgSize();
  // フィルターバーにサイズ切替UIを追加
  const filterBar = document.getElementById("circleFilterBar");
  if (!filterBar) return;
  const container = document.createElement("div");
  container.className = "img-size-selector";
  container.innerHTML = `<span class="text-xs" style="color:var(--text-muted);">画像:</span>`;
  for (const size of ["1x", "2x", "4x"] as ImgSizeLevel[]) {
    const btn = document.createElement("button");
    btn.className = `img-size-btn${size === currentImgSize ? " active" : ""}`;
    btn.textContent = size;
    btn.addEventListener("click", () => {
      currentImgSize = size;
      localStorage.setItem(IMG_SIZE_STORAGE_KEY, size);
      applyImgSize();
      container
        .querySelectorAll(".img-size-btn")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      // 画像列幅も連動
      const v = IMG_SIZE_VALUES[size];
      colWidths["サークル画像"] = v.maxW + 16;
      colWidths["アイテム画像"] = v.maxW + 16;
      saveColWidths(colWidths);
      renderCircleEditor();
    });
    container.appendChild(btn);
  }
  filterBar.appendChild(container);
}

// === サークルマスター（お気に入り・ジャンル・デフォルトカット統合管理） ===
type CircleMasterEntry = {
  penname: string;
  favorite: boolean;
  genre: string;
  default_cut: string | null;
};
type CircleMasterData = {
  circles: Record<string, CircleMasterEntry>;
};

let circleMasterData: CircleMasterData = { circles: {} };
let circleMasterSaveTimer: number | null = null;
const circleMasterWriteSerial = new KeyedSerialExecutor();
const CIRCLE_MASTER_WRITE_KEY = "circle-master";
const circleMasterSaveQueue = new RevisionedSaveQueue<CircleMasterData>(
  ({ snapshot }) => circleMasterWriteSerial.run(CIRCLE_MASTER_WRITE_KEY, async () => {
    const response = await invokeBridgeJob<Record<string, unknown>>(
      "save_circle_master",
      { data: snapshot },
      currentBridgeJobOptions(10_000),
    );
    const bridge = response.bridge as Record<string, unknown> | undefined;
    if (response.ok === false || bridge?.status === "error") {
      throw new Error(String(bridge?.error || "circle_masterの保存に失敗しました"));
    }
  }),
);

async function flushCircleMasterSaves(): Promise<void> {
  if (circleMasterSaveTimer) {
    clearTimeout(circleMasterSaveTimer);
    circleMasterSaveTimer = null;
    const receipt = circleMasterSaveQueue.enqueue(
      cloneJsonSnapshot(circleMasterData),
    );
    await receipt.completed;
  }
  await circleMasterSaveQueue.flush();
  if (circleMasterSaveQueue.error) throw circleMasterSaveQueue.error;
  await circleMasterWriteSerial.run(CIRCLE_MASTER_WRITE_KEY, async () => undefined);
}

function scheduleSaveCircleMaster() {
  if (circleMasterSaveTimer) clearTimeout(circleMasterSaveTimer);
  circleMasterSaveTimer = window.setTimeout(async () => {
    circleMasterSaveTimer = null;
    const receipt = circleMasterSaveQueue.enqueue(
      cloneJsonSnapshot(circleMasterData),
    );
    try {
      await receipt.completed;
    } catch (error) {
      const msg = `circle_master保存エラー: ${String(error)}`;
      logToFile(msg);
    }
  }, 1500);
}

async function loadCircleMasterStrict(): Promise<void> {
  const res = await invokeBridgeJob<Record<string, unknown>>(
    "load_circle_master",
    {},
    currentBridgeJobOptions(),
  );
  if (!res?.ok || (res.bridge as any)?.status === "error") {
    throw new Error(String((res.bridge as any)?.error || "circle_master読込失敗"));
  }
  circleMasterData = (res.bridge as any).data || { circles: {} };
}

async function loadCircleMaster() {
  try {
    await loadCircleMasterStrict();
  } catch (error) {
    logToFile(`circle_master読込エラー: ${String(error)}`);
  }
}

function isFavorite(name: string, tag: string): boolean {
  for (const [cname, entry] of Object.entries(circleMasterData.circles)) {
    if (!entry.favorite) continue;
    if (cname && name && cname === name) return true;
    if (entry.penname && tag && entry.penname === tag) return true;
  }
  return false;
}

function toggleFavorite(name: string, tag: string): boolean {
  const isFav = isFavorite(name, tag);
  if (!circleMasterData.circles[name]) {
    circleMasterData.circles[name] = {
      penname: tag,
      favorite: false,
      genre: "",
      default_cut: null,
    };
  }
  circleMasterData.circles[name].favorite = !isFav;
  if (tag && !circleMasterData.circles[name].penname) {
    circleMasterData.circles[name].penname = tag;
  }
  scheduleSaveCircleMaster();
  return !isFav;
}

function setCircleMasterGenre(name: string, penname: string, genre: string) {
  if (!circleMasterData.circles[name]) {
    circleMasterData.circles[name] = {
      penname: penname,
      favorite: false,
      genre: "",
      default_cut: null,
    };
  }
  circleMasterData.circles[name].genre = genre;
  if (penname && !circleMasterData.circles[name].penname) {
    circleMasterData.circles[name].penname = penname;
  }
  scheduleSaveCircleMaster();
}

function getCircleMasterGenre(name: string): string {
  return circleMasterData.circles[name]?.genre || "";
}

/** サークル名またはペンネームがお気に入りに一致するか判定 */
function isCircleFavorite(row: Record<string, string>): boolean {
  const name = (row["サークル名"] || "").trim();
  const penname = (row["ペンネーム"] || "").trim();
  return isFavorite(name, penname);
}

/** circle_masterのジャンル情報をtableStateに反映する（circle_master優先） */
function applyCircleMasterGenres(state: TableState = tableState) {
  for (const row of state.rows) {
    const name = (row["サークル名"] || "").trim();
    if (!name) continue;
    const masterGenre = getCircleMasterGenre(name);
    if (masterGenre) {
      row["ジャンル"] = masterGenre;
    }
  }
}

// event.json全体を保持
let eventJsonData: any = null;
// 最後にディスクから読み込むか保存完了した文書。no-op保存判定に使う。
let persistedEventJsonData: EventJsonData | null = null;

// 展開中のサークル行インデックス（-1 = なし）
let expandedCircleIdx = -1;

const PURCHASE_STATUS = {
  NOT_YET: 0,
  BOUGHT: 1,
  COULDNT_BUY: 2,
  SKIPPED: 3,
} as const;

type PurchaseStatusValue =
  (typeof PURCHASE_STATUS)[keyof typeof PURCHASE_STATUS];

const PURCHASE_STATUS_VIEWS: Record<
  PurchaseStatusValue,
  { icon: string; label: string; color: string; bg: string }
> = {
  [PURCHASE_STATUS.NOT_YET]: {
    icon: "○",
    label: "未購入",
    color: "#757575",
    bg: "",
  },
  [PURCHASE_STATUS.BOUGHT]: {
    icon: "✓",
    label: "買えた",
    color: "#2e7d32",
    bg: "rgba(46,125,50,0.12)",
  },
  [PURCHASE_STATUS.COULDNT_BUY]: {
    icon: "✗",
    label: "買えなかった",
    color: "#c62828",
    bg: "rgba(198,40,40,0.12)",
  },
  [PURCHASE_STATUS.SKIPPED]: {
    icon: "−",
    label: "見送り",
    color: "#6d4c41",
    bg: "rgba(109,76,65,0.12)",
  },
};

function normalizePurchaseStatus(value: unknown): PurchaseStatusValue {
  const n = Number(value ?? PURCHASE_STATUS.NOT_YET);
  if (
    n === PURCHASE_STATUS.BOUGHT ||
    n === PURCHASE_STATUS.COULDNT_BUY ||
    n === PURCHASE_STATUS.SKIPPED
  ) {
    return n as PurchaseStatusValue;
  }
  return PURCHASE_STATUS.NOT_YET;
}

function nextPurchaseStatus(value: unknown): PurchaseStatusValue {
  const current = normalizePurchaseStatus(value);
  if (current === PURCHASE_STATUS.NOT_YET) return PURCHASE_STATUS.BOUGHT;
  if (current === PURCHASE_STATUS.BOUGHT) return PURCHASE_STATUS.COULDNT_BUY;
  if (current === PURCHASE_STATUS.COULDNT_BUY) return PURCHASE_STATUS.SKIPPED;
  return PURCHASE_STATUS.NOT_YET;
}

function getEffectiveItemStatus(item: any, circle: any): PurchaseStatusValue {
  if (item && item.checked !== undefined && item.checked !== null) {
    return normalizePurchaseStatus(item.checked);
  }
  return normalizePurchaseStatus(circle?.checked);
}

const purchasedItemKeys = new Set<string>();
const purchaseHistoryIndexService = new PurchaseHistoryIndexService();

function normalizePurchaseLookupKey(value: unknown): string {
  const raw = String(value ?? "");
  const normalized =
    typeof raw.normalize === "function" ? raw.normalize("NFKC") : raw;
  return normalized
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function circlePurchaseKeys(circle: any): string[] {
  return [circle?.name, circle?.penname]
    .map(normalizePurchaseLookupKey)
    .filter(Boolean);
}

function purchasedItemKey(circleKey: string, itemKey: string): string {
  return `${circleKey}\u0000${itemKey}`;
}

function isPurchasedItemKnown(circle: any, item: any): boolean {
  const itemKey = normalizePurchaseLookupKey(item?.name);
  if (!itemKey) return false;
  return circlePurchaseKeys(circle).some((circleKey) =>
    purchasedItemKeys.has(purchasedItemKey(circleKey, itemKey)),
  );
}

async function buildPurchasedItemIndex(
  selectedSlug: string | null = activeEventSlug,
  selectedData: any = eventJsonData,
  fingerprint?: { modifiedMs?: number; fileSize?: number },
): Promise<Set<string>> {
  if (!selectedSlug) return new Set<string>();
  // 通常切替では対象イベントだけを更新し、他イベントのevent.jsonは読まない。
  // 起動時のbackground buildがまだ完了していなくても、現在データから即時表示
  // できる。cacheは派生値なので破棄・再構築可能。
  if (selectedData) {
    return new Set(
      purchaseHistoryIndexService.replace(selectedSlug, selectedData, fingerprint),
    );
  }
  return new Set(purchaseHistoryIndexService.get(selectedSlug));
}

function applyPurchasedItemIndex(next: Set<string>): void {
  purchasedItemKeys.clear();
  next.forEach((key) => purchasedItemKeys.add(key));
}

let purchasedItemIndexGeneration = 0;

async function rebuildPurchasedItemIndex() {
  const generation = ++purchasedItemIndexGeneration;
  const owner = captureActiveEventDocumentOwner();
  const revision = eventDocumentStateRevision;
  const next = await buildPurchasedItemIndex();
  if (
    generation !== purchasedItemIndexGeneration ||
    !isActiveEventDocumentOwner(owner) ||
    revision !== eventDocumentStateRevision
  ) {
    return;
  }
  applyPurchasedItemIndex(next);
}

function catalogImagePathsForCircle(circle: any): string[] {
  const paths: string[] = [];
  const addPath = (value: any) => {
    const path = String(value ?? "").trim();
    if (isUsableImageValue(path) && !paths.includes(path)) paths.push(path);
  };

  for (const image of circle?.item_images || []) {
    addPath(typeof image === "string" ? image : image?.path);
  }
  for (const item of circle?.items || []) {
    addPath(item?.image);
  }
  return paths;
}

// event.jsonのcirclesをheaders/rows形式に変換（テーブル表示用）
// アイテムはメインテーブルに含めず、展開パネルで編集する
function circlesToTableState(data: any): TableState {
  const circles: any[] = data?.circles || [];
  if (!circles.length) return { headers: [], rows: [] };

  const headers = [
    "ホール",
    "スペース",
    "サークル名",
    "ジャンル",
    "サークルメモ",
    "ペンネーム",
    "色",
    "マップ番号",
    "ピンX",
    "ピンY",
    "サークル画像",
    "アイテム画像",
    "アイテムメモ",
    "アイテムタグ",
    "チェック",
  ];

  const rows: Record<string, string>[] = circles.map((c: any) => {
    const tags = [...(c.genres || []), ...(c.tags || [])];
    const penname = c.penname || "";
    const memoParts = [c.twitter_url, c.website_url, c.pixiv_url].filter(
      Boolean,
    );
    const itemImagePaths = catalogImagePathsForCircle(c);
    const itemCount = (c.items && c.items.length) || 0;

    // アイテムのtype/genreを集約してタグ表示
    const itemTags = (c.items || [])
      .map((it: any) => it.type || it.genre || "")
      .filter(Boolean);
    const uniqueItemTags = [...new Set(itemTags)];

    return {
      ホール: c.hall || "",
      スペース: c.space || "",
      サークル名: c.name || "",
      ジャンル: (c.genres || []).join(", "),
      サークルメモ: memoParts.join("\n") || "",
      アイテムメモ: (c.memo ? c.memo.replace(/^【[^】]*】\n?/, "") : "") || "",
      ペンネーム: penname,
      アイテムタグ: uniqueItemTags.join(", "),
      色: String(c.priority_color ?? 5) + ".0",
      マップ番号: String(c.map_number ?? 0),
      ピンX: String(c.pin_x ?? 0),
      ピンY: String(c.pin_y ?? 0),
      サークル画像: c.circle_cut_filename || "",
      アイテム画像: itemImagePaths.join("\n"),
      チェック: String(c.checked ?? 0),
      _itemCount: String(itemCount),
    };
  });

  return { headers, rows };
}

const resultEl = document.getElementById("result") as HTMLPreElement;
const progressEl = document.getElementById(
  "crawlProgress",
) as HTMLProgressElement;
const progressTextEl = document.getElementById(
  "crawlProgressText",
) as HTMLDivElement;
const circleEditorEl = document.getElementById(
  "circleEditor",
) as HTMLDivElement;

// サークルテーブル空白エリアの右クリ → 末尾にサークル追加
circleEditorEl.addEventListener("contextmenu", (e) => {
  const target = e.target as HTMLElement;
  // 行内の右クリは行ハンドラに委ねる（stopPropagation済みなのでここには来ない）
  // 入力欄等のデフォルトメニューは尊重
  if (
    target.closest(
      "input, textarea, select, a, button, .img-clickable, .color-swatch",
    )
  )
    return;
  // tableStateが未読込ならメニューを出さない
  if (!tableState.headers.length && !eventJsonData) return;
  e.preventDefault();
  showCircleTableContextMenu(e.clientX, e.clientY);
});

const pythonExeEl = document.getElementById("pythonExe") as HTMLInputElement;
const projectRootEl = document.getElementById(
  "projectRoot",
) as HTMLInputElement;
const timeoutMsEl = document.getElementById("timeoutMs") as HTMLInputElement;
const foamDirEl = document.getElementById("foamDir") as HTMLInputElement;
const unlimitedOcrModelEl = document.getElementById("unlimitedOcrModel") as HTMLInputElement;
const unlimitedOcrModelPathEl = document.getElementById("unlimitedOcrModelPath") as HTMLInputElement;
const unlimitedOcrVenvEl = document.getElementById("unlimitedOcrVenv") as HTMLInputElement;
const unlimitedOcrHfHomeEl = document.getElementById("unlimitedOcrHfHome") as HTMLInputElement;
const unlimitedOcrRevisionEl = document.getElementById("unlimitedOcrRevision") as HTMLInputElement;
const unlimitedOcrDeviceEl = document.getElementById("unlimitedOcrDevice") as HTMLSelectElement;
const unlimitedOcrModeEl = document.getElementById("unlimitedOcrMode") as HTMLSelectElement;
const unlimitedOcrStrategyEl = document.getElementById("unlimitedOcrStrategy") as HTMLSelectElement;
const unlimitedOcrDoctorBtn = document.getElementById("unlimitedOcrDoctorBtn") as HTMLButtonElement | null;
const openaiApiKeyEl = document.getElementById(
  "openaiApiKey",
) as HTMLInputElement;
const geminiApiKeyEl = document.getElementById(
  "geminiApiKey",
) as HTMLInputElement;
const xaiApiKeyEl = document.getElementById("xaiApiKey") as HTMLInputElement;
const modelCatalogStatusEl = document.getElementById(
  "modelCatalogStatus",
) as HTMLSpanElement | null;
const refreshModelCatalogBtn = document.getElementById(
  "refreshModelCatalogBtn",
) as HTMLButtonElement | null;
const cookieFileDropZoneEl = document.getElementById(
  "cookieFileDropZone",
) as HTMLDivElement | null;
const cookieFileBrowseBtn = document.getElementById(
  "cookieFileBrowseBtn",
) as HTMLButtonElement | null;
const cookieFileClearBtn = document.getElementById(
  "cookieFileClearBtn",
) as HTMLButtonElement | null;
const cookieFileStatusEl = document.getElementById(
  "cookieFileStatus",
) as HTMLSpanElement | null;
const cookieFileDropHintEl = document.getElementById(
  "cookieFileDropHint",
) as HTMLDivElement | null;
const cookieFileDropStateEl = document.getElementById(
  "cookieFileDropState",
) as HTMLDivElement | null;
const cookieConsoleCommandEl = document.getElementById(
  "cookieConsoleCommand",
) as HTMLPreElement | null;
const cookieConsoleCopyBtn = document.getElementById(
  "cookieConsoleCopyBtn",
) as HTMLButtonElement | null;
const cookieConsoleCopyStatusEl = document.getElementById(
  "cookieConsoleCopyStatus",
) as HTMLSpanElement | null;

const FALLBACK_MODEL_CATALOG: ModelCatalog = {
  providers: [
    {
      id: "codex",
      label: "Codex CLI",
      kind: "cli",
      available: false,
      models: [
        { id: "gpt-5.5", label: "GPT-5.5", source_label: "CLI候補" },
        { id: "gpt-5.4", label: "GPT-5.4", source_label: "CLI候補" },
        { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", source_label: "CLI候補" },
        { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark", source_label: "CLI候補" },
        { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", source_label: "CLI候補" },
        { id: "gpt-5.2-codex", label: "GPT-5.2 Codex", source_label: "CLI候補" },
        { id: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max", source_label: "CLI候補" },
        { id: "gpt-5.1-codex", label: "GPT-5.1 Codex", source_label: "CLI候補" },
        { id: "gpt-5-codex", label: "GPT-5 Codex", source_label: "CLI候補" },
      ],
    },
    {
      id: "antigravity",
      label: "Antigravity CLI",
      kind: "cli",
      available: false,
      models: [
        { id: "default", label: "default", source_label: "CLI候補" },
        { id: "Gemini 3.5 Flash (High)", label: "Gemini 3.5 Flash (High)", source_label: "CLI候補" },
        { id: "Gemini 3.5 Flash (Medium)", label: "Gemini 3.5 Flash (Medium)", source_label: "CLI候補" },
        { id: "Gemini 3.5 Flash (Low)", label: "Gemini 3.5 Flash (Low)", source_label: "CLI候補" },
        { id: "Gemini 3.1 Pro (High)", label: "Gemini 3.1 Pro (High)", source_label: "CLI候補" },
        { id: "Gemini 3.1 Pro (Low)", label: "Gemini 3.1 Pro (Low)", source_label: "CLI候補" },
        { id: "Claude Sonnet 4.6 (Thinking)", label: "Claude Sonnet 4.6 (Thinking)", source_label: "CLI候補" },
        { id: "Claude Opus 4.6 (Thinking)", label: "Claude Opus 4.6 (Thinking)", source_label: "CLI候補" },
      ],
    },
    {
      id: "claude",
      label: "Claude Code",
      kind: "cli",
      available: false,
      models: [
        { id: "default", label: "Claude default", source_label: "候補" },
        { id: "best", label: "best", source_label: "候補" },
        { id: "sonnet", label: "sonnet", source_label: "候補" },
        { id: "opus", label: "opus", source_label: "候補" },
        { id: "haiku", label: "haiku", source_label: "候補" },
        { id: "sonnet[1m]", label: "sonnet[1m]", source_label: "候補" },
        { id: "opus[1m]", label: "opus[1m]", source_label: "候補" },
        { id: "opusplan", label: "opusplan", source_label: "候補" },
      ],
    },
  ],
  apiModels: [
    { id: "gemini-3-flash-preview", label: "Gemini 3 Flash Preview", provider: "gemini", source_label: "候補" },
    { id: "gemini-3-pro-preview", label: "Gemini 3 Pro Preview", provider: "gemini", source_label: "候補" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", provider: "gemini", source_label: "候補" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", provider: "gemini", source_label: "候補" },
    { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite", provider: "gemini", source_label: "候補" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", provider: "openai", source_label: "候補" },
    { id: "gpt-5.2", label: "GPT-5.2", provider: "openai", source_label: "候補" },
    { id: "gpt-5.1", label: "GPT-5.1", provider: "openai", source_label: "候補" },
    { id: "gpt-5", label: "GPT-5", provider: "openai", source_label: "候補" },
    { id: "gpt-5-mini", label: "GPT-5 mini", provider: "openai", source_label: "候補" },
    { id: "gpt-5-nano", label: "GPT-5 nano", provider: "openai", source_label: "候補" },
    { id: "gpt-5.2-pro", label: "GPT-5.2 pro", provider: "openai", source_label: "候補" },
    { id: "gpt-5-pro", label: "GPT-5 pro", provider: "openai", source_label: "候補" },
  ],
};

let modelCatalog: ModelCatalog = FALLBACK_MODEL_CATALOG;

const DEFAULT_REASONING_EFFORT = "medium";
const OPENAI_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];
const OPENAI_LATEST_REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh"];
const OPENAI_51_REASONING_EFFORTS = ["none", "low", "medium", "high"];
const OPENAI_PRE_51_REASONING_EFFORTS = ["minimal", "low", "medium", "high"];
const CODEX_REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh"];
const GEMINI3_REASONING_EFFORTS = ["minimal", "low", "medium", "high"];
const GEMINI25_FLASH_BUDGETS = ["none", "dynamic", "1024", "8192", "24576"];
const GEMINI25_PRO_BUDGETS = ["dynamic", "1024", "8192", "32768"];
const CLAUDE_CODE_EFFORTS = ["auto", "low", "medium", "high", "xhigh", "max"];
const NO_REASONING_EFFORTS = ["none"];

let tableState: TableState = { headers: [], rows: [] };
// 自動表示補完を含む、最後に読み込み/保存確定したテーブル表示。
// このbaselineとの差分だけをevent.jsonへ反映する。
let eventTableBaseline: TableState = { headers: [], rows: [] };
// save snapshot/選択commitごとのCAS revision。古い非同期失敗による
// 新しい編集stateのwhole rollbackを防ぐ。
let eventDocumentStateRevision = 0;

/** イベント切替の要求/確定を分離するための不変セッション。 */
type EventSourceFingerprint = {
  modifiedMs?: number;
  fileSize?: number;
  contentHash?: string;
};
type EventSession = {
  slug: string;
  eventDir: string;
  eventJsonPath: string;
  meta: EventMeta;
  eventJsonData: EventJsonData;
  tableState: TableState;
  tableBaseline: TableState;
  purchasedItemIndex: ReadonlySet<string>;
  mapImages: EventMapImage[];
  sourceFingerprint: EventSourceFingerprint;
};

/** 開発時に確認できる軽量なデスクトップ計測。productionではログ出力しない。 */
type DesktopPerfCounters = {
  eventJsonBytes: number;
  circles: number;
  items: number;
  events: number;
  pythonBridgeStarts: number;
  tauriIpcCalls: number;
  deepCloneCount: number;
  deepCloneBytes: number;
  sidebarRebuilds: number;
  tableDomRows: number;
};
const desktopPerf: DesktopPerfCounters = {
  eventJsonBytes: 0,
  circles: 0,
  items: 0,
  events: 0,
  pythonBridgeStarts: 0,
  tauriIpcCalls: 0,
  deepCloneCount: 0,
  deepCloneBytes: 0,
  sidebarRebuilds: 0,
  tableDomRows: 0,
};
const isDesktopDevBuild = Boolean((import.meta as any).env?.DEV);
function markEventSwitch(name: string): void {
  if (typeof performance === "undefined") return;
  try {
    performance.mark(name);
  } catch {
    /* browser implementation may reject duplicate marks */
  }
}
function measureEventSwitch(name: string, start: string, end: string): void {
  if (typeof performance === "undefined") return;
  try {
    performance.measure(name, start, end);
  } catch {
    /* markが未実装の環境では計測を無視 */
  }
}
/** state helper/event-document/queueを跨ぐcloneを一箇所で計測する。*
 * productionではcounterを公開せず、observerは軽量な数値更新だけ行う。 */
setCloneObserver((cloned) => {
  desktopPerf.deepCloneCount += 1;
  // bytes概算はDEV計測時だけ行い、本番のclone経路へJSON.stringify負荷を
  // 追加しない。clone回数自体は軽量counterとして常時保持する。
  if (!isDesktopDevBuild) return;
  try {
    desktopPerf.deepCloneBytes += JSON.stringify(cloned).length;
  } catch {
    /* 循環参照等は既存cloneの責務へ委譲 */
  }
});

function recordDeepClone<T>(value: T): T {
  return cloneJsonSnapshot(value);
}

/** Tauri IPCを一箇所で計測する。importした生invokeを直接呼ばないことで、
 * event切替・asset・lifecycleを含む全commandの呼出数を漏れなく集計する。 */
function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  desktopPerf.tauriIpcCalls += 1;
  return tauriInvoke<T>(command, args);
}

/** Python bridgeもTauriのrun_python_bridge IPCを経由するため同じcounterへ
 * 記録する。bridge-jobの純粋なテスト注入経路には影響しない。 */
function invokeBridgeJob<T>(
  job: string,
  payload: Record<string, unknown>,
  options?: Parameters<typeof rawInvokeBridgeJob>[2],
): Promise<BridgeJobResult<T>> {
  desktopPerf.tauriIpcCalls += 1;
  return rawInvokeBridgeJob<T>(job, payload, options);
}

const COOKIE_CONSOLE_COMMAND = [
  "(() => {",
  "  const domain = location.hostname;",
  "  const secure = location.protocol === 'https:' ? 'TRUE' : 'FALSE';",
  "  const rows = document.cookie.split(/;\\s*/).filter(Boolean).map((pair) => {",
  "    const separator = pair.indexOf('=');",
  "    if (separator < 1) return '';",
  "    const name = pair.slice(0, separator);",
  "    const value = pair.slice(separator + 1);",
  // Keep expiry empty so browser-exported session cookies remain usable;
  // MozillaCookieJar interprets `0` as already expired.
  "    return domain + '\\tFALSE\\t/\\t' + secure + '\\t\\t' + name + '\\t' + value;",
  "  }).filter(Boolean);",
  "  if (!rows.length) { window.alert('取得できるCookieが0件です。HttpOnly CookieはConsoleから取得できません。'); return; }",
  "  const blob = new Blob(['# Netscape HTTP Cookie File\\n' + rows.join('\\n') + '\\n'], { type: 'text/plain' });",
  "  const link = document.createElement('a');",
  "  link.href = URL.createObjectURL(blob);",
  "  link.download = 'cookies.txt';",
  "  link.click();",
  "  setTimeout(() => URL.revokeObjectURL(link.href), 1000);",
  "})();",
].join("\n");

type CookieValidationInvokeResult = Partial<CookieFileStageResult> & {
  ok?: boolean;
};

let cookieDomReadSerial = 0;

function cookieReasonText(reason?: CookieFileReason): { status: string; hint: string } {
  switch (reason) {
    case "missing":
      return {
        status: "Cookieファイルを取得できません",
        hint: "Netscape .txtを1件指定してください。",
      };
    case "multiple":
      return {
        status: "複数のCookieファイルは受け付けません",
        hint: "Netscape .txtを1件だけ指定してください。",
      };
    case "directory":
      return {
        status: "フォルダはCookieとして受け付けません",
        hint: "通常のファイル（Netscape .txt）を指定してください。",
      };
    case "unsupported":
      return {
        status: "対応形式はNetscape .txtのみです",
        hint: "拡張子 .txt のCookieファイルを指定してください。",
      };
    case "too_large":
      return {
        status: "Cookieファイルが大きすぎます",
        hint: "最大2MBのNetscape .txtを指定してください。",
      };
    case "unreadable":
    case "read_error":
      return {
        status: "Cookieファイルを読み取れません",
        hint: "アクセス可能なNetscape .txtを指定してください。",
      };
    case "choose_error":
      return {
        status: "Cookieファイル選択を利用できません",
        hint: "参照ボタンをもう一度試してください。",
      };
    case "stage_error":
      return {
        status: "Cookieファイルを安全に準備できません",
        hint: "ファイルを確認して、もう一度ドロップしてください。",
      };
    default:
      return {
        status: "Netscape形式のCookieを確認できません",
        hint: "コメント/空行を除きCookieが1件以上あるNetscape .txtを指定してください。",
      };
  }
}

function cookieDomainSummary(validation: CookieValidationMetadata): string {
  const displayed = validation.domains.join("、");
  const omitted = Math.max(0, validation.domainCount - validation.domains.length);
  return `ドメイン ${validation.domainCount}件: ${displayed}${
    omitted > 0 ? `（ほか${omitted}件）` : ""
  }`;
}

function cookieExpirySummary(validation: CookieValidationMetadata): string {
  const expiry = validation.expiry;
  const status =
    expiry.status === "session"
      ? "セッションのみ"
      : expiry.status === "expired"
        ? "期限切れと思われる項目のみ"
        : expiry.status === "future"
          ? "将来期限のみ"
          : "混在";
  const warning =
    expiry.expiredCount > 0
      ? ` 期限切れと思われるCookieが${expiry.expiredCount}件あります。`
      : " 記載期限は利用可否を保証しません。";
  return `期限の目安（${status}）: セッション ${expiry.sessionCount}件 / 期限切れと思われる ${expiry.expiredCount}件 / 将来期限 ${expiry.futureCount}件。${warning}`;
}

function renderCookieSnapshot(snapshot: CookieFileSnapshot) {
  if (cookieFileClearBtn) cookieFileClearBtn.disabled = !snapshot.hasSelection;
  cookieFileDropZoneEl?.setAttribute(
    "data-drop-state",
    snapshot.state === "validating"
      ? "hover"
      : snapshot.state === "ready"
        ? "ready"
        : snapshot.state === "error"
          ? "error"
          : "idle",
  );

  if (snapshot.state === "validating") {
    if (cookieFileStatusEl) cookieFileStatusEl.textContent = "Cookieファイルを検証中…";
    if (cookieFileDropHintEl) {
      cookieFileDropHintEl.textContent =
        "内容はRust側で一時的に検証しますが、画面表示・設定・localStorageへ保存しません。";
    }
    if (cookieFileDropStateEl) cookieFileDropStateEl.textContent = "検証中（最大2MB）";
    return;
  }

  if (snapshot.state === "ready" && snapshot.basename && snapshot.validation) {
    const validation = snapshot.validation;
    if (cookieFileStatusEl) {
      cookieFileStatusEl.textContent = `明示選択済み: ${snapshot.basename}`;
    }
    if (cookieFileDropHintEl) {
      cookieFileDropHintEl.textContent = `検証時点でファイルが存在し、読み取り可能でした。Cookie ${validation.cookieCount}件 / ${cookieDomainSummary(validation)}。形式と記載期限の要約であり、ログインや認証の有効性は確認していません。`;
    }
    if (cookieFileDropStateEl) {
      cookieFileDropStateEl.textContent = `${cookieExpirySummary(validation)} 実行時にもファイルを再検証します。`;
    }
    return;
  }

  if (snapshot.state === "error") {
    const message = cookieReasonText(snapshot.reason);
    if (cookieFileStatusEl) cookieFileStatusEl.textContent = message.status;
    if (cookieFileDropHintEl) {
      cookieFileDropHintEl.textContent = `${message.hint} 選択済みの値は変更していません。`;
    }
    if (cookieFileDropStateEl) cookieFileDropStateEl.textContent = "選択値は変更していません。";
    return;
  }

  if (cookieFileStatusEl) cookieFileStatusEl.textContent = "明示Cookieファイル: 未選択";
  if (cookieFileDropHintEl) {
    cookieFileDropHintEl.textContent =
      "明示ファイルを使う場合はNetscape .txtを1件指定してください。未選択でも、対象URLに応じたCookieファイルの自動検出が実行時に行われる場合があります。";
  }
  if (cookieFileDropStateEl) {
    cookieFileDropStateEl.textContent = "明示ファイル未選択（自動検出は無効化されません）。";
  }
}

const cookieFileController = createCookieFileController({
  choosePath: async () => {
    let selected: string | string[] | null;
    try {
      selected = await dialogOpen({
        multiple: false,
        filters: [{ name: "Netscape Cookieファイル", extensions: ["txt"] }],
      });
    } catch {
      throw new Error("cookie_choose");
    }
    if (Array.isArray(selected)) throw new Error("cookie_multiple");
    return typeof selected === "string" ? selected : null;
  },
  validatePath: async (path) => {
    const result = await invoke<CookieValidationInvokeResult>(
      "validate_cookie_file",
      { filePath: path },
    );
    if (!result?.ok || !result.basename) throw new Error("cookie_empty_or_invalid");
    return result as CookieFileValidationResult;
  },
  stageBytes: async (fileName, bytes) => {
    const result = await invoke<CookieValidationInvokeResult>("stage_cookie_file", {
      fileName,
      contents: bytes,
    });
    if (!result?.ok || !result.path || !result.basename) {
      throw new Error("cookie_stage_unavailable");
    }
    return result as CookieFileStageResult;
  },
  cleanupStage: async (path) => {
    await invoke("cleanup_staged_cookie_file", { stagedPath: path });
  },
  cleanupAllStages: async () => {
    await invoke("cleanup_cookie_stages");
  },
  onSnapshot: renderCookieSnapshot,
});

function getCookieFilePathForRun(): string {
  return cookieFileController.getSelectedPathForRun();
}

async function clearCookieFile() {
  // Staged files are allowlist-cleaned; browsed user files are never deleted.
  ++cookieDomReadSerial;
  await cookieFileController.clear();
}

async function disposeCookieFileSelection() {
  ++cookieDomReadSerial;
  await cookieFileController.dispose();
}

function initCookieConsoleGuide() {
  if (cookieConsoleCommandEl) cookieConsoleCommandEl.textContent = COOKIE_CONSOLE_COMMAND;
  cookieConsoleCopyBtn?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(COOKIE_CONSOLE_COMMAND);
      if (cookieConsoleCopyStatusEl) {
        cookieConsoleCopyStatusEl.textContent = "コピーしました（コマンド文字列のみ）";
      }
    } catch {
      if (cookieConsoleCopyStatusEl) {
        cookieConsoleCopyStatusEl.textContent =
          "自動コピーできません。上のコマンドを手動でコピーしてください。";
      }
    }
  });
}

function dataTransferHasFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  if (Array.from(dataTransfer.types || []).some((type) => type.toLowerCase() === "files")) {
    return true;
  }
  if (Array.from(dataTransfer.items || []).some((item) => item.kind === "file")) return true;
  return dataTransfer.files.length > 0;
}

type CookieDropEntry = { file: File | null; isDirectory: boolean };

function cookieDropEntries(dataTransfer: DataTransfer): CookieDropEntry[] {
  const items = Array.from(dataTransfer.items || []).filter((item) => item.kind === "file");
  if (items.length > 0) {
    return items.map((item) => {
      let isDirectory = false;
      try {
        const entry = (
          item as DataTransferItem & {
            webkitGetAsEntry?: () => { isDirectory?: boolean } | null;
          }
        ).webkitGetAsEntry?.();
        isDirectory = entry?.isDirectory === true;
      } catch {
        // Directory detection is best effort in the browser File API.
      }
      return { file: item.getAsFile(), isDirectory };
    });
  }
  return Array.from(dataTransfer.files || []).map((file) => ({
    file,
    isDirectory: false,
  }));
}

function safeDroppedCookieFileName(name: string): string {
  const basename = name.replace(/\\/g, "/").split("/").pop() || "cookies.txt";
  const safe = Array.from(basename)
    .filter((character) => !/[\u0000-\u001f\u007f/\\]/.test(character))
    .slice(0, 128)
    .join("");
  return safe || "cookies.txt";
}

function renderCookieDropHover() {
  cookieFileDropZoneEl?.setAttribute("data-drop-state", "hover");
  if (cookieFileStatusEl) cookieFileStatusEl.textContent = "Cookieファイルを確認中…";
  if (cookieFileDropHintEl) {
    cookieFileDropHintEl.textContent = "Netscape .txtを1件ドロップしてください。";
  }
  if (cookieFileDropStateEl) cookieFileDropStateEl.textContent = "ドロップ受付中（最大2MB）";
}

function restoreCookieDropState() {
  renderCookieSnapshot(cookieFileController.getSnapshot());
}

function initCookieDomDrop() {
  if (!cookieFileDropZoneEl) return;
  let domFileDragDepth = 0;

  cookieFileBrowseBtn?.addEventListener("click", () => {
    ++cookieDomReadSerial;
    void cookieFileController.choose();
  });
  cookieFileClearBtn?.addEventListener("click", () => void clearCookieFile());
  cookieFileDropZoneEl.addEventListener("keydown", (event) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    ++cookieDomReadSerial;
    void cookieFileController.choose();
  });
  cookieFileDropZoneEl.addEventListener("dragenter", (event) => {
    const dragEvent = event as DragEvent;
    if (!dataTransferHasFiles(dragEvent.dataTransfer)) return;
    dragEvent.preventDefault();
    dragEvent.stopPropagation();
    domFileDragDepth += 1;
    renderCookieDropHover();
  });
  cookieFileDropZoneEl.addEventListener("dragover", (event) => {
    const dragEvent = event as DragEvent;
    if (!dataTransferHasFiles(dragEvent.dataTransfer)) return;
    dragEvent.preventDefault();
    dragEvent.stopPropagation();
    if (dragEvent.dataTransfer) dragEvent.dataTransfer.dropEffect = "copy";
    renderCookieDropHover();
  });
  cookieFileDropZoneEl.addEventListener("dragleave", (event) => {
    if (domFileDragDepth === 0) return;
    const related = (event as DragEvent).relatedTarget as Node | null;
    if (related && cookieFileDropZoneEl.contains(related)) return;
    domFileDragDepth = 0;
    restoreCookieDropState();
  });
  cookieFileDropZoneEl.addEventListener("drop", (event) => {
    const dragEvent = event as DragEvent;
    const dataTransfer = dragEvent.dataTransfer;
    // Cookie handling is strictly zone-local and File-only. URL/image/reorder
    // DataTransfer routes continue through their established DOM handlers.
    if (!dataTransferHasFiles(dataTransfer) || !dataTransfer) return;
    dragEvent.preventDefault();
    dragEvent.stopPropagation();
    domFileDragDepth = 0;
    const readSerial = ++cookieDomReadSerial;

    const entries = cookieDropEntries(dataTransfer);
    const decision: CookieDropDecision = decideCookieDrop(
      entries.map(({ file, isDirectory }) => ({
        name: file?.name || "",
        size: file?.size ?? -1,
        isDirectory,
      })),
    );
    if (!decision.accepted) {
      cookieFileController.reject(decision.reason);
      return;
    }
    const file = entries[0]?.file;
    if (!file) {
      cookieFileController.reject("read_error");
      return;
    }

    renderCookieSnapshot({
      ...cookieFileController.getSnapshot(),
      state: "validating",
    });
    void (async () => {
      let buffer: ArrayBuffer;
      try {
        buffer = await file.arrayBuffer();
      } catch {
        if (readSerial === cookieDomReadSerial) cookieFileController.reject("read_error");
        return;
      }
      if (readSerial !== cookieDomReadSerial) return;
      if (buffer.byteLength > COOKIE_DROP_MAX_BYTES) {
        cookieFileController.reject("too_large");
        return;
      }
      await cookieFileController.stage(
        safeDroppedCookieFileName(file.name),
        Array.from(new Uint8Array(buffer)),
      );
    })();
  });
  window.addEventListener("blur", () => {
    domFileDragDepth = 0;
    restoreCookieDropState();
  });
}

initCookieConsoleGuide();
initCookieDomDrop();

function publishDesktopPerf(): void {
  // devtoolsから `window.__eventAutoPinPerf` を参照できるが、productionへ
  // console.logを追加しない。
  if (typeof window !== "undefined" && isDesktopDevBuild) {
    (window as any).__eventAutoPinPerf = desktopPerf;
  }
}
async function syncDesktopPerfCounters(): Promise<void> {
  if (!isDesktopDevBuild) return;
  try {
    const counters = await invoke<{
      python_bridge_spawn_count?: number;
      tauri_event_io_ipc_count?: number;
    }>("get_desktop_performance_counters");
    desktopPerf.pythonBridgeStarts = Number(counters?.python_bridge_spawn_count ?? desktopPerf.pythonBridgeStarts);
    desktopPerf.tauriIpcCalls = Math.max(
      desktopPerf.tauriIpcCalls,
      Number(counters?.tauri_event_io_ipc_count ?? desktopPerf.tauriIpcCalls),
    );
    publishDesktopPerf();
  } catch {
    /* older Tauri binary has no counters command */
  }
}

let requestedEventSlug: string | null = null;
let committedEventSession: EventSession | null = null;
let selectionEpoch = 0;
function markEventDocumentMutated(): void {
  eventDocumentStateRevision += 1;
}

type ActiveEventDocumentOwner = { slug: string | null; path: string };
function captureActiveEventDocumentOwner(): ActiveEventDocumentOwner {
  return {
    slug: activeEventSlug,
    path: normalizeEventPath(editorJsonPathValue()),
  };
}
function isActiveEventDocumentOwner(owner: ActiveEventDocumentOwner): boolean {
  return (
    activeEventSlug === owner.slug &&
    normalizeEventPath(editorJsonPathValue()) === owner.path
  );
}

function activeEventDocumentOwnerKey(): string {
  return `${activeEventSlug ?? ""}\n${normalizeEventPath(editorJsonPathValue())}`;
}

function invokeEventAssetWrite<T>(
  event: Pick<EventEntry, "slug" | "dir">,
  command: string,
  args: Record<string, unknown>,
): Promise<T> {
  return eventLifecycleGate.run(eventMetaOwnerKey(event.slug, event.dir), () =>
    invoke<T>(command, args),
  );
}

function invokeActiveEventAssetWrite<T>(
  command: string,
  args: Record<string, unknown>,
): Promise<T> {
  const event = activeEventSlug
    ? eventList.find((entry) => entry.slug === activeEventSlug)
    : null;
  if (!event) return Promise.reject(new Error("アクティブイベントがありません"));
  return invokeEventAssetWrite<T>(event, command, args);
}

/** first await前にowner/revisionと対象object identityを固定する。 */
function captureEventAsyncMutationGuard(
  circleIdx?: number,
  itemIdx?: number,
): AsyncMutationGuard | null {
  const document = eventJsonData as object | null;
  if (!document) return null;
  const circle =
    circleIdx === undefined ? null : eventJsonData?.circles?.[circleIdx] ?? null;
  const item =
    itemIdx === undefined ? null : circle?.items?.[itemIdx] ?? null;
  if (circleIdx !== undefined && !circle) return null;
  if (itemIdx !== undefined && !item) return null;
  markEventDocumentMutated();
  const revision = eventDocumentStateRevision;
  const targets = [circle, item].filter((target) => target !== null) as object[];
  return createAsyncMutationGuard(
    {
      owner: activeEventDocumentOwnerKey(),
      revision,
      document,
      targets,
    },
    () => {
      const currentCircle =
        circleIdx === undefined
          ? null
          : eventJsonData?.circles?.[circleIdx] ?? null;
      const currentItem =
        itemIdx === undefined
          ? null
          : currentCircle?.items?.[itemIdx] ?? null;
      return {
        owner: activeEventDocumentOwnerKey(),
        revision: eventDocumentStateRevision,
        document: eventJsonData as object | null,
        targets: [currentCircle, currentItem].filter(
          (target) => target !== null,
        ) as object[],
      };
    },
  );
}
let operationState: OperationState = createOperationState();
const operationIdleWaiters: (() => void)[] = [];
let operationIdlePromise: Promise<void> | null = null;

function applyOperationEvent(event: OperationEvent): void {
  operationState = transitionOperationState(operationState, event);
  if (operationState.kind === "idle" && operationState.queuedReprocess === 0) {
    const waiters = operationIdleWaiters.splice(0);
    operationIdlePromise = null;
    waiters.forEach((resolve) => resolve());
  }
}

function waitForOperationIdle(): Promise<void> {
  if (canAutoSave(operationState)) return Promise.resolve();
  if (!operationIdlePromise) {
    operationIdlePromise = new Promise<void>((resolve) =>
      operationIdleWaiters.push(resolve),
    );
  }
  return operationIdlePromise;
}

let progressTimer: number | null = null;
let lastProgressTime = 0; // PROGRESS受信時刻（タイマー上書き抑制用）
let lastProgressCount = ""; // 最後に受信した "N/Total (XX%)" 表示用

// ログをファイルに書き出す（projectRootに出力）
function logToFile(msg: string) {
  invoke("append_log", {
    projectRoot: projectRootEl.value || null,
    message: msg,
  }).catch(() => {});
}

function modelProvider(providerId: string): ModelProviderOption | undefined {
  return modelCatalog.providers.find((p) => p.id === providerId);
}

function providerModels(providerId: string): ModelOption[] {
  return modelProvider(providerId)?.models ?? [];
}

function apiProviderLabel(providerId: string): string {
  if (providerId === "openai") return "OpenAI API";
  if (providerId === "gemini") return "Gemini API";
  return providerId || "API";
}

function apiProviderOptions() {
  const providers = Array.from(
    new Set(
      [...FALLBACK_MODEL_CATALOG.apiModels, ...modelCatalog.apiModels]
        .map((model) => model.provider)
        .filter((provider): provider is string => !!provider),
    ),
  );
  return providers.map((provider) => ({
    value: provider,
    label: apiProviderLabel(provider),
  }));
}

function providerConfigValue(selection: TextProviderSelection): string {
  return `${selection.kind}:${selection.provider}`;
}

function apiModelsForProvider(providerId: string): ModelOption[] {
  const merged = [...modelCatalog.apiModels];
  for (const fallback of FALLBACK_MODEL_CATALOG.apiModels) {
    if (
      fallback.provider === providerId &&
      !merged.some((model) => model.id === fallback.id && model.provider === fallback.provider)
    ) {
      merged.push(fallback);
    }
  }
  return merged.filter((model) => model.provider === providerId);
}

function reasoningEffortLabel(effort: string): string {
  if (/^\d+$/.test(effort)) return `budget ${effort}`;
  if (effort === "dynamic") return "dynamic";
  if (effort === "auto") return "auto";
  return effort;
}

function reasoningEffortOptions(efforts: string[]) {
  return efforts.map((effort) => ({
    value: effort,
    label: reasoningEffortLabel(effort),
  }));
}

function defaultEffortFor(efforts: string[]): string {
  if (efforts.includes(DEFAULT_REASONING_EFFORT)) return DEFAULT_REASONING_EFFORT;
  if (efforts.includes("dynamic")) return "dynamic";
  if (efforts.includes("auto")) return "auto";
  return efforts[0] || "none";
}

function normalizeReasoningEffortFor(value: string | undefined, efforts: string[]): string {
  return value && efforts.includes(value) ? value : defaultEffortFor(efforts);
}

function openAiEffortsForModel(modelId: string): string[] {
  if (modelId === "gpt-5-pro" || modelId === "gpt-5.2-pro") return ["high"];
  if (modelId.startsWith("gpt-5.2")) return OPENAI_LATEST_REASONING_EFFORTS;
  if (modelId.startsWith("gpt-5.1")) return OPENAI_51_REASONING_EFFORTS;
  if (modelId.startsWith("gpt-5")) return OPENAI_PRE_51_REASONING_EFFORTS;
  return OPENAI_REASONING_EFFORTS;
}

function geminiApiEffortsForModel(modelId: string): string[] {
  if (modelId.startsWith("gemini-3")) return GEMINI3_REASONING_EFFORTS;
  if (modelId.startsWith("gemini-2.5-pro")) return GEMINI25_PRO_BUDGETS;
  if (modelId.startsWith("gemini-2.5-flash")) return GEMINI25_FLASH_BUDGETS;
  return NO_REASONING_EFFORTS;
}

function reasoningEffortsForSelection(selection: TextProviderSelection, modelId: string): string[] {
  if (selection.kind === "api") {
    if (selection.provider === "openai") return openAiEffortsForModel(modelId);
    if (selection.provider === "gemini") return geminiApiEffortsForModel(modelId);
    return NO_REASONING_EFFORTS;
  }
  if (selection.provider === "codex") return CODEX_REASONING_EFFORTS;
  if (selection.provider === "claude") return CLAUDE_CODE_EFFORTS;
  return NO_REASONING_EFFORTS;
}

function setEffortOptions(selectId: string, preferredValue?: string, efforts = OPENAI_REASONING_EFFORTS) {
  const select = document.getElementById(selectId) as HTMLSelectElement;
  setSelectOptions(
    select,
    reasoningEffortOptions(efforts),
    normalizeReasoningEffortFor(preferredValue || select.value, efforts),
  );
}

function inferApiProviderFromModel(modelId: string): string {
  const found = [...modelCatalog.apiModels, ...FALLBACK_MODEL_CATALOG.apiModels].find(
    (model) => model.id === modelId,
  );
  if (found?.provider) return found.provider;
  if (modelId.startsWith("gemini-")) return "gemini";
  return apiProviderOptions()[0]?.value || "openai";
}

function textProviderOptions() {
  return [
    ...apiProviderOptions().map((provider) => ({
      value: `api:${provider.value}`,
      label: provider.label,
      disabled: false,
    })),
    ...modelCatalog.providers.map((provider) => ({
      value: `cli:${provider.id}`,
      label: provider.label,
      disabled: false,
    })),
  ];
}

function parseTextProviderValue(value: string): TextProviderSelection {
  if (value.startsWith("cli:")) {
    return { kind: "cli", provider: value.slice(4) };
  }
  if (value.startsWith("api:")) {
    return { kind: "api", provider: value.slice(4) };
  }
  return { kind: "api", provider: value || inferApiProviderFromModel("") };
}

function textProviderValueFromConfig(provider: string, modelId: string): string {
  if (provider && provider !== "api") return `cli:${provider}`;
  return `api:${inferApiProviderFromModel(modelId)}`;
}

function updateTextModelSelect(preferredValue?: string) {
  updateProviderModelSelect(
    "modelProvider",
    "model",
    "textReasoningEffort",
    preferredValue,
  );
}

function updateProviderModelSelect(
  providerSelectId: string,
  modelSelectId: string,
  effortSelectId: string,
  preferredValue?: string,
) {
  const providerSelect = document.getElementById(providerSelectId) as HTMLSelectElement;
  const modelSelect = document.getElementById(modelSelectId) as HTMLSelectElement;
  const effortSelect = document.getElementById(effortSelectId) as HTMLSelectElement;
  const selection = parseTextProviderValue(providerSelect.value);
  const models =
    selection.kind === "cli"
      ? providerModels(selection.provider)
      : apiModelsForProvider(selection.provider);
  setSelectOptions(modelSelect, modelOptions(models), preferredValue);
  setEffortOptions(
    effortSelectId,
    effortSelect?.value,
    reasoningEffortsForSelection(selection, modelSelect.value),
  );
}

function updateVisionModelSelect(preferredValue?: string) {
  updateProviderModelSelect(
    "visionModel",
    "visionModelId",
    "visionReasoningEffort",
    preferredValue,
  );
}

function updateTextFallbackModelSelect(preferredValue?: string) {
  updateProviderModelSelect(
    "textFallbackModelProvider",
    "textFallbackModel",
    "textFallbackReasoningEffort",
    preferredValue,
  );
}

function updateVisionFallbackModelSelect(preferredValue?: string) {
  updateProviderModelSelect(
    "visionFallbackModelProvider",
    "visionFallbackModel",
    "visionFallbackReasoningEffort",
    preferredValue,
  );
}

function setSelectOptions(
  select: HTMLSelectElement,
  options: { value: string; label: string; disabled?: boolean }[],
  preferredValue?: string,
) {
  const current = preferredValue || select.value;
  select.innerHTML = "";
  for (const item of options) {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    option.disabled = !!item.disabled;
    select.appendChild(option);
  }
  if (current && options.some((item) => item.value === current)) {
    select.value = current;
  } else if (current) {
    const option = document.createElement("option");
    option.value = current;
    option.textContent = current;
    select.appendChild(option);
    select.value = current;
  } else if (select.options.length > 0) {
    select.selectedIndex = 0;
  }
}

function cliProviderOptions(includeNone = false) {
  const options = modelCatalog.providers.map((provider) => ({
    value: provider.id,
    label: provider.label,
    disabled: false,
  }));
  if (includeNone) {
    return [{ value: "", label: "なし" }, ...options];
  }
  return options;
}

function modelOptions(models: ModelOption[]) {
  return models.map((model) => ({
    value: model.id,
    label: [model.label, model.source_label].filter(Boolean).join(" / "),
  }));
}

function updateCliModelSelect(providerSelectId: string, modelSelectId: string) {
  const provider = (document.getElementById(providerSelectId) as HTMLSelectElement)
    ?.value;
  const modelSelect = document.getElementById(modelSelectId) as HTMLSelectElement;
  if (!modelSelect) return;
  if (!provider) {
    setSelectOptions(modelSelect, [{ value: "", label: "なし" }], "");
    return;
  }
  setSelectOptions(modelSelect, modelOptions(providerModels(provider)));
}

function hydrateModelControls() {
  const textModelSelect = document.getElementById("model") as HTMLSelectElement;
  const currentTextModel = textModelSelect.value || "gpt-5.6-sol";
  const textFallbackModelSelect = document.getElementById("textFallbackModel") as HTMLSelectElement;
  const currentTextFallbackModel = textFallbackModelSelect.value || "gpt-5.5";
  const visionFallbackModelSelect = document.getElementById("visionFallbackModel") as HTMLSelectElement;
  const currentVisionFallbackModel = visionFallbackModelSelect.value || "gpt-5-mini";
  setSelectOptions(
    document.getElementById("modelProvider") as HTMLSelectElement,
    textProviderOptions(),
    (document.getElementById("modelProvider") as HTMLSelectElement).value ||
      textProviderValueFromConfig("api", currentTextModel),
  );
  updateTextModelSelect(currentTextModel);
  setSelectOptions(
    document.getElementById("textFallbackModelProvider") as HTMLSelectElement,
    textProviderOptions(),
    (document.getElementById("textFallbackModelProvider") as HTMLSelectElement).value ||
      "cli:codex",
  );
  updateTextFallbackModelSelect(currentTextFallbackModel);
  setSelectOptions(
    document.getElementById("visionModel") as HTMLSelectElement,
    textProviderOptions(),
    (document.getElementById("visionModel") as HTMLSelectElement).value ||
      "api:gemini",
  );
  updateVisionModelSelect();
  setSelectOptions(
    document.getElementById("visionFallbackModelProvider") as HTMLSelectElement,
    textProviderOptions(),
    (document.getElementById("visionFallbackModelProvider") as HTMLSelectElement).value ||
      "api:openai",
  );
  updateVisionFallbackModelSelect(currentVisionFallbackModel);
}

async function loadModelCatalog() {
  if (modelCatalogStatusEl) modelCatalogStatusEl.textContent = "取得中...";
  if (refreshModelCatalogBtn) refreshModelCatalogBtn.disabled = true;
  try {
    modelCatalog = await invoke<ModelCatalog>("list_model_catalog", {
      projectRoot: projectRootEl.value || ".",
    });
    const apiCount = modelCatalog.apiModels.length;
    const cliCount = modelCatalog.providers.reduce(
      (sum, provider) => sum + provider.models.length,
      0,
    );
    const errors = modelCatalog.apiErrors?.length
      ? ` / API取得エラー ${modelCatalog.apiErrors.length}件`
      : "";
    if (modelCatalogStatusEl) {
      modelCatalogStatusEl.textContent = `API ${apiCount}件 / CLI ${cliCount}件${errors}`;
    }
  } catch (e) {
    modelCatalog = FALLBACK_MODEL_CATALOG;
    console.warn("モデルカタログ読み込みスキップ:", e);
    if (modelCatalogStatusEl) modelCatalogStatusEl.textContent = "候補表示";
  } finally {
    if (refreshModelCatalogBtn) refreshModelCatalogBtn.disabled = false;
  }
  hydrateModelControls();
}

function selectedTextProvider(): TextProviderSelection {
  return parseTextProviderValue(
    (document.getElementById("modelProvider") as HTMLSelectElement).value,
  );
}

function selectedTextCliModelMap(): Record<string, string> {
  const selection = selectedTextProvider();
  const model = (document.getElementById("model") as HTMLSelectElement).value;
  if (selection.kind !== "cli" || !model || model === "default") return {};
  return { [selection.provider]: model };
}

function selectedTextCliEffortMap(): Record<string, string> {
  const selection = selectedTextProvider();
  if (selection.kind !== "cli") return {};
  const model = (document.getElementById("model") as HTMLSelectElement).value;
  const efforts = reasoningEffortsForSelection(selection, model);
  return {
    [selection.provider]: normalizeReasoningEffortFor(
      (document.getElementById("textReasoningEffort") as HTMLSelectElement).value,
      efforts,
    ),
  };
}

function selectedTextEffort(): string {
  const selection = selectedTextProvider();
  const model = (document.getElementById("model") as HTMLSelectElement).value;
  return normalizeReasoningEffortFor(
    (document.getElementById("textReasoningEffort") as HTMLSelectElement).value,
    reasoningEffortsForSelection(selection, model),
  );
}

function selectedTextFallbackProvider(): TextProviderSelection {
  return parseTextProviderValue(
    (document.getElementById("textFallbackModelProvider") as HTMLSelectElement).value,
  );
}

function selectedTextFallbackModel(): string {
  return (document.getElementById("textFallbackModel") as HTMLSelectElement).value;
}

function selectedTextFallbackEffort(): string {
  const selection = selectedTextFallbackProvider();
  const model = selectedTextFallbackModel();
  return normalizeReasoningEffortFor(
    (document.getElementById("textFallbackReasoningEffort") as HTMLSelectElement).value,
    reasoningEffortsForSelection(selection, model),
  );
}

function selectedImageProvider(): TextProviderSelection {
  return parseTextProviderValue(
    (document.getElementById("visionModel") as HTMLSelectElement).value,
  );
}

function selectedImageModel(): string {
  return (document.getElementById("visionModelId") as HTMLSelectElement).value;
}

function selectedImageConfig() {
  const selection = selectedImageProvider();
  const model = selectedImageModel();
  const effort = normalizeReasoningEffortFor(
    (document.getElementById("visionReasoningEffort") as HTMLSelectElement).value,
    reasoningEffortsForSelection(selection, model),
  );
  return {
    provider: `${selection.kind}:${selection.provider}`,
    model,
    effort,
  };
}

function selectedImageFallbackProvider(): TextProviderSelection {
  return parseTextProviderValue(
    (document.getElementById("visionFallbackModelProvider") as HTMLSelectElement).value,
  );
}

function selectedImageFallbackModel(): string {
  return (document.getElementById("visionFallbackModel") as HTMLSelectElement).value;
}

function selectedImageFallbackEffort(): string {
  const selection = selectedImageFallbackProvider();
  const model = selectedImageFallbackModel();
  return normalizeReasoningEffortFor(
    (document.getElementById("visionFallbackReasoningEffort") as HTMLSelectElement).value,
    reasoningEffortsForSelection(selection, model),
  );
}

function uniqueModels(models: string[]): string[] {
  return Array.from(new Set(models.map((m) => m.trim()).filter((m) => m)));
}

function selectedTextApiModels(): string[] {
  const textProvider = selectedTextProvider();
  const textFallbackProvider = selectedTextFallbackProvider();
  const primaryModel = (document.getElementById("model") as HTMLSelectElement).value;
  const fallbackModel = selectedTextFallbackModel();
  return uniqueModels([
    textProvider.kind === "api" ? primaryModel : "",
    textFallbackProvider.kind === "api" ? fallbackModel : "",
  ]);
}

function selectedTextApiEffortMap(): Record<string, string> {
  const textProvider = selectedTextProvider();
  const textFallbackProvider = selectedTextFallbackProvider();
  const primaryModel = (document.getElementById("model") as HTMLSelectElement).value;
  const fallbackModel = selectedTextFallbackModel();
  const map: Record<string, string> = {};
  if (textProvider.kind === "api" && primaryModel) {
    map[primaryModel] = selectedTextEffort();
  }
  if (textFallbackProvider.kind === "api" && fallbackModel) {
    map[fallbackModel] = selectedTextFallbackEffort();
  }
  return map;
}

function selectedImageApiModels(): string[] {
  const imageConfig = selectedImageConfig();
  const imageFallbackProvider = selectedImageFallbackProvider();
  const fallbackModel = selectedImageFallbackModel();
  return uniqueModels([
    imageConfig.provider.startsWith("api:") ? imageConfig.model : "",
    imageFallbackProvider.kind === "api" ? fallbackModel : "",
  ]);
}

function selectedImageApiEffortMap(): Record<string, string> {
  const imageConfig = selectedImageConfig();
  const imageFallbackProvider = selectedImageFallbackProvider();
  const fallbackModel = selectedImageFallbackModel();
  const map: Record<string, string> = {};
  if (imageConfig.provider.startsWith("api:") && imageConfig.model) {
    map[imageConfig.model] = imageConfig.effort;
  }
  if (imageFallbackProvider.kind === "api" && fallbackModel) {
    map[fallbackModel] = selectedImageFallbackEffort();
  }
  return map;
}

function selectedTweetProviders(): string[] {
  const selection = selectedTextProvider();
  return selection.kind === "cli" ? [selection.provider] : [];
}

function selectedTweetModelMap(): Record<string, string> {
  return selectedTextCliModelMap();
}

function selectedTweetEffortMap(): Record<string, string> {
  return selectedTextCliEffortMap();
}

const IMAGE_HEADER_CANDIDATES = [
  "アイテム画像",
  "サークル画像",
  "circle_cut_filename",
  "circle_cut_url",
  "circle_image",
  "item_image",
];
const TWITTER_HEADER_CANDIDATES = [
  "サークルメモ",
  "twitter_url",
  "twitter",
  "x_url",
  "x.com",
  "Xアカウント",
  "Twitter",
];

// 色（優先度）の定義
type ColorOption = {
  value: string;
  label: string;
  color: string;
  bgColor: string;
};
const PRIORITY_COLOR_STORAGE_KEY = "eventtrail-settings-priority-colors-v1";
const LEGACY_PRIORITY_COLOR_STORAGE_KEY = "eventtrail-priority-colors-v1";
const GLOBAL_SEARCH_ENABLED_STORAGE_KEY =
  "eventtrail-settings-global-search-enabled-v1";
const DEFAULT_COLOR_OPTIONS: ColorOption[] = [
  { value: "5", label: "低", color: "#0277bd", bgColor: "#d9effb" },
  { value: "11", label: "中", color: "#2e7d32", bgColor: "#ddf2df" },
  { value: "10", label: "高", color: "#f57f17", bgColor: "#fff3c4" },
  { value: "15", label: "最優先", color: "#c62828", bgColor: "#f9d7e0" },
];
let COLOR_OPTIONS: ColorOption[] = loadPriorityColorOptions();
let globalSearchEnabled = loadGlobalSearchEnabled();

function normalizeHexColor(value: string): string | null {
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;
  const normalized = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  return /^#[0-9a-f]{6}$/i.test(normalized) ? normalized.toLowerCase() : null;
}

function hexToRgba(hex: string, alpha: number): string {
  const normalized = normalizeHexColor(hex);
  if (!normalized) return `rgba(0,0,0,${alpha})`;
  const r = parseInt(normalized.slice(1, 3), 16);
  const g = parseInt(normalized.slice(3, 5), 16);
  const b = parseInt(normalized.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function priorityRowVarsFromColor(color: string): string {
  return [
    `--priority-row-color:${color}`,
  ].join(";");
}

function priorityBgFromColor(color: string): string {
  return hexToRgba(color, 0.14);
}

function loadPriorityColorOptions(): ColorOption[] {
  try {
    const raw =
      localStorage.getItem(PRIORITY_COLOR_STORAGE_KEY) ||
      localStorage.getItem(LEGACY_PRIORITY_COLOR_STORAGE_KEY);
    if (!raw) return DEFAULT_COLOR_OPTIONS.map((o) => ({ ...o }));
    const parsed = JSON.parse(raw) as Partial<ColorOption>[];
    const options = DEFAULT_COLOR_OPTIONS.map((base) => {
      const override = parsed.find((o) => String(o.value) === base.value);
      const color = normalizeHexColor(String(override?.color || "")) || base.color;
      return { ...base, color, bgColor: priorityBgFromColor(color) };
    });
    localStorage.setItem(PRIORITY_COLOR_STORAGE_KEY, JSON.stringify(options));
    return options;
  } catch {
    return DEFAULT_COLOR_OPTIONS.map((o) => ({ ...o }));
  }
}

function savePriorityColorOptions() {
  localStorage.setItem(PRIORITY_COLOR_STORAGE_KEY, JSON.stringify(COLOR_OPTIONS));
}

function loadGlobalSearchEnabled(): boolean {
  return localStorage.getItem(GLOBAL_SEARCH_ENABLED_STORAGE_KEY) === "1";
}

function saveGlobalSearchEnabled() {
  localStorage.setItem(
    GLOBAL_SEARCH_ENABLED_STORAGE_KEY,
    globalSearchEnabled ? "1" : "0",
  );
}

function getColorOption(val: string): ColorOption | null {
  const parsed = parseFloat(val);
  if (isNaN(parsed)) return null;
  const numStr = String(parsed);
  return COLOR_OPTIONS.find((c) => c.value === numStr) || null;
}

function applyPriorityRowStyle(row: HTMLElement, opt: ColorOption | null) {
  if (!opt) {
    row.style.removeProperty("--priority-row-color");
    return;
  }
  row.style.setProperty("--priority-row-color", opt.color);
}

function isColorCol(h: string): boolean {
  return h === "色";
}

// 列幅デフォルト（px）- 画像列は1xサイズ基準で最小限に
const DEFAULT_COL_WIDTHS: Record<string, number> = {
  ホール: 55,
  スペース: 55,
  サークル画像: 80,
  アイテム画像: 80,
  サークル名: 130,
  ジャンル: 70,
  サークルメモ: 80,
  ペンネーム: 80,
  色: 65,
  アイテムメモ: 80,
  アイテムタグ: 80,
  チェック: 95,
  アイテム名: 120,
};
const COL_WIDTHS_STORAGE_KEY = "eventtrail-col-widths-v4";

function loadColWidths(): Record<string, number> {
  try {
    const raw = localStorage.getItem(COL_WIDTHS_STORAGE_KEY);
    if (raw) return { ...DEFAULT_COL_WIDTHS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_COL_WIDTHS };
}

function saveColWidths(widths: Record<string, number>) {
  localStorage.setItem(COL_WIDTHS_STORAGE_KEY, JSON.stringify(widths));
}

let colWidths = loadColWidths();

function boolFromSelect(id: string): boolean {
  return (document.getElementById(id) as HTMLSelectElement).value === "true";
}

function escapeHtml(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function onTabActivated(target: string) {
  if (target === "tab-map") {
    requestAnimationFrame(() => fitMapToViewport());
  } else if (target === "tab-history") {
    requestAnimationFrame(() => {
      document.getElementById("historySearchQuery")?.focus();
    });
  }
}

function initTabs() {
  const buttons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".tab-btn"),
  );
  const panes = Array.from(document.querySelectorAll<HTMLElement>(".tab-pane"));

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tab;
      buttons.forEach((b) => b.classList.remove("active"));
      panes.forEach((pane) => pane.classList.remove("active"));
      btn.classList.add("active");
      if (target) {
        const pane = document.getElementById(target);
        if (pane) pane.classList.add("active");
        onTabActivated(target);
      }
    });
  });
}

let progressStartTime = 0;

function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}秒`;
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  return `${min}分${s.toString().padStart(2, "0")}秒`;
}

function startElapsedTimer() {
  progressStartTime = Date.now();
  lastProgressTime = 0;
  lastProgressCount = "";
  progressEl.removeAttribute("value"); // 不確定プログレスバー
  progressTextEl.textContent = "開始しました...";
  if (progressTimer) window.clearInterval(progressTimer);
  progressTimer = window.setInterval(() => {
    const elapsed = formatElapsed(Date.now() - progressStartTime);
    if (lastProgressCount) {
      progressTextEl.textContent = `${lastProgressCount} ${elapsed} 経過`;
    } else {
      progressTextEl.textContent = `${elapsed} 経過`;
    }
  }, 1000);
}

function finishElapsedTimer(ok: boolean) {
  if (progressTimer) {
    window.clearInterval(progressTimer);
    progressTimer = null;
  }
  const elapsed = formatElapsed(Date.now() - progressStartTime);
  progressEl.value = ok ? 100 : 0;
  progressTextEl.textContent = ok ? `完了（${elapsed}）` : `失敗（${elapsed}）`;
}

function findHeaderByCandidates(
  headers: string[],
  candidates: string[],
): string | null {
  const lower = headers.map((h) => h.toLowerCase());
  for (const c of candidates) {
    const idx = lower.findIndex((h) => h.includes(c.toLowerCase()));
    if (idx >= 0) return headers[idx];
  }
  return null;
}

function resolveImageSrc(pathOrUrl: string): string {
  if (!pathOrUrl) return "";
  if (
    pathOrUrl.startsWith("http://") ||
    pathOrUrl.startsWith("https://") ||
    pathOrUrl.startsWith("data:image")
  ) {
    return pathOrUrl;
  }
  const root = projectRootEl.value.replace(/\\/g, "/");
  const normalized = pathOrUrl.replace(/^\.?[\\/]/, "");
  // ファイル名のみ（パス区切りなし）の場合はアクティブイベントフォルダを使用
  let absPath: string;
  const activeEv = activeEventSlug
    ? eventList.find((e) => e.slug === activeEventSlug)
    : null;
  if (!normalized.includes("/") && !normalized.includes("\\")) {
    const imgDir = activeEv?.dir ?? "";
    absPath = `${imgDir}/${normalized}`;
  } else if (
    activeEv?.dir &&
    /^(circles|items|maps|event_image)\//.test(normalized)
  ) {
    absPath = `${activeEv.dir}/${normalized}`;
  } else {
    absPath = `${root}/${normalized}`;
  }
  // Tauriのassetプロトコルで変換（file://はwebviewでブロックされる）
  return convertFileSrc(absPath);
}

function getDisplayHeaders(headers: string[]): string[] {
  // 非表示列 + ホール（スペースと結合表示するため個別非表示）
  const hiddenCols = [
    "マップ番号",
    "ピンX",
    "ピンY",
    "ピン型",
    "ピン値",
    "買い物リスト名",
    "買い物メモ",
    "単価",
    "数量",
  ];
  const filtered = headers.filter((h) => !hiddenCols.includes(h));
  // 表示順: スペース → サークル画像 → アイテム画像 → サークル名 → 残り
  const priority = [
    "ホール",
    "スペース",
    "サークル画像",
    "アイテム画像",
    "サークル名",
    "ジャンル",
    "サークルメモ",
    "ペンネーム",
    "アイテムメモ",
    "アイテムタグ",
    "色",
    "チェック",
  ];
  const ordered: string[] = [];
  for (const p of priority) {
    if (filtered.includes(p)) ordered.push(p);
  }
  // priority外の列は非表示
  return ordered;
}

// アイテム分別カテゴリ
const ITEM_CATEGORIES = [
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
const CIRCLE_GENRES = [
  "",
  "漫画",
  "イラスト",
  "音楽",
  "小説",
  "雑誌",
  "グッズ",
  "その他",
];

// お気に入りソート状態
let favoriteSortActive = false;

// サークルのアイテム展開パネルHTMLを生成
function renderItemPanel(circleIdx: number): string {
  if (!eventJsonData) return "";
  const circles: any[] = eventJsonData.circles || [];
  if (circleIdx < 0 || circleIdx >= circles.length) return "";
  const c = circles[circleIdx];
  const items: any[] = c.items || [];

  const itemRows = items
    .map((item: any, itemIdx: number) => {
      const checkedVal = getEffectiveItemStatus(item, c);
      const checkedView = PURCHASE_STATUS_VIEWS[checkedVal];
      const boughtView = PURCHASE_STATUS_VIEWS[PURCHASE_STATUS.BOUGHT];
      const knownPurchased = isPurchasedItemKnown(c, item);
      const itemImgPath = item.image || "";
      const itemImgSrc = itemImgPath ? resolveImageSrc(itemImgPath) : "";
      const itemImgHtml = itemImgSrc
        ? `<img src="${escapeHtml(itemImgSrc)}" alt="" class="thumb-sm" data-fallback="outerhtml" data-fallback-html="<span class='img-placeholder-sm'>選択</span>" />`
        : `<span class="img-placeholder-sm">選択</span>`;
      const purchasedBadge = knownPurchased
        ? `<span class="purchased-item-badge" style="border-color:${boughtView.color};color:${boughtView.color};">購入済み</span>`
        : "";
      const rowStyle = knownPurchased
        ? ` style="background:${boughtView.bg || "rgba(46,125,50,0.12)"};"`
        : "";
      return `<tr class="item-draggable-row${knownPurchased ? " item-purchased-known" : ""}" data-circle="${circleIdx}" data-item="${itemIdx}" draggable="true"${rowStyle}>
      <td class="item-drag-handle" title="ドラッグで並び替え">⠿</td>
      <td class="item-img-cell w-10 text-center cursor-pointer" data-circle="${circleIdx}" data-item="${itemIdx}">${itemImgHtml}</td>
      <td><input class="item-field" data-circle="${circleIdx}" data-item="${itemIdx}" data-field="name" value="${escapeHtml(item.name || "")}" placeholder="アイテム名" /></td>
      <td><input class="item-field w-20" data-circle="${circleIdx}" data-item="${itemIdx}" data-field="price" type="number" value="${item.price ?? ""}" placeholder="0" /></td>
      <td><input class="item-field" data-circle="${circleIdx}" data-item="${itemIdx}" data-field="description" value="${escapeHtml(item.description || "")}" placeholder="メモ" /></td>
      <td><select class="item-field item-category-select category-select-compact" data-circle="${circleIdx}" data-item="${itemIdx}" data-field="type">
        ${ITEM_CATEGORIES.map((cat) => `<option value="${escapeHtml(cat)}"${(item.type || item.genre || "") === cat ? " selected" : ""}>${cat || "分類なし"}</option>`).join("")}
      </select></td>
      <td style="background:${knownPurchased ? boughtView.bg || checkedView.bg : checkedView.bg};">${purchasedBadge}
        <button class="item-check-cycle-btn check-btn-sm" data-circle="${circleIdx}" data-item="${itemIdx}" data-val="${checkedVal}" style="border-color:${checkedView.color};color:${checkedView.color};">${checkedView.icon} ${checkedView.label}</button>
      </td>
      <td><button class="item-review-btn text-xs px-1.5 py-0.5 bg-purple-900/30 hover:bg-purple-800/50 text-purple-300 rounded border border-purple-700/50" data-circle="${circleIdx}" data-item="${itemIdx}" title="感想ファイルに追記して開く">📝</button></td>
      <td><button class="item-delete-btn text-xs px-2 py-0.5 bg-red-900/30 hover:bg-red-800/50 text-red-400 rounded border border-red-700/50" data-circle="${circleIdx}" data-item="${itemIdx}">削除</button></td>
    </tr>`;
    })
    .join("");

  const emptyMsg =
    items.length === 0
      ? `<tr><td colspan="10" class="text-center text-gray-400 text-sm">アイテムなし</td></tr>`
      : "";

  return `<tr class="item-panel-row" data-circle="${circleIdx}"><td colspan="100">
    <div class="item-panel">
      <table class="item-table">
        <thead><tr><th class="w-8"></th><th class="w-11">画像</th><th>アイテム名</th><th class="w-[90px]">単価</th><th>メモ</th><th class="w-[110px]">分類</th><th class="w-[100px]">チェック</th><th class="w-8">感想</th><th class="w-15"></th></tr></thead>
        <tbody>${itemRows}${emptyMsg}</tbody>
      </table>
      <button class="item-add-btn mt-1.5 px-3 py-1 text-sm bg-gray-700 hover:bg-gray-600 text-gray-300 rounded" data-circle="${circleIdx}">+ アイテム追加</button>
    </div>
  </td></tr>`;
}

async function loadConfig() {
  const config = await invoke<DesktopConfig>("load_desktop_config");
  pythonExeEl.value = config.pythonExe;
  projectRootEl.value = config.projectRoot;
  timeoutMsEl.value = String(config.timeoutMs);
  foamDirEl.value = config.foamDir || "";
  unlimitedOcrModelEl.value = config.unlimitedOcrModel || "baidu/Unlimited-OCR";
  unlimitedOcrModelPathEl.value = config.unlimitedOcrModelPath || "";
  unlimitedOcrVenvEl.value = config.unlimitedOcrVenv || "";
  unlimitedOcrHfHomeEl.value = config.unlimitedOcrHfHome || "";
  unlimitedOcrRevisionEl.value = config.unlimitedOcrRevision || "ee63731b6461c8afcdcc7b15352e7d2ffecc2ead";
  unlimitedOcrDeviceEl.value = config.unlimitedOcrDevice || "auto";
  unlimitedOcrModeEl.value = config.unlimitedOcrMode || "gundam";
  unlimitedOcrStrategyEl.value = config.unlimitedOcrStrategy || "small_digits";

  // APIキーを.envから読み込み
  try {
    const keys = await invoke<EnvKeys>("load_env_keys", {
      projectRoot: config.projectRoot,
    });
    openaiApiKeyEl.value = keys.openaiApiKey;
    geminiApiKeyEl.value = keys.geminiApiKey;
    xaiApiKeyEl.value = keys.xaiApiKey;
  } catch (e) {
    console.warn(".env読み込みスキップ:", e);
  }
}

async function saveConfig() {
  // project/output root変更は保存対象の所有ディレクトリが変わり得るため、
  // 設定を書き換える前に全イベントのsnapshotを確定する。
  await flushAllEventSavesOrThrow();
  const payload: DesktopConfig = {
    pythonExe: pythonExeEl.value,
    projectRoot: projectRootEl.value,
    timeoutMs: Number(timeoutMsEl.value || "10800000"),
    foamDir: foamDirEl.value,
    unlimitedOcrModel: unlimitedOcrModelEl.value.trim(),
    unlimitedOcrModelPath: unlimitedOcrModelPathEl.value.trim(),
    unlimitedOcrVenv: unlimitedOcrVenvEl.value.trim(),
    unlimitedOcrHfHome: unlimitedOcrHfHomeEl.value.trim(),
    unlimitedOcrRevision: unlimitedOcrRevisionEl.value.trim(),
    unlimitedOcrDevice: unlimitedOcrDeviceEl.value,
    unlimitedOcrMode: unlimitedOcrModeEl.value,
    unlimitedOcrStrategy: unlimitedOcrStrategyEl.value,
  };
  const res = await invoke("save_desktop_config", { config: payload });

  // APIキーを.envに保存
  await invoke("save_env_keys", {
    projectRoot: projectRootEl.value,
    keys: {
      openaiApiKey: openaiApiKeyEl.value,
      geminiApiKey: geminiApiKeyEl.value,
      xaiApiKey: xaiApiKeyEl.value,
    },
  });

  await saveProjectConfig();
  resultEl.textContent = "設定を保存しました";
  await loadModelCatalog();
}

function currentOcrConfigPayload(): Record<string, unknown> {
  return {
    model: unlimitedOcrModelEl?.value.trim() || "baidu/Unlimited-OCR",
    model_path: unlimitedOcrModelPathEl?.value.trim() || "",
    venv_path: unlimitedOcrVenvEl?.value.trim() || "",
    hf_home: unlimitedOcrHfHomeEl?.value.trim() || "",
    revision: unlimitedOcrRevisionEl?.value.trim() || "ee63731b6461c8afcdcc7b15352e7d2ffecc2ead",
    device: unlimitedOcrDeviceEl?.value || "auto",
    mode: unlimitedOcrModeEl?.value || "gundam",
    strategy: unlimitedOcrStrategyEl?.value || "small_digits",
  };
}

async function runUnlimitedOcrDoctor(): Promise<void> {
  if (!unlimitedOcrDoctorBtn) return;
  unlimitedOcrDoctorBtn.disabled = true;
  resultEl.textContent = "Unlimited OCR環境を確認中...";
  try {
    const response = await runJob("unlimited_ocr_doctor", {
      ocr_config: currentOcrConfigPayload(),
    });
    const bridge = response?.bridge as Record<string, any> | undefined;
    if (bridge) {
      const issues = Array.isArray(bridge.issues) ? bridge.issues : [];
      resultEl.textContent =
        `${bridge.ready ? "Unlimited OCR準備完了" : "Unlimited OCR設定に確認事項があります"}\n` +
        `モデル: ${bridge.model_source || "-"}\n` +
        `Python: ${bridge.python || "-"}\n` +
        (issues.length ? `\n⚠️ ${issues.join("\n⚠️ ")}` : "\nCUDA/torch診断は正常です。");
    }
  } finally {
    unlimitedOcrDoctorBtn.disabled = false;
  }
}

function formatResult(job: string, response: Record<string, unknown>): string {
  const ok = Boolean(response.ok);
  const bridge = response.bridge as Record<string, unknown> | undefined;

  if (job === "ping") {
    if (ok && bridge?.status === "ok") {
      return `接続OK\nPython: ${bridge.python ?? "不明"}`;
    }
    return `接続失敗: ${response.stderr || "不明なエラー"}`;
  }

  if (job === "list_jobs") {
    const jobs = (bridge?.jobs as string[]) ?? [];
    return `利用可能なジョブ (${jobs.length}件):\n${jobs.map((j) => `  - ${j}`).join("\n")}`;
  }

  if (job === "validate_mobile_json") {
    if (ok && bridge?.status === "ok") {
      const b = bridge as Record<string, unknown>;
      return `互換性チェックOK\nサークル数: ${b.circle_count ?? "?"}\n画像埋め込み: ${b.image_count ?? 0}件`;
    }
    return `チェック失敗: ${bridge?.error || response.stderr || "不明"}`;
  }

  // その他のジョブ: ステータス行 + stderrがあれば表示
  const status = ok ? "完了" : "失敗";
  const stderr = String(response.stderr || "").trim();
  let msg = `${job}: ${status}`;
  if (bridge?.error) msg += `\nエラー: ${bridge.error}`;
  if (stderr) msg += `\n\n--- ログ ---\n${stderr}`;
  return msg;
}

function formatOcrDiagnostics(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const diagnostics = value as Record<string, unknown>;
  const lines: string[] = [];
  const code = String(diagnostics.error_code || "").trim();
  const message = String(diagnostics.error_message || "").trim();
  const returncode = diagnostics.returncode;
  const model = String(diagnostics.model || "").trim();
  const device = String(diagnostics.device || "").trim();
  const venv = diagnostics.venv as Record<string, unknown> | undefined;
  const stderr = String(diagnostics.stderr || "").trim();
  const hint = String(diagnostics.recovery_hint || "").trim();
  if (code) lines.push(`診断コード: ${code}`);
  if (message) lines.push(`診断メッセージ: ${message}`);
  if (returncode !== null && returncode !== undefined) {
    lines.push(`OCR returncode: ${String(returncode)}`);
  }
  if (model) lines.push(`OCRモデル: ${model}`);
  if (device) lines.push(`実行デバイス: ${device}`);
  if (venv && venv.configured !== undefined) {
    lines.push(`専用venv: ${venv.configured ? "設定済み" : "未設定（既定環境）"}`);
  }
  if (stderr) lines.push(`stderr要約: ${stderr}`);
  if (hint) lines.push(`復旧方法: ${hint}`);
  return lines.length ? `\n\n--- OCR診断（安全な要約） ---\n${lines.join("\n")}` : "";
}

function historyMatchLabel(hit: HistorySearchHit): string {
  return hit.matchedBy === "title" ? "本タイトル一致" : "サークル一致";
}

function historyScoreLabel(score: number): string {
  if (score >= 98) return "完全一致";
  if (score >= 88) return "部分一致";
  return "近い候補";
}

function renderHistorySearchResults(response: HistorySearchResponse) {
  const resultsEl = document.getElementById("historySearchResults");
  if (!resultsEl) return;
  if (response.results.length === 0) {
    resultsEl.innerHTML = `
      <div class="history-empty-state">
        <strong>候補が見つかりませんでした</strong>
        <span>短い語にする、記号を外す、サークル名と本タイトルを入れ替える、などを試してください。</span>
      </div>`;
    return;
  }

  const groups = new Map<string, HistorySearchHit[]>();
  for (const hit of response.results) {
    const key = `${hit.circleName}\u0000${hit.penname}`;
    const group = groups.get(key) || [];
    group.push(hit);
    groups.set(key, group);
  }

  resultsEl.innerHTML = Array.from(groups.values())
    .map((hits) => {
      const best = hits[0];
      const title = best.circleName || "サークル名不明";
      const penname = best.penname
        ? `<span class="history-penname">${escapeHtml(best.penname)}</span>`
        : "";
      const eventRows = hits
        .map((hit) => {
          const place = [hit.hall, hit.space].filter(Boolean).join(" / ");
          const matchedTitles = hit.matchedTitles.length
            ? `<div class="history-matched-titles">${hit.matchedTitles
                .map((item) => `<span>${escapeHtml(item)}</span>`)
                .join("")}</div>`
            : "";
          return `
            <li class="history-event-row">
              <div class="history-event-primary">
                <strong>${escapeHtml(hit.eventName || "イベント名不明")}</strong>
                <span>${escapeHtml(hit.eventDate || "日付不明")}</span>
                ${place ? `<span>${escapeHtml(place)}</span>` : ""}
              </div>
              <div class="history-match-detail">
                <span class="history-match-kind">${historyMatchLabel(hit)}</span>
                <span>${escapeHtml(hit.matchedText)}</span>
              </div>
              ${matchedTitles}
            </li>`;
        })
        .join("");
      return `
        <article class="history-result-card">
          <header>
            <div>
              <h3>${escapeHtml(title)}</h3>
              ${penname}
            </div>
            <div class="history-result-badges">
              <span>${historyScoreLabel(best.score)}</span>
              <span>${hits.length}イベント</span>
            </div>
          </header>
          <ol>${eventRows}</ol>
        </article>`;
    })
    .join("");
}

function initHistorySearch() {
  const form = document.getElementById("historySearchForm") as HTMLFormElement | null;
  const queryEl = document.getElementById("historySearchQuery") as HTMLInputElement | null;
  const button = document.getElementById("historySearchBtn") as HTMLButtonElement | null;
  const statusEl = document.getElementById("historySearchStatus");
  const resultsEl = document.getElementById("historySearchResults");
  if (!form || !queryEl || !button || !statusEl || !resultsEl) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = queryEl.value.trim();
    if (!query) {
      statusEl.textContent = "検索語を入力してください。";
      resultsEl.innerHTML = "";
      queryEl.focus();
      return;
    }

    button.disabled = true;
    button.textContent = "検索中…";
    statusEl.textContent = "保存済みイベントを検索しています…";
    resultsEl.setAttribute("aria-busy", "true");
    try {
      const response = await invoke<HistorySearchResponse>(
        "search_past_participations",
        {
          projectRoot: projectRootEl.value,
          query,
          limit: 100,
        },
      );
      const suffix = response.truncated
        ? `（上位${response.results.length}件を表示）`
        : "";
      const skipped = response.skippedEvents
        ? `・${response.skippedEvents}イベントを読めずスキップ`
        : "";
      const excluded = response.excludedUpcomingEvents
        ? `・今日以降の${response.excludedUpcomingEvents}イベントを除外`
        : "";
      statusEl.textContent = `「${response.query}」: ${response.totalMatches}件 / ${response.scannedEvents}イベント・${response.scannedCircles}サークルを検索${skipped}${excluded} ${suffix}`;
      renderHistorySearchResults(response);
    } catch (error) {
      statusEl.textContent = `検索できませんでした: ${String(error)}`;
      resultsEl.innerHTML = "";
    } finally {
      button.disabled = false;
      button.textContent = "検索";
      resultsEl.removeAttribute("aria-busy");
    }
  });
}

function currentBridgeJobOptions(timeoutMs = 10_800_000) {
  return {
    pythonExe: pythonExeEl.value,
    projectRoot: projectRootEl.value,
    timeoutMs,
  };
}

/**
 * ユーザー向けジョブのUIアダプタ。
 * 実際のTauri呼び出しはinvokeBridgeJobへ委譲し、この関数は結果表示だけを担当する。
 */
async function runJob(
  job: string,
  payload: Record<string, unknown>,
  withProgress = false,
): Promise<BridgeJobResult<Record<string, unknown>> | null> {
  resultEl.textContent = "";
  let unlisten: (() => void) | null = null;

  if (withProgress) {
    startElapsedTimer();
    // リアルタイムログ受信
    unlisten = await listen<string>("pipeline-log", (event) => {
      const line = event.payload;
      // PROGRESS: N/Total (XX%) を検出して進捗バーに反映
      const progressMatch = line.match(/PROGRESS:\s*(\d+)\/(\d+)\s*\((\d+)%\)/);
      if (progressMatch) {
        lastProgressTime = Date.now();
        const pct = parseInt(progressMatch[3], 10);
        progressEl.value = pct;
        lastProgressCount = `${progressMatch[1]}/${progressMatch[2]}件処理済み (${pct}%)`;
        const elapsed = formatElapsed(Date.now() - progressStartTime);
        progressTextEl.textContent = `${lastProgressCount} ${elapsed} 経過`;
      }
      resultEl.textContent += line + "\n";
      resultEl.scrollTop = resultEl.scrollHeight;
    });
  }

  try {
    const response = await invokeBridgeJob<Record<string, unknown>>(
      job,
      payload,
      {
        ...currentBridgeJobOptions(
          Number(timeoutMsEl.value || "10800000"),
        ),
      },
    );
    if (unlisten) unlisten();
    if (withProgress) finishElapsedTimer(Boolean(response.ok));
    if (withProgress) {
      // リアルタイムログを保持し、エラー情報があれば末尾に追記
      const bridge = response.bridge as Record<string, unknown> | undefined;
      if (!response.ok && bridge?.error) {
        resultEl.textContent += `\n❌ エラー: ${bridge.error}\n`;
      }
      const twitterProcessing = bridge?.twitter_processing as
        | Record<string, unknown>
        | undefined;
      if (twitterProcessing?.status === "failed") {
        resultEl.textContent +=
          `\n❌ X/Twitterクロール失敗\n` +
          `対象: ${twitterProcessing.target_count ?? 0}件 / ` +
          `処理済み: ${twitterProcessing.processed_count ?? 0}件 / ` +
          `未処理・失敗: ${twitterProcessing.failed_count ?? 0}件\n` +
          `不正URL除外: ${twitterProcessing.invalid_url_count ?? 0}件\n` +
          `理由: ${twitterProcessing.reason ?? "不明"}\n`;
      } else if (Number(twitterProcessing?.invalid_url_count ?? 0) > 0) {
        resultEl.textContent +=
          `\n⚠️ 不正なX/Twitter URLを ` +
          `${twitterProcessing?.invalid_url_count ?? 0}件除外しました。\n`;
      }
    } else {
      resultEl.textContent = formatResult(job, response);
    }
    return response;
  } catch (error) {
    if (unlisten) unlisten();
    if (withProgress) finishElapsedTimer(false);
    if (withProgress) {
      resultEl.textContent += `\n❌ エラー: ${String(error)}\n`;
    } else {
      resultEl.textContent = `エラー: ${String(error)}`;
    }
    return null;
  }
}

type EventSaveRequest = {
  ownerSlug: string;
  ownerDir: string;
  eventJsonPath: string;
  data: EventJsonData;
  lifecycleLease: EventLifecycleLease;
};

function normalizeEventPath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function eventJsonPathForDir(eventDir: string): string {
  return `${normalizeEventPath(eventDir)}/event.json`;
}

function assertCurrentSaveOwnership(
  snapshot: Pick<EventSaveRequest, "ownerSlug" | "ownerDir" | "eventJsonPath">,
): void {
  const activeEvent = eventList.find((event) => event.slug === activeEventSlug);
  const expectedPath = activeEvent ? eventJsonPathForDir(activeEvent.dir) : "";
  const editorPath = normalizeEventPath(editorJsonPathValue());
  if (
    !activeEvent ||
    activeEvent.slug !== snapshot.ownerSlug ||
    normalizeEventPath(activeEvent.dir) !== normalizeEventPath(snapshot.ownerDir) ||
    expectedPath !== normalizeEventPath(snapshot.eventJsonPath) ||
    editorPath !== expectedPath
  ) {
    throw new Error(
      `保存対象のイベント所有権が一致しません (slug=${snapshot.ownerSlug}, path=${snapshot.eventJsonPath})`,
    );
  }
}

function isActiveEventDocumentOwned(ownerSlug: string): boolean {
  const ownerEvent = eventList.find((event) => event.slug === ownerSlug);
  return Boolean(
    ownerEvent &&
      activeEventSlug === ownerSlug &&
      eventJsonData &&
      normalizeEventPath(editorJsonPathValue()) ===
        eventJsonPathForDir(ownerEvent.dir),
  );
}

const eventLifecycleGate = new EventLifecycleGate();
// 削除中のownerは、一覧から実体が取り除かれるまで一時的に不可視扱いにする。
// 切替loadのawait中にdeleteが始まった場合も、generationだけでなくowner keyを
// commit時に確認して、遅いloadが削除対象をglobalへ蘇生しないようにする。
const deletingEventKeys = new Set<string>();
const eventMetaWriteCoordinator = new EventWriteCoordinator(eventLifecycleGate);

type NativeEventFingerprint = CoordinatedEventSourceFingerprint & {
  modified_ms?: number;
  modified_ns?: number;
  file_size?: number;
  content_hash?: string;
};

function normalizeNativeEventFingerprint(
  value: NativeEventFingerprint | undefined,
): CoordinatedEventSourceFingerprint | undefined {
  if (!value) return undefined;
  return {
    modifiedMs: value.modifiedMs ?? value.modified_ms,
    modifiedNs: value.modifiedNs ?? value.modified_ns,
    fileSize: value.fileSize ?? value.file_size,
    contentHash: value.contentHash ?? value.content_hash,
  };
}

function circlePatchFromBridge(value: Record<string, any>): CircleIdentityPatch {
  const baseCircle = value.base_circle ?? value.baseCircle;
  return {
    circleIndex: Number(value.circle_index ?? value.circleIndex ?? -1),
    circleIdentity: (value.circle_identity ?? value.circleIdentity ?? {}) as
      CircleIdentityPatch["circleIdentity"],
    baseCircle:
      baseCircle && typeof baseCircle === "object"
        ? cloneJsonSnapshot(baseCircle)
        : undefined,
    changes: cloneJsonSnapshot(value.changes ?? value.circle_patch ?? {}),
  };
}

/**
 * Python jobs are read-only for live event.json.  Their targeted result is
 * merged into a freshly loaded document under the same lifecycle/serial gate
 * as autosave, then committed through Rust's atomic writer.
 */
async function applyBridgeEventPatch(
  ownerSlug: string,
  ownerDir: string,
  bridgePatch: EventPatchResult,
): Promise<{ data: EventJsonData; resolvedCircleIndices: number[] }> {
  const key = eventMetaOwnerKey(ownerSlug, ownerDir);
  const eventJsonPath = eventJsonPathForDir(ownerDir);
  return eventMetaWriteCoordinator.runExclusive(key, async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const bundle = await invoke<{
        data?: EventJsonData;
        modified_ms?: number;
        modified_ns?: number;
        file_size?: number;
        content_hash?: string;
      }>("load_event_bundle", {
        eventJson: eventJsonPath,
        eventDir: ownerDir,
        includeMaps: false,
      });
      if (!bundle?.data || typeof bundle.data !== "object" || Array.isArray(bundle.data)) {
        throw new Error("最新event.jsonを読み込めません");
      }
      const currentFingerprint = normalizeNativeEventFingerprint(bundle);
      const applied = applyEventPatchToLatest(
        bundle.data,
        bridgePatch,
        currentFingerprint,
      );
      try {
        const saved = await invoke<NativeEventFingerprint>(
          "save_event_json_native_checked",
          {
            eventJson: eventJsonPath,
            data: applied.data,
            expectedFingerprint: {
              modified_ms: bundle.modified_ms,
              modified_ns: bundle.modified_ns,
              file_size: bundle.file_size,
              content_hash: bundle.content_hash,
            },
          },
        );
        const savedFingerprint = normalizeNativeEventFingerprint(saved);
        purchaseHistoryIndexService.replace(ownerSlug, applied.data, {
          modifiedMs: savedFingerprint?.modifiedMs,
          fileSize: savedFingerprint?.fileSize,
        });
        if (applied.data.event) {
          eventMetaWriteCoordinator.recordCommitted(key, applied.data.event);
        }
        return {
          data: applied.data,
          resolvedCircleIndices: applied.resolvedCircleIndices,
        };
      } catch (error) {
        if (attempt < 2 && String(error).includes("fingerprint conflict")) {
          continue;
        }
        throw error;
      }
    }
    throw new Error("event.json patch save retry exhausted");
  });
}

const eventSaveQueue = new KeyedRevisionedSaveQueue<EventSaveRequest>(
  async ({ snapshot }) => {
    // executorはactiveEventSlug/tableState/DOMを参照しない。snapshot作成時点で
    // owner/path/dataを固定し、イベント切替後も所有権を混同しない。
    const writeKey = eventMetaOwnerKey(snapshot.ownerSlug, snapshot.ownerDir);
    await eventMetaWriteCoordinator.runExclusiveAccepted(writeKey, async () => {
      const data = cloneJsonSnapshot(snapshot.data);
      const committedMeta = eventMetaWriteCoordinator.committedSnapshot<EventMeta>(
        writeKey,
      );
      if (committedMeta) mergeCommittedEventMetaPreservingUnknown(data, committedMeta);
      const response = await invoke<{
        revision?: number;
        file_size?: number;
        modified_ms?: number;
      }>("save_event_json_native", {
        eventJson: snapshot.eventJsonPath,
        data,
      });
      if (!response) throw new Error("event.jsonの保存に失敗しました");
      if (data.event) eventMetaWriteCoordinator.recordCommitted(writeKey, data.event);
      purchaseHistoryIndexService.replace(snapshot.ownerSlug, data, {
        modifiedMs: response.modified_ms,
        fileSize: response.file_size,
      });
    });
  },
  (snapshot) => snapshot.lifecycleLease.release(),
  (key, snapshot) => {
    // 失敗時にdisposeされたleaseを再利用しない。delete/renameでgateがclosed
    // ならretryを拒否し、古いevent directoryをzombie再作成しない。
    const lease = eventLifecycleGate.acquire(key);
    if (!lease) return null;
    return { ...snapshot, lifecycleLease: lease };
  },
);

/** 保存失敗したイベントだけを再試行する。別イベントの表示/loadは止めない。 */
async function retryEventSave(slug: string, dir: string): Promise<boolean> {
  const owner = eventList.find(
    (event) => event.slug === slug && normalizeEventPath(event.dir) === normalizeEventPath(dir),
  );
  if (!owner) return false;
  const receipt = eventSaveQueue.retryKey(eventMetaOwnerKey(slug, dir));
  if (!receipt) return false;
  try {
    await receipt.completed;
    return true;
  } catch (error) {
    logToFile(`event.json再試行失敗 (${slug}): ${String(error)}`);
    return false;
  }
}

async function flushAllEventSavesOrThrow(): Promise<void> {
  await eventSaveQueue.flushAll();
  const failed = eventList
    .map((event) => ({
      event,
      status: eventSaveQueue.getStatus(eventMetaOwnerKey(event.slug, event.dir)),
    }))
    .find(({ status }) => status.error);
  if (failed) {
    throw new Error(`イベント「${failed.event.slug}」の保存に失敗しています: ${String(failed.status.error)}`);
  }
}

function createDesktopEventUid(): string {
  const cryptoApi = globalThis.crypto as Crypto & { randomUUID?: () => string };
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID().replace(/-/g, "").toLowerCase();
  }
  if (typeof cryptoApi?.getRandomValues !== "function") {
    throw new Error("event UID生成に必要な暗号学的乱数APIを利用できません");
  }
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  // UUID v4のvariant/version bitを設定し、manifest互換の32桁hexにする。
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

/**
 * Python full-sync generatorをread-onlyに保つため、全ownerのUIDを先にnative
 * atomic saveする。呼出元はrunManagedEventDocumentMutation内なのでUI edit/
 * autosave/rename/deleteは停止し、各eventのlifecycle leaseも保存完了まで保持する。
 */
async function preflightFullSyncEventUids(): Promise<void> {
  const owners = eventList.map((event) => ({
    slug: event.slug,
    dir: normalizeEventPath(event.dir),
  }));
  for (const owner of owners) {
    const key = eventMetaOwnerKey(owner.slug, owner.dir);
    const lifecycleLease = eventLifecycleGate.acquire(key);
    if (!lifecycleLease) {
      throw new Error(`イベント「${owner.slug}」は削除・名前変更処理中です`);
    }
    try {
      await eventMetaWriteCoordinator.runExclusiveAccepted(key, async () => {
        const eventJsonPath = eventJsonPathForDir(owner.dir);
        const bundle = await invoke<{
          data?: EventJsonData;
          modified_ms?: number;
          file_size?: number;
        }>("load_event_bundle", {
          eventJson: eventJsonPath,
          eventDir: owner.dir,
          includeMaps: false,
        });
        if (!bundle?.data || typeof bundle.data !== "object" || Array.isArray(bundle.data)) {
          throw new Error(`イベント「${owner.slug}」のevent.jsonを読み込めません`);
        }
        const prepared = prepareFullSyncEventDocument(
          bundle.data,
          createDesktopEventUid,
        );
        if (!prepared.changed) return;

        // load後の外部書換えを古いsnapshotで上書きしない。Web UI editはinertだが、
        // 別プロセスによる変更もmetadata fingerprintが変わった場合はfail closed。
        const beforeSave = await invoke<{
          modified_ms?: number;
          file_size?: number;
        }>("event_file_fingerprint", { eventJson: eventJsonPath });
        if (
          beforeSave?.modified_ms !== bundle.modified_ms ||
          beforeSave?.file_size !== bundle.file_size
        ) {
          throw new Error(`イベント「${owner.slug}」が同期preflight中に変更されました`);
        }

        const saved = await invoke<{
          modified_ms?: number;
          file_size?: number;
        }>("save_event_json_native", {
          eventJson: eventJsonPath,
          data: prepared.data,
        });
        const fingerprint: EventSourceFingerprint = {
          modifiedMs: saved?.modified_ms,
          fileSize: saved?.file_size,
        };
        purchaseHistoryIndexService.replace(owner.slug, prepared.data, fingerprint);

        if (
          activeEventSlug === owner.slug &&
          normalizeEventPath(editorJsonPathValue()) === eventJsonPath
        ) {
          // UIDだけを追加したnative saveとopen sessionの双方を同じsnapshotへ揃える。
          // これにより同期後の編集/saveがUIDなしの古いglobalから上書きしない。
          eventJsonData = recordDeepClone(prepared.data);
          persistedEventJsonData = recordDeepClone(prepared.data);
          if (committedEventSession?.slug === owner.slug) {
            committedEventSession = reconcileSessionEventDocument(
              committedEventSession,
              prepared.data,
              fingerprint,
            );
          }
          markEventDocumentMutated();
        }
      });
    } finally {
      lifecycleLease.release();
    }
  }
}

function showEventSaveRetry(ownerSlug: string, ownerDir: string, error: unknown): void {
  const host = document.getElementById("result") || resultEl;
  if (!host) return;
  host.textContent = `イベント「${ownerSlug}」の保存に失敗しました: ${String(error)}`;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn-secondary ml-2";
  button.textContent = "再試行";
  button.addEventListener("click", async () => {
    button.disabled = true;
    const ok = await retryEventSave(ownerSlug, ownerDir);
    if (ok) host.textContent = `イベント「${ownerSlug}」を保存しました`;
    else button.disabled = false;
  });
  host.appendChild(button);
}

type SaveNowResult =
  | { ok: true; revision: number | null }
  | { ok: false; revision: number | null; error: unknown };

const INTERNAL_OPERATION_SAVE = Symbol("internal-operation-save");
type InternalOperationSavePermit = typeof INTERNAL_OPERATION_SAVE;

function editorJsonPathValue(): string {
  return (
    document.getElementById("editorJsonPath") as HTMLInputElement | null
  )?.value.trim() || "";
}

async function saveNow(
  permit?: InternalOperationSavePermit,
): Promise<SaveNowResult> {
  if (isOperationBusy(operationState) && permit !== INTERNAL_OPERATION_SAVE) {
    return {
      ok: false,
      revision: null,
      error: new Error("イベント処理中はevent.jsonを保存できません"),
    };
  }
  if (renameInProgress && permit !== INTERNAL_OPERATION_SAVE) {
    return {
      ok: false,
      revision: null,
      error: new Error("イベント名変更中は保存できません"),
    };
  }
  if (!eventJsonData) return { ok: true, revision: null };
  const ownerSlug = activeEventSlug;
  const ownerEvent = ownerSlug
    ? eventList.find((event) => event.slug === ownerSlug)
    : null;
  if (!ownerSlug || !ownerEvent) {
    return {
      ok: false,
      revision: null,
      error: new Error("保存対象のアクティブイベントが見つかりません"),
    };
  }
  const ownerDir = normalizeEventPath(ownerEvent.dir);
  const eventJsonPath = eventJsonPathForDir(ownerDir);
  if (normalizeEventPath(editorJsonPathValue()) !== eventJsonPath) {
    return {
      ok: false,
      revision: null,
      error: new Error(
        `保存先がアクティブイベントと一致しません (slug=${ownerSlug})`,
      ),
    };
  }
  const lifecycleLease = eventLifecycleGate.acquire(
    eventMetaOwnerKey(ownerSlug, ownerDir),
  );
  if (!lifecycleLease) {
    return {
      ok: false,
      revision: null,
      error: new Error("保存対象のイベントは削除処理中または削除済みです"),
    };
  }

  let syncedEventJsonData: EventJsonData;
  let receipt: SaveReceipt;
  const saveKey = eventMetaOwnerKey(ownerSlug, ownerDir);
  try {
    // 二重管理の境界で、baselineから明示的に変わったセルだけを反映する。
    const tableSnapshot = cloneJsonSnapshot(tableState);
    syncedEventJsonData = buildEventJsonSnapshot(
      eventJsonData,
      tableSnapshot,
      eventTableBaseline,
    );
    eventJsonData = syncedEventJsonData;
    // 後続のsaveNowは、この呼び出し後に発生したUI差分だけをsnapshot化する。
    // 保存中の編集→取り消しも旧baselineに吸収されず、revert payloadとして残る。
    eventTableBaseline = tableSnapshot;
    markEventDocumentMutated();
    // 予算パネルも更新
    updateBudgetPanel();
    // 選択・beforeunload等から呼ばれても、未編集ならディスクへ書かない。
    const queueStatus = eventSaveQueue.getStatus(saveKey);
    if (
      eventJsonDocumentsEqual(syncedEventJsonData, persistedEventJsonData) &&
      !queueStatus.running &&
      !queueStatus.pending &&
      !queueStatus.error
    ) {
      lifecycleLease.release();
      return { ok: true, revision: null };
    }
    // キュー中のpayloadが後続編集で書き換わらないように、もう一度固定する。
    receipt = eventSaveQueue.enqueue(saveKey, {
      ownerSlug,
      ownerDir,
      eventJsonPath,
      data: recordDeepClone(syncedEventJsonData),
      lifecycleLease,
    });
  } catch (error) {
    lifecycleLease.release();
    return { ok: false, revision: null, error };
  }
  try {
    await receipt.completed;
    assertCurrentSaveOwnership({
      ownerSlug,
      ownerDir,
      eventJsonPath,
    });
    const persistedSnapshot = cloneJsonSnapshot(syncedEventJsonData);
    const committedMeta = eventMetaWriteCoordinator.committedSnapshot<EventMeta>(
      eventMetaOwnerKey(ownerSlug, ownerDir),
    );
    if (committedMeta) persistedSnapshot.event = committedMeta;
    persistedEventJsonData = persistedSnapshot;
    return { ok: true, revision: receipt.revision };
  } catch (error) {
    const msg = `event.json保存エラー: ${String(error)}`;
    logToFile(msg);
    return { ok: false, revision: receipt.revision, error };
  }
}

function isImageCol(h: string): boolean {
  return IMAGE_HEADER_CANDIDATES.some((c) =>
    h.toLowerCase().includes(c.toLowerCase()),
  );
}

function isUrlValue(v: string): boolean {
  return v.startsWith("http://") || v.startsWith("https://");
}

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "bmp"];

type ImageModalNavTarget = {
  src: string;
};

type ImageModalOptions = {
  onNavigate?: (direction: -1 | 1) => ImageModalNavTarget | null;
};

function isUsableImageValue(value: string): boolean {
  const trimmed = value.trim();
  return Boolean(
    trimmed &&
      trimmed !== "0.0" &&
      trimmed !== "0" &&
      !/^\d+(\.\d+)?$/.test(trimmed),
  );
}

function firstImagePathFromValue(value: string): string | null {
  return (
    value
      .split("\n")
      .map((part) => part.trim())
      .find((part) => isUsableImageValue(part)) ?? null
  );
}

function renderImageCellContents(value: string): string {
  const imagePath = firstImagePathFromValue(value);
  if (!imagePath) {
    return `<span class="img-placeholder">クリックで選択</span>`;
  }
  const src = resolveImageSrc(imagePath);
  return `<img src="${escapeHtml(src)}" alt="" class="img-block" data-fallback="outerhtml" data-fallback-html="<span class='text-red-500 text-xs cursor-pointer'>読み込み失敗<br>クリックで選択</span>" />`;
}

function updateImageCellContents(row: number, col: string) {
  const cells = Array.from(
    circleEditorEl.querySelectorAll<HTMLTableCellElement>(
      `.img-cell[data-row="${row}"]`,
    ),
  );
  const cell = cells.find((candidate) => candidate.dataset.col === col);
  if (!cell) return;
  cell.innerHTML = renderImageCellContents(String(tableState.rows[row]?.[col] ?? ""));
}

function getCircleCatalogImagePath(circleIdx: number): string | null {
  const rowPath = firstImagePathFromValue(
    String(tableState.rows[circleIdx]?.["アイテム画像"] ?? ""),
  );
  if (rowPath) return rowPath;
  const image = eventJsonData?.circles?.[circleIdx]?.item_images?.[0];
  if (image?.path && isUsableImageValue(String(image.path))) {
    return String(image.path);
  }
  return catalogImagePathsForCircle(eventJsonData?.circles?.[circleIdx])?.[0] ?? null;
}

function visibleCircleIndices(): number[] {
  return Array.from(
    circleEditorEl.querySelectorAll<HTMLTableRowElement>(
      "tr.circle-row[data-circle-row]",
    ),
  )
    .map((row) => Number(row.dataset.circleRow))
    .filter((idx) => Number.isFinite(idx));
}

function findAdjacentCatalogCircle(
  currentCircleIdx: number,
  direction: -1 | 1,
): { circleIdx: number; src: string } | null {
  const visibleIndices = visibleCircleIndices();
  const indices =
    visibleIndices.length > 0
      ? visibleIndices
      : tableState.rows.map((_, idx) => idx);
  const currentPosition = indices.indexOf(currentCircleIdx);
  if (currentPosition < 0) return null;

  for (
    let pos = currentPosition + direction;
    pos >= 0 && pos < indices.length;
    pos += direction
  ) {
    const circleIdx = indices[pos];
    const path = getCircleCatalogImagePath(circleIdx);
    if (path) return { circleIdx, src: resolveImageSrc(path) };
  }
  return null;
}

function showCatalogImageModal(circleIdx: number) {
  const path = getCircleCatalogImagePath(circleIdx);
  if (!path) return;
  let currentCircleIdx = circleIdx;
  showImageModal(resolveImageSrc(path), {
    onNavigate: (direction) => {
      const next = findAdjacentCatalogCircle(currentCircleIdx, direction);
      if (!next) return null;
      currentCircleIdx = next.circleIdx;
      return { src: next.src };
    },
  });
}

// 画像拡大モーダル
function showImageModal(src: string, options: ImageModalOptions = {}) {
  const overlay = document.createElement("div");
  overlay.className = "img-modal-overlay";
  const img = document.createElement("img");
  img.src = src;
  let zoomed = false;
  let pointerStartX: number | null = null;
  let pointerStartY: number | null = null;
  let suppressNextClick = false;
  overlay.appendChild(img);

  function resetZoom() {
    zoomed = false;
    img.style.maxWidth = "90vw";
    img.style.maxHeight = "90vh";
    img.style.width = "";
    img.style.height = "";
    img.style.cursor = "zoom-in";
    overlay.style.overflow = "hidden";
    overlay.style.cursor = "zoom-out";
    overlay.style.alignItems = "center";
  }

  function closeModal() {
    overlay.remove();
    document.removeEventListener("keydown", handleKeyDown);
  }

  function navigate(direction: -1 | 1): boolean {
    const next = options.onNavigate?.(direction);
    if (!next) return false;
    img.src = next.src;
    resetZoom();
    return true;
  }

  // 画像クリック: 拡大/縮小トグル
  img.addEventListener("click", (e) => {
    e.stopPropagation();
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    zoomed = !zoomed;
    if (zoomed) {
      img.style.maxWidth = "none";
      img.style.maxHeight = "none";
      img.style.width = "auto";
      img.style.height = "auto";
      img.style.cursor = "zoom-out";
      overlay.style.overflow = "auto";
      overlay.style.cursor = "default";
      overlay.style.alignItems = "flex-start";
    } else {
      img.style.maxWidth = "90vw";
      img.style.maxHeight = "90vh";
      img.style.width = "";
      img.style.height = "";
      img.style.cursor = "zoom-in";
      overlay.style.overflow = "hidden";
      overlay.style.cursor = "zoom-out";
      overlay.style.alignItems = "center";
    }
  });
  img.style.cursor = "zoom-in";

  overlay.addEventListener("pointerdown", (e) => {
    pointerStartX = e.clientX;
    pointerStartY = e.clientY;
  });
  overlay.addEventListener("pointerup", (e) => {
    if (pointerStartX == null || pointerStartY == null || zoomed) {
      pointerStartX = null;
      pointerStartY = null;
      return;
    }
    const dx = e.clientX - pointerStartX;
    const dy = e.clientY - pointerStartY;
    pointerStartX = null;
    pointerStartY = null;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
    suppressNextClick = true;
    navigate(dx < 0 ? 1 : -1);
  });

  // オーバーレイクリック（画像以外）: 閉じる
  overlay.addEventListener("click", (e) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    if (e.target === overlay) closeModal();
  });
  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      closeModal();
    } else if (e.key === "ArrowLeft" && options.onNavigate) {
      if (navigate(-1)) e.preventDefault();
    } else if (e.key === "ArrowRight" && options.onNavigate) {
      if (navigate(1)) e.preventDefault();
    }
  }
  document.addEventListener("keydown", handleKeyDown);
  document.body.appendChild(overlay);
}

// ファイル選択して画像セルに適用
async function pickAndSetImage(
  cell: HTMLTableCellElement,
  row: number,
  col: string,
) {
  const guard = captureEventAsyncMutationGuard(row);
  if (!guard) return;
  const activeEv = activeEventSlug
    ? eventList.find((e) => e.slug === activeEventSlug)
    : null;
  const subdir = imageColumnAssetSubdir(col);
  const destDir = activeEv?.dir ? eventAssetDir(activeEv.dir, subdir) : "";
  const selected = await dialogOpen({
    multiple: false,
    filters: [{ name: "画像ファイル", extensions: IMAGE_EXTENSIONS }],
  });
  if (!guard.isCurrent()) return;
  if (selected && typeof selected === "string") {
    const fileName = selected.replace(/\\/g, "/").split("/").pop() || selected;
    const relativeFileName = eventRelativeAssetPath(subdir, fileName);
    try {
      await invokeActiveEventAssetWrite("copy_file_to_dir", { sourcePath: selected, destDir });
    } catch (error) {
      resultEl.textContent = `画像コピー失敗: ${String(error)}`;
      return;
    }
    if (!guard.isCurrent()) return;
    applyImageToCell(cell, row, col, relativeFileName);
  }
}

// 画像Undo: 1段階バッファ
let imageUndoBuffer: {
  row: number;
  col: string;
  oldFileName: string;
  cell: HTMLTableCellElement;
} | null = null;

// 画像セルに画像を反映（古い画像をUndoバッファに退避）
function applyImageToCell(
  cell: HTMLTableCellElement,
  row: number,
  col: string,
  fileName: string,
) {
  const oldVal = String(tableState.rows[row][col] ?? "").trim();
  const oldImagePath = firstImagePathFromValue(oldVal);
  const isOldImage = Boolean(oldImagePath);

  // Undoバッファに退避（前のバッファは参照だけ破棄し、assetは孤児として保持）
  if (imageUndoBuffer) {
    imageUndoBuffer = null;
  }

  // 古い画像をUndoバッファに退避（削除しない）
  if (isOldImage) {
    imageUndoBuffer = { row, col, oldFileName: oldImagePath || "", cell };
  }
  tableState.rows[row][col] = fileName;
  saveNow();
  cell.innerHTML = renderImageCellContents(fileName);

  // サークル画像列に設定した場合、デフォルトカットに自動登録（未登録のサークルのみ）
  if (col === "サークル画像" && fileName) {
    const circleName = String(tableState.rows[row]["サークル名"] ?? "").trim();
    const penname = eventJsonData?.circles?.[row]?.penname || "";
    if (circleName) {
      const activeEv = activeEventSlug
        ? eventList.find((e) => e.slug === activeEventSlug)
        : null;
      const imgDir = activeEv?.dir ?? "";
      const fullPath = resolveEventAssetFilePath(imgDir, fileName);
      const genre =
        String(tableState.rows[row]["ジャンル"] ?? "").trim() || undefined;
      void circleMasterWriteSerial
        .run(CIRCLE_MASTER_WRITE_KEY, () =>
          invoke("register_default_cut", {
            projectRoot: projectRootEl.value,
            circleName,
            penname,
            imageSourcePath: fullPath,
            genre: genre || null,
          }),
        )
        .catch((error) => {
          logToFile(`default cut登録エラー: ${String(error)}`);
        });
    }
  }
}

// 右クリックメニュー
function showImageContextMenu(
  x: number,
  y: number,
  cell: HTMLTableCellElement,
  row: number,
  col: string,
  hasImage: boolean,
) {
  document.querySelectorAll(".ctx-menu").forEach((m) => m.remove());
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  if (hasImage) {
    const viewItem = document.createElement("div");
    viewItem.className = "ctx-menu-item";
    viewItem.textContent = "拡大表示";
    viewItem.addEventListener("click", () => {
      menu.remove();
      if (col === "アイテム画像") {
        showCatalogImageModal(row);
      } else {
        const src = resolveImageSrc(String(tableState.rows[row][col] ?? ""));
        showImageModal(src);
      }
    });
    menu.appendChild(viewItem);
  }

  const replaceItem = document.createElement("div");
  replaceItem.className = "ctx-menu-item";
  replaceItem.textContent = "画像を差し替え";
  replaceItem.addEventListener("click", () => {
    menu.remove();
    pickAndSetImage(cell, row, col);
  });
  menu.appendChild(replaceItem);

  if (hasImage) {
    const deleteItem = document.createElement("div");
    deleteItem.className = "ctx-menu-item danger";
    deleteItem.textContent = "画像参照を削除（ファイルは保持）";
    deleteItem.addEventListener("click", async () => {
      menu.remove();
      const currentVal = String(tableState.rows[row][col] ?? "").trim();
      const ownerSlug = activeEventSlug;
      if (!ownerSlug || !eventJsonData) return;
      const tableBefore = cloneJsonSnapshot(tableState);
      const documentBefore = cloneJsonSnapshot(eventJsonData);
      const baselineBefore = cloneJsonSnapshot(eventTableBaseline);
      let deletionRevision = eventDocumentStateRevision;
      let expectedTable: TableState | null = null;
      let expectedDocument: EventJsonData | null = null;
      let expectedBaseline: TableState | null = null;
      try {
        await runImageDeletionTransaction({
          removedReferences: imageColumnAssetReferences(currentVal),
          applyClear: () => {
            tableState.rows[row][col] = "";
            cell.innerHTML = renderImageCellContents("");
          },
          save: async () => {
            // async関数は最初のawaitまで同期実行されるため、saveNowが作った
            // optimistic snapshotとrevisionを直後にCAS対象として固定できる。
            const pending = saveNow();
            deletionRevision = eventDocumentStateRevision;
            expectedTable = cloneJsonSnapshot(tableState);
            expectedDocument = eventJsonData
              ? cloneJsonSnapshot(eventJsonData)
              : null;
            expectedBaseline = cloneJsonSnapshot(eventTableBaseline);
            return (await pending).ok;
          },
          rollbackIfCurrent: () => {
            // 切替・新しい編集・後続saveがあれば古いsnapshotで上書きしない。
            if (
              activeEventSlug !== ownerSlug ||
              eventDocumentStateRevision !== deletionRevision ||
              JSON.stringify(tableState) !== JSON.stringify(expectedTable) ||
              !eventJsonDocumentsEqual(eventJsonData, expectedDocument) ||
              JSON.stringify(eventTableBaseline) !==
                JSON.stringify(expectedBaseline)
            ) {
              return false;
            }
            tableState = tableBefore;
            eventJsonData = documentBefore;
            eventTableBaseline = baselineBefore;
            eventDocumentStateRevision += 1;
            cell.innerHTML = renderImageCellContents(currentVal);
            updateBudgetPanel();
            return true;
          },
          currentDocument: () =>
            activeEventSlug === ownerSlug ? eventJsonData : null,
          // UIによる参照削除ではassetを自動削除しない。共有・Undo・回復のため
          // 孤児ファイルとしてイベント配下に保持する。
          deleteAsset: async () => {},
        });
      } catch (error) {
        logToFile(`画像参照削除エラー: ${String(error)}`);
      }
    });
    menu.appendChild(deleteItem);
  }

  document.body.appendChild(menu);
  const close = () => {
    menu.remove();
    document.removeEventListener("click", close);
  };
  setTimeout(() => document.addEventListener("click", close), 0);
}

// URLから画像ファイル名を生成
function fileNameFromUrl(url: string): string {
  try {
    const base = new URL(url).pathname.split("/").pop() || "";
    const ext = base.split(".").pop()?.toLowerCase() || "";
    if (IMAGE_EXTENSIONS.includes(ext)) return base;
  } catch {}
  return `drop_${Date.now()}.jpg`;
}

function renderItemImageCellContent(fileName: string): string {
  const src = fileName ? resolveImageSrc(fileName) : "";
  return src
    ? `<img src="${escapeHtml(src)}" alt="" class="thumb-sm" data-fallback="outerhtml" data-fallback-html="<span class='img-placeholder-sm'>Select</span>" />`
    : `<span class="img-placeholder-sm">Select</span>`;
}

function applyImageToItemCell(
  cell: HTMLTableCellElement,
  circleIdx: number,
  itemIdx: number,
  fileName: string,
) {
  if (!eventJsonData) return;
  const circle = eventJsonData.circles?.[circleIdx];
  if (!circle?.items?.[itemIdx]) return;
  circle.items[itemIdx].image = fileName;
  saveNow();
  cell.innerHTML = renderItemImageCellContent(fileName);
}

function imageUrlFromDataTransfer(dt: DataTransfer): string {
  const htmlData = dt.getData("text/html");
  const urlData = dt.getData("text/uri-list") || dt.getData("text/plain") || "";
  let imageUrl = "";
  if (htmlData) {
    const match = htmlData.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (match) imageUrl = match[1];
  }
  if (!imageUrl && urlData.startsWith("http")) {
    imageUrl = urlData.split("\n")[0].trim();
  }
  return imageUrl;
}

function isInternalAppImageUrl(url: string): boolean {
  return url.includes("asset.localhost") || url.startsWith("asset://localhost");
}

document.addEventListener("dragstart", (e) => {
  const target = e.target as HTMLElement | null;
  if (target?.closest("img")) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

async function applyDroppedImageToItemCell(
  cell: HTMLTableCellElement,
  dt: DataTransfer,
) {
  const circleIdx = Number(cell.dataset.circle);
  const itemIdx = Number(cell.dataset.item);
  const guard = captureEventAsyncMutationGuard(circleIdx, itemIdx);
  if (!guard) return;
  const activeDir = getActiveEventDir();
  const destDir = activeDir ? eventAssetDir(activeDir, "items") : "";

  if (dt.files && dt.files.length > 0) {
    const file = dt.files[0];
    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    if (!IMAGE_EXTENSIONS.includes(ext)) return;
    const buf = await file.arrayBuffer();
    if (!guard.isCurrent()) return;
    const bytes = Array.from(new Uint8Array(buf));
    const uniqueFileName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${file.name}`;
    try {
      await invokeActiveEventAssetWrite("save_image_bytes", {
        destDir,
        fileName: uniqueFileName,
        bytes,
      });
    } catch (error) {
      resultEl.textContent = `画像保存失敗: ${String(error)}`;
      return;
    }
    if (!guard.isCurrent()) return;
    applyImageToItemCell(
      cell,
      circleIdx,
      itemIdx,
      eventRelativeAssetPath("items", uniqueFileName),
    );
    return;
  }

  const imageUrl = imageUrlFromDataTransfer(dt);
  if (!imageUrl) return;
  if (isInternalAppImageUrl(imageUrl)) return;

  const rawFileName = fileNameFromUrl(imageUrl);
  const fileName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${rawFileName}`;
  try {
    await invokeActiveEventAssetWrite("download_image", { url: imageUrl, destDir, fileName });
  } catch (err) {
    const msg = `アイテム画像のダウンロード失敗: ${String(err)} (URL: ${imageUrl})`;
    resultEl.textContent = msg;
    logToFile(msg);
    return;
  }
  if (!guard.isCurrent()) return;
  applyImageToItemCell(
    cell,
    circleIdx,
    itemIdx,
    eventRelativeAssetPath("items", fileName),
  );
}

function dataTransferHasImage(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  if (dt.files && dt.files.length > 0) {
    const ext = dt.files[0].name.split(".").pop()?.toLowerCase() || "";
    return IMAGE_EXTENSIONS.includes(ext);
  }
  const imageUrl = imageUrlFromDataTransfer(dt);
  if (imageUrl) return !isInternalAppImageUrl(imageUrl);
  const types = Array.from(dt.types || []);
  return (
    types.includes("Files") ||
    types.includes("text/html") ||
    types.includes("text/uri-list") ||
    types.includes("text/plain")
  );
}

function catalogDropFileName(rawName: string): string {
  const ext = imageExtFromName(rawName);
  const base =
    rawName
      .replace(/\\/g, "/")
      .split("/")
      .pop()
      ?.replace(/\.[^.]+$/, "")
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "image";
  return `catalog_drop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${base}.${ext}`;
}

async function saveCatalogImageFromPath(
  sourcePath: string,
  activeDir: string,
  guard: AsyncMutationGuard,
) {
  const destDir = activeDir ? eventAssetDir(activeDir, "items") : "";
  if (!destDir) throw new Error("アクティブなイベントが選択されていません");
  const fileName = catalogDropFileName(sourcePath);
  await invokeActiveEventAssetWrite("copy_file_as", { sourcePath, destDir, fileName });
  if (!guard.isCurrent()) return null;
  const relativeFileName = eventRelativeAssetPath("items", fileName);
  return {
    fileName: relativeFileName,
    filePath: `${normalizeFsPath(activeDir || "")}/${relativeFileName}`,
  };
}

async function saveCatalogImageFromDataTransfer(
  dt: DataTransfer,
  activeDir: string,
  guard: AsyncMutationGuard,
) {
  const destDir = activeDir ? eventAssetDir(activeDir, "items") : "";
  if (!destDir) throw new Error("アクティブなイベントが選択されていません");

  if (dt.files && dt.files.length > 0) {
    const file = dt.files[0];
    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    if (!IMAGE_EXTENSIONS.includes(ext)) return null;
    const fileName = catalogDropFileName(file.name);
    const buf = await file.arrayBuffer();
    if (!guard.isCurrent()) return null;
    const bytes = Array.from(new Uint8Array(buf));
    await invokeActiveEventAssetWrite("save_image_bytes", { destDir, fileName, bytes });
    if (!guard.isCurrent()) return null;
    const relativeFileName = eventRelativeAssetPath("items", fileName);
    return {
      fileName: relativeFileName,
      filePath: `${normalizeFsPath(activeDir || "")}/${relativeFileName}`,
    };
  }

  const imageUrl = imageUrlFromDataTransfer(dt);
  if (!imageUrl) return null;
  if (isInternalAppImageUrl(imageUrl)) return null;

  const fileName = catalogDropFileName(fileNameFromUrl(imageUrl));
  await invokeActiveEventAssetWrite("download_image", { url: imageUrl, destDir, fileName });
  if (!guard.isCurrent()) return null;
  const relativeFileName = eventRelativeAssetPath("items", fileName);
  return {
    fileName: relativeFileName,
    filePath: `${normalizeFsPath(activeDir || "")}/${relativeFileName}`,
  };
}

// フィルター状態
const circleGenreFilter = document.getElementById(
  "circleGenreFilter",
) as HTMLSelectElement;
const circleColorFilter = document.getElementById(
  "circleColorFilter",
) as HTMLDivElement;
const circleCheckFilter = document.getElementById(
  "circleCheckFilter",
) as HTMLDivElement;
const circleCatalogFilter = document.getElementById(
  "circleCatalogFilter",
) as HTMLSelectElement;
const globalCircleSearchInput = document.getElementById(
  "globalCircleSearch",
) as HTMLInputElement;
const globalSearchEnabledInput = document.getElementById(
  "globalSearchEnabled",
) as HTMLInputElement;
const circleFilterCount = document.getElementById(
  "circleFilterCount",
) as HTMLSpanElement;

const circleColorFilterValues = new Set<string>();
const circleCheckFilterValues = new Set<string>();

const CIRCLE_CHECK_FILTER_OPTIONS: PurchaseStatusValue[] = [
  PURCHASE_STATUS.NOT_YET,
  PURCHASE_STATUS.BOUGHT,
  PURCHASE_STATUS.COULDNT_BUY,
  PURCHASE_STATUS.SKIPPED,
];

const TWITTER_STATUS_URL_RE =
  /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^/\s]+\/status(?:es)?\/\d+/i;
const TWITTER_STATUS_URL_GLOBAL_RE =
  /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^/\s]+\/status(?:es)?\/\d+/gi;

function removeTwitterStatusUrlsFromMemo(text: string): string {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.replace(TWITTER_STATUS_URL_GLOBAL_RE, "").trim())
    .filter(Boolean)
    .join("\n");
}

function circleHasCatalogPost(circle: any, row?: Record<string, string>): boolean {
  if (!circle) return false;
  if (circle.catalog_status === "needs_recheck") return false;
  const status = String(circle.catalog_status || "").trim();
  if (status) return true;
  if (circle.existing_only_status) return true;
  if (Array.isArray(circle.item_images) && circle.item_images.length > 0) {
    return true;
  }
  if (Array.isArray(circle.items) && circle.items.length > 0) {
    return true;
  }
  const memoText = [circle.memo, row?.["アイテムメモ"]].filter(Boolean).join("\n");
  return TWITTER_STATUS_URL_RE.test(memoText);
}

function toggleFilterValue(values: Set<string>, value: string) {
  if (!value) return;
  if (values.has(value)) {
    values.delete(value);
  } else {
    values.add(value);
  }
}

function isExcludeSkippedFilterActive(): boolean {
  return (
    circleCheckFilterValues.size === 3 &&
    circleCheckFilterValues.has(String(PURCHASE_STATUS.NOT_YET)) &&
    circleCheckFilterValues.has(String(PURCHASE_STATUS.BOUGHT)) &&
    circleCheckFilterValues.has(String(PURCHASE_STATUS.COULDNT_BUY)) &&
    !circleCheckFilterValues.has(String(PURCHASE_STATUS.SKIPPED))
  );
}

function renderCircleColorFilterOptions() {
  circleColorFilter.innerHTML =
    `<span class="circle-filter-label">色</span>` +
    [...COLOR_OPTIONS]
      .reverse()
      .map((opt) => {
        const selected = circleColorFilterValues.has(opt.value);
        return `
          <button
            type="button"
            class="circle-filter-chip priority-filter-chip${selected ? " active" : ""}"
            data-filter-value="${escapeHtml(opt.value)}"
            aria-pressed="${selected ? "true" : "false"}"
            style="border-color:${escapeHtml(opt.color)};color:${escapeHtml(opt.color)};${selected ? `background:${escapeHtml(opt.bgColor)};` : ""}"
          >
            <span class="circle-filter-dot" style="background:${escapeHtml(opt.color)};"></span>
            ${escapeHtml(opt.label)}
          </button>
        `;
      })
      .join("");
}

function renderCircleCheckFilterOptions() {
  const excludeSkippedActive = isExcludeSkippedFilterActive();
  circleCheckFilter.innerHTML =
    `<span class="circle-filter-label">状態</span>
      <button
        type="button"
        class="circle-filter-chip${excludeSkippedActive ? " active" : ""}"
        data-check-shortcut="exclude-skipped"
        aria-pressed="${excludeSkippedActive ? "true" : "false"}"
      >見送り以外</button>` +
    CIRCLE_CHECK_FILTER_OPTIONS.map((status) => {
      const view = PURCHASE_STATUS_VIEWS[status];
      const value = String(status);
      const selected = circleCheckFilterValues.has(value);
      return `
        <button
          type="button"
          class="circle-filter-chip${selected ? " active" : ""}"
          data-filter-value="${escapeHtml(value)}"
          aria-pressed="${selected ? "true" : "false"}"
          style="border-color:${escapeHtml(view.color)};color:${escapeHtml(view.color)};${selected && view.bg ? `background:${escapeHtml(view.bg)};` : ""}"
        >${escapeHtml(view.label)}</button>
      `;
    }).join("");
}

function updatePriorityColorSettingsUI() {
  const host = document.getElementById("priorityColorSettings");
  if (!host) return;
  host.innerHTML = `
    <details>
      <summary>優先度カラー設定</summary>
      <div class="priority-color-settings-body">
        ${COLOR_OPTIONS.map((opt) => `
          <label class="priority-color-setting-row">
            <span class="priority-color-setting-swatch" style="background:${opt.color};"></span>
            <span class="priority-color-setting-label">${escapeHtml(opt.label)}</span>
            <input data-priority-color="${escapeHtml(opt.value)}" value="${escapeHtml(opt.color)}" />
          </label>
        `).join("")}
        <button type="button" id="priorityColorResetBtn" class="priority-color-reset-btn">初期値に戻す</button>
      </div>
    </details>
  `;
  host.querySelectorAll<HTMLInputElement>("input[data-priority-color]").forEach((input) => {
    const save = () => {
      const value = input.dataset.priorityColor || "";
      const normalized = normalizeHexColor(input.value);
      const opt = COLOR_OPTIONS.find((o) => o.value === value);
      if (!opt || !normalized) {
        input.classList.add("invalid");
        return;
      }
      input.classList.remove("invalid");
      opt.color = normalized;
      opt.bgColor = priorityBgFromColor(normalized);
      savePriorityColorOptions();
      renderCircleColorFilterOptions();
      updatePriorityColorSettingsUI();
      renderCircleEditorAndMap();
    };
    input.addEventListener("change", save);
    input.addEventListener("blur", save);
  });
  document.getElementById("priorityColorResetBtn")?.addEventListener("click", () => {
    COLOR_OPTIONS = DEFAULT_COLOR_OPTIONS.map((o) => ({ ...o }));
    savePriorityColorOptions();
    renderCircleColorFilterOptions();
    updatePriorityColorSettingsUI();
    renderCircleEditorAndMap();
  });
}

function initPriorityColorSettings() {
  renderCircleColorFilterOptions();
  updatePriorityColorSettingsUI();
}

function initCircleFilters() {
  const handler = () => renderCircleEditor();
  renderCircleColorFilterOptions();
  renderCircleCheckFilterOptions();
  updateGlobalSearchUI();
  circleGenreFilter.addEventListener("change", handler);
  circleColorFilter.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>("button[data-filter-value]");
    if (!button) return;
    toggleFilterValue(circleColorFilterValues, button.dataset.filterValue || "");
    renderCircleColorFilterOptions();
    handler();
  });
  circleCheckFilter.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const shortcut = target.closest<HTMLButtonElement>("button[data-check-shortcut]");
    if (shortcut?.dataset.checkShortcut === "exclude-skipped") {
      if (isExcludeSkippedFilterActive()) {
        circleCheckFilterValues.clear();
      } else {
        circleCheckFilterValues.clear();
        circleCheckFilterValues.add(String(PURCHASE_STATUS.NOT_YET));
        circleCheckFilterValues.add(String(PURCHASE_STATUS.BOUGHT));
        circleCheckFilterValues.add(String(PURCHASE_STATUS.COULDNT_BUY));
      }
      renderCircleCheckFilterOptions();
      handler();
      return;
    }
    const button = target.closest<HTMLButtonElement>("button[data-filter-value]");
    if (!button) return;
    toggleFilterValue(circleCheckFilterValues, button.dataset.filterValue || "");
    renderCircleCheckFilterOptions();
    handler();
  });
  circleCatalogFilter.addEventListener("change", handler);
  globalCircleSearchInput.addEventListener("input", handler);
  globalSearchEnabledInput.addEventListener("change", () => {
    globalSearchEnabled = globalSearchEnabledInput.checked;
    if (!globalSearchEnabled) globalCircleSearchInput.value = "";
    saveGlobalSearchEnabled();
    updateGlobalSearchUI();
    renderCircleEditor();
  });
}

function updateGlobalSearchUI() {
  globalSearchEnabledInput.checked = globalSearchEnabled;
  globalCircleSearchInput.classList.toggle("hidden", !globalSearchEnabled);
  globalCircleSearchInput.disabled = !globalSearchEnabled;
}

function valueMatchesSearch(value: unknown, query: string): boolean {
  return String(value ?? "").toLowerCase().includes(query);
}

function circleMatchesGlobalSearch(
  row: Record<string, string>,
  circle: any,
  query: string,
): boolean {
  const circleParts = [
    row["サークル名"],
    row["ペンネーム"],
    row["サークルメモ"],
    row["アイテムメモ"],
    circle?.name,
    circle?.penname,
    circle?.memo,
    circle?.description,
  ];
  if (circleParts.some((value) => valueMatchesSearch(value, query))) {
    return true;
  }
  return (circle?.items || []).some((item: any) =>
    [item?.name, item?.description, item?.memo].some((value) =>
      valueMatchesSearch(value, query),
    ),
  );
}

function updateGenreFilterOptions() {
  const genres = new Set<string>();
  for (const row of tableState.rows) {
    const g = (row["ジャンル"] || "").trim();
    if (g) genres.add(g);
  }
  const current = circleGenreFilter.value;
  circleGenreFilter.innerHTML =
    `<option value="">ジャンル</option>` +
    [...genres]
      .sort()
      .map(
        (g) =>
          `<option value="${escapeHtml(g)}"${g === current ? " selected" : ""}>${escapeHtml(g)}</option>`,
      )
      .join("");
}

const TABLE_WINDOW_SIZE = 120;
const TABLE_WINDOW_OVERSCAN = 24;
const TABLE_ESTIMATED_ROW_HEIGHT = 42;
let tableWindowScrollTop = 0;
let tableWindowRerenderQueued = false;
const tableRowHeights = new Map<number, number>();

function measuredTableRowHeight(realIdx: number): number {
  return Math.max(24, tableRowHeights.get(realIdx) ?? TABLE_ESTIMATED_ROW_HEIGHT);
}

function tablePrefixHeight(indices: number[], startIdx: number, end: number): number {
  return calculateTablePrefixHeight(indices, startIdx, end, {
    estimatedRowHeight: TABLE_ESTIMATED_ROW_HEIGHT,
    rowHeights: tableRowHeights,
  });
}

function tableWindowForScroll(
  indices: number[],
  startIdx: number,
  scrollTop: number,
  viewportHeight: number,
): { start: number; end: number; topHeight: number; bottomHeight: number } {
  return calculateTableWindowForScroll(indices, startIdx, scrollTop, viewportHeight, {
    windowSize: TABLE_WINDOW_SIZE,
    overscanRows: TABLE_WINDOW_OVERSCAN,
    estimatedRowHeight: TABLE_ESTIMATED_ROW_HEIGHT,
    rowHeights: tableRowHeights,
  });
}

function renderCircleEditor() {
  if (!tableState.headers.length) {
    circleEditorEl.innerHTML = "<p class='small'>データ未読込です。</p>";
    return;
  }

  updateGenreFilterOptions();

  const displayHeaders = getDisplayHeaders(tableState.headers);
  // circlesToTableStateはevent.json.circlesをそのまま行へ変換し、
  // イベント情報行を挿入しない。先頭サークル名が空でも実データなので、
  // 内容から推測してskipしない（legacy tableを扱う場合だけ明示的にopt-in）。
  const startIdx = tableDataStartIndex(false);
  const allRows = tableState.rows.slice(startIdx);

  // フィルター適用
  const genreFilter = circleGenreFilter.value;
  const colorFilter = circleColorFilterValues;
  const checkFilter = circleCheckFilterValues;
  const catalogFilter = circleCatalogFilter.value;
  const globalSearchQuery = globalSearchEnabled
    ? globalCircleSearchInput.value.trim().toLowerCase()
    : "";

  const filteredIndices: number[] = [];
  allRows.forEach((row, dispIdx) => {
    const realIdx = startIdx + dispIdx;
    const circle = eventJsonData?.circles?.[realIdx];
    // ジャンルフィルター
    if (genreFilter && (row["ジャンル"] || "").trim() !== genreFilter) return;
    // 色フィルター
    if (colorFilter.size > 0) {
      const colorVal = String(parseFloat(String(row["色"] ?? "5")) || 5);
      if (!colorFilter.has(colorVal)) return;
    }
    // チェックフィルター
    if (checkFilter.size > 0) {
      const checkedVal = String(parseInt(row["チェック"] || "0") || 0);
      if (!checkFilter.has(checkedVal)) return;
    }
    if (catalogFilter) {
      const hasCatalogPost = circleHasCatalogPost(circle, row);
      if (catalogFilter === "with" && !hasCatalogPost) return;
      if (catalogFilter === "without" && hasCatalogPost) return;
    }
    if (
      globalSearchQuery &&
      !circleMatchesGlobalSearch(row, circle, globalSearchQuery)
    ) {
      return;
    }
    filteredIndices.push(dispIdx);
  });

  // お気に入りソート: お気に入りを先頭に
  if (favoriteSortActive) {
    filteredIndices.sort((a, b) => {
      const aFav = isCircleFavorite(allRows[a]) ? 0 : 1;
      const bFav = isCircleFavorite(allRows[b]) ? 0 : 1;
      return aFav - bFav;
    });
  }

  const isFiltering =
    genreFilter ||
    colorFilter.size > 0 ||
    checkFilter.size > 0 ||
    catalogFilter ||
    globalSearchQuery;
  circleFilterCount.textContent = isFiltering
    ? `${filteredIndices.length} / ${allRows.length}`
    : "";

  const previousTableScroll =
    circleEditorEl.querySelector<HTMLElement>(".table-scroll")?.scrollTop ??
    tableWindowScrollTop;
  const tableViewportHeight =
    circleEditorEl.querySelector<HTMLElement>(".table-scroll")?.clientHeight ??
    600;
  // filter/sort後に古いscrollTopをそのまま使うと、windowStartが末尾を
  // 越えて空白になる。可変row heightを含む全高で先にclampする。
  const tableTotalHeight = tablePrefixHeight(
    filteredIndices,
    startIdx,
    filteredIndices.length,
  );
  const maxTableScroll = Math.max(0, tableTotalHeight - tableViewportHeight);
  tableWindowScrollTop = Math.min(
    Math.max(0, previousTableScroll),
    maxTableScroll,
  );
  const tableWindow = tableWindowForScroll(
    filteredIndices,
    startIdx,
    tableWindowScrollTop,
    tableViewportHeight,
  );
  const windowStart = tableWindow.start;
  const windowEnd = tableWindow.end;
  const visibleIndices = filteredIndices.slice(windowStart, windowEnd);
  const rowsHtml = visibleIndices
    .map((dispIdx) => {
      const row = allRows[dispIdx];
      const realIdx = startIdx + dispIdx;
      let cells = displayHeaders
        .map((h) => {
          let val = String(row[h] ?? "");
          // スペース列: ホール+スペースを結合表示（例: "あ-" + "01" → "あ-01"）
          if (h === "スペース" && row["ホール"]) {
            val = String(row["ホール"]) + val;
          }
          // 画像列: サムネイル表示（空・数値のみ・"0.0"は無視）
          if (h === "スペース") {
            val = String(row[h] ?? "");
          }
          if (isImageCol(h)) {
            return `<td class="img-cell img-clickable" data-row="${realIdx}" data-col="${escapeHtml(h)}">${renderImageCellContents(val)}</td>`;
          }
          // 色列: カラーピッカー
          if (isColorCol(h)) {
            const opt = getColorOption(val);
            const bg = opt ? opt.bgColor : "#f0f0f0";
            const fg = opt ? opt.color : "#666";
            const label = opt ? opt.label : "";
            return `<td><div class="color-picker-cell"><div class="color-swatch" data-row="${realIdx}" data-col="${escapeHtml(h)}" style="background:${bg};border-color:${fg};" title="${label}"></div><span class="color-label" style="color:${fg};">${escapeHtml(label)}</span></div></td>`;
          }
          // チェック列: selectで表示
          if (h === "チェック") {
            const checkedVal = normalizePurchaseStatus(val);
            const checkedView = PURCHASE_STATUS_VIEWS[checkedVal];
            return `<td><button class="check-cycle-btn check-btn" data-row="${realIdx}" data-col="${escapeHtml(h)}" data-val="${checkedVal}" style="border-color:${checkedView.color};color:${checkedView.color};" title="${checkedView.label}">${checkedView.icon} ${checkedView.label}</button></td>`;
          }
          // ジャンル列: プルダウン
          if (h === "ジャンル") {
            return `<td><select class="genre-select genre-select-compact" data-row="${realIdx}" data-col="${escapeHtml(h)}">
              ${CIRCLE_GENRES.map((g) => `<option value="${escapeHtml(g)}"${val === g ? " selected" : ""}>${g || "未設定"}</option>`).join("")}
            </select></td>`;
          }
          // サークル名列: アイテム数バッジ + Ctrl+F検索用の非表示アイテム名を追加
          if (h === "サークル名") {
            const itemCount = parseInt(row["_itemCount"] || "0");
            const badge =
              itemCount > 0
                ? ` <span class="item-count-badge">${itemCount}</span>`
                : "";
            const circleItems = eventJsonData.circles[realIdx]?.items || [];
            const hiddenItemNames = circleItems
              .map((it: any) => it.name)
              .filter(Boolean)
              .join(" ");
            const srOnly = hiddenItemNames
              ? `<span class="sr-only">${escapeHtml(hiddenItemNames)}</span>`
              : "";
            return `<td class="relative"><input data-row="${realIdx}" data-col="${escapeHtml(h)}" value="${escapeHtml(val)}" />${badge}${srOnly}</td>`;
          }
          // URL値: リンク＋編集欄（複数URL改行区切りの場合は最初のURLを「開く」対象に）
          const firstUrl = val
            .split("\n")
            .find((line) => isUrlValue(line.trim()));
          if (firstUrl) {
            return `<td><a href="${escapeHtml(firstUrl.trim())}" target="_blank" rel="noopener noreferrer" class="link-sm">開く</a><input data-row="${realIdx}" data-col="${escapeHtml(h)}" value="${escapeHtml(val)}" /></td>`;
          }
          return `<td><input data-row="${realIdx}" data-col="${escapeHtml(h)}" value="${escapeHtml(val)}" /></td>`;
        })
        .join("");

      // お気に入り☆列を末尾に追加
      const isFav = isCircleFavorite(row);
      const favStar = isFav ? "★" : "☆";
      const favClass = isFav ? "fav-btn active" : "fav-btn";
      cells += `<td class="fav-cell"><button class="${favClass}" data-row="${realIdx}" title="お気に入り${isFav ? "解除" : "登録"}">${favStar}</button></td>`;

      // 行の背景色を「色」列の値で決定
      const colorVal = String(row["色"] ?? "");
      const rowColorOpt = getColorOption(colorVal);
      const colorParsed = parseFloat(colorVal);
      const isExpanded = expandedCircleIdx === realIdx;
      const rowClasses = [
        `circle-row`,
        ...(!isNaN(colorParsed) ? [`row-color-${colorParsed}`] : []),
        ...(isExpanded ? ["expanded"] : []),
        ...(isFav ? ["favorite-circle"] : []),
      ];
      const rowStyle = rowColorOpt
        ? ` style="${priorityRowVarsFromColor(rowColorOpt.color)}"`
        : "";

      let html = `<tr class="${rowClasses.join(" ")}" data-circle-row="${realIdx}"${rowStyle}>${cells}</tr>`;
      // 展開中ならアイテムパネル行を挿入
      if (isExpanded) {
        html += renderItemPanel(realIdx);
      }
      return html;
    })
    .join("");
  const columnCount = displayHeaders.length + 1;
  const topSpacer = tableWindow.topHeight
    ? `<tr class="virtual-spacer" aria-hidden="true"><td colspan="${columnCount}" style="height:${tableWindow.topHeight}px;padding:0;border:0"></td></tr>`
    : "";
  const bottomSpacer = tableWindow.bottomHeight
    ? `<tr class="virtual-spacer" aria-hidden="true"><td colspan="${columnCount}" style="height:${tableWindow.bottomHeight}px;padding:0;border:0"></td></tr>`
    : "";

  // ヘッダー表示名のマッピング
  const headerLabels: Record<string, string> = {
    サークル画像: "サークルカット",
    アイテム画像: "おしながき",
  };
  const thHtml =
    displayHeaders
      .map((h) => {
        const w = colWidths[h] || 100;
        const label = headerLabels[h] || h;
        return `<th style="width:${w}px;min-width:40px;" data-col-name="${escapeHtml(h)}">${escapeHtml(label)}<div class="col-resize-handle"></div></th>`;
      })
      .join("") +
    `<th style="width:36px;min-width:36px;cursor:pointer;" data-col-name="★" title="お気に入りでソート">${favoriteSortActive ? "★" : "☆"}</th>`;

  circleEditorEl.innerHTML = `
    <div class="table-scroll">
    <table>
      <thead><tr>${thHtml}</tr></thead>
      <tbody>${topSpacer}${rowsHtml}${bottomSpacer}</tbody>
    </table>
    </div>
  `;
  markEventSwitch("event-switch:table-first-paint");
  measureEventSwitch(
    "event-switch:table-first-paint-duration",
    "event-switch:click",
    "event-switch:table-first-paint",
  );
  // 実測row heightを次回window計算へ反映する。展開パネルはサークルrowの
  // 高さに加算し、固定42px前提によるスクロール位置ずれを避ける。
  let tableRowMeasurementChanged = false;
  circleEditorEl
    .querySelectorAll<HTMLTableRowElement>("tr.circle-row[data-circle-row]")
    .forEach((row) => {
      const realIdx = Number(row.dataset.circleRow);
      if (!Number.isFinite(realIdx)) return;
      const panel = row.nextElementSibling;
      const rowHeight = row.getBoundingClientRect().height;
      const panelHeight =
        panel instanceof HTMLTableRowElement &&
        panel.classList.contains("item-panel-row")
          ? panel.getBoundingClientRect().height
          : 0;
      const measured = Math.max(
        24,
        Math.ceil(rowHeight + panelHeight) || TABLE_ESTIMATED_ROW_HEIGHT,
      );
      const previous = tableRowHeights.get(realIdx);
      if (previous === undefined || Math.abs(previous - measured) > 1) {
        tableRowHeights.set(realIdx, measured);
        tableRowMeasurementChanged = true;
      }
    });
  if (
    tableRowMeasurementChanged &&
    filteredIndices.length > TABLE_WINDOW_SIZE &&
    !tableWindowRerenderQueued
  ) {
    tableWindowRerenderQueued = true;
    requestAnimationFrame(() => {
      tableWindowRerenderQueued = false;
      renderCircleEditor();
    });
  }
  const tableScroll = circleEditorEl.querySelector<HTMLElement>(".table-scroll");
  if (tableScroll) {
    tableScroll.scrollTop = tableWindowScrollTop;
    if (filteredIndices.length > TABLE_WINDOW_SIZE) {
      tableScroll.addEventListener("scroll", () => {
        tableWindowScrollTop = tableScroll.scrollTop;
        if (tableWindowRerenderQueued) return;
        tableWindowRerenderQueued = true;
        requestAnimationFrame(() => {
          tableWindowRerenderQueued = false;
          renderCircleEditor();
        });
      }, { passive: true });
    }
  }
  desktopPerf.tableDomRows = circleEditorEl.querySelectorAll("tbody tr.circle-row").length;
  publishDesktopPerf();

  // 列幅ドラッグリサイズ
  circleEditorEl
    .querySelectorAll<HTMLDivElement>(".col-resize-handle")
    .forEach((handle) => {
      handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const th = handle.parentElement as HTMLTableCellElement;
        const colName = th.dataset.colName || "";
        const startX = e.clientX;
        const startW = th.offsetWidth;
        handle.classList.add("dragging");

        const onMove = (ev: MouseEvent) => {
          const newW = Math.max(40, startW + (ev.clientX - startX));
          th.style.width = `${newW}px`;
        };
        const onUp = (ev: MouseEvent) => {
          handle.classList.remove("dragging");
          const finalW = Math.max(40, startW + (ev.clientX - startX));
          th.style.width = `${finalW}px`;
          if (colName) {
            colWidths[colName] = finalW;
            saveColWidths(colWidths);
          }
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    });

  // ★ヘッダークリック → お気に入りソート切り替え
  const favHeader = circleEditorEl.querySelector<HTMLTableCellElement>(
    'th[data-col-name="★"]',
  );
  if (favHeader) {
    favHeader.addEventListener("click", () => {
      favoriteSortActive = !favoriteSortActive;
      renderCircleEditor();
    });
  }

  // 色スウォッチクリック → ドロップダウン表示
  circleEditorEl
    .querySelectorAll<HTMLDivElement>(".color-swatch[data-row][data-col]")
    .forEach((swatch) => {
      swatch.addEventListener("click", (e) => {
        e.stopPropagation();
        // 既存ドロップダウンを閉じる
        document.querySelectorAll(".color-dropdown").forEach((d) => d.remove());
        const row = Number(swatch.dataset.row);
        const col = String(swatch.dataset.col);
        const currentVal = String(
          parseFloat(tableState.rows[row][col] || "5") || 5,
        );

        const dropdown = document.createElement("div");
        dropdown.className = "color-dropdown";
        for (const opt of COLOR_OPTIONS) {
          const btn = document.createElement("div");
          btn.className =
            "color-option" + (opt.value === currentVal ? " selected" : "");
          btn.style.background = opt.bgColor;
          btn.style.color = opt.color;
          btn.textContent = opt.label;
          btn.title = opt.label;
          btn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            tableState.rows[row][col] = opt.value + ".0";
            saveNow();
            swatch.style.background = opt.bgColor;
            swatch.style.borderColor = opt.color;
            swatch.title = opt.label;
            const labelSpan =
              swatch.nextElementSibling as HTMLSpanElement | null;
            if (labelSpan) {
              labelSpan.textContent = opt.label;
              labelSpan.style.color = opt.color;
            }
            // 行の背景色クラスも更新
            const tr = swatch.closest("tr");
            if (tr) {
              tr.className = tr.className.replace(/row-color-\S+/g, "").trim();
              tr.classList.add(`row-color-${opt.value}`);
              applyPriorityRowStyle(tr as HTMLElement, opt);
            }
            dropdown.remove();
          });
          dropdown.appendChild(btn);
        }
        // ドロップダウンの位置（右端はみ出し防止）
        const rect = swatch.getBoundingClientRect();
        dropdown.style.position = "fixed";
        dropdown.style.top = `${rect.bottom + 4}px`;
        document.body.appendChild(dropdown);
        const ddWidth = dropdown.offsetWidth;
        const maxLeft = window.innerWidth - ddWidth - 8;
        dropdown.style.left = `${Math.min(rect.left, maxLeft)}px`;

        // 外側クリックで閉じる
        const closeHandler = () => {
          dropdown.remove();
          document.removeEventListener("click", closeHandler);
        };
        setTimeout(() => document.addEventListener("click", closeHandler), 0);
      });
    });

  // 画像セル: 左クリック → 拡大表示、右クリック → コンテキストメニュー（差し替え/削除）
  circleEditorEl
    .querySelectorAll<HTMLTableCellElement>(
      ".img-clickable[data-row][data-col]",
    )
    .forEach((cell) => {
      // 左クリック: 画像があれば拡大表示、なければファイル選択
      cell.addEventListener("click", async () => {
        const row = Number(cell.dataset.row);
        const col = String(cell.dataset.col);
        const currentVal = String(tableState.rows[row][col] ?? "").trim();
        const hasImage =
          currentVal &&
          currentVal !== "0.0" &&
          currentVal !== "0" &&
          !/^\d+(\.\d+)?$/.test(currentVal);
        if (hasImage) {
          // 拡大表示
          if (col === "アイテム画像") {
            showCatalogImageModal(row);
          } else {
            const src = resolveImageSrc(currentVal);
            showImageModal(src);
          }
        } else {
          // 画像なし → ファイル選択
          await pickAndSetImage(cell, row, col);
        }
      });

      // 右クリック: コンテキストメニュー
      cell.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const row = Number(cell.dataset.row);
        const col = String(cell.dataset.col);
        const currentVal = String(tableState.rows[row][col] ?? "").trim();
        const hasImage =
          currentVal &&
          currentVal !== "0.0" &&
          currentVal !== "0" &&
          !/^\d+(\.\d+)?$/.test(currentVal);
        showImageContextMenu(e.clientX, e.clientY, cell, row, col, !!hasImage);
      });
    });

  // サークルのチェック列（クリックサイクル）
  circleEditorEl
    .querySelectorAll<HTMLButtonElement>("button.check-cycle-btn")
    .forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const row = Number(btn.dataset.row);
        const col = String(btn.dataset.col);
        const current = normalizePurchaseStatus(btn.dataset.val);
        const next = nextPurchaseStatus(current);
        tableState.rows[row][col] = String(next);
        btn.dataset.val = String(next);
        // ボタン表示更新
        const view = PURCHASE_STATUS_VIEWS[next];
        btn.textContent = `${view.icon} ${view.label}`;
        btn.title = view.label;
        btn.style.borderColor = view.color;
        btn.style.color = view.color;
        // 背景色更新
        const td = btn.closest("td");
        if (td) {
          td.style.background = view.bg;
        }
        // サークルのチェック変更 → アイテム自動連動
        if (col === "チェック" && eventJsonData && eventJsonData.circles[row]) {
          const items: any[] = eventJsonData.circles[row].items || [];
          const allUntouched = items.every(
            (it: any) => (it.checked ?? 0) === 0,
          );
          if (next === PURCHASE_STATUS.NOT_YET && items.length > 0) {
            items.forEach((it: any) => {
              it.checked = next;
            });
            if (expandedCircleIdx === row) {
              toggleItemPanelInPlace();
            }
          } else if (allUntouched && items.length > 0) {
            items.forEach((it: any) => {
              it.checked = next;
            });
            if (expandedCircleIdx === row) {
              toggleItemPanelInPlace();
            }
          }
        }
        saveNow();
        await rebuildPurchasedItemIndex();
        if (expandedCircleIdx === row) {
          toggleItemPanelInPlace();
        }
      });
    });

  // 表示window内のinput/selectへ個別listenerを付けず、table rootで委譲する。
  // tableStateは全行を保持するため、window再描画でも編集中の値を失わない。
  if (circleEditorEl.dataset.delegated !== "true") {
    circleEditorEl.dataset.delegated = "true";
    circleEditorEl.addEventListener("change", (e) => {
    const target = e.target as HTMLInputElement | HTMLSelectElement | null;
    if (!target) return;
    if (target.matches("select.genre-select")) {
      const row = Number(target.dataset.row);
      const col = String(target.dataset.col);
      tableState.rows[row][col] = target.value;
      void saveNow();
      const rowData = tableState.rows[row];
      const cName = (rowData["サークル名"] || "").trim();
      const penname = (rowData["ペンネーム"] || "").trim();
      if (cName) setCircleMasterGenre(cName, penname, target.value);
      return;
    }
    if (!target.matches("input[data-row][data-col]")) return;
    const row = Number(target.dataset.row);
    const col = String(target.dataset.col);
    tableState.rows[row][col] = target.value;
    void saveNow();
    });
    circleEditorEl.addEventListener("input", (e) => {
      const target = e.target as HTMLInputElement | null;
      if (!target?.matches("input[data-row][data-col]")) return;
      const row = Number(target.dataset.row);
      const col = String(target.dataset.col);
      if (!tableState.rows[row]) return;
      // scroll/filterでwindow DOMが差し替わる前に入力値を保持する。
      // saveNowはchange listenerへ任せ、入力ごとのIPCは発生させない。
      tableState.rows[row][col] = target.value;
    });
    // selectは行の展開clickを止める必要があるためcaptureで委譲する。
    circleEditorEl.addEventListener(
      "click",
      (e) => {
        if ((e.target as HTMLElement).closest("select.genre-select")) e.stopPropagation();
      },
      true,
    );
  }

  // サークル行クリック → アイテムパネル展開/折りたたみ（テーブル再構築しない）
  circleEditorEl
    .querySelectorAll<HTMLTableRowElement>("tr.circle-row[data-circle-row]")
    .forEach((tr) => {
      let downX = 0,
        downY = 0;
      tr.addEventListener("mousedown", (e) => {
        downX = e.clientX;
        downY = e.clientY;
      });
      tr.addEventListener("click", (e) => {
        const target = e.target as HTMLElement;
        if (
          target.closest(
            "input, textarea, img, a, button, select, .color-swatch, .img-clickable",
          )
        )
          return;
        if (Math.abs(e.clientX - downX) > 5 || Math.abs(e.clientY - downY) > 5)
          return;

        const idx = Number(tr.dataset.circleRow);
        if (expandedCircleIdx === idx) {
          expandedCircleIdx = -1;
        } else {
          expandedCircleIdx = idx;
        }
        toggleItemPanelInPlace();
      });

      tr.addEventListener("dragover", (e) => {
        const target = e.target as HTMLElement;
        if (
          target.closest(
            "input, textarea, select, a, button, .img-clickable, .color-swatch",
          )
        )
          return;
        if (!dataTransferHasImage(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        tr.classList.add("drag-over");
      });
      tr.addEventListener("dragleave", (e) => {
        const related = e.relatedTarget as Node | null;
        if (!related || !tr.contains(related)) tr.classList.remove("drag-over");
      });
      tr.addEventListener("drop", async (e) => {
        const target = e.target as HTMLElement;
        if (
          target.closest(
            "input, textarea, select, a, button, .img-clickable, .color-swatch",
          )
        )
          return;
        if (!e.dataTransfer || !dataTransferHasImage(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();
        tr.classList.remove("drag-over");
        const idx = Number(tr.dataset.circleRow);
        await reprocessCircleFromDroppedImage(idx, e.dataTransfer);
      });

      // 行右クリック → コンテキストメニュー（再処理/追加/削除）
      tr.addEventListener("contextmenu", (e) => {
        const target = e.target as HTMLElement;
        // 入力欄・画像セル等、独自の右クリ挙動があるものはスキップ
        if (
          target.closest(
            "input, textarea, select, a, button, .img-clickable, .color-swatch",
          )
        )
          return;
        e.preventDefault();
        e.stopPropagation();
        const idx = Number(tr.dataset.circleRow);
        showCircleRowContextMenu(e.clientX, e.clientY, idx);
      });
    });

  // お気に入り☆ボタン
  circleEditorEl
    .querySelectorAll<HTMLButtonElement>("button.fav-btn")
    .forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const rowIdx = Number(btn.dataset.row);
        const row = tableState.rows[rowIdx];
        if (!row) return;
        const name = (row["サークル名"] || "").trim();
        const penname = (row["ペンネーム"] || "").trim();
        const nowFav = toggleFavorite(name, penname);
        btn.textContent = nowFav ? "★" : "☆";
        btn.title = `お気に入り${nowFav ? "解除" : "登録"}`;
        btn.classList.toggle("active", nowFav);
        // 行クラスも更新
        const tr = btn.closest("tr");
        if (tr) tr.classList.toggle("favorite-circle", nowFav);
      });
    });

  // 初期表示時に展開中パネルがあればリスナーを付与
  attachItemPanelListeners();

  // 予算パネル更新
  updateBudgetPanel();
}

/** サークル行の右クリックメニュー（再処理/追加/削除） */
async function markCircleCatalogNeedsRecheck(rowIdx: number) {
  const row = tableState.rows[rowIdx];
  const circle = eventJsonData?.circles?.[rowIdx];
  if (!row || !circle) return;
  const ok = confirm(
    "このサークルを「おしながきポスト未取得」に戻します。メモ内のX/Twitter投稿URLも削除します。",
  );
  if (!ok) return;
  const cleanedMemo = removeTwitterStatusUrlsFromMemo(
    String(circle.memo ?? row["サークルメモ"] ?? ""),
  );
  circle.memo = cleanedMemo;
  circle.catalog_status = "needs_recheck";
  row["サークルメモ"] = cleanedMemo;
  await saveNow();
  renderCircleEditorAndMap();
}

function showCircleRowContextMenu(x: number, y: number, rowIdx: number) {
  document.querySelectorAll(".ctx-menu").forEach((m) => m.remove());
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const reprocessItem = document.createElement("div");
  reprocessItem.textContent = "このサークルを再処理（XポストURL指定）";
  reprocessItem.addEventListener("click", () => {
    menu.remove();
    void reprocessCircleFromPostInteractive(rowIdx);
  });
  menu.appendChild(reprocessItem);

  const reprocessImageItem = document.createElement("div");
  reprocessImageItem.textContent = "このサークルを画像から再処理";
  reprocessImageItem.addEventListener("click", () => {
    menu.remove();
    void reprocessCircleFromImagePicker(rowIdx);
  });
  menu.appendChild(reprocessImageItem);

  const needsRecheckItem = document.createElement("div");
  needsRecheckItem.textContent = "おしながきポスト未取得に戻す";
  needsRecheckItem.addEventListener("click", () => {
    menu.remove();
    void markCircleCatalogNeedsRecheck(rowIdx);
  });
  menu.appendChild(needsRecheckItem);

  const addItem = document.createElement("div");
  addItem.textContent = "このサークルの下に追加";
  addItem.addEventListener("click", () => {
    menu.remove();
    addCircleRow(rowIdx + 1);
  });
  menu.appendChild(addItem);

  const deleteItem = document.createElement("div");
  deleteItem.textContent = "このサークルを削除";
  deleteItem.style.color = "#c62828";
  deleteItem.addEventListener("click", () => {
    menu.remove();
    void deleteCircleRow(rowIdx);
  });
  menu.appendChild(deleteItem);

  document.body.appendChild(menu);
  const close = () => {
    menu.remove();
    document.removeEventListener("click", close);
  };
  setTimeout(() => document.addEventListener("click", close), 0);
}

/** テーブル空白エリアの右クリックメニュー（末尾に追加のみ） */
function showCircleTableContextMenu(x: number, y: number) {
  document.querySelectorAll(".ctx-menu").forEach((m) => m.remove());
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const addItem = document.createElement("div");
  addItem.textContent = "サークルを末尾に追加";
  addItem.addEventListener("click", () => {
    menu.remove();
    const len = eventJsonData?.circles?.length ?? tableState.rows.length;
    addCircleRow(len);
  });
  menu.appendChild(addItem);

  document.body.appendChild(menu);
  const close = () => {
    menu.remove();
    document.removeEventListener("click", close);
  };
  setTimeout(() => document.addEventListener("click", close), 0);
}

/** 空のサークルを指定位置に挿入 */
function addCircleRow(insertIdx: number) {
  if (!eventJsonData) {
    eventJsonData = { circles: [] };
  }
  if (!Array.isArray(eventJsonData.circles)) eventJsonData.circles = [];

  const newCircle = {
    name: "",
    penname: "",
    space: "",
    hall: "",
    twitter_url: "",
    website_url: "",
    pixiv_url: "",
    description: "",
    genres: [],
    tags: [],
    items: [],
    circle_cut_filename: "",
    item_images: [],
    priority_color: 5,
    memo: "",
    absence_status: null,
    existing_only_status: null,
    pin_x: null,
    pin_y: null,
    map_number: null,
    checked: 0,
  };
  const idx = Math.max(0, Math.min(insertIdx, eventJsonData.circles.length));
  eventJsonData.circles.splice(idx, 0, newCircle);

  // tableStateも再構築
  tableState = circlesToTableState(eventJsonData);
  applyCircleMasterGenres();
  eventTableBaseline = cloneJsonSnapshot(tableState);
  saveNow();
  renderCircleEditor();
}

/** サークルを削除（assetファイルとcircle_masterは保持） */
async function deleteCircleRow(rowIdx: number) {
  if (!eventJsonData?.circles || rowIdx < 0 || rowIdx >= eventJsonData.circles.length)
    return;
  const c = eventJsonData.circles[rowIdx];
  const name = c.name || "(無題)";
  if (!window.confirm(`サークル「${name}」を削除します。よろしいですか？\n\n(画像ファイルとcircle_masterのデータは保持されます)`))
    return;

  const ownerSlug = activeEventSlug;
  const documentBefore = cloneJsonSnapshot(eventJsonData);
  const tableBefore = cloneJsonSnapshot(tableState);
  const baselineBefore = cloneJsonSnapshot(eventTableBaseline);
  const expandedBefore = expandedCircleIdx;

  // 配列から削除
  eventJsonData.circles.splice(rowIdx, 1);
  // 展開状態のリセット
  if (expandedCircleIdx === rowIdx) expandedCircleIdx = -1;
  else if (expandedCircleIdx > rowIdx) expandedCircleIdx -= 1;

  tableState = circlesToTableState(eventJsonData);
  applyCircleMasterGenres();
  eventTableBaseline = cloneJsonSnapshot(tableState);
  const pendingSave = saveNow();
  const deletionRevision = eventDocumentStateRevision;
  const expectedDocument = cloneJsonSnapshot(eventJsonData);
  const expectedTable = cloneJsonSnapshot(tableState);
  const expectedBaseline = cloneJsonSnapshot(eventTableBaseline);
  const saveResult = await pendingSave;
  if (!saveResult.ok) {
    if (
      activeEventSlug === ownerSlug &&
      eventDocumentStateRevision === deletionRevision &&
      eventJsonDocumentsEqual(eventJsonData, expectedDocument) &&
      JSON.stringify(tableState) === JSON.stringify(expectedTable) &&
      JSON.stringify(eventTableBaseline) === JSON.stringify(expectedBaseline)
    ) {
      eventJsonData = documentBefore;
      tableState = tableBefore;
      eventTableBaseline = baselineBefore;
      expandedCircleIdx = expandedBefore;
      eventDocumentStateRevision += 1;
    }
  }
  renderCircleEditor();
}

type ReprocessCircleJob = {
  rowIdx: number;
  circleIdentity: {
    name: string;
    penname: string;
    space: string;
    hall: string;
  };
  circleName: string;
  eventSlug?: string;
  eventJsonPath?: string;
  outputDir?: string;
} & (
  | {
      source: "post";
      postUrl: string;
    }
  | {
      source: "image";
      imageFileName: string;
      imagePath: string;
    }
);

const reprocessCircleQueue: ReprocessCircleJob[] = [];

function circleIdentityFromCircle(c: any): ReprocessCircleJob["circleIdentity"] {
  return {
    name: String(c?.name || "").trim(),
    penname: String(c?.penname || "").trim(),
    space: String(c?.space || "").trim(),
    hall: String(c?.hall || "").trim(),
  };
}

function reprocessJobLabel(job: ReprocessCircleJob): string {
  return job.source === "post" ? job.postUrl : job.imageFileName;
}

function findCircleIndexByIdentity(
  preferredIdx: number,
  identity: ReprocessCircleJob["circleIdentity"],
): number {
  const circles: any[] = eventJsonData?.circles || [];
  const hasIdentity = Boolean(
    identity.name || identity.penname || identity.space || identity.hall,
  );
  if (!hasIdentity) return preferredIdx >= 0 && preferredIdx < circles.length ? preferredIdx : -1;
  const matchesIdentity = (circle: any) =>
    (!identity.name || String(circle?.name || "").trim() === identity.name) &&
    (!identity.penname || String(circle?.penname || "").trim() === identity.penname) &&
    (!identity.space || String(circle?.space || "").trim() === identity.space) &&
    (!identity.hall || String(circle?.hall || "").trim() === identity.hall);

  if (
    preferredIdx >= 0 &&
    preferredIdx < circles.length &&
    matchesIdentity(circles[preferredIdx])
  ) {
    return preferredIdx;
  }
  const matches = circles
    .map((circle, index) => ({ circle, index }))
    .filter(({ circle }) => matchesIdentity(circle));
  return matches.length === 1 ? matches[0].index : -1;
}

function mergeReprocessedCircleIntoState(
  preferredIdx: number,
  identity: ReprocessCircleJob["circleIdentity"],
  updatedCircle: any,
) {
  if (!eventJsonData?.circles || !updatedCircle) return;
  const idx = findCircleIndexByIdentity(preferredIdx, identity);
  if (idx < 0) return;

  const target = eventJsonData.circles[idx];
  for (const field of [
    "items",
    "item_images",
    "catalog_status",
    "existing_only_status",
    "memo",
  ]) {
    if (Object.prototype.hasOwnProperty.call(updatedCircle, field)) {
      target[field] = updatedCircle[field];
    }
  }

  const row = tableState.rows[idx];
  if (row) {
    if (
      Object.prototype.hasOwnProperty.call(updatedCircle, "item_images") ||
      Object.prototype.hasOwnProperty.call(updatedCircle, "items")
    ) {
      row["アイテム画像"] = catalogImagePathsForCircle(target).join("\n");
    }
    if (Object.prototype.hasOwnProperty.call(updatedCircle, "items")) {
      const items: any[] = target.items || [];
      row["_itemCount"] = String(items.length);
      row["アイテムタグ"] = [
        ...new Set(
          items
            .map((item: any) => item.type || item.genre || "")
            .filter(Boolean),
        ),
      ].join(", ");
    }
    if (Object.prototype.hasOwnProperty.call(updatedCircle, "memo")) {
      row["アイテムメモ"] = String(target.memo || "");
    }
  }

  const active = document.activeElement as HTMLElement | null;
  const isEditing =
    !!active && !!active.closest("#circleEditor input, #circleEditor textarea, #circleEditor select");
  if (!isEditing) {
    renderCircleEditor();
    updateBudgetPanel();
    return;
  }
  updateImageCellContents(idx, "アイテム画像");
  updateBudgetPanel();
}

function enqueueReprocessCircle(job: ReprocessCircleJob) {
  if (!canEnqueueReprocess(operationState)) {
    resultEl.textContent =
      "イベント処理中のため、1サークル再処理は完了後に実行してください。";
    return;
  }
  job.eventSlug = activeEventSlug || "";
  job.eventJsonPath = (
    document.getElementById("editorJsonPath") as HTMLInputElement
  ).value.trim();
  job.outputDir = getActiveEventDir() || "";
  if (!job.eventSlug || !job.eventJsonPath || !job.outputDir) {
    resultEl.textContent = "アクティブなイベントが選択されていません。";
    return;
  }
  const shouldStart =
    operationState.kind === "idle" && operationState.queuedReprocess === 0;
  reprocessCircleQueue.push(job);
  applyOperationEvent({ type: "enqueue-reprocess" });
  const queued = operationState.queuedReprocess +
    (isReprocessOperation(operationState) ? 1 : 0);
  resultEl.textContent = `「${job.circleName}」の再処理をキューに追加しました（待機中: ${queued}件）`;
  if (shouldStart) {
    void drainReprocessCircleQueue().catch((error) => {
      const msg = `1サークル再処理キューで予期しないエラーが発生しました: ${String(error)}`;
      resultEl.textContent = msg;
      logToFile(msg);
    });
  }
}

async function drainReprocessCircleQueue() {
  if (!canStartReprocess(operationState)) return;
  applyOperationEvent({ type: "start-reprocess" });
  setEventPipelineButtonsDisabled(true);
  try {
    const pendingCrawlMeta = captureCrawlMetaSnapshot();
    cancelCrawlMetaSave();
    await flushCrawlMetaSnapshot(pendingCrawlMeta, INTERNAL_OPERATION_SAVE);
    const initialSave = await saveNow(INTERNAL_OPERATION_SAVE);
    if (!initialSave.ok) {
      resultEl.textContent = `1サークル再処理前の保存に失敗しました: ${String(initialSave.error)}`;
      reprocessCircleQueue.length = 0;
      applyOperationEvent({ type: "abort-reprocess" });
      return;
    }
    while (true) {
      while (reprocessCircleQueue.length > 0) {
        const job = reprocessCircleQueue.shift()!;
        applyOperationEvent({ type: "dequeue-reprocess" });
        await runReprocessCircleJob(job);
      }
      const finalSave = await saveNow(INTERNAL_OPERATION_SAVE);
      if (!finalSave.ok) {
        resultEl.textContent = `1サークル再処理後の保存に失敗しました: ${String(finalSave.error)}`;
      }
      // 最終保存中に追加されたキューも同じ排他区間で処理する。
      if (reprocessCircleQueue.length === 0) break;
    }
  } finally {
    if (isReprocessOperation(operationState)) {
      if (reprocessCircleQueue.length === 0) {
        applyOperationEvent({ type: "finish-reprocess" });
      } else {
        reprocessCircleQueue.length = 0;
        applyOperationEvent({ type: "abort-reprocess" });
      }
    }
    setEventPipelineButtonsDisabled(false);
  }
}

async function runReprocessCircleJob(job: ReprocessCircleJob) {
  const stillTargetsQueuedEvent = () =>
    activeEventSlug === job.eventSlug &&
    (document.getElementById("editorJsonPath") as HTMLInputElement).value.trim() ===
      job.eventJsonPath &&
    getActiveEventDir() === job.outputDir;
  if (!stillTargetsQueuedEvent()) {
    resultEl.textContent =
      `「${job.circleName}」はイベントが切り替わったため再処理をスキップしました。`;
    return;
  }
  const currentIdx = findCircleIndexByIdentity(job.rowIdx, job.circleIdentity);
  if (currentIdx < 0) {
    resultEl.textContent = `「${job.circleName}」が見つからないため再処理をスキップしました。`;
    return;
  }

  resultEl.textContent = `「${job.circleName}」の変更を保存中...`;
  const saveResult = await saveNow(INTERNAL_OPERATION_SAVE);
  if (!saveResult.ok) {
    resultEl.textContent = `「${job.circleName}」の変更保存に失敗しました: ${String(saveResult.error)}`;
    return;
  }
  if (!stillTargetsQueuedEvent()) {
    resultEl.textContent =
      `「${job.circleName}」は保存中にイベントが切り替わったため再処理を中止しました。`;
    return;
  }

  const eventJsonPath = job.eventJsonPath || "";
  const outputDir = job.outputDir || "";
  if (!eventJsonPath || !outputDir) {
    alert("アクティブなイベントが選択されていません。");
    return;
  }

  resultEl.textContent = `「${job.circleName}」を再処理中... (${reprocessJobLabel(job)})\n残りキュー: ${reprocessCircleQueue.length}件`;
  const modelVal = (document.getElementById("model") as HTMLInputElement)?.value || "";
  const imageConfig = selectedImageConfig();
  const textApiModels = selectedTextApiModels();
  const additionalPrompt = displayAdditionalPromptText(
    (document.getElementById("additionalPrompt") as HTMLTextAreaElement)?.value || "",
  );
  const eventDate =
    (document.getElementById("eventDate") as HTMLInputElement)?.value || "";

  const selectedText = selectedTextProvider();
  const commonPayload = {
    project_root: projectRootEl.value,
    event_json: eventJsonPath,
    circle_index: currentIdx,
    circle_identity: job.circleIdentity,
    output_dir: outputDir,
    model: textApiModels.join(",") || modelVal.split(",")[0]?.trim() || "gemini-pro",
    text_llm_provider: selectedText.kind === "cli" ? selectedText.provider : "api",
    text_llm_cli_models: selectedTextCliModelMap(),
    text_llm_cli_efforts: selectedTextCliEffortMap(),
    text_llm_cli_timeout: 900,
    api_reasoning_effort: selectedTextEffort(),
    api_reasoning_effort_map: selectedTextApiEffortMap(),
    text_fallback_llm_provider: providerConfigValue(selectedTextFallbackProvider()),
    text_fallback_llm_model: selectedTextFallbackModel(),
    text_fallback_llm_effort: selectedTextFallbackEffort(),
    image_llm_provider: imageConfig.provider,
    image_llm_model: imageConfig.model,
    image_llm_effort: imageConfig.effort,
    image_fallback_llm_provider: providerConfigValue(selectedImageFallbackProvider()),
    image_fallback_llm_model: selectedImageFallbackModel(),
    image_fallback_llm_effort: selectedImageFallbackEffort(),
    image_api_reasoning_effort_map: selectedImageApiEffortMap(),
    tweet_llm_cli_providers: selectedTweetProviders(),
    tweet_llm_cli_models: selectedTweetModelMap(),
    tweet_llm_cli_efforts: selectedTweetEffortMap(),
    tweet_llm_cli_timeout: 900,
    catalog_additional_prompt: additionalPrompt,
    event_date: eventDate,
  };
  const res =
    job.source === "post"
      ? await runJob("reprocess_circle_from_post", {
          ...commonPayload,
          post_url: job.postUrl,
        })
      : await runJob("reprocess_circle_from_image", {
          ...commonPayload,
          image_filename: job.imageFileName,
          image_path: job.imagePath,
        });

  if (!stillTargetsQueuedEvent()) {
    resultEl.textContent =
      `「${job.circleName}」の処理中にイベントが切り替わったため、画面への反映を中止しました。`;
    return;
  }

  const bridge = res?.bridge as Record<string, any> | undefined;
  if (res?.ok && bridge?.circle_patch) {
    const applied = await applyBridgeEventPatch(
      job.eventSlug || "",
      outputDir,
      {
        baseFingerprint: normalizeNativeEventFingerprint(
          bridge.base_fingerprint as NativeEventFingerprint | undefined,
        ),
        circlePatches: [circlePatchFromBridge(bridge)],
      },
    );
    if (!stillTargetsQueuedEvent()) {
      resultEl.textContent =
        `「${job.circleName}」の保存中にイベントが切り替わったため画面反映を中止しました。`;
      return;
    }
    eventJsonData = cloneJsonSnapshot(applied.data);
    persistedEventJsonData = cloneJsonSnapshot(applied.data);
    tableState = circlesToTableState(eventJsonData);
    eventTableBaseline = cloneJsonSnapshot(tableState);
    markEventDocumentMutated();
    const resolvedIndex = applied.resolvedCircleIndices[0] ?? currentIdx;
    mergeReprocessedCircleIntoState(
      resolvedIndex,
      job.circleIdentity,
      eventJsonData.circles?.[resolvedIndex],
    );
    resultEl.textContent = `「${job.circleName}」の再処理が完了しました\nアイテム数: ${bridge.items_count ?? "?"}\n残りキュー: ${reprocessCircleQueue.length}件`;
  }
}

/** XポストURLをプロンプトで受け取り、当該サークルを再処理キューに追加する */
async function reprocessCircleFromPostInteractive(rowIdx: number) {
  if (!eventJsonData?.circles || rowIdx < 0 || rowIdx >= eventJsonData.circles.length)
    return;
  const guard = captureEventAsyncMutationGuard(rowIdx);
  if (!guard) return;
  const c = eventJsonData.circles[rowIdx];
  const name = c.name || "(無題)";

  // クリップボードから候補URLを取得（許可がなければ無視）
  let defaultUrl = "";
  try {
    const text = await navigator.clipboard.readText();
    if (!guard.isCurrent()) return;
    if (/(?:twitter\.com|x\.com)\/[^/]+\/status(?:es)?\/\d+/.test(text)) {
      defaultUrl = text.trim();
    }
  } catch {
    /* 権限エラー等は無視 */
  }

  if (!guard.isCurrent()) return;
  const input = window.prompt(
    `「${name}」を再処理するXポストのURLを入力してください\n例: https://x.com/user/status/1234567890`,
    defaultUrl,
  );
  if (!input || !guard.isCurrent()) return;
  const postUrl = input.trim();
  if (!/(?:twitter\.com|x\.com)\/[^/]+\/status(?:es)?\/\d+/.test(postUrl)) {
    alert("Xのポスト(ステータス)URLではありません。\n例: https://x.com/user/status/1234567890");
    return;
  }

  enqueueReprocessCircle({
    rowIdx,
    circleIdentity: circleIdentityFromCircle(c),
    circleName: name,
    source: "post",
    postUrl,
  });
}

function enqueueReprocessCircleFromImage(
  rowIdx: number,
  imageFileName: string,
  imagePath: string,
) {
  if (!eventJsonData?.circles || rowIdx < 0 || rowIdx >= eventJsonData.circles.length)
    return;
  const c = eventJsonData.circles[rowIdx];
  enqueueReprocessCircle({
    rowIdx,
    circleIdentity: circleIdentityFromCircle(c),
    circleName: c.name || "(無題)",
    source: "image",
    imageFileName,
    imagePath,
  });
}

async function reprocessCircleFromImagePicker(rowIdx: number) {
  const guard = captureEventAsyncMutationGuard(rowIdx);
  if (!guard) return;
  const activeDir = getActiveEventDir();
  const selected = await dialogOpen({
    multiple: false,
    filters: [{ name: "画像ファイル", extensions: IMAGE_EXTENSIONS }],
  });
  if (!guard.isCurrent()) return;
  if (!selected || typeof selected !== "string") return;

  try {
    const saved = await saveCatalogImageFromPath(selected, activeDir, guard);
    if (!saved || !guard.isCurrent()) return;
    enqueueReprocessCircleFromImage(rowIdx, saved.fileName, saved.filePath);
  } catch (err) {
    const msg = `画像からの再処理準備に失敗: ${String(err)}`;
    resultEl.textContent = msg;
    logToFile(msg);
  }
}

async function reprocessCircleFromDroppedImage(rowIdx: number, dt: DataTransfer) {
  const guard = captureEventAsyncMutationGuard(rowIdx);
  if (!guard) return;
  const activeDir = getActiveEventDir();
  try {
    const saved = await saveCatalogImageFromDataTransfer(dt, activeDir, guard);
    if (!saved || !guard.isCurrent()) return;
    enqueueReprocessCircleFromImage(rowIdx, saved.fileName, saved.filePath);
  } catch (err) {
    const msg = `画像からの再処理準備に失敗: ${String(err)}`;
    resultEl.textContent = msg;
    logToFile(msg);
  }
}

/** 既存テーブルDOMを保持したまま、アイテムパネル行だけ差し替える */
function toggleItemPanelInPlace() {
  const tbody = circleEditorEl.querySelector("tbody");
  if (!tbody) return;

  // 1. 既存のアイテムパネル行と展開クラスを全て除去
  tbody
    .querySelectorAll<HTMLTableRowElement>("tr.item-panel-row")
    .forEach((r) => r.remove());
  tbody
    .querySelectorAll<HTMLTableRowElement>("tr.circle-row.expanded")
    .forEach((r) => r.classList.remove("expanded"));

  // 2. 展開対象があれば挿入
  if (expandedCircleIdx >= 0) {
    const circleRow = tbody.querySelector<HTMLTableRowElement>(
      `tr.circle-row[data-circle-row="${expandedCircleIdx}"]`,
    );
    if (circleRow) {
      circleRow.classList.add("expanded");
      const panelHtml = renderItemPanel(expandedCircleIdx);
      if (panelHtml) {
        const temp = document.createElement("template");
        temp.innerHTML = panelHtml;
        const panelRow = temp.content.firstElementChild as HTMLElement;
        circleRow.after(panelRow);
      }
    }
  }

  // 3. 新パネルにイベントリスナーを付与
  attachItemPanelListeners();
  // 仮想windowでは展開パネルが可変高さのため、bottom spacerも再計算する。
  // tableState/expandedCircleIdxは外部に保持されるので再描画しても編集状態を失わない。
  if (
    tableState.rows.length > TABLE_WINDOW_SIZE &&
    !tableWindowRerenderQueued
  ) {
    tableWindowRerenderQueued = true;
    requestAnimationFrame(() => {
      tableWindowRerenderQueued = false;
      renderCircleEditor();
    });
  }
}

/** サークル名列のアイテム数バッジを更新する */
function updateItemCountBadge(circleIdx: number) {
  const row = circleEditorEl.querySelector<HTMLTableRowElement>(
    `tr.circle-row[data-circle-row="${circleIdx}"]`,
  );
  if (!row) return;
  const count = parseInt(tableState.rows[circleIdx]?.["_itemCount"] || "0");
  const existing = row.querySelector(".item-count-badge");
  if (count > 0) {
    if (existing) {
      existing.textContent = String(count);
    } else {
      // サークル名列のtdに追加
      const nameTd = Array.from(row.querySelectorAll("td")).find((td) => {
        const input = td.querySelector("input");
        return input && input.dataset.col === "サークル名";
      });
      if (nameTd) {
        const badge = document.createElement("span");
        badge.className = "item-count-badge";
        badge.textContent = String(count);
        nameTd.appendChild(badge);
      }
    }
  } else {
    if (existing) existing.remove();
  }
}

/** アイテムパネル内のイベントリスナーを付与する */
function attachItemPanelListeners() {
  // アイテム行D&D並び替え
  let dragSrcItemIdx = -1;
  let dragSrcCircleIdx = -1;
  circleEditorEl
    .querySelectorAll<HTMLTableRowElement>("tr.item-draggable-row")
    .forEach((row) => {
      if ((row as any)._dragBound) return;
      (row as any)._dragBound = true;

      row.addEventListener("dragstart", (e) => {
        // input/selectにフォーカスがある場合はD&Dを開始しない
        const active = document.activeElement;
        if (
          active &&
          row.contains(active) &&
          (active.tagName === "INPUT" ||
            active.tagName === "SELECT" ||
            active.tagName === "TEXTAREA")
        ) {
          e.preventDefault();
          return;
        }
        dragSrcCircleIdx = Number(row.dataset.circle);
        dragSrcItemIdx = Number(row.dataset.item);
        row.classList.add("item-dragging");
        e.dataTransfer!.effectAllowed = "move";
        e.dataTransfer!.setData("text/plain", String(dragSrcItemIdx));
      });

      row.addEventListener("dragend", () => {
        row.classList.remove("item-dragging");
        circleEditorEl
          .querySelectorAll(".item-drag-over")
          .forEach((r) => r.classList.remove("item-drag-over"));
      });

      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer!.dropEffect = "move";
        const ci = Number(row.dataset.circle);
        if (ci !== dragSrcCircleIdx) return;
        circleEditorEl
          .querySelectorAll(".item-drag-over")
          .forEach((r) => r.classList.remove("item-drag-over"));
        row.classList.add("item-drag-over");
      });

      row.addEventListener("dragleave", () => {
        row.classList.remove("item-drag-over");
      });

      row.addEventListener("drop", (e) => {
        e.preventDefault();
        row.classList.remove("item-drag-over");
        const ci = Number(row.dataset.circle);
        const targetIdx = Number(row.dataset.item);
        if (ci !== dragSrcCircleIdx || targetIdx === dragSrcItemIdx) return;
        if (!eventJsonData) return;
        const c = eventJsonData.circles[ci];
        if (!c || !c.items) return;
        // 配列内で要素を移動
        const [moved] = c.items.splice(dragSrcItemIdx, 1);
        c.items.splice(targetIdx, 0, moved);
        // tableStateも同期
        tableState.rows[ci]["アイテムタグ"] = c.items
          .map((it: any) => it.type || it.genre || "")
          .join(", ");
        saveNow();
        toggleItemPanelInPlace();
      });
    });

  // アイテム編集フィールド
  circleEditorEl
    .querySelectorAll<
      HTMLInputElement | HTMLSelectElement
    >("input.item-field, select.item-field")
    .forEach((el) => {
      if ((el as any)._itemBound) return; // 二重バインド防止
      (el as any)._itemBound = true;
      const applyItemFieldValue = (): {
        ci: number;
        field: string;
        c: any;
      } | null => {
        const ci = Number(el.dataset.circle);
        const ii = Number(el.dataset.item);
        const field = String(el.dataset.field);
        if (!eventJsonData) return null;
        const c = eventJsonData.circles[ci];
        if (!c || !c.items || !c.items[ii]) return null;
        if (field === "price") {
          const v = parseFloat(el.value);
          c.items[ii].price = isNaN(v) ? null : v;
        } else {
          c.items[ii][field] = el.value;
        }
        tableState.rows[ci]["_itemCount"] = String(c.items.length);
        tableState.rows[ci]["アイテムタグ"] = c.items
          .map((it: any) => it.type || it.genre || "")
          .join(", ");
        return { ci, field, c };
      };
      // virtual table再描画・スクロールでinput DOMが差し替わっても、
      // 入力途中の値をeventJsonDataへ即時反映して失わない。保存/副作用は
      // change時だけ行い、入力のたびにIPCを発生させない。
      el.addEventListener("input", () => {
        applyItemFieldValue();
      });
      el.addEventListener("change", async () => {
        const applied = applyItemFieldValue();
        if (!applied) return;
        saveNow();
        if (applied.field === "name") {
          await rebuildPurchasedItemIndex();
          if (expandedCircleIdx === applied.ci) {
            toggleItemPanelInPlace();
          }
        }
      });
      el.addEventListener("click", (e) => e.stopPropagation());
    });

  // アイテム画像セル
  circleEditorEl
    .querySelectorAll<HTMLTableCellElement>("td.item-img-cell")
    .forEach((cell) => {
      if ((cell as any)._itemBound) return;
      (cell as any)._itemBound = true;
      cell.addEventListener("click", async (e) => {
        e.stopPropagation();
        const ci = Number(cell.dataset.circle);
        const ii = Number(cell.dataset.item);
        if (!eventJsonData) return;
        const c = eventJsonData.circles[ci];
        if (!c || !c.items || !c.items[ii]) return;
        const currentImg = c.items[ii].image || "";
        if (currentImg) {
          // 画像あり → 拡大表示
          showImageModal(resolveImageSrc(currentImg));
        } else {
          // 画像なし → ファイル選択
          const guard = captureEventAsyncMutationGuard(ci, ii);
          if (!guard) return;
          const activeEv = activeEventSlug
            ? eventList.find((ev) => ev.slug === activeEventSlug)
            : null;
          const destDir = activeEv?.dir
            ? eventAssetDir(activeEv.dir, "items")
            : "";
          const selected = await dialogOpen({
            multiple: false,
            filters: [{ name: "画像ファイル", extensions: IMAGE_EXTENSIONS }],
          });
          if (!guard.isCurrent()) return;
          if (selected && typeof selected === "string") {
            const fileName =
              selected.replace(/\\/g, "/").split("/").pop() || selected;
            try {
              await invokeActiveEventAssetWrite("copy_file_to_dir", {
                sourcePath: selected,
                destDir,
              });
            } catch (error) {
              resultEl.textContent = `画像コピー失敗: ${String(error)}`;
              return;
            }
            if (!guard.isCurrent()) return;
            c.items[ii].image = eventRelativeAssetPath("items", fileName);
            saveNow();
            toggleItemPanelInPlace();
          }
        }
      });
      cell.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        cell.classList.add("drag-over");
      });
      cell.addEventListener("dragleave", (e) => {
        e.stopPropagation();
        cell.classList.remove("drag-over");
      });
      cell.addEventListener("drop", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        cell.classList.remove("drag-over");
        const dt = e.dataTransfer;
        if (!dt) return;
        await applyDroppedImageToItemCell(cell, dt);
      });
      // 右クリック → コンテキストメニュー（差替/削除）
      cell.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const ci = Number(cell.dataset.circle);
        const ii = Number(cell.dataset.item);
        if (!eventJsonData) return;
        const c = eventJsonData.circles[ci];
        if (!c || !c.items || !c.items[ii]) return;
        const hasImg = !!c.items[ii].image;
        document.querySelectorAll(".ctx-menu").forEach((m) => m.remove());
        const menu = document.createElement("div");
        menu.className = "ctx-menu";
        menu.style.left = `${e.clientX}px`;
        menu.style.top = `${e.clientY}px`;
        if (hasImg) {
          const viewItem = document.createElement("div");
          viewItem.textContent = "拡大表示";
          viewItem.addEventListener("click", () => {
            menu.remove();
            showImageModal(resolveImageSrc(c.items[ii].image));
          });
          menu.appendChild(viewItem);
          const replaceItem = document.createElement("div");
          replaceItem.textContent = "差し替え";
          replaceItem.addEventListener("click", async () => {
            menu.remove();
            const guard = captureEventAsyncMutationGuard(ci, ii);
            if (!guard) return;
            const activeEv = activeEventSlug
              ? eventList.find((ev) => ev.slug === activeEventSlug)
              : null;
            const destDir = activeEv?.dir
              ? eventAssetDir(activeEv.dir, "items")
              : "";
            const selected = await dialogOpen({
              multiple: false,
              filters: [{ name: "画像ファイル", extensions: IMAGE_EXTENSIONS }],
            });
            if (!guard.isCurrent()) return;
            if (selected && typeof selected === "string") {
              const fileName =
                selected.replace(/\\/g, "/").split("/").pop() || selected;
              try {
                await invokeActiveEventAssetWrite("copy_file_to_dir", {
                  sourcePath: selected,
                  destDir,
                });
              } catch (error) {
                resultEl.textContent = `画像コピー失敗: ${String(error)}`;
                return;
              }
              if (!guard.isCurrent()) return;
              c.items[ii].image = eventRelativeAssetPath("items", fileName);
              saveNow();
              toggleItemPanelInPlace();
            }
          });
          menu.appendChild(replaceItem);
          const deleteItem = document.createElement("div");
          deleteItem.textContent = "削除";
          deleteItem.addEventListener("click", () => {
            menu.remove();
            c.items[ii].image = "";
            saveNow();
            toggleItemPanelInPlace();
          });
          menu.appendChild(deleteItem);
        } else {
          const setItem = document.createElement("div");
          setItem.textContent = "画像を選択";
          setItem.addEventListener("click", () => {
            menu.remove();
            cell.click();
          });
          menu.appendChild(setItem);
        }
        document.body.appendChild(menu);
        document.addEventListener("click", () => menu.remove(), { once: true });
      });
    });

  // アイテム追加ボタン
  circleEditorEl
    .querySelectorAll<HTMLButtonElement>("button.item-add-btn")
    .forEach((btn) => {
      if ((btn as any)._itemBound) return;
      (btn as any)._itemBound = true;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const ci = Number(btn.dataset.circle);
        if (!eventJsonData) return;
        const c = eventJsonData.circles[ci];
        if (!c) return;
        if (!c.items) c.items = [];
        c.items.push({
          name: "",
          price: null,
          type: "",
          description: "",
          checked: 0,
        });
        tableState.rows[ci]["_itemCount"] = String(c.items.length);
        tableState.rows[ci]["アイテムタグ"] = c.items
          .map((it: any) => it.type || it.genre || "")
          .join(", ");
        updateItemCountBadge(ci);
        saveNow();
        // パネルだけ再描画（テーブル全体は再構築しない）
        toggleItemPanelInPlace();
      });
    });

  // アイテム購入ステータス（クリックサイクル）
  circleEditorEl
    .querySelectorAll<HTMLButtonElement>("button.item-check-cycle-btn")
    .forEach((btn) => {
      if ((btn as any)._itemBound) return;
      (btn as any)._itemBound = true;
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const ci = Number(btn.dataset.circle);
        const ii = Number(btn.dataset.item);
        if (!eventJsonData) return;
        const c = eventJsonData.circles[ci];
        if (!c || !c.items || !c.items[ii]) return;
        const current = normalizePurchaseStatus(btn.dataset.val);
        const next = nextPurchaseStatus(current);
        c.items[ii].checked = next;
        btn.dataset.val = String(next);
        const view = PURCHASE_STATUS_VIEWS[next];
        btn.textContent = `${view.icon} ${view.label}`;
        btn.style.borderColor = view.color;
        btn.style.color = view.color;
        saveNow();
        const td = btn.closest("td");
        if (td) {
          td.style.background = view.bg;
        }
        await rebuildPurchasedItemIndex();
        if (expandedCircleIdx === ci) {
          toggleItemPanelInPlace();
        }
      });
    });

  // アイテム削除ボタン
  circleEditorEl
    .querySelectorAll<HTMLButtonElement>("button.item-delete-btn")
    .forEach((btn) => {
      if ((btn as any)._itemBound) return;
      (btn as any)._itemBound = true;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const ci = Number(btn.dataset.circle);
        const ii = Number(btn.dataset.item);
        if (!eventJsonData) return;
        const c = eventJsonData.circles[ci];
        if (!c || !c.items) return;
        c.items.splice(ii, 1);
        tableState.rows[ci]["_itemCount"] = String(c.items.length);
        // 保存用snapshotでtableStateのアイテムタグが再追加されるのを防ぐ
        tableState.rows[ci]["アイテムタグ"] = c.items
          .map((it: any) => it.type || it.genre || "")
          .join(", ");
        updateItemCountBadge(ci);
        saveNow();
        // パネルだけ再描画
        toggleItemPanelInPlace();
      });
    });

  // 感想ボタン（📝）
  circleEditorEl
    .querySelectorAll<HTMLButtonElement>("button.item-review-btn")
    .forEach((btn) => {
      if ((btn as any)._itemBound) return;
      (btn as any)._itemBound = true;
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const foamDir = foamDirEl.value;
        if (!foamDir) {
          alert("設定タブで「感想フォルダ（Foam）」を設定してください。");
          return;
        }
        if (!eventJsonData) return;
        const ci = Number(btn.dataset.circle);
        const ii = Number(btn.dataset.item);
        const circle = eventJsonData.circles[ci];
        if (!circle) return;
        const item = circle.items?.[ii];
        if (!item || !item.name) {
          alert("アイテム名を入力してください。");
          return;
        }
        const eventName = eventJsonData.event?.name || "";
        if (!eventName) {
          alert("イベント名が設定されていません。");
          return;
        }
        btn.disabled = true;
        btn.textContent = "⏳";
        try {
          if (isDesktopDevBuild) {
            console.log("[感想] invoke開始", {
              foamDir,
              eventName,
              itemName: item.name,
              penname: circle.penname || "",
            });
          }
          const res = await invoke<{
            status: string;
            filePath: string;
            createdNew: boolean;
            alreadyExists: boolean;
          }>("append_review_entry", {
            foamDir: foamDir.replace(/\\/g, "/"),
            eventName,
            itemName: item.name,
            penname: circle.penname || "",
          });
          if (isDesktopDevBuild) console.log("[感想] invoke成功", res);
          await invoke("open_file_default", { filePath: res.filePath });
          btn.textContent = "✓";
          setTimeout(() => {
            btn.textContent = "📝";
            btn.disabled = false;
          }, 1500);
        } catch (err: any) {
          console.error("[感想] invokeエラー", err);
          alert(`感想追記エラー: ${err}`);
          btn.textContent = "📝";
          btn.disabled = false;
        }
      });
    });
}

(
  document.getElementById("loadConfigBtn") as HTMLButtonElement
).addEventListener("click", loadConfig);
(
  document.getElementById("saveConfigBtn") as HTMLButtonElement
).addEventListener("click", saveConfig);
unlimitedOcrDoctorBtn?.addEventListener("click", runUnlimitedOcrDoctor);
refreshModelCatalogBtn?.addEventListener("click", () => loadModelCatalog());
(document.getElementById("pingBtn") as HTMLButtonElement).addEventListener(
  "click",
  () => runJob("ping", {}),
);
(document.getElementById("listJobsBtn") as HTMLButtonElement).addEventListener(
  "click",
  () => runJob("list_jobs", {}),
);

function setEventPipelineButtonsDisabled(disabled: boolean): void {
  (document.getElementById("runExtractBtn") as HTMLButtonElement).disabled = disabled;
  (document.getElementById("runPipelineBtn") as HTMLButtonElement).disabled = disabled;
  for (const element of document.querySelectorAll<HTMLElement>(
    "#eventList, .tab-pane",
  )) {
    element.inert = disabled;
    element.setAttribute("aria-busy", disabled ? "true" : "false");
  }
}

(
  document.getElementById("runExtractBtn") as HTMLButtonElement
).addEventListener("click", async () => {
  if (!canStartPipeline(operationState)) {
    resultEl.textContent = "別のイベント処理を実行中です。完了後に再実行してください。";
    return;
  }
  applyOperationEvent({ type: "request-pipeline" });
  setEventPipelineButtonsDisabled(true);
  try {
  const pendingCrawlMeta = captureCrawlMetaSnapshot();
  cancelCrawlMetaSave();
  await flushCrawlMetaSnapshot(pendingCrawlMeta, INTERNAL_OPERATION_SAVE);
  const eventSlug = activeEventSlug;
  const outputDir = getActiveEventDir();
  const eventFile = (
    document.getElementById("eventJsonHidden") as HTMLInputElement
  ).value.trim();
  if (!eventSlug || !outputDir || !eventFile || !eventJsonData) {
    resultEl.textContent =
      "既存イベントが選択されていません。イベントを選択してから実行してください。";
    return;
  }
  const normalizedEventFile = eventFile.replace(/\\/g, "/").toLowerCase();
  const expectedEventFile = `${outputDir.replace(/[\\/]+$/, "")}/event.json`
    .replace(/\\/g, "/")
    .toLowerCase();
  if (normalizedEventFile !== expectedEventFile) {
    resultEl.textContent =
      "選択イベントとevent.jsonのパスが一致しないため、Twitterお品書き抽出を中止しました。イベントを選び直してください。";
    return;
  }

  // 画面上の編集内容をevent.jsonへ反映してから、未取得サークルだけを再処理する。
  const initialSave = await saveNow(INTERNAL_OPERATION_SAVE);
  if (!initialSave.ok) {
    resultEl.textContent = `実行前のevent.json保存に失敗しました: ${String(initialSave.error)}`;
    return;
  }
  if (activeEventSlug !== eventSlug) {
    resultEl.textContent =
      "保存中に選択イベントが切り替わったため、Twitterお品書き抽出を中止しました。";
    return;
  }
  const payload = buildPipelinePayload();
  if (!isValidEventDate(payload.event_date)) {
    resultEl.textContent =
      "イベント日が未設定または不正です。YYYY-MM-DD形式で設定してから実行してください。";
    return;
  }
  payload.output_dir = outputDir;
  payload.enable_twitter_catalog = true;
  payload.reprocess = true;
  payload.regenerate_coordinates = false;
  payload.urls = [];
  payload.event_sources = [];
  applyOperationEvent({ type: "pipeline-started" });
  await runJob("run_main_pipeline", payload, true);
  const processingLog = resultEl.textContent;
  const shouldReloadSelectedEvent = activeEventSlug === eventSlug;
  await loadEventList();
  if (shouldReloadSelectedEvent) {
    await selectEvent(eventSlug, INTERNAL_OPERATION_SAVE);
  }
  resultEl.textContent = processingLog;
  } finally {
    if (isPipelineOperation(operationState)) {
      applyOperationEvent({ type: "finish-pipeline" });
    }
    setEventPipelineButtonsDisabled(false);
  }
});

/** パイプライン共通ペイロードを構築 */
function normalizeDateInputValue(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!match) return trimmed;
  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function parseEventUrlList(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const matches = value.match(/https?:\/\/[^\s,]+/g) || [];
  const urls: string[] = [];
  for (const rawUrl of matches) {
    const url = rawUrl.trim().replace(/[,\]\)\};]+$/, "");
    if (url && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

function eventUrlListText(urls: unknown): string {
  if (!Array.isArray(urls)) return "";
  return urls.filter((url): url is string => typeof url === "string" && !!url.trim()).join("\n");
}

type EventSourcePayload = {
  url: string;
  map_urls?: string[];
  catalog_additional_prompt?: string;
};

function pushUnique(target: string[], values: string[]) {
  for (const value of values) {
    if (value && !target.includes(value)) target.push(value);
  }
}

function parseEventMapConfig(
  raw: string,
  sourceUrls: string[],
): { byUrl: Map<string, string[]>; allMapUrls: string[] } {
  const byUrl = new Map(sourceUrls.map((url) => [url, [] as string[]]));
  const plainMapUrls: string[] = [];
  let hasExplicitRule = false;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(.*?)\s*(?:=>|->)\s*(.*)$/);
    if (match) {
      hasExplicitRule = true;
      const targets = parseEventUrlList(match[1]).filter((url) =>
        sourceUrls.includes(url),
      );
      const mapUrls = parseEventUrlList(match[2]);
      for (const target of targets) {
        pushUnique(byUrl.get(target) ?? [], mapUrls);
      }
      continue;
    }
    pushUnique(plainMapUrls, parseEventUrlList(line));
  }

  if (plainMapUrls.length) {
    if (!hasExplicitRule && sourceUrls.length > 1 && plainMapUrls.length === sourceUrls.length) {
      sourceUrls.forEach((url, index) => pushUnique(byUrl.get(url) ?? [], [plainMapUrls[index]]));
    } else {
      sourceUrls.forEach((url) => pushUnique(byUrl.get(url) ?? [], plainMapUrls));
    }
  }

  const allMapUrls: string[] = [];
  byUrl.forEach((urls) => pushUnique(allMapUrls, urls));
  return { byUrl, allMapUrls };
}

type EventPromptConfig = {
  commonPrompt: string;
  sourcePrompts: Map<string, string>;
  hasSourceSections: boolean;
};

let loadedConfigSourcePrompts = new Map<string, string>();

function parseEventPromptConfig(
  raw: string,
  sourceUrls: string[],
): EventPromptConfig {
  const globalLines: string[] = [];
  const sourceLines = new Map(sourceUrls.map((url) => [url, [] as string[]]));
  let targets: string[] | null = null;
  let hasSourceSections = false;

  for (const line of raw.split(/\r?\n/)) {
    const section = line.match(/^\s*\[(.+?)\]\s*$/);
    if (section) {
      const label = section[1].trim().toLowerCase();
      targets =
        label === "default" || label === "common"
          ? []
          : parseEventUrlList(section[1]).filter((url) => sourceUrls.includes(url));
      if (targets.length > 0) hasSourceSections = true;
      continue;
    }
    if (targets === null || targets.length === 0) {
      globalLines.push(line);
    } else {
      targets.forEach((url) => sourceLines.get(url)?.push(line));
    }
  }

  const globalPrompt = globalLines.join("\n").trim();
  const sourcePrompts = new Map<string, string>();
  sourceUrls.forEach((url) => {
    const sourcePrompt = (sourceLines.get(url) ?? []).join("\n").trim();
    if (sourcePrompt) sourcePrompts.set(url, sourcePrompt);
  });
  return { commonPrompt: globalPrompt, sourcePrompts, hasSourceSections };
}

function buildEventSourcesPayload(
  sourceUrls: string[],
  mapRaw: string,
  promptRaw: string,
): { eventSources: EventSourcePayload[]; mapUrls: string[] } {
  const mapConfig = parseEventMapConfig(mapRaw, sourceUrls);
  const promptConfig = parseEventPromptConfig(promptRaw, sourceUrls);
  const eventSources = sourceUrls.map((url) => {
    const source: EventSourcePayload = { url };
    const mapUrls = mapConfig.byUrl.get(url) ?? [];
    if (mapUrls.length) source.map_urls = mapUrls;
    const explicitSourcePrompt = promptConfig.sourcePrompts.get(url)?.trim() || "";
    const preservedSourcePrompt = loadedConfigSourcePrompts.get(url)?.trim() || "";
    const prompt =
      promptConfig.hasSourceSections && explicitSourcePrompt
        ? [promptConfig.commonPrompt, explicitSourcePrompt].filter(Boolean).join("\n\n")
        : preservedSourcePrompt || promptConfig.commonPrompt;
    if (prompt) source.catalog_additional_prompt = prompt;
    return source;
  });
  return { eventSources, mapUrls: mapConfig.allMapUrls };
}

function buildPipelinePayload() {
  const textProvider = selectedTextProvider();
  const imageConfig = selectedImageConfig();
  const textEffort = selectedTextEffort();
  const event = eventJsonData?.event || {};
  const eventUrlRaw =
    (document.getElementById("eventUrl") as HTMLInputElement).value.trim() ||
    eventUrlListText(event.source_urls) ||
    (typeof event.url === "string" ? event.url.trim() : "");
  const eventUrls = parseEventUrlList(eventUrlRaw);
  const eventUrl = eventUrls[0] || eventUrlRaw.trim();
  const sourceUrls = eventUrls.length ? eventUrls : eventUrl ? [eventUrl] : [];
  const mapRaw = (document.getElementById("mapUrl") as HTMLTextAreaElement).value;
  const additionalPrompt = displayAdditionalPromptText(
    (document.getElementById("additionalPrompt") as HTMLTextAreaElement).value,
  );
  const sourceConfig = buildEventSourcesPayload(sourceUrls, mapRaw, additionalPrompt);
  const eventDate =
    (document.getElementById("eventDate") as HTMLInputElement).value ||
    normalizeDateInputValue(event.date);
  const eventNameInput = (
    document.getElementById("eventName") as HTMLInputElement
  ).value.trim();
  const eventName =
    eventNameInput && eventNameInput !== NEW_EVENT_NAME
      ? eventNameInput
      : typeof event.name === "string"
        ? event.name.trim()
        : "";
  return {
    project_root: projectRootEl.value,
    url: eventUrl,
    urls: sourceUrls,
    event_sources: sourceConfig.eventSources,
    model: selectedTextApiModels().join(","),
    output_dir: (
      document.getElementById("pipelineOutputDir") as HTMLInputElement
    ).value,
    text_llm_provider: textProvider.kind === "cli" ? textProvider.provider : "api",
    text_llm_cli_models: selectedTextCliModelMap(),
    text_llm_cli_efforts: selectedTextCliEffortMap(),
    text_llm_cli_timeout: 900,
    api_reasoning_effort: textEffort,
    api_reasoning_effort_map: selectedTextApiEffortMap(),
    text_fallback_llm_provider: providerConfigValue(selectedTextFallbackProvider()),
    text_fallback_llm_model: selectedTextFallbackModel(),
    text_fallback_llm_effort: selectedTextFallbackEffort(),
    image_llm_provider: imageConfig.provider,
    image_llm_model: imageConfig.model,
    image_llm_effort: imageConfig.effort,
    image_fallback_llm_provider: providerConfigValue(selectedImageFallbackProvider()),
    image_fallback_llm_model: selectedImageFallbackModel(),
    image_fallback_llm_effort: selectedImageFallbackEffort(),
    image_api_reasoning_effort_map: selectedImageApiEffortMap(),
    map_url: sourceConfig.mapUrls[0] || "",
    map_urls: sourceConfig.mapUrls,
    enable_twitter_catalog: boolFromSelect("enableTwitter"),
    tweet_llm_cli_providers: selectedTweetProviders(),
    tweet_llm_cli_models: selectedTweetModelMap(),
    tweet_llm_cli_efforts: selectedTweetEffortMap(),
    tweet_llm_cli_timeout: 900,
    reprocess: boolFromSelect("reprocess"),
    regenerate_coordinates: boolFromSelect("regen"),
    skip_circle_images: boolFromSelect("skipCircleImages"),
    verbose: boolFromSelect("verbose"),
    event_date: eventDate,
    event_name: eventName,
    catalog_additional_prompt: additionalPrompt,
    cookie_file: getCookieFilePathForRun(),
    days_before: Number(
      (document.getElementById("daysBefore") as HTMLInputElement)?.value || "30",
    ),
    days_after: Number(
      (document.getElementById("daysAfter") as HTMLInputElement)?.value || "7",
    ),
    // 通常の run_main_pipeline 経路でも OCR 設定を保持する。auto_place の
    // 専用経路だけに渡すと GUIで選んだモデル/venvが座標再生成時に失われる。
    ocr_config: currentOcrConfigPayload(),
  };
}

function isValidEventDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

(
  document.getElementById("runPipelineBtn") as HTMLButtonElement
).addEventListener("click", async () => {
  if (!canStartPipeline(operationState)) {
    resultEl.textContent = "別のイベント処理を実行中です。完了後に再実行してください。";
    return;
  }
  applyOperationEvent({ type: "request-pipeline" });
  setEventPipelineButtonsDisabled(true);
  try {
  const pendingCrawlMeta = captureCrawlMetaSnapshot();
  cancelCrawlMetaSave();
  await flushCrawlMetaSnapshot(pendingCrawlMeta, INTERNAL_OPERATION_SAVE);
  const initialSave = await saveNow(INTERNAL_OPERATION_SAVE);
  if (!initialSave.ok) {
    resultEl.textContent = `実行前のevent.json保存に失敗しました: ${String(initialSave.error)}`;
    return;
  }
  applyOperationEvent({ type: "pipeline-started" });
  const payload = buildPipelinePayload();
  if (!payload.url) {
    resultEl.textContent =
      "イベントURLが未設定です。イベントURLを入力してから実行してください。";
    return;
  }

  // クロール実行前: URLの不一致チェック
  if (activeEventSlug && payload.url) {
    const ev = eventList.find((e) => e.slug === activeEventSlug);
    const savedUrls = ev?.meta.event_urls?.length
      ? ev.meta.event_urls
      : ev?.meta.event_url
        ? [ev.meta.event_url]
        : [];
    const savedUrl = savedUrls.map((url) => url.replace(/\/+$/, "")).join("\n");
    const formUrls = (payload.urls?.length ? payload.urls : [payload.url]) as string[];
    const formUrl = formUrls.map((url) => url.replace(/\/+$/, "")).join("\n");
    if (savedUrl && savedUrl !== formUrl) {
      const choice = await showCrawlMismatchDialog(
        formUrl,
        savedUrl,
        ev?.meta.name || activeEventSlug,
      );
      if (choice === "cancel") {
        resultEl.textContent = "パイプラインをキャンセルしました。";
        return;
      }
      if (choice === "new_event") {
        const now = new Date();
        const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
        const newSlug = !isPlaceholderEventName(payload.event_name)
          ? generateSlugFromName(payload.event_name, payload.event_date)
          : `new_event_${ts}`;
        try {
          const res = await runEventDocumentSerial(async () => {
            const created = await invoke<{ status: string; dir: string }>(
              "create_event_dir",
              { projectRoot: projectRootEl.value, slug: newSlug },
            );
            eventLifecycleGate.open(eventMetaOwnerKey(newSlug, created.dir));
            await writeEventMetaSnapshot(
              { slug: newSlug, dir: created.dir },
              {
              name: isPlaceholderEventName(payload.event_name)
                ? NEW_EVENT_NAME
                : payload.event_name,
              date: payload.event_date || null,
              event_url: formUrls[0] || null,
              event_urls: formUrls.length ? formUrls : null,
              created_at: new Date().toISOString(),
              source: "desktop_created",
              },
              { requireListedOwner: false, commitToEventList: false },
            );
            await loadEventList();
            return created;
          });
          await selectEvent(newSlug, INTERNAL_OPERATION_SAVE);
          payload.output_dir = res.dir;
        } catch (e) {
          resultEl.textContent = `新規イベント作成エラー: ${String(e)}`;
          return;
        }
      }
      if (choice === "overwrite" && ev) {
        const nextMeta = {
          ...cloneJsonSnapshot(ev.meta),
          event_url: formUrls[0],
          event_urls: formUrls,
        };
        try {
          await writeEventMetaSnapshot(ev, nextMeta);
        } catch (error) {
          resultEl.textContent = `イベントURL保存エラー: ${String(error)}`;
          return;
        }
      }
    }
  }

  // テーブル・画像表示をクリアしてファイルロックを解放
  tableState = { headers: [], rows: [] };
  circleEditorEl.innerHTML = "<p class='small'>パイプライン実行中...</p>";

  // クロール情報をメタデータに保存（実行前に確定）
  if (activeEventSlug) {
    const ev = eventList.find((e) => e.slug === activeEventSlug);
    if (ev) {
      const mapInput = (document.getElementById("mapUrl") as HTMLTextAreaElement).value;
      const mapConfig = parseEventMapConfig(mapInput, payload.urls || []);
      const nextMeta = {
        ...cloneJsonSnapshot(ev.meta),
        event_url: payload.url || null,
        event_urls: payload.urls?.length ? payload.urls : null,
        map_config:
          (payload.urls?.length || 0) > 1 ? mapInput || null : null,
        map_url: mapConfig.allMapUrls[0] || mapInput || null,
        additional_prompt: payload.catalog_additional_prompt || null,
      };
      try {
        await writeEventMetaSnapshot(ev, nextMeta);
      } catch (error) {
        resultEl.textContent = `クロール情報保存エラー: ${String(error)}`;
        return;
      }
    }
  }

  // 再処理モードの場合はプレビューなしで直接実行
  if (boolFromSelect("reprocess")) {
    await runJob("run_main_pipeline", payload, true);
    await loadEventList();
    if (activeEventSlug) {
      const completedEventSlug = activeEventSlug;
      const reloadSucceeded = await selectEvent(
        completedEventSlug,
        INTERNAL_OPERATION_SAVE,
      );
      if (
        !reloadSucceeded ||
        !isActiveEventDocumentOwned(completedEventSlug)
      ) {
        resultEl.textContent =
          "パイプライン完了後のイベント再読み込みに失敗しました。";
      }
    }
    return;
  }

  // Phase 1: プレビュー用パースのみ（画像DLなし）
  resultEl.textContent = "サイトを解析中...";
  let parseResult: any = null;
  if ((payload.urls?.length || 0) > 1) {
    resultEl.textContent = `${payload.urls.length} 件のイベントを1つにまとめて実行します...`;
  } else {
  try {
    parseResult = (await runJob("parse_site_preview", {
      project_root: payload.project_root,
      url: payload.url,
      model: payload.model,
      text_llm_provider: payload.text_llm_provider,
      text_llm_cli_models: payload.text_llm_cli_models,
      text_llm_cli_efforts: payload.text_llm_cli_efforts,
      text_llm_cli_timeout: payload.text_llm_cli_timeout,
      api_reasoning_effort: payload.api_reasoning_effort,
      api_reasoning_effort_map: payload.api_reasoning_effort_map,
      text_fallback_llm_provider: payload.text_fallback_llm_provider,
      text_fallback_llm_model: payload.text_fallback_llm_model,
      text_fallback_llm_effort: payload.text_fallback_llm_effort,
      image_llm_provider: payload.image_llm_provider,
      image_llm_model: payload.image_llm_model,
      image_llm_effort: payload.image_llm_effort,
      image_fallback_llm_provider: payload.image_fallback_llm_provider,
      image_fallback_llm_model: payload.image_fallback_llm_model,
      image_fallback_llm_effort: payload.image_fallback_llm_effort,
      image_api_reasoning_effort_map: payload.image_api_reasoning_effort_map,
      catalog_additional_prompt: payload.catalog_additional_prompt,
      cookie_file: payload.cookie_file,
    })) as any;
  } catch (e) {
    resultEl.textContent = `プレビュー解析失敗: ${String(e)}。フルパイプラインを実行します...`;
    parseResult = null;
  }

  // GenericAdapterの場合はプレビューモーダルを表示
  if (
    parseResult?.status === "ok" &&
    parseResult.adapter_type === "GenericAdapter" &&
    parseResult.circles?.length > 0
  ) {
    const approved = await showScrapePreviewModalAsync(
      parseResult.circles,
      parseResult.html_context,
      payload,
    );
    if (!approved) {
      resultEl.textContent = "パイプラインをキャンセルしました。";
      circleEditorEl.innerHTML = "";
      return;
    }
  }

  // Phase 2: フルパイプライン
  resultEl.textContent = "フルパイプライン実行中...";
  }
  await runJob("run_main_pipeline", payload, true);
  await loadEventList();
  if (activeEventSlug) {
    const completedEventSlug = activeEventSlug;
    const reloadSucceeded = await selectEvent(
      completedEventSlug,
      INTERNAL_OPERATION_SAVE,
    );
    if (
      !reloadSucceeded ||
      !isActiveEventDocumentOwned(completedEventSlug)
    ) {
      resultEl.textContent =
        "パイプライン完了後のイベント再読み込みに失敗したため、後続処理を中止しました。";
      return;
    }
  }

  // パイプライン完了後: フォルダ名リネーム（スクレイピングで名前が取得された場合）
  if (activeEventSlug) {
    const ev = eventList.find((e) => e.slug === activeEventSlug);
    if (ev?.meta.name && !isPlaceholderEventName(ev.meta.name)) {
      const newSlug = await renameEventDir(
        activeEventSlug,
        ev.meta.name,
        ev.meta.date ?? undefined,
      );
      if (newSlug) {
        await loadEventList();
        await selectEvent(newSlug, INTERNAL_OPERATION_SAVE);
      }
    }
  }

  // イベントURLをイベントメモに自動記載（メモが空の場合のみ）
  if (eventJsonData) {
    const eventUrl = (
      document.getElementById("eventUrl") as HTMLInputElement
    ).value.trim();
    const eventUrls = parseEventUrlList(eventUrl);
    if (eventUrl && !eventJsonData.event?.memo) {
      if (!eventJsonData.event) eventJsonData.event = {};
      if (eventUrls.length) eventJsonData.event.source_urls = eventUrls;
      eventJsonData.event.memo = eventUrl;
      updateEventMemoUI();
      scheduleAutoSave();
    }
  }
  } finally {
    if (isPipelineOperation(operationState)) {
      applyOperationEvent({ type: "finish-pipeline" });
    }
    setEventPipelineButtonsDisabled(false);
  }
});

/** プレビューテーブルのHTML生成 */
function buildPreviewTableHtml(circles: any[]): string {
  const rows = circles
    .slice(0, 15)
    .map(
      (c: any, i: number) =>
        `<tr><td>${i + 1}</td><td>${escapeHtml(c.name || "(空)")}</td><td>${escapeHtml(c.penname || "(空)")}</td><td>${escapeHtml(c.space || "(空)")}</td><td>${escapeHtml(c.twitter_url || c.website_url || "(なし)")}</td></tr>`,
    )
    .join("");
  return `
    <table>
      <thead><tr><th>#</th><th>サークル名</th><th>ペンネーム</th><th>スペース</th><th>URL</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${circles.length > 15 ? `<p class="scrape-more">...他 ${circles.length - 15} サークル</p>` : ""}
  `;
}

/** インタラクティブスクレイピングプレビューモーダル（Promise版） */
function showScrapePreviewModalAsync(
  circles: any[],
  htmlContext: string,
  pipelinePayload: any,
): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "img-modal-overlay";
    overlay.style.cursor = "default";
    overlay.style.alignItems = "flex-start";
    overlay.style.justifyContent = "center";
    overlay.style.paddingTop = "5vh";

    const container = document.createElement("div");
    container.className = "scrape-dialog";

    let currentCircles = circles;
    let currentHtmlContext = htmlContext;

    function render() {
      container.innerHTML = `
        <h3>スクレイピング結果の確認</h3>
        <p class="scrape-warning">初めてのイベントサイトのようです。結果が正しいか確認してください。</p>
        <p>取得サークル数: <strong>${currentCircles.length}</strong></p>
        <div id="scrapePreviewTable">${buildPreviewTableHtml(currentCircles)}</div>
        <div id="scrapeFeedbackArea" style="display:none;">
          <label class="scrape-feedback-label">修正指示を入力してください:</label>
          <textarea id="scrapeFeedbackText" class="scrape-feedback-textarea" rows="3"
            placeholder="例: スペース番号が「A-01」形式になっていない。テーブルのヘッダー行が認識されていない。"></textarea>
          <div class="scrape-btn-group">
            <button id="scrapeRetryBtn" class="scrape-ok-btn">再パース</button>
            <button id="scrapeCancelFeedbackBtn" class="scrape-ng-btn">戻る</button>
          </div>
        </div>
        <div id="scrapeMainBtns" class="scrape-btn-group">
          <button id="scrapeOkBtn" class="scrape-ok-btn">問題なし（続行）</button>
          <button id="scrapeNgBtn" class="scrape-ng-btn">修正が必要</button>
          <button id="scrapeCancelBtn" class="scrape-cancel-btn">キャンセル</button>
        </div>
      `;

      // OK → フルパイプラインへ
      container.querySelector("#scrapeOkBtn")!.addEventListener("click", () => {
        overlay.remove();
        resolve(true);
      });

      // キャンセル
      container
        .querySelector("#scrapeCancelBtn")!
        .addEventListener("click", () => {
          overlay.remove();
          resolve(false);
        });

      // 修正が必要 → フィードバックエリア表示
      container.querySelector("#scrapeNgBtn")!.addEventListener("click", () => {
        (
          container.querySelector("#scrapeFeedbackArea") as HTMLElement
        ).style.display = "block";
        (
          container.querySelector("#scrapeMainBtns") as HTMLElement
        ).style.display = "none";
      });

      // フィードバック「戻る」
      container
        .querySelector("#scrapeCancelFeedbackBtn")!
        .addEventListener("click", () => {
          (
            container.querySelector("#scrapeFeedbackArea") as HTMLElement
          ).style.display = "none";
          (
            container.querySelector("#scrapeMainBtns") as HTMLElement
          ).style.display = "";
        });

      // 再パース
      container
        .querySelector("#scrapeRetryBtn")!
        .addEventListener("click", async () => {
          const feedbackText = (
            container.querySelector(
              "#scrapeFeedbackText",
            ) as HTMLTextAreaElement
          ).value.trim();
          if (!feedbackText) return;

          const retryBtn = container.querySelector(
            "#scrapeRetryBtn",
          ) as HTMLButtonElement;
          retryBtn.textContent = "再パース中...";
          retryBtn.disabled = true;

          try {
            const result = (await runJob("reparse_with_feedback", {
              project_root: pipelinePayload.project_root,
              html_context: currentHtmlContext,
              feedback: feedbackText,
              previous_result: currentCircles,
              model: pipelinePayload.model,
              text_llm_provider: pipelinePayload.text_llm_provider,
              text_llm_cli_models: pipelinePayload.text_llm_cli_models,
              text_llm_cli_efforts: pipelinePayload.text_llm_cli_efforts,
              text_llm_cli_timeout: pipelinePayload.text_llm_cli_timeout,
              api_reasoning_effort: pipelinePayload.api_reasoning_effort,
              api_reasoning_effort_map: pipelinePayload.api_reasoning_effort_map,
              text_fallback_llm_provider: pipelinePayload.text_fallback_llm_provider,
              text_fallback_llm_model: pipelinePayload.text_fallback_llm_model,
              text_fallback_llm_effort: pipelinePayload.text_fallback_llm_effort,
            })) as any;

            if (result?.circles?.length > 0) {
              currentCircles = result.circles as any[];
              if (result.html_context) {
                currentHtmlContext = result.html_context as string;
              }
              render(); // テーブルを再描画
            } else {
              retryBtn.textContent = "再パース（結果なし、再試行）";
              retryBtn.disabled = false;
            }
          } catch (e) {
            retryBtn.textContent = `失敗: ${String(e).slice(0, 30)}`;
            retryBtn.disabled = false;
          }
        });
    }

    render();
    overlay.appendChild(container);
    document.body.appendChild(overlay);
  });
}

// データ読み込みはselectEvent経由で自動実行される

// event.json自動保存（デバウンス付き）
let autoSaveTimer: number | null = null;
let autoSaveRequestGeneration = 0;
function cancelAutoSave(): void {
  autoSaveRequestGeneration += 1;
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = null;
}

function scheduleAutoSave() {
  if (isMapAutoOperation(operationState)) return;
  // input/change時点でrevisionを進め、同時進行中のload commitを拒否する。
  markEventDocumentMutated();
  const generation = ++autoSaveRequestGeneration;
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  const scheduledEventSlug = activeEventSlug;
  const scheduledEventJsonPath = editorJsonPathValue();
  autoSaveTimer = window.setTimeout(async () => {
    if (generation !== autoSaveRequestGeneration) return;
    autoSaveTimer = null;
    // 実行中に抑止して捨てず、排他状態がidleへ戻ってから保存する。
    while (!canAutoSave(operationState)) {
      await waitForOperationIdle();
    }
    if (
      generation !== autoSaveRequestGeneration ||
      activeEventSlug !== scheduledEventSlug ||
      editorJsonPathValue() !== scheduledEventJsonPath
    ) {
      return;
    }
    await saveNow();
  }, 1500);
}

// 手動保存ボタン（HTMLから削除済みだが安全のため）
document
  .getElementById("saveBtn")
  ?.addEventListener("click", () => scheduleAutoSave());

// === モバイル連携 ===

// アクティブイベントの情報を取得するヘルパー
function getActiveEventDir(): string {
  const ev = activeEventSlug
    ? eventList.find((e) => e.slug === activeEventSlug)
    : null;
  return ev?.dir ?? "";
}

function getActiveEventMeta(): EventMeta {
  const ev = activeEventSlug
    ? eventList.find((e) => e.slug === activeEventSlug)
    : null;
  return ev?.meta ?? {};
}

function getActiveEventJsonPath(): string {
  const dir = getActiveEventDir();
  return dir ? `${dir}/event.json`.replace(/\\/g, "/") : "";
}

function startMobileZipServer(zipPath: string): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>("start_file_server", {
    filePath: zipPath,
    cleanupOnStop: true,
  });
}

async function flushActiveEventForLifecycle(): Promise<void> {
  const saved = await saveNow(INTERNAL_OPERATION_SAVE);
  if (!saved.ok) throw new Error(`イベント保存に失敗しました: ${String(saved.error)}`);
  const slug = activeEventSlug;
  const ev = slug ? eventList.find((entry) => entry.slug === slug) : null;
  if (!ev) {
    await flushAllEventSavesOrThrow();
    return;
  }
  const key = eventMetaOwnerKey(ev.slug, ev.dir);
  await eventSaveQueue.flushKey(key);
  const status = eventSaveQueue.getStatus(key);
  if (status.error) throw new Error(`イベント保存キューに失敗しました: ${String(status.error)}`);
}

(document.getElementById("exportZipBtn") as HTMLButtonElement).addEventListener(
  "click",
  async () => {
    const eventDir = getActiveEventDir();
    if (!eventDir) {
      resultEl.textContent = "サイドバーでイベントを選択してください";
      return;
    }
    const eventJsonPath = getActiveEventJsonPath();
    const meta = getActiveEventMeta();
    const zipPath = `${eventDir}/mobile_export.zip`;

    resultEl.textContent = "ZIPファイル生成中...";
    try {
      await flushActiveEventForLifecycle();
    } catch (error) {
      resultEl.textContent = `ZIP生成前の保存に失敗しました: ${String(error)}`;
      return;
    }
    const res = await runJob("create_mobile_zip", {
      event_json: eventJsonPath,
      output_dir: eventDir,
      zip_output_path: zipPath,
    });

    if (res?.ok) {
      const b = res.bridge as any;
      resultEl.textContent = `ZIPエクスポート完了\n保存先: ${b.zip_path}\nサイズ: ${((b.total_size || 0) / 1024 / 1024).toFixed(1)} MB\nサークル画像: ${b.circle_images ?? 0}件\nアイテム画像: ${b.item_images ?? 0}件\nマップ画像: ${b.map_images ?? 0}件`;
    }
  },
);

(
  document.getElementById("sendToMobileBtn") as HTMLButtonElement
).addEventListener("click", async () => {
  const eventDir = getActiveEventDir();
  if (!eventDir) {
    resultEl.textContent = "サイドバーでイベントを選択してください";
    return;
  }
  const eventJsonPath = getActiveEventJsonPath();
  const meta = getActiveEventMeta();
  const zipPath = `${eventDir}/mobile_export.zip`;

  resultEl.textContent = "ZIPファイル生成中...";
  try {
    await flushActiveEventForLifecycle();
  } catch (error) {
    resultEl.textContent = `ZIP生成前の保存に失敗しました: ${String(error)}`;
    return;
  }
  const zipRes = await runJob("create_mobile_zip", {
    event_json: eventJsonPath,
    output_dir: eventDir,
    zip_output_path: zipPath,
  });

  if (!zipRes?.ok) return;

  resultEl.textContent = "HTTPサーバー起動中...";
  try {
    const serverRes = await startMobileZipServer(zipPath);
    if (serverRes.status === "ok") {
      const url = serverRes.url as string;
      const qrArea = document.getElementById("qrCodeArea")!;
      qrArea.style.display = "block";
      (document.getElementById("qrUrl") as HTMLElement).textContent = url;

      // QRコード描画
      const canvas = document.getElementById("qrCanvas") as HTMLCanvasElement;
      const QRCode = (await import("qrcode")).default;
      await QRCode.toCanvas(canvas, url, { width: 256, margin: 2 });

      resultEl.textContent = `モバイル転送サーバー起動中\nURL: ${url}\nスマホのアプリでQRコードをスキャンしてください`;
    }
  } catch (e) {
    resultEl.textContent = `サーバー起動エラー: ${String(e)}`;
  }
});

(
  document.getElementById("sendFullSyncToMobileBtn") as HTMLButtonElement
).addEventListener("click", async () => {
  if (eventList.length === 0) {
    resultEl.textContent = "同期できるイベントがありません";
    return;
  }

  const projectRoot = projectRootEl.value;

  const pendingCrawlMeta = captureCrawlMetaSnapshot();
  let zipRes: BridgeJobResult<Record<string, unknown>> | null = null;
  try {
    zipRes = await runManagedEventDocumentMutation(async () => {
      await flushCrawlMetaSnapshot(pendingCrawlMeta, INTERNAL_OPERATION_SAVE);
      const activeSave = await saveNow(INTERNAL_OPERATION_SAVE);
      if (!activeSave.ok) {
        throw new Error(`アクティブイベント保存失敗: ${String(activeSave.error)}`);
      }
      await flushAllEventSavesOrThrow();
      await preflightFullSyncEventUids();
      await flushAllEventSavesOrThrow();
      try {
        await invoke("stop_file_server");
      } catch {
        // stale server cleanup failures are harmless; start_file_server reports real errors.
      }
      // ZIP作成完了までevent editor/tabをinertに保ち、preflight済みの一貫した
      // disk snapshotへ後続edit/autosaveを混入させない。
      resultEl.textContent = "全イベント同期ZIPを作成中...";
      return runJob("create_mobile_full_sync_zip", {
        project_root: projectRoot,
      });
    });
  } catch (error) {
    resultEl.textContent = `全イベント同期前の保存に失敗しました: ${String(error)}`;
    return;
  }

  if (!zipRes?.ok) return;

  const b = zipRes.bridge as any;
  const zipPath = String(b?.zip_path || "").replace(/\\/g, "/");
  if (!zipPath) {
    resultEl.textContent = "Failed to get full sync ZIP path";
    return;
  }

  resultEl.textContent = "HTTPサーバー起動中...";
  try {
    const serverRes = await startMobileZipServer(zipPath);
    if (serverRes.status === "ok") {
      const url = serverRes.url as string;
      const qrArea = document.getElementById("qrCodeArea")!;
      qrArea.style.display = "block";
      (document.getElementById("qrUrl") as HTMLElement).textContent = url;

      const canvas = document.getElementById("qrCanvas") as HTMLCanvasElement;
      const QRCode = (await import("qrcode")).default;
      await QRCode.toCanvas(canvas, url, { width: 256, margin: 2 });

      resultEl.textContent =
        `全イベント同期サーバー起動中\nURL: ${url}\n` +
        `イベント: ${b.event_count ?? 0}件 / 画像: ${b.image_count ?? 0}件 / ` +
        `デフォルトカット: ${b.default_cut_count ?? 0}件\n` +
        `サイズ: ${((b.total_size || 0) / 1024 / 1024).toFixed(1)} MB\n` +
        "モバイルアプリでQRコードをスキャンしてください";
    }
  } catch (e) {
    resultEl.textContent = `サーバー起動エラー: ${String(e)}`;
  }
});

(
  document.getElementById("stopServerBtn") as HTMLButtonElement
).addEventListener("click", async () => {
  try {
    await invoke("stop_file_server");
    const qrArea = document.getElementById("qrCodeArea")!;
    qrArea.style.display = "none";
    resultEl.textContent = "サーバーを停止しました";
  } catch (e) {
    resultEl.textContent = `サーバー停止エラー: ${String(e)}`;
  }
});

function parseYamlValue(raw: string, key: string): string {
  const re = new RegExp(`^${key}:\\s*"?([^"\\n]*)"?`, "m");
  const m = raw.match(re);
  return m ? m[1].trim() : "";
}

function parseYamlList(raw: string, key: string): string[] {
  const re = new RegExp(`^${key}:\\s*\\n((?:\\s+-\\s+.*\\n?)*)`, "m");
  const m = raw.match(re);
  if (!m) return [];
  return m[1]
    .split("\n")
    .map((l) => {
      // `  - "gemini-3-flash-preview"  # 第1優先` → `gemini-3-flash-preview`
      let v = l.replace(/^\s*-\s*/, ""); // リストマーカー除去
      v = v.replace(/#.*$/, "").trim(); // コメント除去
      v = v.replace(/^["']+/, "").replace(/["']+$/, ""); // 前後のクォート除去
      return v.trim();
    })
    .filter((l) => l.length > 0);
}

function parseYamlBlock(raw: string, key: string): string {
  const re = new RegExp(`^${key}:\\s*\\|\\s*\\n((?:\\s+.*\\n?)*)`, "m");
  const m = raw.match(re);
  if (!m) return "";
  return m[1]
    .split("\n")
    .map((l) => l.replace(/^\s{2}/, ""))
    .join("\n")
    .trim();
}

function yamlLineIndent(line: string): number {
  const match = line.match(/^ */);
  return match ? match[0].length : 0;
}

function parseYamlScalar(value: string): string {
  let v = value.replace(/#.*$/, "").trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  }
  return v.replace(/\\"/g, '"').replace(/\\\\/g, "\\").trim();
}

function parseYamlEventSources(raw: string): EventSourcePayload[] {
  const lines = raw.split("\n");
  const startIndex = lines.findIndex((line) => /^event_sources:\s*$/.test(line));
  if (startIndex < 0) return [];

  const sources: EventSourcePayload[] = [];
  let current: EventSourcePayload | null = null;
  let listKey: "map_urls" | null = null;
  let blockKey: "catalog_additional_prompt" | null = null;
  let blockIndent = 0;
  let blockLines: string[] = [];

  const finishBlock = () => {
    if (current && blockKey) {
      current[blockKey] = blockLines.join("\n").trim();
    }
    blockKey = null;
    blockLines = [];
  };

  for (let index = startIndex + 1; index < lines.length; index++) {
    const line = lines[index].replace(/\r$/, "");
    if (line.trim() && yamlLineIndent(line) === 0) break;

    if (blockKey) {
      if (!line.trim()) {
        blockLines.push("");
        continue;
      }
      const indent = yamlLineIndent(line);
      if (indent > blockIndent) {
        blockLines.push(line.slice(Math.min(indent, blockIndent + 2)));
        continue;
      }
      finishBlock();
    }

    const sourceMatch = line.match(/^\s*-\s+url:\s*(.+)$/);
    if (sourceMatch) {
      current = { url: parseYamlScalar(sourceMatch[1]) };
      sources.push(current);
      listKey = null;
      continue;
    }
    if (!current) continue;

    const mapListMatch = line.match(/^\s+map_urls:\s*$/);
    if (mapListMatch) {
      if (!current.map_urls) current.map_urls = [];
      listKey = "map_urls";
      continue;
    }

    const listItemMatch = line.match(/^\s+-\s+(.+)$/);
    if (listKey === "map_urls" && listItemMatch) {
      const mapUrl = parseYamlScalar(listItemMatch[1]);
      if (mapUrl) current.map_urls?.push(mapUrl);
      continue;
    }

    const mapScalarMatch = line.match(/^\s+map_url:\s*(.+)$/);
    if (mapScalarMatch) {
      const mapUrl = parseYamlScalar(mapScalarMatch[1]);
      if (mapUrl) {
        if (!current.map_urls) current.map_urls = [];
        if (!current.map_urls.includes(mapUrl)) current.map_urls.push(mapUrl);
      }
      listKey = null;
      continue;
    }

    const promptMatch = line.match(/^\s+catalog_additional_prompt:\s*(.*)$/);
    if (promptMatch) {
      listKey = null;
      const value = promptMatch[1].trim();
      if (value.startsWith("|") || value.startsWith(">")) {
        blockKey = "catalog_additional_prompt";
        blockIndent = yamlLineIndent(line);
        blockLines = [];
      } else {
        current.catalog_additional_prompt = parseYamlScalar(value);
      }
    }
  }
  finishBlock();

  return sources.filter((source) => source.url);
}

function eventSourceMapConfigText(sources: EventSourcePayload[]): string {
  return sources
    .filter((source) => source.map_urls?.length)
    .map((source) => `${source.url} => ${(source.map_urls ?? []).join(", ")}`)
    .join("\n");
}

function displayAdditionalPromptText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const sourceSectionIndex = raw.search(
    /(^|\n)\s*\[https?:\/\/[^\]]+\]\s*(?:\n|$)/,
  );
  return (sourceSectionIndex >= 0 ? raw.slice(0, sourceSectionIndex) : raw).trim();
}

function parseYamlNestedValue(raw: string, parent: string, key: string): string {
  if (!parent || !key) return "";
  const re = new RegExp(
    `^${parent}:\\s*\\n(?:\\s+[^\\n]*\\n)*?\\s+${key}:\\s*"?([^"\\n]*)"?`,
    "m",
  );
  const m = raw.match(re);
  return m ? m[1].trim() : "";
}

async function loadProjectConfig(): Promise<boolean> {
  try {
    const res = await invoke<{ found: boolean; raw?: string }>(
      "load_project_config",
      {
        projectRoot: projectRootEl.value,
      },
    );
    loadedConfigSourcePrompts = new Map();
    if (!res.found || !res.raw) return false;
    const raw = res.raw.replace(/\r\n/g, "\n");

    const eventSources = parseYamlEventSources(raw);
    loadedConfigSourcePrompts = new Map(
      eventSources
        .filter((source) => source.catalog_additional_prompt?.trim())
        .map((source) => [
          source.url,
          (source.catalog_additional_prompt ?? "").trim(),
        ]),
    );
    const sourceUrls = eventSources.map((source) => source.url);
    const urls = sourceUrls.length ? sourceUrls : parseYamlList(raw, "urls");
    const url = urls.length ? urls.join("\n") : parseYamlValue(raw, "url");
    if (url)
      (document.getElementById("eventUrl") as HTMLInputElement).value = url;

    const eventSourceMaps = eventSourceMapConfigText(eventSources);
    const mapUrls = parseYamlList(raw, "map_urls");
    const mapUrl = mapUrls.length ? mapUrls.join("\n") : parseYamlValue(raw, "map_url");
    if (eventSourceMaps || mapUrl)
      (document.getElementById("mapUrl") as HTMLInputElement).value = mapUrl;
    if (eventSourceMaps)
      (document.getElementById("mapUrl") as HTMLInputElement).value =
        eventSourceMaps;

    const outputDir = parseYamlValue(raw, "output_dir");
    if (outputDir)
      (document.getElementById("pipelineOutputDir") as HTMLInputElement).value =
        outputDir;

    const models = parseYamlList(raw, "models");
    const textProvider = parseYamlValue(raw, "text_llm_provider") || "api";
    const textPrimaryModel =
      textProvider !== "api"
        ? parseYamlNestedValue(raw, "text_llm_cli_models", textProvider) || models[0]
        : models[0];
    if (textPrimaryModel) {
      (document.getElementById("modelProvider") as HTMLSelectElement).value =
        textProviderValueFromConfig(textProvider, textPrimaryModel);
      updateTextModelSelect(textPrimaryModel);
    }
    const apiReasoningEffort = parseYamlValue(raw, "api_reasoning_effort");
    const textPrimaryEffort =
      textProvider !== "api"
        ? parseYamlNestedValue(raw, "text_llm_cli_efforts", textProvider) ||
          apiReasoningEffort
        : parseYamlNestedValue(raw, "api_reasoning_effort_map", textPrimaryModel) ||
          apiReasoningEffort;
    if (textPrimaryEffort) {
      setEffortOptions(
        "textReasoningEffort",
        textPrimaryEffort,
        reasoningEffortsForSelection(selectedTextProvider(), textPrimaryModel || ""),
      );
    }
    const textFallbackModel =
      parseYamlValue(raw, "text_fallback_llm_model") ||
      (parseYamlValue(raw, "text_llm_provider") === "api" ? models[1] : models[0]) ||
      "gpt-5.5";
    const textFallbackProvider = parseYamlValue(raw, "text_fallback_llm_provider");
    (document.getElementById("textFallbackModelProvider") as HTMLSelectElement).value =
      textFallbackProvider
        ? textFallbackProvider.startsWith("api:") || textFallbackProvider.startsWith("cli:")
          ? textFallbackProvider
          : `api:${textFallbackProvider}`
        : `api:${inferApiProviderFromModel(textFallbackModel)}`;
    updateTextFallbackModelSelect(textFallbackModel);
    const textFallbackEffort =
      parseYamlValue(raw, "text_fallback_llm_effort") ||
      parseYamlNestedValue(raw, "api_reasoning_effort_map", textFallbackModel);
    if (textFallbackEffort) {
      setEffortOptions(
        "textFallbackReasoningEffort",
        textFallbackEffort,
        reasoningEffortsForSelection(selectedTextFallbackProvider(), textFallbackModel),
      );
    }

    const enableTwitter = parseYamlValue(raw, "enable_twitter_catalog");
    if (enableTwitter)
      (document.getElementById("enableTwitter") as HTMLSelectElement).value =
        enableTwitter;

    const useGrokSearch = parseYamlValue(raw, "use_grok_search");
    if (useGrokSearch)
      (document.getElementById("useGrokSearch") as HTMLSelectElement).value =
        useGrokSearch;

    const imageProvider = parseYamlValue(raw, "image_llm_provider");
    const imageModel = parseYamlValue(raw, "image_llm_model");
    let selectedImageProviderValue = `api:${inferApiProviderFromModel(imageModel || models[0] || "")}`;
    if (imageProvider?.startsWith("api:") || imageProvider?.startsWith("cli:")) {
      selectedImageProviderValue = imageProvider;
    } else if (imageProvider) {
      selectedImageProviderValue = `api:${imageProvider}`;
    }
    (document.getElementById("visionModel") as HTMLSelectElement).value =
      selectedImageProviderValue;
    updateVisionModelSelect(imageModel);
    const visionEffort = parseYamlValue(raw, "image_llm_effort");
    if (visionEffort) {
      setEffortOptions(
        "visionReasoningEffort",
        visionEffort,
        reasoningEffortsForSelection(selectedImageProvider(), imageModel || ""),
      );
    }
    const imageFallbackModel =
      parseYamlValue(raw, "image_fallback_llm_model") || "gpt-5-mini";
    const imageFallbackProvider = parseYamlValue(raw, "image_fallback_llm_provider");
    (document.getElementById("visionFallbackModelProvider") as HTMLSelectElement).value =
      imageFallbackProvider
        ? imageFallbackProvider.startsWith("api:") || imageFallbackProvider.startsWith("cli:")
          ? imageFallbackProvider
          : `api:${imageFallbackProvider}`
        : `api:${inferApiProviderFromModel(imageFallbackModel)}`;
    updateVisionFallbackModelSelect(imageFallbackModel);
    const imageFallbackEffort =
      parseYamlValue(raw, "image_fallback_llm_effort") ||
      parseYamlNestedValue(raw, "image_api_reasoning_effort_map", imageFallbackModel);
    if (imageFallbackEffort) {
      setEffortOptions(
        "visionFallbackReasoningEffort",
        imageFallbackEffort,
        reasoningEffortsForSelection(selectedImageFallbackProvider(), imageFallbackModel),
      );
    }

    const skipCircleImages = parseYamlValue(raw, "skip_circle_images");
    if (skipCircleImages)
      (document.getElementById("skipCircleImages") as HTMLSelectElement).value =
        skipCircleImages;

    const commonPrompt = parseYamlBlock(raw, "catalog_additional_prompt");
    (document.getElementById("additionalPrompt") as HTMLTextAreaElement).value =
      commonPrompt;
  } catch (e) {
    // config.yaml読み込み失敗は無視（任意ファイル）
    return false;
  }
  return true;
}

function buildConfigYaml(): string {
  const val = (id: string) =>
    (document.getElementById(id) as HTMLInputElement).value;
  const sel = (id: string) =>
    (document.getElementById(id) as HTMLSelectElement).value;

  const models = selectedTextApiModels();
  const modelsYamlLines = models.length > 0
    ? ["models:", ...models.map((m) => `  - "${m}"`)]
    : ["models: []"];
  const textProvider = selectedTextProvider();
  const textEffort = selectedTextEffort();
  const textApiEffortMap = selectedTextApiEffortMap();
  const textApiEffortMapYamlLines =
    Object.keys(textApiEffortMap).length > 0
      ? [
          "api_reasoning_effort_map:",
          ...Object.entries(textApiEffortMap).map(
            ([model, effort]) => `  ${model}: "${effort}"`,
          ),
        ]
      : ["api_reasoning_effort_map: {}"];
  const textModelMap = selectedTextCliModelMap();
  const textModelMapYamlLines =
    Object.keys(textModelMap).length > 0
      ? [
          "text_llm_cli_models:",
          ...Object.entries(textModelMap).map(([provider, model]) => `  ${provider}: "${model}"`),
        ]
      : ["text_llm_cli_models: {}"];
  const textEffortMap = selectedTextCliEffortMap();
  const textEffortMapYamlLines =
    Object.keys(textEffortMap).length > 0
      ? [
          "text_llm_cli_efforts:",
          ...Object.entries(textEffortMap).map(
            ([provider, effort]) => `  ${provider}: "${effort}"`,
          ),
        ]
      : ["text_llm_cli_efforts: {}"];

  const imageConfig = selectedImageConfig();
  const imageApiEffortMap = selectedImageApiEffortMap();
  const imageApiEffortMapYamlLines =
    Object.keys(imageApiEffortMap).length > 0
      ? [
          "image_api_reasoning_effort_map:",
          ...Object.entries(imageApiEffortMap).map(
            ([model, effort]) => `  ${model}: "${effort}"`,
          ),
        ]
      : ["image_api_reasoning_effort_map: {}"];
  const promptRaw = (
    document.getElementById("additionalPrompt") as HTMLTextAreaElement
  ).value;
  const prompt = displayAdditionalPromptText(promptRaw);
  const promptYaml = prompt
    ? "catalog_additional_prompt: |\r\n" +
      prompt
        .split("\n")
        .map((l) => `  ${l.replace(/\r$/, "")}`)
        .join("\r\n")
    : 'catalog_additional_prompt: ""';
  const yamlQuote = (value: string) =>
    value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const configUrls = parseEventUrlList(val("eventUrl"));
  const yamlSourceUrls = configUrls.length ? configUrls : parseEventUrlList(val("eventUrl"));
  const configSource = buildEventSourcesPayload(yamlSourceUrls, val("mapUrl"), promptRaw);
  const urlYamlLines =
    configUrls.length > 1
      ? [
          `url: "${yamlQuote(configUrls[0])}"`,
          "urls:",
          ...configUrls.map((url) => `  - "${yamlQuote(url)}"`),
        ]
      : [`url: "${yamlQuote(val("eventUrl"))}"`];
  const mapYamlLines =
    configSource.mapUrls.length > 0
      ? [
          `map_url: "${yamlQuote(configSource.mapUrls[0])}"`,
          ...(configSource.mapUrls.length > 1
            ? ["map_urls:", ...configSource.mapUrls.map((url) => `  - "${yamlQuote(url)}"`)]
            : []),
        ]
      : [`map_url: ""`];
  const eventSourcesYamlLines =
    configSource.eventSources.length > 1 ||
    configSource.eventSources.some((source) => source.map_urls?.length)
      ? [
          "event_sources:",
          ...configSource.eventSources.flatMap((source) => [
            `  - url: "${yamlQuote(source.url)}"`,
            ...(source.map_urls?.length
              ? [
                  "    map_urls:",
                  ...source.map_urls.map((url) => `      - "${yamlQuote(url)}"`),
                ]
              : []),
            ...(source.catalog_additional_prompt
              ? [
                  "    catalog_additional_prompt: |-",
                  ...source.catalog_additional_prompt
                    .split("\n")
                    .map((line) => `      ${line.replace(/\r$/, "")}`),
                ]
              : []),
          ]),
        ]
      : [];

  return [
    "# Event AutoPin 設定",
    "",
    ...urlYamlLines,
    ...mapYamlLines,
    ...eventSourcesYamlLines,
    `output_dir: "${val("pipelineOutputDir")}"`,
    "",
    ...modelsYamlLines,
    `text_llm_provider: "${textProvider.kind === "cli" ? textProvider.provider : "api"}"`,
    ...textModelMapYamlLines,
    ...textEffortMapYamlLines,
    `api_reasoning_effort: "${textEffort}"`,
    ...textApiEffortMapYamlLines,
    `text_fallback_llm_provider: "${providerConfigValue(selectedTextFallbackProvider())}"`,
    `text_fallback_llm_model: "${selectedTextFallbackModel()}"`,
    `text_fallback_llm_effort: "${selectedTextFallbackEffort()}"`,
    `image_llm_provider: "${imageConfig.provider}"`,
    `image_llm_model: "${imageConfig.model}"`,
    `image_llm_effort: "${imageConfig.effort}"`,
    `image_fallback_llm_provider: "${providerConfigValue(selectedImageFallbackProvider())}"`,
    `image_fallback_llm_model: "${selectedImageFallbackModel()}"`,
    `image_fallback_llm_effort: "${selectedImageFallbackEffort()}"`,
    ...imageApiEffortMapYamlLines,
    "",
    `skip_circle_images: ${sel("skipCircleImages")}`,
    "",
    `enable_twitter_catalog: ${sel("enableTwitter")}`,
    `use_grok_search: ${sel("useGrokSearch")}`,
    "",
    `verbose: ${sel("verbose")}`,
    "",
    promptYaml,
    "",
  ].join("\r\n");
}

async function saveProjectConfig() {
  try {
    await invoke("save_project_config", {
      projectRoot: projectRootEl.value,
      yamlContent: buildConfigYaml(),
    });
  } catch (e) {
    // 保存失敗は無視
  }
}

const FORM_STORAGE_KEY = "eventtrail-form-values";
const FORM_IDS = [
  "eventDate",
  "outputDir",
  "eventUrl",
  "modelProvider",
  "model",
  "textReasoningEffort",
  "textFallbackModelProvider",
  "textFallbackModel",
  "textFallbackReasoningEffort",
  "visionModel",
  "visionModelId",
  "visionReasoningEffort",
  "visionFallbackModelProvider",
  "visionFallbackModel",
  "visionFallbackReasoningEffort",
  "mapUrl",
  "daysBefore",
  "daysAfter",
  "backup",
  "enableTwitter",
  "useGrokSearch",
  "reprocess",
  "regen",
  "skipCircleImages",
  "verbose",
  "additionalPrompt",
  "pythonExe",
  "projectRoot",
  "timeoutMs",
  "unlimitedOcrModel",
  "unlimitedOcrModelPath",
  "unlimitedOcrVenv",
  "unlimitedOcrHfHome",
  "unlimitedOcrRevision",
  "unlimitedOcrDevice",
  "unlimitedOcrMode",
  "unlimitedOcrStrategy",
];

function saveFormValues() {
  const data: Record<string, string> = {};
  for (const id of FORM_IDS) {
    const el = document.getElementById(id) as
      | HTMLInputElement
      | HTMLSelectElement
      | HTMLTextAreaElement
      | null;
    if (el) data[id] = el.value;
  }
  localStorage.setItem(FORM_STORAGE_KEY, JSON.stringify(data));
}

function restoreFormValues() {
  const raw = localStorage.getItem(FORM_STORAGE_KEY);
  if (!raw) return;
  try {
    const data = JSON.parse(raw) as Record<string, string>;
    for (const [id, val] of Object.entries(data)) {
      const el = document.getElementById(id) as
        | HTMLInputElement
        | HTMLSelectElement
        | HTMLTextAreaElement
        | null;
      if (el && val) el.value = val;
    }
    // 古いデフォルト(300000ms)が保存されていたら新デフォルトに引き上げ
    if (data.timeoutMs && Number(data.timeoutMs) < 10800000) {
      timeoutMsEl.value = "10800000";
    }
    updateTextModelSelect(data.model);
    updateTextFallbackModelSelect(data.textFallbackModel);
    updateVisionModelSelect(data.visionModelId);
    updateVisionFallbackModelSelect(data.visionFallbackModel);
  } catch {
    /* ignore */
  }
}

let applicationCloseFlowInProgress = false;
let applicationCloseFlowCompleted = false;
let applicationCloseUnlisten: (() => void) | null = null;

/**
 * Tauri close-requestedをpreventDefaultして、保存完了後にlistenerを外して
 * closeする。二重closeイベントや同時beforeunloadでもsave/flushを一度だけ実行する。
 */
async function handleApplicationCloseRequested(event: { preventDefault: () => void }): Promise<void> {
  if (applicationCloseFlowCompleted) return;
  event.preventDefault();
  if (applicationCloseFlowInProgress) return;
  applicationCloseFlowInProgress = true;
  try {
    const pendingCrawlMeta = captureCrawlMetaSnapshot();
    cancelCrawlMetaSave();
    await flushCrawlMetaSnapshot(pendingCrawlMeta, INTERNAL_OPERATION_SAVE);
    const saved = await saveNow(INTERNAL_OPERATION_SAVE);
    if (!saved.ok) throw saved.error;
    await flushAllEventSavesOrThrow();
    await flushCircleMasterSaves();
    saveFormValues();
    await disposeCookieFileSelection();
    applicationCloseFlowCompleted = true;
    applicationCloseUnlisten?.();
    applicationCloseUnlisten = null;
    await appWindow.close();
  } catch (error) {
    applicationCloseFlowInProgress = false;
    resultEl.textContent = `終了処理に失敗しました: ${String(error)}`;
  }
}

async function installApplicationCloseHandler(): Promise<void> {
  try {
    applicationCloseUnlisten = await appWindow.onCloseRequested((event) =>
      handleApplicationCloseRequested(event),
    );
  } catch {
    // Browser/Vite preview has no Tauri close-requested API; beforeunload fallbackを使う。
  }
}

window.addEventListener("beforeunload", () => {
  if (applicationCloseFlowCompleted) return;
  void disposeCookieFileSelection();
  // Browser fallbackはbeforeunloadをawaitできないためbest effort。ただしsnapshot投入
  // とflushAllを開始し、Tauri flowがない環境でもpendingを可能な限り排出する。
  void (async () => {
    if (applicationCloseFlowInProgress) return;
    applicationCloseFlowInProgress = true;
    try {
      const pendingCrawlMeta = captureCrawlMetaSnapshot();
      cancelCrawlMetaSave();
      await flushCrawlMetaSnapshot(pendingCrawlMeta, INTERNAL_OPERATION_SAVE);
      await saveNow(INTERNAL_OPERATION_SAVE);
      // beforeunloadはawaitされないが、可能な限り全event/circle-masterを
      // drainする。Tauri close-requestedが利用できる場合は上の確実なflowが優先。
      await flushAllEventSavesOrThrow();
      await flushCircleMasterSaves();
    } finally {
      saveFormValues();
    }
  })();
});

void installApplicationCloseHandler();

// 初期化は末尾のautoLoadEventチェーンで実行

const tabScrollPositions: Record<string, number> = {};

function switchTab(index: number) {
  const buttons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".tab-btn"),
  );
  const panes = Array.from(document.querySelectorAll<HTMLElement>(".tab-pane"));
  if (index < 0 || index >= buttons.length) return;
  // 現在のタブのスクロール位置を保存
  const currentPane = panes.find((p) => p.classList.contains("active"));
  if (currentPane) {
    tabScrollPositions[currentPane.id] = currentPane.scrollTop;
  }
  buttons.forEach((b) => b.classList.remove("active"));
  panes.forEach((p) => p.classList.remove("active"));
  buttons[index].classList.add("active");
  const target = buttons[index].dataset.tab;
  if (target) {
    const pane = document.getElementById(target);
    if (pane) {
      pane.classList.add("active");
      // 保存されたスクロール位置を復元
      if (tabScrollPositions[target] !== undefined) {
        pane.scrollTop = tabScrollPositions[target];
      }
    }
    onTabActivated(target);
  }
}

function getActiveTabIndex(): number {
  const buttons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".tab-btn"),
  );
  return buttons.findIndex((b) => b.classList.contains("active"));
}

function isTextInputLikeElement(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT"
  );
}

function initShortcuts() {
  document.addEventListener("keydown", (e) => {
    // Alt+1〜6: タブ切り替え
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= 6) {
        e.preventDefault();
        switchTab(num - 1);
        return;
      }
    }
    // Ctrl+Tab / Ctrl+Shift+Tab: タブ切り替え
    if (e.ctrlKey && e.key === "Tab" && !e.altKey && !e.metaKey) {
      e.preventDefault();
      const tabCount = document.querySelectorAll(".tab-btn").length;
      const current = getActiveTabIndex();
      const next = e.shiftKey
        ? (current - 1 + tabCount) % tabCount
        : (current + 1) % tabCount;
      switchTab(next);
      return;
    }
    // ArrowLeft / ArrowRight: マップ編集タブ内でマップ切り替え
    if (
      (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.metaKey &&
      !e.shiftKey &&
      document.getElementById("tab-map")?.classList.contains("active") &&
      !isTextInputLikeElement(document.activeElement)
    ) {
      if (switchMapByOffset(e.key === "ArrowLeft" ? -1 : 1)) {
        e.preventDefault();
        return;
      }
    }
    // Escape: マップ配置モード解除
    if (e.key === "Escape" && mapPlacingRow >= 0) {
      mapPlacingRow = -1;
      mapViewport.classList.remove("placing-mode");
      renderMapCircleList();
      return;
    }
    // Ctrl+Z: 画像Undo（1段階バッファ）
    if (e.ctrlKey && e.key === "z" && !e.altKey && !e.shiftKey && !e.metaKey) {
      if (isMapAutoOperation(operationState)) {
        e.preventDefault();
        return;
      }
      // inputにフォーカス中はブラウザのUndoを優先
      const ae = document.activeElement;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) return;
      if (imageUndoBuffer) {
        e.preventDefault();
        const undo = imageUndoBuffer;
        imageUndoBuffer = null;
        // 元の画像を復元
        tableState.rows[undo.row][undo.col] = undo.oldFileName;
        saveNow();
        const src = resolveImageSrc(undo.oldFileName);
        undo.cell.innerHTML = `<img src="${escapeHtml(src)}" alt="" class="img-block" data-fallback="outerhtml" data-fallback-html="<span class='text-red-500 text-xs cursor-pointer'>読込失敗</span>" />`;
        // 新しい画像の参照だけを解除し、assetファイルは回復用に保持する。
        return;
      }
    }
    // Ctrl+Enter: フルパイプライン実行
    if (e.ctrlKey && e.key === "Enter" && !e.altKey && !e.metaKey) {
      e.preventDefault();
      (document.getElementById("runPipelineBtn") as HTMLButtonElement).click();
    }
  });
}

/** サークルリストテーブルのキーボードナビゲーション */
function initCircleTableKeyboardNav() {
  circleEditorEl.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement;
    const isInput =
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT";
    const circleRow = target.closest<HTMLTableRowElement>(
      "tr.circle-row[data-circle-row]",
    );
    const itemRow = target.closest<HTMLTableRowElement>("tr.item-panel-row");

    // Enter: 行展開/折りたたみ（inputにフォーカス中でも可）
    if (e.key === "Enter" && !e.ctrlKey && !e.altKey && circleRow) {
      // input内のEnterは展開トグルに使う（値確定はchangeイベントで処理済み）
      if (isInput && target.tagName === "INPUT") {
        e.preventDefault();
        const idx = Number(circleRow.dataset.circleRow);
        expandedCircleIdx = expandedCircleIdx === idx ? -1 : idx;
        toggleItemPanelInPlace();
        // 展開後、アイテムパネルの最初のinputにフォーカス
        if (expandedCircleIdx === idx) {
          setTimeout(() => {
            const panel = circleEditorEl.querySelector<HTMLInputElement>(
              `tr.item-panel-row[data-circle="${idx}"] input.item-field`,
            );
            if (panel) panel.focus();
          }, 50);
        }
        return;
      }
    }

    // 上下矢印: input内でもサークル行間移動
    if (
      (e.key === "ArrowUp" || e.key === "ArrowDown") &&
      !e.ctrlKey &&
      !e.altKey
    ) {
      if (!circleRow && !itemRow) return;

      const allCircleRows = Array.from(
        circleEditorEl.querySelectorAll<HTMLTableRowElement>(
          "tr.circle-row[data-circle-row]",
        ),
      );
      if (allCircleRows.length === 0) return;

      let currentRowIdx = -1;
      if (circleRow) {
        currentRowIdx = allCircleRows.indexOf(circleRow);
      } else if (itemRow) {
        // アイテムパネル行の場合、親サークル行を探す
        const ci = itemRow.dataset.circle;
        currentRowIdx = allCircleRows.findIndex(
          (r) => r.dataset.circleRow === ci,
        );
      }
      if (currentRowIdx < 0) return;

      const nextRowIdx =
        e.key === "ArrowUp" ? currentRowIdx - 1 : currentRowIdx + 1;
      if (nextRowIdx < 0 || nextRowIdx >= allCircleRows.length) return;

      e.preventDefault();
      const nextRow = allCircleRows[nextRowIdx];
      // 同じ列位置のinputにフォーカス
      const currentCell = target.closest("td");
      const currentCellIdx = currentCell
        ? Array.from(currentCell.parentElement!.children).indexOf(currentCell)
        : 0;
      const targetInput = nextRow.querySelectorAll<HTMLInputElement>(
        "input, button.check-cycle-btn",
      )[0];
      const samePosInput = nextRow.children[
        currentCellIdx
      ]?.querySelector<HTMLInputElement>("input, button.check-cycle-btn");
      if (samePosInput) {
        samePosInput.focus();
        if (samePosInput.tagName === "INPUT")
          (samePosInput as HTMLInputElement).select();
      } else if (targetInput) {
        targetInput.focus();
        if (targetInput.tagName === "INPUT")
          (targetInput as HTMLInputElement).select();
      }
      // 行をビューに入れる
      nextRow.scrollIntoView({ block: "nearest" });
      return;
    }

    // Escape: 展開中のアイテムパネルを閉じる
    if (e.key === "Escape" && expandedCircleIdx >= 0) {
      // マップ配置モードでなければパネルを閉じる
      if (mapPlacingRow < 0) {
        expandedCircleIdx = -1;
        toggleItemPanelInPlace();
        return;
      }
    }

    // Tab: アイテムパネル内で最後のフィールドからTab→次のサークル行へ
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey && itemRow) {
      const itemInputs = Array.from(
        itemRow.querySelectorAll<HTMLElement>(
          "input.item-field, button.item-check-cycle-btn, button.item-delete-btn, button.item-add-btn",
        ),
      );
      if (itemInputs.length > 0) {
        const lastItem = itemInputs[itemInputs.length - 1];
        if (target === lastItem && !e.shiftKey) {
          // 最後のアイテム要素からTab → 次のサークル行の最初のinputへ
          const ci = itemRow.dataset.circle;
          const allCircleRows = Array.from(
            circleEditorEl.querySelectorAll<HTMLTableRowElement>(
              "tr.circle-row[data-circle-row]",
            ),
          );
          const currentIdx = allCircleRows.findIndex(
            (r) => r.dataset.circleRow === ci,
          );
          if (currentIdx >= 0 && currentIdx + 1 < allCircleRows.length) {
            e.preventDefault();
            const nextRow = allCircleRows[currentIdx + 1];
            const nextInput = nextRow.querySelector<HTMLInputElement>("input");
            if (nextInput) {
              nextInput.focus();
              nextInput.select();
            }
          }
        }
      }
    }
  });
}

renderCircleEditorAndMap();
initTabs();
initHistorySearch();
initShortcuts();
initCircleTableKeyboardNav();
initCircleFilters();

const initialConfigPromise = loadConfig();

initialConfigPromise
  .then(() => {
    hydrateModelControls();
    return loadProjectConfig();
  })
  .then((loadedProjectConfig) => {
    if (!loadedProjectConfig) restoreFormValues();
  })
  .catch((e) => {
    resultEl.textContent = `設定読み込み警告: ${String(e)}`;
    pythonExeEl.value = "python";
    projectRootEl.value = ".";
    timeoutMsEl.value = "10800000";
    restoreFormValues();
  });

// === マップ編集 ===
const mapViewport = document.getElementById("mapViewport") as HTMLDivElement;
const mapInner = document.getElementById("mapInner") as HTMLDivElement;
const mapNumberSelect = document.getElementById(
  "mapNumberSelect",
) as HTMLSelectElement;
const mapZoomInfo = document.getElementById("mapZoomInfo") as HTMLSpanElement;
const mapInfoCard = document.getElementById("mapInfoCard") as HTMLDivElement;
const mapFilterChips = document.getElementById(
  "mapFilterChips",
) as HTMLDivElement;

let mapScale = 1;
let mapPanX = 0;
let mapPanY = 0;
let mapImgWidth = 0;
let mapImgHeight = 0;
let mapSelectedRow = -1;
let mapColorFilter: Record<string, boolean> = {
  "5": true,
  "11": true,
  "10": true,
  "15": true,
  none: true,
};
let mapImagePaths: EventMapImage[] = [];
// 同一owner/mapへの物理writeを要求順に完了させ、後発bytesを必ず最後にする。
const mapImageMutationSerial = new KeyedSerialExecutor();
const eventImageMutationSerial = new KeyedSerialExecutor();
// Image.onload/onerrorの後着完了を無効化する世代。
let mapImageLoadGeneration = 0;
let mapImageRefreshGeneration = 0;
let mapAutoPlacementGeneration = 0;
let mapPlacingRow = -1; // 配置モード中のサークル行番号（-1=非配置モード）
let mapPinWidth = 77;
let mapPinHeight = 24;
let mapPinOffsetX = 0;
let mapPinOffsetY = 0;
let mapPinOrientation: "vertical" | "horizontal" = "vertical";
let mapSelectChangeBound = false;
let mapPinControlsBound = false;
let mapCircleControlsBound = false;

function normalizeSpaceNumberText(value: string): string {
  return value.replace(/[０-９]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xfee0),
  );
}

function getMapPinSpaceSpan(space: string): number {
  const normalized = normalizeSpaceNumberText(space);
  const target = normalized.includes("-")
    ? normalized.slice(normalized.indexOf("-") + 1)
    : normalized;
  const numbers = target.match(/\d+/g);
  if (!numbers || numbers.length <= 1) return 1;
  return Math.max(1, Math.min(4, numbers.length));
}

function mapNumberFromName(name: string): number | null {
  const match = name.match(/^map_(\d+)/i);
  if (!match) return null;
  const num = Number.parseInt(match[1], 10);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function preferredEventMapReferences(
  data: EventJsonData | null = eventJsonData,
  explicitReference = "",
): string[] {
  const byNumber = new Map<number, string>();
  const maps = Array.isArray(data?.event?.maps) ? data.event.maps : [];
  for (const entry of maps) {
    const reference =
      typeof entry === "string"
        ? entry
        : typeof entry?.filename === "string"
          ? entry.filename
          : "";
    const number = mapNumberFromName(
      reference.replace(/\\/g, "/").split("/").pop() || "",
    );
    if (number && reference) byNumber.set(number, reference);
  }
  if (explicitReference) {
    const number = mapNumberFromName(
      explicitReference.replace(/\\/g, "/").split("/").pop() || "",
    );
    if (number) byNumber.set(number, explicitReference);
  }
  return Array.from(byNumber.values());
}

function getMapNumbers(): number[] {
  const nums = new Set<number>();
  for (const map of mapImagePaths) {
    const num = mapNumberFromName(map.name);
    if (num) nums.add(num);
  }
  for (const row of tableState.rows) {
    const v = parseFloat(String(row["マップ番号"] ?? "0"));
    if (!isNaN(v) && v > 0) nums.add(v);
  }
  const result = Array.from(nums).sort((a, b) => a - b);
  return result.length ? result : [1];
}

function currentMapNumber(): number {
  return parseFloat(mapNumberSelect.value) || 1;
}

function switchMapByOffset(offset: number): boolean {
  const options = Array.from(mapNumberSelect.options);
  if (options.length <= 1) return false;
  const currentIndex = Math.max(0, mapNumberSelect.selectedIndex);
  const nextIndex = (currentIndex + offset + options.length) % options.length;
  if (nextIndex === currentIndex) return false;
  mapNumberSelect.selectedIndex = nextIndex;
  loadMapImage();
  return true;
}

function getMapImageForNumber(num: number): { name: string; path: string } | null {
  return (
    mapImagePaths.find((m) => mapNumberFromName(m.name) === num) || null
  );
}

function mapFileNameFor(num: number, ext: string): string {
  const normalizedExt = IMAGE_EXTENSIONS.includes(ext.toLowerCase())
    ? ext.toLowerCase()
    : "jpg";
  return `map_${String(num || 1).padStart(2, "0")}.${normalizedExt}`;
}

function nextMapNumber(): number {
  const nums = [
    ...mapImagePaths
      .map((m) => mapNumberFromName(m.name))
      .filter((n): n is number => Boolean(n)),
    ...tableState.rows
      .map((row) => parseFloat(String(row["マップ番号"] ?? "0")))
      .filter((n) => !isNaN(n) && n > 0),
  ];
  return nums.length ? Math.max(...nums) + 1 : 1;
}

function rebuildMapNumberSelect(preferred?: number) {
  const current = preferred || currentMapNumber();
  const nums = getMapNumbers();
  mapNumberSelect.innerHTML = nums
    .map((n) => `<option value="${n}">マップ ${n}</option>`)
    .join("");
  const selected = nums.includes(current) ? current : nums[0] || 1;
  mapNumberSelect.value = String(selected);
}

function syncEventMapMetadata() {
  if (!eventJsonData) return;
  if (!eventJsonData.event) eventJsonData.event = {};
  mapImagePaths = selectActiveMapImages(
    mapImagePaths,
    preferredEventMapReferences(eventJsonData),
  );
  eventJsonData.event.maps = mapImagePaths
    .map((m) => ({
      filename: eventRelativeAssetPath("maps", m.name),
      map_number: mapNumberFromName(m.name) || 1,
    }))
    .sort((a, b) => a.map_number - b.map_number);
}

function commitMapImagesToEventSession(
  owner: ActiveEventDocumentOwner,
  images: EventMapImage[],
): void {
  if (
    !committedEventSession ||
    !isActiveEventDocumentOwner(owner) ||
    committedEventSession.slug !== owner.slug
  ) {
    return;
  }
  committedEventSession = {
    ...committedEventSession,
    mapImages: recordDeepClone(images),
  };
}

async function refreshMapImages(
  preferred?: number,
  explicitReference = "",
) {
  const generation = ++mapImageRefreshGeneration;
  const owner = captureActiveEventDocumentOwner();
  const isCurrentRequest = () =>
    generation === mapImageRefreshGeneration &&
    isActiveEventDocumentOwner(owner);
  try {
    const activeDir = getActiveEventDir();
    const preferredRefs = preferredEventMapReferences(
      eventJsonData,
      explicitReference,
    );
    const res = activeDir
      ? await invoke<{
          status: string;
          maps: EventMapImage[];
        }>("list_event_map_images", { eventDir: activeDir, preferredRefs })
      : await invoke<{
          status: string;
          maps: EventMapImage[];
        }>("list_map_images", { projectRoot: projectRootEl.value });
    if (!isCurrentRequest()) return;
    mapImagePaths = selectActiveMapImages(res.maps || [], preferredRefs);
    commitMapImagesToEventSession(owner, mapImagePaths);
  } catch {
    if (!isCurrentRequest()) return;
    mapImagePaths = [];
    commitMapImagesToEventSession(owner, mapImagePaths);
  }
  rebuildMapNumberSelect(preferred);
}

function clampMapPan() {
  if (!mapImgWidth || !mapImgHeight) return;
  const vpW = mapViewport.clientWidth;
  const vpH = mapViewport.clientHeight;
  if (!vpW || !vpH) return;
  const scaledW = mapImgWidth * mapScale;
  const scaledH = mapImgHeight * mapScale;
  // 画像端がビューポートから出すぎないよう制限（画像の半分までは許容）
  const marginX = Math.min(scaledW * 0.5, vpW * 0.3);
  const marginY = Math.min(scaledH * 0.5, vpH * 0.3);
  mapPanX = Math.min(marginX, Math.max(vpW - scaledW - marginX, mapPanX));
  mapPanY = Math.min(marginY, Math.max(vpH - scaledH - marginY, mapPanY));
}

function updateMapTransform(skipClamp = false) {
  if (!skipClamp) clampMapPan();
  mapInner.style.transform = `translate(${mapPanX}px, ${mapPanY}px) scale(${mapScale})`;
  mapZoomInfo.textContent = `${Math.round(mapScale * 100)}%`;
}

let mapNeedsFit = false;

function fitMapToViewport() {
  if (!mapImgWidth || !mapImgHeight) {
    mapNeedsFit = true;
    return;
  }
  const vpW = mapViewport.clientWidth;
  const vpH = mapViewport.clientHeight;
  if (!vpW || !vpH) {
    mapNeedsFit = true;
    return;
  }
  mapNeedsFit = false;
  // ビューポートに画像全体がぴったり収まるようフィット
  const padding = 8;
  const availW = vpW - padding * 2;
  const availH = vpH - padding * 2;
  mapScale = Math.min(availW / mapImgWidth, availH / mapImgHeight);
  mapPanX = (vpW - mapImgWidth * mapScale) / 2;
  mapPanY = (vpH - mapImgHeight * mapScale) / 2;
  if (isDesktopDevBuild) {
    logToFile(
      `fitMapToViewport: vpW=${vpW} vpH=${vpH} imgW=${mapImgWidth} imgH=${mapImgHeight} scale=${mapScale} panX=${mapPanX} panY=${mapPanY}`,
    );
  }
  updateMapTransform(true);
}

// ビューポートサイズ変更時に自動フィット
new ResizeObserver(() => {
  if (mapNeedsFit) fitMapToViewport();
}).observe(mapViewport);

function getMapImagePath(): string {
  const num = currentMapNumber();
  const found = getMapImageForNumber(num);
  // list_map_imagesの結果からマッチするパスを取得
  if (found) return found.path;
  // フォールバック: アクティブイベントフォルダから
  const activeEvMap = activeEventSlug
    ? eventList.find((e) => e.slug === activeEventSlug)
    : null;
  const mapDir = activeEvMap?.dir ?? "";
  return `${mapDir}/${mapFileNameFor(num, "jpg")}`;
}

function renderMapPins() {
  // 既存のピンを削除
  mapInner.querySelectorAll(".map-pin").forEach((p) => p.remove());
  if (!mapImgWidth || !mapImgHeight) return;

  const mapNum = currentMapNumber();
  tableState.rows.forEach((row, idx) => {
    const rowMapNum = parseFloat(String(row["マップ番号"] ?? "0")) || 0;
    if (rowMapNum > 0 && rowMapNum !== mapNum) return;

    const px = parseFloat(String(row["ピンX"] ?? "0"));
    const py = parseFloat(String(row["ピンY"] ?? "0"));
    if (!px && !py) return; // 座標なし

    // 色フィルター
    const colorVal = String(parseFloat(String(row["色"] ?? "5")) || 5);
    const colorKey = COLOR_OPTIONS.find((c) => c.value === colorVal)
      ? colorVal
      : "none";
    if (!mapColorFilter[colorKey]) return;

    const opt = getColorOption(String(row["色"] ?? "5"));
    const priorityColor = opt ? opt.color : "#666";
    const fillColor = hexToRgba(priorityColor, 0.36);
    const borderColor = hexToRgba(priorityColor, 0.76);

    const anchorLeft = px * mapImgWidth;
    const anchorTop = py * mapImgHeight;
    const visualLeft = anchorLeft + mapPinOffsetX;
    const visualTop = anchorTop + mapPinOffsetY;

    const hall = String(row["ホール"] ?? "");
    const space = String(row["スペース"] ?? "");
    const name = String(row["サークル名"] ?? "");
    const span = getMapPinSpaceSpan(space);
    const pinWidth =
      mapPinOrientation === "horizontal" ? mapPinWidth * span : mapPinWidth;
    const pinHeight =
      mapPinOrientation === "vertical" ? mapPinHeight * span : mapPinHeight;

    const pin = document.createElement("div");
    pin.className = "map-pin";
    pin.dataset.row = String(idx);
    pin.style.left = `${visualLeft}px`;
    pin.style.top = `${visualTop}px`;
    pin.style.width = `${pinWidth}px`;
    pin.style.height = `${pinHeight}px`;
    pin.style.backgroundColor = fillColor;
    pin.style.borderColor = borderColor;
    pin.style.setProperty("--map-pin-priority", priorityColor);
    pin.style.setProperty("--map-pin-priority-soft", hexToRgba(priorityColor, 0.86));
    if (idx === mapSelectedRow) pin.classList.add("selected");

    const circleCutVal = String(row["サークル画像"] ?? "").trim();
    const hasCut =
      circleCutVal &&
      circleCutVal !== "0.0" &&
      circleCutVal !== "0" &&
      !/^\d+(\.\d+)?$/.test(circleCutVal);
    const cutImgHtml = hasCut
      ? `<img src="${escapeHtml(resolveImageSrc(circleCutVal))}" class="thumb-tooltip" data-fallback="hide" />`
      : "";
    pin.innerHTML = `<div class="map-pin-tooltip">${cutImgHtml}<div class="map-pin-tooltip-title">${escapeHtml(hall + space)} ${escapeHtml(name)}</div></div>`;

    // クリック→選択
    pin.addEventListener("click", (e) => {
      e.stopPropagation();
      mapSelectedRow = idx;
      mapInner
        .querySelectorAll(".map-pin.selected")
        .forEach((p) => p.classList.remove("selected"));
      pin.classList.add("selected");
      showMapInfo(idx);
    });

    // 右クリック→削除
    pin.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showMapPinContextMenu(e.clientX, e.clientY, idx);
    });

    // ドラッグ移動
    let pinDragging = false;
    let pinStartX = 0;
    let pinStartY = 0;
    let pinOrigLeft = 0;
    let pinOrigTop = 0;

    pin.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      pinDragging = true;
      pin.classList.add("dragging");
      pinStartX = e.clientX;
      pinStartY = e.clientY;
      pinOrigLeft = parseFloat(pin.style.left) || visualLeft;
      pinOrigTop = parseFloat(pin.style.top) || visualTop;

      const onMove = (ev: MouseEvent) => {
        if (!pinDragging) return;
        const dx = (ev.clientX - pinStartX) / mapScale;
        const dy = (ev.clientY - pinStartY) / mapScale;
        const newAnchorLeft = Math.max(
          0,
          Math.min(mapImgWidth, pinOrigLeft + dx - mapPinOffsetX),
        );
        const newAnchorTop = Math.max(
          0,
          Math.min(mapImgHeight, pinOrigTop + dy - mapPinOffsetY),
        );
        pin.style.left = `${newAnchorLeft + mapPinOffsetX}px`;
        pin.style.top = `${newAnchorTop + mapPinOffsetY}px`;
      };

      const onUp = (ev: MouseEvent) => {
        if (!pinDragging) return;
        pinDragging = false;
        pin.classList.remove("dragging");
        const dx = (ev.clientX - pinStartX) / mapScale;
        const dy = (ev.clientY - pinStartY) / mapScale;
        const newLeft = Math.max(
          0,
          Math.min(mapImgWidth, pinOrigLeft + dx - mapPinOffsetX),
        );
        const newTop = Math.max(
          0,
          Math.min(mapImgHeight, pinOrigTop + dy - mapPinOffsetY),
        );
        // 正規化座標に変換して保存
        const newPx = newLeft / mapImgWidth;
        const newPy = newTop / mapImgHeight;
        tableState.rows[idx]["ピンX"] = String(newPx);
        tableState.rows[idx]["ピンY"] = String(newPy);
        saveNow();
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    mapInner.appendChild(pin);
  });
}

function showMapInfo(rowIdx: number) {
  const row = tableState.rows[rowIdx];
  if (!row) {
    mapInfoCard.innerHTML = `<h4>サークル情報</h4><p class="hint">ピンをクリックして選択</p>`;
    return;
  }
  const hall = String(row["ホール"] ?? "");
  const space = String(row["スペース"] ?? "");
  const name = String(row["サークル名"] ?? "");
  const tag = String(row["ペンネーム"] ?? "");
  const memo = String(row["サークルメモ"] ?? "");
  const pinX = parseFloat(String(row["ピンX"] ?? "0"));
  const pinY = parseFloat(String(row["ピンY"] ?? "0"));
  const px = pinX.toFixed(4);
  const py = pinY.toFixed(4);
  const hasPin = Boolean(pinX || pinY);
  const opt = getColorOption(String(row["色"] ?? "5"));
  const colorLabel = opt ? opt.label : "なし";

  // サークルカット画像
  const cutVal = String(row["サークル画像"] ?? "").trim();
  const hasCut =
    cutVal &&
    cutVal !== "0.0" &&
    cutVal !== "0" &&
    !/^\d+(\.\d+)?$/.test(cutVal);
  const cutSrc = hasCut ? resolveImageSrc(cutVal) : "";
  const cutHtml = hasCut
    ? `<img src="${escapeHtml(cutSrc)}" alt="" class="map-info-thumb" data-fallback="hide" title="クリックで拡大" />`
    : "";

  mapInfoCard.innerHTML = `
    <h4>${escapeHtml(hall + space)} ${escapeHtml(name)}</h4>
    ${cutHtml}
    <div class="detail-row"><span class="detail-label">タグ</span><span>${escapeHtml(tag)}</span></div>
    <div class="detail-row"><span class="detail-label">優先度</span><span>${escapeHtml(colorLabel)}</span></div>
    <div class="detail-row"><span class="detail-label">座標</span><span>(${px}, ${py})</span></div>
    ${memo ? `<div class="detail-row"><span class="detail-label">メモ</span><span>${escapeHtml(memo)}</span></div>` : ""}
    ${isUrlValue(memo) ? `<a href="${escapeHtml(memo)}" target="_blank" rel="noopener" class="link-sm">開く</a>` : ""}
    ${hasPin ? `<button id="mapAddCalibrationPointBtn" class="btn-secondary text-xs px-2 py-1 rounded mt-2">校正点に追加</button>` : ""}
  `;
  if (cutSrc) {
    mapInfoCard
      .querySelector<HTMLImageElement>(".map-info-thumb")
      ?.addEventListener("click", () => showImageModal(cutSrc));
  }
  mapInfoCard
    .querySelector<HTMLButtonElement>("#mapAddCalibrationPointBtn")
    ?.addEventListener("click", () => addMapCalibrationPoint(rowIdx));
}

function addMapCalibrationPoint(rowIdx: number) {
  if (!eventJsonData) return;
  const row = tableState.rows[rowIdx];
  if (!row) return;
  const space = String(row["スペース"] ?? "").trim();
  const name = String(row["サークル名"] ?? "").trim();
  const pinX = parseFloat(String(row["ピンX"] ?? "0"));
  const pinY = parseFloat(String(row["ピンY"] ?? "0"));
  if (!space || !Number.isFinite(pinX) || !Number.isFinite(pinY) || !(pinX || pinY)) {
    resultEl.textContent = "校正点に追加するには、先にこのサークルのピンを配置してください";
    return;
  }
  if (!eventJsonData.event) eventJsonData.event = {};
  const eventObj = eventJsonData.event as Record<string, any>;
  const points = Array.isArray(eventObj.map_calibration_points)
    ? eventObj.map_calibration_points
    : [];
  const mapNumber = currentMapNumber();
  const nextPoint = {
    space,
    circle_name: name,
    map_number: mapNumber,
    pin_x: pinX,
    pin_y: pinY,
  };
  const idx = points.findIndex(
    (p: any) => p && p.space === space && Number(p.map_number || mapNumber) === mapNumber,
  );
  if (idx >= 0) {
    points[idx] = nextPoint;
  } else {
    points.push(nextPoint);
  }
  eventObj.map_calibration_points = points;
  void saveNow();
  resultEl.textContent = `校正点を追加しました: ${space} (${pinX.toFixed(4)}, ${pinY.toFixed(4)})`;
}

function showMapPinContextMenu(x: number, y: number, rowIdx: number) {
  document.querySelectorAll(".ctx-menu").forEach((m) => m.remove());
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const deleteItem = document.createElement("div");
  deleteItem.className = "ctx-menu-item danger";
  deleteItem.textContent = "ピンを削除";
  deleteItem.addEventListener("click", () => {
    menu.remove();
    tableState.rows[rowIdx]["ピンX"] = "0";
    tableState.rows[rowIdx]["ピンY"] = "0";
    saveNow();
    renderMapPins();
    renderMapCircleList();
    if (mapSelectedRow === rowIdx) {
      mapSelectedRow = -1;
      mapInfoCard.innerHTML = `<h4>サークル情報</h4><p class="hint">ピンをクリックして選択</p>`;
    }
  });
  menu.appendChild(deleteItem);

  document.body.appendChild(menu);
  const close = () => {
    menu.remove();
    document.removeEventListener("click", close);
  };
  setTimeout(() => document.addEventListener("click", close), 0);
}

// ピン追加モーダル
function showPinAddModal(normX: number, normY: number) {
  // 未配置サークルを取得
  const unplaced = tableState.rows
    .map((row, idx) => ({ row, idx }))
    .filter(({ row }) => {
      const px = parseFloat(String(row["ピンX"] ?? "0"));
      const py = parseFloat(String(row["ピンY"] ?? "0"));
      return !px && !py && String(row["サークル名"] ?? "").trim();
    });

  if (!unplaced.length) {
    resultEl.textContent = "未配置のサークルがありません";
    return;
  }

  const overlay = document.createElement("div");
  overlay.className = "pin-add-modal";

  const panel = document.createElement("div");
  panel.className = "pin-add-panel";
  panel.innerHTML = `<h4 class="m-0 mb-2">サークルを選択（座標: ${normX.toFixed(3)}, ${normY.toFixed(3)}）</h4>`;

  const searchInput = document.createElement("input");
  searchInput.placeholder = "サークル名で検索...";
  searchInput.style.width = "100%";
  panel.appendChild(searchInput);

  const listEl = document.createElement("div");
  listEl.className = "pin-add-list";
  panel.appendChild(listEl);

  function renderList(filter: string) {
    const filtered = filter
      ? unplaced.filter(({ row }) => {
          const name = String(row["サークル名"] ?? "").toLowerCase();
          const space = (
            String(row["ホール"] ?? "") + String(row["スペース"] ?? "")
          ).toLowerCase();
          return (
            name.includes(filter.toLowerCase()) ||
            space.includes(filter.toLowerCase())
          );
        })
      : unplaced;

    listEl.innerHTML = filtered
      .slice(0, 50)
      .map(({ row, idx }) => {
        const hall = String(row["ホール"] ?? "");
        const space = String(row["スペース"] ?? "");
        const name = String(row["サークル名"] ?? "");
        return `<div class="pin-add-item" data-idx="${idx}">${escapeHtml(hall + space)} ${escapeHtml(name)}</div>`;
      })
      .join("");

    listEl.querySelectorAll<HTMLDivElement>(".pin-add-item").forEach((item) => {
      item.addEventListener("click", () => {
        const idx = Number(item.dataset.idx);
        tableState.rows[idx]["ピンX"] = String(normX);
        tableState.rows[idx]["ピンY"] = String(normY);
        tableState.rows[idx]["マップ番号"] = String(currentMapNumber());
        saveNow();
        overlay.remove();
        renderMapPins();
        mapSelectedRow = idx;
        showMapInfo(idx);
      });
    });
  }

  searchInput.addEventListener("input", () => renderList(searchInput.value));
  renderList("");

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  searchInput.focus();
}

// サイドバーのサークルリスト描画
function renderMapCircleList() {
  const listEl = document.getElementById("mapCircleList") as HTMLDivElement;
  const searchEl = document.getElementById(
    "mapCircleSearch",
  ) as HTMLInputElement;
  const filterEl = document.getElementById(
    "mapCircleFilter",
  ) as HTMLSelectElement;
  if (!listEl) return;

  const query = (searchEl?.value || "").toLowerCase();
  const filterMode = filterEl?.value || "unplaced";

  const priorityOrder: Record<string, number> = {
    "15": 0,
    "10": 1,
    "11": 2,
    "5": 3,
  };
  const items = tableState.rows
    .map((row, idx) => ({ row, idx }))
    .filter(({ row }) => {
      const name = String(row["サークル名"] ?? "").trim();
      if (!name) return false;
      const px = parseFloat(String(row["ピンX"] ?? "0"));
      const py = parseFloat(String(row["ピンY"] ?? "0"));
      const placed = !!(px || py);
      if (filterMode === "unplaced" && placed) return false;
      if (filterMode === "placed" && !placed) return false;
      if (query) {
        const hall = String(row["ホール"] ?? "").toLowerCase();
        const space = String(row["スペース"] ?? "").toLowerCase();
        const tag = String(row["ペンネーム"] ?? "").toLowerCase();
        if (
          !name.toLowerCase().includes(query) &&
          !(hall + space).includes(query) &&
          !tag.includes(query)
        )
          return false;
      }
      return true;
    })
    .sort((a, b) => {
      const aColor = String(parseFloat(String(a.row["色"] ?? "5")) || 5);
      const bColor = String(parseFloat(String(b.row["色"] ?? "5")) || 5);
      return (priorityOrder[aColor] ?? 4) - (priorityOrder[bColor] ?? 4);
    });

  listEl.innerHTML = items
    .map(({ row, idx }) => {
      const hall = String(row["ホール"] ?? "");
      const space = String(row["スペース"] ?? "");
      const name = String(row["サークル名"] ?? "");
      const tag = String(row["ペンネーム"] ?? "");
      const cutVal = String(row["サークル画像"] ?? "").trim();
      const hasCut =
        cutVal &&
        cutVal !== "0.0" &&
        cutVal !== "0" &&
        !/^\d+(\.\d+)?$/.test(cutVal);
      const imgHtml = hasCut
        ? `<img src="${escapeHtml(resolveImageSrc(cutVal))}" alt="" data-fallback="hide" />`
        : `<div class="empty-cut"></div>`;
      const opt = getColorOption(String(row["色"] ?? "5"));
      const pinColor = opt ? opt.bgColor : "#ccc";
      const placing = idx === mapPlacingRow ? " placing" : "";
      const px = parseFloat(String(row["ピンX"] ?? "0"));
      const py = parseFloat(String(row["ピンY"] ?? "0"));
      const placedMark =
        px || py
          ? `<div class="circle-pin-badge" style="background-color:${pinColor};"></div>`
          : "";

      const colorClass = opt ? ` map-color-${opt.value}` : "";
      return `<div class="map-circle-item${placing}${colorClass}" data-idx="${idx}">
      ${imgHtml}
      <div class="circle-text">
        <div class="circle-name">${escapeHtml(hall + space)} ${escapeHtml(name)}</div>
        <div class="circle-sub">${escapeHtml(tag)}</div>
      </div>
      ${placedMark}
    </div>`;
    })
    .join("");

  if (!items.length) {
    listEl.innerHTML = `<div class="hint p-2">該当するサークルがありません</div>`;
  }

  // クリックイベント
  listEl.querySelectorAll<HTMLDivElement>(".map-circle-item").forEach((el) => {
    el.addEventListener("click", () => {
      const idx = Number(el.dataset.idx);
      const px = parseFloat(String(tableState.rows[idx]["ピンX"] ?? "0"));
      const py = parseFloat(String(tableState.rows[idx]["ピンY"] ?? "0"));

      if (px || py) {
        // 配置済み → ピンにフォーカス
        mapSelectedRow = idx;
        showMapInfo(idx);
        // マップ上のピンをハイライト
        mapInner
          .querySelectorAll(".map-pin.selected")
          .forEach((p) => p.classList.remove("selected"));
        const pin = mapInner.querySelector(`.map-pin[data-row="${idx}"]`);
        if (pin) pin.classList.add("selected");
        // そのピンが見えるようにパン
        const pinLeft = px * mapImgWidth + mapPinOffsetX;
        const pinTop = py * mapImgHeight + mapPinOffsetY;
        const vpW = mapViewport.clientWidth;
        const vpH = mapViewport.clientHeight;
        mapPanX = vpW / 2 - pinLeft * mapScale;
        mapPanY = vpH / 2 - pinTop * mapScale;
        updateMapTransform();
      } else {
        // 未配置 → 配置モード開始
        if (mapPlacingRow === idx) {
          // 同じサークルをもう一度クリック → 配置モード解除
          mapPlacingRow = -1;
          mapViewport.classList.remove("placing-mode");
        } else {
          mapPlacingRow = idx;
          mapViewport.classList.add("placing-mode");
        }
        renderMapCircleList();
      }
    });
  });
}

async function initMapEditor() {
  const owner = captureActiveEventDocumentOwner();
  // マップ画像一覧を取得
  try {
    const activeEvInit = activeEventSlug
      ? eventList.find((e) => e.slug === activeEventSlug)
      : null;
    const res = activeEvInit
      ? await invoke<{
          status: string;
          maps: EventMapImage[];
        }>("list_event_map_images", {
          eventDir: activeEvInit.dir,
          preferredRefs: preferredEventMapReferences(),
        })
      : await invoke<{
          status: string;
          maps: EventMapImage[];
        }>("list_map_images", { projectRoot: projectRootEl.value });
    if (!isActiveEventDocumentOwner(owner)) return;
    mapImagePaths = selectActiveMapImages(
      res.maps || [],
      preferredEventMapReferences(),
    );
    commitMapImagesToEventSession(owner, mapImagePaths);
  } catch {
    if (!isActiveEventDocumentOwner(owner)) return;
    mapImagePaths = [];
    commitMapImagesToEventSession(owner, mapImagePaths);
  }

  // マップ番号セレクタを構築
  const nums = getMapNumbers();
  mapNumberSelect.innerHTML = nums
    .map((n) => `<option value="${n}">マップ ${n || 1}</option>`)
    .join("");
  if (!nums.length)
    mapNumberSelect.innerHTML = `<option value="0">マップ 1</option>`;

  if (!mapSelectChangeBound) {
    mapNumberSelect.addEventListener("change", () => loadMapImage());
    mapSelectChangeBound = true;
  }

  // フィルターチップ
  mapFilterChips.innerHTML = "";
  for (const opt of COLOR_OPTIONS) {
    const chip = document.createElement("span");
    chip.className = "map-filter-chip";
    chip.style.borderColor = opt.color;
    chip.style.backgroundColor = opt.bgColor;
    chip.style.color = opt.color;
    chip.textContent = opt.label;
    chip.addEventListener("click", () => {
      mapColorFilter[opt.value] = !mapColorFilter[opt.value];
      chip.classList.toggle("off", !mapColorFilter[opt.value]);
      renderMapPins();
    });
    mapFilterChips.appendChild(chip);
  }
  // 未設定チップ
  const noneChip = document.createElement("span");
  noneChip.className = "map-filter-chip";
  noneChip.style.borderColor = "#999";
  noneChip.style.backgroundColor = "#eee";
  noneChip.style.color = "#666";
  noneChip.textContent = "未設定";
  noneChip.addEventListener("click", () => {
    mapColorFilter["none"] = !mapColorFilter["none"];
    noneChip.classList.toggle("off", !mapColorFilter["none"]);
    renderMapPins();
  });
  mapFilterChips.appendChild(noneChip);

  // ピン形状コントロール
  const pinWidthEl = document.getElementById("mapPinWidth") as HTMLInputElement;
  const pinHeightEl = document.getElementById("mapPinHeight") as HTMLInputElement;
  const pinOffsetXEl = document.getElementById("mapPinOffsetX") as HTMLInputElement;
  const pinOffsetYEl = document.getElementById("mapPinOffsetY") as HTMLInputElement;
  const pinOrientationEl = document.getElementById(
    "mapPinOrientation",
  ) as HTMLSelectElement;
  if (
    (pinWidthEl || pinHeightEl || pinOffsetXEl || pinOffsetYEl || pinOrientationEl) &&
    !mapPinControlsBound
  ) {
    pinWidthEl?.addEventListener("input", () => {
      mapPinWidth = Number(pinWidthEl.value);
      renderMapPins();
    });
    pinHeightEl?.addEventListener("input", () => {
      mapPinHeight = Number(pinHeightEl.value);
      renderMapPins();
    });
    pinOffsetXEl?.addEventListener("input", () => {
      mapPinOffsetX = Number(pinOffsetXEl.value);
      renderMapPins();
    });
    pinOffsetYEl?.addEventListener("input", () => {
      mapPinOffsetY = Number(pinOffsetYEl.value);
      renderMapPins();
    });
    pinOrientationEl?.addEventListener("change", () => {
      mapPinOrientation =
        pinOrientationEl.value === "horizontal" ? "horizontal" : "vertical";
      renderMapPins();
    });
    mapPinControlsBound = true;
  }

  loadMapImage();

  // サークルリストの検索・フィルターイベント
  const searchEl = document.getElementById(
    "mapCircleSearch",
  ) as HTMLInputElement;
  const filterEl = document.getElementById(
    "mapCircleFilter",
  ) as HTMLSelectElement;
  if (!mapCircleControlsBound) {
    searchEl?.addEventListener("input", () => renderMapCircleList());
    filterEl?.addEventListener("change", () => renderMapCircleList());
    mapCircleControlsBound = true;
  }
  renderMapCircleList();
}

function loadMapImage() {
  const generation = ++mapImageLoadGeneration;
  const owner = captureActiveEventDocumentOwner();
  const selectedMapNumber = currentMapNumber();
  const imgPath = getMapImagePath();
  const src = convertFileSrc(imgPath);
  const isCurrentLoad = () =>
    generation === mapImageLoadGeneration &&
    isActiveEventDocumentOwner(owner) &&
    currentMapNumber() === selectedMapNumber &&
    normalizeEventPath(getMapImagePath()) === normalizeEventPath(imgPath);
  if (isDesktopDevBuild) {
    logToFile(
      `マップ画像読み込み: path=${imgPath}, src=${src}, mapImages=${JSON.stringify(mapImagePaths)}`,
    );
  }
  mapInner.innerHTML = "";
  mapScale = 1;
  mapPanX = 0;
  mapPanY = 0;

  const img = new Image();
  img.onload = () => {
    if (!isCurrentLoad()) return;
    mapImgWidth = img.naturalWidth;
    mapImgHeight = img.naturalHeight;
    // 高DPIでもCSS上で正確なサイズで表示されるよう明示指定
    img.style.width = `${mapImgWidth}px`;
    img.style.height = `${mapImgHeight}px`;
    mapInner.style.width = `${mapImgWidth}px`;
    mapInner.style.height = `${mapImgHeight}px`;
    mapInner.innerHTML = "";
    mapInner.appendChild(img);
    fitMapToViewport();
    renderMapPins();
  };
  img.onerror = () => {
    if (!isCurrentLoad()) return;
    logToFile(`マップ画像読み込み失敗: path=${imgPath}, src=${src}`);
    mapImgWidth = 0;
    mapImgHeight = 0;
    mapInner.innerHTML = `<div class="map-error-msg">マップ画像が見つかりません<br><span class="map-error-path">${escapeHtml(imgPath)}</span><br><span class="map-error-src">${escapeHtml(src)}</span></div>`;
  };
  img.src = src;
}

// マップ パン操作
let mapPanning = false;
let mapPanStartX = 0;
let mapPanStartY = 0;
let mapPanOrigX = 0;
let mapPanOrigY = 0;

mapViewport.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  mapPanning = true;
  mapViewport.classList.add("grabbing");
  mapPanStartX = e.clientX;
  mapPanStartY = e.clientY;
  mapPanOrigX = mapPanX;
  mapPanOrigY = mapPanY;
});

document.addEventListener("mousemove", (e) => {
  if (!mapPanning) return;
  mapPanX = mapPanOrigX + (e.clientX - mapPanStartX);
  mapPanY = mapPanOrigY + (e.clientY - mapPanStartY);
  updateMapTransform();
});

document.addEventListener("mouseup", () => {
  if (mapPanning) {
    mapPanning = false;
    mapViewport.classList.remove("grabbing");
  }
});

// マップ ズーム
mapViewport.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const rect = mapViewport.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const newScale = Math.max(0.1, Math.min(10, mapScale * factor));

    // マウス位置を中心にズーム
    mapPanX = mouseX - (mouseX - mapPanX) * (newScale / mapScale);
    mapPanY = mouseY - (mouseY - mapPanY) * (newScale / mapScale);
    mapScale = newScale;
    updateMapTransform();
  },
  { passive: false },
);

// マップクリック: 配置モード中なら座標設定、ダブルクリックならモーダル
mapViewport.addEventListener("click", (e) => {
  // 配置モードでなく、ピン以外をクリックした場合は選択解除
  if (mapPlacingRow < 0 && mapSelectedRow >= 0) {
    mapSelectedRow = -1;
    mapInner
      .querySelectorAll(".map-pin.selected")
      .forEach((p) => p.classList.remove("selected"));
    mapInfoCard.innerHTML = `<h4>サークル情報</h4><p class="hint">ピンをクリックして選択</p>`;
  }
  if (mapPlacingRow < 0 || !mapImgWidth || !mapImgHeight) return;
  // パン操作直後のクリックは無視（5px以上動いていたら）
  if (
    Math.abs(e.clientX - mapPanStartX) > 5 ||
    Math.abs(e.clientY - mapPanStartY) > 5
  )
    return;

  const rect = mapViewport.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;
  const imgX = (mouseX - mapPanX) / mapScale;
  const imgY = (mouseY - mapPanY) / mapScale;
  const normX = imgX / mapImgWidth;
  const normY = imgY / mapImgHeight;
  if (normX < 0 || normX > 1 || normY < 0 || normY > 1) return;

  tableState.rows[mapPlacingRow]["ピンX"] = String(normX);
  tableState.rows[mapPlacingRow]["ピンY"] = String(normY);
  tableState.rows[mapPlacingRow]["マップ番号"] = String(currentMapNumber());
  saveNow();

  mapSelectedRow = mapPlacingRow;
  mapPlacingRow = -1;
  mapViewport.classList.remove("placing-mode");
  renderMapPins();
  showMapInfo(mapSelectedRow);
  renderMapCircleList();
});

// ダブルクリック → モーダルからのピン追加（フォールバック）
mapViewport.addEventListener("dblclick", (e) => {
  if (mapPlacingRow >= 0) return; // 配置モード中はスキップ
  if (!mapImgWidth || !mapImgHeight) return;
  const rect = mapViewport.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;
  const imgX = (mouseX - mapPanX) / mapScale;
  const imgY = (mouseY - mapPanY) / mapScale;
  const normX = imgX / mapImgWidth;
  const normY = imgY / mapImgHeight;
  if (normX < 0 || normX > 1 || normY < 0 || normY > 1) return;
  showPinAddModal(normX, normY);
});

// マップ画像差し替え
function imageExtFromName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return IMAGE_EXTENSIONS.includes(ext) ? ext : "jpg";
}

function normalizeFsPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function eventAssetDir(eventDir: string, subdir: string): string {
  return `${normalizeFsPath(eventDir)}/${subdir}`;
}

function eventRelativeAssetPath(subdir: string, fileName: string): string {
  const safeName = fileName.replace(/\\/g, "/").split("/").pop() || fileName;
  return `${subdir}/${safeName}`;
}

function imageColumnAssetSubdir(col: string): "circles" | "items" {
  return col === "サークル画像" ? "circles" : "items";
}

function resolveEventAssetFilePath(eventDir: string, ref: string): string {
  const normalized = String(ref || "").replace(/\\/g, "/");
  if (
    !normalized ||
    normalized.startsWith("file://") ||
    normalized.startsWith("http://") ||
    normalized.startsWith("https://") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized)
  ) {
    return normalized;
  }
  const baseDir = normalizeFsPath(eventDir);
  return baseDir ? `${baseDir}/${normalized}` : normalized;
}

async function saveMapImageFromPath(
  sourcePath: string,
  num: number,
  capturedEventDir = getActiveEventDir(),
) {
  markEventDocumentMutated();
  const owner = captureActiveEventDocumentOwner();
  const activeDir = capturedEventDir;
  const destDir = activeDir ? eventAssetDir(activeDir, "maps") : "";
  if (!destDir) throw new Error("イベントフォルダが選択されていません");
  const destName = mapFileNameFor(num, imageExtFromName(sourcePath));
  const serialKey = `${owner.slug ?? ""}\n${owner.path}\n${num}`;
  await mapImageMutationSerial.run(serialKey, async () => {
    if (!isActiveEventDocumentOwner(owner)) return;
    await invokeActiveEventAssetWrite("copy_file_as", {
      sourcePath,
      destDir,
      fileName: destName,
    });
    if (!isActiveEventDocumentOwner(owner)) return;
    await refreshMapImages(num, eventRelativeAssetPath("maps", destName));
    if (!isActiveEventDocumentOwner(owner)) return;
    syncEventMapMetadata();
    await saveNow();
    if (!isActiveEventDocumentOwner(owner)) return;
    loadMapImage();
  });
}

async function saveMapImageFromDataTransfer(dt: DataTransfer, num: number) {
  markEventDocumentMutated();
  const owner = captureActiveEventDocumentOwner();
  const activeDir = getActiveEventDir();
  const destDir = activeDir ? eventAssetDir(activeDir, "maps") : "";
  if (!destDir) throw new Error("イベントフォルダが選択されていません");
  const droppedFile = dt.files && dt.files.length > 0 ? dt.files[0] : null;
  const droppedUrl = droppedFile ? "" : imageUrlFromDataTransfer(dt);
  const serialKey = `${owner.slug ?? ""}\n${owner.path}\n${num}`;
  await mapImageMutationSerial.run(serialKey, async () => {
    if (!isActiveEventDocumentOwner(owner)) return;
    let destName = "";
    if (droppedFile) {
      destName = mapFileNameFor(num, imageExtFromName(droppedFile.name));
      const buf = await droppedFile.arrayBuffer();
      if (!isActiveEventDocumentOwner(owner)) return;
      const bytes = Array.from(new Uint8Array(buf));
      await invokeActiveEventAssetWrite("save_image_bytes", { destDir, fileName: destName, bytes });
    } else {
      const imageUrl = droppedUrl;
      if (!imageUrl || isInternalAppImageUrl(imageUrl)) return;
      destName = mapFileNameFor(
        num,
        imageExtFromName(fileNameFromUrl(imageUrl)),
      );
      await invokeActiveEventAssetWrite("download_image", { url: imageUrl, destDir, fileName: destName });
    }
    if (!isActiveEventDocumentOwner(owner)) return;
    await refreshMapImages(num, eventRelativeAssetPath("maps", destName));
    if (!isActiveEventDocumentOwner(owner)) return;
    syncEventMapMetadata();
    await saveNow();
    if (!isActiveEventDocumentOwner(owner)) return;
    loadMapImage();
  });
}

async function runMapAutoPlacement(useCalibration: boolean) {
  const generation = ++mapAutoPlacementGeneration;
  if (!canStartMapAuto(operationState)) {
    resultEl.textContent =
      "別のイベント処理を実行中です。完了後にマップ自動配置を再実行してください。";
    return;
  }
  const eventDir = getActiveEventDir();
  const eventJsonPath = getActiveEventJsonPath();
  if (!eventDir || !eventJsonPath) {
    resultEl.textContent = "サイドバーでイベントを選択してください";
    return;
  }
  const autoBtn = document.getElementById("mapAutoPlaceBtn") as HTMLButtonElement;
  const calibrationBtn = document.getElementById(
    "mapReprocessWithCalibrationBtn",
  ) as HTMLButtonElement;
  applyOperationEvent({ type: "request-map-auto" });
  markEventDocumentMutated();
  const mutationTabs = ["sidebar", "tab-crawl", "tab-edit", "tab-map"]
    .map((id) => document.getElementById(id) as HTMLElement | null)
    .filter((tab): tab is HTMLElement => Boolean(tab));
  mutationTabs.forEach((tab) => {
    tab.inert = true;
  });
  autoBtn.disabled = true;
  calibrationBtn.disabled = true;
  let backendSucceeded = false;
  let reloadCommitted = false;
  try {
    const crawlSnapshot = captureCrawlMetaSnapshot();
    cancelCrawlMetaSave();
    await flushCrawlMetaSnapshot(crawlSnapshot, INTERNAL_OPERATION_SAVE);
    const pendingSave = saveNow(INTERNAL_OPERATION_SAVE);
    // saveNowは最初のawaitまでにsnapshot/revisionを確定する。
    const saveRevision = eventDocumentStateRevision;
    const saveResult = await pendingSave;
    if (!saveResult.ok) {
      resultEl.textContent = `マップ処理前のevent.json保存に失敗しました: ${String(saveResult.error)}`;
      return;
    }
    await eventSaveQueue.flushKey(eventMetaOwnerKey(activeEventSlug || "", eventDir));
    if (eventDocumentStateRevision !== saveRevision) {
      resultEl.textContent =
        "マップ処理前の保存中に編集されたため、自動配置を中止しました。もう一度実行してください。";
      return;
    }
    const owner = captureActiveEventDocumentOwner();
    const ownerRevision = eventDocumentStateRevision;
    const isCurrentOperation = () =>
      generation === mapAutoPlacementGeneration &&
      isActiveEventDocumentOwner(owner) &&
      eventDocumentStateRevision === ownerRevision &&
      isMapAutoOperation(operationState);
    const reportDiscarded = () => {
      if (generation === mapAutoPlacementGeneration) {
        resultEl.textContent =
          "自動配置中にイベント切替または編集があったため、取得結果を画面へ反映しませんでした。";
      }
    };
    const mapNumber = currentMapNumber();
    resultEl.textContent = useCalibration
      ? `マップ ${mapNumber} を校正点で再処理中...`
      : `マップ ${mapNumber} のピンを自動配置中...`;
    applyOperationEvent({ type: "map-auto-started" });
    const response = await runJob("auto_place_map_pins", {
      event_dir: eventDir,
      event_json: eventJsonPath,
      map_number: mapNumber,
      use_calibration: useCalibration,
      image_llm_model: selectedImageModel() || selectedImageFallbackModel(),
      ocr_config: currentOcrConfigPayload(),
    });
    const bridge = response?.bridge as Record<string, any> | undefined;
    if (!response?.ok || bridge?.status !== "ok") {
      const ocrDiagnostics = formatOcrDiagnostics(bridge?.ocr_diagnostics);
      resultEl.textContent =
        `マップピン自動配置に失敗しました: ${bridge?.error || response?.stderr || "不明なエラー"}` +
        ocrDiagnostics;
      return;
    }

    const bridgeCirclePatches = Array.isArray(bridge.circle_patches)
      ? bridge.circle_patches.map((value: Record<string, any>) =>
          circlePatchFromBridge(value),
        )
      : [];
    const appliedPatch = await retryUntilValue<{
      data: EventJsonData;
      resolvedCircleIndices: number[];
    }>({
      attempt: async () => {
        try {
          return await applyBridgeEventPatch(
            owner.slug || "",
            eventDir,
            {
              baseFingerprint: normalizeNativeEventFingerprint(
                bridge.base_fingerprint as NativeEventFingerprint | undefined,
              ),
              circlePatches: bridgeCirclePatches,
            },
          );
        } catch (error) {
          const message = String(error);
          // A native CAS miss is transient: reload and reapply to the new
          // latest document.  Identity/field conflicts are semantic and must
          // fail instead of holding the UI in an endless recovery loop.
          if (
            message.includes("fingerprint conflict") ||
            message.includes("最新event.jsonを読み込めません")
          ) {
            return null;
          }
          throw error;
        }
      },
      onFailure: (retryCount) => {
        if (operationState.kind === "map-auto-running") {
          applyOperationEvent({ type: "map-auto-reload-failed" });
        }
        resultEl.textContent =
          `自動配置結果の再読み込みに失敗しました。編集と保存をロックしたまま再試行します (${retryCount})...`;
      },
      wait: async () => {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 1500));
        if (operationState.kind === "map-auto-recovery") {
          applyOperationEvent({ type: "retry-map-auto-reload" });
        }
      },
    });
    if (!isCurrentOperation()) {
      reportDiscarded();
      return;
    }
    backendSucceeded = true;
    if (!isCurrentOperation()) {
      resultEl.textContent =
        "自動配置後の所有状態が一致しません。編集と保存をロックしたまま再読み込みが必要です。";
      return;
    }
    eventJsonData = appliedPatch.data;
    tableState = circlesToTableState(eventJsonData);
    persistedEventJsonData = cloneJsonSnapshot(eventJsonData);
    eventTableBaseline = cloneJsonSnapshot(tableState);
    markEventDocumentMutated();
    renderCircleEditorAndMap();
    await eventSaveQueue.flushKey(eventMetaOwnerKey(activeEventSlug || "", eventDir));
    reloadCommitted = true;
    const calibration = bridge.calibration as Record<string, any> | undefined;
    const calibrationText = calibration?.applied
      ? ` / 校正: ${calibration.mode} ${calibration.points}点`
      : "";
    resultEl.textContent = `マップ ${mapNumber} の自動配置完了: 更新 ${bridge.updated_count ?? 0}件 / 生成 ${bridge.generated_count ?? 0}件${calibrationText}`;
  } catch (err) {
    resultEl.textContent = `マップピン自動配置エラー: ${String(err)}`;
  } finally {
    const mayUnlock = !backendSucceeded || reloadCommitted;
    if (mayUnlock && isMapAutoOperation(operationState)) {
      applyOperationEvent({ type: "finish-map-auto" });
    }
    if (mayUnlock) {
      mutationTabs.forEach((tab) => {
        tab.inert = false;
      });
      autoBtn.disabled = false;
      calibrationBtn.disabled = false;
    }
  }
}

(
  document.getElementById("mapChangeImgBtn") as HTMLButtonElement
).addEventListener("click", async () => {
  const guard = captureEventAsyncMutationGuard();
  if (!guard) return;
  const capturedEventDir = getActiveEventDir();
  const num = currentMapNumber() || 1;
  const selected = await dialogOpen({
    multiple: false,
    filters: [{ name: "画像ファイル", extensions: IMAGE_EXTENSIONS }],
  });
  if (!guard.isCurrent()) return;
  if (selected && typeof selected === "string") {
    try {
      await saveMapImageFromPath(selected, num, capturedEventDir);
    } catch (err) {
      resultEl.textContent = `マップ画像コピー失敗: ${String(err)}`;
      return;
    }
    loadMapImage();
  }
});

// データロード後にマップも初期化
(
  document.getElementById("mapAddImgBtn") as HTMLButtonElement
).addEventListener("click", async () => {
  const guard = captureEventAsyncMutationGuard();
  if (!guard) return;
  const capturedEventDir = getActiveEventDir();
  const num = nextMapNumber();
  const selected = await dialogOpen({
    multiple: false,
    filters: [{ name: "画像ファイル", extensions: IMAGE_EXTENSIONS }],
  });
  if (!guard.isCurrent()) return;
  if (selected && typeof selected === "string") {
    try {
      await saveMapImageFromPath(selected, num, capturedEventDir);
    } catch (err) {
      resultEl.textContent = `マップ画像追加失敗: ${String(err)}`;
    }
  }
});

(document.getElementById("mapAutoPlaceBtn") as HTMLButtonElement).addEventListener(
  "click",
  () => {
    void runMapAutoPlacement(false);
  },
);

(
  document.getElementById("mapReprocessWithCalibrationBtn") as HTMLButtonElement
).addEventListener("click", () => {
  void runMapAutoPlacement(true);
});

mapViewport.addEventListener("dragover", (e) => {
  if (!e.dataTransfer) return;
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer.dropEffect = "copy";
  mapViewport.classList.add("map-drop-over");
});

mapViewport.addEventListener("dragleave", (e) => {
  if (!mapViewport.contains(e.relatedTarget as Node | null)) {
    mapViewport.classList.remove("map-drop-over");
  }
});

mapViewport.addEventListener("drop", async (e) => {
  e.preventDefault();
  e.stopPropagation();
  mapViewport.classList.remove("map-drop-over");
  const dt = e.dataTransfer;
  if (!dt) return;
  try {
    await saveMapImageFromDataTransfer(dt, currentMapNumber());
  } catch (err) {
    resultEl.textContent = `マップ画像D&D失敗: ${String(err)}`;
  }
});

function renderCircleEditorAndMap() {
  markEventSwitch("event-switch:table-first-paint");
  renderCircleEditor();
  applyPurchaseStatusColors();
  if (tableState.headers.length) {
    // MapEditorは最初のtable paintをブロックしない。Mapタブを開いていない
    // 場合も次のframe以降に遅延初期化する。
    const mapEpoch = selectionEpoch;
    const mapOwner = captureActiveEventDocumentOwner();
    window.setTimeout(() => {
      if (
        !tableState.headers.length ||
        mapEpoch !== selectionEpoch ||
        !isActiveEventDocumentOwner(mapOwner)
      ) {
        return;
      }
      void initMapEditor()
        .then(() => {
          markEventSwitch("event-switch:map-ready");
          measureEventSwitch(
            "event-switch:map-ready-duration",
            "event-switch:click",
            "event-switch:map-ready",
          );
        })
        .catch(() => undefined);
    }, 0);
  }
}

// === 画像セルへのクリップボードペースト対応 ===
document.addEventListener("paste", async (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  // フォーカスがinput/textareaの場合は通常のペーストを優先
  const activeEl = document.activeElement;
  if (
    activeEl &&
    (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA")
  )
    return;

  // 画像セルがフォーカスされているか、最後にクリックされた画像セルを対象にする
  const focusedCell =
    activeEl?.closest<HTMLTableCellElement>(
      ".img-clickable[data-row][data-col]",
    ) ||
    document.querySelector<HTMLTableCellElement>(".img-clickable.last-clicked");
  if (!focusedCell) return;

  for (let i = 0; i < items.length; i++) {
    if (items[i].type.startsWith("image/")) {
      e.preventDefault();
      const blob = items[i].getAsFile();
      if (!blob) continue;
      const row = Number(focusedCell.dataset.row);
      const col = String(focusedCell.dataset.col);
      const guard = captureEventAsyncMutationGuard(row);
      if (!guard) return;
      const activeEvPaste = activeEventSlug
        ? eventList.find((ev) => ev.slug === activeEventSlug)
        : null;
      const subdir = imageColumnAssetSubdir(col);
      const destDir = activeEvPaste?.dir
        ? eventAssetDir(activeEvPaste.dir, subdir)
        : "";
      const ext = blob.type.split("/")[1] || "png";
      const fileName = `paste_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const buf = await blob.arrayBuffer();
      if (!guard.isCurrent()) return;
      const bytes = Array.from(new Uint8Array(buf));
      try {
        await invokeActiveEventAssetWrite("save_image_bytes", { destDir, fileName, bytes });
      } catch (error) {
        resultEl.textContent = `画像保存失敗: ${String(error)}`;
        return;
      }
      if (!guard.isCurrent()) return;
      applyImageToCell(
        focusedCell,
        row,
        col,
        eventRelativeAssetPath(subdir, fileName),
      );
      return;
    }
  }
});

// 画像セルクリック時にlast-clickedマーカーを付与（ペースト対象の判定用）
circleEditorEl.addEventListener("click", (e) => {
  const cell = (e.target as HTMLElement).closest<HTMLTableCellElement>(
    ".img-clickable[data-row][data-col]",
  );
  circleEditorEl
    .querySelectorAll(".img-clickable.last-clicked")
    .forEach((c) => c.classList.remove("last-clicked"));
  if (cell) cell.classList.add("last-clicked");
});

// === 画像セルへのドラッグ&ドロップ（ファイル / Web画像URL 両対応） ===
let dragHighlighted: HTMLElement | null = null;

document.addEventListener("dragover", (e) => {
  if (!dataTransferHasImage(e.dataTransfer)) {
    if (dragHighlighted) {
      dragHighlighted.classList.remove("drag-over");
      dragHighlighted = null;
    }
    return;
  }
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const cell = el?.closest<HTMLTableCellElement>(
    ".img-clickable[data-row][data-col]",
  );
  if (dragHighlighted && dragHighlighted !== cell) {
    dragHighlighted.classList.remove("drag-over");
  }
  if (cell) {
    cell.classList.add("drag-over");
    dragHighlighted = cell;
  } else {
    dragHighlighted = null;
  }
});

document.addEventListener("dragleave", (e) => {
  if (e.clientX === 0 && e.clientY === 0 && dragHighlighted) {
    dragHighlighted.classList.remove("drag-over");
    dragHighlighted = null;
  }
});

document.addEventListener("drop", async (e) => {
  e.preventDefault();
  if (dragHighlighted) dragHighlighted.classList.remove("drag-over");
  const cell = dragHighlighted as HTMLTableCellElement | null;
  dragHighlighted = null;
  if (!cell) return;

  const dt = e.dataTransfer;
  if (!dt) return;
  const row = Number(cell.dataset.row);
  const col = String(cell.dataset.col);
  const guard = captureEventAsyncMutationGuard(row);
  if (!guard) return;
  const activeEvDrop = activeEventSlug
    ? eventList.find((e) => e.slug === activeEventSlug)
    : null;
  const subdir = imageColumnAssetSubdir(col);
  const destDir = activeEvDrop?.dir ? eventAssetDir(activeEvDrop.dir, subdir) : "";

  // 1. ローカルファイル
  if (dt.files && dt.files.length > 0) {
    const file = dt.files[0];
    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    if (!IMAGE_EXTENSIONS.includes(ext)) return;
    const buf = await file.arrayBuffer();
    if (!guard.isCurrent()) return;
    const bytes = Array.from(new Uint8Array(buf));
    const uniqueFileName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${file.name}`;
    try {
      await invokeActiveEventAssetWrite("save_image_bytes", {
        destDir,
        fileName: uniqueFileName,
        bytes,
      });
    } catch (error) {
      resultEl.textContent = `画像保存失敗: ${String(error)}`;
      return;
    }
    if (!guard.isCurrent()) return;
    applyImageToCell(
      cell,
      row,
      col,
      eventRelativeAssetPath(subdir, uniqueFileName),
    );
    return;
  }

  // 2. Web画像URL（ブラウザからのD&D）
  const imageUrl = imageUrlFromDataTransfer(dt);
  if (!imageUrl) return;
  if (isInternalAppImageUrl(imageUrl)) return;
  const rawFileName = fileNameFromUrl(imageUrl);
  const fileName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${rawFileName}`;
  try {
    await invokeActiveEventAssetWrite("download_image", { url: imageUrl, destDir, fileName });
  } catch (err) {
    const msg = `画像ダウンロード失敗: ${String(err)} (URL: ${imageUrl})`;
    resultEl.textContent = msg;
    logToFile(msg);
    return;
  }
  if (!guard.isCurrent()) return;
  applyImageToCell(cell, row, col, eventRelativeAssetPath(subdir, fileName));
});

// === イベント管理 ===

type EventMeta = {
  name?: string;
  /** 空欄はJSON nullで明示削除し、undefined（未提示）は既存値を保持する。 */
  date?: string | null;
  venue?: string | null;
  event_url?: string | null;
  event_urls?: string[] | null;
  /** Rust側の旧alias。event_url clear時もurl:nullを併記して確実に消す。 */
  url?: string | null;
  map_url?: string | null;
  map_config?: string | null;
  additional_prompt?: string | null;
  created_at?: string;
  source?: string;
  memo?: string;
  completed?: boolean;
  shopping_started_at?: string;
  shopping_ended_at?: string;
  event_image?: string | null;
  purchase_results?: {
    total: number;
    bought: number;
    couldnt_buy: number;
    remaining: number;
  };
};

type EventEntry = {
  slug: string;
  dir: string;
  meta: EventMeta;
};

let eventList: EventEntry[] = [];
let activeEventSlug: string | null = null;
let crawlMetaSaveTimer: number | null = null;
let syncInProgress = false;
let renameInProgress = false;
function eventMetaOwnerKey(slug: string, dir: string): string {
  return `${slug}\n${normalizeEventPath(dir)}`;
}

type EventMetaWriteOptions = {
  requireListedOwner?: boolean;
  commitToEventList?: boolean;
  isCurrent?: () => boolean;
  onCommit?: (meta: EventMeta) => void;
};

async function writeEventMetaSnapshot(
  owner: Pick<EventEntry, "slug" | "dir">,
  meta: EventMeta,
  options: EventMetaWriteOptions = {},
): Promise<boolean> {
  const ownerDir = normalizeEventPath(owner.dir);
  const activeRawEvent =
    activeEventSlug === owner.slug &&
    normalizeEventPath(editorJsonPathValue()) === eventJsonPathForDir(ownerDir)
      ? eventJsonData?.event
      : null;
  // event metaフォームが認識しないraw event fieldsも維持する。明示clearは
  // caller snapshotのundefinedがraw値を上書きし、JSON送信時にabsenceになる。
  const writeSnapshot = {
    ...(activeRawEvent ? cloneJsonSnapshot(activeRawEvent) : {}),
    ...cloneJsonSnapshot(meta),
  } as EventMeta;
  const requireListedOwner = options.requireListedOwner !== false;
  const result = await eventMetaWriteCoordinator.run({
    key: eventMetaOwnerKey(owner.slug, ownerDir),
    snapshot: writeSnapshot,
    isCurrent: () => {
      if (options.isCurrent && !options.isCurrent()) return false;
      if (!requireListedOwner) return true;
      const current = eventList.find((entry) => entry.slug === owner.slug);
      return Boolean(
        current && normalizeEventPath(current.dir) === ownerDir,
      );
    },
    write: (snapshot) =>
      invoke("write_event_meta", { eventDir: ownerDir, meta: snapshot }),
    commit: (snapshot) => {
      if (options.commitToEventList !== false) {
        const current = eventList.find((entry) => entry.slug === owner.slug);
        if (current && normalizeEventPath(current.dir) === ownerDir) {
          // 非同期画像操作が捕捉したmeta object identityを維持しつつ、
          // 成功したsnapshotのoptional field absenceも正確に反映する。
          for (const key of Object.keys(current.meta)) {
            if (!Object.prototype.hasOwnProperty.call(snapshot, key)) {
              delete (current.meta as Record<string, unknown>)[key];
            }
          }
          Object.assign(current.meta, snapshot);
        }
      }
      if (
        activeEventSlug === owner.slug &&
        normalizeEventPath(editorJsonPathValue()) === eventJsonPathForDir(ownerDir)
      ) {
        const reconcileEventSection = (documentData: EventJsonData | null) => {
          if (!documentData) return;
          const currentEvent = (documentData.event ??= {});
          for (const key of Object.keys(currentEvent)) {
            if (!Object.prototype.hasOwnProperty.call(snapshot, key)) {
              delete (currentEvent as Record<string, unknown>)[key];
            }
          }
          Object.assign(currentEvent, snapshot);
        };
        reconcileEventSection(eventJsonData);
        reconcileEventSection(persistedEventJsonData);
      }
      options.onCommit?.(snapshot);
    },
  });
  return result.committed;
}

function updateConcurrentEventSummary() {
  const el = document.getElementById("concurrentEventSummary");
  if (!el) return;
  const urls = parseEventUrlList(
    (document.getElementById("eventUrl") as HTMLTextAreaElement)?.value || "",
  );
  if (urls.length <= 1) {
    el.textContent = "";
    return;
  }
  el.textContent = `併催イベント: ${urls.length}件`;
}

/** クロールフォームの変更をイベントメタデータに自動保存（1秒デバウンス） */
type CrawlMetaSnapshot = {
  ownerSlug: string;
  ownerDir: string;
  meta: EventMeta;
  editRevision: number;
};

// クロールmetaのrevisionはactive globalではなくイベント所有者ごとに保持する。
// A→B切替後にAのdebounce writeが遅れて完了しても、Bのフォーム/state revisionを
// 汚染しない。mapは派生状態で、イベントdelete/rename時に局所的に移動/破棄する。
const crawlMetaEditRevisions = new Map<string, number>();
const persistedCrawlMetaRevisions = new Map<string, number>();

function crawlMetaRevisionKey(slug: string, dir: string): string {
  return eventMetaOwnerKey(slug, dir);
}

function crawlMetaEditRevisionFor(slug: string, dir: string): number {
  return crawlMetaEditRevisions.get(crawlMetaRevisionKey(slug, dir)) ?? 0;
}

function persistedCrawlMetaRevisionFor(slug: string, dir: string): number {
  return persistedCrawlMetaRevisions.get(crawlMetaRevisionKey(slug, dir)) ?? 0;
}

function bumpCrawlMetaEditRevision(slug: string, dir: string): number {
  const key = crawlMetaRevisionKey(slug, dir);
  const next = (crawlMetaEditRevisions.get(key) ?? 0) + 1;
  crawlMetaEditRevisions.set(key, next);
  return next;
}

function markCrawlMetaPersisted(slug: string, dir: string, revision: number): void {
  const key = crawlMetaRevisionKey(slug, dir);
  persistedCrawlMetaRevisions.set(
    key,
    Math.max(persistedCrawlMetaRevisions.get(key) ?? 0, revision),
  );
}

function renameCrawlMetaOwner(
  oldSlug: string,
  oldDir: string,
  newSlug: string,
  newDir: string,
): void {
  const oldKey = crawlMetaRevisionKey(oldSlug, oldDir);
  const newKey = crawlMetaRevisionKey(newSlug, newDir);
  const edit = crawlMetaEditRevisions.get(oldKey);
  const persisted = persistedCrawlMetaRevisions.get(oldKey);
  crawlMetaEditRevisions.delete(oldKey);
  persistedCrawlMetaRevisions.delete(oldKey);
  if (edit !== undefined) crawlMetaEditRevisions.set(newKey, edit);
  if (persisted !== undefined) persistedCrawlMetaRevisions.set(newKey, persisted);
}

function removeCrawlMetaOwner(slug: string, dir: string): void {
  const key = crawlMetaRevisionKey(slug, dir);
  crawlMetaEditRevisions.delete(key);
  persistedCrawlMetaRevisions.delete(key);
}

function captureCrawlMetaSnapshot(): CrawlMetaSnapshot | null {
  if (!activeEventSlug) return null;
  const ev = eventList.find((event) => event.slug === activeEventSlug);
  if (!ev) return null;
  const editRevision = crawlMetaEditRevisionFor(ev.slug, ev.dir);
  if (editRevision <= persistedCrawlMetaRevisionFor(ev.slug, ev.dir)) return null;
  const eventName = (document.getElementById("eventName") as HTMLInputElement).value.trim();
  const eventUrl = (document.getElementById("eventUrl") as HTMLInputElement).value.trim();
  const eventUrls = parseEventUrlList(eventUrl);
  const eventDate = (document.getElementById("eventDate") as HTMLInputElement).value;
  const mapUrl = (document.getElementById("mapUrl") as HTMLInputElement).value.trim();
  const additionalPrompt = displayAdditionalPromptText(
    (document.getElementById("additionalPrompt") as HTMLTextAreaElement).value,
  );
  const mapConfig = parseEventMapConfig(mapUrl, eventUrls);
  // フォームの空欄は「未提示(undefined)」ではなく、既知metadataの明示削除
  // としてnullを送る。Rust write_event_metaはnullだけをclear扱いし、
  // incomingにない未知/raw fieldは保持する。
  const eventUrlValue = eventUrls[0] || eventUrl || null;
  const eventUrlsValue = eventUrls.length ? eventUrls : null;
  const mapConfigValue = eventUrls.length > 1 && mapUrl ? mapUrl : null;
  const mapUrlValue = mapConfig.allMapUrls[0] || mapUrl || null;
  const additionalPromptValue = additionalPrompt || null;
  const meta: EventMeta = {
    ...cloneJsonSnapshot(ev.meta),
    name: eventName || ev.meta.name,
    date: eventDate || null,
    event_url: eventUrlValue,
    event_urls: eventUrlsValue,
    url: eventUrlValue,
    map_config: mapConfigValue,
    map_url: mapUrlValue,
    additional_prompt: additionalPromptValue,
  };
  return {
    ownerSlug: ev.slug,
    ownerDir: ev.dir,
    meta,
    editRevision,
  };
}

function flushCrawlMetaSnapshot(
  snapshot: CrawlMetaSnapshot | null,
  permit?: InternalOperationSavePermit,
): Promise<void> {
  if (!snapshot) return Promise.resolve();
  if (isOperationBusy(operationState) && permit !== INTERNAL_OPERATION_SAVE) {
    return Promise.reject(new Error("イベント処理中はイベントメタデータを保存できません"));
  }
  const ownerKey = crawlMetaRevisionKey(snapshot.ownerSlug, snapshot.ownerDir);
  const isOwnerRevisionCurrent = () => {
    const owner = eventList.find(
      (event) =>
        event.slug === snapshot.ownerSlug &&
        normalizeEventPath(event.dir) === normalizeEventPath(snapshot.ownerDir),
    );
    return Boolean(owner) &&
      (crawlMetaEditRevisions.get(ownerKey) ?? 0) === snapshot.editRevision;
  };
  return writeEventMetaSnapshot(
    { slug: snapshot.ownerSlug, dir: snapshot.ownerDir },
    snapshot.meta,
    {
      // owner slug/dir + owner revisionをCASにする。activeEventSlugやBのglobal
      // form/stateを参照しないため、Aの遅いwrite完了はBへ反映されない。
      isCurrent: isOwnerRevisionCurrent,
      onCommit: () => {
        markCrawlMetaPersisted(
          snapshot.ownerSlug,
          snapshot.ownerDir,
          snapshot.editRevision,
        );
      },
    },
  ).then((committed) => {
    if (!committed && isOwnerRevisionCurrent()) {
      throw new Error("イベントメタデータの保存対象が切り替わりました");
    }
  });
}

function cancelCrawlMetaSave(): void {
  if (crawlMetaSaveTimer) clearTimeout(crawlMetaSaveTimer);
  crawlMetaSaveTimer = null;
}

function scheduleCrawlMetaSave() {
  if (isOperationBusy(operationState) || renameInProgress) return;
  if (!activeEventSlug) return;
  const owner = eventList.find((event) => event.slug === activeEventSlug);
  if (!owner) return;
  cancelCrawlMetaSave();
  markEventDocumentMutated();
  bumpCrawlMetaEditRevision(owner.slug, owner.dir);
  const snapshot = captureCrawlMetaSnapshot();
  if (!snapshot) return;
  crawlMetaSaveTimer = window.setTimeout(() => {
    crawlMetaSaveTimer = null;
    void flushCrawlMetaSnapshot(snapshot).catch((error) => {
      console.error("クロール情報保存エラー:", error);
    });
  }, 1000);
}

const NEW_EVENT_NAME = "新規イベント";

function isPlaceholderEventName(name?: string | null): boolean {
  return !name || name.trim() === "" || name.trim() === NEW_EVENT_NAME;
}

/** イベント名からslugのベース名を生成 */
function generateSlugBaseFromName(name: string, date?: string): string {
  let slug = name
    .trim()
    .replace(/[\s\\/:"*?<>|]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_|_$/g, "");
  if (!slug) slug = "event";
  if (date) slug += `_${date.replace(/-/g, "")}`;
  return slug;
}

/** イベント名からslugを生成 */
function generateSlugFromName(name: string, date?: string): string {
  const suffix = Date.now().toString(36);
  const maxBaseLength = Math.max(1, 119 - suffix.length);
  let base = generateSlugBaseFromName(name, date);
  if (base.length > maxBaseLength) base = base.substring(0, maxBaseLength);
  let slug = `${base}_${suffix}`;
  if (slug.length > 120) slug = slug.substring(0, 120);
  return slug;
}

function shouldRenameEventSlug(slug: string, name: string, date?: string): boolean {
  if (isPlaceholderEventName(name)) return false;
  if (slug.startsWith("new_event_")) return true;
  const expectedBase = generateSlugBaseFromName(name, date);
  return !slug.startsWith(`${expectedBase}_`) && slug !== expectedBase;
}

/** イベントフォルダをリネーム */
function renameEventDir(
  slug: string,
  newName: string,
  newDate?: string,
): Promise<string | null> {
  if (renameInProgress) return Promise.resolve(null);
  const ev = eventList.find((event) => event.slug === slug);
  if (!ev) return Promise.resolve(null);
  const newSlug = generateSlugFromName(newName, newDate);
  if (newSlug === slug) return Promise.resolve(null);

  const generation = ++selectEventGeneration;
  const crawlSnapshot = captureCrawlMetaSnapshot();
  cancelAutoSave();
  cancelEventMemoSave();
  cancelCrawlMetaSave();
  renameInProgress = true;
  const request = eventDocumentSerial.then(() =>
    renameEventDirLocked(ev, slug, newSlug, generation, crawlSnapshot),
  );
  eventDocumentSerial = request.then(() => undefined, () => undefined);
  return request;
}

async function renameEventDirLocked(
  ev: EventEntry,
  oldSlug: string,
  newSlug: string,
  generation: number,
  crawlSnapshot: CrawlMetaSnapshot | null,
): Promise<string | null> {
  const isCurrent = () => generation === selectEventGeneration;
  const oldLifecycleKey = eventMetaOwnerKey(oldSlug, ev.dir);
  let oldLifecycleClosed = false;
  let renamed = false;
  const oldDir = ev.dir;
  try {
    await flushCrawlMetaSnapshot(crawlSnapshot, INTERNAL_OPERATION_SAVE);
    if (!isCurrent() || activeEventSlug !== oldSlug) return null;

    const saveResult = await saveNow(INTERNAL_OPERATION_SAVE);
    if (!saveResult.ok) {
      resultEl.textContent = `イベント名変更前の保存に失敗しました: ${String(saveResult.error)}`;
      return null;
    }
    await eventSaveQueue.flushKey(oldLifecycleKey);
    if (!isCurrent() || activeEventSlug !== oldSlug) return null;

    await eventLifecycleGate.closeAndDrain(oldLifecycleKey);
    oldLifecycleClosed = true;
    if (!isCurrent() || activeEventSlug !== oldSlug) return null;

    const res = await invoke<{
      status: string;
      new_dir: string;
      new_slug: string;
    }>("rename_event_dir", {
      projectRoot: projectRootEl.value,
      oldSlug,
      newSlug,
    });

    eventLifecycleGate.open(eventMetaOwnerKey(res.new_slug, res.new_dir));
    renamed = true;
    renameCrawlMetaOwner(oldSlug, oldDir, res.new_slug, res.new_dir);
    ev.slug = res.new_slug;
    ev.dir = res.new_dir;
    purchaseHistoryIndexService.rename(oldSlug, res.new_slug);
    if (committedEventSession?.slug === oldSlug) {
      committedEventSession = {
        ...committedEventSession,
        slug: res.new_slug,
        eventDir: res.new_dir,
        eventJsonPath: eventJsonPathForDir(res.new_dir),
      };
    }
    if (!isCurrent() || activeEventSlug !== oldSlug) return res.new_slug;

    const eventJsonPath = eventJsonPathForDir(res.new_dir);
    activeEventSlug = res.new_slug;
    (document.getElementById("pipelineOutputDir") as HTMLInputElement).value =
      res.new_dir;
    (document.getElementById("eventJsonHidden") as HTMLInputElement).value =
      eventJsonPath;
    (document.getElementById("editorJsonPath") as HTMLInputElement).value =
      eventJsonPath;
    (document.getElementById("editorOutputJsonPath") as HTMLInputElement).value =
      eventJsonPath;
    return res.new_slug;
  } catch (error) {
    console.error("ディレクトリ名変更エラー:", error);
    return null;
  } finally {
    if (oldLifecycleClosed && !renamed) {
      eventLifecycleGate.open(oldLifecycleKey);
    }
    renameInProgress = false;
  }
}

/** クロール不一致確認ダイアログ */
type CrawlMismatchChoice = "overwrite" | "new_event" | "cancel";
function showCrawlMismatchDialog(
  currentUrl: string,
  savedUrl: string,
  eventName: string,
): Promise<CrawlMismatchChoice> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "img-modal-overlay";
    overlay.style.cursor = "default";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";

    const container = document.createElement("div");
    container.style.cssText =
      "background:var(--bg-secondary);border-radius:0.75rem;padding:1.5rem;max-width:480px;width:90%;box-shadow:0 8px 30px rgba(0,0,0,0.3);";
    container.innerHTML = `
      <h3 style="margin:0 0 0.75rem;font-size:1.1rem;font-weight:600;color:var(--text-primary);">クロール情報の不一致</h3>
      <p style="font-size:0.85rem;color:var(--text-secondary);margin:0 0 0.75rem;">
        現在のイベント「${escapeHtml(eventName)}」に保存されているURLと、入力中のURLが異なります。
      </p>
      <div style="font-size:0.8rem;margin:0.75rem 0;padding:0.5rem;background:var(--bg-input);border-radius:0.375rem;overflow-wrap:break-word;">
        <div><strong>保存済み:</strong> ${escapeHtml(savedUrl || "(なし)")}</div>
        <div><strong>入力中:</strong> ${escapeHtml(currentUrl)}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:0.5rem;margin-top:1rem;">
        <button id="mismatchOverwrite" class="btn-primary px-4 py-2 rounded">上書きする</button>
        <button id="mismatchNewEvent" class="btn-secondary px-4 py-2 rounded">新しいイベントとして作成</button>
        <button id="mismatchCancel" class="btn-secondary px-4 py-2 rounded" style="opacity:0.7;">キャンセル</button>
      </div>
    `;
    overlay.appendChild(container);
    document.body.appendChild(overlay);

    container
      .querySelector("#mismatchOverwrite")!
      .addEventListener("click", () => {
        overlay.remove();
        resolve("overwrite");
      });
    container
      .querySelector("#mismatchNewEvent")!
      .addEventListener("click", () => {
        overlay.remove();
        resolve("new_event");
      });
    container
      .querySelector("#mismatchCancel")!
      .addEventListener("click", () => {
        overlay.remove();
        resolve("cancel");
      });
  });
}

/** イベントカード右クリックメニュー */
function showEventCardContextMenu(
  x: number,
  y: number,
  slug: string,
  card: HTMLDivElement,
) {
  document.querySelectorAll(".ctx-menu").forEach((m) => m.remove());
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const renameItem = document.createElement("div");
  renameItem.className = "ctx-menu-item";
  renameItem.textContent = "名前変更";
  renameItem.addEventListener("click", async () => {
    menu.remove();
    await selectEvent(slug);
    const selectedCard = document.querySelector<HTMLDivElement>(
      `.event-card[data-slug="${CSS.escape(slug)}"]`,
    );
    if (activeEventSlug === slug && selectedCard) {
      startInlineEdit(slug, selectedCard);
    }
  });
  menu.appendChild(renameItem);

  const deleteItem = document.createElement("div");
  deleteItem.className = "ctx-menu-item danger";
  deleteItem.textContent = "削除";
  deleteItem.addEventListener("click", () => {
    menu.remove();
    confirmDeleteEvent(slug);
  });
  menu.appendChild(deleteItem);

  document.body.appendChild(menu);
  requestAnimationFrame(() => {
    document.addEventListener("click", () => menu.remove(), { once: true });
  });
}

// サイドバートグル
const sidebarEl = document.getElementById("sidebar")!;
const sidebarToggle = document.getElementById("sidebarToggle")!;

// localStorageからサイドバー状態を復元
if (localStorage.getItem("eventtrail-sidebar-collapsed") === "true") {
  sidebarEl.classList.add("collapsed");
}

sidebarToggle.addEventListener("click", () => {
  sidebarEl.classList.toggle("collapsed");
  localStorage.setItem(
    "eventtrail-sidebar-collapsed",
    sidebarEl.classList.contains("collapsed") ? "true" : "false",
  );
});

function formatDateTime(dtStr: string): string {
  try {
    // "2026-03-29 04:43:06" 形式もサポート
    const d = new Date(dtStr.replace(" ", "T"));
    if (isNaN(d.getTime())) return dtStr;
    return d.toLocaleString("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return dtStr;
  }
}

function updateActiveEventDisplay(meta: EventMeta, pending = false) {
  const name = meta.name || "（名前未設定）";
  const date = meta.date || "";
  const venue = meta.venue || "";
  const info = [name, date, venue].filter(Boolean).join(" / ");

  let shoppingHtml = "";
  if (meta.shopping_started_at) {
    const start = formatDateTime(meta.shopping_started_at);
    const end = meta.shopping_ended_at
      ? formatDateTime(meta.shopping_ended_at)
      : "進行中";
    shoppingHtml = `<div class="shopping-time">買い物: ${escapeHtml(start)} ～ ${escapeHtml(end)}</div>`;
  }

  const crawlEl = document.getElementById("crawlActiveEvent");
  const pendingLabel = pending ? ' <span class="event-selection-pending">読み込み中…</span>' : "";
  if (crawlEl)
    crawlEl.innerHTML = `<strong>対象イベント:</strong> ${escapeHtml(info)}${pendingLabel}${shoppingHtml}`;

  const mobileEl = document.getElementById("mobileActiveEvent");
  if (mobileEl)
    mobileEl.innerHTML = `<strong>対象イベント:</strong> ${escapeHtml(info)}${pendingLabel}${shoppingHtml}`;
}

/** イベント選択ではカードDOMを再生成せずclass差分だけを更新する。 */
function updateSidebarSelectionClasses(): void {
  const listEl = document.getElementById("eventList");
  if (!listEl) return;
  listEl.querySelectorAll<HTMLElement>(".event-card").forEach((card) => {
    const slug = card.dataset.slug || "";
    card.classList.toggle("active", slug === activeEventSlug);
    card.classList.toggle(
      "pending",
      Boolean(requestedEventSlug && slug === requestedEventSlug && slug !== activeEventSlug),
    );
    card.setAttribute("aria-busy", slug === requestedEventSlug && slug !== activeEventSlug ? "true" : "false");
  });
}

function requestEventSelection(slug: string): void {
  requestedEventSlug = slug;
  // 起動時の全イベントwarm scanよりイベント切替IPCを優先する。進行中の
  // warm invoke結果はgenerationで破棄し、idle時に残りを再開する。
  cancelPurchaseHistoryWarmForSelection();
  markEventSwitch("event-switch:click");
  updateSidebarSelectionClasses();
  const requested = eventList.find((event) => event.slug === slug);
  const pending = slug !== activeEventSlug;
  circleEditorEl?.classList.toggle("event-selection-pending", pending);
  if (pending) {
    resultEl.textContent = "イベント読み込み中…";
  }
  if (requested) updateActiveEventDisplay(requested.meta, pending);
  markEventSwitch("event-switch:pending-visible");
}

function sortEventList() {
  const sortEl = document.getElementById(
    "eventSortSelect",
  ) as HTMLSelectElement | null;
  const sort = sortEl?.value || "created_desc";
  eventList.sort((a, b) => {
    switch (sort) {
      case "created_desc":
        return (b.meta.created_at || "").localeCompare(a.meta.created_at || "");
      case "date_desc":
        return (b.meta.date || "").localeCompare(a.meta.date || "");
      case "date_asc":
        return (a.meta.date || "").localeCompare(b.meta.date || "");
      case "name_asc":
        return (a.meta.name || "").localeCompare(b.meta.name || "");
      default:
        return 0;
    }
  });
}

// ソート変更時に再描画
document.getElementById("eventSortSelect")?.addEventListener("change", () => {
  sortEventList();
  renderSidebar();
  localStorage.setItem(
    "eventtrail-event-sort",
    (document.getElementById("eventSortSelect") as HTMLSelectElement).value,
  );
});

// ソート設定の復元
{
  const saved = localStorage.getItem("eventtrail-event-sort");
  const sortEl = document.getElementById(
    "eventSortSelect",
  ) as HTMLSelectElement | null;
  if (saved && sortEl) sortEl.value = saved;
}

let loadEventListGeneration = 0;

async function loadEventList(): Promise<boolean> {
  const generation = ++loadEventListGeneration;
  let nextEvents: EventEntry[];
  try {
    const res = await invoke<{ status: string; events: EventEntry[] }>(
      "list_event_dirs",
      {
        projectRoot: projectRootEl.value,
      },
    );
    nextEvents = res.events || [];
  } catch {
    nextEvents = [];
  }
  if (generation !== loadEventListGeneration) return false;
  eventList = nextEvents;
  desktopPerf.events = eventList.length;
  sortEventList();
  renderSidebar();
  // 購入履歴の初回構築はUI表示をブロックしない。通常のイベント切替は
  // このbackground処理を待たず、対象eventのbundleだけで更新する。
  void warmPurchaseHistoryIndex(nextEvents);
  return true;
}

/**
 * 購入履歴cacheの起動時warmはイベント切替のIPCと競合させない。
 * 切替要求が来たらgenerationを無効化して、残りはidle callbackへ延期する。
 * cursorを保持するため、中断しても既に読んだイベントを再scanしない。
 */
let purchaseHistoryWarmGeneration = 0;
let purchaseHistoryWarmEvents: EventEntry[] = [];
let purchaseHistoryWarmCursor = 0;
let purchaseHistoryWarmRunning = false;
let purchaseHistoryWarmResumeScheduled = false;
let purchaseHistoryWarmResumeTimer: number | null = null;

function schedulePurchaseHistoryWarmResume(delayMs = 450): void {
  if (
    purchaseHistoryWarmResumeScheduled ||
    purchaseHistoryWarmCursor >= purchaseHistoryWarmEvents.length
  ) {
    return;
  }
  purchaseHistoryWarmResumeScheduled = true;
  const resume = () => {
    purchaseHistoryWarmResumeScheduled = false;
    purchaseHistoryWarmResumeTimer = null;
    // selection pending中は、idle callbackが早く発火しても再開しない。
    if (requestedEventSlug && requestedEventSlug !== activeEventSlug) {
      schedulePurchaseHistoryWarmResume(250);
      return;
    }
    void runPurchaseHistoryWarm();
  };
  const idle = (
    window as typeof window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
    }
  ).requestIdleCallback;
  if (typeof idle === "function") {
    // timeoutを付けても選択中のguardは維持する。通常はmain-thread idle時に再開。
    purchaseHistoryWarmResumeTimer = idle(resume, { timeout: Math.max(1000, delayMs * 3) });
  } else {
    purchaseHistoryWarmResumeTimer = window.setTimeout(resume, delayMs);
  }
}

function cancelPurchaseHistoryWarmForSelection(): void {
  purchaseHistoryWarmGeneration += 1;
  if (purchaseHistoryWarmResumeTimer !== null) {
    const cancelIdle = (
      window as typeof window & { cancelIdleCallback?: (id: number) => void }
    ).cancelIdleCallback;
    if (typeof cancelIdle === "function") cancelIdle(purchaseHistoryWarmResumeTimer);
    window.clearTimeout(purchaseHistoryWarmResumeTimer);
    purchaseHistoryWarmResumeTimer = null;
    purchaseHistoryWarmResumeScheduled = false;
  }
  if (
    !purchaseHistoryWarmRunning &&
    purchaseHistoryWarmCursor < purchaseHistoryWarmEvents.length
  ) {
    schedulePurchaseHistoryWarmResume();
  }
}

async function runPurchaseHistoryWarm(): Promise<void> {
  if (purchaseHistoryWarmRunning) return;
  const generation = purchaseHistoryWarmGeneration;
  purchaseHistoryWarmRunning = true;
  try {
    while (purchaseHistoryWarmCursor < purchaseHistoryWarmEvents.length) {
      if (generation !== purchaseHistoryWarmGeneration) return;
      const cursor = purchaseHistoryWarmCursor;
      const ev = purchaseHistoryWarmEvents[cursor];
      // 選択中/選択済みイベントはselectEventLocked側で構築済みなのでscanしない。
      if (ev.slug === requestedEventSlug || ev.slug === activeEventSlug) {
        purchaseHistoryWarmCursor += 1;
        continue;
      }
      try {
        const bundle = await invoke<{
          data?: EventJsonData;
          modified_ms?: number;
          file_size?: number;
        }>("load_event_bundle", {
          eventJson: eventJsonPathForDir(ev.dir),
          eventDir: ev.dir,
          includeMaps: false,
        });
        if (generation !== purchaseHistoryWarmGeneration) return;
        if (!bundle?.data) {
          purchaseHistoryWarmCursor = cursor + 1;
          continue;
        }
        const fingerprint = {
          modifiedMs: bundle.modified_ms,
          fileSize: bundle.file_size,
        };
        const previous = purchaseHistoryIndexService.fingerprint(ev.slug);
        if (
          !previous ||
          previous.modifiedMs !== fingerprint.modifiedMs ||
          previous.fileSize !== fingerprint.fileSize
        ) {
          purchaseHistoryIndexService.replace(ev.slug, bundle.data, fingerprint);
        }
      } catch {
        // 起動時の派生cache構築失敗はUIを止めない。次回起動に再構築する。
      }
      // await中に選択が要求された場合はcursorを進めず、idle再開時に
      // このイベントをもう一度構築する（読み捨てによるcache欠落を防ぐ）。
      if (generation !== purchaseHistoryWarmGeneration) return;
      purchaseHistoryWarmCursor = cursor + 1;
      // 長いイベント一覧でメインスレッドを占有しない。
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  } finally {
    purchaseHistoryWarmRunning = false;
    if (
      purchaseHistoryWarmCursor < purchaseHistoryWarmEvents.length
    ) {
      schedulePurchaseHistoryWarmResume();
    }
  }
}

function warmPurchaseHistoryIndex(events: EventEntry[]): void {
  purchaseHistoryWarmEvents = events.slice();
  purchaseHistoryWarmCursor = 0;
  purchaseHistoryWarmGeneration += 1;
  if (purchaseHistoryWarmResumeTimer !== null) {
    window.clearTimeout(purchaseHistoryWarmResumeTimer);
    purchaseHistoryWarmResumeTimer = null;
    purchaseHistoryWarmResumeScheduled = false;
  }
  // 初期event auto-select/first paintを先に通す。idle callbackが得られる
  // までwarmを開始しないことで、起動直後のload bundle競合も避ける。
  schedulePurchaseHistoryWarmResume(300);
}

let activePurchaseFingerprintRefreshRunning = false;
let activePurchaseFingerprintTimer: number | null = null;

function sameEventSourceFingerprint(
  left: EventSourceFingerprint | undefined,
  right: EventSourceFingerprint | undefined,
): boolean {
  return (
    left?.modifiedMs === right?.modifiedMs &&
    left?.fileSize === right?.fileSize
  );
}

/**
 * 外部編集（別アプリ/同期）をactive eventだけ軽量に検知する。
 * まずRustのmetadata-only fingerprintを取り、変更時だけJSONを読む
 * load_event_bundle(includeMaps:false)へ進む。通常切替の全event scanへ戻らず、
 * 購入履歴cacheのfingerprintが変わった時だけ再構築する。
 */
async function refreshActivePurchaseHistoryFingerprint(
  reason: "focus" | "idle" = "idle",
): Promise<void> {
  if (
    activePurchaseFingerprintRefreshRunning ||
    !activeEventSlug ||
    !eventList.length ||
    (document.hidden && reason !== "focus") ||
    (requestedEventSlug && requestedEventSlug !== activeEventSlug)
  ) {
    return;
  }
  const slug = activeEventSlug;
  const ev = eventList.find((event) => event.slug === slug);
  if (!ev) return;
  const owner = captureActiveEventDocumentOwner();
  const epoch = selectionEpoch;
  activePurchaseFingerprintRefreshRunning = true;
  try {
    const fingerprintResponse = await invoke<{
      modified_ms?: number;
      file_size?: number;
    }>("event_file_fingerprint", {
      eventJson: eventJsonPathForDir(ev.dir),
    });
    if (
      epoch !== selectionEpoch ||
      !isActiveEventDocumentOwner(owner) ||
      activeEventSlug !== slug
    ) {
      return;
    }
    const fingerprint: EventSourceFingerprint = {
      modifiedMs: fingerprintResponse?.modified_ms,
      fileSize: fingerprintResponse?.file_size,
    };
    const cached = purchaseHistoryIndexService.fingerprint(slug);
    const sessionFingerprint =
      committedEventSession?.slug === slug
        ? committedEventSession.sourceFingerprint
        : undefined;
    const previous = cached ?? sessionFingerprint;
    if (previous && sameEventSourceFingerprint(previous, fingerprint)) return;

    // metadataが変わった場合だけdocumentを取得する。通常のfocus/idleでは
    // JSON bytes/parseを発生させず、既存active documentも上書きしない。
    const bundle = await invoke<{
      data?: EventJsonData;
    }>("load_event_bundle", {
      eventJson: eventJsonPathForDir(ev.dir),
      eventDir: ev.dir,
      includeMaps: false,
    });
    if (
      !bundle?.data ||
      epoch !== selectionEpoch ||
      !isActiveEventDocumentOwner(owner) ||
      activeEventSlug !== slug
    ) {
      return;
    }

    // 外部変更時は派生購入indexだけを更新し、編集中のglobal eventJson/tableを
    // 覆い隠さない。次回明示reload/切替でfull documentを取り込める。
    const next = new Set(
      purchaseHistoryIndexService.replace(slug, bundle.data, fingerprint),
    );
    applyPurchasedItemIndex(next);
    if (committedEventSession?.slug === slug) {
      committedEventSession = {
        ...committedEventSession,
        purchasedItemIndex: new Set(next),
        sourceFingerprint: fingerprint,
      };
    }
    if (isDesktopDevBuild) {
      resultEl.textContent = `イベント「${ev.meta.name || slug}」の外部変更を検知（購入履歴を更新）`;
    }
  } catch {
    // focus/idleの派生cache更新失敗はUIを停止させない。
  } finally {
    activePurchaseFingerprintRefreshRunning = false;
  }
}

function scheduleActivePurchaseFingerprintRefresh(): void {
  if (activePurchaseFingerprintTimer !== null) return;
  // 起動/切替直後のIPCと競合させず、メインスレッドがidleになってから確認する。
  activePurchaseFingerprintTimer = window.setTimeout(() => {
    activePurchaseFingerprintTimer = null;
    void refreshActivePurchaseHistoryFingerprint("idle").finally(() => {
      scheduleActivePurchaseFingerprintRefresh();
    });
  }, 30_000);
}

window.addEventListener("focus", () => {
  void refreshActivePurchaseHistoryFingerprint("focus");
  scheduleActivePurchaseFingerprintRefresh();
});
scheduleActivePurchaseFingerprintRefresh();

function captureEventImageMutationGuard(ev: EventEntry): AsyncMutationGuard {
  const owner = `${ev.slug}\n${normalizeEventPath(ev.dir)}`;
  const revision =
    (ev.slug === activeEventSlug ? eventDocumentStateRevision : 0) +
    selectEventGeneration;
  return createAsyncMutationGuard(
    { owner, revision, document: ev, targets: [ev.meta] },
    () => {
      const current = eventList.find((entry) => entry.slug === ev.slug);
      return {
        owner: current
          ? `${current.slug}\n${normalizeEventPath(current.dir)}`
          : "",
        revision:
          (current?.slug === activeEventSlug ? eventDocumentStateRevision : 0) +
          selectEventGeneration,
        document: current ?? null,
        targets: current ? [current.meta] : [],
      };
    },
  );
}

/** イベント画像をファイル選択で設定 */
async function pickEventImage(ev: EventEntry) {
  const guard = captureEventImageMutationGuard(ev);
  const eventDir = ev.dir;
  const selected = await dialogOpen({
    multiple: false,
    filters: [{ name: "画像ファイル", extensions: IMAGE_EXTENSIONS }],
  });
  if (!guard.isCurrent()) return;
  if (selected && typeof selected === "string") {
    const fileName = selected.replace(/\\/g, "/").split("/").pop() || selected;
    try {
      await eventImageMutationSerial.run(`${ev.slug}\nevent_image`, async () => {
        if (!guard.isCurrent()) return;
        await invokeEventAssetWrite(ev, "copy_file_to_dir", {
          sourcePath: selected,
          destDir: eventAssetDir(eventDir, "event_image"),
        });
        if (!guard.isCurrent()) return;
        const nextMeta = {
          ...cloneJsonSnapshot(ev.meta),
          event_image: eventRelativeAssetPath("event_image", fileName),
        };
        const committed = await writeEventMetaSnapshot(ev, nextMeta, {
          isCurrent: guard.isCurrent,
        });
        if (committed) renderSidebar();
      });
    } catch (err) {
      console.error("イベント画像設定エラー:", err);
    }
  }
}

/** イベント画像の右クリックメニュー（サークルカットと同パターン） */
function showEventImageContextMenu(x: number, y: number, ev: EventEntry) {
  document.querySelectorAll(".ctx-menu").forEach((m) => m.remove());
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const hasImage = !!ev.meta.event_image;

  if (hasImage) {
    const viewItem = document.createElement("div");
    viewItem.className = "ctx-menu-item";
    viewItem.textContent = "拡大表示";
    viewItem.addEventListener("click", () => {
      menu.remove();
      const imgPath = `${ev.dir}/${ev.meta.event_image}`;
      showImageModal(convertFileSrc(imgPath));
    });
    menu.appendChild(viewItem);
  }

  const replaceItem = document.createElement("div");
  replaceItem.className = "ctx-menu-item";
  replaceItem.textContent = hasImage ? "画像を差し替え" : "画像を設定";
  replaceItem.addEventListener("click", () => {
    menu.remove();
    pickEventImage(ev);
  });
  menu.appendChild(replaceItem);

  if (hasImage) {
    const deleteItem = document.createElement("div");
    deleteItem.className = "ctx-menu-item danger";
    deleteItem.textContent = "画像を削除";
    deleteItem.addEventListener("click", async () => {
      menu.remove();
      const guard = captureEventImageMutationGuard(ev);
      const eventDir = ev.dir;
      try {
        await eventImageMutationSerial.run(`${ev.slug}\nevent_image`, async () => {
          if (!guard.isCurrent()) return;
          const nextMeta = cloneJsonSnapshot(ev.meta);
          // nullは明示削除としてnative meta mergeへ渡す（undefinedは
          // JSON serializationで欠落し、既存event_imageを保持してしまう）。
          nextMeta.event_image = null;
          const committed = await writeEventMetaSnapshot(ev, nextMeta, {
            isCurrent: guard.isCurrent,
          });
          if (committed) renderSidebar();
        });
      } catch {}
    });
    menu.appendChild(deleteItem);
  }

  document.body.appendChild(menu);
  requestAnimationFrame(() => {
    document.addEventListener("click", () => menu.remove(), { once: true });
  });
}

function renderSidebar() {
  const listEl = document.getElementById("eventList")!;
  desktopPerf.sidebarRebuilds += 1;

  if (eventList.length === 0) {
    listEl.innerHTML = '<div class="no-events">イベントがありません</div>';
    return;
  }

  listEl.innerHTML = eventList
    .map((ev) => {
      const isActive = ev.slug === activeEventSlug;
      const meta = ev.meta;
      const name = meta.name || ev.slug;
      const date = meta.date || "";
      const venue = meta.venue || "";
      const pr = meta.purchase_results;
      const source = meta.source === "mobile_import" ? "モバイルから" : "";
      const isCompleted = !!meta.completed;

      let statsBar = "";
      if (pr && pr.total > 0) {
        const boughtPct = (pr.bought / pr.total) * 100;
        const couldntPct = (pr.couldnt_buy / pr.total) * 100;
        const remainPct = (pr.remaining / pr.total) * 100;
        statsBar = `
        <div class="event-stats">
          <div class="stat-bought" style="width:${boughtPct}%"></div>
          <div class="stat-couldnt" style="width:${couldntPct}%"></div>
          <div class="stat-remaining" style="width:${remainPct}%"></div>
        </div>`;
      }

      // イベント画像サムネイル
      let thumbHtml = "";
      if (meta.event_image) {
        const imgPath = `${ev.dir}/${meta.event_image}`;
        const imgSrc = convertFileSrc(imgPath);
        thumbHtml = `<img class="event-image-thumb" src="${imgSrc}" alt="" data-event-img-slug="${escapeHtml(ev.slug)}" />`;
      } else {
        const initial = (name || "?").charAt(0);
        thumbHtml = `<div class="event-image-placeholder" data-event-img-slug="${escapeHtml(ev.slug)}">${escapeHtml(initial)}</div>`;
      }
      const cardTitle = `${name}\nダブルクリック or F2: 名前変更 / Delete: 削除`;
      const cardTitleHtml = escapeHtml(cardTitle).replace(/\n/g, "&#10;");

      return `
      <div class="event-card ${isActive ? "active" : ""} ${requestedEventSlug === ev.slug && !isActive ? "pending" : ""} ${isCompleted ? "completed" : ""}" data-slug="${escapeHtml(ev.slug)}" tabindex="0" title="${cardTitleHtml}">
        <div class="event-card-header">
          ${thumbHtml}
          <div class="event-card-info">
            <div class="event-name">${escapeHtml(name)}</div>
            <div class="event-date">${date ? escapeHtml(date) : '<span class="opacity-40">日付未設定</span>'}</div>
            ${venue ? `<div class="event-venue">${escapeHtml(venue)}</div>` : ""}
          </div>
          <button class="event-complete-btn ${isCompleted ? "checked" : ""}" data-complete-slug="${escapeHtml(ev.slug)}" title="${isCompleted ? "完了を解除" : "完了にする"}">✓</button>
        </div>
        ${statsBar}
        ${source ? `<div class="event-source">${escapeHtml(source)}</div>` : ""}
      </div>`;
    })
    .join("");

  // クリック・ダブルクリック・キーボード操作
  listEl.querySelectorAll<HTMLDivElement>(".event-card").forEach((card) => {
    // シングルクリックは即時にrequested stateへ反映する。
    card.addEventListener("click", () => {
      const slug = card.dataset.slug;
      if (!slug) return;
      if (slug !== activeEventSlug) void selectEvent(slug);
      else {
        requestEventSelection(slug);
        card.focus();
      }
    });

    // ダブルクリックで名前編集
    card.addEventListener("dblclick", async (e) => {
      e.preventDefault();
      const slug = card.dataset.slug;
      if (slug && slug === activeEventSlug) {
        const selectedCard = document.querySelector<HTMLDivElement>(
          `.event-card[data-slug="${CSS.escape(slug)}"]`,
        );
        if (activeEventSlug === slug && selectedCard) {
          startInlineEdit(slug, selectedCard);
        }
      }
    });

    // キーボードイベント: F2=編集, Delete=削除
    card.addEventListener("keydown", (e) => {
      const slug = card.dataset.slug;
      if (!slug) return;
      if (e.key === "F2") {
        e.preventDefault();
        void selectEvent(slug).then(() => {
          const selectedCard = document.querySelector<HTMLDivElement>(
            `.event-card[data-slug="${CSS.escape(slug)}"]`,
          );
          if (activeEventSlug === slug && selectedCard) {
            startInlineEdit(slug, selectedCard);
          }
        });
      } else if (e.key === "Delete") {
        e.preventDefault();
        confirmDeleteEvent(slug);
      }
    });

    // 右クリック: コンテキストメニュー
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const slug = card.dataset.slug;
      if (!slug) return;
      showEventCardContextMenu(e.clientX, e.clientY, slug, card);
    });
  });

  // 完了トグルボタン
  listEl
    .querySelectorAll<HTMLButtonElement>(".event-complete-btn")
    .forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const slug = btn.dataset.completeSlug;
        if (!slug) return;
        await toggleEventCompleted(slug);
      });
    });

  // イベント画像の操作（サークルカットと同じ挙動）
  // クリック: 画像あり→拡大表示、画像なし→ファイル選択
  // 右クリック: コンテキストメニュー（拡大表示/差し替え/削除）
  // D&D: ファイル or Web画像URLドロップ
  listEl
    .querySelectorAll<HTMLElement>("[data-event-img-slug]")
    .forEach((el) => {
      el.addEventListener("click", async (e) => {
        e.stopPropagation();
        const slug = el.dataset.eventImgSlug;
        if (!slug) return;
        const ev = eventList.find((x) => x.slug === slug);
        if (!ev) return;

        if (ev.meta.event_image) {
          // 画像あり → 拡大表示
          const imgPath = `${ev.dir}/${ev.meta.event_image}`;
          showImageModal(convertFileSrc(imgPath));
        } else {
          // 画像なし → ファイル選択
          await pickEventImage(ev);
        }
      });

      // 右クリック: コンテキストメニュー
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const slug = el.dataset.eventImgSlug;
        if (!slug) return;
        const ev = eventList.find((x) => x.slug === slug);
        if (!ev) return;
        showEventImageContextMenu(e.clientX, e.clientY, ev);
      });

      // ドラッグ&ドロップで画像設定
      el.addEventListener("dragover", (e) => {
        if (!dataTransferHasImage(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        el.classList.add("drag-over");
      });
      el.addEventListener("dragleave", (e) => {
        e.stopPropagation();
        el.classList.remove("drag-over");
      });
      el.addEventListener("drop", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.remove("drag-over");
        const slug = el.dataset.eventImgSlug;
        if (!slug) return;
        const ev = eventList.find((x) => x.slug === slug);
        if (!ev) return;
        const guard = captureEventImageMutationGuard(ev);
        const eventDir = ev.dir;

        const dt = e.dataTransfer;
        if (!dt) return;
        if (!dataTransferHasImage(dt)) return;

        // ローカルファイル
        if (dt.files && dt.files.length > 0) {
          const file = dt.files[0];
          const ext = file.name.split(".").pop()?.toLowerCase() || "";
          if (!IMAGE_EXTENSIONS.includes(ext)) return;
          const buf = await file.arrayBuffer();
          if (!guard.isCurrent()) return;
          const bytes = Array.from(new Uint8Array(buf));
          const destName = `event_image.${ext}`;
          try {
            await eventImageMutationSerial.run(`${ev.slug}\nevent_image`, async () => {
              if (!guard.isCurrent()) return;
              await invokeEventAssetWrite(ev, "save_image_bytes", {
                destDir: eventAssetDir(eventDir, "event_image"),
                fileName: destName,
                bytes,
              });
              if (!guard.isCurrent()) return;
              const nextMeta = {
                ...cloneJsonSnapshot(ev.meta),
                event_image: eventRelativeAssetPath("event_image", destName),
              };
              const committed = await writeEventMetaSnapshot(ev, nextMeta, {
                isCurrent: guard.isCurrent,
              });
              if (committed) renderSidebar();
            });
          } catch (err) {
            console.error("イベント画像D&Dエラー:", err);
          }
          return;
        }

        // Web画像URL
        const imageUrl = imageUrlFromDataTransfer(dt);
        if (!imageUrl) return;
        if (isInternalAppImageUrl(imageUrl)) return;

        const urlExt = imageUrl.split(".").pop()?.split("?")[0] || "jpg";
        const destName = `event_image.${IMAGE_EXTENSIONS.includes(urlExt) ? urlExt : "jpg"}`;
        try {
          await eventImageMutationSerial.run(`${ev.slug}\nevent_image`, async () => {
            if (!guard.isCurrent()) return;
            await invokeEventAssetWrite(ev, "download_image", {
              url: imageUrl,
              destDir: eventAssetDir(eventDir, "event_image"),
              fileName: destName,
            });
            if (!guard.isCurrent()) return;
            const nextMeta = {
              ...cloneJsonSnapshot(ev.meta),
              event_image: eventRelativeAssetPath("event_image", destName),
            };
            const committed = await writeEventMetaSnapshot(ev, nextMeta, {
              isCurrent: guard.isCurrent,
            });
            if (committed) renderSidebar();
          });
        } catch (err) {
          console.error("イベント画像URLドロップエラー:", err);
        }
      });
    });

  // 選択中イベントのカードにフォーカスを当てる
  if (activeEventSlug) {
    const activeCard = listEl.querySelector<HTMLDivElement>(
      `.event-card[data-slug="${activeEventSlug}"]`,
    );
    if (activeCard) activeCard.focus();
  }
}

/** イベントの完了フラグをトグル */
async function toggleEventCompleted(slug: string) {
  const ev = eventList.find((e) => e.slug === slug);
  if (!ev) return;
  const guard = captureEventImageMutationGuard(ev);

  try {
    const meta = cloneJsonSnapshot(ev.meta);
    meta.completed = !meta.completed;
    const committed = await writeEventMetaSnapshot(ev, meta, {
      isCurrent: guard.isCurrent,
    });
    if (committed) renderSidebar();
  } catch (err) {
    console.error("完了フラグ更新エラー:", err);
  }
}

/** イベント名のインライン編集を開始 */
function startInlineEdit(slug: string, card: HTMLDivElement) {
  const ev = eventList.find((e) => e.slug === slug);
  if (!ev) return;

  const nameEl = card.querySelector(".event-name") as HTMLDivElement;
  const dateEl = card.querySelector(".event-date") as HTMLDivElement;
  let venueEl = card.querySelector(".event-venue") as HTMLDivElement | null;
  if (!nameEl) return;

  // 既に編集中なら無視
  if (nameEl.querySelector("input")) return;

  const currentName = ev.meta.name || ev.slug;
  const currentDate = ev.meta.date || "";
  const currentVenue = ev.meta.venue || "";

  // 名前をinputに置換
  nameEl.innerHTML = `<input type="text" class="inline-edit-input text-sm font-semibold" value="${escapeHtml(currentName)}" placeholder="イベント名" />`;
  const nameInput = nameEl.querySelector("input")!;

  // 日付をinputに置換
  dateEl.innerHTML = `<input type="date" class="inline-edit-input text-xs" value="${escapeHtml(currentDate)}" />`;
  const dateInput = dateEl.querySelector("input")!;

  // 会場をinputに置換（なければ作成）
  if (!venueEl) {
    venueEl = document.createElement("div");
    venueEl.className = "event-venue";
    dateEl.after(venueEl);
  }
  venueEl.innerHTML = `<input type="text" class="inline-edit-input text-[0.7rem]" value="${escapeHtml(currentVenue)}" placeholder="会場" />`;
  const venueInput = venueEl.querySelector("input")!;

  nameInput.focus();
  nameInput.select();

  const allInputs = [nameInput, dateInput, venueInput];

  // クリックイベントの伝播を止める
  allInputs.forEach((inp) =>
    inp.addEventListener("click", (e) => e.stopPropagation()),
  );

  const evRef = ev; // クロージャ内でのnarrowing保持用
  async function save() {
    const newName = nameInput.value.trim() || currentName;
    const newDate = dateInput.value || null;
    const newVenue = venueInput.value.trim() || null;
    const nextMeta = {
      ...cloneJsonSnapshot(evRef.meta),
      name: newName,
      // インライン編集の空欄は既知metaの明示削除。undefinedにするとRust側の
      // unknown-preserving mergeで旧値が残るため、nullをそのまま渡す。
      date: newDate,
      venue: newVenue,
    };
    try {
      const committed = await writeEventMetaSnapshot(evRef, nextMeta);
      if (!committed) return;
    } catch (e) {
      resultEl.textContent = `メタデータ保存エラー: ${String(e)}`;
      return;
    }
    renderSidebar();
    updateActiveEventDisplay(nextMeta);

    // クロールフォームにも同期
    syncInProgress = true;
    (document.getElementById("eventName") as HTMLInputElement).value = newName;
    (document.getElementById("eventDate") as HTMLInputElement).value =
      newDate || "";
    syncInProgress = false;

    // フォルダ名リネーム（仮slugまたは名前/日付とslugがずれた場合）
    let currentSlug = slug;
    if (shouldRenameEventSlug(slug, newName, newDate ?? undefined)) {
      const newSlug = await renameEventDir(slug, newName, newDate ?? undefined);
      if (newSlug) currentSlug = newSlug;
    }

    // 内部状態を再同期
    if (activeEventSlug === currentSlug) {
      await selectEvent(currentSlug);
    }
  }

  function cancel() {
    renderSidebar();
  }

  // Enter=保存, Escape=キャンセル
  function handleKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  }
  allInputs.forEach((inp) => inp.addEventListener("keydown", handleKey));

  // フォーカスが全inputから外れたら保存
  let blurTimer: number | null = null;
  function handleBlur() {
    if (blurTimer) clearTimeout(blurTimer);
    blurTimer = window.setTimeout(() => {
      if (allInputs.some((inp) => document.activeElement === inp)) return;
      save();
    }, 150);
  }
  allInputs.forEach((inp) => inp.addEventListener("blur", handleBlur));
}

/** 削除確認ダイアログ */
function confirmDeleteEvent(slug: string) {
  const ev = eventList.find((e) => e.slug === slug);
  if (!ev) return;
  const name = ev.meta.name || slug;
  if (
    !confirm(`「${name}」を本当に削除しますか？\n\nこの操作は取り消せません。`)
  )
    return;
  // 二重確認
  if (
    !confirm(
      `最終確認: 「${name}」のデータ（画像含む）が完全に削除されます。よろしいですか？`,
    )
  )
    return;
  deleteEvent(slug);
}

let selectEventGeneration = 0;
let eventDocumentSerial: Promise<unknown> = Promise.resolve();

function runEventDocumentSerial<T>(task: () => Promise<T>): Promise<T> {
  const request = eventDocumentSerial.then(task);
  eventDocumentSerial = request.then(() => undefined, () => undefined);
  return request;
}

function runManagedEventDocumentMutation<T>(task: () => Promise<T>): Promise<T> {
  if (!canStartEventDocumentMutation(operationState) || renameInProgress) {
    return Promise.reject(
      new Error("別のイベント処理中のためイベント管理操作を開始できません"),
    );
  }
  applyOperationEvent({ type: "start-event-document" });
  setEventPipelineButtonsDisabled(true);
  selectEventGeneration += 1;
  markEventDocumentMutated();
  const metadataBarriers = eventList
    .filter((event) =>
      eventLifecycleGate.isOpen(eventMetaOwnerKey(event.slug, event.dir)),
    )
    .map((event) =>
      eventMetaWriteCoordinator.runExclusive(
        eventMetaOwnerKey(event.slug, event.dir),
        async () => undefined,
      ),
    );
  cancelAutoSave();
  cancelEventMemoSave();
  cancelCrawlMetaSave();
  return runEventDocumentSerial(async () => {
    await Promise.all(metadataBarriers);
    return task();
  }).finally(() => {
    if (operationState.kind === "event-document-running") {
      applyOperationEvent({ type: "finish-event-document" });
    }
    setEventPipelineButtonsDisabled(false);
  });
}

/** 通常切替用。旧イベントのimmutable snapshotだけをkeyed queueへ投入し、
 * 保存完了は待たずに次イベントのloadを開始する。 */
function enqueueCurrentEventSnapshotForSwitch(): SaveReceipt | null {
  if (!eventJsonData || !activeEventSlug) return null;
  const ownerEvent = eventList.find((event) => event.slug === activeEventSlug);
  if (!ownerEvent) return null;
  const ownerSlug = activeEventSlug;
  const ownerDir = normalizeEventPath(ownerEvent.dir);
  const eventJsonPath = eventJsonPathForDir(ownerDir);
  if (normalizeEventPath(editorJsonPathValue()) !== eventJsonPath) return null;
  const key = eventMetaOwnerKey(ownerSlug, ownerDir);
  const lifecycleLease = eventLifecycleGate.acquire(key);
  if (!lifecycleLease) return null;
  try {
    markEventSwitch("event-switch:outgoing-snapshot");
    const tableSnapshot = recordDeepClone(tableState);
    const synced = buildEventJsonSnapshot(eventJsonData, tableSnapshot, eventTableBaseline);
    eventJsonData = synced;
    eventTableBaseline = tableSnapshot;
    markEventDocumentMutated();
    const status = eventSaveQueue.getStatus(key);
    if (
      eventJsonDocumentsEqual(synced, persistedEventJsonData) &&
      !status.running &&
      !status.pending &&
      !status.error
    ) {
      lifecycleLease.release();
      return null;
    }
    const receipt = eventSaveQueue.enqueue(key, {
      ownerSlug,
      ownerDir,
      eventJsonPath,
      data: recordDeepClone(synced),
      lifecycleLease,
    });
    void receipt.completed.catch((error) => showEventSaveRetry(ownerSlug, ownerDir, error));
    return receipt;
  } catch {
    lifecycleLease.release();
    return null;
  }
}

function selectEvent(
  slug: string,
  savePermit?: InternalOperationSavePermit,
): Promise<boolean> {
  requestEventSelection(slug);
  // 物理rename中はgenerationを無効化せず、rename完了後の新slug/dir状態から
  // crawl snapshotを取得して選択処理を開始する。
  if (renameInProgress) {
    const deferredRequest = eventDocumentSerial.then(async () => {
      const crawlSnapshot = captureCrawlMetaSnapshot();
      cancelAutoSave();
      cancelEventMemoSave();
      cancelCrawlMetaSave();
      const generation = ++selectEventGeneration;
      selectionEpoch = generation;
      return selectEventLocked(slug, generation, crawlSnapshot, savePermit);
    });
    eventDocumentSerial = deferredRequest.then(() => undefined, () => undefined);
    return deferredRequest;
  }
  // 呼び出し時点で旧リクエストを無効化する。旧イベント保存のawaitより必ず先。
  const crawlSnapshot = captureCrawlMetaSnapshot();
  cancelAutoSave();
  cancelEventMemoSave();
  cancelCrawlMetaSave();
  const generation = ++selectEventGeneration;
  selectionEpoch = generation;
  if (slug === activeEventSlug && activeEventSlug) {
    // 同一slugのF2/明示再読込だけは、編集中snapshotを保存してからreloadする。
    // 異なるイベントへの通常切替は下記のlatest-wins経路で待たない。
    const current = eventList.find((event) => event.slug === activeEventSlug);
    const key = current ? eventMetaOwnerKey(current.slug, current.dir) : "";
    return (async () => {
      const saveResult = await saveNow(savePermit);
      if (!saveResult.ok) {
        resultEl.textContent = `イベント再読み込み前の保存に失敗しました: ${String(saveResult.error)}`;
        return false;
      }
      if (key) await eventSaveQueue.flushKey(key);
      return selectEventLocked(slug, generation, crawlSnapshot, savePermit);
    })();
  }
  // 通常の選択はeventDocumentSerialから外し、latest-request-winsにする。
  // 旧イベントの未保存差分はイベントkeyへenqueueするだけで、保存完了を待たない。
  enqueueCurrentEventSnapshotForSwitch();
  return selectEventLocked(slug, generation, crawlSnapshot, savePermit);
}

async function selectEventLocked(
  slug: string,
  generation: number,
  crawlSnapshot: CrawlMetaSnapshot | null,
  savePermit?: InternalOperationSavePermit,
): Promise<boolean> {
  const isStale = () =>
    generation !== selectEventGeneration || generation !== selectionEpoch;
  const rejectCurrentSelection = (message?: string): false => {
    // staleな旧要求は最新requested stateを触らない。最新要求だけを
    // fail-closedでactiveへ戻し、pending overlay/aria-busyを解除する。
    if (isStale()) return false;
    requestedEventSlug = activeEventSlug;
    circleEditorEl?.classList.remove("event-selection-pending");
    updateSidebarSelectionClasses();
    const active = eventList.find((event) => event.slug === activeEventSlug);
    if (active) updateActiveEventDisplay(active.meta);
    if (message) resultEl.textContent = message;
    return false;
  };
  // メタデータはowner固定のwriteを開始するが、通常切替のpending表示/loadを
  // 待たせない。rename/delete等のlifecycle mutationだけがflushKeyする。
  void flushCrawlMetaSnapshot(crawlSnapshot).catch((error) => {
    if (!isStale()) {
      resultEl.textContent = `イベント切替前のメタデータ保存に失敗しました: ${String(error)}`;
    }
  });
  if (isStale()) return false;
  if (
    isOperationBusy(operationState) &&
    (slug !== activeEventSlug || isMapAutoOperation(operationState))
  ) {
    resultEl.textContent =
      "イベント処理中はイベントを切り替えられません。完了後に選択してください。";
    requestedEventSlug = activeEventSlug;
    circleEditorEl?.classList.remove("event-selection-pending");
    updateSidebarSelectionClasses();
    return false;
  }
  const ev = eventList.find((event) => event.slug === slug);
  if (!ev) {
    requestedEventSlug = activeEventSlug;
    circleEditorEl?.classList.remove("event-selection-pending");
    updateSidebarSelectionClasses();
    return false;
  }

  // 旧イベントのimmutable snapshotはselectEvent呼び出し直後にkeyed queueへ
  // enqueue済み。通常切替では保存完了/flushを待たずloadを続行する。
  if (isStale()) return false;
  const loadOwnerSlug = activeEventSlug;
  const loadOwnerPath = normalizeEventPath(editorJsonPathValue());
  const loadStateRevision = eventDocumentStateRevision;
  const metaOwnerKey = eventMetaOwnerKey(ev.slug, ev.dir);
  if (deletingEventKeys.has(metaOwnerKey)) {
    return rejectCurrentSelection("イベント削除中のため切替を取り消しました");
  }
  const loadMetaRevision = eventMetaWriteCoordinator.revision(metaOwnerKey);

  const eventJsonPath = eventJsonPathForDir(ev.dir);
  let nextMeta: EventMeta = { ...ev.meta };
  let nextMapImagePaths: EventMapImage[] = [];
  let sourceFingerprint: EventSourceFingerprint = {};
  let nextEventJsonData: EventJsonData | null = null;
  let loadSucceeded = false;
  markEventSwitch("event-switch:load-start");
  try {
    const bundle = await invoke<{
      data?: EventJsonData;
      meta?: EventMeta;
      map_images?: EventMapImage[];
      modified_ms?: number;
      file_size?: number;
    }>("load_event_bundle", {
      eventJson: eventJsonPath,
      eventDir: ev.dir,
      includeMaps: false,
    });
    nextEventJsonData = bundle?.data || null;
    if (bundle?.meta) nextMeta = { ...nextMeta, ...bundle.meta };
    // includeMaps:falseで通常切替のdirectory scanを行わない。mapImagesは
    // session commit後のMapEditor遅延初期化で1回だけ取得する。
    nextMapImagePaths = [];
    sourceFingerprint = {
      modifiedMs: bundle?.modified_ms,
      fileSize: bundle?.file_size,
    };
    if (nextEventJsonData) {
      loadSucceeded = true;
      desktopPerf.eventJsonBytes = Number(bundle?.file_size || JSON.stringify(nextEventJsonData).length);
      desktopPerf.circles = Array.isArray(nextEventJsonData.circles) ? nextEventJsonData.circles.length : 0;
      desktopPerf.items = (nextEventJsonData.circles || []).reduce(
        (total: number, circle: any) => total + (Array.isArray(circle?.items) ? circle.items.length : 0),
        0,
      );
      publishDesktopPerf();
    }
  } catch {
    nextEventJsonData = null;
  }
  markEventSwitch("event-switch:load-end");
  if (isStale()) return false;
  if (!loadSucceeded) {
    resultEl.textContent = `イベント「${ev.meta.name || slug}」の読み込みに失敗しました`;
    requestedEventSlug = activeEventSlug;
    circleEditorEl?.classList.remove("event-selection-pending");
    updateSidebarSelectionClasses();
    const active = eventList.find((event) => event.slug === activeEventSlug);
    if (active) updateActiveEventDisplay(active.meta);
    return false;
  }

  const nextTableState = nextEventJsonData
    ? circlesToTableState(nextEventJsonData)
    : { headers: [], rows: [] };
  // circle_masterは表示上の初期値として重ねるだけ。baselineにも含めることで、
  // ユーザーがジャンル列を明示編集するまでevent.jsonへは永続化しない。
  applyCircleMasterGenres(nextTableState);

  // 購入済みindexもlocalで構築し、古い選択処理からglobalへ途中反映しない。
  const nextPurchasedItemKeys = await buildPurchasedItemIndex(
    slug,
    nextEventJsonData,
    sourceFingerprint,
  );
  if (isStale()) return false;

  // loadedEvent由来のmeta補完もglobal commit前のlocal stateだけに適用する。
  const loadedEvent = nextEventJsonData?.event || {};
  let metaChanged = false;
  if (
    isPlaceholderEventName(nextMeta.name) &&
    typeof loadedEvent.name === "string" && loadedEvent.name &&
    !isPlaceholderEventName(loadedEvent.name)
  ) {
    nextMeta.name = loadedEvent.name;
    metaChanged = true;
  }
  if (!nextMeta.event_url && typeof loadedEvent.url === "string" && loadedEvent.url) {
    nextMeta.event_url = loadedEvent.url;
    metaChanged = true;
  }
  if (!nextMeta.event_urls && Array.isArray(loadedEvent.source_urls)) {
    nextMeta.event_urls = loadedEvent.source_urls.filter(
      (url: unknown): url is string => typeof url === "string" && !!url.trim(),
    );
    metaChanged = true;
  }
  if (!nextMeta.event_urls && Array.isArray(loadedEvent.event_urls)) {
    nextMeta.event_urls = loadedEvent.event_urls.filter(
      (url: unknown): url is string => typeof url === "string" && !!url.trim(),
    );
    metaChanged = true;
  }
  if (!nextMeta.map_config && typeof loadedEvent.map_config === "string") {
    nextMeta.map_config = loadedEvent.map_config;
    metaChanged = true;
  }
  if (!nextMeta.date && typeof loadedEvent.date === "string" && loadedEvent.date) {
    nextMeta.date = normalizeDateInputValue(loadedEvent.date);
    metaChanged = true;
  }
  // load中に別のmetadata操作が成功/要求された場合、取得済みnextMetaで
  // その更新を上書きしない。ユーザーの次の選択でfreshに再試行する。
  if (!eventMetaWriteCoordinator.isRevision(metaOwnerKey, loadMetaRevision)) {
    return rejectCurrentSelection("イベントメタデータが更新されたため、再読込を取り消しました");
  }
  if (metaChanged) {
    try {
      const committed = await writeEventMetaSnapshot(ev, nextMeta, {
        commitToEventList: false,
        isCurrent: () =>
          !isStale() &&
          activeEventSlug === loadOwnerSlug &&
          normalizeEventPath(editorJsonPathValue()) === loadOwnerPath &&
          eventDocumentStateRevision === loadStateRevision,
      });
      if (!committed) return rejectCurrentSelection("イベントメタデータ補完が競合したため、再読込を取り消しました");
    } catch (error) {
      resultEl.textContent = `イベントメタデータ補完の保存に失敗しました: ${String(error)}`;
      return rejectCurrentSelection(resultEl.textContent);
    }
    if (isStale()) return false;
  }

  const loadedAdditionalPrompt =
    nextMeta.additional_prompt ||
    (typeof loadedEvent.additional_prompt === "string"
      ? loadedEvent.additional_prompt
      : "");
  const commitMetaRevision = eventMetaWriteCoordinator.revision(metaOwnerKey);

  // load await中にmemo/table/image/crawl等が編集された場合、取得済みの古い
  // documentをglobalへcommitしない。次の明示選択で最新stateから再試行する。
  if (
    isStale() ||
    deletingEventKeys.has(metaOwnerKey) ||
    !eventList.some(
      (event) =>
        event.slug === ev.slug &&
        normalizeEventPath(event.dir) === normalizeEventPath(ev.dir),
    ) ||
    activeEventSlug !== loadOwnerSlug ||
    normalizeEventPath(editorJsonPathValue()) !== loadOwnerPath ||
    eventDocumentStateRevision !== loadStateRevision ||
    !eventMetaWriteCoordinator.isRevision(metaOwnerKey, commitMetaRevision)
  ) {
    return rejectCurrentSelection("イベント切替中に編集が発生したため、再読込を取り消しました");
  }

  // 全global ownerとフォームを、最後のawait後に同一generationで一括commitする。
  const previousCommittedSlug = activeEventSlug;
  ev.meta = nextMeta;
  activeEventSlug = slug;
  requestedEventSlug = slug;
  if (previousCommittedSlug !== slug) {
    // virtual tableのscroll/実測row heightはevent owner固有。A→BでAの
    // 末尾scrollTopやexpanded heightを持ち越すと、Bで空window/巨大spacerになる。
    tableWindowScrollTop = 0;
    tableRowHeights.clear();
    expandedCircleIdx = -1;
    // renderCircleEditor()はinnerHTML差し替え前に旧table-scrollを参照するため、
    // JS値だけでなく旧DOMのscrollTopも先に戻す。
    const previousTableScrollEl =
      circleEditorEl.querySelector<HTMLElement>(".table-scroll");
    if (previousTableScrollEl) previousTableScrollEl.scrollTop = 0;
  }
  circleEditorEl?.classList.remove("event-selection-pending");
  eventJsonData = nextEventJsonData;
  tableState = nextTableState;
  markEventDocumentMutated();
  persistedEventJsonData = nextEventJsonData
    ? recordDeepClone(nextEventJsonData)
    : null;
  eventTableBaseline = recordDeepClone(nextTableState);
  applyPurchasedItemIndex(nextPurchasedItemKeys);
  mapImagePaths = nextMapImagePaths;
  committedEventSession = {
    slug,
    eventDir: ev.dir,
    eventJsonPath,
    meta: recordDeepClone(nextMeta),
    eventJsonData: recordDeepClone(nextEventJsonData as EventJsonData),
    tableState: recordDeepClone(nextTableState),
    tableBaseline: recordDeepClone(nextTableState),
    purchasedItemIndex: new Set(nextPurchasedItemKeys),
    mapImages: recordDeepClone(nextMapImagePaths),
    sourceFingerprint,
  };
  markEventSwitch("event-switch:history-index-ready");
  markEventSwitch("event-switch:session-commit");
  updateSidebarSelectionClasses();
  void syncDesktopPerfCounters();
  (document.getElementById("pipelineOutputDir") as HTMLInputElement).value = ev.dir;
  (document.getElementById("eventJsonHidden") as HTMLInputElement).value = eventJsonPath;
  (document.getElementById("editorJsonPath") as HTMLInputElement).value = eventJsonPath;
  (document.getElementById("editorOutputJsonPath") as HTMLInputElement).value = eventJsonPath;
  (document.getElementById("eventName") as HTMLInputElement).value =
    nextMeta.name || (typeof loadedEvent.name === "string" ? loadedEvent.name : "");
  (document.getElementById("eventUrl") as HTMLInputElement).value =
    eventUrlListText(nextMeta.event_urls) ||
    eventUrlListText(loadedEvent.event_urls) ||
    eventUrlListText(loadedEvent.source_urls) ||
    nextMeta.event_url ||
    (typeof loadedEvent.url === "string" ? loadedEvent.url : "");
  (document.getElementById("eventDate") as HTMLInputElement).value =
    nextMeta.date || normalizeDateInputValue(loadedEvent.date);
  (document.getElementById("mapUrl") as HTMLInputElement).value =
    nextMeta.map_config ||
    (typeof loadedEvent.map_config === "string" ? loadedEvent.map_config : "") ||
    nextMeta.map_url ||
    (typeof loadedEvent.map_url === "string" ? loadedEvent.map_url : "");
  (document.getElementById("additionalPrompt") as HTMLTextAreaElement).value =
    displayAdditionalPromptText(loadedAdditionalPrompt);

  // 選択切替ではsidebar全カードを再生成せず、active/pending classだけを差分更新。
  updateSidebarSelectionClasses();
  renderCircleEditorAndMap();
  updateEventMemoUI();
  rebuildMapNumberSelect(currentMapNumber());
  loadMapImage();
  updateConcurrentEventSummary();
  updateActiveEventDisplay(nextMeta);
  publishDesktopPerf();

  const qrArea = document.getElementById("qrCodeArea")!;
  if (qrArea.style.display === "block") {
    try {
      await invoke("stop_file_server");
      if (isStale()) return false;
      const zipPath = `${ev.dir}/mobile_export.zip`;
      resultEl.textContent = "イベント切替: ZIPファイル再生成中...";
      const zipRes = await runJob("create_mobile_zip", {
        event_json: eventJsonPath,
        output_dir: ev.dir,
        zip_output_path: zipPath,
      });
      if (isStale()) return false;
      if (zipRes?.ok) {
        resultEl.textContent = "イベント切替: HTTPサーバー再起動中...";
        const serverRes = await startMobileZipServer(zipPath);
        if (isStale()) return false;
        if (serverRes.status === "ok") {
          const url = serverRes.url as string;
          (document.getElementById("qrUrl") as HTMLElement).textContent = url;
          const canvas = document.getElementById("qrCanvas") as HTMLCanvasElement;
          const QRCode = (await import("qrcode")).default;
          if (isStale()) return false;
          await QRCode.toCanvas(canvas, url, { width: 256, margin: 2 });
          if (isStale()) return false;
          resultEl.textContent = `イベント「${ev.meta.name || slug}」に切替完了\nモバイル転送サーバー起動中\nURL: ${url}`;
        } else {
          qrArea.style.display = "none";
          resultEl.textContent = `イベント「${ev.meta.name || slug}」を読み込みました（サーバー再起動失敗）`;
        }
      } else {
        qrArea.style.display = "none";
        resultEl.textContent = `イベント「${ev.meta.name || slug}」を読み込みました（ZIP生成失敗）`;
      }
    } catch (e) {
      if (isStale()) return false;
      qrArea.style.display = "none";
      resultEl.textContent = `イベント「${ev.meta.name || slug}」を読み込みました（サーバー再起動エラー: ${String(e)}）`;
    }
  } else {
    resultEl.textContent = `イベント「${ev.meta.name || slug}」を読み込みました`;
  }
  return true;
}

function invalidateSelectionForEventDeletion(slug: string, lifecycleKey: string): void {
  deletingEventKeys.add(lifecycleKey);
  // requested/activeのどちらかが削除対象なら、切替loadのgenerationを即時に
  // 無効化する。削除完了前にeventListから対象が消えないため、owner keyの
  // guardと併用しないと遅いloadが削除イベントを蘇生し得る。
  if (requestedEventSlug !== slug && activeEventSlug !== slug) return;
  selectEventGeneration += 1;
  selectionEpoch = selectEventGeneration;
  requestedEventSlug = activeEventSlug;
  circleEditorEl?.classList.remove("event-selection-pending");
  updateSidebarSelectionClasses();
}

async function deleteEvent(slug: string) {
  const ev = eventList.find((e) => e.slug === slug);
  if (!ev) return;
  const lifecycleKey = eventMetaOwnerKey(ev.slug, ev.dir);
  invalidateSelectionForEventDeletion(slug, lifecycleKey);
  const pendingCrawlMeta =
    activeEventSlug === slug ? captureCrawlMetaSnapshot() : null;
  const pendingMetaSettle =
    activeEventSlug === slug
      ? flushCrawlMetaSnapshot(pendingCrawlMeta, INTERNAL_OPERATION_SAVE)
      : Promise.resolve();
  const pendingDocumentSettle =
    activeEventSlug === slug
      ? saveNow(INTERNAL_OPERATION_SAVE)
      : Promise.resolve<SaveNowResult>({ ok: true, revision: null });
  // active eventのsaveNowがleaseを取得してenqueueできるよう、closeは
  // pending snapshotのflush後に開始する。先にcloseするとsaveNowが拒否され、
  // 削除前編集が黙って失われるうえ、retry leaseもzombie化する。
  let lifecycleDrain: Promise<void> | null = null;
  let deleted = false;

  try {
    await runManagedEventDocumentMutation(async () => {
      if (activeEventSlug === slug) {
        await pendingMetaSettle;
        const settled = await pendingDocumentSettle;
        if (!settled.ok) {
          throw new Error(`削除前の保存に失敗しました: ${String(settled.error)}`);
        }
        await eventSaveQueue.flushKey(lifecycleKey);
        const saveStatus = eventSaveQueue.getStatus(lifecycleKey);
        if (saveStatus.error) {
          throw new Error(`削除前の保存キューに失敗しました: ${String(saveStatus.error)}`);
        }
      }
      lifecycleDrain = eventLifecycleGate.closeAndDrain(lifecycleKey);
      await lifecycleDrain;
      await invoke("delete_event_dir", { eventDir: ev.dir });
      deleted = true;
      removeCrawlMetaOwner(slug, ev.dir);
      purchaseHistoryIndexService.remove(slug);
      if (activeEventSlug === slug) {
        activeEventSlug = null;
        requestedEventSlug = null;
        committedEventSession = null;
        eventJsonData = null;
        persistedEventJsonData = null;
        tableState = { headers: [], rows: [] };
        eventTableBaseline = { headers: [], rows: [] };
        eventDocumentStateRevision += 1;
        renderCircleEditorAndMap();
        updateEventMemoUI();
      }
      await loadEventList();
      // 一覧更新が完了するまで削除ownerを不可視に保つ。finallyで必ず
      // clearするのではなく、成功後だけclearして再選択のzombieを防ぐ。
      deletingEventKeys.delete(lifecycleKey);
    });
    resultEl.textContent = `イベントを削除しました`;
  } catch (e) {
    if (!deleted) {
      deletingEventKeys.delete(lifecycleKey);
      eventLifecycleGate.open(lifecycleKey);
    }
    resultEl.textContent = `削除エラー: ${String(e)}`;
  }
}

// 新規イベント作成
const newEventBtn = document.getElementById("newEventBtn") as HTMLButtonElement;
newEventBtn.addEventListener("click", async () => {
  const now = new Date();
  const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
  const slug = `new_event_${timestamp}`;

  try {
    await runManagedEventDocumentMutation(async () => {
      const created = await invoke<{ status: string; dir: string }>(
        "create_event_dir",
        {
          projectRoot: projectRootEl.value,
          slug,
        },
      );
      eventLifecycleGate.open(eventMetaOwnerKey(slug, created.dir));
      await writeEventMetaSnapshot(
        { slug, dir: created.dir },
        {
        name: NEW_EVENT_NAME,
        created_at: new Date().toISOString(),
        source: "desktop_created",
        },
        { requireListedOwner: false, commitToEventList: false },
      );
      await loadEventList();
    });
    // selectEventを呼んで内部状態(pipelineOutputDir等)を正しく初期化
    await selectEvent(slug);

    // 作成直後にインライン編集を開始（名前/日付/会場を入力）
    const card = document.querySelector<HTMLDivElement>(
      `.event-card[data-slug="${slug}"]`,
    );
    if (card) startInlineEdit(slug, card);

    resultEl.textContent =
      "新規イベントを作成しました。名前・日付・会場を入力してください。";
  } catch (e) {
    resultEl.textContent = `イベント作成エラー: ${String(e)}`;
  }
});

// クロールフォーム → メタデータ自動保存 + サイドバー同期
["eventUrl", "mapUrl"].forEach((id) => {
  document
    .getElementById(id)
    ?.addEventListener("input", () => {
      if (id === "eventUrl") updateConcurrentEventSummary();
      scheduleCrawlMetaSave();
    });
});
document
  .getElementById("additionalPrompt")
  ?.addEventListener("input", () => scheduleCrawlMetaSave());

document.getElementById("modelProvider")?.addEventListener("change", () => {
  updateTextModelSelect();
  saveFormValues();
});
document.getElementById("textFallbackModelProvider")?.addEventListener("change", () => {
  updateTextFallbackModelSelect();
  saveFormValues();
});
document.getElementById("visionModel")?.addEventListener("change", () => {
  updateVisionModelSelect();
  saveFormValues();
});
document.getElementById("visionFallbackModelProvider")?.addEventListener("change", () => {
  updateVisionFallbackModelSelect();
  saveFormValues();
});
[
  "model",
  "textReasoningEffort",
  "textFallbackModel",
  "textFallbackReasoningEffort",
  "visionModelId",
  "visionReasoningEffort",
  "visionFallbackModel",
  "visionFallbackReasoningEffort",
].forEach((id) => {
  document.getElementById(id)?.addEventListener("change", () => {
    if (id === "model") updateTextModelSelect((document.getElementById("model") as HTMLSelectElement).value);
    if (id === "textFallbackModel") updateTextFallbackModelSelect((document.getElementById("textFallbackModel") as HTMLSelectElement).value);
    if (id === "visionModelId") updateVisionModelSelect((document.getElementById("visionModelId") as HTMLSelectElement).value);
    if (id === "visionFallbackModel") updateVisionFallbackModelSelect((document.getElementById("visionFallbackModel") as HTMLSelectElement).value);
    saveFormValues();
  });
});

// イベント名・日付: クロールフォーム → サイドバー同期（blur時のみ実行し入力中のフォーカスを奪わない）
["eventName", "eventDate"].forEach((id) => {
  document.getElementById(id)?.addEventListener("blur", async () => {
    if (syncInProgress || !activeEventSlug) return;
    const currentSlug = activeEventSlug;
    const ev = eventList.find((e) => e.slug === activeEventSlug);
    if (!ev) return;

    const nameVal = (
      document.getElementById("eventName") as HTMLInputElement
    ).value.trim();
    const dateVal = (document.getElementById("eventDate") as HTMLInputElement)
      .value;

    const nextMeta = {
      ...cloneJsonSnapshot(ev.meta),
      name: nameVal || ev.meta.name,
      date: dateVal || null,
    };

    syncInProgress = true;
    updateActiveEventDisplay(nextMeta);
    syncInProgress = false;

    if (nameVal && shouldRenameEventSlug(currentSlug, nameVal, nextMeta.date ?? undefined)) {
      try {
        const committed = await writeEventMetaSnapshot(ev, nextMeta);
        if (!committed) return;
      } catch (error) {
        resultEl.textContent = `メタデータ保存エラー: ${String(error)}`;
        return;
      }
      renderSidebar();
      const newSlug = await renameEventDir(currentSlug, nameVal, nextMeta.date ?? undefined);
      if (newSlug) {
        await loadEventList();
        await selectEvent(newSlug);
        return;
      }
    }

    scheduleCrawlMetaSave();
  });
});

// 逆QRインポート
const importResultBtn = document.getElementById(
  "importResultBtn",
) as HTMLButtonElement;
const importModalOverlay = document.getElementById("importModalOverlay")!;
const importCancelBtn = document.getElementById(
  "importCancelBtn",
) as HTMLButtonElement;
const importStatusEl = document.getElementById("importStatus")!;

importResultBtn.addEventListener("click", async () => {
  try {
    importStatusEl.textContent = "受信サーバー起動中...";
    importModalOverlay.classList.remove("hidden");
    importModalOverlay.classList.add("active");
    logToFile("モバイル同期: 受信サーバー起動");

    const res = await invoke<{
      status: string;
      url: string;
      ip: string;
      port: number;
    }>("start_receive_server", {
      projectRoot: projectRootEl.value,
    });

    if (res.status === "ok") {
      const url = res.url;
      (document.getElementById("importQrUrl") as HTMLElement).textContent = url;

      // QRコード描画
      const canvas = document.getElementById(
        "importQrCanvas",
      ) as HTMLCanvasElement;
      const QRCode = (await import("qrcode")).default;
      await QRCode.toCanvas(canvas, url, { width: 256, margin: 2 });

      importStatusEl.textContent = "スマホからのデータ受信を待機中...";
      logToFile(`モバイル同期: 待機開始 url=${url}`);
    }
  } catch (e) {
    importStatusEl.textContent = `エラー: ${String(e)}`;
    logToFile(`モバイル同期: 受信サーバー起動エラー ${String(e)}`);
  }
});

importCancelBtn.addEventListener("click", async () => {
  importModalOverlay.classList.remove("active");
  importModalOverlay.classList.add("hidden");
  try {
    await invoke("stop_receive_server");
    logToFile("モバイル同期: 受信キャンセル");
  } catch {
    /* ignore */
  }
});

listen<{ zipPath: string; size: number }>("result-uploaded", async (event) => {
  const { zipPath, size } = event.payload;
  importStatusEl.textContent = `データ受信完了 (${(size / 1024 / 1024).toFixed(1)} MB)。PCに取り込み中...`;
  resultEl.textContent = `データ受信完了 (${(size / 1024 / 1024).toFixed(1)} MB)\nPCに取り込み中...\n${zipPath}`;
  logToFile(`モバイル同期: 受信完了 size=${size} zip=${zipPath}`);
});

// 受信完了イベントのリスナー
listen<{
  uploadId: string;
  zipPath: string;
  size: number;
}>("result-received", async (event) => {
  importModalOverlay.classList.remove("active");
  importModalOverlay.classList.add("hidden");
  const { uploadId, zipPath, size } = event.payload;
  let successAckSent = false;
  let leaseHeartbeatTimer: number | null = null;
  let leaseHeartbeatFailure: unknown = null;
  const heartbeatUploadLease = () =>
    invoke("heartbeat_received_upload", { uploadId });
  const assertUploadLeaseCurrent = async () => {
    if (leaseHeartbeatFailure) throw leaseHeartbeatFailure;
    await heartbeatUploadLease();
    if (leaseHeartbeatFailure) throw leaseHeartbeatFailure;
  };
  const startUploadLeaseHeartbeat = () => {
    leaseHeartbeatTimer = window.setInterval(() => {
      void heartbeatUploadLease().catch((error) => {
        leaseHeartbeatFailure = error;
        if (leaseHeartbeatTimer !== null) clearInterval(leaseHeartbeatTimer);
        leaseHeartbeatTimer = null;
      });
    }, 20_000);
  };

  resultEl.textContent = `データ受信完了 (${(size / 1024 / 1024).toFixed(1)} MB)\nインポート完了処理中...`;

  try {
    await invoke("claim_received_upload", { uploadId });
    startUploadLeaseHeartbeat();
    await waitForOperationIdle();
    await assertUploadLeaseCurrent();
    const pendingCrawlMeta = captureCrawlMetaSnapshot();
    const res = await runManagedEventDocumentMutation(async () => {
      await assertUploadLeaseCurrent();
      await flushCrawlMetaSnapshot(
        pendingCrawlMeta,
        INTERNAL_OPERATION_SAVE,
      );
      await assertUploadLeaseCurrent();
      const activeSave = await saveNow(INTERNAL_OPERATION_SAVE);
      if (!activeSave.ok) {
        throw new Error(`インポート前の保存に失敗しました: ${String(activeSave.error)}`);
      }
      await assertUploadLeaseCurrent();
      await flushAllEventSavesOrThrow();
      await flushCircleMasterSaves();
      await assertUploadLeaseCurrent();
      return circleMasterWriteSerial.run(CIRCLE_MASTER_WRITE_KEY, async () => {
        const plan = await invoke<{
        status: string;
        slug: string;
        dir: string;
        affectedEvents: Array<{ slug: string; dir: string; survives: boolean }>;
        }>("plan_received_result_import", {
          uploadId,
          projectRoot: projectRootEl.value,
        });
        await assertUploadLeaseCurrent();
        const lifecycleKeys = Array.from(
          new Set(
            plan.affectedEvents.map((affected) =>
              eventMetaOwnerKey(affected.slug, affected.dir),
            ),
          ),
        );
        await Promise.all(
          lifecycleKeys.map((key) => eventLifecycleGate.closeAndDrain(key)),
        );
        let published = false;
        const cacheReadyLifecycleKeys = new Set<string>();
        try {
          const staged = await invoke<{
            status: string;
            slug: string;
            dir: string;
            meta: EventMeta;
          }>("stage_received_result_import", {
            uploadId,
            projectRoot: projectRootEl.value,
            expectedSlug: plan.slug,
          });
          await assertUploadLeaseCurrent();
          const imported = await invoke<{
            status: string;
            slug: string;
            dir: string;
          }>("publish_received_result_import", { uploadId });
          published = true;
          // publish commandがmobile successをatomicに確定する。以後のUI復旧失敗は
          // committed uploadをfailure/retryへ戻してはいけない。
          successAckSent = true;
          for (const affected of plan.affectedEvents) {
            const key = eventMetaOwnerKey(affected.slug, affected.dir);
            eventMetaWriteCoordinator.invalidate(key);
            eventMetaWriteCoordinator.forgetCommitted(key);
          }
          // publishはevent directoryを外部置換するため、survivorを再openする前に
          // fresh documentのevent metadataをcacheへ戻す。古いUI snapshotが直後に
          // 保存されてもmobile import metadataを巻き戻さない。
          for (const affected of plan.affectedEvents) {
            if (!affected.survives) continue;
            const key = eventMetaOwnerKey(affected.slug, affected.dir);
            const freshBundle = await invoke<{ data?: EventJsonData }>(
              "load_event_bundle",
              {
                eventJson: eventJsonPathForDir(affected.dir),
                eventDir: affected.dir,
                includeMaps: false,
              },
            );
            if (
              !freshBundle?.data ||
              typeof freshBundle.data !== "object" ||
              Array.isArray(freshBundle.data)
            ) {
              throw new Error(
                `インポート後のevent.json再読込に失敗しました: ${affected.slug}`,
              );
            }
            const freshMeta = freshBundle.data.event;
            if (
              freshMeta !== undefined &&
              (freshMeta === null ||
                typeof freshMeta !== "object" ||
                Array.isArray(freshMeta))
            ) {
              throw new Error(
                `インポート後のevent metadataが不正です: ${affected.slug}`,
              );
            }
            eventMetaWriteCoordinator.recordCommitted(key, freshMeta ?? {});
            cacheReadyLifecycleKeys.add(key);
          }
          return { ...staged, ...imported };
        } finally {
          for (const affected of plan.affectedEvents) {
            const key = eventMetaOwnerKey(affected.slug, affected.dir);
            if (!published || cacheReadyLifecycleKeys.has(key)) {
              eventLifecycleGate.open(key);
            }
          }
        }
      });
    });

    if (res.status === "ok") {
      const recoveryWarnings: string[] = [];
      try {
        await loadCircleMasterStrict();
      } catch (error) {
        recoveryWarnings.push(`circle_master再読込失敗: ${String(error)}`);
      }
      try {
        await loadEventList();
      } catch (error) {
        recoveryWarnings.push(`イベント一覧再読込失敗: ${String(error)}`);
      }
      try {
        const selected = await selectEvent(res.slug);
        if (!selected) recoveryWarnings.push("インポート後のイベント選択に失敗しました");
      } catch (error) {
        recoveryWarnings.push(`イベント選択エラー: ${String(error)}`);
      }
      const warningText = recoveryWarnings.length
        ? `\nUI再読込警告: ${recoveryWarnings.join(" / ")}`
        : "";
      resultEl.textContent = `インポート完了: ${res.meta.name || res.slug}${warningText}`;
      logToFile(`モバイル同期: インポート完了 slug=${res.slug} zip=${zipPath}`);
    } else {
      throw new Error("インポート結果が成功ではありません");
    }
  } catch (e) {
    if (!successAckSent) {
      try {
        await invoke("cancel_received_upload", {
          uploadId,
          error: String(e),
        });
      } catch (ackError) {
        logToFile(`モバイル同期: failure ackエラー ${String(ackError)}`);
      }
    }
    resultEl.textContent = `インポートエラー: ${String(e)}`;
    logToFile(`モバイル同期: インポートエラー ${String(e)} zip=${zipPath}`);
  } finally {
    if (leaseHeartbeatTimer !== null) clearInterval(leaseHeartbeatTimer);
  }
});

listen<{ zipPath?: string; size?: number; error: string }>(
  "result-receive-error",
  async (event) => {
    importModalOverlay.classList.remove("active");
    importModalOverlay.classList.add("hidden");
    const { zipPath, size, error } = event.payload;
    resultEl.textContent = `同期エラー: ${error}`;
    logToFile(
      `モバイル同期: 同期エラー error=${error} size=${size ?? "?"} zip=${zipPath ?? "?"}`,
    );
  },
);

// 購入結果の色分け表示（renderCircleEditorの拡張）
// checked列がある場合、テーブル行に背景色を適用
function applyPurchaseStatusColors() {
  const checkedIdx = tableState.headers.indexOf("チェック");
  if (checkedIdx < 0) return;

  const rows = document.querySelectorAll<HTMLTableRowElement>(
    "#circleEditor table tbody tr",
  );
  rows.forEach((tr) => {
    const cells = tr.querySelectorAll("td");
    const checkedCell = cells[checkedIdx];
    if (!checkedCell) return;
    const val =
      (checkedCell.querySelector("input") as HTMLInputElement)?.value || "";
    if (val === "1") {
      tr.style.backgroundColor = "rgba(46, 125, 50, 0.08)"; // 買えた: 緑
    } else if (val === "2") {
      tr.style.backgroundColor = "rgba(198, 40, 40, 0.08)"; // 買えなかった: 赤
    } else if (val === "3") {
      tr.style.backgroundColor = "rgba(109, 76, 65, 0.08)"; // 見送り: 茶
    }
  });
}

// === 結果ログ折りたたみ ===
const LOG_COLLAPSED_KEY = "eventtrail-log-collapsed";
function initLogToggle() {
  const logArea = document.getElementById("logArea");
  const logToggle = document.getElementById("logToggle");
  const resultPre = document.getElementById("result");
  if (!logArea || !logToggle || !resultPre) return;

  // 初期状態復元（デフォルト: 格納）
  const collapsed = localStorage.getItem(LOG_COLLAPSED_KEY) !== "false";
  if (collapsed) {
    logArea.classList.add("collapsed");
    resultPre.classList.add("hidden");
  } else {
    logArea.classList.remove("collapsed");
    resultPre.classList.remove("hidden");
  }

  logToggle.addEventListener("click", () => {
    const isCollapsed = logArea.classList.toggle("collapsed");
    resultPre.classList.toggle("hidden", isCollapsed);
    localStorage.setItem(LOG_COLLAPSED_KEY, isCollapsed ? "true" : "false");
  });
}

// === 予算パネル ===

// 予算計算（モバイルのgetBudgetSummaryと同等ロジック）
function calculateBudgetSummary() {
  const summary = {
    totalListPrice: 0,
    totalPlanned: 0,
    totalBought: 0,
    totalCouldntBuy: 0,
    totalSkipped: 0,
    totalRemaining: 0,
    byPriority: new Map<
      number,
      {
        total: number;
        planned: number;
        bought: number;
        couldntBuy: number;
        skipped: number;
        remaining: number;
        circleCount: number;
      }
    >(),
  };
  if (!eventJsonData?.circles) return summary;

  for (const circle of eventJsonData.circles) {
    const prioColor = circle.priority_color ?? 5;
    if (!summary.byPriority.has(prioColor)) {
      summary.byPriority.set(prioColor, {
        total: 0,
        planned: 0,
        bought: 0,
        couldntBuy: 0,
        skipped: 0,
        remaining: 0,
        circleCount: 0,
      });
    }
    const p = summary.byPriority.get(prioColor)!;
    p.circleCount++;
    for (const item of circle.items ?? []) {
      const price = Number(item.price ?? 0) || 0;
      const status = getEffectiveItemStatus(item, circle);
      summary.totalListPrice += price;
      p.total += price;
      if (status === PURCHASE_STATUS.BOUGHT) {
        summary.totalBought += price;
        p.bought += price;
      } else if (status === PURCHASE_STATUS.COULDNT_BUY) {
        summary.totalCouldntBuy += price;
        p.couldntBuy += price;
      } else if (status === PURCHASE_STATUS.SKIPPED) {
        summary.totalSkipped += price;
        p.skipped += price;
      } else {
        summary.totalRemaining += price;
        p.remaining += price;
      }
    }
  }
  summary.totalPlanned = summary.totalBought + summary.totalRemaining;
  for (const p of summary.byPriority.values()) {
    p.planned = p.bought + p.remaining;
  }
  return summary;
}

function formatYen(n: number): string {
  return n > 0 ? `¥${n.toLocaleString()}` : "¥0";
}

// 予算パネル更新
function updateBudgetPanel() {
  const panel = document.getElementById("budgetPanel");
  if (!panel || !eventJsonData) return;

  const summary = calculateBudgetSummary();

  // リスト総額が0なら非表示
  if (summary.totalListPrice === 0) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");

  // インラインサマリー（折りたたみ時に表示）
  const inline = document.getElementById("budgetSummaryInline");
  if (inline) {
    inline.textContent = `予定 ${formatYen(summary.totalPlanned)} (残 ${formatYen(summary.totalRemaining)})`;
  }

  // 各値を更新
  const setEl = (id: string, text: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  setEl("budgetTotalList", formatYen(summary.totalListPrice));
  setEl("budgetTotalPlanned", formatYen(summary.totalPlanned));
  setEl("budgetTotalBought", formatYen(summary.totalBought));
  setEl("budgetTotalCouldnt", formatYen(summary.totalCouldntBuy));
  setEl("budgetTotalSkipped", formatYen(summary.totalSkipped));
  setEl("budgetTotalRemaining", formatYen(summary.totalRemaining));

  // 優先度別内訳
  const detailEl = document.getElementById("budgetPriorityDetail");
  if (detailEl) {
    const priorityOrder = [15, 10, 11, 5]; // 最優先→高→中→低
    let html = "";
    for (const prio of priorityOrder) {
      const data = summary.byPriority.get(prio);
      if (!data) continue;
      const colorOpt = COLOR_OPTIONS.find((o) => Number(o.value) === prio);
      if (!colorOpt) continue;
      html += `<div class="budget-priority-row">
        <span class="budget-priority-dot" style="background:${colorOpt.color}"></span>
        <span class="budget-priority-label" style="color:${colorOpt.color}">${colorOpt.label}</span>
        <span class="budget-priority-count">${data.circleCount}件</span>
        <span class="budget-priority-value">${formatYen(data.planned)} / 総額 ${formatYen(data.total)}</span>
      </div>`;
    }
    detailEl.innerHTML = html;
  }
}

// 予算パネル初期化（トグル操作）
function initBudgetPanel() {
  const toggle = document.getElementById("budgetToggle");
  const body = document.getElementById("budgetBody");
  const arrow = toggle?.querySelector(".budget-arrow");
  if (toggle && body) {
    toggle.addEventListener("click", () => {
      body.classList.toggle("hidden");
      if (arrow)
        arrow.textContent = body.classList.contains("hidden")
          ? "\u25B6"
          : "\u25BC";
    });
  }
}

// === イベントメモ ===
let eventMemoTimer: number | null = null;

function cancelEventMemoSave(): void {
  if (eventMemoTimer) clearTimeout(eventMemoTimer);
  eventMemoTimer = null;
}

function initEventMemo() {
  const memoArea = document.getElementById("eventMemoArea");
  const memoToggle = document.getElementById("eventMemoToggle");
  const memoBody = document.getElementById("eventMemoBody");
  const memoInput = document.getElementById(
    "eventMemoInput",
  ) as HTMLTextAreaElement | null;
  if (!memoArea || !memoToggle || !memoBody || !memoInput) return;

  memoToggle.addEventListener("click", () => {
    const isClosed = memoArea.classList.toggle("collapsed");
    memoBody.classList.toggle("hidden", isClosed);
  });

  memoInput.addEventListener("input", () => {
    if (!eventJsonData) return;
    if (isMapAutoOperation(operationState)) return;
    markEventDocumentMutated();
    if (!eventJsonData.event) eventJsonData.event = {};
    eventJsonData.event.memo = memoInput.value;
    // デバウンス保存
    cancelEventMemoSave();
    eventMemoTimer = window.setTimeout(() => saveNow(), 500);
  });
}

function updateEventMemoUI() {
  const memoArea = document.getElementById("eventMemoArea");
  const memoBody = document.getElementById("eventMemoBody");
  const memoInput = document.getElementById(
    "eventMemoInput",
  ) as HTMLTextAreaElement | null;
  if (!memoArea || !memoBody || !memoInput) return;

  const memo = eventJsonData?.event?.memo || "";
  memoInput.value = memo;

  if (eventJsonData) {
    memoArea.classList.remove("hidden");
    // メモがあれば展開、なければ折りたたみ
    if (memo) {
      memoArea.classList.remove("collapsed");
      memoBody.classList.remove("hidden");
    } else {
      memoArea.classList.add("collapsed");
      memoBody.classList.add("hidden");
    }
  } else {
    memoArea.classList.add("hidden");
  }
}

// ==================== 自動更新 ====================
type UpdateCheckResult = {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion?: string;
  downloadUrl?: string;
  releaseNotes?: string;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function cleanupOldUpdate(): Promise<void> {
  try {
    await invoke("cleanup_old_update");
  } catch {
    // クリーンアップ失敗は無視
  }
}

async function checkForUpdate(manual = false): Promise<void> {
  const statusEl = document.getElementById("updateCheckStatus");
  if (manual && statusEl) statusEl.textContent = "確認中...";

  try {
    const result = (await invoke("check_for_update")) as UpdateCheckResult;

    if (!result.updateAvailable || !result.latestVersion) {
      if (manual && statusEl) {
        statusEl.textContent = "最新バージョンです";
        setTimeout(() => {
          statusEl.textContent = "";
        }, 3000);
      }
      return;
    }

    // 自動チェック時は既スキップ済みバージョンを表示しない
    if (!manual) {
      const dismissed = localStorage.getItem("eventtrail-update-dismissed");
      if (dismissed === result.latestVersion) return;
    }

    if (statusEl) statusEl.textContent = "";
    showUpdateBar(result);
  } catch {
    // 更新チェック失敗は黙殺（オフライン等）
    if (manual && statusEl) {
      statusEl.textContent = "確認に失敗しました";
      setTimeout(() => {
        statusEl.textContent = "";
      }, 3000);
    }
  }
}

function showUpdateBar(info: UpdateCheckResult): void {
  const bar = document.getElementById("updateBar")!;
  const msg = document.getElementById("updateBarMsg")!;
  const btn = document.getElementById("updateBtn")!;
  const dismissBtn = document.getElementById("updateDismissBtn")!;

  const notesText = info.releaseNotes ? ` (${info.releaseNotes})` : "";
  msg.textContent = `Event AutoPin の新しいバージョン v${info.latestVersion} が利用可能です${notesText}`;
  bar.classList.remove("hidden");

  btn.onclick = () => downloadAndApplyUpdate(info.downloadUrl!);
  dismissBtn.onclick = () => {
    bar.classList.add("hidden");
    localStorage.setItem("eventtrail-update-dismissed", info.latestVersion!);
  };
}

async function downloadAndApplyUpdate(url: string): Promise<void> {
  const btn = document.getElementById("updateBtn") as HTMLButtonElement;
  const msgEl = document.getElementById("updateBarMsg")!;
  const progressContainer = document.getElementById("updateBarProgress")!;
  const progressBar = document.getElementById(
    "updateProgressBar",
  ) as HTMLProgressElement;
  const sizeEl = document.getElementById("updateBarSize")!;
  const dismissBtn = document.getElementById("updateDismissBtn")!;

  btn.disabled = true;
  btn.textContent = "ダウンロード中...";
  dismissBtn.classList.add("hidden");
  msgEl.classList.add("hidden");
  progressContainer.classList.remove("hidden");

  const unlisten = await listen("update-download-progress", (event: any) => {
    const { downloaded, totalSize, progress } = event.payload as {
      downloaded: number;
      totalSize: number;
      progress: number;
    };
    progressBar.value = progress;
    if (totalSize > 0) {
      sizeEl.textContent = `${formatBytes(downloaded)} / ${formatBytes(totalSize)}`;
    } else {
      sizeEl.textContent = formatBytes(downloaded);
    }
  });

  try {
    await invoke("download_update", { url });
    unlisten();

    btn.textContent = "再起動して更新を適用";
    btn.disabled = false;
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = "更新を適用中...";
      try {
        await invoke("apply_update");
      } catch (e) {
        btn.textContent = "更新適用に失敗しました";
        console.error("apply_update 失敗:", e);
      }
    };
  } catch (e) {
    unlisten();
    progressContainer.classList.add("hidden");
    msgEl.classList.remove("hidden");
    msgEl.textContent = `ダウンロード失敗: ${e}`;
    btn.textContent = "再試行";
    btn.disabled = false;
    btn.onclick = () => downloadAndApplyUpdate(url);
    dismissBtn.classList.remove("hidden");
  }
}

// テーマ・画像サイズの初期化
initThemeToggle();
initImgSizeSelector();
initPriorityColorSettings();
initLogToggle();
initEventMemo();
initBudgetPanel();

// 起動時はイベント一覧だけを読み込み、詳細は選択時に遅延ロードする
initialConfigPromise
  .then(() => loadCircleMaster())
  .then(() => loadEventList())
  .then(() => cleanupOldUpdate())
  .then(() => {
    window.setTimeout(() => void checkForUpdate(), 1500);
  })
  .catch(() => {});

// 手動「更新を確認」ボタン
document.getElementById("checkUpdateBtn")?.addEventListener("click", () => {
  checkForUpdate(true);
});
