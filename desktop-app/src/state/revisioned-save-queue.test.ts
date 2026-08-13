import {
  cloneJsonSnapshot,
  KeyedRevisionedSaveQueue,
  RevisionedSaveQueue,
  setCloneObserver,
} from "./revisioned-save-queue";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const calls: { revision: number; value: number }[] = [];
  let releaseFirst: () => void = () => {
    throw new Error("first save has not started");
  };
  let firstStartedResolve: (() => void) | null = null;
  const firstStarted = new Promise<void>((resolve) => {
    firstStartedResolve = resolve;
  });

  const queue = new RevisionedSaveQueue<{ value: number }>(
    async ({ revision, snapshot }) => {
      calls.push({ revision, value: snapshot.value });
      if (revision === 1) {
        firstStartedResolve?.();
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
    },
  );

  const firstSource = { value: 1 };
  const first = queue.enqueue(cloneJsonSnapshot(firstSource));
  firstSource.value = 99;
  await firstStarted;
  const second = queue.enqueue(cloneJsonSnapshot({ value: 2 }));
  releaseFirst();
  await Promise.all([first.completed, second.completed, queue.flush()]);

  assert(calls.length === 2, `保存回数が2ではありません: ${calls.length}`);
  assert(calls[0].value === 1, "最初の保存が後続編集で書き換わっています");
  assert(calls[1].value === 2, "保存中の後続編集が再保存されていません");
  assert(queue.savedRevision === 2, "最新revisionが保存済みになっていません");
  assert(!queue.isRunning && !queue.hasPending, "flush後も保存キューがidleではありません");

  const failingQueue = new RevisionedSaveQueue<{ value: number }>(async () => {
    throw new Error("expected save failure");
  });
  let failed = false;
  try {
    await failingQueue.enqueue({ value: 3 }).completed;
  } catch {
    failed = true;
  }
  assert(failed, "保存エラーがreceiptへ伝播していません");

  const disposed: number[] = [];
  let finishActive: () => void = () => undefined;
  let activeStartedResolve: () => void = () => undefined;
  const activeStarted = new Promise<void>((resolve) => {
    activeStartedResolve = resolve;
  });
  const disposalQueue = new RevisionedSaveQueue<{ value: number }>(
    async ({ snapshot }) => {
      if (snapshot.value === 1) {
        activeStartedResolve();
        await new Promise<void>((resolve) => {
          finishActive = resolve;
        });
      }
    },
    (snapshot) => disposed.push(snapshot.value),
  );
  const active = disposalQueue.enqueue({ value: 1 });
  await activeStarted;
  const superseded = disposalQueue.enqueue({ value: 2 });
  const latest = disposalQueue.enqueue({ value: 3 });
  finishActive();
  await Promise.all([
    active.completed,
    superseded.completed,
    latest.completed,
    disposalQueue.flush(),
  ]);
  assert(
    disposed.join(",") === "2,1,3",
    `置換/実行済みsnapshotのdisposeが不正です: ${disposed.join(",")}`,
  );

  await testKeyedQueue();

  // event-documentなど別moduleからのcloneも同一observerで計測できる。
  let observedClones = 0;
  setCloneObserver(() => {
    observedClones += 1;
  });
  cloneJsonSnapshot({ crossModule: true });
  assert(observedClones === 1, "clone observerがcross-module cloneを計測しませんでした");
  setCloneObserver(null);

  console.log("revisioned-save-queue tests passed");
}

