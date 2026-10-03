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

let downloadTempSequence = 0;
let resizeOperationQueue: Promise<void> = Promise.resolve();
const resizeOutputNamePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpe?g|png|webp)$/i;

/** ImageManipulatorのcache所有権を1件ずつ確定させる。 */
function enqueueResizeOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = resizeOperationQueue.then(operation);
  resizeOperationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function getSafeResizeName(uri: string, resizeDir: string): string | null {
  if (!uri.startsWith(resizeDir)) return null;
  const name = uri.slice(resizeDir.length);
  return resizeOutputNamePattern.test(name) ? name : null;
}

async function readResizeSnapshot(resizeDir: string): Promise<Set<string> | null> {
  try {
    const info = await FileSystem.getInfoAsync(resizeDir);
    return info.exists ? new Set(await FileSystem.readDirectoryAsync(resizeDir)) : new Set();
  } catch (error) {
    console.warn("画像変換cache一覧取得失敗、元画像を使用:", error);
    return null;
  }
}

async function cleanupNewResizeOutputs(
  resizeDir: string,
  existingNames: Set<string>,
  inputUri: string,
  destPath: string,
  resultUri: string | null,
): Promise<void> {
  const candidates = new Set<string>();
  const addCandidate = (name: string) => {
    if (!resizeOutputNamePattern.test(name) || existingNames.has(name)) return;
    const uri = `${resizeDir}${name}`;
    if (uri === inputUri || uri === destPath) return;
    candidates.add(name);
  };

  // 変換がrejectしてURIを返さない場合にも、一覧差分から今回のUUIDを回収する。
  if (resultUri) {
    const resultName = getSafeResizeName(resultUri, resizeDir);
    if (resultName) addCandidate(resultName);
  }
  try {
    const info = await FileSystem.getInfoAsync(resizeDir);
    if (info.exists) {
      for (const name of await FileSystem.readDirectoryAsync(resizeDir)) addCandidate(name);
    }
  } catch {
    // 一覧取得不能時は既存画像を守るため、返却済みで安全に特定できるものだけ扱う。
  }
  for (const name of candidates) {
    await FileSystem.deleteAsync(`${resizeDir}${name}`, { idempotent: true }).catch(() => {});
  }
}

/** URLから画像をダウンロードして、指定ディレクトリに保存（最大幅 maxWidth でリサイズ） */
export async function downloadImage(
  url: string,
  destDir: string,
  filename: string,
  options: { maxWidth?: number; quality?: number } = {},
): Promise<DownloadResult | null> {
  let ownedTempPath: string | null = null;
  try {
    const cacheDirectory = FileSystem.cacheDirectory;
    if (!cacheDirectory) throw new Error("画像キャッシュの保存先がありません");
    const dirInfo = await FileSystem.getInfoAsync(destDir);
    if (!dirInfo.exists) {
      await FileSystem.makeDirectoryAsync(destDir, { intermediates: true });
    }
    // 同時刻・同名の並行取得や前回残留したcacheを上書きしない。
    let tmpPath: string;
    do {
      tmpPath = `${cacheDirectory}tmp_dl_${Date.now()}_${++downloadTempSequence}_${filename}`;
    } while ((await FileSystem.getInfoAsync(tmpPath)).exists);
    ownedTempPath = tmpPath;
    const { status, uri } = await FileSystem.downloadAsync(url, tmpPath);
    if (status !== 200 || !uri) return null;

    const destPath = `${destDir}${filename}`;
    const maxWidth = options.maxWidth ?? 800;
    const quality = options.quality ?? 0.85;

    await enqueueResizeOperation(async () => {
      // snapshotからfallback・cleanupまでを直列化し、reject時の一覧差分を自分の所有物に限定する。
      const resizeDir = `${cacheDirectory}ImageManipulator/`;
      const existingResizeNames = await readResizeSnapshot(resizeDir);
      if (!existingResizeNames) {
        await FileSystem.copyAsync({ from: uri, to: destPath });
        return;
      }

      let resultUri: string | null = null;
      try {
        const result = await manipulateAsync(
          uri,
          [{ resize: { width: maxWidth } }],
          { compress: quality, format: SaveFormat.JPEG },
        );
        resultUri = result.uri;
        await FileSystem.copyAsync({ from: result.uri, to: destPath });
      } catch (e) {
        // リサイズ失敗時はそのままコピー
        console.warn("画像リサイズ失敗、そのまま保存:", e);
        await FileSystem.copyAsync({ from: uri, to: destPath });
      } finally {
        // 変換reject・copy/fallback失敗でも、今回の新規UUID変換画像だけを回収する。
        await cleanupNewResizeOutputs(resizeDir, existingResizeNames, uri, destPath, resultUri);
      }
    });
    return { localPath: destPath, filename };
  } catch (e) {
    console.warn(`画像DL失敗: ${url}`, e);
    return null;
  } finally {
    // 非200の早期returnや途中例外でも、今回のdownload先だけを回収する。
    // 返却URIや既存の頒布物・カットを削除対象に広げない。
    if (ownedTempPath) {
      await FileSystem.deleteAsync(ownedTempPath, { idempotent: true }).catch(() => {});
    }
  }
}

/** URLから拡張子推測（不明時は jpg） */
export function guessExt(url: string): string {
  const m = url.match(/\.(jpe?g|png|gif|webp)(\?|#|$)/i);
  return m ? m[1].toLowerCase().replace("jpeg", "jpg") : "jpg";
}
