/**
 * API プロバイダーのモデルカタログ。
 *
 * モデル一覧は API の read-only endpoint から都度取得する。API キーや
 * レスポンス本文はこのモジュールの状態・SQLite・ログへ保存しない。取得に
 * 失敗した場合は、同じプロバイダーのメモリ上の直前候補を stale として
 * 保持するので、保存済み設定を勝手に変更せずに再取得できる。
 */
import {
  getAllApiKeys,
  type ApiKeyProvider,
  type ReasoningEffort,
  type SavedModelSelection,
} from "./settings-store";

export type ModelCapabilityStatus = "verified" | "unsupported" | "unknown";
export type ModelCatalogSource =
  | "seed"
  | "provider-api"
  | "saved"
  | "stale-cache";
export type ModelCatalogRole = "text" | "vision";

export interface ModelCatalogEntry {
  id: string;
  label: string;
  provider: ApiKeyProvider;
  /** テキスト生成能力。provider のモデル一覧に出た生成モデルは verified。 */
  text: ModelCapabilityStatus;
  /** 画像入力能力。API が広告しない場合は unknown のままにする。 */
  vision: ModelCapabilityStatus;
  capabilityStatus: ModelCapabilityStatus;
  /** API へ送ってよい既知の effort。unknown は none のみ（API 既定）。 */
  reasoningEfforts: readonly ReasoningEffort[];
  source: ModelCatalogSource;
  fetchedAt?: string;
  stale?: boolean;
}

export interface ModelCapabilityInfo {
  text: ModelCapabilityStatus;
  /** mobile 側の名称。desktop と共有しやすい image alias も返す。 */
  vision: ModelCapabilityStatus;
  image: ModelCapabilityStatus;
  capabilityStatus: ModelCapabilityStatus;
  reasoningEfforts: readonly ReasoningEffort[];
  supportedReasoningEfforts: readonly ReasoningEffort[];
}

export type ProviderCatalogStatus =
  | "idle"
  | "loading"
  | "ready"
  | "error"
  | "credential-missing";

export type CatalogErrorKind =
  | "credential-missing"
  | "auth"
  | "rate-limit"
  | "http"
  | "network"
  | "invalid-response";

export interface ModelCatalogError {
  kind: CatalogErrorKind;
  /** HTTP status のみ。レスポンス本文・API キーは含めない。 */
  status?: number;
  message: string;
}

export interface ProviderCatalogState {
  provider: ApiKeyProvider;
  status: ProviderCatalogStatus;
  models: ModelCatalogEntry[];
  error: ModelCatalogError | null;
  fetchedAt: string | null;
  stale: boolean;
  generation: number;
}

export interface ModelCatalogSnapshot {
  providers: Record<ApiKeyProvider, ProviderCatalogState>;
}

export interface CatalogResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

type CatalogJson = Record<string, unknown> | unknown[];

export type CatalogFetchImplementation = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: unknown;
  },
) => Promise<CatalogResponse>;

export interface FetchProviderModelsOptions {
  fetchImpl?: CatalogFetchImplementation;
  timeoutMs?: number;
}

export interface RefreshModelCatalogOptions extends FetchProviderModelsOptions {
  /** テスト・呼び出し元でキーを明示する場合のみ使う。状態へ保存しない。 */
  apiKey?: string | null;
  apiKeys?: Partial<Record<ApiKeyProvider, string | null>>;
  now?: () => Date;
  providers?: readonly ApiKeyProvider[];
}

export const MODEL_CATALOG_PROVIDERS: readonly ApiKeyProvider[] = [
  "openai",
  "gemini",
  "xai",
];

const NO_REASONING_EFFORTS: readonly ReasoningEffort[] = ["none"];
const GPT_56_REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const GPT_5_REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
];
const GEMINI_3_REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
];

/**
 * 初回表示・未取得時の互換候補。これらは API 取得済みとは表示しない。
 * 新しいモデルをここへ追加しても、既存の保存値や effort は変更されない。
 */
