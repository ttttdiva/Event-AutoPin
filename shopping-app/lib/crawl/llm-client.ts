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
import {
  fetchProviderModels,
  normalizeReasoningEffortForModel,
  reasoningEffortsForModel,
} from "../model-catalog";

export type LlmApiType = ApiKeyProvider;

export interface LlmModelConfig {
  id: string;
  apiType: LlmApiType;
  /**
   *候補ごとにeffortを持つ必要があるrole（サイト構造→本文fallback等）用。
   * 指定しない場合はextractData/analyzeImageのoptionsを使用する。
   */
  reasoningEffort?: ReasoningEffort;
}

export type LlmModelInput = string | LlmModelConfig;

export interface LlmRequestOptions {
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
}

function inferApiType(modelId: string): LlmApiType {
  if (modelId.startsWith("gemini")) return "gemini";
  if (modelId.startsWith("grok")) return "xai";
  return "openai";
}

function normalizeModelInput(input: LlmModelInput): LlmModelConfig {
  if (typeof input === "string") {
    return { id: input, apiType: inferApiType(input) };
  }
  return {
    id: input.id,
    // 明示providerを必ず優先し、ID prefixから再推測しない。
    apiType: input.apiType,
    ...(input.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: input.reasoningEffort }),
  };
}

function modelKey(model: LlmModelConfig): string {
  return `${model.apiType}\u0000${model.id}`;
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
  // 未知モデルのAPI metadataを根拠にmedium等を推測しない。none/未指定は
  // Responses APIの既定値へ委ねるため、reasoning自体を省略する。
  const reasoningEffort = apiReasoningEffort(effort);
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

  constructor(models: LlmModelInput | LlmModelInput[]) {
    const list = Array.isArray(models) ? models : [models];
    const seen = new Set<string>();
    this.models = [];
    for (const input of list) {
      const model = normalizeModelInput(input);
      if (!model.id || seen.has(modelKey(model))) continue;
      seen.add(modelKey(model));
      this.models.push(model);
    }
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
        const modelOptions = optionsForModel(model, options);
        const content = await this.callModel(model, prompt, modelOptions);
        return stripJsonFences(content);
      } catch (e) {
        lastError = e;
        // API応答本文（promptや秘密値を含み得る）はログに出さない。
        console.warn(`モデル ${model.apiType}/${model.id} でエラー`);
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
        const modelOptions = optionsForModel(model, options);
        const content = await this.callModelWithImage(
          model,
          imageBase64,
          mimeType,
          prompt,
          modelOptions,
        );
        return stripJsonFences(content);
      } catch (e) {
        lastError = e;
        // API応答本文（画像dataを含み得る）はログに出さない。
        console.warn(`モデル ${model.apiType}/${model.id} で画像解析エラー`);
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
      return geminiGenerate(apiKey, model.id, prompt, options);
    }
    if (model.apiType === "xai") {
      return xaiGenerate(apiKey, model.id, prompt, options);
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
      return geminiAnalyzeImage(
        apiKey,
        model.id,
        imageBase64,
        mimeType,
        prompt,
        options,
      );
    }
    if (model.apiType === "xai") {
      return xaiAnalyzeImage(
        apiKey,
        model.id,
        imageBase64,
        mimeType,
        prompt,
        options,
      );
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

function optionsForModel(
  model: LlmModelConfig,
  options: LlmRequestOptions,
): LlmRequestOptions {
  const requested = model.reasoningEffort ?? options.reasoningEffort;
  // APIがeffort metadataを広告しない候補（未知IDやxAI）はmodel-catalogの
  // pure helperに従ってnoneへ正規化し、別providerのOpenAI値を転送しない。
  return {
    ...options,
    reasoningEffort: normalizeReasoningEffortForModel(
      model.apiType,
      model.id,
      requested,
    ),
  };
}

async function fetchApiResponse(
  providerLabel: string,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    // fetchの例外にURL（Geminiのquery keyを含む）が混ざる実装があるため、
    // 元の例外をそのままログ・上位へ渡さない。
    throw new Error(`${providerLabel} APIへの接続に失敗しました`);
  }
  if (!res.ok) {
    // 応答本文にはプロンプト・認証情報・プロバイダー内部情報が混ざり得る。
    throw new Error(`${providerLabel} APIエラー (${res.status})`);
  }
  return res;
}

async function readApiJson<T>(
  providerLabel: string,
  res: Response,
): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(`${providerLabel} API応答の解析に失敗しました`);
  }
}

// --- Gemini ---

async function geminiGenerate(
  apiKey: string,
  model: string,
  prompt: string,
  options: LlmRequestOptions = {},
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body: Record<string, unknown> = {
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
  const generationConfig = geminiGenerationConfig(model, options.reasoningEffort);
  if (generationConfig) body.generationConfig = generationConfig;
  const res = await fetchApiResponse("Gemini", url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });
  const data = await readApiJson<any>("Gemini", res);
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
  options: LlmRequestOptions = {},
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body: Record<string, unknown> = {
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
  const generationConfig = geminiGenerationConfig(model, options.reasoningEffort);
  if (generationConfig) body.generationConfig = generationConfig;
  const res = await fetchApiResponse("Gemini画像", url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });
  const data = await readApiJson<any>("Gemini画像", res);
  const content =
    data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  if (!content) {
    throw new Error("Gemini画像APIレスポンスが空です");
  }
  return String(content).trim();
}

