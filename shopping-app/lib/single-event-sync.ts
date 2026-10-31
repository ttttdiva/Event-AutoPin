import type { ImportData } from "./types";
import { stableSourceIdentityKeys } from "./database-core";

export interface SingleEventSyncUploadTarget {
  url: URL;
  token: string;
  targetUid: string;
  targetName: string | null;
  targetDate: string | null;
}

function queryValue(url: URL, key: string, required = false): string | null {
  const values = url.searchParams.getAll(key);
  if (values.length > 1) throw new Error(`同期QRの${key}が重複しています`);
  const value = values[0] ?? null;
  if (required && !value) throw new Error(`同期QRに${key}がありません`);
  return value;
}

function optionalPairingText(url: URL, key: string, maxLength = 512): string | null {
  const value = queryValue(url, key);
  if (value !== null && (value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value))) {
    throw new Error(`同期QRの${key}が不正です`);
  }
  return value;
}

function assertAllowedQueryKeys(url: URL, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of url.searchParams.keys()) {
    if (!allowedSet.has(key)) throw new Error(`同期QRに未対応のquery parameterがあります: ${key}`);
  }
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((part) => part < 0 || part > 255)) return false;
  const [a, b] = octets;
  return a === 10 || a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168);
}

function assertLanHttpUrl(url: URL): void {
  if (url.protocol !== "http:") throw new Error("同期QRはHTTP LANアドレスである必要があります");
  if (url.username || url.password) throw new Error("同期QRに認証情報を含められません");
  if (url.hash) throw new Error("同期QRのfragmentは使用できません");
  const hostname = url.hostname.toLowerCase();
  if (hostname !== "localhost" && !isPrivateIpv4(hostname)) {
    throw new Error("同期QRはlocalhostまたはプライベートIPv4アドレスのみ使用できます");
  }
}

export function parseSingleEventSyncUploadUrl(value: string): SingleEventSyncUploadTarget {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("同期QRのURL形式が不正です");
  }
  assertLanHttpUrl(url);
  if (url.pathname !== "/upload") throw new Error("同期QRの送信先が不正です");
  assertAllowedQueryKeys(url, ["token", "mode", "target_uid", "target_name", "target_date"]);
  const token = queryValue(url, "token", true) as string;
  const mode = queryValue(url, "mode", true);
  const targetUid = queryValue(url, "target_uid", true) as string;
  if (mode !== "single-event-sync") throw new Error("同期QRのmodeが不正です");
  if (token.length > 2048 || /[\u0000-\u001f\u007f]/.test(token)) {
    throw new Error("同期QRのtokenが不正です");
  }
  if (targetUid.length > 256 || /[\s\u0000-\u001f\u007f]/.test(targetUid)) {
    throw new Error("同期QRのtarget_uidが不正です");
  }
  return {
    url,
    token,
    targetUid,
    targetName: optionalPairingText(url, "target_name"),
    targetDate: optionalPairingText(url, "target_date"),
  };
}

export function parseSingleEventSyncDownloadUrl(value: string): {
  url: URL;
  token: string;
  targetUid: string;
} {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PC同期QRのURL形式が不正です");
  }
  assertLanHttpUrl(url);
  if (url.pathname !== "/mobile_export.zip") {
    throw new Error("PC同期QRのZIP送信先が不正です");
  }
  assertAllowedQueryKeys(url, ["token", "mode", "target_uid"]);
  const token = queryValue(url, "token", true) as string;
  const mode = queryValue(url, "mode", true);
  const targetUid = queryValue(url, "target_uid", true) as string;
  if (mode !== "single-event-sync") throw new Error("PC同期QRのmodeが不正です");
  if (token.length > 2048 || /[\u0000-\u001f\u007f]/.test(token)) {
    throw new Error("PC同期QRのtokenが不正です");
  }
  if (targetUid.length > 256 || /[\s\u0000-\u001f\u007f]/.test(targetUid)) {
    throw new Error("PC同期QRのtarget_uidが不正です");
  }
  return { url, token, targetUid };
}

export type SingleEventSyncSessionState =
  | "pending"
  | "pc-ready"
  | "mobile-applied"
  | "cancelled"
  | "error"
  | "unknown";

