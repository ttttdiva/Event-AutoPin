/** Expo/SQLite に依存しない DB 契約の純粋関数。
 * migration・同期差分の Node テスト/benchmark から再利用する。
 */

export interface SyncHashRecord {
  uid?: string | null;
  contentHash?: string | null;
  assetSetHash?: string | null;
}

export interface SyncDiff {
  incremental: boolean;
  unchanged: string[];
  changed: string[];
  added: string[];
  removed: string[];
  fallbackReason?: string;
}

export function normalizeLookupKey(value: string | null | undefined): string {
  const raw = String(value ?? "");
  const normalized = typeof raw.normalize === "function" ? raw.normalize("NFKC") : raw;
  return normalized.trim().toLowerCase().replace(/\s+/g, "");
}

export type StableIdentityKind = "circle" | "item";

export interface StableIdentityRow {
  id: number;
  rawJson?: string | null;
  fallbackKey: string;
}

/**
 * Desktop が将来追加する source identifier を schema migration なしで利用する。
 * key 名も含めて namespacing し、circle_id と item_id の偶然の同値を混同しない。
 */
export function stableSourceIdentityKeys(
  rawJson: string | null | undefined,
  kind: StableIdentityKind,
): string[] {
  if (!rawJson) return [];
  let value: unknown;
  try { value = JSON.parse(rawJson); } catch { return []; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const kindKeys = kind === "circle"
    ? ["circle_id", "circle_uid", "circle_uuid"]
    : ["item_id", "item_uid", "item_uuid", "product_id"];
  const keys = [
    ...kindKeys,
    "source_id",
    "source_uid",
    "external_id",
    "stable_uid",
    "uuid",
    "uid",
    "id",
  ];
  const result: string[] = [];
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate !== "string" && typeof candidate !== "number") continue;
    const normalized = normalizeLookupKey(String(candidate));
    if (normalized) result.push(`${key}:${normalized}`);
  }
  return [...new Set(result)];
}

/**
 * Changed-event の local state を引き継ぐ行を一対一で対応付ける。
 * raw source ID を優先し、無い場合のみ呼び出し側の正規化 composite keyを使う。
 * duplicate/ambiguous key は誤転記を避けて match しない。
 */
export function matchStableIdentityRows(
  previous: readonly StableIdentityRow[],
  staged: readonly StableIdentityRow[],
  kind: StableIdentityKind,
): Map<number, number> {
  const candidates = (row: StableIdentityRow): string[] => {
    const source = stableSourceIdentityKeys(row.rawJson, kind);
    return source.length ? source.map((key) => `source:${key}`) :
      (row.fallbackKey ? [`fallback:${row.fallbackKey}`] : []);
  };
  const previousIndex = new Map<string, number[]>();
  const stagedCounts = new Map<string, number>();
  for (const row of previous) {
    for (const key of candidates(row)) {
      const ids = previousIndex.get(key) ?? [];
      ids.push(Number(row.id));
      previousIndex.set(key, ids);
    }
  }
  for (const row of staged) {
    for (const key of candidates(row)) stagedCounts.set(key, (stagedCounts.get(key) ?? 0) + 1);
  }

  const matchedPrevious = new Set<number>();
  const result = new Map<number, number>();
  for (const row of staged) {
    for (const key of candidates(row)) {
      const ids = previousIndex.get(key) ?? [];
      if (ids.length !== 1 || stagedCounts.get(key) !== 1 || matchedPrevious.has(ids[0])) continue;
      result.set(Number(row.id), ids[0]);
      matchedPrevious.add(ids[0]);
      break;
    }
  }
  return result;
}

/** Count SQLite bind markers outside SQL string literals. */
export function countSqlPlaceholders(sql: string): number {
  const withoutLiterals = String(sql ?? "").replace(/'(?:''|[^'])*'/g, "");
  return (withoutLiterals.match(/\?/g) ?? []).length;
}

/** Guard import statements against a column/value bind drift. */
export function assertSqlBindCount(sql: string, bindCount: number): void {
  const expected = countSqlPlaceholders(sql);
  if (expected !== bindCount) {
    throw new Error(`SQL bind count mismatch: expected ${expected}, got ${bindCount}`);
  }
}

/**
 * ZIP 内の相対パスとして扱えるかを判定する純粋な安全契約。
 *
 * `normalizeArchivePath` のように先に先頭スラッシュを削ると、絶対パス・
 * UNC・ドライブ相対パスを安全な相対パスへ偽装できるため、必ず raw 値を
 * 検査してから正規化する。Expo の ZIP 展開結果は file URI だが、manifest
 * から受け取る値は URI/OS パスではなく archive-relative のみ許可する。
 */
