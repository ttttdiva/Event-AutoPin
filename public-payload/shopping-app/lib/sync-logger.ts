import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";

const LOG_DIR = `${FileSystem.documentDirectory}sync-logs/`;

type LogDetails = Record<string, unknown> | string | number | boolean | null;

async function ensureLogDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(LOG_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(LOG_DIR, { intermediates: true });
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

function safeFileTimestamp(): string {
  return timestamp().replace(/[:.]/g, "-");
}

function formatDetails(details?: LogDetails): string {
  if (details == null) return "";
  if (typeof details === "string") return ` ${details}`;
  try {
    return ` ${JSON.stringify(details)}`;
  } catch {
    return ` ${String(details)}`;
  }
}

export async function createSyncLog(
  label: string,
  details?: LogDetails,
): Promise<string> {
  await ensureLogDir();
  const path = `${LOG_DIR}${safeFileTimestamp()}_${label}.log`;
  const firstLine = `[${timestamp()}] start${formatDetails(details)}\n`;
  await FileSystem.writeAsStringAsync(path, firstLine);
  return path;
}

export async function appendSyncLog(
  path: string | null,
  message: string,
  details?: LogDetails,
): Promise<void> {
  if (!path) return;
  try {
    const current = await FileSystem.readAsStringAsync(path).catch(() => "");
    const line = `[${timestamp()}] ${message}${formatDetails(details)}\n`;
    await FileSystem.writeAsStringAsync(path, current + line);
  } catch (e) {
    console.warn("sync log write failed:", e);
  }
}

export async function shareSyncLog(path: string | null): Promise<void> {
  if (!path) return;
  const available = await Sharing.isAvailableAsync();
  if (available) {
    await Sharing.shareAsync(path, {
      mimeType: "text/plain",
      dialogTitle: "同期ログ",
    });
  }
}

export async function getFileSize(path: string): Promise<number | null> {
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists || !("size" in info)) return null;
  return info.size ?? null;
}
