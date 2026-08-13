import { createMutationEpochGuard } from "./mutation-epoch";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function runMutationEpochTests(): Promise<void> {
  const guard = createMutationEpochGuard<string>();
  const first = guard.next("circle");
  const second = guard.next("circle");
  assert(!guard.isCurrent("circle", first), "older token must be stale");
  assert(guard.isCurrent("circle", second), "latest token must be current");

  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const queuedFirst = guard.enqueue("circle", async () => {
    order.push("first-start");
    await firstRelease;
    order.push("first-end");
  });
  const queuedSecond = guard.enqueue("circle", async () => {
    order.push("second");
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(order.join(",") === "first-start", "second mutation must wait in queue");
  releaseFirst();
  await Promise.all([queuedFirst, queuedSecond]);
  assert(
    order.join(",") === "first-start,first-end,second",
    "per-circle queue ordering changed",
  );

  // Map drag/remove operations share the same per-circle key. A failed older
  // write must release the queue so the latest drag still reaches the DB.
  const mapOrder: string[] = [];
  const mapFirst = guard.next("map-circle");
  const mapSecond = guard.next("map-circle");
  const failedMap = guard.enqueue("map-circle", async () => {
    mapOrder.push("map-fail");
    throw new Error("synthetic map failure");
  });
  const latestMap = guard.enqueue("map-circle", async () => {
    mapOrder.push("map-latest");
    return "ok";
  });
  await Promise.allSettled([failedMap, latestMap]);
  assert(
    mapOrder.join(",") === "map-fail,map-latest",
    "map mutation queue did not recover after rollback failure",
  );
  assert(!guard.isCurrent("map-circle", mapFirst), "old map token must be stale");
  assert(guard.isCurrent("map-circle", mapSecond), "latest map token must win");

  // reset() invalidates UI tokens but must not break the DB chain. This
  // models route A→B→A where the same event/circle key is revisited while the
  // first write is still in flight.
  const routeOrder: string[] = [];
  let releaseRoute!: () => void;
  const routeGate = new Promise<void>((resolve) => {
    releaseRoute = resolve;
  });
  const routeFirst = guard.enqueue("event-a:circle", async () => {
    routeOrder.push("A-first-start");
    await routeGate;
    routeOrder.push("A-first-end");
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  guard.reset(); // navigate to B, then back to A
  const routeToken = guard.next("event-a:circle");
  const routeSecond = guard.enqueue("event-a:circle", async () => {
    routeOrder.push("A-second");
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(
    routeOrder.join(",") === "A-first-start",
    "reset must retain the in-flight route chain",
  );
  releaseRoute();
  await Promise.all([routeFirst, routeSecond]);
  assert(
    routeOrder.join(",") === "A-first-start,A-first-end,A-second",
    "A→B→A database writes must remain serialized",
  );
  assert(guard.isCurrent("event-a:circle", routeToken), "new route token should commit");

  // Absolute status writes preserve the second intent when the first write
  // fails (the app uses updateCirclePurchaseStatus(next), not a DB-side cycle
  // read). The final database value must be the latest desired status 2.
  let fakeDbStatus = 0;
  const statusKey = "event-a:status-circle";
  const firstStatusToken = guard.next(statusKey);
  const secondStatusToken = guard.next(statusKey);
  const firstStatus = guard.enqueue(statusKey, async () => {
    throw new Error("synthetic first status failure");
  });
  const secondStatus = guard.enqueue(statusKey, async () => {
    fakeDbStatus = 2;
  });
  await Promise.allSettled([firstStatus, secondStatus]);
  assert(fakeDbStatus === 2, "latest absolute status intent must commit as 2");
  assert(!guard.isCurrent(statusKey, firstStatusToken), "first status token stale");
  assert(guard.isCurrent(statusKey, secondStatusToken), "second status token current");

  // First intent commits 1, then latest intent 2 fails. Rollback must read
  // the committed value at the second queue callback (1), not at enqueue time
  // (0), so the final DB status remains 1.
  let sequentialStatus = 0;
  let committedAtCallback = 0;
  const sequentialKey = "event-a:sequential-status";
  const firstCommit = guard.enqueue(sequentialKey, async () => {
    sequentialStatus = 1;
    committedAtCallback = sequentialStatus;
  });
  const secondFailure = guard.enqueue(sequentialKey, async () => {
    const rollbackBase = committedAtCallback;
    try {
      throw new Error("synthetic latest failure");
    } catch {
      sequentialStatus = rollbackBase;
    }
  });
  await Promise.all([firstCommit, secondFailure]);
  assert(
    sequentialStatus === 1,
    "second failure must rollback to first committed status 1",
  );

  // Route/session ownership check: a queued callback captured by event A must
  // not write after A→B navigation even if the numeric circle id is reused.
  let activeSession = 1;
  let staleWrites = 0;
  const capturedSession = activeSession;
  const staleWrite = guard.enqueue("event-a:reused-circle", async () => {
    if (capturedSession !== activeSession) return;
    staleWrites += 1;
  });
  activeSession = 2;
  await staleWrite;
  assert(staleWrites === 0, "stale reused-id mutation must be skipped");

  // The same generation check must happen before optimistic UI state is
  // touched by a stale callback.
  let uiStatus = 0;
  const staleUiToken = guard.next("stale-ui");
  guard.reset();
  if (guard.isCurrent("stale-ui", staleUiToken)) uiStatus = 2;
  assert(uiStatus === 0, "stale callback must not optimistically mutate UI");

  const oldAfterReset = guard.next("circle");
  guard.reset();
  assert(!guard.isCurrent("circle", oldAfterReset), "reset invalidates old tokens");
  console.log("mutation-epoch.test passed");
}