export interface SingleEventSyncSessionResult {
  state: SingleEventSyncSessionState;
  targetUid: string | null;
  downloadUrl: string | null;
  message: string | null;
  delivered: boolean | null;
}

export function shouldRetrySingleEventSyncCancellation(
  state: SingleEventSyncSessionState,
): boolean {
  return state === "pending";
}

function responseString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function responseRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("同期セッション応答が不正です");
  }
  return value as Record<string, unknown>;
}

/**
 * Parse the JSON returned by the original upload endpoint and by the
 * same-session GET poll.  The server has shipped both snake_case and
 * camelCase field names, so the parser accepts either spelling while still
 * validating the UID and download URL through the strict QR parsers.
 */
export function parseSingleEventSyncSessionResponse(
  value: string,
  expectedUid: string,
): SingleEventSyncSessionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("同期セッション応答のJSON形式が不正です");
  }
  const record = responseRecord(parsed);
  const targetUid = responseString(record, ["target_uid", "targetUid", "event_uid", "eventUid"]);
  if (targetUid !== null && targetUid !== expectedUid) {
    throw new Error("同期セッション応答の対象UIDが一致しません");
  }

  const rawDownloadUrl = responseString(record, [
    "download_url",
    "downloadUrl",
    "outbound_url",
    "outboundUrl",
    "next_url",
    "nextUrl",
    "pc_download_url",
    "pcDownloadUrl",
  ]);
  let downloadUrl: string | null = null;
  if (rawDownloadUrl !== null) {
    const parsedDownload = parseSingleEventSyncDownloadUrl(rawDownloadUrl);
    if (parsedDownload.targetUid !== expectedUid) {
      throw new Error("同期セッションのPC ZIP対象UIDが一致しません");
    }
    downloadUrl = parsedDownload.url.toString();
  }

  const source = responseString(record, [
    "source",
    "choice",
    "decision",
    "result",
    "selected_source",
    "selectedSource",
  ])?.toLowerCase() ?? "";
  const status = responseString(record, ["state", "status", "phase", "result"])?.toLowerCase() ?? "";
  const message = responseString(record, ["error", "message"]);
  const delivered = typeof record.delivered === "boolean" ? record.delivered : null;
  if (message && (status === "error" || status === "failed" || status === "cancelled" || status === "canceled")) {
    return { state: status === "cancelled" || status === "canceled" ? "cancelled" : "error", targetUid, downloadUrl, message, delivered };
  }
  if (downloadUrl || source === "pc" || source === "desktop" || status === "pc-ready" || status === "desktop-ready" || status === "outbound") {
    return { state: "pc-ready", targetUid, downloadUrl, message, delivered };
  }
  if (source === "mobile" || source === "mobile-selected" || status === "mobile-applied" || status === "mobile-complete" || status === "mobile-selected" || status === "mobile_selected" || status === "applied") {
    return { state: "mobile-applied", targetUid, downloadUrl, message, delivered };
  }
  if (status === "cancelled" || status === "canceled") {
    return { state: "cancelled", targetUid, downloadUrl, message, delivered };
  }
  if (status === "pending" || status === "processing" || status === "preview" || status === "waiting" || status === "waiting-for-choice" || status === "waiting_for_choice" || status === "ready") {
    return { state: "pending", targetUid, downloadUrl, message, delivered };
  }
  if (message) return { state: "error", targetUid, downloadUrl, message, delivered };
  return { state: "unknown", targetUid, downloadUrl, message, delivered };
}

export type SyncIdentityAction = "matched" | "link-required";

export function resolveSingleEventSyncIdentity(input: {
  selectedUid: string | null | undefined;
  targetUid: string;
  selectedName: string;
  selectedDate: string | null | undefined;
  targetName: string | null;
  targetDate: string | null;
}): SyncIdentityAction {
  if (!input.targetUid || input.targetUid.length > 256 || /[\s\u0000-\u001f\u007f]/.test(input.targetUid)) {
    throw new Error("PCイベントUIDが不正です");
  }
  if (input.selectedUid) {
    if (input.selectedUid !== input.targetUid) {
      throw new Error("選択したイベントのUIDとPC対象UIDが一致しません");
    }
    return "matched";
  }
  if (input.targetName === null || input.targetDate === null) {
    throw new Error("UID未設定イベントはPC側のイベント名・開催日がないと紐づけられません");
  }
  if (input.selectedName !== input.targetName || (input.selectedDate ?? "") !== input.targetDate) {
    throw new Error("選択したイベントとPC対象の名前・開催日が一致しません");
  }
  return "link-required";
}

