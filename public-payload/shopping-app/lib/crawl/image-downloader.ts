/**
 * 画像ダウンローダ
 *
 * - URLから画像をダウンロード
 * - expo-image-manipulator でリサイズ/JPEG変換
 * - 指定ディレクトリへ保存
 */
import * as FileSystem from "expo-file-system/legacy";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";

export interface DownloadResult {
  localPath: string;
  filename: string;
}

/** URLから画像をダウンロードして、指定ディレクトリに保存（最大幅 maxWidth でリサイズ） */
export async function downloadImage(
  url: string,
  destDir: string,
  filename: string,
  options: { maxWidth?: number; quality?: number } = {},
): Promise<DownloadResult | null> {
  try {
    const dirInfo = await FileSystem.getInfoAsync(destDir);
    if (!dirInfo.exists) {
      await FileSystem.makeDirectoryAsync(destDir, { intermediates: true });
    }
    const tmpPath = `${FileSystem.cacheDirectory}tmp_dl_${Date.now()}_${filename}`;
    const { status, uri } = await FileSystem.downloadAsync(url, tmpPath);
    if (status !== 200 || !uri) return null;

    const destPath = `${destDir}${filename}`;
    const maxWidth = options.maxWidth ?? 800;
    const quality = options.quality ?? 0.85;

    try {
      const result = await manipulateAsync(
        uri,
        [{ resize: { width: maxWidth } }],
        { compress: quality, format: SaveFormat.JPEG },
      );
      await FileSystem.copyAsync({ from: result.uri, to: destPath });
      try {
        await FileSystem.deleteAsync(result.uri, { idempotent: true });
      } catch {
        // ignore
      }
    } catch (e) {
      // リサイズ失敗時はそのままコピー
      console.warn("画像リサイズ失敗、そのまま保存:", e);
      await FileSystem.copyAsync({ from: uri, to: destPath });
    } finally {
      await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    }
    return { localPath: destPath, filename };
  } catch (e) {
    console.warn(`画像DL失敗: ${url}`, e);
    return null;
  }
}

/** URLから拡張子推測（不明時は jpg） */
export function guessExt(url: string): string {
  const m = url.match(/\.(jpe?g|png|gif|webp)(\?|#|$)/i);
  return m ? m[1].toLowerCase().replace("jpeg", "jpg") : "jpg";
}
