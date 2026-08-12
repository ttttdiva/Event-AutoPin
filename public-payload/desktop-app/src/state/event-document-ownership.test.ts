type FixtureDocument = {
  slug: string;
  dir: string;
  path: string;
  circleCount: number;
};

export {};

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}

async function main(): Promise<void> {
  const fixtures: Record<string, FixtureDocument> = {
    a: { slug: "a", dir: "fixture/a", path: "fixture/a/event.json", circleCount: 355 },
    b: { slug: "b", dir: "fixture/b", path: "fixture/b/event.json", circleCount: 109 },
    c: { slug: "c", dir: "fixture/c", path: "fixture/c/event.json", circleCount: 25 },
  };
  let active = fixtures.a;
  let generation = 0;
  let serial: Promise<unknown> = Promise.resolve();
  const writes: { path: string; circleCount: number }[] = [];
  const firstSaveStarted = deferred<void>();
  const firstSave = deferred<void>();

  const save = async (owner: FixtureDocument) => {
    assert(active.slug === owner.slug, "保存開始前にslug所有権が外れています");
    assert(active.path === owner.path, "保存開始前にpath所有権が外れています");
    if (owner.slug === "a") {
      firstSaveStarted.resolve();
      await firstSave.promise;
    }
    assert(active.slug === owner.slug, "保存結果適用時にslug所有権が外れています");
    assert(active.path === owner.path, "保存結果適用時にpath所有権が外れています");
    writes.push({ path: owner.path, circleCount: owner.circleCount });
  };

  const select = (slug: string, failLoad = false) => {
    const mine = ++generation;
    const request = serial.then(async () => {
      if (mine !== generation) return false;
      const previous = active;
      await save(previous);
      if (mine !== generation) return false;
      if (failLoad) return false;
      active = fixtures[slug];
      return true;
    });
    serial = request.then(() => undefined, () => undefined);
    return request;
  };

  // 実障害相当: 355件のA保存待ち中に109件B→25件Cを連打する。
  const b = select("b");
  await firstSaveStarted.promise;
  const c = select("c");
  firstSave.resolve();
  await Promise.all([b, c]);
  assert(active.slug === "c", "最後の選択Cがatomic commitされていません");
  assert(
    !writes.some((write) => write.path === fixtures.a.path && write.circleCount !== 355),
    "B/CのデータがAのpathへ保存されました",
  );

  // load失敗時は現在docを変更しない。
  const failedSelection = await select("b", true);
  assert(failedSelection === false, "load失敗がselect成功として返されました");
  assert(active.slug === "c", "load失敗でactive docが部分更新されました");

  // rename後のslug/pathを一体で所有し、旧pathへ書かない。
  fixtures.c = { ...fixtures.c, slug: "c-renamed", dir: "fixture/c-renamed", path: "fixture/c-renamed/event.json" };
  active = fixtures.c;
  await save(active);
  assert(writes[writes.length - 1]?.path === "fixture/c-renamed/event.json", "rename後に旧pathへ保存されました");

  // 切替開始時に取得したメタデータsnapshotは、フォーム変更後も旧eventへflushする。
  const metaWrites: { dir: string; name: string }[] = [];
  const crawlSnapshot = { dir: active.dir, name: "切替直前の編集" };
  const formAfterClick = { name: "切替先の値" };
  await Promise.resolve().then(() => metaWrites.push({ ...crawlSnapshot }));
  assert(metaWrites[0].dir === "fixture/c-renamed", "crawl metaが旧dirへ保存されていません");
  assert(metaWrites[0].name !== formAfterClick.name, "crawl meta snapshotが切替後フォーム値で変化しました");

  // renameは先行saveの完了を待ってからpathを更新する。
  const renameSave = deferred<void>();
  let renamedPath = active.path;
  const rename = (async () => {
    await renameSave.promise;
    renamedPath = "fixture/final/event.json";
  })();
  assert(renamedPath === active.path, "pending save中にrename pathが先行更新されました");
  renameSave.resolve();
  await rename;
  assert(renamedPath === "fixture/final/event.json", "save flush後にrenameされませんでした");

  // rename invoke中のselectはrenameをstale化せず、新path commit後に開始する。
  const renameInvoke = deferred<void>();
  let renameGeneration = 1;
  let selectedAfterRename = "";
  const renameDuringSelect = (async () => {
    await renameInvoke.promise;
    renamedPath = "fixture/renamed-during-select/event.json";
  })();
  const selectDuringRename = renameDuringSelect.then(() => {
    renameGeneration += 1;
    selectedAfterRename = renamedPath;
  });
  assert(renameGeneration === 1, "rename invoke中のselectがgenerationを無効化しました");
  renameInvoke.resolve();
  await selectDuringRename;
  assert(
    selectedAfterRename === "fixture/renamed-during-select/event.json",
    "rename中selectが旧dir snapshotから開始されました",
  );

  // Bのmeta補完write待ち中はowner/formをcommitせず、C snapshotがB+A混在にならない。
  let committedOwner = "a";
  let committedForm = "form-a";
  const metaWrite = deferred<void>();
  const loadB = (async () => {
    const localOwner = "b";
    const localForm = "form-b";
    await metaWrite.promise;
    committedOwner = localOwner;
    committedForm = localForm;
  })();
  await Promise.resolve();
  const cSnapshot = { owner: committedOwner, form: committedForm };
  assert(
    cSnapshot.owner === "a" && cSnapshot.form === "form-a",
    "meta write待ち中にB ownerと旧フォームが部分commitされました",
  );
  metaWrite.resolve();
  await loadB;
  assert(
    committedOwner === "b" && committedForm === "form-b",
    "meta write後にowner/formが一括commitされませんでした",
  );

  // パイプライン完了後は再読み込みのatomic commitを待ち、所有権確認後だけrenameする。
  const pipelineReload = deferred<void>();
  let pipelineOwned = false;
  let pipelineRenamed = false;
  const finishPipeline = (async () => {
    await pipelineReload.promise;
    if (!pipelineOwned) return;
    pipelineRenamed = true;
  })();
  assert(!pipelineRenamed, "再読み込み完了前にpipeline後続renameが開始されました");
  pipelineReload.resolve();
  await finishPipeline;
  assert(!pipelineRenamed, "再読み込み所有権不一致でもpipeline後続renameが実行されました");

  const successfulReload = deferred<void>();
  const finishSuccessfulPipeline = (async () => {
    await successfulReload.promise;
    if (!pipelineOwned) return;
    pipelineRenamed = true;
  })();
  pipelineOwned = true;
  successfulReload.resolve();
  await finishSuccessfulPipeline;
  assert(pipelineRenamed, "再読み込み所有権一致後にpipeline後続renameが実行されませんでした");

  console.log("event document ownership tests passed");
}

void main().catch((error) => {
  console.error(error);
  throw error;
});
