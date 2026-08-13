import {
  advanceImportPublishPhase,
  benchmarkSummaryQueryCount,
  buildSharedBundleFingerprint,
  buildLegacyBootstrapBookkeeping,
  buildImportPublishPlan,
  computeSyncDiff,
  advanceImageMutationPhase,
  assertSqlBindCount,
  isPathContainedBy,
  isSafeRelativeArchivePath,
  normalizeLookupKey,
  sha256Hex,
  isAssetMappingComplete,
  matchStableIdentityRows,
  shouldRollbackPublishedFiles,
  countSqlPlaceholders,
  stableSourceIdentityKeys,
} from "./database-core";
import { isRawJsonSql } from "./performance";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function runDatabaseCoreTests(): void {
  assert(normalizeLookupKey(" ＡＢ　C ") === "abc", "NFKC/空白除去");
  const diff = computeSyncDiff(
    {
      a: { uid: "a", contentHash: "1", assetSetHash: "x" },
      b: { uid: "b", contentHash: "1", assetSetHash: "x" },
    },
    {
      a: { uid: "a", contentHash: "1", assetSetHash: "x" },
      b: { uid: "b", contentHash: "2", assetSetHash: "x" },
      c: { uid: "c", contentHash: "1", assetSetHash: "x" },
    },
  );
  assert(diff.incremental && diff.unchanged.includes("a"), "unchanged diff");
  assert(diff.changed.includes("b") && diff.added.includes("c"), "changed/added diff");
  assert(computeSyncDiff({}, { a: { uid: "a", contentHash: "1" } }).incremental === false, "legacy fallback");
  assert(benchmarkSummaryQueryCount(500) === 1, "summary SQL is bounded");
  const sharedFingerprint = buildSharedBundleFingerprint('{"b":2,"a":1}', [
    { relative: "0500.jpg", size: 5, md5: "AABB" },
    { relative: "0001.jpg", size: 1, md5: "CCDD" },
  ]);
  assert(
    sharedFingerprint === buildSharedBundleFingerprint('{ "a": 1, "b": 2 }', [
      { relative: "0001.jpg", size: 1, md5: "ccdd" },
      { relative: "0500.jpg", size: 5, md5: "aabb" },
    ]),
    "shared bundle fingerprint is semantic and order independent",
  );
  assert(
    sharedFingerprint !== buildSharedBundleFingerprint('{"a":1,"b":2}', [
      { relative: "0001.jpg", size: 2, md5: "ccdd" },
      { relative: "0500.jpg", size: 5, md5: "aabb" },
    ]),
    "shared bundle fingerprint changes with file content metadata",
  );
  const completeBootstrap = buildLegacyBootstrapBookkeeping([
    { syncUid: "event-a", contentHash: "content-a", assetSetHash: "assets-a" },
    { syncUid: "event-b", contentHash: "content-b", assetSetHash: "assets-b" },
  ]);
  assert(completeBootstrap[0]?.syncUid === "event-a" && completeBootstrap[1]?.contentHash === "content-b", "complete v2 bootstrap publishes real bookkeeping");
  const legacyBootstrap = buildLegacyBootstrapBookkeeping([
    { syncUid: "event-a", contentHash: null, assetSetHash: null },
    { syncUid: "event-b", contentHash: "content-b", assetSetHash: "assets-b" },
  ]);
  assert(legacyBootstrap.every((record) => record === null), "old/partial manifest remains wholly legacy");
  let duplicateBootstrapUid = false;
  try {
    buildLegacyBootstrapBookkeeping([
      { syncUid: "event-a", contentHash: "content-a", assetSetHash: "assets-a" },
      { syncUid: "event-a", contentHash: "content-b", assetSetHash: "assets-b" },
    ]);
  } catch { duplicateBootstrapUid = true; }
  assert(duplicateBootstrapUid, "complete bootstrap rejects duplicate stable UIDs");
  assert(countSqlPlaceholders("INSERT INTO t(a,b,c) VALUES (?, ?, '?')") === 2, "placeholder count ignores literals");
  assertSqlBindCount("INSERT INTO t(a,b) VALUES (?, ?)", 2);
  let bindMismatch = false;
  try { assertSqlBindCount("INSERT INTO t(a,b) VALUES (?, ?)", 1); } catch { bindMismatch = true; }
  assert(bindMismatch, "placeholder assertion rejects drift");

  // raw 値を normalize する前の archive path 安全契約。
  assert(isSafeRelativeArchivePath("events/a/event.json"), "relative archive path");
  for (const unsafe of ["/tmp/event.json", "\\\\server\\share\\event.json", "C:foo/event.json", "C:" + "\\foo\\event.json", "file:///tmp/event.json", "a/../event.json", "a/%2e%2e/event.json"]) {
    assert(!isSafeRelativeArchivePath(unsafe), `unsafe archive path: ${unsafe}`);
  }
  assert(isPathContainedBy("file:///cache/extract/", "file:///cache/extract/events/a"), "extract containment");
  assert(!isPathContainedBy("file:///cache/extract/", "file:///cache/extract-other/events/a"), "extract sibling escape");

  const plan = buildImportPublishPlan([10, 10, 11], [2, 2], [3]);
  assert(JSON.stringify(plan.publishEventIds) === JSON.stringify([10, 11]), "publish plan dedupe");
  assert(JSON.stringify(plan.deleteEventIds) === JSON.stringify([2, 3]), "delete plan order");
  assert(JSON.stringify(plan.rollbackEventIds) === JSON.stringify([10, 11]), "rollback plan");
  assert(advanceImportPublishPhase("staging", "publishing") === "publishing", "publish transition");
  let invalidTransition = false;
  try { advanceImportPublishPhase("finalized", "rolled_back"); } catch { invalidTransition = true; }
  assert(invalidTransition, "finalized state cannot rollback");
  assert(isRawJsonSql("SELECT c.* FROM circles c"), "raw projection c.*");
  assert(isRawJsonSql("SELECT i.id, i.* FROM items i"), "raw projection i.*");
  assert(!isRawJsonSql("SELECT c.id, c.name FROM circles c"), "explicit projection");
  assert(sha256Hex(new TextEncoder().encode("abc")) === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "sha256 digest");
  assert(advanceImageMutationPhase("staged", "db_published") === "db_published", "image mutation publish transition");
  assert(advanceImageMutationPhase("db_published", "compensated") === "compensated", "image mutation compensation");
  assert(isAssetMappingComplete(0, 0), "zero-asset event can remain unchanged");
  assert(!isAssetMappingComplete(2, 0) && !isAssetMappingComplete(2, 1) && isAssetMappingComplete(2, 2), "asset mapping requires one ref per declared asset");
  assert(isAssetMappingComplete(["a", "b"], ["b", "a"]), "asset mappings exact set equality");
  assert(!isAssetMappingComplete(["a", "b"], ["a", "a"]), "asset mappings reject duplicate logical refs");
  assert(!isAssetMappingComplete(["a", "b"], ["a"]), "asset mappings reject missing logical refs");
  assert(shouldRollbackPublishedFiles(true, "db_published", true), "legacy DB restore forces old image rollback");
  assert(!shouldRollbackPublishedFiles(false, "db_published", true), "fully published legacy state forwards on restart");
  assert(shouldRollbackPublishedFiles(false, "db_publish_intent", true), "pre-publish legacy failure rolls back files");
  assert(
    stableSourceIdentityKeys('{"circle_id":"Circle-42"}', "circle")[0] === "circle_id:circle-42",
    "raw source identity is normalized and namespaced",
  );
  const stableMatches = matchStableIdentityRows(
    [
      { id: 10, rawJson: '{"circle_id":"source-a"}', fallbackKey: "fallback-old" },
      { id: 11, rawJson: null, fallbackKey: "name-b|pen-b|a01" },
      { id: 12, rawJson: null, fallbackKey: "duplicate" },
      { id: 13, rawJson: null, fallbackKey: "duplicate" },
    ],
    [
      { id: 100, rawJson: '{"circle_id":"SOURCE-A"}', fallbackKey: "changed-fallback" },
      { id: 101, rawJson: null, fallbackKey: "name-b|pen-b|a01" },
      { id: 102, rawJson: null, fallbackKey: "duplicate" },
    ],
    "circle",
  );
  assert(stableMatches.get(100) === 10, "raw source identity wins over fallback drift");
  assert(stableMatches.get(101) === 11, "unique normalized fallback matches");
  assert(!stableMatches.has(102), "ambiguous fallback does not transfer local state");
  let imageTransitionRejected = false;
  try { advanceImageMutationPhase("compensated", "db_published"); } catch { imageTransitionRejected = true; }
  assert(imageTransitionRejected, "compensated image mutation cannot publish again");
}
