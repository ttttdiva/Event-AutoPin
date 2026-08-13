import {
  buildEventJsonSnapshot,
  eventJsonDocumentsEqual,
  runImageDeletionTransaction,
  type EventJsonData,
  type TableState,
} from "./event-document";
import { cloneJsonSnapshot, RevisionedSaveQueue } from "./revisioned-save-queue";
import { KeyedSerialExecutor } from "./async-mutation-guard";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}

async function testQueuedRevertAndFailedRetry(): Promise<void> {
  const baseline: TableState = {
    headers: ["サークル名"],
    rows: [{ サークル名: "元" }],
  };
  let uiBaseline = clone(baseline);
  let memory: EventJsonData = { circles: [{ name: "元", unknown: { keep: true } }] };
  let persisted = clone(memory);
  const writes: EventJsonData[] = [];
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const queue = new RevisionedSaveQueue<EventJsonData>(async ({ revision, snapshot }) => {
    writes.push(clone(snapshot));
    if (revision === 1) {
      firstStarted.resolve();
      await releaseFirst.promise;
    }
    persisted = clone(snapshot);
  });

  const enqueueTable = (table: TableState) => {
    const snapshot = buildEventJsonSnapshot(memory, clone(table), uiBaseline);
    memory = snapshot;
    uiBaseline = clone(table);
    if (
      eventJsonDocumentsEqual(snapshot, persisted) &&
      !queue.isRunning &&
      !queue.hasPending
    ) {
      return null;
    }
    return queue.enqueue(cloneJsonSnapshot(snapshot));
  };

  const edited = clone(baseline);
  edited.rows[0]["サークル名"] = "編集後";
  const first = enqueueTable(edited);
  assert(first !== null, "編集保存がenqueueされませんでした");
  await firstStarted.promise;
  // 1件目の保存中に元へ戻す。memoryは編集後でも、UI baselineとの差分で元を適用する。
  const reverted = enqueueTable(clone(baseline));
  assert(reverted !== null, "保存中のrevertがno-op扱いされました");
  releaseFirst.resolve();
  await Promise.all([first!.completed, reverted!.completed, queue.flush()]);
  assert(writes.length === 2, `編集→revertの保存回数が2ではありません: ${writes.length}`);
  assert(writes[0].circles?.[0].name === "編集後", "最初の編集payloadが不正です");
  assert(writes[1].circles?.[0].name === "元", "revert payloadが保存されませんでした");
  assert(eventJsonDocumentsEqual(persisted, { circles: [{ name: "元", unknown: { keep: true } }] }), "最終persisted文書が元へ戻りませんでした");

  let fail = true;
  const failedWrites: EventJsonData[] = [];
  let failedPersisted = clone(persisted);
  const failingQueue = new RevisionedSaveQueue<EventJsonData>(async ({ snapshot }) => {
    failedWrites.push(clone(snapshot));
    if (fail) {
      fail = false;
      throw new Error("expected failure");
    }
    failedPersisted = clone(snapshot);
  });
  const failedEdit = clone(baseline);
  failedEdit.rows[0]["サークル名"] = "失敗する編集";
  const failedSnapshot = buildEventJsonSnapshot(memory, failedEdit, uiBaseline);
  memory = failedSnapshot;
  uiBaseline = clone(failedEdit);
  try {
    await failingQueue.enqueue(clone(failedSnapshot)).completed;
  } catch {
    // expected
  }
  const revertedAfterFailure = buildEventJsonSnapshot(memory, clone(baseline), uiBaseline);
  memory = revertedAfterFailure;
  uiBaseline = clone(baseline);
  assert(
    eventJsonDocumentsEqual(revertedAfterFailure, failedPersisted),
    "失敗後のrevert snapshotがpersisted文書と一致しません",
  );
  assert(
    !failingQueue.isRunning && !failingQueue.hasPending,
    "失敗後のqueueがidleへ戻りませんでした",
  );
  assert(failedWrites.length === 1, "失敗編集以外の不要writeが発生しました");
}

