/**
 * LLMクライアント（OpenAI / Gemini / xAI 統一インタフェース）
 *
 * デスクトップ版 src/utils/llm_client.py の移植。
 * - マルチモデルfallback
 * - テキスト抽出 + 画像解析
 * - JSON形式で回答を期待
 */
import {
  getApiKey,
  type ApiKeyProvider,
  type ReasoningEffort,
} from "../settings-store";

export type LlmApiType = "openai" | "gemini" | "xai";

export interface LlmModelConfig {
  id: string;
  apiType: LlmApiType;
}

export interface LlmRequestOptions {
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
}

function inferApiType(modelId: string): LlmApiType {
  if (modelId.startsWith("gemini")) return "gemini";
  if (modelId.startsWith("grok")) return "xai";
  return "openai";
}

function apiReasoningEffort(
  effort?: ReasoningEffort,
): Exclude<ReasoningEffort, "none"> | undefined {
  return effort && effort !== "none" ? effort : undefined;
}

function openaiTemperatureFor(
  model: string,
  temperature?: number,
): number | undefined {
  const normalized = model.toLowerCase();
  if (
    normalized.startsWith("gpt-5") ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4")
  ) {
    return undefined;
  }
  return temperature ?? 0.1;
}

function applyOpenAiReasoningEffort(
  body: Record<string, unknown>,
  effort?: ReasoningEffort,
) {
  const reasoningEffort = apiReasoningEffort(effort);
  if (reasoningEffort) {
    body.reasoning_effort = reasoningEffort;
  }
}

function applyResponsesReasoning(
  body: Record<string, unknown>,
  effort?: ReasoningEffort,
) {
  const reasoningEffort = apiReasoningEffort(effort ?? "medium");
  if (reasoningEffort) {
    body.reasoning = { effort: reasoningEffort };
  }
}

function responsesOutputText(data: any): string {
  if (typeof data?.output_text === "string" && data.output_text) {
    return data.output_text.trim();
  }
  const texts: string[] = [];
  for (const item of data?.output ?? []) {
    for (const part of item?.content ?? []) {
      if (part?.type === "output_text" && part?.text) {
        texts.push(String(part.text));
      }
    }
  }
  return texts.join("").trim();
}

export class LlmClient {
  private models: LlmModelConfig[];

  constructor(models: string | string[]) {
    const list = Array.isArray(models) ? models : [models];
    this.models = list.map((id) => ({ id, apiType: inferApiType(id) }));
    if (!this.models.length) {
      throw new Error("少なくとも1つのモデルが必要です");
    }
  }

  /**
   * テキストプロンプトを実行してJSON文字列を返す（fallback対応）
   */
  async extractData(
    prompt: string,
    options: LlmRequestOptions = {},
  ): Promise<string> {
    let lastError: unknown = null;
    for (const model of this.models) {
      try {
        const content = await this.callModel(model, prompt, options);
        return stripJsonFences(content);
      } catch (e) {
        lastError = e;
        console.warn(`モデル ${model.id} でエラー: ${String(e)}`);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("全てのモデルで処理に失敗しました");
  }

  /**
   * 画像 + テキストで解析（マルチモーダル）
   * @param imageBase64 base64エンコード済み画像（プレフィックスなし）
   * @param mimeType "image/jpeg" 等
   */
  async analyzeImage(
    imageBase64: string,
    mimeType: string,
    prompt: string,
    options: LlmRequestOptions = {},
  ): Promise<string> {
    let lastError: unknown = null;
    for (const model of this.models) {
      try {
        const content = await this.callModelWithImage(
          model,
          imageBase64,
          mimeType,
          prompt,
          options,
        );
        return stripJsonFences(content);
      } catch (e) {
        lastError = e;
        console.warn(`モデル ${model.id} で画像解析エラー: ${String(e)}`);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("全てのモデルで画像解析に失敗しました");
  }

  private async callModel(
    model: LlmModelConfig,
    prompt: string,
    options: LlmRequestOptions,
  ): Promise<string> {
    const apiKey = await getApiKey(model.apiType);
    if (!apiKey) {
      throw new Error(
        `${model.apiType} のAPIキーが未設定です（モデル: ${model.id}）`,
      );
    }

    if (model.apiType === "gemini") {
      return geminiGenerate(apiKey, model.id, prompt);
    }
    if (model.apiType === "xai") {
      return xaiGenerate(apiKey, model.id, prompt);
    }
    return openaiGenerate(apiKey, model.id, prompt, options);
  }

  private async callModelWithImage(
    model: LlmModelConfig,
    imageBase64: string,
    mimeType: string,
    prompt: string,
    options: LlmRequestOptions,
  ): Promise<string> {
    const apiKey = await getApiKey(model.apiType);
    if (!apiKey) {
      throw new Error(
        `${model.apiType} のAPIキーが未設定です（モデル: ${model.id}）`,
      );
    }

    if (model.apiType === "gemini") {
      return geminiAnalyzeImage(apiKey, model.id, imageBase64, mimeType, prompt);
    }
    return openaiAnalyzeImage(
      apiKey,
      model.id,
      imageBase64,
      mimeType,
      prompt,
      options,
    );
  }
}

// --- Gemini ---

async function geminiGenerate(
  apiKey: string,
  model: string,
  prompt: string,
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              "あなたはHTMLを解析してデータを抽出する専門家です。常にJSON形式で回答してください。\n\n" +
              prompt,
          },
        ],
      },
    ],
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini API エラー (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const content =
    data?.candidates?.[0]?.content?.parts?.[0]?.text ??
    data?.candidates?.[0]?.output ??
    "";
  if (!content) {
    throw new Error("Gemini APIレスポンスが空です");
  }
  return String(content).trim();
}

async function geminiAnalyzeImage(
  apiKey: string,
  model: string,
  imageBase64: string,
  mimeType: string,
  prompt: string,
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: mimeType,
              data: imageBase64,
            },
          },
        ],
      },
    ],
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini画像API エラー (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const content =
    data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  if (!content) {
    throw new Error("Gemini画像APIレスポンスが空です");
  }
  return String(content).trim();
}