/** Return the UID that the rest of a confirmed pairing session must use. */
export function resolveSingleEventSyncUid(input: {
  selectedUid: string | null | undefined;
  targetUid: string;
  identityAction: SyncIdentityAction;
}): string {
  if (!input.targetUid || input.targetUid.length > 256 || /[\s\u0000-\u001f\u007f]/.test(input.targetUid)) {
    throw new Error("PCイベントUIDが不正です");
  }
  if (input.identityAction === "link-required") return input.targetUid;
  if (input.selectedUid !== input.targetUid) {
    throw new Error("確認済み同期UIDが対象UIDと一致しません");
  }
  return input.targetUid;
}

export interface SingleEventSyncImageRef {
  key: string;
  label: string;
  path: string;
}

export interface SingleEventSyncDiff {
  metadata: string[];
  circles: { added: string[]; changed: string[]; removed: string[] };
  items: { added: string[]; changed: string[]; removed: string[] };
  purchase: string[];
  mapPins: string[];
  images: { added: string[]; changed: string[]; removed: string[] };
}

export type SyncImageFingerprints = Record<string, string | null>;

function canonical(value: unknown): string {
  if (value === undefined) return "<undefined>";
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "<undefined>" : serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function normalizeIdentity(value: unknown): string {
  return String(value ?? "").normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function circleIdentity(circle: Record<string, unknown>): string {
  const sourceKeys = stableSourceIdentityKeys(JSON.stringify(circle), "circle");
  if (sourceKeys.length) return `source:${sourceKeys[0]}`;
  const space = normalizeIdentity(circle.space);
  const name = normalizeIdentity(circle.name);
  const penname = normalizeIdentity(circle.penname);
  return `${space}\u001f${name}\u001f${penname}`;
}

function uniqueRows<T extends Record<string, unknown>>(
  rows: readonly T[],
  keyOf: (row: T) => string,
): { byKey: Map<string, T>; duplicateKeys: Set<string> } {
  const byKey = new Map<string, T>();
  const duplicateKeys = new Set<string>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key || byKey.has(key)) {
      if (key) duplicateKeys.add(key);
      continue;
    }
    byKey.set(key, row);
  }
  for (const key of duplicateKeys) byKey.delete(key);
  return { byKey, duplicateKeys };
}

function circleBasicFields(circle: Record<string, unknown>): Record<string, unknown> {
  const { checked, pin_x, pin_y, map_number, circle_cut_filename, items, item_images, ...fields } = circle;
  return fields;
}

function itemKey(item: Record<string, unknown>): string {
  const sourceKeys = stableSourceIdentityKeys(JSON.stringify(item), "item");
  if (sourceKeys.length) return `source:${sourceKeys[0]}`;
  return `fallback:${normalizeIdentity(item.name)}\u001f${normalizeIdentity(item.type ?? item.genre)}`;
}

function circleLabel(circle: Record<string, unknown>): string {
  const space = [circle.hall, circle.space].filter(Boolean).join(" ");
  return space ? `${space} ${String(circle.name ?? "(名称なし)")}` : String(circle.name ?? "(名称なし)");
}

export function singleEventSyncImageRefs(data: ImportData): SingleEventSyncImageRef[] {
  const refs: SingleEventSyncImageRef[] = [];
  const eventImage = data.event.event_image_filename ?? data.event.event_image;
  if (eventImage) refs.push({ key: "event-image", label: "イベント画像", path: eventImage });
  for (const map of data.event.maps ?? []) {
    if (map.filename) {
      const number = Number(map.map_number ?? 1);
      refs.push({ key: `map:${number}`, label: `マップ${number}`, path: map.filename });
    }
  }
  const circles = (data.circles ?? []) as Array<Record<string, unknown>>;
  for (const circle of circles) {
    const id = circleIdentity(circle);
    const label = circleLabel(circle);
    if (circle.circle_cut_filename) {
      refs.push({ key: `cut:${id}`, label: `${label} サークルカット`, path: String(circle.circle_cut_filename) });
    }
    const itemImages = Array.isArray(circle.item_images) ? circle.item_images as Array<Record<string, unknown>> : [];
    itemImages.forEach((image, index) => {
      if (image.path) refs.push({ key: `item-image:${id}:${index}`, label: `${label} 頒布物画像${index + 1}`, path: String(image.path) });
    });
    const items = Array.isArray(circle.items) ? circle.items as Array<Record<string, unknown>> : [];
    for (const item of items) {
      if (typeof item.image === "string" && item.image) {
        refs.push({
          key: `item-image-ref:${id}:${itemKey(item)}`,
          label: `${label} / ${String(item.name ?? "頒布物")} 画像`,
          path: item.image,
        });
      }
    }
  }
  return refs;
}

