import { cloneJsonSnapshot } from "./revisioned-save-queue";

/**
 * イベント切替のrequested/committed境界をUIから独立して扱う小さな状態機械。
 * load処理はSessionを完成させてからcommitし、epochが古ければ破棄する。
 */
export type EventSession<Meta = unknown, Data = unknown, Table = unknown, Index = ReadonlySet<string>, MapImage = unknown> = {
  slug: string;
  eventDir: string;
  eventJsonPath: string;
  meta: Meta;
  eventJsonData: Data;
  tableState: Table;
  tableBaseline: Table;
  purchasedItemIndex: Index;
  mapImages: MapImage[];
  sourceFingerprint: {
    modifiedMs?: number;
    fileSize?: number;
    contentHash?: string;
  };
};

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function identifierValue(value: unknown): string | null {
  if (value === null || value === undefined || typeof value === "object") return null;
  const normalized = String(value).trim();
  return normalized || null;
}

/** Python full-sync manifestと同じ範囲のlegacy event identifierを解決する。 */
export function existingEventUid(document: unknown): string | null {
  const root = objectValue(document);
  if (!root) return null;
  for (const key of [
    "event_uid",
    "event_id",
    "event_uuid",
    "stable_event_uid",
    "stable_uid",
    "uuid",
  ]) {
    const identifier = identifierValue(root[key]);
    if (identifier) return identifier;
  }
  const event = objectValue(root.event);
  if (event) {
    for (const key of ["event_uid", "event_id", "event_uuid", "stable_uid", "uuid", "id"]) {
      const identifier = identifierValue(event[key]);
      if (identifier) return identifier;
    }
  }
  const metadata = objectValue(root.metadata);
  if (metadata) {
    for (const key of ["event_uid", "event_id", "event_uuid", "stable_uid", "uuid"]) {
      const identifier = identifierValue(metadata[key]);
      if (identifier) return identifier;
    }
  }
  return null;
}

export type FullSyncPreparedDocument<Data extends JsonObject = JsonObject> = {
  data: Data;
  eventUid: string;
  changed: boolean;
};

/**
 * full-sync前にownerのevent documentへroot event_uidを付与する純粋関数。
 * 入力を変更せず、未知field/raw_json/metadata/画像参照を含む全documentをcloneする。
 */
export function prepareFullSyncEventDocument<Data extends JsonObject>(
  document: Data,
  createUid: () => string,
): FullSyncPreparedDocument<Data> {
  const snapshot = cloneJsonSnapshot(document);
  const rootUid = identifierValue((snapshot as JsonObject).event_uid);
  if (rootUid) return { data: snapshot, eventUid: rootUid, changed: false };
  const eventUid = existingEventUid(snapshot) ?? identifierValue(createUid());
  if (!eventUid) throw new Error("event UIDを生成できませんでした");
  (snapshot as JsonObject).event_uid = eventUid;
  return { data: snapshot, eventUid, changed: true };
}

/** native save完了後のactive committed sessionを同じdocument/fingerprintへ揃える。 */
export function reconcileSessionEventDocument<S extends EventSession>(
  session: S,
  data: S["eventJsonData"],
  fingerprint: S["sourceFingerprint"],
): S {
  return {
    ...session,
    eventJsonData: cloneJsonSnapshot(data),
    sourceFingerprint: { ...fingerprint },
  };
}

export class EventSelectionState<S extends EventSession = EventSession> {
  requestedEventSlug: string | null = null;
  committedEventSession: S | null = null;
  selectionEpoch = 0;

  request(slug: string): number {
    this.requestedEventSlug = slug;
    this.selectionEpoch += 1;
    return this.selectionEpoch;
  }

  isCurrent(epoch: number, slug?: string): boolean {
    return epoch === this.selectionEpoch && (!slug || slug === this.requestedEventSlug);
  }

  commit(epoch: number, session: S): boolean {
    if (!this.isCurrent(epoch, session.slug)) return false;
    this.committedEventSession = session;
    this.requestedEventSlug = session.slug;
    return true;
  }

  invalidate(): void {
    this.selectionEpoch += 1;
  }

  clear(): void {
    this.invalidate();
    this.requestedEventSlug = null;
    this.committedEventSession = null;
  }
}