function geminiGenerationConfig(
  model: string,
  effort?: ReasoningEffort,
): Record<string, unknown> | undefined {
  const normalizedModel = model.trim().toLowerCase();
  if (!normalizedModel.startsWith("gemini-3")) return undefined;
  if (!effort || effort === "none") return undefined;
  // モデルカタログが広告・既知対応として許可した値だけを送る。
  const supported = reasoningEffortsForModel("gemini", model);
  if (!supported.includes(effort)) return undefined;
  return { thinkingConfig: { thinkingLevel: effort } };
}

// --- OpenAI ---

// Responses APIをまだ提供していない既知のChat Completions専用モデルだけを
// ここに限定する。新しい生成モデルIDは個別追加なしでResponsesへ送る。
const KNOWN_LEGACY_CHAT_MODELS = new Set([
  "gpt-3.5-turbo",
  "gpt-3.5-turbo-0125",
  "gpt-3.5-turbo-1106",
  "gpt-3.5-turbo-0613",
  "gpt-3.5-turbo-16k",
  "gpt-3.5-turbo-16k-0613",
  "gpt-4",
  "gpt-4-0314",
  "gpt-4-0613",
  "gpt-4-32k",
  "gpt-4-32k-0314",
  "gpt-4-32k-0613",
  "gpt-4-1106-preview",
  "gpt-4-0125-preview",
  "gpt-4-turbo",
  "gpt-4-turbo-preview",
  "gpt-4o",
  "gpt-4o-2024-05-13",
  "gpt-4o-2024-08-06",
  "gpt-4o-2024-11-20",
  "gpt-4o-mini",
  "gpt-4o-mini-2024-07-18",
  "chatgpt-4o-latest",
]);

function usesLegacyChatCompletions(model: string): boolean {
  return KNOWN_LEGACY_CHAT_MODELS.has(model.toLowerCase());
}

async function openaiGenerate(
  apiKey: string,
  model: string,
  prompt: string,
  options: LlmRequestOptions,
): Promise<string> {
  if (!usesLegacyChatCompletions(model)) {
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
  const res = await fetchApiResponse("OpenAI", "https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const data = await readApiJson<any>("OpenAI", res);
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
  const res = await fetchApiResponse("OpenAI Responses", "https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const data = await readApiJson<any>("OpenAI Responses", res);
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
  if (!usesLegacyChatCompletions(model)) {
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
  const res = await fetchApiResponse("OpenAI画像", "https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const data = await readApiJson<any>("OpenAI画像", res);
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
  const res = await fetchApiResponse("OpenAI Responses画像", "https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const data = await readApiJson<any>("OpenAI Responses画像", res);
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
  options: LlmRequestOptions = {},
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages: [
      {
        role: "system",
        content: "常にJSON形式で回答してください。",
      },
      { role: "user", content: prompt },
    ],
    temperature: options.temperature ?? 0.2,
  };
  applyOpenAiReasoningEffort(body, options.reasoningEffort);
  const res = await fetchApiResponse("xAI", "https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const data = await readApiJson<any>("xAI", res);
  const content = data?.choices?.[0]?.message?.content ?? "";
  if (!content) {
    throw new Error("xAI APIレスポンスが空です");
  }
  return String(content).trim();
}

async function xaiAnalyzeImage(
  apiKey: string,
  model: string,
  imageBase64: string,
  mimeType: string,
  prompt: string,
  options: LlmRequestOptions = {},
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages: [
      {
        role: "system",
        content: "常にJSON形式で回答してください。",
      },
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
    temperature: options.temperature ?? 0.2,
  };
  applyOpenAiReasoningEffort(body, options.reasoningEffort);
  const res = await fetchApiResponse("xAI画像", "https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const data = await readApiJson<any>("xAI画像", res);
  const content = data?.choices?.[0]?.message?.content ?? "";
  if (!content) {
    throw new Error("xAI画像APIレスポンスが空です");
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
  _modelId?: string,
): Promise<{ ok: boolean; message: string }> {
  if (provider !== "openai" && provider !== "gemini" && provider !== "xai") {
    return { ok: false, message: "未対応プロバイダー" };
  }
  try {
    // 固定modelへのcompletion probeは廃止し、read-onlyのモデル一覧だけを取得する。
    // _modelIdは既存UI/呼び出し元との3引数互換のため受けるが、通信には使わない。
    const models = await fetchProviderModels(provider, apiKey);
    return { ok: true, message: `${provider}モデル一覧取得OK（${models.length}件）` };
  } catch (error) {
    // CatalogFetchErrorの公開型に依存せず、statusと安全な分類だけを表示する。
    // 応答本文・API key・元例外messageは絶対に返さない。
    const details =
      error && typeof error === "object" && "details" in error
        ? (error as { details?: { kind?: string; status?: unknown } }).details
        : undefined;
    const status =
      typeof details?.status === "number" && Number.isFinite(details.status)
        ? details.status
        : undefined;
    if (details?.kind === "credential-missing") {
      return { ok: false, message: `${provider} APIキーが未設定です` };
    }
    return {
      ok: false,
      message: `${provider}モデル一覧取得失敗${status === undefined ? "" : ` (HTTP ${status})`}`,
    };
  }
}

