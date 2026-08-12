import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import {
  getAllEvents,
  getCirclesByEvent,
  getEventMaps,
  getItemImagesByCircle,
  getItemsByCircle,
  importFromZip,
} from "./database";
import type { ImportProgress } from "./database";

export interface ImportResult {
  eventName: string;
  circleCount: number;
  mapCount: number;
  imageCount: number;
  itemCount: number;
}

export interface ImportRunResult {
  eventId: number;
  importedEventIds: number[];
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
  const maps = await getEventMaps(eventId);
  const circles = await getCirclesByEvent(eventId);
  let totalImages = 0;
  let totalItems = 0;
  for (const circle of circles) {
    const imgs = await getItemImagesByCircle(circle.id);
    const items = await getItemsByCircle(circle.id);
    totalImages += imgs.length;
    totalItems += items.length;
  }

  const events = await getAllEvents();
  const eventData = events.find((event) => event.id === eventId);

  return {
    eventName: eventData?.name ?? "不明",
    circleCount: circles.length,
    mapCount: maps.length,
    imageCount: totalImages,
    itemCount: totalItems,
  };
}

async function importZipWithSummary(
  zipUri: string,
  onProgress: (p: ImportProgress) => void,
): Promise<ImportRunResult> {
  const beforeIds = new Set((await getAllEvents()).map((event) => event.id));
  const eventId = await importFromZip(zipUri, onProgress);
  const afterEvents = await getAllEvents();
  const importedEventIds = afterEvents
    .filter((event) => !beforeIds.has(event.id))
    .map((event) => event.id);
  const normalizedEventIds =
    importedEventIds.length > 0 ? importedEventIds : [eventId];
  const summary =
    normalizedEventIds.length === 1
      ? await getImportSummary(normalizedEventIds[0])
      : {
          eventName: `${normalizedEventIds.length}件のイベント`,
          circleCount: 0,
          mapCount: 0,
          imageCount: 0,
          itemCount: 0,
        };

  return {
    eventId,
    importedEventIds: normalizedEventIds,
    eventCount: normalizedEventIds.length,
    isFullSync: normalizedEventIds.length > 1,
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
