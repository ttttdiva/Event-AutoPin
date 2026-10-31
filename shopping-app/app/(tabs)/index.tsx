import { InputTextInput as TextInput } from "@/components/KeyboardLayout";
import { InputModal, InputScrollView } from "@/components/KeyboardLayout";
import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import {
  StyleSheet,
  View,
  Text,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  Alert,
  Modal,
  Pressable,
  StatusBar,
  Platform,
} from "react-native";
import { useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useEvent } from "@/lib/event-context";
import { useTheme } from "@/lib/theme-context";
import {
  getEventSummaries,
  startShopping,
  endShopping,
  deleteEventWithImages,
  resetAllPurchaseStatus,
  exportEventAsZip,
  linkEventSyncUidForPairing,
  previewSingleEventSyncZip,
  applySingleEventSyncZip,
  updateEventMemo,
  toggleEventCompleted,
  createEvent,
  pickAndSaveEventImage,
  removeEventImage,
  getSetting,
  setSetting,
} from "@/lib/database";
import {
  handleImportZip,
  handleImportFromQRUrl,
} from "@/lib/import-helpers";
import type { ImportRunResult } from "@/lib/import-helpers";
import {
  appendSyncLog,
  createSyncLog,
  getFileSize,
  shareSyncLog,
} from "@/lib/sync-logger";
import type { ImportProgress, ExportProgress, SingleEventSyncPreview } from "@/lib/database";
import type { EventSummary } from "@/lib/database";
import { getColors } from "@/constants/Colors";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { ScreenSafeArea } from "@/components/ScreenSafeArea";
import EventCard from "@/components/EventCard";
import {
  beginSqlMetricsScope,
  recordUiMetric,
  recordUiMetricAfterPaint,
  startUiMetric,
} from "@/lib/performance";
import { createLoadEpochGuard } from "@/lib/event-load-epoch";
import { compareJaText } from "@/lib/text-collation";
import {
  parseSingleEventSyncDownloadUrl,
  parseSingleEventSyncUploadUrl,
  parseSingleEventSyncSessionResponse,
  redactSyncUrl,
  redactSyncText,
  resolveSingleEventSyncIdentity,
  resolveSingleEventSyncUid,
  shouldRetrySingleEventSyncCancellation,
} from "../../lib/single-event-sync";

type EventWithStats = EventSummary;

type EventSortKey = "imported" | "date" | "name";
type SortDirection = "desc" | "asc";

const EVENT_SORT_OPTIONS: Array<{ key: EventSortKey; label: string }> = [
  { key: "imported", label: "取り込み" },
  { key: "date", label: "開催日" },
  { key: "name", label: "名前" },
];

const EVENT_SORT_KEY_SETTING = "event_list_sort_key";
const EVENT_SORT_DIRECTION_SETTING = "event_list_sort_direction";
const PC_SYNC_TIMEOUT_MS = 15 * 60 * 1000;
const PC_SYNC_POLL_INTERVAL_MS = 1500;
const PC_SYNC_POLL_REQUEST_TIMEOUT_MS = 15 * 1000;
const PC_SYNC_NETWORK_WARNING = "Bearerトークンは20分で失効します。HTTP通信は暗号化されません。同じプライベートIPv4の/24（同一LAN）で実行してください。";

function normalizeEventSortKey(value: string | null): EventSortKey {
  return EVENT_SORT_OPTIONS.some((option) => option.key === value)
    ? (value as EventSortKey)
    : "imported";
}

function normalizeSortDirection(value: string | null): SortDirection {
  return value === "asc" || value === "desc" ? value : "desc";
}

function parseDateValue(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function compareNullableDate(
  a: string | null | undefined,
  b: string | null | undefined,
  direction: SortDirection,
) {
  const av = parseDateValue(a);
  const bv = parseDateValue(b);
  if (av === null && bv === null) return 0;
  if (av === null) return 1;
  if (bv === null) return -1;
  return direction === "desc" ? bv - av : av - bv;
}

function sortEvents(
  eventList: EventWithStats[],
  sortKey: EventSortKey,
  direction: SortDirection,
) {
  return [...eventList].sort((a, b) => {
    let result = 0;
    if (sortKey === "imported") {
      result = compareNullableDate(a.importedAt, b.importedAt, direction);
    } else if (sortKey === "date") {
      result = compareNullableDate(a.date, b.date, direction);
    } else {
      result = compareJaText(a.name, b.name);
      if (direction === "desc") result = -result;
    }
    return result || b.id - a.id;
  });
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new Error(
        `PC側の応答待ちが${Math.round(timeoutMs / 1000)}秒を超えました。PC側の完了表示、同一Wi-Fi、ファイアウォール設定を確認してください。`,
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function waitForSyncPollInterval(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, PC_SYNC_POLL_INTERVAL_MS));
}

async function pollSingleEventSyncSession(
  sessionUrl: string,
  expectedUid: string,
  shouldCancel: () => boolean,
  onWaiting: () => void,
): Promise<ReturnType<typeof parseSingleEventSyncSessionResponse>> {
  const deadline = Date.now() + PC_SYNC_TIMEOUT_MS;
  let firstRequest = true;
  while (Date.now() < deadline) {
    if (shouldCancel()) throw new Error("イベント同期を中断しました");
    if (!firstRequest) {
      onWaiting();
      await waitForSyncPollInterval();
      if (shouldCancel()) throw new Error("イベント同期を中断しました");
    }
    firstRequest = false;
    const response = await fetchWithTimeout(
      sessionUrl,
      { method: "GET", headers: { Accept: "application/json" } },
      PC_SYNC_POLL_REQUEST_TIMEOUT_MS,
    );
    const body = await response.text();
    // A pending session is intentionally represented by 202.  A 404/405
    // means that the server does not implement same-session polling, so do
    // not retry forever or ask the user to scan a second QR.
    if (response.status === 404 || response.status === 405) {
      throw new Error("PC側がこの同期セッションの継続に対応していません。PCアプリを更新してから再試行してください");
    }
    if (!response.ok && response.status !== 202) {
      let message = `同期セッションの確認に失敗しました: HTTP ${response.status}`;
      if (body.trim()) {
        try {
          const parsed = parseSingleEventSyncSessionResponse(body, expectedUid);
          if (parsed.message) message = parsed.message;
        } catch {
          // Keep the status based error and avoid exposing an untrusted body.
        }
      }
      throw new Error(message);
    }
    if (!body.trim()) continue;
    const parsed = parseSingleEventSyncSessionResponse(body, expectedUid);
    if (parsed.state !== "pending") return parsed;
  }
  throw new Error("PC側の選択待ちがタイムアウトしました。PC側の同期画面を確認してください");
}

async function postSingleEventSyncSession(
  sessionUrl: string,
  expectedUid: string,
  state: "mobile-applied" | "cancelled",
): Promise<void> {
  const response = await fetchWithTimeout(
    sessionUrl,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mode: "single-event-sync",
        target_uid: expectedUid,
        state,
        result: state,
      }),
    },
    PC_SYNC_POLL_REQUEST_TIMEOUT_MS,
  );
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`PC側への同期完了通知に失敗しました: HTTP ${response.status}`);
  }
  if (body.trim()) {
    const result = parseSingleEventSyncSessionResponse(body, expectedUid);
    if (result.state === "error") {
      throw new Error(result.message ?? "PC側が同期完了通知を受け付けませんでした");
    }
  }
}

async function getSingleEventSyncSessionOnce(
  sessionUrl: string,
  expectedUid: string,
): Promise<ReturnType<typeof parseSingleEventSyncSessionResponse>> {
  // POST only acknowledges receipt. The backend publishes the terminal state
  // and then delivers event-sync-session-state (delivered:true) to the
  // desktop when this one-shot GET arrives, so require that GET confirmation
  // before showing completion.
  const terminalResponse = await fetchWithTimeout(
    sessionUrl,
    { method: "GET", headers: { Accept: "application/json" } },
    PC_SYNC_POLL_REQUEST_TIMEOUT_MS,
  );
  const terminalBody = await terminalResponse.text();
  if (!terminalResponse.ok) {
    throw new Error(`PC側の同期完了確認に失敗しました: HTTP ${terminalResponse.status}`);
  }
  if (!terminalBody.trim()) {
    throw new Error("PC側の同期完了確認が空の応答でした");
  }
  const terminal = parseSingleEventSyncSessionResponse(terminalBody, expectedUid);
  if (terminal.targetUid !== expectedUid) throw new Error("PC側の同期完了確認のUIDが一致しません");
  return terminal;
}

async function notifySingleEventSyncSession(
  sessionUrl: string,
  expectedUid: string,
  state: "mobile-applied" | "cancelled",
): Promise<void> {
  await postSingleEventSyncSession(sessionUrl, expectedUid, state);
  const terminal = await getSingleEventSyncSessionOnce(sessionUrl, expectedUid);
  if (terminal.state !== state) {
    throw new Error("PC側の同期完了通知が同UIDの終端状態として確認できませんでした");
  }
}