export function isSafeRelativeArchivePath(value: string | null | undefined): boolean {
  if (typeof value !== "string" || !value || value.includes("\0")) return false;
  const slash = value.replace(/\\/g, "/");
  // Unix absolute, UNC, URI scheme, Windows drive absolute/relative の拒否。
  if (/^(?:\/|\/\/)/.test(slash)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(slash)) return false;
  if (slash.split("/").some((part) => {
    try { return part === ".." || decodeURIComponent(part) === ".."; } catch { return true; }
  })) return false;
  return slash.split("/").some((part) => part.length > 0 && part !== ".");
}

/** file URI/OS パスを lexical canonical form に揃え、base 配下か判定する。 */
export function isPathContainedBy(basePath: string, candidatePath: string): boolean {
  const canonical = (value: string): string => {
    const stripped = value
      .replace(/^file:\/\/\//i, "/")
      .replace(/^file:\/\//i, "/")
      .replace(/\\/g, "/");
    const absolute = stripped.startsWith("/");
    const parts: string[] = [];
    for (const part of stripped.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
        else if (!absolute) parts.push(part);
        continue;
      }
      parts.push(part);
    }
    const body = parts.join("/");
    return absolute ? `/${body}` : body;
  };
  const base = canonical(basePath).replace(/\/+$/, "") || "/";
  const candidate = canonical(candidatePath);
  return candidate === base || candidate.startsWith(`${base === "/" ? "" : base}/`);
}

export type ImportPublishPhase = "staging" | "publishing" | "finalized" | "rolled_back";

/** Incremental import の DB/image publish state machine。rollback 判定を純粋化する。 */
export function advanceImportPublishPhase(
  current: ImportPublishPhase,
  next: ImportPublishPhase,
): ImportPublishPhase {
  const allowed: Record<ImportPublishPhase, ImportPublishPhase[]> = {
    staging: ["publishing", "rolled_back"],
    publishing: ["finalized", "rolled_back"],
    finalized: [],
    rolled_back: [],
  };
  if (!allowed[current].includes(next)) {
    throw new Error(`invalid import publish transition: ${current} -> ${next}`);
  }
  return next;
}

/** Legacy full-sync fault policy: once the old DB preimage has been restored,
 * image/default-cut trees must roll back as well regardless of the last
 * journal phase (the phase write itself may have failed). */
export function shouldRollbackPublishedFiles(
  dbRestoredToOld: boolean,
  phase: "staging" | "image_publish_intent" | "images_published" | "db_publish_intent" | "db_published" | "finalized",
  publishAttempted: boolean,
): boolean {
  return publishAttempted && (dbRestoredToOld || (phase !== "db_published" && phase !== "finalized"));
}

export interface ImportPublishPlan {
  publishEventIds: number[];
  deleteEventIds: number[];
  rollbackEventIds: number[];
}

/** 重複を除去した publish/delete/rollback 対象を作る。順序は入力順を保持する。 */
export function buildImportPublishPlan(
  importedEventIds: number[],
  previousChangedIds: number[],
  removedEventIds: number[],
): ImportPublishPlan {
  const unique = (values: number[]): number[] => [...new Set(values.map(Number))];
  const publishEventIds = unique(importedEventIds);
  return {
    publishEventIds,
    deleteEventIds: unique([...previousChangedIds, ...removedEventIds]),
    rollbackEventIds: [...publishEventIds],
  };
}

export function computeSyncDiff(
  existing: Record<string, SyncHashRecord>,
  incoming: Record<string, SyncHashRecord>,
): SyncDiff {
  const records = Object.entries(incoming);
  if (!records.length || records.some(([, record]) => !record.uid || !record.contentHash || !record.assetSetHash)) {
    return {
      incremental: false,
      unchanged: [],
      changed: [],
      added: [],
      removed: [],
      fallbackReason: "stable uid/content hash/asset set hash が不足",
    };
  }
  const unchanged: string[] = [];
  const changed: string[] = [];
  const added: string[] = [];
  for (const [key, record] of records) {
    const uid = String(record.uid);
    const previous = existing[uid];
    if (!previous) added.push(key);
    else if (previous.contentHash === record.contentHash && previous.assetSetHash === record.assetSetHash) {
      unchanged.push(key);
    } else changed.push(key);
  }
  const seen = new Set(records.map(([, record]) => String(record.uid)));
  const removed = Object.keys(existing).filter((uid) => !seen.has(uid));
  return { incremental: true, unchanged, changed, added, removed };
}

export function benchmarkSummaryQueryCount(eventCount: number): number {
  // getEventSummaries は event 数に関わらず 1 SQL。
  return eventCount >= 0 ? 1 : 0;
}

export interface SharedBundleFileFingerprint {
  relative: string;
  size: number;
  md5: string;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalJsonValue(child)]),
    );
  }
  return value;
}

