export function mapFollowerMetadata(row: any): { followerCount: number | null; followerObservedAt: string | null; followerSource: string | null } {
  const count = row.follower_count;
  const validCount = row.follower_count_type === "integer" && Number.isSafeInteger(count) && count >= 0;
  return {
    followerCount: validCount ? count : null,
    followerObservedAt: validCount && typeof row.follower_observed_at === "string" ? row.follower_observed_at : null,
    followerSource: validCount && typeof row.follower_source === "string" ? row.follower_source : null,
  };
}
