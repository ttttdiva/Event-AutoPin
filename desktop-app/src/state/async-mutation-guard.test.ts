import {
  createAsyncMutationGuard,
  KeyedSerialExecutor,
  retryUntilValue,
  type AsyncMutationState,
} from "./async-mutation-guard";

declare function require(name: string): any;
const fs = require("fs").promises;
const os = require("os");
const path = require("path");

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}

async function main(): Promise<void> {
  const document = {};
  const circle = {};
  const item = {};
  let current: AsyncMutationState = {
    owner: "a/a.json",
    revision: 1,
    document,
    targets: [circle, item],
  };
  const guard = createAsyncMutationGuard({ ...current, targets: [...current.targets] }, () => current);
  assert(guard.isCurrent(), "capture直後のguardが一致しません");
  current = { ...current, revision: 2 };
  assert(!guard.isCurrent(), "revision変更を検出しませんでした");
  current = { ...current, revision: 1, owner: "b/b.json" };
  assert(!guard.isCurrent(), "owner slug/path変更を検出しませんでした");
  current = { ...current, owner: "a/a.json", document: {} };
  assert(!guard.isCurrent(), "document identity変更を検出しませんでした");
  current = { ...current, document, targets: [circle, item] };
  current = { ...current, targets: [circle, {}] };
  assert(!guard.isCurrent(), "item identity変更を検出しませんでした");

  const serial = new KeyedSerialExecutor();
  const releaseFirst = deferred();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "eventtrail-map-serial-"));
  const mapPath = path.join(tempDir, "map_01.jpg");
  try {
    const first = serial.run(mapPath, async () => {
      await releaseFirst.promise;
      await fs.writeFile(mapPath, "op1");
    });
    const second = serial.run(mapPath, async () => {
      await fs.writeFile(mapPath, "op2");
    });
    await Promise.resolve();
    let existsBeforeRelease = true;
    try {
      await fs.access(mapPath);
    } catch {
      existsBeforeRelease = false;
    }
    assert(!existsBeforeRelease, "slow op1中にfast op2が同一pathへ先行writeしました");
    releaseFirst.resolve();
    await Promise.all([first, second]);
    assert(
      String(await fs.readFile(mapPath)) === "op2",
      "同一jpgの最終bytesが後発op2ではありません",
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  const eventImageDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "eventtrail-event-image-serial-"),
  );
  const eventImagePath = path.join(eventImageDir, "event_image.jpg");
  const releaseEventFirst = deferred();
  try {
    const first = serial.run("event-a/event_image", async () => {
      await releaseEventFirst.promise;
      await fs.writeFile(eventImagePath, "first-image");
    });
    const second = serial.run("event-a/event_image", async () => {
      await fs.writeFile(eventImagePath, "second-image");
    });
    releaseEventFirst.resolve();
    await Promise.all([first, second]);
    assert(
      String(await fs.readFile(eventImagePath)) === "second-image",
      "event-image固定pathのfast secondが最終bytesになりませんでした",
    );
  } finally {
    await fs.rm(eventImageDir, { recursive: true, force: true });
  }

  let retryAttempts = 0;
  let locked = true;
  const recovered = await retryUntilValue({
    attempt: async () => {
      retryAttempts += 1;
      return retryAttempts === 2 ? "reloaded" : null;
    },
    onFailure: () => {
      assert(locked, "reload失敗時に編集lockを解除しました");
    },
    wait: async () => {},
  });
  locked = false;
  assert(recovered === "reloaded" && retryAttempts === 2 && !locked, "reload成功前に完了しました");
  console.log("async mutation guard tests passed");
}

void main().catch((error) => {
  console.error(error);
  throw error;
});