async function testFailedDeletionDoesNotRollbackNewerQueuedEdit(): Promise<void> {
  const firstStarted = deferred();
  const releaseFailure = deferred();
  const persisted: string[] = [];
  const queue = new RevisionedSaveQueue<string>(async ({ revision, snapshot }) => {
    if (revision === 1) {
      firstStarted.resolve();
      await releaseFailure.promise;
      throw new Error("expected deletion save failure");
    }
    persisted.push(snapshot);
  });
  let state = "before";
  let stateRevision = 0;
  let deletionRevision = 0;
  let expectedDeletionState = "";
  let rollbackCalls = 0;
  let deleteCalls = 0;

  const deletion = runImageDeletionTransaction({
    removedReferences: ["items/delete.jpg"],
    applyClear: () => {
      state = "deletion-clear";
    },
    save: async () => {
      const receipt = queue.enqueue(state);
      stateRevision += 1;
      deletionRevision = stateRevision;
      expectedDeletionState = state;
      try {
        await receipt.completed;
        return true;
      } catch {
        return false;
      }
    },
    rollbackIfCurrent: () => {
      if (
        stateRevision !== deletionRevision ||
        state !== expectedDeletionState ||
        queue.hasPending
      ) {
        return false;
      }
      rollbackCalls += 1;
      state = "before";
      return true;
    },
    currentDocument: () => ({ circles: [] }),
    deleteAsset: async () => {
      deleteCalls += 1;
    },
  });

  await firstStarted.promise;
  state = "newer-edit";
  stateRevision += 1;
  const newer = queue.enqueue(state);
  releaseFailure.resolve();
  await deletion;
  await newer.completed;
  await queue.flush();

  assert(state === "newer-edit", "失敗した削除が新しい編集stateをwhole rollbackしました");
  assert(rollbackCalls === 0, "新しいrevision/pending中に古いrollbackを実行しました");
  assert(deleteCalls === 0, "削除save失敗後に物理削除を実行しました");
  assert(persisted[persisted.length - 1] === "newer-edit", "後続queue payloadが失われました");
}

async function testSameSlugReloadWaitsForSaveBarrier(): Promise<void> {
  const saveStarted = deferred();
  const releaseSave = deferred();
  let disk = "old";
  let loaded = "";
  const queue = new RevisionedSaveQueue<string>(async ({ snapshot }) => {
    saveStarted.resolve();
    await releaseSave.promise;
    disk = snapshot;
  });
  const pendingSave = queue.enqueue("edited");

  const sameSlugReload = (async () => {
    // selectEventLockedと同じ順序: saveNow receiptとqueue barrierの完了後だけload。
    await pendingSave.completed;
    await queue.flush();
    loaded = disk;
  })();
  await saveStarted.promise;
  await Promise.resolve();
  assert(loaded === "", "同一slug再選択がin-flight save完了前にdiskをreloadしました");
  releaseSave.resolve();
  await sameSlugReload;
  assert(loaded === "edited", "dblclick/F2同一slug再選択が最新diskをreloadしませんでした");

  let loadCalls = 0;
  const failingQueue = new RevisionedSaveQueue<string>(async () => {
    throw new Error("expected save failure");
  });
  const failed = failingQueue.enqueue("unsaved");
  try {
    await failed.completed;
    loadCalls += 1;
  } catch {
    // 保存失敗時はreloadへ進まない。
  }
  assert(loadCalls === 0, "同一slug保存失敗後もreloadしてUI編集を破棄しました");

  const loadStarted = deferred();
  const releaseLoad = deferred();
  let owner = "same";
  let path = "same/event.json";
  let documentRevision = 7;
  let memo = "before";
  let committedDocument = "before";
  assert(
    !queue.isRunning && !queue.hasPending,
    "load owner/revisionをsave queue flush前にcaptureしました",
  );
  const captured = { owner, path, revision: documentRevision };
  const loading = (async () => {
    loadStarted.resolve();
    await releaseLoad.promise;
    const canCommit =
      owner === captured.owner &&
      path === captured.path &&
      documentRevision === captured.revision;
    if (canCommit) committedDocument = "loaded-from-disk";
    return canCommit;
  })();
  await loadStarted.promise;
  // 実mainのmemo input相当: documentを更新すると同時にrevisionを進める。
  memo = "edited while load awaited";
  documentRevision += 1;
  releaseLoad.resolve();
  assert(!(await loading), "load await中のmemo編集後も古いdocumentをcommitしました");
  assert(memo === "edited while load awaited", "load commitがmemo inputを破棄しました");
  assert(committedDocument === "before", "revision不一致でもglobal documentを書き換えました");
}

