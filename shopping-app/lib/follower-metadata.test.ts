import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mapFollowerMetadata } from "./follower-metadata";

// 既存イベントJSONがそのままraw_jsonとして保存される経路をSQLiteで検証する。
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE circles (raw_json TEXT)");
const insert = db.prepare("INSERT INTO circles VALUES (?)");
const read = db.prepare(`SELECT json_extract(raw_json, '$.follower_count') AS follower_count,
  json_type(raw_json, '$.follower_count') AS follower_count_type,
  json_extract(raw_json, '$.follower_observed_at') AS follower_observed_at,
  json_extract(raw_json, '$.follower_source') AS follower_source FROM circles ORDER BY rowid DESC LIMIT 1`);
const project = (value: unknown) => {
  insert.run(JSON.stringify(value));
  return mapFollowerMetadata(read.get());
};
const unknown = { followerCount: null, followerObservedAt: null, followerSource: null };
assert.deepEqual(project({ name: "旧データ" }), unknown);
assert.deepEqual(project({ follower_count: 0, follower_observed_at: "2026-01-01T00:00:00Z", follower_source: "twscrape_user_by_login" }), {
  followerCount: 0, followerObservedAt: "2026-01-01T00:00:00Z", followerSource: "twscrape_user_by_login",
});
for (const value of [-1, 1.5, "100", true, null]) {
  assert.deepEqual(project({ follower_count: value, follower_observed_at: "2026-01-01T00:00:00Z", follower_source: "twscrape_user_by_login" }), unknown);
}
assert.deepEqual(project({ follower_count: 123, follower_observed_at: null, follower_source: null }), {
  followerCount: 123, followerObservedAt: null, followerSource: null,
});
db.close();
console.log("PASS follower metadata SQLite projection");
