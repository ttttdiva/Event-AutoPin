import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import {
  getEventImportSummary,
  getLastImportDiff,
  importFromZip,
} from "./database";
import type { ImportDiffResult, ImportKind, ImportProgress } from "./database";

export interface ImportResult {
  eventName: string;
  circleCount: number;
  mapCount: number;
  imageCount: number;
  itemCount: number;
}

export interface ImportRunResult {
  eventId: number;
  kind: ImportKind;
  importedEventIds: number[];
  addedEventIds: number[];
  changedEventIds: number[];
  unchangedEventIds: number[];
  removedEventIds: number[];
  targetEventIds: number[];
  failedEventIds: number[];
  eventCount: number;
  isFullSync: boolean;
  summary: ImportResult;
}

const QR_DOWNLOAD_STALL_TIMEOUT_MS = 90 * 1000;
const QR_DOWNLOAD_MAX_TIMEOUT_MS = 20 * 60 * 1000;

export async function handleImportZip(
  onProgress: (p: ImportProgress) => void,
): Promise<ImportRunResult | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: "application/zip",
    copyToCacheDirectory: true,
  });
  if (result.canceled) return null;

  const asset = result.assets[0];
  return importZipWithSummary(asset.uri, onProgress);
}

export async function handleImportFromQRUrl(
  url: string,
  onProgress: (p: ImportProgress) => void,
): Promise<ImportRunResult> {
  const downloadPath = `${FileSystem.cacheDirectory}qr_import_${Date.now()}.zip`;

  try {
    const downloadResult = await downloadQrZip(url, downloadPath, onProgress);
    if (downloadResult.status !== 200) {
      throw new Error(`ダウンロード失敗: HTTP ${downloadResult.status}`);
    }
    return await importZipWithSummary(downloadPath, onProgress);
  } finally {
    await FileSystem.deleteAsync(downloadPath, { idempotent: true });
  }
}

export async function getImportSummary(eventId: number): Promise<ImportResult> {
  const summary = await getEventImportSummary(eventId);

  return {
    eventName: summary.eventName,
    circleCount: summary.circleCount,
    mapCount: summary.mapCount,
    imageCount: summary.imageCount,
    itemCount: summary.itemCount,
  };
}

async function importZipWithSummary(
  zipUri: string,
  onProgress: (p: ImportProgress) => void,
): Promise<ImportRunResult> {
  const eventId = await importFromZip(zipUri, onProgress);
  // The importer records the manifest-authoritative diff after its transaction
  // commits.  Never infer full/single from SQLite row IDs: changed events are
  // deliberately finalized back onto their old IDs and unchanged events add
  // no rows at all.
  const diff = getLastImportDiff();
  const targetEventIds = normalizeTargetEventIds(diff, eventId);
  const summaryEventId =
    diff.addedEventIds[0] ?? diff.changedEventIds[0] ??
    diff.unchangedEventIds[0] ?? targetEventIds[0] ?? eventId;
  const summary =
    targetEventIds.length === 1
      ? await getImportSummary(summaryEventId)
      : {
          eventName: `${targetEventIds.length}件のイベント`,
          circleCount: 0,
          mapCount: 0,
          imageCount: 0,
          itemCount: 0,
        };

  return buildImportRunResult(eventId, diff, targetEventIds, summary);
}

function uniqueEventIds(ids: number[]): number[] {
  return [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))];
}

function normalizeTargetEventIds(
  diff: ImportDiffResult,
  eventId: number,
): number[] {
  const targetEventIds = uniqueEventIds(diff.targetEventIds);
  if (targetEventIds.length > 0) return targetEventIds;
  // Keep compatibility with an older native/database module that has not yet
  // populated targetEventIds while still avoiding the old before/after query.
  return uniqueEventIds([
    ...diff.addedEventIds,
    ...diff.changedEventIds,
    ...diff.unchangedEventIds,
    ...diff.importedEventIds,
    eventId,
  ]);
}

export function buildImportRunResult(
  eventId: number,
  diff: ImportDiffResult,
  targetEventIds: number[],
  summary: ImportResult,
): ImportRunResult {
  const kind = diff.kind;
  const normalizedTargetEventIds = uniqueEventIds(targetEventIds);
  const importedEventIds = uniqueEventIds(diff.importedEventIds);
  const addedEventIds = uniqueEventIds(diff.addedEventIds);
  const changedEventIds = uniqueEventIds(diff.changedEventIds);
  const unchangedEventIds = uniqueEventIds(diff.unchangedEventIds);
  const removedEventIds = uniqueEventIds(diff.removedEventIds);
  const failedEventIds = uniqueEventIds(diff.failedEventIds);
  return {
    eventId,
    kind,
    importedEventIds,
    addedEventIds,
    changedEventIds,
    unchangedEventIds,
    removedEventIds,
    targetEventIds: normalizedTargetEventIds,
    failedEventIds,
    eventCount: normalizedTargetEventIds.length,
    isFullSync: kind === "full",
    summary,
  };
}

async function downloadQrZip(
  url: string,
  downloadPath: string,
  onProgress: (p: ImportProgress) => void,
): Promise<FileSystem.FileSystemDownloadResult> {
  let lastProgressAt = Date.now();
  const startedAt = lastProgressAt;
  onProgress({ current: 0, total: 0, phase: "download" });

  const download = FileSystem.createDownloadResumable(
    url,
    downloadPath,
    {},
    (progress) => {
      lastProgressAt = Date.now();
      onProgress({
        current: progress.totalBytesWritten,
        total: Math.max(progress.totalBytesExpectedToWrite, 0),
        phase: "download",
      });
    },
  );

  let monitor: ReturnType<typeof setInterval> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    monitor = setInterval(() => {
      const now = Date.now();
      if (now - lastProgressAt > QR_DOWNLOAD_STALL_TIMEOUT_MS) {
        void download.pauseAsync().catch(() => undefined);
        reject(
          new Error(
            "ダウンロードが止まっています。PC側のサーバー表示、同じWi-Fi、ファイアウォール設定を確認してください。",
          ),
        );
      }
      if (now - startedAt > QR_DOWNLOAD_MAX_TIMEOUT_MS) {
        void download.pauseAsync().catch(() => undefined);
        reject(
          new Error(
            "ダウンロードが20分を超えました。全イベント同期ZIPを作り直してから再度読み込んでください。",
          ),
        );
      }
    }, 1000);
  });

  try {
    const result = await Promise.race([download.downloadAsync(), timeout]);
    if (!result) {
      throw new Error("ダウンロードに失敗しました");
    }
    return result;
  } finally {
    if (monitor) clearInterval(monitor);
  }
}