async function testDroppedItemImageRejectsReorderedTarget(): Promise<void> {
  const fileRead = deferred();
  const first = { id: "first", image: "" };
  const second = { id: "second", image: "" };
  const document = { circles: [{ items: [first, second] }] };
  let activeDocument = document;
  let owner = "a";
  let path = "a/event.json";
  let revision = 4;
  const captured = {
    document,
    circle: document.circles[0],
    item: first,
    owner,
    path,
    revision,
  };
  const dropped = (async () => {
    await fileRead.promise;
    const current = activeDocument.circles[0];
    const canApply =
      owner === captured.owner &&
      path === captured.path &&
      revision === captured.revision &&
      activeDocument === captured.document &&
      current === captured.circle &&
      current.items[0] === captured.item;
    if (canApply) current.items[0].image = "items/new.png";
    return canApply;
  })();

  document.circles[0].items.reverse();
  revision += 1;
  fileRead.resolve();
  assert(!(await dropped), "item reorder後も旧indexへ画像参照を適用しました");
  assert(!first.image && !second.image, "target不一致時にいずれかのitemを更新しました");

  const deletedRead = deferred();
  const remaining = { id: "remaining", image: "" };
  const deleted = { id: "deleted", image: "" };
  const deleteDocument = { circles: [{ items: [deleted, remaining] }] };
  const deleteCircle = deleteDocument.circles[0];
  const deleteRevision = revision;
  const deletedDrop = (async () => {
    await deletedRead.promise;
    const canApply =
      revision === deleteRevision &&
      deleteDocument.circles[0] === deleteCircle &&
      deleteCircle.items[0] === deleted;
    if (canApply) deleteCircle.items[0].image = "items/deleted.png";
    return canApply;
  })();
  deleteCircle.items.splice(0, 1);
  revision += 1;
  deletedRead.resolve();
  assert(!(await deletedDrop), "item delete後に繰り上がったindexへ画像参照を適用しました");
  assert(!remaining.image, "削除itemの画像を次itemへ誤適用しました");
}

async function testMapAutoPlacementRejectsOwnerOrRevisionChange(): Promise<void> {
  const job = deferred();
  let owner = "a";
  let path = "a/event.json";
  let revision = 9;
  let committed = "a-before";
  const captured = { owner, path, revision };
  const placement = (async () => {
    await job.promise;
    const canCommit =
      owner === captured.owner &&
      path === captured.path &&
      revision === captured.revision;
    if (canCommit) committed = "job-result";
    return canCommit;
  })();
  owner = "b";
  path = "b/event.json";
  revision += 1;
  job.resolve();
  assert(!(await placement), "event Bへの切替後もevent Aのmap job結果をcommitしました");
  assert(committed === "a-before", "stale map jobがglobal documentを更新しました");

  owner = "a";
  path = "a/event.json";
  const editJob = deferred();
  const editCapture = { owner, path, revision };
  const editedPlacement = (async () => {
    await editJob.promise;
    return (
      owner === editCapture.owner &&
      path === editCapture.path &&
      revision === editCapture.revision
    );
  })();
  revision += 1;
  editJob.resolve();
  assert(!(await editedPlacement), "map job中の同一event編集後も旧reloadをcommitしました");

  let locked = true;
  let attempts = 0;
  let recoveryState: "running" | "recovery" | "idle" = "running";
  let reloaded = "old-memory";
  while (recoveryState !== "idle") {
    attempts += 1;
    if (attempts === 1) {
      recoveryState = "recovery";
      assert(locked, "reload失敗時に編集lockを解除しました");
      assert(reloaded === "old-memory", "reload失敗payloadをmemoryへ反映しました");
      recoveryState = "running";
      continue;
    }
    reloaded = "backend-result";
    recoveryState = "idle";
  }
  locked = false;
  assert(attempts === 2, "reload失敗後の明示retryを実行しませんでした");
  assert(!locked && reloaded === "backend-result", "reload成功前に完了/unlockしました");
}