export const MODEL_CATALOG_SEEDS: readonly ModelCatalogEntry[] = [
  {
    id: "gemini-3-flash-preview",
    label: "Gemini 3 Flash (推奨・安価)",
    provider: "gemini",
    text: "verified",
    vision: "verified",
    capabilityStatus: "verified",
    reasoningEfforts: GEMINI_3_REASONING_EFFORTS,
    source: "seed",
  },
  {
    id: "gemini-3.1-pro-preview",
    label: "Gemini 3 Pro (高性能)",
    provider: "gemini",
    text: "verified",
    vision: "verified",
    capabilityStatus: "verified",
    reasoningEfforts: GEMINI_3_REASONING_EFFORTS,
    source: "seed",
  },
  {
    id: "gemini-3.1-flash-lite-preview",
    label: "Gemini 3 Flash Lite (最安)",
    provider: "gemini",
    text: "verified",
    vision: "verified",
    capabilityStatus: "verified",
    reasoningEfforts: GEMINI_3_REASONING_EFFORTS,
    source: "seed",
  },
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol (高性能)",
    provider: "openai",
    text: "verified",
    vision: "verified",
    capabilityStatus: "verified",
    reasoningEfforts: GPT_56_REASONING_EFFORTS,
    source: "seed",
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra (高性能)",
    provider: "openai",
    text: "verified",
    vision: "verified",
    capabilityStatus: "verified",
    reasoningEfforts: GPT_56_REASONING_EFFORTS,
    source: "seed",
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna (高速)",
    provider: "openai",
    text: "verified",
    vision: "verified",
    capabilityStatus: "verified",
    reasoningEfforts: GPT_56_REASONING_EFFORTS,
    source: "seed",
  },
  {
    id: "gpt-5-mini",
    label: "GPT-5 Mini",
    provider: "openai",
    text: "verified",
    vision: "verified",
    capabilityStatus: "verified",
    reasoningEfforts: GPT_5_REASONING_EFFORTS,
    source: "seed",
  },
  {
    id: "gpt-5.4",
    label: "GPT-5.4 (高性能)",
    provider: "openai",
    text: "verified",
    vision: "verified",
    capabilityStatus: "verified",
    reasoningEfforts: GPT_5_REASONING_EFFORTS,
    source: "seed",
  },
];

const SPECIAL_MODEL_ID_PATTERN =
  /(?:embedding|(?:^|[-_])embed(?:$|[-_])|dall-e|gpt-image|imagen|imagegen|image-generation|audio|tts(?:-|$)|whisper|transcri|moderation|safety-only)/i;
const RETIRED_MODEL_ID_PATTERN = /(?:retired|deprecated|decommissioned)/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      const record = asRecord(item);
      return stringValue(record?.name) ?? stringValue(record?.type);
    })
    .filter((item): item is string => Boolean(item))
    .map((item) => item.toLowerCase());
}

function modalityValueStrings(value: unknown): string[] {
  if (typeof value === "string") return [value.toLowerCase()];
  if (Array.isArray(value)) return value.flatMap((item) => modalityValueStrings(item));
  const record = asRecord(value);
  if (!record) return [];
  const direct = [record.name, record.type]
    .map((item) => stringValue(item)?.toLowerCase())
    .filter((item): item is string => Boolean(item));
  if (direct.length) return direct;
  return Object.values(record).flatMap((item) => modalityValueStrings(item));
}

function normalizeEfforts(value: unknown): readonly ReasoningEffort[] | null {
  const raw = stringArray(value);
  const allowed: ReasoningEffort[] = [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ];
  const efforts = allowed.filter((effort) => raw.includes(effort));
  return efforts.length ? efforts : null;
}

function isGpt56GeneralModel(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return (
    normalized === "gpt-5.6" ||
    ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].some(
      (id) => normalized === id || normalized.startsWith(`${id}-`),
    )
  );
}

