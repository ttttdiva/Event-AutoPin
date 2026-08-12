import {
  cloneJsonSnapshot,
  RevisionedSaveQueue,
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

  console.log("revisioned-save-queue tests passed");
}

void main().catch((error) => {
  console.error(error);
  throw error;
});