/** Stable fingerprint for shared circle-master/default-cut bundle content. */
export function buildSharedBundleFingerprint(
  circleMasterJson: string | null,
  files: readonly SharedBundleFileFingerprint[],
): string {
  let circleMaster: unknown = null;
  if (circleMasterJson != null) circleMaster = canonicalJsonValue(JSON.parse(circleMasterJson));
  const normalizedFiles = files
    .map((file) => ({
      relative: String(file.relative).replace(/\\/g, "/"),
      size: Number(file.size),
      md5: String(file.md5).toLowerCase(),
    }))
    .sort((left, right) => left.relative.localeCompare(right.relative));
  return sha256Hex(new TextEncoder().encode(JSON.stringify({ circleMaster, files: normalizedFiles })));
}

export interface SyncManifestBookkeeping {
  syncUid: string | null;
  contentHash: string | null;
  assetSetHash: string | null;
}

/**
 * Legacy local DB に対する full bootstrap 後の同期 bookkeeping を決める。
 *
 * 全 event が complete v2 record なら、full import の安全性を維持したまま
 * publish 行を real UID/hash へ昇格できる。1件でも欠ける旧 manifest は bundle
 * 全体を legacy として NULL にし、部分的な hash 状態を incremental と誤認しない。
 */
export function buildLegacyBootstrapBookkeeping(
  records: readonly SyncManifestBookkeeping[],
): Array<SyncManifestBookkeeping | null> {
  const complete = records.length > 0 && records.every(
    (record) => !!record.syncUid && !!record.contentHash && !!record.assetSetHash,
  );
  if (!complete) return records.map(() => null);

  const seen = new Set<string>();
  for (const record of records) {
    const uid = record.syncUid as string;
    if (seen.has(uid)) throw new Error(`duplicate sync UID: ${uid}`);
    seen.add(uid);
  }
  return records.map((record) => ({ ...record }));
}

/** Every declared logical asset needs one exact persisted mapping before an
 * event can be considered unchanged.  A zero-asset event is complete only
 * with zero mappings; extras/duplicates force re-import.  The numeric
 * overload is retained for callers that only have counts; the array overload
 * enforces exact set equality and uniqueness. */
export function isAssetMappingComplete(expectedAssetCount: number, mappedAssetCount: number): boolean;
export function isAssetMappingComplete(expectedLogical: readonly string[], mappedLogical: readonly string[]): boolean;
export function isAssetMappingComplete(
  expected: number | readonly string[],
  mapped: number | readonly string[],
): boolean {
  if (typeof expected === "number" && typeof mapped === "number") return expected === mapped;
  if (!Array.isArray(expected) || !Array.isArray(mapped)) return false;
  const expectedSet = new Set(expected);
  const mappedSet = new Set(mapped);
  if (expectedSet.size !== expected.length || mappedSet.size !== mapped.length) return false;
  if (expectedSet.size !== mappedSet.size) return false;
  for (const value of expectedSet) if (!mappedSet.has(value)) return false;
  return true;
}

/**
 * Small dependency-free SHA-256 implementation used by the mobile import
 * verifier.  Expo's legacy FileSystem exposes MD5 on every supported SDK but
 * not SHA-256; keeping the digest primitive here lets callers fail closed for
 * manifests that require SHA-256 without adding a native dependency.
 */
export function sha256Hex(input: Uint8Array): string {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b,
    0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
    0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7,
    0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152,
    0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
    0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
    0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
    0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
    0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const bitLength = input.length * 8;
  const paddedLength = ((input.length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, hh = h7;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + hh) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((value) => value.toString(16).padStart(8, "0")).join("");
}

export type ImageMutationPhase = "staged" | "db_published" | "compensated";

/** Pure state transitions used by image mutation rollback/fault-injection tests. */
export function advanceImageMutationPhase(
  current: ImageMutationPhase,
  next: ImageMutationPhase,
): ImageMutationPhase {
  const allowed: Record<ImageMutationPhase, ImageMutationPhase[]> = {
    staged: ["db_published", "compensated"],
    db_published: ["compensated"],
    compensated: [],
  };
  if (!allowed[current].includes(next)) throw new Error(`invalid image mutation transition: ${current} -> ${next}`);
  return next;
}
