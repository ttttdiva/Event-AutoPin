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
  const merged: Record<string, unknown> = { ...existing };
  for (const key of EVENT_META_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(meta, key)) delete merged[key];
  }
  Object.assign(merged, meta);
  data.event = merged;
}
