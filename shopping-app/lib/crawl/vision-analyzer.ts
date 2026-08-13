/**
 * 画像解析（サークルカット → ジャンル推定）
 *
 * デスクトップの image_analyzer.py を移植。
 * サークルカット画像をLLMに渡してジャンル・メモを推定する。
 */
import * as FileSystem from "expo-file-system/legacy";
import { LlmClient } from "./llm-client";
import {
  getVisionModel,
  getVisionReasoningEffort,
  isVisionAnalysisEnabled,
} from "../settings-store";

const PROMPT = `この画像は同人誌即売会のサークルカット（宣伝画像）です。

以下のJSON形式で画像の情報を抽出してください。
{
  "genres": ["ジャンル1", "ジャンル2"],
  "description": "サークルの頒布物・作風を一言で"
}

ジャンル例: 漫画, イラスト集, 小説, グッズ, 音楽, アニメ二次創作, オリジナル, 男性向け, 女性向け, 健全, 成人向け
JSONのみを返してください。`;

export interface VisionResult {
  genres: string[];
  description: string | null;
}

export async function analyzeCircleCut(
  imagePath: string,
): Promise<VisionResult | null> {
  if (!(await isVisionAnalysisEnabled())) return null;
  try {
    const info = await FileSystem.getInfoAsync(imagePath);
    if (!info.exists) return null;

    const base64 = await FileSystem.readAsStringAsync(imagePath, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const mime = imagePath.toLowerCase().endsWith(".png")
      ? "image/png"
      : "image/jpeg";

    const [model, reasoningEffort] = await Promise.all([
      getVisionModel(),
      getVisionReasoningEffort(),
    ]);
    const llm = new LlmClient([model]);
    const text = await llm.analyzeImage(base64, mime, PROMPT, {
      reasoningEffort,
    });
    const parsed = JSON.parse(text);
    return {
      genres: Array.isArray(parsed.genres) ? parsed.genres : [],
      description: parsed.description ?? null,
    };
  } catch (e) {
    console.warn("画像解析失敗:", imagePath, e);
    return null;
  }
}