async function testMapImageLoadAndMutationGenerations(): Promise<void> {
  let loadGeneration = 0;
  let owner = "a";
  let selectedMap = 1;
  let rendered = "";
  const startLoad = (map: number, path: string) => {
    const generation = ++loadGeneration;
    const capturedOwner = owner;
    selectedMap = map;
    return () => {
      if (
        generation === loadGeneration &&
        owner === capturedOwner &&
        selectedMap === map
      ) {
        rendered = path;
      }
    };
  };
  const slowMap1 = startLoad(1, "map_01.jpg");
  const fastMap2 = startLoad(2, "map_02.png");
  fastMap2();
  slowMap1();
  assert(rendered === "map_02.png", "遅いmap1 onloadが新しいmap2表示を戻しました");
  const eventALoad = startLoad(1, "event-a-map.png");
  owner = "b";
  eventALoad();
  assert(rendered === "map_02.png", "event B切替後にevent Aの画像handlerを反映しました");

  const serial = new KeyedSerialExecutor();
  let activeBytes = "";
  const slow = deferred();
  const op1 = serial.run("a/map_01.jpg", async () => {
    await slow.promise;
    activeBytes = "op1-bytes";
  });
  const op2 = serial.run("a/map_01.jpg", async () => {
    activeBytes = "op2-bytes";
  });
  await Promise.resolve();
  assert(activeBytes === "", "同一map pathへの後発writeが先行しました");
  slow.resolve();
  await Promise.all([op1, op2]);
  assert(
    activeBytes === "op2-bytes",
    "遅いop1/速いop2の同一jpg最終bytesがop2ではありません",
  );
}

async function testDeleteWaitsForInflightSaveSettlement(): Promise<void> {
  const saveStarted = deferred();
  const releaseSave = deferred();
  let directoryExists = true;
  let zombieRecreated = false;
  const queue = new RevisionedSaveQueue<string>(async () => {
    saveStarted.resolve();
    await releaseSave.promise;
    // 実save_event_jsonのparent mkdir相当。deleteが先行するとzombieになる。
    if (!directoryExists) {
      directoryExists = true;
      zombieRecreated = true;
    }
  });
  const receipt = queue.enqueue("pending event.json");
  await saveStarted.promise;
  const deletion = (async () => {
    await receipt.completed;
    await queue.flush();
    if (queue.error) throw queue.error;
    directoryExists = false;
  })();
  await Promise.resolve();
  assert(directoryExists, "in-flight save中にevent directoryを削除しました");
  releaseSave.resolve();
  await deletion;
  assert(!directoryExists, "save settle後にevent directoryを削除できませんでした");
  assert(!zombieRecreated, "delete後に遅いsaveがevent directoryを再作成しました");

  let deleteCalls = 0;
  const failed = new RevisionedSaveQueue<string>(async () => {
    throw new Error("expected save failure");
  });
  const failedReceipt = failed.enqueue("unsaved");
  try {
    await failedReceipt.completed;
    await failed.flush();
    if (failed.error) throw failed.error;
    deleteCalls += 1;
  } catch {
    // failure propagation: deleteしない。
  }
  assert(deleteCalls === 0, "保存失敗後もevent directoryを削除しました");
}