/** 既知モデルの effort。未知 ID へ medium/high を推測して返さない。 */
export function reasoningEffortsForKnownModel(
  provider: ApiKeyProvider,
  modelId: string,
): readonly ReasoningEffort[] {
  const normalized = modelId.trim().toLowerCase();
  if (provider === "openai") {
    if (isGpt56GeneralModel(normalized)) return GPT_56_REASONING_EFFORTS;
    if (normalized === "gpt-5-pro" || normalized === "gpt-5.2-pro") {
      return ["high"];
    }
    if (normalized === "gpt-5-mini" || normalized === "gpt-5.4") {
      return GPT_5_REASONING_EFFORTS;
    }
    // /v1/models が effort metadata を広告しない未知 ID（例えば
    // gpt-5.6-cyber / 将来の gpt-5.x）へ、ID prefix だけで medium 等を推測しない。
    return NO_REASONING_EFFORTS;
  }
  if (provider === "gemini" && normalized.startsWith("gemini-3")) {
    return GEMINI_3_REASONING_EFFORTS;
  }
  return NO_REASONING_EFFORTS;
}

/** API から広告されない専用モデルを text/vision role へ混ぜない。 */
export function isKnownUnsupportedModel(modelId: string, raw?: unknown): boolean {
  const normalized = modelId.trim();
  if (!normalized || SPECIAL_MODEL_ID_PATTERN.test(normalized)) return true;
  if (RETIRED_MODEL_ID_PATTERN.test(normalized)) return true;
  const record = asRecord(raw);
  const status = stringValue(record?.status)?.toLowerCase();
  const availability = stringValue(record?.availability)?.toLowerCase();
  return (
    status === "retired" ||
    status === "deprecated" ||
    availability === "retired" ||
    availability === "deprecated"
  );
}

function knownSeed(provider: ApiKeyProvider, id: string): ModelCatalogEntry | null {
  return (
    MODEL_CATALOG_SEEDS.find(
      (entry) => entry.provider === provider && entry.id === id,
    ) ?? null
  );
}

function knownCapabilityStatus(
  provider: ApiKeyProvider,
  id: string,
): ModelCapabilityInfo {
  const seed = knownSeed(provider, id);
  if (seed) {
    return {
      text: seed.text,
      vision: seed.vision,
      image: seed.vision,
      capabilityStatus: seed.capabilityStatus,
      reasoningEfforts: seed.reasoningEfforts,
      supportedReasoningEfforts: seed.reasoningEfforts,
    };
  }
  const efforts = reasoningEffortsForKnownModel(provider, id);
  return {
    text: "unknown",
    vision: "unknown",
    image: "unknown",
    capabilityStatus: "unknown",
    reasoningEfforts: efforts,
    supportedReasoningEfforts: efforts,
  };
}

function modalityStrings(record: Record<string, unknown>): string[] {
  const values: string[] = [];
  for (const key of [
    "input_modalities",
    "inputModalities",
    "modalities",
    "supported_modalities",
    "supportedModalities",
  ]) {
    values.push(...modalityValueStrings(record[key]));
  }
  const capabilities = asRecord(record.capabilities);
  if (capabilities) {
    for (const key of ["input", "inputs", "modalities", "vision"]) {
      values.push(...modalityValueStrings(capabilities[key]));
      if (capabilities[key] === true && key === "vision") values.push("image");
    }
  }
  return values;
}

function explicitVisionCapability(
  record: Record<string, unknown>,
): ModelCapabilityStatus {
  const inputKeys = ["input_modalities", "inputModalities", "input_types"];
  const hasExplicitInput = inputKeys.some((key) => record[key] !== undefined);
  const modalities = modalityStrings(record);
  const vision = modalities.some((modality) =>
    /image|vision|picture|multimodal|visual/.test(modality),
  );
  if (vision) return "verified";
  if (hasExplicitInput) return "unsupported";
  return "unknown";
}

