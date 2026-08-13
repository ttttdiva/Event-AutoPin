/**
 * 特定サークルをXポストURLから再処理する
 *
 * デスクトップの desktop_bridge.py: reprocess_circle_from_post を移植。
 * - ポストURLからtweet_idを抽出
 * - Grok APIで当該ツイートの画像URL・頒布物情報を取得
 * - 画像をDL、items/item_imagesを置換してDB更新
 * - memoにポストURLを追記
 */
import * as FileSystem from "expo-file-system/legacy";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import {
  getDatabase,
  registerDefaultCutFromImage,
  normalizePurchaseLookupKey,
  refreshItemSearchIndexForCircle,
  deleteItemSearchIndexForCircle,
  invalidatePurchaseLookupCache,
} from "../database";
import { getApiKey, isGrokEnabled } from "../settings-store";
import { downloadImage, guessExt } from "./image-downloader";

const GROK_ENDPOINT = "https://api.x.ai/v1/chat/completions";
const KEEP_AWAKE_TAG = "post-reprocess";
const POST_URL_RE = /(?:twitter\.com|x\.com)\/[^/]+\/status(?:es)?\/(\d+)/i;

export interface PostReprocessProgress {
  phase: "fetch" | "download" | "save" | "done";
  message: string;
}

export interface PostReprocessResult {
  success: boolean;
  message: string;
  itemCount: number;
  imageCount: number;
}

/** URLからtweet_idを抽出 */
export function extractTweetId(url: string): string | null {
  const m = url.match(POST_URL_RE);
  return m ? m[1] : null;
}

/** 指定のサークルを指定のポストURLで再処理する */
export async function reprocessCircleFromPost(
  circleId: number,
  postUrl: string,
  onProgress?: (p: PostReprocessProgress) => void,
): Promise<PostReprocessResult> {
  const tweetId = extractTweetId(postUrl);
  if (!tweetId) {
    return {
      success: false,
      message: "ポストURLの形式が不正です",
      itemCount: 0,
      imageCount: 0,
    };
  }

  if (!(await isGrokEnabled())) {
    return {
      success: false,
      message: "設定でGrok検索が無効になっています",
      itemCount: 0,
      imageCount: 0,
    };
  }
  const apiKey = await getApiKey("xai");
  if (!apiKey) {
    return {
      success: false,
      message: "xAI(Grok) APIキーが未設定です",
      itemCount: 0,
      imageCount: 0,
    };
  }

  const db = await getDatabase();
  const circleRow = await db.getFirstAsync<{
    event_id: number;
    name: string;
    penname: string | null;
    memo: string | null;
    circle_cut_filename: string | null;
  }>(
    "SELECT event_id, name, penname, memo, circle_cut_filename FROM circles WHERE id = ?",
    circleId,
  );
  if (!circleRow) {
    return {
      success: false,
      message: "サークルが見つかりません",
      itemCount: 0,
      imageCount: 0,
    };
  }
  const eventId = circleRow.event_id;

  await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
  try {
    onProgress?.({ phase: "fetch", message: "Grokで投稿を解析中..." });
    const grokResult = await fetchPostWithGrok(apiKey, postUrl);
    if (!grokResult) {
      return {
        success: false,
        message: "Grokから投稿情報を取得できませんでした",
        itemCount: 0,
        imageCount: 0,
      };
    }

    const items = grokResult.items.filter((i) => i?.name);
    const imageUrls = grokResult.imageUrls.filter((u) => u);

    // 既存行と画像は staging/publish が成功するまで保持する。
    const oldImages = await db.getAllAsync<{ filename: string }>(
      "SELECT filename FROM item_images WHERE circle_id = ?",
      circleId,
    );

    // 画像DL
    const itemsDir = `${FileSystem.documentDirectory}images/${eventId}/items/`;
    const stagingDir = `${itemsDir}.staging_post_${circleId}_${tweetId}_${Date.now()}/`;
    const dirInfo = await FileSystem.getInfoAsync(itemsDir);
    if (!dirInfo.exists) {
      await FileSystem.makeDirectoryAsync(itemsDir, { intermediates: true });
    }
    await FileSystem.makeDirectoryAsync(stagingDir, { intermediates: true });

    let savedImages = 0;
    let firstSavedImage: string | null = null;
    const newImagePaths: string[] = [];
    try {
      for (let j = 0; j < imageUrls.length; j++) {
        const u = imageUrls[j];
        onProgress?.({
          phase: "download",
          message: `画像DL ${j + 1}/${imageUrls.length}`,
        });
        const ext = guessExt(u);
        const fn = `item_${circleId}_post_${tweetId}_${Date.now()}_${j + 1}.${ext === "jpg" ? "jpg" : ext}`;
        const dl = await downloadImage(u, stagingDir, fn, { maxWidth: 1200 });
        if (dl) {
          const publishedPath = `${itemsDir}${fn}`;
          await FileSystem.copyAsync({ from: dl.localPath, to: publishedPath });
          firstSavedImage ??= publishedPath;
          newImagePaths.push(publishedPath);
          savedImages++;
        }
      }
    } catch (error) {
      for (const path of newImagePaths) {
        await FileSystem.deleteAsync(path, { idempotent: true }).catch(() => undefined);
      }
      await FileSystem.deleteAsync(stagingDir, { idempotent: true }).catch(() => undefined);
      throw error;
    }

    try {
      // DB はイベント単位の exclusive transaction。ここで失敗しても old rows と
      // old images は残り、publish 済みの新画像だけ catch で掃除する。
      onProgress?.({ phase: "save", message: "頒布物を保存中..." });
      await db.withExclusiveTransactionAsync(async (txn) => {
        const txDb = txn as unknown as typeof db;
        await deleteItemSearchIndexForCircle(circleId, txDb);
        await txDb.runAsync("DELETE FROM item_images WHERE circle_id = ?", circleId);
        await txDb.runAsync("DELETE FROM items WHERE circle_id = ?", circleId);
        for (const imagePath of newImagePaths) {
          await txDb.runAsync(
            "INSERT INTO item_images (circle_id, filename, source) VALUES (?, ?, ?)",
            circleId,
            imagePath,
            "twitter",
          );
        }
        for (const item of items) {
          await txDb.runAsync(
            "INSERT INTO items (circle_id, name, price, type, description, purchase_status, name_key) VALUES (?, ?, ?, ?, ?, ?, ?)",
            circleId,
            String(item.name),
            typeof item.price === "number" ? item.price : null,
            item.type ?? null,
            null,
            3,
            normalizePurchaseLookupKey(String(item.name)),
          );
        }

        // memoにポストURLを追記（重複なし）
        const existingMemo = circleRow.memo ?? "";
        if (!existingMemo.includes(postUrl)) {
          const newMemo = existingMemo ? `${existingMemo}\n${postUrl}` : postUrl;
          await txDb.runAsync("UPDATE circles SET memo = ? WHERE id = ?", newMemo, circleId);
        }
        const catalogStatus = items.length || savedImages ? "confirmed" : "no_extractable_items";
        await txDb.runAsync("UPDATE circles SET catalog_status = ? WHERE id = ?", catalogStatus, circleId);
        if (!circleRow.circle_cut_filename && firstSavedImage) {
          await txDb.runAsync("UPDATE circles SET circle_cut_filename = ? WHERE id = ?", firstSavedImage, circleId);
        }
      });
    } catch (error) {
      for (const path of newImagePaths) {
        await FileSystem.deleteAsync(path, { idempotent: true }).catch(() => undefined);
      }
      throw error;
    } finally {
      await FileSystem.deleteAsync(stagingDir, { idempotent: true }).catch(() => undefined);
    }
    await refreshItemSearchIndexForCircle(circleId);
    invalidatePurchaseLookupCache();
    // 古いファイルは DB publish 成功後にのみ削除する。
    for (const img of oldImages) {
      await FileSystem.deleteAsync(img.filename, { idempotent: true }).catch(() => undefined);
    }
    if (!circleRow.circle_cut_filename && firstSavedImage) {
      await registerDefaultCutFromImage(
        circleRow.name,
        circleRow.penname ?? "",
        firstSavedImage,
      );
    }

    onProgress?.({ phase: "done", message: "完了" });
    return {
      success: true,
      message: `頒布物 ${items.length}件・画像 ${savedImages}件を更新しました`,
      itemCount: items.length,
      imageCount: savedImages,
    };
  } finally {
    deactivateKeepAwake(KEEP_AWAKE_TAG);
  }
}

