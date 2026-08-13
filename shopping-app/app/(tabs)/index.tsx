import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import {
  StyleSheet,
  View,
  Text,
  TextInput,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  Alert,
  Modal,
  Pressable,
  SafeAreaView,
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
import type { ImportProgress, ExportProgress } from "@/lib/database";
import type { EventSummary } from "@/lib/database";
import { getColors } from "@/constants/Colors";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import EventCard from "@/components/EventCard";
import {
  beginSqlMetricsScope,
  recordUiMetric,
  recordUiMetricAfterPaint,
  startUiMetric,
} from "@/lib/performance";
import { createLoadEpochGuard } from "@/lib/event-load-epoch";
import { compareJaText } from "@/lib/text-collation";

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
const PC_SYNC_TIMEOUT_MS = 5 * 60 * 1000;

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

export default function EventListScreen() {
  const { effectiveScheme } = useTheme();
  const colors = getColors(effectiveScheme);
  const router = useRouter();
  const { setCurrentEventId } = useEvent();

  const [events, setEvents] = useState<EventWithStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
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

  // 長押しアクションモーダル
  const [actionTarget, setActionTarget] = useState<EventWithStats | null>(null);

  // エクスポート
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(
    null,
  );
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [lastSyncLogPath, setLastSyncLogPath] = useState<string | null>(null);

  // PCに送信（逆QR）
  const [sendToPCTarget, setSendToPCTarget] = useState<EventWithStats | null>(
    null,
  );
  const [showSendQRScanner, setShowSendQRScanner] = useState(false);
  const sendQrScannedRef = useRef(false);

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
    const epoch = listLoadEpochGuardRef.current.next();
    const endSqlMetrics = beginSqlMetricsScope("event-list");
    setLoading(true);
    try {
      // イベント件数に比例する N+1 を避け、集約 projection を1 SQLで取得する。
      const summaries = await getEventSummaries();
      if (!listLoadEpochGuardRef.current.isCurrent(epoch)) return;
      setEvents(summaries);
    } catch (e) {
      console.error("データ読み込みエラー:", e);
    } finally {
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
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
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
      case "sendToPC":
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

  async function doImportZip() {
    setShowImportModal(false);
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
    setShowImportModal(false);
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

  async function finishImport(result: ImportRunResult) {
    setCurrentEventId(result.eventId);
    invalidateListLoad();
    await loadData();
    const summary = result.summary;
    if (result.isFullSync) {
      Alert.alert(
        "全イベント同期完了",
        `${result.eventCount}件のイベントを取り込みました`,
      );
      return;
    }
    Alert.alert(
      "インポート完了",
      `${summary.eventName}\n${summary.circleCount}サークル / ${summary.mapCount}マップ / ${summary.itemCount}頒布物`,
    );
  }

  // PCに送信: QRスキャン→ZIPアップロード
  async function onSendQRCodeScanned({ data }: { data: string }) {
    if (sendQrScannedRef.current) return;
    sendQrScannedRef.current = true;
    setShowSendQRScanner(false);

    if (!data.startsWith("http")) {
      Alert.alert("エラー", "QRコードにURLが含まれていません");
      return;
    }

    const ev = sendToPCTarget;
    if (!ev) return;
    setSendToPCTarget(null);

    let syncLogPath: string | null = null;
    try {
      setExporting(true);
      setSyncMessage("同期ログを作成中...");
      syncLogPath = await createSyncLog("send-to-pc", {
        eventId: ev.id,
        eventName: ev.name,
        targetUrl: data,
        platform: Platform.OS,
      });
      setLastSyncLogPath(syncLogPath);
      await appendSyncLog(syncLogPath, "QR scanned");

      setSyncMessage("ZIPを作成中...");
      setExportProgress({ current: 0, total: 1, phase: "images" });
      const zipPath = await exportEventAsZip(ev.id, (p) =>
        setExportProgress({ ...p }),
      );
      const zipSize = await getFileSize(zipPath);
      await appendSyncLog(syncLogPath, "ZIP created", { zipPath, zipSize });

      setSyncMessage("Uploading ZIP to PC...");
      setExportProgress({ current: 0, total: 1, phase: "zip" });

      setSyncMessage("Uploading to PC...");
      const uploadResult = await FileSystem.uploadAsync(data, zipPath, {
        httpMethod: "POST",
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        headers: { "Content-Type": "application/octet-stream" },
      });

      const responseText = uploadResult.body;
      const responseOk = uploadResult.status >= 200 && uploadResult.status < 300;
      await appendSyncLog(syncLogPath, "PC response received", {
        status: uploadResult.status,
        ok: responseOk,
        body: responseText.slice(0, 2000),
      });

      if (!responseOk) {
        throw new Error(`Upload failed: HTTP ${uploadResult.status}`);
      }

      let importedName = "";
      try {
        const responseJson = JSON.parse(responseText);
        importedName = responseJson?.importResult?.meta?.name ?? "";
      } catch {
        /* 古いPC側アプリはJSONを返さないため無視 */
      }
      setSyncMessage("同期完了");
      await appendSyncLog(syncLogPath, "sync completed", { importedName });
      Alert.alert(
        "同期完了",
        importedName
          ? `PC側の取り込みまで完了しました。\n${importedName}`
          : "PC側の取り込みまで完了しました。",
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
      await appendSyncLog(syncLogPath, "sync failed", {
        message: e?.message ?? String(e),
        stack: e?.stack,
      });
      Alert.alert("送信エラー", e.message, [
        { text: "OK" },
        {
          text: "ログ共有",
          onPress: () => {
            shareSyncLog(syncLogPath);
          },
        },
      ]);
    } finally {
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
      <SafeAreaView
        style={[styles.safeArea, { backgroundColor: colors.background }]}
      >
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.tint} />
          <Text style={[styles.loadingText, { color: colors.textSecondary }]}>
            読み込み中...
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      style={[styles.safeArea, { backgroundColor: colors.background }]}
    >
      <StatusBar
        barStyle={effectiveScheme === "dark" ? "light-content" : "dark-content"}
      />
      <View style={{ flex: 1 }}>
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
          ListEmptyComponent={
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
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
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
        onRequestClose={() => setShowImportModal(false)}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setShowImportModal(false)}
        >
          <View
            style={[styles.modalCard, { backgroundColor: colors.card }]}
            onStartShouldSetResponder={() => true}
          >
            <Text style={[styles.modalTitle, { color: colors.text }]}>
              データインポート
            </Text>
            <Pressable
              style={[styles.modalOption, { borderBottomColor: colors.border }]}
              onPress={doImportZip}
            >
              <FontAwesome
                name="file-archive-o"
                size={18}
                color={colors.tint}
              />
              <Text style={[styles.modalOptionText, { color: colors.text }]}>
                ZIPファイル
              </Text>
            </Pressable>
            <Pressable
              style={[styles.modalOption, { borderBottomColor: "transparent" }]}
              onPress={doImportQR}
            >
              <FontAwesome name="qrcode" size={18} color={colors.tint} />
              <Text style={[styles.modalOptionText, { color: colors.text }]}>
                QRコード
              </Text>
            </Pressable>
            <Pressable
              style={styles.modalCancel}
              onPress={() => setShowImportModal(false)}
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
              onPress={() => handleAction("sendToPC")}
            >
              <FontAwesome name="desktop" size={18} color={colors.tint} />
              <Text style={[styles.modalOptionText, { color: colors.text }]}>
                PCに送信
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

      {/* イベントメモ編集モーダル */}
      <Modal
        visible={memoTarget !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setMemoTarget(null)}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setMemoTarget(null)}
        >
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
        </Pressable>
      </Modal>

      {/* イベント作成モーダル */}
      <Modal
        visible={showCreateModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowCreateModal(false)}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setShowCreateModal(false)}
        >
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
        </Pressable>
      </Modal>

      {/* QRスキャナーモーダル */}
      <Modal
        visible={showQRScanner}
        animationType="slide"
        onRequestClose={() => setShowQRScanner(false)}
      >
        <View style={styles.qrContainer}>
          <CameraView
            style={styles.qrCamera}
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={onQRCodeScanned}
          />
          <View style={styles.qrOverlay}>
            <Text style={styles.qrText}>QRコードをスキャンしてください</Text>
            <Pressable
              style={styles.qrCloseBtn}
              onPress={() => setShowQRScanner(false)}
            >
              <Text style={styles.qrCloseBtnText}>閉じる</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* PCに送信用QRスキャナーモーダル */}
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
            <Text style={styles.qrText}>PCに表示されたQRコードをスキャン</Text>
            <Pressable
              style={styles.qrCloseBtn}
              onPress={() => setShowSendQRScanner(false)}
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
              インポート中...
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    paddingTop: Platform.OS === "android" ? StatusBar.currentHeight : 0,
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