/** Best effort terminalization after an upload/transport failure. */
async function cancelSingleEventSyncSessionBestEffort(
  sessionUrl: string,
  expectedUid: string,
): Promise<string | null> {
  const warnings: string[] = [];
  try {
    await postSingleEventSyncSession(sessionUrl, expectedUid, "cancelled");
  } catch (error: any) {
    warnings.push(`同期終了通知: ${redactSyncText(error?.message ?? String(error))}`);
  }
  let terminal: ReturnType<typeof parseSingleEventSyncSessionResponse> | null = null;
  try {
    terminal = await getSingleEventSyncSessionOnce(sessionUrl, expectedUid);
  } catch (error: any) {
    warnings.push(`同期終端確認: ${redactSyncText(error?.message ?? String(error))}`);
    return warnings.length ? warnings.join(" / ") : null;
  }

  // A transient POST failure can leave the session pending. Retry cancellation
  // exactly once in that state; terminal states are never overwritten.
  if (shouldRetrySingleEventSyncCancellation(terminal.state)) {
    try {
      await postSingleEventSyncSession(sessionUrl, expectedUid, "cancelled");
    } catch (error: any) {
      warnings.push(`再試行の同期終了通知: ${redactSyncText(error?.message ?? String(error))}`);
    }
    try {
      terminal = await getSingleEventSyncSessionOnce(sessionUrl, expectedUid);
    } catch (error: any) {
      warnings.push(`再試行の同期終端確認: ${redactSyncText(error?.message ?? String(error))}`);
      return warnings.length ? warnings.join(" / ") : null;
    }
  }
  if (terminal.state !== "cancelled" && terminal.state !== "error" && terminal.state !== "mobile-applied") {
    warnings.push(`同期終端state: ${terminal.state}`);
  }
  return warnings.length ? warnings.join(" / ") : null;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatImportProgress(progress: ImportProgress): string {
  if (progress.phase === "download") {
    const downloaded = formatBytes(progress.current);
    if (progress.total > 0) {
      return `ダウンロード中 ${downloaded} / ${formatBytes(progress.total)}`;
    }
    return `ダウンロード中 ${downloaded}`;
  }
  if (progress.phase === "events") {
    return `イベント ${progress.current}/${progress.total}`;
  }
  if (progress.phase === "circles") {
    return `サークル ${progress.current}/${progress.total}`;
  }
  return "マップ読み込み中...";
}

function compactDiffLines(values: string[], limit = 8): string {
  if (!values.length) return "なし";
  const shown = values.slice(0, limit).map((value) => `・${value}`).join("\n");
  return values.length > limit ? `${shown}\nほか ${values.length - limit}件` : shown;
}

function formatSingleEventSyncDiff(preview: SingleEventSyncPreview): string {
  const { diff } = preview;
  const lines = [
    `イベント情報: ${diff.metadata.length}件`,
    compactDiffLines(diff.metadata),
    `サークル: 追加 ${diff.circles.added.length} / 変更 ${diff.circles.changed.length} / 削除 ${diff.circles.removed.length}`,
    compactDiffLines([...diff.circles.added.map((name) => `追加 ${name}`), ...diff.circles.changed.map((name) => `変更 ${name}`), ...diff.circles.removed.map((name) => `削除 ${name}`)]),
    `頒布物: 追加 ${diff.items.added.length} / 変更 ${diff.items.changed.length} / 削除 ${diff.items.removed.length}`,
    compactDiffLines([...diff.items.added.map((name) => `追加 ${name}`), ...diff.items.changed.map((name) => `変更 ${name}`), ...diff.items.removed.map((name) => `削除 ${name}`)]),
    `購入状態: ${diff.purchase.length}件`,
    compactDiffLines(diff.purchase),
    `マップピン: ${diff.mapPins.length}件`,
    compactDiffLines(diff.mapPins),
    `画像: 追加 ${diff.images.added.length} / 変更 ${diff.images.changed.length} / 削除 ${diff.images.removed.length}`,
    compactDiffLines([...diff.images.added.map((name) => `追加 ${name}`), ...diff.images.changed.map((name) => `変更 ${name}`), ...diff.images.removed.map((name) => `削除 ${name}`)]),
  ];
  return lines.join("\n");
}

export default function EventListScreen() {
  const { effectiveScheme } = useTheme();
  const colors = getColors(effectiveScheme);
  const router = useRouter();
  const { setCurrentEventId } = useEvent();

  const [events, setEvents] = useState<EventWithStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const activeListLoadRef = useRef<number | null>(null);
  const [eventSortKey, setEventSortKey] = useState<EventSortKey>("imported");
  const [eventSortDirection, setEventSortDirection] =
    useState<SortDirection>("desc");
  const [sortSettingsLoaded, setSortSettingsLoaded] = useState(false);
  const listLoadEpochGuardRef = useRef(createLoadEpochGuard());
  const listFmpStartedAt = useRef(startUiMetric());

  const sortedEvents = useMemo(
    () => sortEvents(events, eventSortKey, eventSortDirection),
    [events, eventSortKey, eventSortDirection],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [savedKey, savedDirection] = await Promise.all([
        getSetting(EVENT_SORT_KEY_SETTING),
        getSetting(EVENT_SORT_DIRECTION_SETTING),
      ]);
      if (cancelled) return;
      setEventSortKey(normalizeEventSortKey(savedKey));
      setEventSortDirection(normalizeSortDirection(savedDirection));
      setSortSettingsLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!sortSettingsLoaded) return;
    void setSetting(EVENT_SORT_KEY_SETTING, eventSortKey);
    void setSetting(EVENT_SORT_DIRECTION_SETTING, eventSortDirection);
  }, [eventSortKey, eventSortDirection, sortSettingsLoaded]);

  // インポート
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(
    null,
  );
  const [showQRScanner, setShowQRScanner] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const qrScannedRef = useRef(false);

  // インポート方法選択モーダル
  const [showImportModal, setShowImportModal] = useState(false);
  const [showAdvancedImportOptions, setShowAdvancedImportOptions] = useState(false);

  // 長押しアクションモーダル
  const [actionTarget, setActionTarget] = useState<EventWithStats | null>(null);

  // エクスポート
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(
    null,
  );
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [lastSyncLogPath, setLastSyncLogPath] = useState<string | null>(null);

  // PCと同期（初回QRでセッションを開始）
  const [sendToPCTarget, setSendToPCTarget] = useState<EventWithStats | null>(
    null,
  );
  const [showSendQRScanner, setShowSendQRScanner] = useState(false);
  const sendQrScannedRef = useRef(false);
  const [pendingSingleEventSync, setPendingSingleEventSync] = useState<{
    event: EventWithStats;
    zipPath: string;
    preview: SingleEventSyncPreview;
    sessionUrl: string;
  } | null>(null);
  const [singleSyncSourceSelected, setSingleSyncSourceSelected] = useState(false);
  const [singleSyncBusy, setSingleSyncBusy] = useState(false);
  const syncCancelledRef = useRef(false);
  const activeSyncNetworkTaskRef = useRef<{ cancelAsync: () => Promise<void> } | null>(null);

  // イベントメモ編集
  const [memoTarget, setMemoTarget] = useState<EventWithStats | null>(null);
  const [memoText, setMemoText] = useState("");

  // イベント作成
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDate, setCreateDate] = useState("");
  const [createVenue, setCreateVenue] = useState("");

  const patchEventSummary = useCallback(
    (eventId: number, patch: Partial<EventWithStats>) => {
      setEvents((previous) =>
        previous.map((event) =>
          event.id === eventId ? { ...event, ...patch } : event,
        ),
      );
      setActionTarget((target) =>
        target?.id === eventId ? { ...target, ...patch } : target,
      );
      setMemoTarget((target) =>
        target?.id === eventId ? { ...target, ...patch } : target,
      );
    },
    [],
  );

  const invalidateListLoad = useCallback(() => {
    // Targeted mutations fence off both an already-running query and any
    // query that started while the mutation was in flight. Call again after
    // the DB commit immediately before applying the local patch.
    listLoadEpochGuardRef.current.next();
  }, []);

  const loadData = useCallback(async () => {
    const guard = listLoadEpochGuardRef.current;
    // Coalesce repeated taps while this request still owns the list. A mutation
    // or focus change invalidates its epoch so a newer read can start immediately.
    if (
      activeListLoadRef.current !== null &&
      guard.isCurrent(activeListLoadRef.current)
    ) return;
    const epoch = guard.next();
    activeListLoadRef.current = epoch;
    const endSqlMetrics = beginSqlMetricsScope("event-list");
    setLoading(true);
    setLoadError(false);
    try {
      // イベント件数に比例する N+1 を避け、集約 projection を1 SQLで取得する。
      const summaries = await getEventSummaries();
      if (!listLoadEpochGuardRef.current.isCurrent(epoch)) return;
      setEvents(summaries);
      setHasLoaded(true);
    } catch (e) {
      if (!guard.isCurrent(epoch)) return;
      setLoadError(true);
      console.error("データ読み込みエラー:", e);
    } finally {
      if (activeListLoadRef.current === epoch) activeListLoadRef.current = null;
      const snapshot = endSqlMetrics();
      recordUiMetric("event-list-sql-count", snapshot.count);
      recordUiMetric("event-list-sql-elapsed-ms", snapshot.elapsedMs);
      recordUiMetric("event-list-sql-wall-ms", snapshot.wallElapsedMs);
      if (listLoadEpochGuardRef.current.isCurrent(epoch)) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    return () => {
      // Invalidate in-flight list requests when leaving the route. The latest
      // request guard also prevents a stale focus/refresh response from
      // replacing a newer create/import result.
      listLoadEpochGuardRef.current.next();
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadData();
      return () => {
        listLoadEpochGuardRef.current.next();
      };
    }, [loadData]),
  );

  const listFmpRecorded = useRef(false);
  useEffect(() => {
    if (!loading && !listFmpRecorded.current) {
      listFmpRecorded.current = true;
      recordUiMetricAfterPaint("event-list-fmp", listFmpStartedAt.current);
    }
  }, [loading]);

  const onRefresh = useCallback(async () => {
    await loadData();
  }, [loadData]);

  async function handleAction(action: string) {
    if (!actionTarget) return;
    const ev = actionTarget;
    setActionTarget(null);

    switch (action) {
      case "startShopping":
        try {
          invalidateListLoad();
          await startShopping(ev.id);
          invalidateListLoad();
          setCurrentEventId(ev.id);
          patchEventSummary(ev.id, {
            shoppingStartedAt: new Date().toISOString(),
            shoppingEndedAt: null,
          });
        } catch (error: any) {
          Alert.alert("買い物開始エラー", error?.message ?? String(error));
        }
        break;
      case "endShopping":
        try {
          invalidateListLoad();
          await endShopping(ev.id);
          invalidateListLoad();
          patchEventSummary(ev.id, { shoppingEndedAt: new Date().toISOString() });
        } catch (error: any) {
          Alert.alert("買い物終了エラー", error?.message ?? String(error));
        }
        break;
      case "export":
        try {
          setExporting(true);
          const zipPath = await exportEventAsZip(ev.id, (p) =>
            setExportProgress({ ...p }),
          );
          const filename = zipPath.split("/").pop() ?? "export.zip";
          await Sharing.shareAsync(zipPath, {
            mimeType: "application/zip",
            dialogTitle: filename,
          });
        } catch (e: any) {
          Alert.alert("エクスポートエラー", e.message);
        } finally {
          setExporting(false);
          setExportProgress(null);
        }
        break;
      case "syncWithPC":
        setSendToPCTarget(ev);
        sendQrScannedRef.current = false;
        if (!cameraPermission?.granted) {
          const { granted } = await requestCameraPermission();
          if (!granted) {
            Alert.alert(
              "カメラの許可が必要です",
              "QRコードの読み取りにカメラの許可が必要です",
            );
            return;
          }
        }
        setShowSendQRScanner(true);
        break;
      case "reset":
        Alert.alert(
          "全ステータスリセット",
          "全サークルの購入状態を「未購入」に戻しますか？",
          [
            { text: "キャンセル", style: "cancel" },
            {
              text: "リセット",
              style: "destructive",
              onPress: async () => {
                try {
                  invalidateListLoad();
                  await resetAllPurchaseStatus(ev.id);
                  invalidateListLoad();
                  patchEventSummary(ev.id, {
                    boughtCircles: 0,
                    couldntBuyCircles: 0,
                    skippedCircles: 0,
                    remainingCircles: ev.totalCircles,
                    boughtItems: 0,
                    remainingItems: ev.totalItems,
                  });
                } catch (error: any) {
                  Alert.alert("リセットエラー", error?.message ?? String(error));
                }
              },
            },
          ],
        );
        break;
      case "delete":
        Alert.alert(
          "イベント削除",
          `「${ev.name}」を削除しますか？\nサークルデータも全て削除されます。`,
          [
            { text: "キャンセル", style: "cancel" },
            {
              text: "削除",
              style: "destructive",
              onPress: async () => {
                try {
                  invalidateListLoad();
                  await deleteEventWithImages(ev.id);
                  invalidateListLoad();
                  setEvents((previous) => previous.filter((event) => event.id !== ev.id));
                  setActionTarget(null);
                } catch (error: any) {
                  Alert.alert("削除エラー", error?.message ?? String(error));
                }
              },
            },
          ],
        );
        break;
      case "toggleCompleted":
        try {
          invalidateListLoad();
          const completed = await toggleEventCompleted(ev.id);
          invalidateListLoad();
          patchEventSummary(ev.id, { completed });
        } catch (error: any) {
          Alert.alert("完了状態更新エラー", error?.message ?? String(error));
        }
        break;
      case "memo":
        setMemoText(ev.memo || "");
        setMemoTarget(ev);
        break;
      case "eventImage":
        if (ev.eventImageFilename) {
          Alert.alert("イベント画像", "", [
            { text: "キャンセル", style: "cancel" },
            {
              text: "画像を変更",
              onPress: async () => {
                try {
                  invalidateListLoad();
                  const path = await pickAndSaveEventImage(ev.id);
                  if (path) {
                    invalidateListLoad();
                    patchEventSummary(ev.id, { eventImageFilename: path });
                  }
                } catch (error: any) {
                  Alert.alert("画像更新エラー", error?.message ?? String(error));
                }
              },
            },
            {
              text: "画像を削除",
              style: "destructive",
              onPress: async () => {
                try {
                  invalidateListLoad();
                  await removeEventImage(ev.id);
                  invalidateListLoad();
                  patchEventSummary(ev.id, { eventImageFilename: null });
                } catch (error: any) {
                  Alert.alert("画像削除エラー", error?.message ?? String(error));
                }
              },
            },
          ]);
        } else {
          invalidateListLoad();
          const result = await pickAndSaveEventImage(ev.id);
          if (result) {
            invalidateListLoad();
            patchEventSummary(ev.id, { eventImageFilename: result });
          }
        }
        break;
    }
  }

  async function handleSaveMemo() {
    if (!memoTarget) return;
    try {
      invalidateListLoad();
      await updateEventMemo(memoTarget.id, memoText);
      invalidateListLoad();
      patchEventSummary(memoTarget.id, { memo: memoText });
      setMemoTarget(null);
    } catch (error: any) {
      Alert.alert("メモ更新エラー", error?.message ?? String(error));
    }
  }

  // イベント作成
  function handleCreate() {
    setCreateName("");
    setCreateDate("");
    setCreateVenue("");
    setShowCreateModal(true);
  }

  async function handleCreateEvent() {
    const name = createName.trim();
    if (!name) {
      Alert.alert("エラー", "イベント名を入力してください");
      return;
    }
    try {
      invalidateListLoad();
      const eventId = await createEvent(
        name,
        createDate.trim() || null,
        createVenue.trim() || null,
      );
      setShowCreateModal(false);
      setCurrentEventId(eventId);
      invalidateListLoad();
      await loadData();
      router.push(`/event/${eventId}` as any);
    } catch (e: any) {
      Alert.alert("エラー", e.message);
    }
  }

  // インポート
  function handleImport() {
    setShowImportModal(true);
  }

  function closeImportModal() {
    setShowImportModal(false);
    setShowAdvancedImportOptions(false);
  }

  async function doImportZip() {
    closeImportModal();
    try {
      invalidateListLoad();
      setImporting(true);
      const result = await handleImportZip((p) => setImportProgress({ ...p }));
      if (result) await finishImport(result);
    } catch (e: any) {
      Alert.alert("エラー", e.message);
    } finally {
      setImporting(false);
      setImportProgress(null);
    }
  }

  async function doImportQR() {
    closeImportModal();
    if (!cameraPermission?.granted) {
      const perm = await requestCameraPermission();
      if (!perm.granted) {
        Alert.alert("カメラ権限", "QRコードスキャンにはカメラの権限が必要です");
        return;
      }
    }
    qrScannedRef.current = false;
    setShowQRScanner(true);
  }

  async function onQRCodeScanned({ data }: { data: string }) {
    if (qrScannedRef.current) return;
    qrScannedRef.current = true;
    setShowQRScanner(false);

    if (!data.startsWith("http")) {
      Alert.alert("エラー", "QRコードにURLが含まれていません");
      return;
    }

    try {
      invalidateListLoad();
      setImporting(true);
      const result = await handleImportFromQRUrl(data, (p) =>
        setImportProgress({ ...p }),
      );
      await finishImport(result);
    } catch (e: any) {
      Alert.alert("エラー", e.message);
    } finally {
      setImporting(false);
      setImportProgress(null);
    }
  }

  async function onPCSourceQRCode(
    data: string,
    event: EventWithStats,
    sessionUrl: string,
    sessionUid: string,
  ) {
    if (!sessionUid) {
      await notifySingleEventSyncSession(sessionUrl, sessionUid, "cancelled").catch(() => undefined);
      Alert.alert("PCイベント比較", "同期対象UIDがありません。同期を中断しました");
      return;
    }
    let zipPath: string | null = null;
    syncCancelledRef.current = false;
    setSingleSyncBusy(true);
    setImporting(true);
    setSyncMessage("PCの比較ZIPを確認中...");
    setImportProgress({ current: 0, total: 0, phase: "download" });
    try {
      const target = parseSingleEventSyncDownloadUrl(data);
      if (target.targetUid !== sessionUid) {
        throw new Error("QRのPC対象UIDと選択イベントUIDが一致しません");
      }
      zipPath = `${FileSystem.cacheDirectory}pc_single_event_${event.id}_${Date.now()}.zip`;
      let lastProgressAt = Date.now();
      let downloadTooLarge = false;
      let task: ReturnType<typeof FileSystem.createDownloadResumable> | null = null;
      task = FileSystem.createDownloadResumable(
        target.url.toString(),
        zipPath,
        {},
        (progress) => {
          lastProgressAt = Date.now();
          if (progress.totalBytesWritten > 512 * 1024 * 1024) {
            downloadTooLarge = true;
            syncCancelledRef.current = true;
            void task?.cancelAsync().catch(() => undefined);
          }
          setImportProgress({
            current: progress.totalBytesWritten,
            total: Math.max(progress.totalBytesExpectedToWrite, 0),
            phase: "download",
          });
        },
      );
      activeSyncNetworkTaskRef.current = task;
      const timeout = setTimeout(() => {
        syncCancelledRef.current = true;
        void task?.cancelAsync().catch(() => undefined);
      }, PC_SYNC_TIMEOUT_MS);
      let result;
      try {
        result = await task.downloadAsync();
      } finally {
        clearTimeout(timeout);
        if (activeSyncNetworkTaskRef.current === task) activeSyncNetworkTaskRef.current = null;
      }
      if (downloadTooLarge) throw new Error("PC同期ZIPのサイズが上限512MBを超えています");
      if (syncCancelledRef.current) {
        throw new Error(`PC ZIPの受信を中断しました${Date.now() - lastProgressAt > PC_SYNC_TIMEOUT_MS ? "（タイムアウト）" : ""}`);
      }
      if (!result || result.status !== 200) {
        throw new Error(`PC ZIPのダウンロードに失敗しました: HTTP ${result?.status ?? "応答なし"}`);
      }
      setSyncMessage("イベント差分を確認中...");
      setImportProgress({ current: 0, total: 1, phase: "events" });
      const preview = await previewSingleEventSyncZip(zipPath, event.id, sessionUid);
      if (syncCancelledRef.current) throw new Error("PCイベント比較を中断しました");
      setPendingSingleEventSync({ event, zipPath, preview, sessionUrl });
      setSingleSyncSourceSelected(false);
      zipPath = null;
    } catch (error: any) {
      if (zipPath) await FileSystem.deleteAsync(zipPath, { idempotent: true }).catch(() => undefined);
      const originalMessage = redactSyncText(error?.message ?? String(error));
      let cancelMessage = "";
      try {
        await notifySingleEventSyncSession(sessionUrl, sessionUid, "cancelled");
      } catch (cancelError: any) {
        cancelMessage = `\n同期終了通知にも失敗しました: ${redactSyncText(cancelError?.message ?? String(cancelError))}`;
        console.warn("PCイベント同期のcancel通知に失敗しました", redactSyncText(cancelError?.message ?? String(cancelError)));
      }
      Alert.alert(
        syncCancelledRef.current ? "比較を中断しました" : "PCイベント比較エラー",
        `${originalMessage}${cancelMessage}`,
      );
    } finally {
      activeSyncNetworkTaskRef.current = null;
      setSingleSyncBusy(false);
      setImporting(false);
      setImportProgress(null);
      setSyncMessage(null);
      syncCancelledRef.current = false;
    }
  }

  function cancelSingleSyncOperation() {
    if (!singleSyncBusy) return;
    syncCancelledRef.current = true;
    const task = activeSyncNetworkTaskRef.current;
    if (task) void task.cancelAsync().catch(() => undefined);
  }

  async function cancelPendingSingleEventSync() {
    const pending = pendingSingleEventSync;
    setPendingSingleEventSync(null);
    setSingleSyncSourceSelected(false);
    if (pending) {
      await notifySingleEventSyncSession(pending.sessionUrl, pending.preview.eventUid, "cancelled")
        .catch(() => undefined);
      await FileSystem.deleteAsync(pending.zipPath, { idempotent: true }).catch(() => undefined);
    }
  }

  async function applyPendingSingleEventSync() {
    const pending = pendingSingleEventSync;
    if (!pending || !singleSyncSourceSelected) return;
    const { event, zipPath, preview, sessionUrl } = pending;
    const confirmed = await new Promise<boolean>((resolve) => {
      Alert.alert(
        "PCデータを反映",
        `「${event.name}」のmobile内容をバックアップし、PCの内容で置き換えます。差分は対象イベントUIDの1件に限られます。反映を開始しますか？`,
        [
          { text: "戻る", style: "cancel", onPress: () => resolve(false) },
          { text: "バックアップ後に反映", style: "destructive", onPress: () => resolve(true) },
        ],
      );
    });
    if (!confirmed) return;

    setPendingSingleEventSync(null);
    syncCancelledRef.current = false;
    setSingleSyncBusy(true);
    setImporting(true);
    setSyncMessage("イベントバックアップを作成中...");
    setImportProgress({ current: 0, total: 1, phase: "events" });
    invalidateListLoad();
    try {
      const result = await applySingleEventSyncZip(
        zipPath,
        event.id,
        preview.eventUid,
        preview.revision,
        (progress) => {
          if (syncCancelledRef.current) throw new Error("イベント同期を中断しました");
          setImportProgress({ ...progress });
          setSyncMessage(progress.phase === "circles" ? "サークル・頒布物を反映中..." : "イベントを安全に反映中...");
        },
        () => syncCancelledRef.current,
      );
      if (syncCancelledRef.current) throw new Error("イベント同期を中断しました");
      setCurrentEventId(result.eventId);
      invalidateListLoad();
      await loadData();
      const diff = result.diff;
      let completionNotice = "";
      try {
        await notifySingleEventSyncSession(sessionUrl, preview.eventUid, "mobile-applied");
      } catch (notifyError: any) {
        completionNotice = `\nPC側への完了通知に失敗しました: ${redactSyncText(notifyError?.message ?? String(notifyError))}`;
      }
      Alert.alert(
        completionNotice ? "PCイベントを反映しました（通知要確認）" : "PCイベントを反映しました",
        `${event.name}\nイベントバックアップ: ${result.backupPath}\n追加 ${diff.addedEventIds.length} / 更新 ${diff.changedEventIds.length} / 変更なし ${diff.unchangedEventIds.length}${completionNotice}`,
      );
    } catch (error: any) {
      await notifySingleEventSyncSession(sessionUrl, preview.eventUid, "cancelled").catch(() => undefined);
      invalidateListLoad();
      await loadData();
      Alert.alert(syncCancelledRef.current ? "同期を中断しました" : "同期エラー", error?.message ?? String(error));
    } finally {
      activeSyncNetworkTaskRef.current = null;
      await FileSystem.deleteAsync(zipPath, { idempotent: true }).catch(() => undefined);
      syncCancelledRef.current = false;
      setSingleSyncBusy(false);
      setImporting(false);
      setImportProgress(null);
      setSyncMessage(null);
      setSingleSyncSourceSelected(false);
    }
  }

  async function finishImport(result: ImportRunResult) {
    // Full-sync changed rows keep their live IDs and unchanged rows add no
    // rows, so focus the actual diff target rather than relying on the
    // importer's last/staged ID. Removed-only syncs do not point at a stale row.
    const focusEventId =
      result.addedEventIds[0] ??
      result.changedEventIds[0] ??
      result.unchangedEventIds[0] ??
      null;
    setCurrentEventId(focusEventId);
    invalidateListLoad();
    await loadData();
    const summary = result.summary;
    if (result.isFullSync) {
      Alert.alert(
        "全イベント同期完了",
        `${result.eventCount}件のイベントを同期しました\n` +
          `追加 ${result.addedEventIds.length}件 / ` +
          `更新 ${result.changedEventIds.length}件 / ` +
          `変更なし ${result.unchangedEventIds.length}件 / ` +
          `削除 ${result.removedEventIds.length}件`,
      );
      return;
    }
    Alert.alert(
      "インポート完了",
      `${summary.eventName}\n${summary.circleCount}サークル / ${summary.mapCount}マップ / ${summary.itemCount}頒布物\n` +
        `追加 ${result.addedEventIds.length}件 / 更新 ${result.changedEventIds.length}件`,
    );
  }

  // PCと同期: 初回QRスキャン→ZIPアップロード→同一セッション継続
  async function onSendQRCodeScanned({ data }: { data: string }) {
    if (sendQrScannedRef.current) return;
    sendQrScannedRef.current = true;
    setShowSendQRScanner(false);

    const ev = sendToPCTarget;
    if (!ev) return;
    setSendToPCTarget(null);

    let syncLogPath: string | null = null;
    let zipPath: string | null = null;
    let syncSessionUrl: string | null = null;
    let syncSessionUid: string | null = null;
    let terminalSessionConsumed = false;
    let userCancelled = false;
    syncCancelledRef.current = false;
    setSingleSyncBusy(true);
    try {
      const target = parseSingleEventSyncUploadUrl(data);
      syncSessionUrl = target.url.toString();
      syncSessionUid = target.targetUid;
      const identityAction = resolveSingleEventSyncIdentity({
        selectedUid: ev.syncUid,
        targetUid: target.targetUid,
        selectedName: ev.name,
        selectedDate: ev.date,
        targetName: target.targetName,
        targetDate: target.targetDate,
      });
      const pairedUid = resolveSingleEventSyncUid({
        selectedUid: ev.syncUid,
        targetUid: target.targetUid,
        identityAction,
      });
      if (identityAction === "link-required") {
        const confirmed = await new Promise<boolean>((resolve) => {
          Alert.alert(
            "PCイベントとのペアリング",
            `選択イベント「${ev.name}」をPCの「${target.targetName}」に紐づけます。イベント内容はまだ送信・上書きされません。UIDを登録して続けますか？\n\n${PC_SYNC_NETWORK_WARNING}`,
            [
              { text: "キャンセル", style: "cancel", onPress: () => resolve(false) },
              { text: "UIDを紐づける", onPress: () => resolve(true) },
            ],
          );
        });
        if (!confirmed) {
          userCancelled = true;
          syncCancelledRef.current = true;
          throw new Error("PCイベント同期を中断しました");
        }
        await linkEventSyncUidForPairing(
          ev.id,
          target.targetUid,
          target.targetName as string,
          target.targetDate as string,
        );
        // Pairing is now committed in SQLite. Keep the in-flight event
        // snapshot aligned so the same session can continue into the PC ZIP
        // preview without treating the legacy null UID as a mismatch.
        ev.syncUid = pairedUid;
        patchEventSummary(ev.id, { syncUid: pairedUid });
      }
      const sendConfirmed = await new Promise<boolean>((resolve) => {
        Alert.alert(
          "比較データをPCへ送信",
          `「${ev.name}」のデータをUID ${target.targetUid} のPCへ送ります。PC側のプレビューで確認し、mobileを正として確定するまでPCのデータは変更されません。\n\n${PC_SYNC_NETWORK_WARNING}`,
          [
            { text: "キャンセル", style: "cancel", onPress: () => resolve(false) },
            { text: "送信", onPress: () => resolve(true) },
          ],
        );
      });
      if (!sendConfirmed) {
        userCancelled = true;
        syncCancelledRef.current = true;
        throw new Error("PCイベント同期を中断しました");
      }
      setExporting(true);
      setSyncMessage("同期ログを作成中...");
      syncLogPath = await createSyncLog("send-to-pc", {
        eventId: ev.id,
        eventName: ev.name,
        targetUrl: redactSyncUrl(data),
        platform: Platform.OS,
      });
      setLastSyncLogPath(syncLogPath);
      await appendSyncLog(syncLogPath, "QR scanned");

      setSyncMessage("ZIPを作成中...");
      setExportProgress({ current: 0, total: 1, phase: "images" });
      zipPath = await exportEventAsZip(
        ev.id,
        (p) => {
          if (syncCancelledRef.current) throw new Error("イベント送信を中断しました");
          setExportProgress({ ...p });
        },
        { includeSharedSettings: false },
      );
      if (syncCancelledRef.current) throw new Error("イベント送信を中断しました");
      const zipSize = await getFileSize(zipPath);
      await appendSyncLog(syncLogPath, "ZIP created", { zipPath, zipSize });

      setSyncMessage("PCへZIPを送信中...");
      setExportProgress({ current: 0, total: 1, phase: "zip" });

      setSyncMessage("PCへ送信中...");
      const uploadTask = FileSystem.createUploadTask(target.url.toString(), zipPath, {
        httpMethod: "POST",
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        headers: { "Content-Type": "application/octet-stream" },
      });
      activeSyncNetworkTaskRef.current = uploadTask;
      const uploadTimeout = setTimeout(() => {
        syncCancelledRef.current = true;
        void uploadTask.cancelAsync().catch(() => undefined);
      }, PC_SYNC_TIMEOUT_MS);
      let uploadResult;
      try {
        uploadResult = await uploadTask.uploadAsync();
      } finally {
        clearTimeout(uploadTimeout);
        if (activeSyncNetworkTaskRef.current === uploadTask) activeSyncNetworkTaskRef.current = null;
      }
      if (syncCancelledRef.current || !uploadResult) throw new Error("PCへの送信を中断しました");

      const responseText = uploadResult.body;
      const responseOk = uploadResult.status >= 200 && uploadResult.status < 300;
      await appendSyncLog(syncLogPath, "PC response received", {
        status: uploadResult.status,
        ok: responseOk,
        body: redactSyncText(responseText).slice(0, 2000),
      });

      if (!responseOk) {
        throw new Error(`PCへの送信に失敗しました: HTTP ${uploadResult.status}`);
      }
      const sessionResponse = parseSingleEventSyncSessionResponse(responseText, target.targetUid);
      if (sessionResponse.state === "pending") {
        setExporting(false);
        setExportProgress(null);
        setImporting(true);
        setImportProgress({ current: 0, total: 0, phase: "download" });
        setSyncMessage("PC側の差分確認と採用結果を待っています...");
        const decision = await pollSingleEventSyncSession(
          target.url.toString(),
          target.targetUid,
          () => syncCancelledRef.current,
          () => setSyncMessage("PC側の差分確認と採用結果を待っています..."),
        );
        terminalSessionConsumed = decision.state === "cancelled" ||
          decision.state === "error" || decision.state === "mobile-applied";
        if (decision.state === "pc-ready" && decision.downloadUrl) {
          await appendSyncLog(syncLogPath, "PC selected; receiving same-session ZIP", {
            targetUid: target.targetUid,
          });
          await onPCSourceQRCode(decision.downloadUrl, ev, target.url.toString(), target.targetUid);
          return;
        }
        if (decision.state === "mobile-applied") {
          setSyncMessage("mobile側を正としてPCへ反映しました");
          Alert.alert("PCへ反映しました", `「${ev.name}」のmobileデータをPC側へ反映しました。`);
          return;
        }
        if (decision.state === "cancelled") {
          throw new Error(decision.message ?? "PC側で同期がキャンセルされました");
        }
        throw new Error(decision.message ?? "PC側から同期結果を受け取れませんでした");
      }
      if (sessionResponse.state === "pc-ready") {
        if (!sessionResponse.downloadUrl) {
          throw new Error("PC側を正とするZIPの受信URLがありません");
        }
        setExporting(false);
        setExportProgress(null);
        await appendSyncLog(syncLogPath, "PC selected; receiving same-session ZIP", {
          targetUid: target.targetUid,
        });
        await onPCSourceQRCode(sessionResponse.downloadUrl, ev, target.url.toString(), target.targetUid);
        return;
      }
      if (sessionResponse.state === "mobile-applied") {
        setSyncMessage("mobile側を正としてPCへ反映しました");
        Alert.alert("PCへ反映しました", `「${ev.name}」のmobileデータをPC側へ反映しました。`);
        return;
      }
      if (sessionResponse.state === "cancelled" || sessionResponse.state === "error") {
        throw new Error(sessionResponse.message ?? "PC側で同期が中断されました");
      }
      // Older desktop versions return only {status:"ok"} after they finish
      // the upload. Keep that path informational, while newer versions use
      // the same session response above to deliver the PC ZIP automatically.
      setSyncMessage("PCへ比較データを送信しました");
      await appendSyncLog(syncLogPath, "single-event data staged for desktop preview", {
        targetUid: target.targetUid,
        status: uploadResult.status,
      });
      Alert.alert(
        "PCへ送信しました",
        "PC側で差分を確認し、採用結果がこの接続へ返るまでお待ちください。",
        [
          { text: "OK" },
          {
            text: "ログ共有",
            onPress: () => {
              shareSyncLog(syncLogPath);
            },
          },
        ],
      );
    } catch (e: any) {
      let terminalWarning = "";
      if (!terminalSessionConsumed && syncSessionUrl && syncSessionUid) {
        terminalWarning = await cancelSingleEventSyncSessionBestEffort(
          syncSessionUrl,
          syncSessionUid,
        ).then((warning) => warning ? `\n${warning}` : "");
        terminalSessionConsumed = true;
      }
      const originalMessage = redactSyncText(e?.message ?? String(e));
      await appendSyncLog(syncLogPath, userCancelled ? "sync cancelled" : "sync failed", {
        message: `${originalMessage}${terminalWarning}`,
        stack: redactSyncText(e?.stack ?? ""),
      });
      if (!userCancelled) {
        Alert.alert(syncCancelledRef.current ? "送信を中断しました" : "送信エラー", `${originalMessage}${terminalWarning}`, [
          { text: "OK" },
          {
            text: "ログ共有",
            onPress: () => {
              shareSyncLog(syncLogPath);
            },
          },
        ]);
      } else if (terminalWarning) {
        Alert.alert(
          "送信を中断しました",
          `PC側へのキャンセル通知を確認できませんでした。PC側の状態を確認してから再試行してください。${terminalWarning}`,
          [{ text: "OK" }],
        );
      }
    } finally {
      activeSyncNetworkTaskRef.current = null;
      if (zipPath) await FileSystem.deleteAsync(zipPath, { idempotent: true }).catch(() => undefined);
      syncCancelledRef.current = false;
      setSingleSyncBusy(false);
      setExporting(false);
      setExportProgress(null);
      setSyncMessage(null);
    }
  }

  const handleEventPress = useCallback((event: EventWithStats) => {
    setCurrentEventId(event.id);
    router.push(`/event/${event.id}` as any);
  }, [router, setCurrentEventId]);

  const handleEventLongPress = useCallback((event: EventWithStats) => {
    setActionTarget(event);
  }, []);

  const renderEventItem = useCallback(({ item }: { item: EventWithStats }) => (
    <EventCard
      event={item}
      colorScheme={effectiveScheme}
      onPress={handleEventPress}
      onLongPress={handleEventLongPress}
    />
  ), [effectiveScheme, handleEventPress, handleEventLongPress]);
  if (loading && events.length === 0) {
    return (
      <ScreenSafeArea
        style={[styles.safeArea, { backgroundColor: colors.background }]}
      >
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.tint} />
          <Text style={[styles.loadingText, { color: colors.textSecondary }]}>
            読み込み中...
          </Text>
        </View>
      </ScreenSafeArea>
    );
  }

  return (
    <ScreenSafeArea
      style={[styles.safeArea, { backgroundColor: colors.background }]}
    >
      <StatusBar
        barStyle={effectiveScheme === "dark" ? "light-content" : "dark-content"}
        backgroundColor="transparent"
        translucent
      />
      <View style={{ flex: 1 }}>
        {loadError && (
          <View style={styles.loadError} accessibilityRole="alert">
            <Text style={{ color: colors.text }}>イベントを読み込めませんでした</Text>
            <Text style={{ color: colors.textSecondary }}>
              {events.length > 0
                ? "前回読み込んだ一覧を表示しています。"
                : "データがないとは限りません。再読み込みしてください。"}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="イベント一覧を再読み込み"
              disabled={loading}
              onPress={() => { void loadData(); }}
              style={[styles.emptyImportBtn, { backgroundColor: colors.tint }]}
            >
              <Text style={styles.emptyImportBtnText}>再読み込み</Text>
            </Pressable>
          </View>
        )}
        <FlatList
          data={sortedEvents}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderEventItem}
          ListHeaderComponent={
            <>
            <View style={styles.listHeader}>
              <Text style={[styles.headerTitle, { color: colors.text }]}>
                イベント
              </Text>
              <View style={styles.headerButtons}>
                <Pressable
                  style={[styles.createBtn, { borderColor: colors.tint }]}
                  onPress={handleCreate}
                >
                  <FontAwesome name="pencil" size={13} color={colors.tint} />
                  <Text style={[styles.createBtnText, { color: colors.tint }]}>
                    作成
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.importBtn, { backgroundColor: colors.tint }]}
                  onPress={handleImport}
                >
                  <FontAwesome name="plus" size={13} color="#fff" />
                  <Text style={styles.importBtnText}>インポート</Text>
                </Pressable>
              </View>
            </View>
            <View style={styles.sortRow}>
              {EVENT_SORT_OPTIONS.map((option) => {
                const selected = eventSortKey === option.key;
                return (
                  <Pressable
                    key={option.key}
                    style={[
                      styles.sortChip,
                      { borderColor: colors.border },
                      selected && {
                        backgroundColor: colors.tint,
                        borderColor: colors.tint,
                      },
                    ]}
                    onPress={() => setEventSortKey(option.key)}
                  >
                    <Text
                      style={[
                        styles.sortChipText,
                        { color: colors.textSecondary },
                        selected && { color: "#fff" },
                      ]}
                    >
                      {option.label}
                    </Text>
                  </Pressable>
                );
              })}
              <Pressable
                style={[
                  styles.sortDirectionBtn,
                  { borderColor: colors.border },
                ]}
                onPress={() =>
                  setEventSortDirection((current) =>
                    current === "desc" ? "asc" : "desc",
                  )
                }
              >
                <FontAwesome
                  name={
                    eventSortDirection === "desc"
                      ? "sort-amount-desc"
                      : "sort-amount-asc"
                  }
                  size={13}
                  color={colors.textSecondary}
                />
                <Text
                  style={[
                    styles.sortChipText,
                    { color: colors.textSecondary },
                  ]}
                >
                  {eventSortDirection === "desc" ? "降順" : "昇順"}
                </Text>
              </Pressable>
            </View>
            </>
          }
          ListEmptyComponent={hasLoaded && !loading && !loadError ? (
            <View style={styles.emptyContainer}>
              <Text style={[styles.emptyTitle, { color: colors.text }]}>
                イベントデータがありません
              </Text>
              <Text style={[styles.emptyDesc, { color: colors.textSecondary }]}>
                「+インポート」からデータを取り込んでください
              </Text>
              <Pressable
                style={[
                  styles.emptyImportBtn,
                  { backgroundColor: colors.tint },
                ]}
                onPress={handleImport}
              >
                <Text style={styles.emptyImportBtnText}>
                  データをインポート
                </Text>
              </Pressable>
            </View>
          ) : null}
          refreshControl={
            <RefreshControl
              refreshing={loading && events.length > 0}
              onRefresh={onRefresh}
              tintColor={colors.tint}
            />
          }
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          updateCellsBatchingPeriod={40}
          windowSize={5}
          removeClippedSubviews
        />

      </View>

      {/* インポート方法選択モーダル (外タップで閉じる) */}
      <Modal
        visible={showImportModal}
        transparent
        animationType="fade"
        onRequestClose={closeImportModal}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={closeImportModal}
        >
          <View
            style={[styles.modalCard, { backgroundColor: colors.card }]}
            onStartShouldSetResponder={() => true}
          >
            <Text style={[styles.modalTitle, { color: colors.text }]}>
              データインポート
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="高度な操作・バックアップ"
              accessibilityState={{ expanded: showAdvancedImportOptions }}
              style={[styles.modalOption, { borderBottomColor: colors.border }]}
              onPress={() => setShowAdvancedImportOptions((expanded) => !expanded)}
            >
              <FontAwesome
                name={showAdvancedImportOptions ? "chevron-down" : "chevron-right"}
                size={14}
                color={colors.tint}
              />
              <Text style={[styles.modalOptionText, { color: colors.text }]}>
                高度な操作・バックアップ
              </Text>
            </Pressable>
            {showAdvancedImportOptions && (
              <View style={styles.advancedImportOptions}>
                <Text style={[styles.advancedImportHint, { color: colors.textSecondary }]}>
                  旧形式のQR取り込みと手動バックアップZIPを使います。
                </Text>
                <Pressable
                  accessibilityRole="button"
                  style={[styles.modalOption, { borderBottomColor: colors.border }]}
                  onPress={doImportZip}
                >
                  <FontAwesome
                    name="file-archive-o"
                    size={18}
                    color={colors.tint}
                  />
                  <Text style={[styles.modalOptionText, { color: colors.text }]}>
                    手動ZIPを取り込む
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  style={[styles.modalOption, { borderBottomColor: "transparent" }]}
                  onPress={doImportQR}
                >
                  <FontAwesome name="qrcode" size={18} color={colors.tint} />
                  <Text style={[styles.modalOptionText, { color: colors.text }]}>
                    旧QRから取り込む
                  </Text>
                </Pressable>
              </View>
            )}
            <Pressable
              style={styles.modalCancel}
              onPress={closeImportModal}
            >
              <Text
                style={[
                  styles.modalCancelText,
                  { color: colors.textSecondary },
                ]}
              >
                キャンセル
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* イベント長押しアクションモーダル */}
      <Modal
        visible={actionTarget !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setActionTarget(null)}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setActionTarget(null)}
        >
          <View
            style={[styles.modalCard, { backgroundColor: colors.card }]}
            onStartShouldSetResponder={() => true}
          >
            <Text style={[styles.modalTitle, { color: colors.text }]}>
              {actionTarget?.name}
            </Text>
            {actionTarget?.date && (
              <Text
                style={[styles.actionDate, { color: colors.textSecondary }]}
              >
                {actionTarget.date}
              </Text>
            )}
            {actionTarget?.shoppingStartedAt != null &&
            actionTarget?.shoppingEndedAt == null ? (
              <Pressable
                style={[
                  styles.modalOption,
                  { borderBottomColor: colors.border },
                ]}
                onPress={() => handleAction("endShopping")}
              >
                <FontAwesome name="stop-circle" size={18} color="#c62828" />
                <Text style={[styles.modalOptionText, { color: "#c62828" }]}>
                  買い物を終了する
                </Text>
              </Pressable>
            ) : (
              <Pressable
                style={[
                  styles.modalOption,
                  { borderBottomColor: colors.border },
                ]}
                onPress={() => handleAction("startShopping")}
              >
                <FontAwesome name="shopping-cart" size={18} color="#2e7d32" />
                <Text style={[styles.modalOptionText, { color: "#2e7d32" }]}>
                  買い物を開始する
                </Text>
              </Pressable>
            )}
            <Pressable
              style={[styles.modalOption, { borderBottomColor: colors.border }]}
              onPress={() => handleAction("export")}
            >
              <FontAwesome
                name="share-square-o"
                size={18}
                color={colors.tint}
              />
              <Text style={[styles.modalOptionText, { color: colors.text }]}>
                データをエクスポート
              </Text>
            </Pressable>
            <Pressable
              style={[styles.modalOption, { borderBottomColor: colors.border }]}
              onPress={() => handleAction("syncWithPC")}
            >
              <FontAwesome name="desktop" size={18} color={colors.tint} />
              <Text style={[styles.modalOptionText, { color: colors.text }]}>
                PCと同期
              </Text>
            </Pressable>
            <Pressable
              style={[styles.modalOption, { borderBottomColor: colors.border }]}
              onPress={() => handleAction("toggleCompleted")}
            >
              <FontAwesome
                name={actionTarget?.completed ? "square-o" : "check-square"}
                size={18}
                color={
                  actionTarget?.completed ? colors.textSecondary : "#2e7d32"
                }
              />
              <Text style={[styles.modalOptionText, { color: colors.text }]}>
                {actionTarget?.completed ? "完了を解除" : "完了にする"}
              </Text>
            </Pressable>
            <Pressable
              style={[styles.modalOption, { borderBottomColor: colors.border }]}
              onPress={() => handleAction("eventImage")}
            >
              <FontAwesome name="picture-o" size={18} color={colors.tint} />
              <Text style={[styles.modalOptionText, { color: colors.text }]}>
                {actionTarget?.eventImageFilename
                  ? "イベント画像を変更"
                  : "イベント画像を設定"}
              </Text>
            </Pressable>
            <Pressable
              style={[styles.modalOption, { borderBottomColor: colors.border }]}
              onPress={() => handleAction("memo")}
            >
              <FontAwesome name="sticky-note" size={18} color={colors.tint} />
              <Text style={[styles.modalOptionText, { color: colors.text }]}>
                メモ
              </Text>
            </Pressable>
            <Pressable
              style={[styles.modalOption, { borderBottomColor: colors.border }]}
              onPress={() => handleAction("reset")}
            >
              <FontAwesome name="refresh" size={18} color="#f57f17" />
              <Text style={[styles.modalOptionText, { color: colors.text }]}>
                全ステータスリセット
              </Text>
            </Pressable>
            <Pressable
              style={[styles.modalOption, { borderBottomColor: "transparent" }]}
              onPress={() => handleAction("delete")}
            >
              <FontAwesome name="trash" size={18} color="#c62828" />
              <Text style={[styles.modalOptionText, { color: "#c62828" }]}>
                削除
              </Text>
            </Pressable>
            <Pressable
              style={styles.modalCancel}
              onPress={() => setActionTarget(null)}
            >
              <Text
                style={[
                  styles.modalCancelText,
                  { color: colors.textSecondary },
                ]}
              >
                キャンセル
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* PC ZIP差分の確認とソース選択 */}
      <Modal
        visible={pendingSingleEventSync !== null}
        transparent
        animationType="fade"
        onRequestClose={() => void cancelPendingSingleEventSync()}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={() => void cancelPendingSingleEventSync()}
        >
          <InputScrollView
            style={{ width: "100%", flexGrow: 0, maxHeight: "100%" }}
            contentContainerStyle={{ alignItems: "center" }}
          >
            <View
              style={[styles.syncPreviewCard, { backgroundColor: colors.card }]}
              onStartShouldSetResponder={() => true}
            >
              <Text style={[styles.modalTitle, { color: colors.text }]}>
                イベント差分プレビュー
              </Text>
              {pendingSingleEventSync && (
                <>
                  <Text style={[styles.syncPreviewEvent, { color: colors.text }]}>
                    {pendingSingleEventSync.event.name}
                  </Text>
                  <Text style={[styles.syncPreviewUid, { color: colors.textSecondary }]}>
                    UID: {pendingSingleEventSync.preview.eventUid}
                  </Text>
                  <Text style={[styles.syncPreviewWarning, { color: colors.text }]}>
                    反映先はこのイベント1件だけです。ほかのイベントと共有設定は変更しません。
                    {"\n"}{PC_SYNC_NETWORK_WARNING}
                  </Text>
                  <Pressable
                    style={[
                      styles.syncSourceOption,
                      {
                        borderColor: singleSyncSourceSelected ? colors.tint : colors.border,
                        backgroundColor: singleSyncSourceSelected ? `${colors.tint}18` : colors.background,
                      },
                    ]}
                    onPress={() => setSingleSyncSourceSelected(true)}
                  >
                    <FontAwesome
                      name={singleSyncSourceSelected ? "check-circle" : "circle-o"}
                      size={20}
                      color={singleSyncSourceSelected ? colors.tint : colors.textSecondary}
                    />
                    <Text style={[styles.syncSourceText, { color: colors.text }]}>
                      PC側を正として反映する
                    </Text>
                  </Pressable>
                  <Text
                    selectable
                    style={[styles.syncDiffText, { color: colors.textSecondary }]}
                  >
                    {formatSingleEventSyncDiff(pendingSingleEventSync.preview)}
                  </Text>
                  <View style={styles.memoButtons}>
                    <Pressable
                      style={[styles.memoBtn, { borderColor: colors.border }]}
                      onPress={() => void cancelPendingSingleEventSync()}
                    >
                      <Text style={{ color: colors.textSecondary }}>キャンセル</Text>
                    </Pressable>
                    <Pressable
                      style={[
                        styles.memoBtn,
                        { backgroundColor: singleSyncSourceSelected ? colors.tint : colors.border },
                      ]}
                      disabled={!singleSyncSourceSelected}
                      onPress={() => void applyPendingSingleEventSync()}
                    >
                      <Text style={{ color: "#fff", fontWeight: "600" }}>確認して適用</Text>
                    </Pressable>
                  </View>
                </>
              )}
            </View>
          </InputScrollView>
        </Pressable>
      </Modal>

      {/* イベントメモ編集モーダル */}
      <InputModal
        visible={memoTarget !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setMemoTarget(null)}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setMemoTarget(null)}
        >
          <InputScrollView style={{ width: '100%', flexGrow: 0, maxHeight: '100%' }} contentContainerStyle={{ alignItems: 'center' }}>
          <View
            style={[styles.modalCard, { backgroundColor: colors.card }]}
            onStartShouldSetResponder={() => true}
          >
            <Text style={[styles.modalTitle, { color: colors.text }]}>
              イベントメモ
            </Text>
            <TextInput
              style={[
                styles.memoInput,
                {
                  color: colors.text,
                  borderColor: colors.border,
                  backgroundColor: colors.background,
                },
              ]}
              value={memoText}
              onChangeText={setMemoText}
              multiline
              placeholder="イベントに関するメモ（会場情報、持ち物など）"
              placeholderTextColor={colors.textSecondary}
              autoFocus
            />
            <View style={styles.memoButtons}>
              <Pressable
                style={[styles.memoBtn, { borderColor: colors.border }]}
                onPress={() => setMemoTarget(null)}
              >
                <Text style={{ color: colors.textSecondary }}>キャンセル</Text>
              </Pressable>
              <Pressable
                style={[styles.memoBtn, { backgroundColor: colors.tint }]}
                onPress={handleSaveMemo}
              >
                <Text style={{ color: "#fff", fontWeight: "600" }}>保存</Text>
              </Pressable>
            </View>
          </View>
          </InputScrollView>
        </Pressable>
      </InputModal>

      {/* イベント作成モーダル */}
      <InputModal
        visible={showCreateModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowCreateModal(false)}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setShowCreateModal(false)}
        >
          <InputScrollView style={{ width: '100%', flexGrow: 0, maxHeight: '100%' }} contentContainerStyle={{ alignItems: 'center' }}>
          <View
            style={[styles.modalCard, { backgroundColor: colors.card }]}
            onStartShouldSetResponder={() => true}
          >
            <Text style={[styles.modalTitle, { color: colors.text }]}>
              イベント作成
            </Text>
            <View style={styles.createFormGroup}>
              <Text
                style={[styles.createLabel, { color: colors.textSecondary }]}
              >
                イベント名 *
              </Text>
              <TextInput
                style={[
                  styles.createInput,
                  {
                    color: colors.text,
                    borderColor: colors.border,
                    backgroundColor: colors.background,
                  },
                ]}
                value={createName}
                onChangeText={setCreateName}
                placeholder="例: コミックマーケット C105"
                placeholderTextColor={colors.textSecondary}
                autoFocus
              />
            </View>
            <View style={styles.createFormGroup}>
              <Text
                style={[styles.createLabel, { color: colors.textSecondary }]}
              >
                開催日
              </Text>
              <TextInput
                style={[
                  styles.createInput,
                  {
                    color: colors.text,
                    borderColor: colors.border,
                    backgroundColor: colors.background,
                  },
                ]}
                value={createDate}
                onChangeText={setCreateDate}
                placeholder="例: 2026-08-15"
                placeholderTextColor={colors.textSecondary}
              />
            </View>
            <View style={styles.createFormGroup}>
              <Text
                style={[styles.createLabel, { color: colors.textSecondary }]}
              >
                会場
              </Text>
              <TextInput
                style={[
                  styles.createInput,
                  {
                    color: colors.text,
                    borderColor: colors.border,
                    backgroundColor: colors.background,
                  },
                ]}
                value={createVenue}
                onChangeText={setCreateVenue}
                placeholder="例: 東京ビッグサイト"
                placeholderTextColor={colors.textSecondary}
              />
            </View>
            <View style={styles.memoButtons}>
              <Pressable
                style={[styles.memoBtn, { borderColor: colors.border }]}
                onPress={() => setShowCreateModal(false)}
              >
                <Text style={{ color: colors.textSecondary }}>キャンセル</Text>
              </Pressable>
              <Pressable
                style={[styles.memoBtn, { backgroundColor: colors.tint }]}
                onPress={handleCreateEvent}
              >
                <Text style={{ color: "#fff", fontWeight: "600" }}>作成</Text>
              </Pressable>
            </View>
          </View>
          </InputScrollView>
        </Pressable>
      </InputModal>

      {/* QRスキャナーモーダル */}
      <Modal
        visible={showQRScanner}
        animationType="slide"
        onRequestClose={() => {
          setShowQRScanner(false);
        }}
      >
        <View style={styles.qrContainer}>
          <CameraView
            style={styles.qrCamera}
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={onQRCodeScanned}
          />
          <View style={styles.qrOverlay}>
            <Text style={styles.qrText}>
              QRコードをスキャンしてください
            </Text>
            <Pressable
              style={styles.qrCloseBtn}
              onPress={() => {
                setShowQRScanner(false);
              }}
            >
              <Text style={styles.qrCloseBtnText}>閉じる</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* PCと同期するための初回QRスキャナーモーダル */}
      <Modal
        visible={showSendQRScanner}
        animationType="slide"
        onRequestClose={() => setShowSendQRScanner(false)}
      >
        <View style={styles.qrContainer}>
          <CameraView
            style={styles.qrCamera}
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={onSendQRCodeScanned}
          />
          <View style={styles.qrOverlay}>
            <Text style={styles.qrText}>PCの「モバイルと同期」QRをスキャン</Text>
            <Text style={styles.qrWarningText}>
              {PC_SYNC_NETWORK_WARNING}
            </Text>
            <Pressable
              style={styles.qrCloseBtn}
              onPress={() => {
                setShowSendQRScanner(false);
                setSendToPCTarget(null);
              }}
            >
              <Text style={styles.qrCloseBtnText}>閉じる</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* インポート中オーバーレイ */}
      {importing && (
        <View style={styles.importOverlay}>
          <View style={[styles.importCard, { backgroundColor: colors.card }]}>
            <ActivityIndicator size="large" color={colors.tint} />
            <Text style={[styles.importText, { color: colors.text }]}>
              {syncMessage ?? "インポート中..."}
            </Text>
            {importProgress && (
              <Text
                style={[
                  styles.importProgressText,
                  { color: colors.textSecondary },
                ]}
              >
                {formatImportProgress(importProgress)}
              </Text>
            )}
            {singleSyncBusy && (
              <Pressable style={styles.syncCancelBtn} onPress={cancelSingleSyncOperation}>
                <Text style={styles.syncCancelBtnText}>中断</Text>
              </Pressable>
            )}
          </View>
        </View>
      )}

      {/* エクスポート/送信中オーバーレイ */}
      {exporting && (
        <View style={styles.importOverlay}>
          <View style={[styles.importCard, { backgroundColor: colors.card }]}>
            <ActivityIndicator size="large" color={colors.tint} />
            <Text style={[styles.importText, { color: colors.text }]}>
              {syncMessage ??
                (exportProgress?.phase === "zip"
                  ? "ZIP作成中..."
                  : "エクスポート中...")}
            </Text>
            {exportProgress && exportProgress.phase === "images" && (
              <Text
                style={[
                  styles.importProgressText,
                  { color: colors.textSecondary },
                ]}
              >
                画像 {exportProgress.current}/{exportProgress.total}
              </Text>
            )}
            {singleSyncBusy && (
              <Pressable style={styles.syncCancelBtn} onPress={cancelSingleSyncOperation}>
                <Text style={styles.syncCancelBtnText}>中断</Text>
              </Pressable>
            )}
            {lastSyncLogPath && syncMessage && (
              <Pressable
                style={styles.syncLogBtn}
                onPress={() => shareSyncLog(lastSyncLogPath)}
              >
                <Text style={[styles.syncLogBtnText, { color: colors.tint }]}>
                  ログ共有
                </Text>
              </Pressable>
            )}
          </View>
        </View>
      )}
    </ScreenSafeArea>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
  },
  listHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: "700",
  },
  headerButtons: {
    flexDirection: "row",
    gap: 8,
  },
  createBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1.5,
  },
  createBtnText: {
    fontSize: 13,
    fontWeight: "600",
  },
  importBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  importBtnText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "600",
  },
  sortRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 10,
    flexWrap: "wrap",
  },
  sortChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: 1,
  },
  sortDirectionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: 1,
  },
  sortChipText: {
    fontSize: 12,
    fontWeight: "600",
  },
  eventCard: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  eventCardCompleted: {
    opacity: 0.45,
  },
  eventRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  eventThumbnail: {
    width: 44,
    height: 44,
    borderRadius: 6,
    marginRight: 12,
  },
  eventNoImage: {
    alignItems: "center",
    justifyContent: "center",
  },
  eventNoImageText: {
    fontSize: 18,
    fontWeight: "bold",
  },
  eventContent: {
    flex: 1,
  },
  eventHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  eventTitleArea: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
    gap: 8,
  },
  eventName: {
    fontSize: 17,
    fontWeight: "700",
    flexShrink: 1,
  },
  shoppingBadge: {
    backgroundColor: "#e65100",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  shoppingBadgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "700",
  },
  completedBadge: {
    backgroundColor: "#616161",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  completedBadgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "700",
  },
  eventMetaRow: {
    flexDirection: "row",
    marginTop: 3,
  },
  eventMetaText: {
    fontSize: 12,
  },
  eventMemoPreview: {
    fontSize: 11,
    fontStyle: "italic",
    marginTop: 4,
  },
  eventProgressRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 8,
    gap: 8,
  },
  eventProgressBar: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    position: "relative",
    overflow: "hidden",
  },
  eventProgressFill: {
    height: "100%",
    borderRadius: 2,
  },
  eventProgressText: {
    fontSize: 12,
    fontWeight: "600",
    minWidth: 48,
    textAlign: "right",
  },
  footer: {
    flexDirection: "row",
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 8,
    paddingHorizontal: 16,
    justifyContent: "center",
  },
  footerBtn: {
    alignItems: "center",
    gap: 2,
    paddingHorizontal: 20,
  },
  footerBtnText: {
    fontSize: 11,
  },
  loadError: {
    padding: 16,
    gap: 10,
    alignItems: "center",
  },
  emptyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 48,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: "600",
    marginBottom: 8,
  },
  emptyDesc: {
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 20,
  },
  emptyImportBtn: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
  },
  emptyImportBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  // インポート方法選択モーダル
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
  },
  modalCard: {
    width: "80%",
    borderRadius: 14,
    paddingTop: 20,
    paddingBottom: 10,
  },
  syncPreviewCard: {
    width: "92%",
    borderRadius: 14,
    padding: 18,
    marginVertical: 24,
  },
  syncPreviewEvent: {
    fontSize: 17,
    fontWeight: "700",
    textAlign: "center",
    marginBottom: 4,
  },
  syncPreviewUid: {
    fontSize: 11,
    textAlign: "center",
    marginBottom: 12,
  },
  syncPreviewWarning: {
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 12,
  },
  syncSourceOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1.5,
    borderRadius: 9,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 12,
  },
  syncSourceText: {
    fontSize: 14,
    fontWeight: "600",
  },
  syncDiffText: {
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 14,
  },
  syncCancelBtn: {
    marginTop: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#c62828",
    paddingHorizontal: 18,
    paddingVertical: 8,
  },
  syncCancelBtnText: {
    color: "#c62828",
    fontWeight: "700",
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: "700",
    textAlign: "center",
    marginBottom: 16,
  },
  themeSection: {
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  themeSectionTitle: {
    fontSize: 14,
    fontWeight: "600",
    marginBottom: 10,
  },
  themeButtons: {
    flexDirection: "row",
    gap: 8,
  },
  themeBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1.5,
  },
  themeBtnText: {
    fontSize: 13,
    fontWeight: "600",
  },
  actionDate: {
    fontSize: 13,
    textAlign: "center",
    marginBottom: 12,
  },
  modalOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modalOptionText: {
    fontSize: 16,
  },
  modalCancel: {
    paddingVertical: 12,
    alignItems: "center",
  },
  modalCancelText: {
    fontSize: 15,
  },
  advancedImportOptions: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  advancedImportHint: {
    fontSize: 12,
    lineHeight: 17,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 2,
  },
  // QRスキャナー
  qrContainer: { flex: 1, backgroundColor: "#000" },
  qrCamera: { flex: 1 },
  qrOverlay: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    paddingBottom: 50,
    paddingTop: 20,
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  qrText: { color: "#fff", fontSize: 16, fontWeight: "600", marginBottom: 16 },
  qrWarningText: {
    color: "#fff",
    fontSize: 12,
    lineHeight: 17,
    textAlign: "center",
    marginHorizontal: 20,
    marginBottom: 14,
  },
  qrCloseBtn: {
    backgroundColor: "#fff",
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 8,
  },
  qrCloseBtnText: { fontSize: 16, fontWeight: "600", color: "#333" },
  // インポート中
  importOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
  },
  importCard: {
    padding: 24,
    borderRadius: 14,
    alignItems: "center",
    gap: 12,
    width: "70%",
  },
  importText: {
    fontSize: 16,
    fontWeight: "600",
  },
  importProgressText: {
    fontSize: 13,
  },
  syncLogBtn: {
    marginTop: 4,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  syncLogBtnText: {
    fontSize: 13,
    fontWeight: "600",
  },
  createFormGroup: {
    paddingHorizontal: 20,
    marginBottom: 12,
  },
  createLabel: {
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 4,
  },
  createInput: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    fontSize: 14,
  },
  memoInput: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    minHeight: 120,
    textAlignVertical: "top",
    marginBottom: 12,
  },
  memoButtons: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
  },
  memoBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "transparent",
  },
});