export function buildSingleEventSyncDiff(
  local: ImportData,
  incoming: ImportData,
  fingerprints?: { local?: SyncImageFingerprints; incoming?: SyncImageFingerprints },
): SingleEventSyncDiff {
  const metadataFields: Array<[string, unknown, unknown]> = [
    ["イベント名", local.event.name, incoming.event.name],
    ["URL", local.event.url, incoming.event.url],
    ["開催日", local.event.date ?? null, incoming.event.date ?? null],
    ["会場", local.event.venue ?? null, incoming.event.venue ?? null],
    ["主催", local.event.organizer ?? null, incoming.event.organizer ?? null],
    ["メモ", local.event.memo ?? null, incoming.event.memo ?? null],
    ["完了状態", local.event.completed ?? false, incoming.event.completed ?? false],
    ["買い物開始", local.event.shopping_started_at ?? null, incoming.event.shopping_started_at ?? null],
    ["買い物終了", local.event.shopping_ended_at ?? null, incoming.event.shopping_ended_at ?? null],
  ];
  const metadata = metadataFields.filter(([, a, b]) => canonical(a) !== canonical(b)).map(([label]) => label);
  const normalizeMetadata = (value: ImportData["metadata"]): Record<string, unknown> => {
    const {
      generated_at: _generatedAt,
      format_version: _formatVersion,
      total_circles: _totalCircles,
      export_type: _exportType,
      source: _source,
      purchase_results: _purchaseResults,
      ...rest
    } = value;
    return rest;
  };
  if (canonical(normalizeMetadata(local.metadata)) !== canonical(normalizeMetadata(incoming.metadata))) {
    metadata.push("イベント補足メタデータ");
  }
  const diff: SingleEventSyncDiff = {
    metadata,
    circles: { added: [], changed: [], removed: [] },
    items: { added: [], changed: [], removed: [] },
    purchase: [],
    mapPins: [],
    images: { added: [], changed: [], removed: [] },
  };
  if (canonical(local.event.map_calibration_points ?? []) !== canonical(incoming.event.map_calibration_points ?? [])) {
    diff.mapPins.push("マップ校正点");
  }

  const localCircles = (local.circles ?? []) as Array<Record<string, unknown>>;
  const incomingCircles = (incoming.circles ?? []) as Array<Record<string, unknown>>;
  const localIndex = uniqueRows(localCircles, circleIdentity);
  const incomingIndex = uniqueRows(incomingCircles, circleIdentity);
  for (const circle of incomingCircles) {
    const key = circleIdentity(circle);
    const before = localIndex.byKey.get(key);
    if (!key || !before || localIndex.duplicateKeys.has(key) || incomingIndex.duplicateKeys.has(key)) {
      const label = circleLabel(circle);
      diff.circles.added.push(label);
      if (circle.checked !== undefined) diff.purchase.push(`${label}: 新規サークルの購入状態 (${String(circle.checked)})`);
      if (circle.pin_x != null || circle.pin_y != null || circle.map_number != null) {
        diff.mapPins.push(`${label}: 追加ピン`);
      }
      const items = Array.isArray(circle.items) ? circle.items as Array<Record<string, unknown>> : [];
      for (const item of items) {
        const itemLabel = `${label} / ${String(item.name ?? "(名称なし)")}`;
        diff.items.added.push(itemLabel);
        if (item.checked !== undefined) diff.purchase.push(`${itemLabel}: 追加購入状態 (${String(item.checked)})`);
      }
      continue;
    }
    if (canonical(circleBasicFields(before)) !== canonical(circleBasicFields(circle))) {
      diff.circles.changed.push(circleLabel(circle));
    }
    if (canonical(before.checked ?? 0) !== canonical(circle.checked ?? 0)) {
      diff.purchase.push(`${circleLabel(circle)}: サークル購入状態`);
    }
    if (canonical([before.pin_x ?? null, before.pin_y ?? null, before.map_number ?? null]) !== canonical([circle.pin_x ?? null, circle.pin_y ?? null, circle.map_number ?? null])) {
      diff.mapPins.push(circleLabel(circle));
    }
    const oldItems = Array.isArray(before.items) ? before.items as Array<Record<string, unknown>> : [];
    const newItems = Array.isArray(circle.items) ? circle.items as Array<Record<string, unknown>> : [];
    const oldItemIndex = uniqueRows(oldItems, itemKey);
    const newItemIndex = uniqueRows(newItems, itemKey);
    for (const item of newItems) {
      const ik = itemKey(item);
      const oldItem = oldItemIndex.byKey.get(ik);
      if (!ik || !oldItem || oldItemIndex.duplicateKeys.has(ik) || newItemIndex.duplicateKeys.has(ik)) {
        const label = `${circleLabel(circle)} / ${String(item.name ?? "(名称なし)")}`;
        diff.items.added.push(label);
        if (item.checked !== undefined) diff.purchase.push(`${label}: 追加購入状態 (${String(item.checked)})`);
        continue;
      }
      const { checked: _oldChecked, ...oldFields } = oldItem;
      const { checked: _newChecked, ...newFields } = item;
      if (canonical(oldFields) !== canonical(newFields)) {
        diff.items.changed.push(`${circleLabel(circle)} / ${String(item.name ?? "(名称なし)")}`);
      }
      if (canonical(oldItem.checked ?? 0) !== canonical(item.checked ?? 0)) {
        diff.purchase.push(`${circleLabel(circle)} / ${String(item.name ?? "(名称なし)")}: 購入状態`);
      }
    }
    for (const [ik, item] of oldItemIndex.byKey) {
      if (!newItemIndex.byKey.has(ik) || newItemIndex.duplicateKeys.has(ik)) {
        diff.items.removed.push(`${circleLabel(before)} / ${String(item.name ?? "(名称なし)")}`);
      }
    }
  }
  for (const circle of localCircles) {
    const key = circleIdentity(circle);
    if (!key || localIndex.duplicateKeys.has(key) || !incomingIndex.byKey.has(key) || incomingIndex.duplicateKeys.has(key)) {
      diff.circles.removed.push(circleLabel(circle));
      if (circle.pin_x != null || circle.pin_y != null || circle.map_number != null) {
        diff.mapPins.push(`${circleLabel(circle)}: 削除ピン`);
      }
      const items = Array.isArray(circle.items) ? circle.items as Array<Record<string, unknown>> : [];
      for (const item of items) diff.items.removed.push(`${circleLabel(circle)} / ${String(item.name ?? "(名称なし)")}`);
    }
  }

  const localImages = new Map(singleEventSyncImageRefs(local).map((image) => [image.key, image]));
  const incomingImages = new Map(singleEventSyncImageRefs(incoming).map((image) => [image.key, image]));
  for (const [key, image] of incomingImages) {
    const before = localImages.get(key);
    if (!before) {
      diff.images.added.push(image.label);
      continue;
    }
    const localFingerprint = fingerprints?.local?.[key];
    const incomingFingerprint = fingerprints?.incoming?.[key];
    const changed = localFingerprint && incomingFingerprint
      ? localFingerprint !== incomingFingerprint
      : canonical(before.path.split(/[\\/]/).pop()) !== canonical(image.path.split(/[\\/]/).pop());
    if (changed) {
      diff.images.changed.push(image.label);
    }
  }
  for (const [key, image] of localImages) {
    if (!incomingImages.has(key)) diff.images.removed.push(image.label);
  }
  return diff;
}

export function redactSyncUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of ["token", "target_uid", "target_name", "target_date"]) {
      if (url.searchParams.has(key)) url.searchParams.set(key, "[redacted]");
    }
    return url.toString();
  } catch {
    return "[invalid URL]";
  }
}

export function redactSyncText(value: string): string {
  return String(value ?? "").replace(/https?:\/\/[^\s"'<>]+/gi, (match) => redactSyncUrl(match));
}