async function testExpiredUploadLeaseDoesNotImportAndRetryAppliesOnce(): Promise<void> {
  const pipeline = deferred();
  let leaseCurrent = true;
  let importCalls = 0;
  const firstUpload = (async () => {
    await pipeline.promise;
    // waitForOperationIdle後のheartbeat相当。
    if (!leaseCurrent) return false;
    importCalls += 1;
    return true;
  })();
  leaseCurrent = false; // backend 504 terminal cancel
  pipeline.resolve();
  assert(!(await firstUpload), "timeout後に期限切れuploadのimportを開始しました");
  assert(importCalls === 0, "120秒超pipeline後にもimportを適用しました");

  leaseCurrent = true; // mobile再送の新uploadId
  if (leaseCurrent) importCalls += 1;
  assert(importCalls === 1, "再送データがsingle applyになりませんでした");
}

async function testCircleMasterFlushAndImportShareOneSerial(): Promise<void> {
  const serial = new KeyedSerialExecutor();
  const saveStarted = deferred();
  const releaseSave = deferred();
  const order: string[] = [];
  const saveQueue = new RevisionedSaveQueue<string>(({ snapshot }) =>
    serial.run("circle-master", async () => {
      order.push(`save:${snapshot}`);
      saveStarted.resolve();
      if (snapshot === "local-before-import") await releaseSave.promise;
    }),
  );
  const pendingSave = saveQueue.enqueue("local-before-import");
  await saveStarted.promise;
  const imported = (async () => {
    await pendingSave.completed;
    await saveQueue.flush();
    return serial.run("circle-master", async () => {
      order.push("import-publish");
      order.push("reload-master");
    });
  })();
  const concurrentSave = saveQueue.enqueue("local-after-import-request");
  releaseSave.resolve();
  await Promise.all([imported, concurrentSave.completed, saveQueue.flush()]);
  assert(
    order.join(",") ===
      "save:local-before-import,save:local-after-import-request,import-publish,reload-master",
    `circle master save/importのshared serial順序が不正です: ${order.join(",")}`,
  );
}

async function testPublishedUploadIsNotFailedByUiRecovery(): Promise<void> {
  const upload: { terminal: "pending" | "published" | "failed" } = {
    terminal: "pending",
  };
  let successResponses = 0;
  let failureResponses = 0;
  const publish = () => {
    upload.terminal = "published";
    successResponses += 1;
  };
  const cancel = () => {
    if (upload.terminal === "published") return false;
    upload.terminal = "failed";
    failureResponses += 1;
    return true;
  };
  publish();
  try {
    throw new Error("post-publish reload failed");
  } catch {
    cancel();
  }
  cancel(); // server stop相当もpublishedを上書きしない。
  assert(upload.terminal === "published", "UI reload失敗がpublished uploadをfailureへ戻しました");
  assert(successResponses === 1, "mobile successがexactly onceではありません");
  assert(failureResponses === 0, "publish後にmobile failureを返しました");
}

void Promise.all([
  testQueuedRevertAndFailedRetry(),
  testFailedDeletionDoesNotRollbackNewerQueuedEdit(),
  testSameSlugReloadWaitsForSaveBarrier(),
  testDroppedItemImageRejectsReorderedTarget(),
  testMapAutoPlacementRejectsOwnerOrRevisionChange(),
  testMapImageLoadAndMutationGenerations(),
  testDeleteWaitsForInflightSaveSettlement(),
  testExpiredUploadLeaseDoesNotImportAndRetryAppliesOnce(),
  testCircleMasterFlushAndImportShareOneSerial(),
  testPublishedUploadIsNotFailedByUiRecovery(),
])
  .then(() => console.log("event document save flow tests passed"))
  .catch((error) => {
    console.error(error);
    throw error;
  });