function explicitTextCapability(
  record: Record<string, unknown>,
): ModelCapabilityStatus {
  const values: string[] = [];
  for (const key of [
    "output_modalities",
    "outputModalities",
    "modalities",
    "supported_modalities",
    "supportedModalities",
  ]) {
    values.push(...modalityValueStrings(record[key]));
  }
  const capabilities = asRecord(record.capabilities);
  if (capabilities) {
    for (const key of ["output", "outputs", "modalities", "text"]) {
      values.push(...modalityValueStrings(capabilities[key]));
      if (capabilities[key] === true && key === "text") values.push("text");
    }
  }
  if (values.some((value) => /text|language|token/.test(value))) return "verified";
  const hasExplicitOutput = [
    "output_modalities",
    "outputModalities",
    "output_types",
  ].some((key) => record[key] !== undefined);
  return hasExplicitOutput ? "unsupported" : "unknown";
}

function explicitReasoningEfforts(record: Record<string, unknown>): readonly ReasoningEffort[] | null {
  for (const key of [
    "reasoning_efforts",
    "reasoningEfforts",
    "supported_reasoning_efforts",
    "supportedReasoningEfforts",
  ]) {
    if (record[key] !== undefined) return normalizeEfforts(record[key]);
  }
  const capabilities = asRecord(record.capabilities);
  if (capabilities) {
    for (const key of ["reasoning_efforts", "reasoningEfforts"]) {
      if (capabilities[key] !== undefined) return normalizeEfforts(capabilities[key]);
    }
  }
  return null;
}

function modelLabel(id: string, raw?: Record<string, unknown>): string {
  return (
    stringValue(raw?.displayName) ??
    stringValue(raw?.display_name) ??
    knownSeed("openai", id)?.label ??
    knownSeed("gemini", id)?.label ??
    id
  );
}

function entryFromApiModel(
  provider: ApiKeyProvider,
  id: string,
  raw?: unknown,
  textFromProviderMetadata?: ModelCapabilityStatus,
): ModelCatalogEntry {
  const record = asRecord(raw) ?? {};
  const known = knownCapabilityStatus(provider, id);
  const explicitVision = explicitVisionCapability(record);
  const vision =
    explicitVision === "unknown" ? known.vision : explicitVision;
  const explicitText = textFromProviderMetadata ?? explicitTextCapability(record);
  const text =
    known.text !== "unknown"
      ? known.text
      : explicitText;
  const efforts = explicitReasoningEfforts(record) ?? known.reasoningEfforts;
  const capabilityStatus =
    text === "verified" && vision === "verified" ? "verified" : "unknown";
  return {
    id,
    label: modelLabel(id, record),
    provider,
    text,
    vision,
    capabilityStatus,
    reasoningEfforts: efforts,
    source: "provider-api",
  };
}

function assertResponseOk(response: CatalogResponse, provider: ApiKeyProvider): void {
  const ok = response.ok ?? (response.status >= 200 && response.status < 300);
  if (ok && response.status >= 200 && response.status < 300) return;
  const status = Number.isFinite(response.status) ? response.status : undefined;
  let kind: CatalogErrorKind = "http";
  if (status === 401 || status === 403) kind = "auth";
  else if (status === 429) kind = "rate-limit";
  const message =
    kind === "auth"
      ? `${provider} のAPI認証に失敗しました`
      : kind === "rate-limit"
        ? `${provider} のAPI利用制限に達しました`
        : `${provider} のモデル一覧取得に失敗しました`;
  throw new CatalogFetchError({ kind, status, message });
}

export class CatalogFetchError extends Error {
  readonly details: ModelCatalogError;
  readonly kind: CatalogErrorKind;
  readonly status?: number;

  constructor(details: ModelCatalogError) {
    super(details.message);
    this.name = "CatalogFetchError";
    this.details = details;
    this.kind = details.kind;
    this.status = details.status;
  }
}

