import {
  applyEventPatchToLatest,
  EventLifecycleGate,
  EventWriteCoordinator,
} from "./event-write-coordinator";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function main(): Promise<void> {
  const coordinator = new EventWriteCoordinator();
  assert(coordinator.revision("event-a") === 0, "初期revisionは0である必要があります");
  const releaseFirst = deferred<void>();
  const firstStarted = deferred<void>();
  const writes: string[] = [];
  const commits: string[] = [];
  const firstSnapshot = { name: "old", nested: { value: 1 } };

  const first = coordinator.run({
    key: "event-a",
    snapshot: firstSnapshot,
    isCurrent: () => true,
    write: async (snapshot) => {
      writes.push(snapshot.name);
      firstStarted.resolve();
      await releaseFirst.promise;
    },
    commit: (snapshot) => commits.push(snapshot.name),
  });
  firstSnapshot.name = "mutated-after-enqueue";
  firstSnapshot.nested.value = 99;

  await firstStarted.promise;
  assert(coordinator.revision("event-a") === 1, "enqueueでrevisionが進む必要があります");
  const second = coordinator.run({
    key: "event-a",
    snapshot: { name: "new", nested: { value: 2 } },
    isCurrent: () => true,
    write: async (snapshot) => {
      writes.push(snapshot.name);
      assert(snapshot.nested.value === 2, "後発snapshotがcloneされていません");
    },
    commit: (snapshot) => commits.push(snapshot.name),
  });
  releaseFirst.resolve();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert(firstResult.written, "開始済みの旧writeは完了する必要があります");
  assert(!firstResult.committed, "後発要求がある旧writeをglobal commitしてはいけません");
  assert(secondResult.committed, "最新writeはcommitされる必要があります");
  assert(writes.join(",") === "old,new", `write順序が不正です: ${writes}`);
  assert(commits.join(",") === "new", `commit内容が不正です: ${commits}`);
  assert(
    coordinator.committedSnapshot<{ name: string }>("event-a")?.name === "new",
    "最新commit snapshotを取得できません",
  );

  let current = true;
  let staleWrites = 0;
  const stale = coordinator.run({
    key: "event-b",
    snapshot: { name: "stale" },
    isCurrent: () => current,
    write: async () => {
      staleWrites += 1;
    },
    commit: () => {
      throw new Error("stale ownerをcommitしてはいけません");
    },
  });
  current = false;
  const staleResult = await stale;
  assert(!staleResult.written && staleWrites === 0, "stale ownerをwriteしてはいけません");

  // metadata writerとfull-document writerが同一serialを共有し、metadata先行時も
  // 後続full snapshotへ最新event metadataを合成する。
  const disk: { event: { url: string }; circles: unknown[] } = {
    event: { url: "old" },
    circles: [],
  };
  const metaThenFull = coordinator.run({
    key: "event-c",
    snapshot: { url: "new-meta" },
    isCurrent: () => true,
    write: async (meta) => {
      disk.event = meta;
    },
    commit: () => undefined,
  });
  const fullAfterMeta = coordinator.runExclusive("event-c", async () => {
    const fullSnapshot = { event: { url: "old" }, circles: [{ id: 1 }] };
    const committedMeta = coordinator.committedSnapshot<{ url: string }>("event-c");
    if (committedMeta) fullSnapshot.event = committedMeta;
    disk.event = fullSnapshot.event;
    disk.circles = fullSnapshot.circles;
    coordinator.recordCommitted("event-c", fullSnapshot.event);
  });
  await Promise.all([metaThenFull, fullAfterMeta]);
  assert(disk.event.url === "new-meta", "meta→fullで最新URLが失われました");

  const fullBeforeMeta = coordinator.runExclusive("event-d", async () => {
    disk.event = { url: "full" };
    coordinator.recordCommitted("event-d", disk.event);
  });
  const metaAfterFull = coordinator.run({
    key: "event-d",
    snapshot: { url: "newest-meta" },
    isCurrent: () => true,
    write: async (meta) => {
      disk.event = meta;
    },
    commit: () => undefined,
  });
  await Promise.all([fullBeforeMeta, metaAfterFull]);
  assert(disk.event.url === "newest-meta", "full→metaで最新URLが失われました");

  // mobile importがevent.jsonを外部置換した後は、古いmetadata cacheを
  // 捨ててfresh reloadを記録し、古いUI snapshotの保存で巻き戻さない。
  const importedKey = "event-imported";
  coordinator.recordCommitted(importedKey, { url: "desktop-stale", source: "desktop" });
  coordinator.forgetCommitted(importedKey);
  assert(
    coordinator.committedSnapshot(importedKey) === null,
    "外部置換後も古いmetadata cacheが残りました",
  );
  coordinator.recordCommitted(importedKey, {
    url: "mobile-fresh",
    source: "mobile_import",
  });
  const staleUiDocument = {
    event: { url: "desktop-stale", source: "desktop" },
    circles: [{ name: "keep" }],
  };
  await coordinator.runExclusiveAccepted(importedKey, async () => {
    const freshMeta = coordinator.committedSnapshot<typeof staleUiDocument.event>(
      importedKey,
    );
    if (freshMeta) staleUiDocument.event = freshMeta;
  });
  assert(
    staleUiDocument.event.url === "mobile-fresh" &&
      staleUiDocument.event.source === "mobile_import",
    "import後の保存が古いmetadataを復活させました",
  );

  const lifecycle = new EventLifecycleGate();
  const activeWrite = deferred<void>();
  const releaseWrite = deferred<void>();
  const writer = lifecycle.run("delete-me", async () => {
    activeWrite.resolve();
    await releaseWrite.promise;
  });
  await activeWrite.promise;
  let drained = false;
  const closing = lifecycle.closeAndDrain("delete-me").then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert(!drained, "既存writer tail完了前にdelete lifecycleをdrainしました");
  let lateWrites = 0;
  try {
    await lifecycle.run("delete-me", async () => {
      lateWrites += 1;
    });
  } catch {
    // close後のinline/meta/asset writerはfail closed。
  }
  assert(lateWrites === 0, "delete close後にlate writerを開始しました");
  releaseWrite.resolve();
  await Promise.all([writer, closing]);
  assert(drained, "既存writer tail後もlifecycle drainが完了しません");

  const coordinatedLifecycle = new EventLifecycleGate();
  const lifecycleCoordinator = new EventWriteCoordinator(coordinatedLifecycle);
  const coordinatedStarted = deferred<void>();
  const releaseCoordinated = deferred<void>();
  let coordinatedCommits = 0;
  const accepted = lifecycleCoordinator.run({
    key: "coordinated-delete",
    snapshot: { value: 1 },
    isCurrent: () => true,
    write: async () => {
      coordinatedStarted.resolve();
      await releaseCoordinated.promise;
    },
    commit: () => {
      coordinatedCommits += 1;
    },
  });
  await coordinatedStarted.promise;
  const coordinatedDrain = coordinatedLifecycle.closeAndDrain("coordinated-delete");
  let rejectedLateWrite = false;
  try {
    await lifecycleCoordinator.run({
      key: "coordinated-delete",
      snapshot: { value: 2 },
      isCurrent: () => true,
      write: async () => undefined,
      commit: () => undefined,
    });
  } catch {
    rejectedLateWrite = true;
  }
  releaseCoordinated.resolve();
  await Promise.all([accepted, coordinatedDrain]);
  assert(rejectedLateWrite, "close後のcoordinator writeを拒否しませんでした");
  assert(
    coordinatedCommits === 1,
    "拒否されたlate writeがclose前に受理済みのwriteをinvalidateしました",
  );

  const importLifecycle = new EventLifecycleGate();
  const targetTail = deferred<void>();
  const duplicateTail = deferred<void>();
  const releaseImportTails = deferred<void>();
  const targetWriter = importLifecycle.run("target", async () => {
    targetTail.resolve();
    await releaseImportTails.promise;
  });
  const duplicateWriter = importLifecycle.run("duplicate", async () => {
    duplicateTail.resolve();
    await releaseImportTails.promise;
  });
  await Promise.all([targetTail.promise, duplicateTail.promise]);
  const affectedDrain = Promise.all([
    importLifecycle.closeAndDrain("target"),
    importLifecycle.closeAndDrain("duplicate"),
  ]);
  let lateAffectedWrites = 0;
  for (const key of ["target", "duplicate"]) {
    try {
      await importLifecycle.run(key, async () => {
        lateAffectedWrites += 1;
      });
    } catch {
      // import plan確定後の対象writerは拒否される。
    }
  }
  releaseImportTails.resolve();
  await Promise.all([targetWriter, duplicateWriter, affectedDrain]);
  assert(lateAffectedWrites === 0, "import drain中にaffected event writerを開始しました");
  importLifecycle.open("target");
  await importLifecycle.run("target", async () => undefined);
  let deletedKeyRejected = false;
  try {
    await importLifecycle.run("duplicate", async () => undefined);
  } catch {
    deletedKeyRejected = true;
  }
  assert(deletedKeyRejected, "publish後に削除済みduplicate lifecycleを再openしました");

  const renameLifecycle = new EventLifecycleGate();
  const oldWriteStarted = deferred<void>();
  const releaseOldWrite = deferred<void>();
  const oldWrite = renameLifecycle.run("old", async () => {
    oldWriteStarted.resolve();
    await releaseOldWrite.promise;
  });
  await oldWriteStarted.promise;
  let renameInvoked = false;
  const rename = (async () => {
    await renameLifecycle.closeAndDrain("old");
    renameInvoked = true;
    renameLifecycle.open("new");
  })();
  await Promise.resolve();
  assert(!renameInvoked, "old writer drain前に物理renameを開始しました");
  releaseOldWrite.resolve();
  await Promise.all([oldWrite, rename]);
  await renameLifecycle.run("new", async () => undefined);
  let oldRejected = false;
  try {
    await renameLifecycle.run("old", async () => undefined);
  } catch {
    oldRejected = true;
  }
  assert(oldRejected, "rename成功後もold lifecycleをopenにしました");
  renameLifecycle.open("old");
  await renameLifecycle.run("old", async () => undefined);

  // auto pinのbase取得後にmetadataが編集されても、latest documentへ対象pinだけ
  // patchすることでmetadataと別circleを保持する。
  const autoPinLatest = {
    event: { name: "latest", memo: "concurrent metadata edit" },
    circles: [
      { name: "A", space: "A-01", pin_x: 0.1, memo: "keep-a" },
      { name: "B", space: "B-01", pin_x: 0.2, memo: "keep-b" },
    ],
    metadata: { opaque: { keep: true } },
  };
  const autoPinApplied = applyEventPatchToLatest(
    autoPinLatest,
    {
      baseFingerprint: { contentHash: "old" },
      circlePatches: [
        {
          circleIndex: 0,
          circleIdentity: { name: "A", space: "A-01" },
          baseCircle: { name: "A", space: "A-01", pin_x: 0.1, memo: "keep-a" },
          changes: { pin_x: 0.8, pin_y: 0.9 },
        },
      ],
    },
    { contentHash: "new" },
  );
  assert(!autoPinApplied.baseFingerprintMatched, "並行metadata編集を検知できません");
  assert(
    autoPinApplied.data.event.memo === "concurrent metadata edit" &&
      autoPinApplied.data.metadata.opaque.keep,
    "auto pinが並行metadataを失いました",
  );
  assert(
    autoPinApplied.data.circles[1].pin_x === 0.2 &&
      autoPinApplied.data.circles[1].memo === "keep-b",
    "auto pinが別circleを変更しました",
  );

  // circle reprocess resultはindexがずれてもidentityで解決し、別jobが別circleへ
  // 適用した変更を保持する。
  const afterFirstJob = applyEventPatchToLatest(
    {
      event: { name: "race" },
      circles: [
        { name: "inserted", space: "Z-00", items: [] },
        { name: "A", space: "A-01", items: [] },
        { name: "B", space: "B-01", items: [] },
      ],
    },
    {
      circlePatches: [
        {
          circleIndex: 0,
          circleIdentity: { name: "A", space: "A-01" },
          changes: { items: [{ name: "job-a" }] },
        },
      ],
    },
  );
  const afterSecondJob = applyEventPatchToLatest(afterFirstJob.data, {
    circlePatches: [
      {
        circleIndex: 1,
        circleIdentity: { name: "B", space: "B-01" },
        changes: { items: [{ name: "job-b" }] },
      },
    ],
  });
  assert(
    (afterSecondJob.data.circles[1].items[0] as { name: string }).name === "job-a" &&
      (afterSecondJob.data.circles[2].items[0] as { name: string }).name === "job-b",
    "二jobの別circle patchがlost updateになりました",
  );
  assert(
    autoPinLatest.circles[0].pin_x === 0.1,
    "patch helperがlatest inputを直接mutateしました",
  );
  const matchingFingerprintWithoutIdentity = applyEventPatchToLatest(
    { circles: [{ pin_x: 0.1 }] },
    {
      baseFingerprint: { contentHash: "same" },
      circlePatches: [{ circleIndex: 0, changes: { pin_x: 0.8 } }],
    },
    { contentHash: "same" },
  );
  assert(
    matchingFingerprintWithoutIdentity.data.circles[0].pin_x === 0.8,
    "同一documentのpreferred index patchを拒否しました",
  );
  let emptyIdentityMismatchRejected = false;
  try {
    applyEventPatchToLatest(
      { circles: [{ pin_x: 0.1 }] },
      {
        baseFingerprint: { contentHash: "old" },
        circlePatches: [{ circleIndex: 0, changes: { pin_x: 0.8 } }],
      },
      { contentHash: "new" },
    );
  } catch {
    emptyIdentityMismatchRejected = true;
  }
  assert(
    emptyIdentityMismatchRejected,
    "fingerprint不一致で空identityのpreferred indexを適用しました",
  );
  let duplicateIdentityMismatchRejected = false;
  try {
    applyEventPatchToLatest(
      {
        circles: [
          { name: "duplicate", space: "A-01", pin_x: 0.1 },
          { name: "duplicate", space: "A-01", pin_x: 0.2 },
        ],
      },
      {
        baseFingerprint: { contentHash: "old" },
        circlePatches: [
          {
            circleIndex: 0,
            circleIdentity: { name: "duplicate", space: "A-01" },
            changes: { pin_x: 0.8 },
          },
        ],
      },
      { contentHash: "new" },
    );
  } catch {
    duplicateIdentityMismatchRejected = true;
  }
  assert(
    duplicateIdentityMismatchRejected,
    "fingerprint不一致で重複identityのpreferred indexを適用しました",
  );
  let sameFieldConflict = false;
  try {
    applyEventPatchToLatest(
      {
        circles: [{ name: "A", space: "A-01", pin_x: 0.7 }],
      },
      {
        baseFingerprint: { contentHash: "old" },
        circlePatches: [
          {
            circleIndex: 0,
            circleIdentity: { name: "A", space: "A-01" },
            baseCircle: { name: "A", space: "A-01", pin_x: 0.1 },
            changes: { pin_x: 0.9 },
          },
        ],
      },
      { contentHash: "new" },
    );
  } catch {
    sameFieldConflict = true;
  }
  assert(sameFieldConflict, "同一fieldの並行編集を上書きしました");

  console.log("event-write-coordinator tests passed");
}

void main();