// --- OpenAI ---

async function openaiGenerate(
  apiKey: string,
  model: string,
  prompt: string,
  options: LlmRequestOptions,
): Promise<string> {
  if (model === "gpt-5.6-sol") {
    return openaiResponsesGenerate(apiKey, model, prompt, options);
  }
  const body: any = {
    model,
    messages: [
      {
        role: "system",
        content:
          "あなたはHTMLを解析してデータを抽出する専門家です。常にJSON形式で回答してください。",
      },
      { role: "user", content: prompt },
    ],
  };
  const temperature = openaiTemperatureFor(model, options.temperature);
  if (temperature !== undefined) {
    body.temperature = temperature;
  }
  applyOpenAiReasoningEffort(body, options.reasoningEffort);
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI API エラー (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? "";
  if (!content) {
    throw new Error("OpenAI APIレスポンスが空です");
  }
  return String(content).trim();
}

async function openaiResponsesGenerate(
  apiKey: string,
  model: string,
  prompt: string,
  options: LlmRequestOptions,
): Promise<string> {
  const body: any = {
    model,
    instructions:
      "あなたはHTMLを解析してデータを抽出する専門家です。常にJSON形式で回答してください。",
    input: prompt,
  };
  applyResponsesReasoning(body, options.reasoningEffort);
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI Responses API エラー (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = responsesOutputText(data);
  if (!content) {
    throw new Error("OpenAI Responses APIレスポンスが空です");
  }
  return content;
}

async function openaiAnalyzeImage(
  apiKey: string,
  model: string,
  imageBase64: string,
  mimeType: string,
  prompt: string,
  options: LlmRequestOptions,
): Promise<string> {
  if (model === "gpt-5.6-sol") {
    return openaiResponsesAnalyzeImage(
      apiKey,
      model,
      imageBase64,
      mimeType,
      prompt,
      options,
    );
  }
  const body: any = {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "image_url",
            image_url: { url: `data:${mimeType};base64,${imageBase64}` },
          },
        ],
      },
    ],
  };
  const temperature = openaiTemperatureFor(model, options.temperature);
  if (temperature !== undefined) {
    body.temperature = temperature;
  }
  applyOpenAiReasoningEffort(body, options.reasoningEffort);
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `OpenAI画像API エラー (${res.status}): ${text.slice(0, 300)}`,
    );
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? "";
  if (!content) {
    throw new Error("OpenAI画像APIレスポンスが空です");
  }
  return String(content).trim();
}

async function openaiResponsesAnalyzeImage(
  apiKey: string,
  model: string,
  imageBase64: string,
  mimeType: string,
  prompt: string,
  options: LlmRequestOptions,
): Promise<string> {
  const body: any = {
    model,
    instructions: "画像を解析して、指定されたJSON形式で回答してください。",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          {
            type: "input_image",
            image_url: `data:${mimeType};base64,${imageBase64}`,
          },
        ],
      },
    ],
  };
  applyResponsesReasoning(body, options.reasoningEffort);
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `OpenAI Responses画像API エラー (${res.status}): ${text.slice(0, 300)}`,
    );
  }
  const data = await res.json();
  const content = responsesOutputText(data);
  if (!content) {
    throw new Error("OpenAI Responses画像APIレスポンスが空です");
  }
  return content;
}

// --- xAI (Grok) ---

async function xaiGenerate(
  apiKey: string,
  model: string,
  prompt: string,
): Promise<string> {
  const body = {
    model,
    messages: [
      {
        role: "system",
        content: "常にJSON形式で回答してください。",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.2,
  };
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`xAI API エラー (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? "";
  if (!content) {
    throw new Error("xAI APIレスポンスが空です");
  }
  return String(content).trim();
}

// --- ユーティリティ ---

function stripJsonFences(text: string): string {
  let t = text.trim();
  if (t.startsWith("```json")) t = t.slice(7);
  else if (t.startsWith("```")) t = t.slice(3);
  if (t.endsWith("```")) t = t.slice(0, -3);
  return t.trim();
}

/** APIキーの疎通テスト（最小リクエスト） */
export async function testApiKey(
  provider: ApiKeyProvider,
  apiKey: string,
  modelId?: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    if (provider === "gemini") {
      const model = modelId ?? "gemini-3-flash-preview";
      await geminiGenerate(apiKey, model, '{"ping":"ok"} と返してください');
      return { ok: true, message: "Gemini接続OK" };
    }
    if (provider === "openai") {
      const model = modelId ?? "gpt-5-mini";
      await openaiGenerate(apiKey, model, '{"ping":"ok"}と返してください', {});
      return { ok: true, message: "OpenAI接続OK" };
    }
    if (provider === "xai") {
      const model = modelId ?? "grok-2-latest";
      await xaiGenerate(apiKey, model, '{"ping":"ok"}と返してください');
      return { ok: true, message: "xAI接続OK" };
    }
    return { ok: false, message: "未対応プロバイダー" };
  } catch (e: any) {
    return { ok: false, message: `接続エラー: ${e?.message ?? String(e)}` };
  }
}

