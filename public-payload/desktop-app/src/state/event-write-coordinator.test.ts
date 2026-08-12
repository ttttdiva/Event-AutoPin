import { EventLifecycleGate, EventWriteCoordinator } from "./event-write-coordinator";

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

  console.log("event-write-coordinator tests passed");
}

void main();
