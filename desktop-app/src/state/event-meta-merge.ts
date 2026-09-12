/** event.jsonのevent metadataだけを同期し、未知フィールドを保持する。 */
export const EVENT_META_KEYS = [
  "name",
  "date",
  "venue",
  "event_url",
  "event_urls",
  "url",
  "map_url",
  "map_config",
  "additional_prompt",
  "created_at",
  "source",
  "memo",
  "completed",
  "shopping_started_at",
  "shopping_ended_at",
  "event_image",
  "purchase_results",
] as const;

export function mergeCommittedEventMetaPreservingUnknown(
  data: { event?: unknown; [key: string]: unknown },
  committedMeta: object,
): void {
  const raw = data.event;
  const existing =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const meta = committedMeta as Record<string, unknown>;
  const hasDocumentMemo = Object.prototype.hasOwnProperty.call(existing, "memo");
  const documentMemo = existing.memo;
  const merged: Record<string, unknown> = { ...existing };
  for (const key of EVENT_META_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(meta, key)) delete merged[key];
  }
  Object.assign(merged, meta);
  // event.memo is owned by the document/editor snapshot.  The coordinator's
  // committed metadata may be stale after a later user edit/revert.
  if (hasDocumentMemo) {
    merged.memo = documentMemo;
  } else {
    delete merged.memo;
  }
  data.event = merged;
}
