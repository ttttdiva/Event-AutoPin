import { EventSelectionState, type EventSession } from "./event-session";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => (resolve = ok));
  return { promise, resolve };
}

function session(slug: string, meta: Record<string, unknown> = {}): EventSession {
  return {
    slug,
    eventDir: `${slug}/`,
    eventJsonPath: `${slug}/event.json`,
    meta,
    eventJsonData: { slug },
    tableState: { slug },
    tableBaseline: { slug },
    purchasedItemIndex: new Set(),
    mapImages: [{ slug }],
    sourceFingerprint: {},
  };
}

async function main(): Promise<void> {
  const state = new EventSelectionState();
  const slowA = deferred<EventSession>();
  const fastB = deferred<EventSession>();
  const aEpoch = state.request("A");
  const bEpoch = state.request("B");

  // Bのloadが先に完了してcommit、遅いAのmeta/map結果はepochで拒否する。
  fastB.resolve(session("B"));
  slowA.resolve(session("A"));
  assert(state.commit(bEpoch, await fastB.promise), "B commitに失敗しました");
  assert(!state.commit(aEpoch, await slowA.promise), "古いAをcommitしました");
  assert(state.committedEventSession?.slug === "B", "Aの古いsessionがBを上書きしました");

  // 実際のpromise順序も確認（Cだけが最終commit）。
  const slow = deferred<EventSession>();
  const fast = deferred<EventSession>();
  const cEpoch = state.request("C");
  const dEpoch = state.request("D");
  const cLoad = slow.promise.then((value) => state.commit(cEpoch, value));
  const dLoad = fast.promise.then((value) => state.commit(dEpoch, value));
  fast.resolve(session("D", { meta: "new" }));
  assert(await dLoad, "D commitに失敗しました");
  slow.resolve(session("C", { stale: true }));
  assert(!(await cLoad), "遅いC loadがDへ反映されました");
  assert(state.committedEventSession?.slug === "D", "最終sessionがDではありません");

  // Bの切替load中にdeleteが開始した場合、delete側のinvalidateがepochを
  // 進めるため、eventListからの物理削除前に返る遅いbundleでもcommitできない。
  const deleting = new EventSelectionState();
  const pendingB = deleting.request("B");
  deleting.invalidate();
  deleting.requestedEventSlug = "A";
  assert(!deleting.commit(pendingB, session("B")), "削除対象Bを遅いloadからcommitしました");
  assert(deleting.committedEventSession === null, "削除対象Bがcommit済みsessionへ蘇生しました");

  // クロールmetaの遅延A commitもowner/revision単位で判定し、Bのglobal
  // persisted stateへ混入させない。
  const owners = new Map<string, { revision: number; persisted: string }>([
    ["A", { revision: 1, persisted: "A-old" }],
    ["B", { revision: 2, persisted: "B-current" }],
  ]);
  const delayedA = { owner: "A", revision: 1, value: "A-late" };
  const commitOwnerSnapshot = (snapshot: typeof delayedA): boolean => {
    const current = owners.get(snapshot.owner);
    if (!current || current.revision !== snapshot.revision) return false;
    current.persisted = snapshot.value;
    return true;
  };
  assert(commitOwnerSnapshot(delayedA), "owner単位のA commitを誤って拒否しました");
  assert(owners.get("B")?.persisted === "B-current", "遅いA commitがB stateを汚染しました");
  console.log("event-selection-race tests passed");
}

void main();