interface GrokPostResult {
  imageUrls: string[];
  items: { name: string; price?: number | null; type?: string | null }[];
}

/** Grokに特定ポストURLを渡して画像URL・頒布物を抽出 */
async function fetchPostWithGrok(
  apiKey: string,
  postUrl: string,
): Promise<GrokPostResult | null> {
  const prompt = `次のXポストを確認し、そこに含まれる「おしながき」画像URLと、頒布物一覧を抽出してください。
ポストURL: ${postUrl}

以下のJSON形式で返してください。
{
  "image_urls": ["画像URL1", "画像URL2"],
  "items": [
    { "name": "頒布物名", "price": 500, "type": "新刊(漫画)" }
  ]
}

type は次のいずれかを使ってください: 新刊(漫画), 新刊(イラスト), 既刊, 小説, 合同誌, 雑誌, 音楽, グッズ, その他
ポストが存在しない・画像がない場合は {"image_urls": [], "items": []} を返してください。
JSONのみを返してください。`;

  try {
    const body = {
      model: "grok-2-latest",
      messages: [
        { role: "system", content: "常にJSON形式で回答してください。" },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
    };
    const res = await fetch(GROK_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? "";
    if (!content) return null;
    const parsed = JSON.parse(stripFences(String(content).trim()));
    return {
      imageUrls: Array.isArray(parsed.image_urls) ? parsed.image_urls : [],
      items: Array.isArray(parsed.items) ? parsed.items : [],
    };
  } catch (e) {
    console.warn("Grokポスト解析失敗:", postUrl, e);
    return null;
  }
}

function stripFences(text: string): string {
  let t = text.trim();
  if (t.startsWith("```json")) t = t.slice(7);
  else if (t.startsWith("```")) t = t.slice(3);
  if (t.endsWith("```")) t = t.slice(0, -3);
  return t.trim();
}