async function testKeyedQueue(): Promise<void> {
  const calls: Array<{ key: string; value: number; revision: number }> = [];
  let releaseA!: () => void;
  let startedA!: () => void;
  const aStarted = new Promise<void>((resolve) => (startedA = resolve));
  const queue = new KeyedRevisionedSaveQueue<{ value: number }>(
    async ({ key, revision, snapshot }) => {
      calls.push({ key, value: snapshot.value, revision });
      if (key === "A" && revision === 1) {
        startedA();
        await new Promise<void>((resolve) => (releaseA = resolve));
      }
    },
  );

  const a1 = queue.enqueue("A", { value: 1 });
  await aStarted;
  const a2 = queue.enqueue("A", { value: 2 });
  const a3 = queue.enqueue("A", { value: 3 });
  // BはAのin-flight saveを待たずに開始できる。
  const b1 = queue.enqueue("B", { value: 10 });
  await Promise.all([b1.completed, queue.flushKey("B")]);
  assert(calls.some((call) => call.key === "B" && call.value === 10), "Bの保存が開始されませんでした");
  assert(queue.getStatus("A").running || queue.getStatus("A").pending, "A statusが不正です");

  releaseA();
  await Promise.all([a1.completed, a2.completed, a3.completed, queue.flushKey("A")]);
  const aCalls = calls.filter((call) => call.key === "A");
  assert(aCalls.length === 2, `Aの連続revisionがcoalesceされませんでした: ${aCalls.length}`);
  assert(aCalls[0].value === 1 && aCalls[1].value === 3, "Aの最新snapshotが保存されませんでした");
  assert(queue.getStatus("A").savedRevision === 3, "Aの最新revisionが保存済みになっていません");

  let fail = true;
  const savedDuringFailure: string[] = [];
  const failing = new KeyedRevisionedSaveQueue<{ value: number }>(async ({ key, snapshot }) => {
    if (key === "A" && fail) {
      fail = false;
      throw new Error("expected keyed failure");
    }
    if (key === "A") assert(snapshot.value === 4, "retry snapshotが壊れています");
    savedDuringFailure.push(key);
  });
  const failed = failing.enqueue("A", { value: 4 });
  const bDuringFailure = failing.enqueue("B", { value: 8 });
  let rejected = false;
  try {
    await failed.completed;
  } catch {
    rejected = true;
  }
  await bDuringFailure.completed;
  assert(savedDuringFailure.includes("B"), "A失敗時にBの保存まで停止しました");
  assert(rejected, "keyed queueの保存失敗がreceiptへ伝播していません");
  assert(failing.getStatus("A").dirty, "失敗後にdirty statusが残りません");
  const retried = failing.retryKey("A");
  assert(retried !== null, "retryKeyが失敗snapshotを再試行しませんでした");
  await retried!.completed;
  assert(!failing.getStatus("A").dirty, "retry成功後もdirty statusが残っています");

  // lifecycle leaseをdisposeした失敗snapshotはそのまま再利用しない。
  // delete/rename後にgateが閉じた場合はretryを拒否し、zombie eventを作らない。
  let leaseAvailable = true;
  let leaseAcquires = 0;
  let failOnce = true;
  const lifecycleQueue = new KeyedRevisionedSaveQueue<{
    value: number;
    lease: number;
  }>(
    async ({ snapshot }) => {
      assert(snapshot.lease > 0, "retry snapshotに新しいleaseがありません");
      if (failOnce) {
        failOnce = false;
        throw new Error("expected lifecycle failure");
      }
    },
    undefined,
    (_key, snapshot) => {
      if (!leaseAvailable) return null;
      leaseAcquires += 1;
      return { ...snapshot, lease: leaseAcquires + 1 };
    },
  );
  const leaseFailed = lifecycleQueue.enqueue("deleted-event", {
    value: 1,
    lease: 1,
  });
  let leaseRejected = false;
  try {
    await leaseFailed.completed;
  } catch {
    leaseRejected = true;
  }
  assert(leaseRejected, "lifecycle lease失敗がreceiptへ伝播していません");
  leaseAvailable = false;
  assert(
    lifecycleQueue.retryKey("deleted-event") === null,
    "closed lifecycle gate後にzombie retryを許可しました",
  );
  assert(lifecycleQueue.getStatus("deleted-event").dirty, "retry拒否後のdirty statusが消えました");
  leaseAvailable = true;
  const leaseRetry = lifecycleQueue.retryKey("deleted-event");
  assert(leaseRetry !== null, "lifecycle lease再取得後のretryを拒否しました");
  await leaseRetry!.completed;
  assert(leaseAcquires === 1, "retryでlease再取得callbackが呼ばれていません");
  assert(!lifecycleQueue.getStatus("deleted-event").dirty, "lifecycle retry成功後もdirtyです");

  // flushAllは全keyのdrainが終わるまで待つ。
  const all = new KeyedRevisionedSaveQueue<number>(async () => undefined);
  all.enqueue("A", 1);
  all.enqueue("B", 2);
  await all.flushAll();
  assert(!all.getStatus("A").running && !all.getStatus("B").running, "flushAll後にkeyがrunningです");
}

void main().catch((error) => {
  console.error(error);
  throw error;
});