async function readJson(
  response: CatalogResponse,
  provider: ApiKeyProvider,
): Promise<CatalogJson> {
  try {
    const value = await response.json();
    const record = asRecord(value);
    if (record) return record;
    if (Array.isArray(value)) return value;
    throw new Error("not an object or array");
  } catch {
    throw new CatalogFetchError({
      kind: "invalid-response",
      message: `${provider} のモデル一覧の形式を確認できませんでした`,
    });
  }
}

function defaultFetch(): CatalogFetchImplementation {
  const candidate = (globalThis as { fetch?: CatalogFetchImplementation }).fetch;
  if (!candidate) {
    throw new CatalogFetchError({
      kind: "network",
      message: "モデル一覧を取得できる通信機能がありません",
    });
  }
  return candidate;
}

async function requestJson(
  provider: ApiKeyProvider,
  fetchImpl: CatalogFetchImplementation,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<CatalogJson> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: { signal?: unknown; abort?: () => void } | undefined;
  try {
    const AbortControllerCtor = (globalThis as { AbortController?: new () => { signal: unknown; abort(): void } }).AbortController;
    if (AbortControllerCtor) controller = new AbortControllerCtor();
    const request = fetchImpl(url, {
      method: "GET",
      headers,
      signal: controller?.signal,
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller?.abort?.();
        reject(new CatalogFetchError({ kind: "network", message: `${provider} のモデル一覧取得がタイムアウトしました` }));
      }, timeoutMs);
    });
    const response = await Promise.race([request, timeout]);
    assertResponseOk(response, provider);
    return await readJson(response, provider);
  } catch (error) {
    if (error instanceof CatalogFetchError) throw error;
    throw new CatalogFetchError({
      kind: "network",
      message: `${provider} のモデル一覧を取得できませんでした`,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function dedupeModels(models: ModelCatalogEntry[]): ModelCatalogEntry[] {
  const byKey = new Map<string, ModelCatalogEntry>();
  const priority: Record<ModelCatalogSource, number> = {
    seed: 1,
    saved: 2,
    "stale-cache": 3,
    "provider-api": 4,
  };
  for (const model of models) {
    const key = `${model.provider}:${model.id}`;
    const previous = byKey.get(key);
    if (!previous || priority[model.source] > priority[previous.source]) {
      byKey.set(key, model);
    }
  }
  return Array.from(byKey.values());
}

function parseOpenAiModels(payload: CatalogJson): ModelCatalogEntry[] {
  const record = asRecord(payload) ?? {};
  if (!Array.isArray(record.data)) {
    throw new CatalogFetchError({
      kind: "invalid-response",
      message: "openai のモデル一覧の形式を確認できませんでした",
    });
  }
  const items = record.data;
  const models: ModelCatalogEntry[] = [];
  for (const item of items) {
    const record = asRecord(item);
    const id = stringValue(record?.id);
    if (!id || isKnownUnsupportedModel(id, record)) continue;
    models.push(entryFromApiModel("openai", id, record));
  }
  return dedupeModels(models);
}

function parseGeminiModels(payload: CatalogJson): ModelCatalogEntry[] {
  const recordPayload = asRecord(payload) ?? {};
  if (!Array.isArray(recordPayload.models)) {
    throw new CatalogFetchError({
      kind: "invalid-response",
      message: "gemini のモデル一覧の形式を確認できませんでした",
    });
  }
  const items = recordPayload.models;
  const models: ModelCatalogEntry[] = [];
  for (const item of items) {
    const record = asRecord(item);
    const rawName = stringValue(record?.name);
    const id = rawName?.replace(/^models\//, "") ?? stringValue(record?.id);
    if (!id || isKnownUnsupportedModel(id, record)) continue;
    const methods = stringArray(record?.supportedGenerationMethods);
    if (methods.length && !methods.includes("generatecontent")) continue;
    models.push(
      entryFromApiModel(
        "gemini",
        id,
        record,
        methods.includes("generatecontent") ? "verified" : undefined,
      ),
    );
  }
  return dedupeModels(models);
}

function parseXaiModels(payload: CatalogJson): ModelCatalogEntry[] {
  const recordPayload = asRecord(payload);
  const items = Array.isArray(payload)
    ? payload
    : Array.isArray(recordPayload?.data)
      ? recordPayload.data
      : Array.isArray(recordPayload?.models)
        ? recordPayload.models
        : null;
  if (!items) {
    throw new CatalogFetchError({
      kind: "invalid-response",
      message: "xai のモデル一覧の形式を確認できませんでした",
    });
  }
  const models: ModelCatalogEntry[] = [];
  for (const item of items) {
    const record = asRecord(item);
    const id = stringValue(record?.id) ?? stringValue(record?.name);
    if (!id || isKnownUnsupportedModel(id, record)) continue;
    models.push(entryFromApiModel("xai", id, record));
  }
  return dedupeModels(models);
}

/**
 * 各 provider の read-only モデル一覧を取得する。completion probe は行わない。
 */
export async function fetchProviderModels(
  provider: ApiKeyProvider,
  apiKey: string | null | undefined,
  options: FetchProviderModelsOptions = {},
): Promise<ModelCatalogEntry[]> {
  if (!apiKey?.trim()) {
    throw new CatalogFetchError({
      kind: "credential-missing",
      message: `${provider} のAPIキーが未設定です`,
    });
  }
  const fetchImpl = options.fetchImpl ?? defaultFetch();
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (provider === "openai") {
    const body = await requestJson(
      provider,
      fetchImpl,
      "https://api.openai.com/v1/models",
      { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      timeoutMs,
    );
    return parseOpenAiModels(body);
  }
  if (provider === "xai") {
    const body = await requestJson(
      provider,
      fetchImpl,
      "https://api.x.ai/v1/language-models",
      { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      timeoutMs,
    );
    return parseXaiModels(body);
  }

  const models: ModelCatalogEntry[] = [];
  let pageToken: string | null = null;
  const seenPageTokens = new Set<string>();
  for (let page = 0; page < 50; page += 1) {
    const params = new URLSearchParams({ pageSize: "1000" });
    if (pageToken) params.set("pageToken", pageToken);
    const body = await requestJson(
      provider,
      fetchImpl,
      `https://generativelanguage.googleapis.com/v1beta/models?${params.toString()}`,
      { Accept: "application/json", "x-goog-api-key": apiKey },
      timeoutMs,
    );
    models.push(...parseGeminiModels(body));
    const next = stringValue(asRecord(body)?.nextPageToken);
    if (!next || seenPageTokens.has(next)) break;
    seenPageTokens.add(next);
    pageToken = next;
  }
  return dedupeModels(models);
}

/** 呼び出し側の命名差を吸収する互換 alias。 */
export const fetchModelsForProvider = fetchProviderModels;

function emptyProviderState(provider: ApiKeyProvider): ProviderCatalogState {
  return {
    provider,
    status: "idle",
    models: [],
    error: null,
    fetchedAt: null,
    stale: false,
    generation: 0,
  };
}

const providerStates: Record<ApiKeyProvider, ProviderCatalogState> = {
  openai: emptyProviderState("openai"),
  gemini: emptyProviderState("gemini"),
  xai: emptyProviderState("xai"),
};
const listeners = new Set<() => void>();

function notifyCatalogChanged(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // UI listener の例外でモデル取得処理を中断しない。
    }
  }
}

export function subscribeModelCatalog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getModelCatalogSnapshot(): ModelCatalogSnapshot {
  return {
    providers: {
      openai: { ...providerStates.openai, models: [...providerStates.openai.models] },
      gemini: { ...providerStates.gemini, models: [...providerStates.gemini.models] },
      xai: { ...providerStates.xai, models: [...providerStates.xai.models] },
    },
  };
}

/** 旧 UI / テストとの別名。 */
export const getModelCatalogState = getModelCatalogSnapshot;

function beginProviderRefresh(provider: ApiKeyProvider): number {
  const previous = providerStates[provider];
  const generation = previous.generation + 1;
  providerStates[provider] = {
    ...previous,
    status: "loading",
    error: null,
    stale: previous.models.length > 0,
    generation,
  };
  notifyCatalogChanged();
  return generation;
}

function isCurrentGeneration(provider: ApiKeyProvider, generation: number): boolean {
  return providerStates[provider].generation === generation;
}

function errorDetails(error: unknown, provider: ApiKeyProvider): ModelCatalogError {
  if (error instanceof CatalogFetchError) return error.details;
  return {
    kind: "network",
    message: `${provider} のモデル一覧を取得できませんでした`,
  };
}

async function refreshOneProvider(
  provider: ApiKeyProvider,
  generation: number,
  apiKey: string | null | undefined,
  options: RefreshModelCatalogOptions,
): Promise<void> {
  if (!isCurrentGeneration(provider, generation)) return;
  if (!apiKey?.trim()) {
    const previous = providerStates[provider];
    if (!isCurrentGeneration(provider, generation)) return;
    providerStates[provider] = {
      ...previous,
      status: "credential-missing",
      error: { kind: "credential-missing", message: `${provider} のAPIキーが未設定です` },
      stale: previous.models.length > 0,
    };
    notifyCatalogChanged();
    return;
  }
  try {
    const models = await fetchProviderModels(provider, apiKey, options);
    if (!isCurrentGeneration(provider, generation)) return;
    const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
    providerStates[provider] = {
      ...providerStates[provider],
      status: "ready",
      models: models.map((model) => ({ ...model, fetchedAt, source: "provider-api", stale: false })),
      error: null,
      fetchedAt,
      stale: false,
    };
    notifyCatalogChanged();
  } catch (error) {
    if (!isCurrentGeneration(provider, generation)) return;
    const previous = providerStates[provider];
    const details = errorDetails(error, provider);
    providerStates[provider] = {
      ...previous,
      status: details.kind === "credential-missing" ? "credential-missing" : "error",
      error: details,
      stale: previous.models.length > 0,
    };
    notifyCatalogChanged();
  }
}

/**
 * 指定 provider（省略時は全 provider）を更新する。generation で古いキーの
 * 遅延レスポンスが新しい状態を上書きしない。apiKey はテストまたは UI の
 * 呼び出しで明示した場合だけ使い、完了後に保持しない。
 */
export async function refreshModelCatalog(
  provider?: ApiKeyProvider,
  options: RefreshModelCatalogOptions = {},
): Promise<ModelCatalogSnapshot> {
  const providers = provider
    ? [provider]
    : [...(options.providers ?? MODEL_CATALOG_PROVIDERS)];
  const generations = new Map<ApiKeyProvider, number>();
  for (const current of providers) {
    generations.set(current, beginProviderRefresh(current));
  }

  let apiKeys: Partial<Record<ApiKeyProvider, string | null>> = options.apiKeys ?? {};
  if (options.apiKey !== undefined && provider) {
    apiKeys = { ...apiKeys, [provider]: options.apiKey };
  }
  if (
    options.apiKey === undefined &&
    !options.apiKeys &&
    typeof provider === "undefined"
  ) {
    try {
      apiKeys = await getAllApiKeys();
    } catch {
      apiKeys = {};
    }
  } else if (
    options.apiKey === undefined &&
    !options.apiKeys &&
    provider
  ) {
    try {
      const all = await getAllApiKeys();
      apiKeys = { [provider]: all[provider] };
    } catch {
      apiKeys = {};
    }
  }

  await Promise.all(
    providers.map((current) =>
      refreshOneProvider(current, generations.get(current)!, apiKeys[current], options),
    ),
  );
  return getModelCatalogSnapshot();
}

export const refreshModels = refreshModelCatalog;

function savedEntry(selection: SavedModelSelection): ModelCatalogEntry {
  const known = knownCapabilityStatus(selection.apiType, selection.id);
  return {
    id: selection.id,
    label: knownSeed(selection.apiType, selection.id)?.label ?? selection.id,
    provider: selection.apiType,
    text: knownCapabilityStatus(selection.apiType, selection.id).text,
    vision: known.vision,
    capabilityStatus: known.capabilityStatus,
    reasoningEfforts: known.reasoningEfforts,
    source: "saved",
  };
}

export interface ModelCatalogListOptions {
  role?: ModelCatalogRole;
  savedSelections?: readonly SavedModelSelection[];
  includeSeeds?: boolean;
}

/** UI picker 用。provider+id をキーにし、同名異 provider を混同しない。 */
export function getModelCatalogModels(
  options: ModelCatalogListOptions = {},
): ModelCatalogEntry[] {
  const entries: ModelCatalogEntry[] = [];
  if (options.includeSeeds !== false) entries.push(...MODEL_CATALOG_SEEDS);
  for (const provider of MODEL_CATALOG_PROVIDERS) {
    const state = providerStates[provider];
    entries.push(
      ...state.models.map((model) => ({
        ...model,
        source: state.stale
          ? ("stale-cache" as const)
          : ("provider-api" as const),
        stale: state.stale,
      })),
    );
  }
  for (const selection of options.savedSelections ?? []) {
    if (
      selection.id &&
      !isKnownUnsupportedModel(selection.id) &&
      !entries.some(
        (entry) => entry.provider === selection.apiType && entry.id === selection.id,
      )
    ) {
      entries.push(savedEntry(selection));
    }
  }
  const unique = dedupeModels(entries);
  if (options.role === "vision") {
    return unique.filter((entry) => entry.vision !== "unsupported");
  }
  if (options.role === "text") {
    return unique.filter((entry) => entry.text !== "unsupported");
  }
  return unique;
}

export const listModelCatalog = getModelCatalogModels;

export function getModelCapabilities(
  provider: ApiKeyProvider,
  modelId: string,
  entries?: readonly ModelCatalogEntry[],
): ModelCapabilityInfo {
  const source = entries ?? getModelCatalogModels();
  const entry = source.find(
    (candidate) => candidate.provider === provider && candidate.id === modelId,
  );
  if (entry) {
    return {
      text: entry.text,
      vision: entry.vision,
      image: entry.vision,
      capabilityStatus: entry.capabilityStatus,
      reasoningEfforts: entry.reasoningEfforts,
      supportedReasoningEfforts: entry.reasoningEfforts,
    };
  }
  return knownCapabilityStatus(provider, modelId);
}

/** client worker と共有する pure helper。状態を変更せず、unknown は none。 */
export const modelCapabilitiesFor = getModelCapabilities;

export function reasoningEffortsForModel(
  provider: ApiKeyProvider,
  modelId: string,
  entries?: readonly ModelCatalogEntry[],
): readonly ReasoningEffort[] {
  return getModelCapabilities(provider, modelId, entries).reasoningEfforts;
}

export function normalizeReasoningEffortForModel(
  provider: ApiKeyProvider,
  modelId: string,
  effort: ReasoningEffort | null | undefined,
  entries?: readonly ModelCatalogEntry[],
): ReasoningEffort {
  const supported = reasoningEffortsForModel(provider, modelId, entries);
  return effort && supported.includes(effort) ? effort : "none";
}

/** テスト専用。API キーや候補を外部ストレージへ書かずに状態だけ消去する。 */
export function resetModelCatalogForTests(): void {
  for (const provider of MODEL_CATALOG_PROVIDERS) {
    providerStates[provider] = emptyProviderState(provider);
  }
  notifyCatalogChanged();
}

