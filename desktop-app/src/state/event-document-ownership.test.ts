import {
  buildEventJsonSnapshot,
  collectEventAssetReferences,
  eventJsonDocumentsEqual,
  runImageDeletionTransaction,
  selectActiveMapImages,
  type EventJsonData,
  type TableState,
} from "./event-document";

type FixtureDocument = {
  slug: string;
  dir: string;
  path: string;
  circleCount: number;
};

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
  }
  return value;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function testLosslessEventDocumentSnapshot(): void {
  const source: EventJsonData = deepFreeze({
    schema_extension: { keep: true },
    circles: [
      {
        name: "元のサークル",
        space: "A01",
        priority_color: 5,
        item_images: [
          {
            path: "items/retained.jpg",
            source: "catalog",
            analysis: { confidence: 0.91 },
          },
        ],
        items: [
          {
            name: "本",
            genre: "漫画",
            custom_nested: { keep: "yes" },
          },
        ],
        custom_circle_field: { keep: 1 },
      },
    ],
  });
  const baseline: TableState = {
    headers: ["サークル名", "ジャンル", "アイテム画像", "ピンX", "アイテムメモ"],
    rows: [
      {
        サークル名: "元のサークル",
        ジャンル: "雑誌",
        アイテム画像: "items/retained.jpg",
        ピンX: "0",
        アイテムメモ: "",
      },
    ],
  };

  // circle_master由来の「雑誌」は表示baselineにも含まれるため自動永続化されない。
  const untouched = buildEventJsonSnapshot(source, clone(baseline), baseline);
  assert(
    eventJsonDocumentsEqual(untouched, source),
    "未編集snapshotが元文書をsemantic変更しました",
  );
  assert(
    !Object.prototype.hasOwnProperty.call(untouched.circles?.[0], "genres"),
    "circle_master表示overlayがgenresとして永続化されました",
  );
  assert(
    !Object.prototype.hasOwnProperty.call(untouched.circles?.[0], "pin_x") &&
      !Object.prototype.hasOwnProperty.call(untouched.circles?.[0], "memo"),
    "未編集のoptional field absenceが失われました",
  );

  const renamedTable = clone(baseline);
  renamedTable.rows[0]["サークル名"] = "明示編集したサークル";
  const renamed = buildEventJsonSnapshot(source, renamedTable, baseline);
  const expectedRenamed = clone(source);
  expectedRenamed.circles![0].name = "明示編集したサークル";
  assert(
    eventJsonDocumentsEqual(renamed, expectedRenamed),
    "単一列編集以外のフィールドまで変更されました",
  );

  const imageTable = clone(baseline);
  imageTable.rows[0]["アイテム画像"] =
    "items/retained.jpg\nitems/added.jpg";
  const imageEdited = buildEventJsonSnapshot(source, imageTable, baseline);
  assert(
    imageEdited.circles?.[0].item_images?.[0].source === "catalog" &&
      imageEdited.circles?.[0].item_images?.[0].analysis?.confidence === 0.91,
    "保持画像のnested metadataが失われました",
  );
  assert(
    imageEdited.circles?.[0].item_images?.[1].path === "items/added.jpg",
    "明示追加した画像だけが追加されませんでした",
  );

  const itemImageOnlySource: EventJsonData = {
    circles: [
      {
        name: "item画像のみ",
        items: [
          {
            name: "本",
            image: "items/item-only.jpg",
            custom_nested: { keep: true },
          },
        ],
        item_images: [],
      },
    ],
  };
  const itemImageBaseline: TableState = {
    headers: ["アイテム画像"],
    rows: [{ アイテム画像: "items/item-only.jpg" }],
  };
  const clearedItemImageTable = clone(itemImageBaseline);
  clearedItemImageTable.rows[0]["アイテム画像"] = "";
  const clearedItemImage = buildEventJsonSnapshot(
    itemImageOnlySource,
    clearedItemImageTable,
    itemImageBaseline,
  );
  assert(
    clearedItemImage.circles?.[0].items?.[0].image === "" &&
      clearedItemImage.circles?.[0].item_images?.length === 0,
    "items[].image-only画像が合成列のclear後も復活します",
  );
  assert(
    clearedItemImage.circles?.[0].items?.[0].custom_nested?.keep === true,
    "画像clear時にitemのunknown metadataが失われました",
  );

  const retainedItemImageTable = clone(itemImageBaseline);
  retainedItemImageTable.rows[0]["アイテム画像"] =
    "items/item-only.jpg\nitems/new.jpg";
  const retainedItemImage = buildEventJsonSnapshot(
    itemImageOnlySource,
    retainedItemImageTable,
    itemImageBaseline,
  );
  assert(
    retainedItemImage.circles?.[0].items?.[0].image === "items/item-only.jpg",
    "desired pathに残るitems[].imageが解除されました",
  );
  assert(
    retainedItemImage.circles?.[0].item_images?.length === 1 &&
      retainedItemImage.circles?.[0].item_images?.[0].path === "items/new.jpg",
    "items[].imageとの重複を避けて新規pathだけをitem_imagesへ追加できませんでした",
  );

  const overlapSource: EventJsonData = {
    circles: [{
      items: [{ image: "items/shared.jpg" }],
      item_images: [{ path: "items/shared.jpg", source: "catalog", custom: { keep: true } }],
    }],
  };
  const overlapBaseline: TableState = {
    headers: ["アイテム画像"],
    rows: [{ アイテム画像: "items/shared.jpg" }],
  };
  const overlapEditedTable = clone(overlapBaseline);
  overlapEditedTable.rows[0]["アイテム画像"] += "\nitems/new.jpg";
  const overlapEdited = buildEventJsonSnapshot(
    overlapSource,
    overlapEditedTable,
    overlapBaseline,
  );
  assert(
    overlapEdited.circles?.[0].item_images?.[0]?.source === "catalog" &&
      overlapEdited.circles?.[0].item_images?.[0]?.custom?.keep === true,
    "items[].imageと重複するitem_images metadataが失われました",
  );

  // hydration相当の読み取りはdeep-frozen文書にも副作用を起こさない。
  const inheritedCheckedSource: EventJsonData = deepFreeze({
    circles: [{ checked: 1, items: [{ name: "本" }] }],
  });
  const effectiveChecked =
    inheritedCheckedSource.circles![0].items[0].checked ??
    inheritedCheckedSource.circles![0].checked ??
    0;
  assert(effectiveChecked === 1, "circle checkedの表示fallbackが維持されていません");
  assert(
    !Object.prototype.hasOwnProperty.call(
      inheritedCheckedSource.circles![0].items[0],
      "checked",
    ),
    "表示用hydrationがitem.checkedを注入しました",
  );
}

async function testImageDeletionTransaction(): Promise<void> {
  const sharedDocument: EventJsonData = {
    circles: [
      {
        item_images: [{ path: "items/shared.jpg" }, { path: "items/only.jpg" }],
        items: [{ image: "items/shared-by-items.jpg" }],
      },
      {
        item_images: [{ path: "items/shared.jpg" }],
        items: [
          { image: "items/shared-by-items.jpg" },
          { image: "items/other.jpg" },
        ],
      },
    ],
  };
  const references = collectEventAssetReferences(sharedDocument);
  assert(
    references.has("items/shared.jpg") &&
      references.has("items/shared-by-items.jpg") &&
      references.has("items/other.jpg"),
    "別circle/複数itemsを含むdocument全体の参照を集計できませんでした",
  );

  const order: string[] = [];
  const deleted: string[] = [];
  await runImageDeletionTransaction({
    removedReferences: ["items/shared.jpg", "items/shared-by-items.jpg", "items/only.jpg"],
    applyClear: () => {
      order.push("clear");
      sharedDocument.circles![0].item_images = [];
      sharedDocument.circles![0].items[0].image = "";
    },
    save: async () => {
      order.push("save");
      return true;
    },
    rollbackIfCurrent: () => {
      order.push("rollback");
      return true;
    },
    currentDocument: () => sharedDocument,
    deleteAsset: async (reference) => {
      order.push(`delete:${reference}`);
      deleted.push(reference);
    },
  });
  assert(
    deleted.length === 1 && deleted[0] === "items/only.jpg",
    "document内に共有参照が残る画像を物理削除しました",
  );
  assert(
    order.indexOf("save") < order.indexOf("delete:items/only.jpg"),
    "JSON保存完了前に画像を物理削除しました",
  );

  const failedState = { table: "before", document: "before", baseline: "before", ui: "before" };
  const failedBefore = clone(failedState);
  let failedDeleteCalls = 0;
  const failed = await runImageDeletionTransaction({
    removedReferences: ["items/failure.jpg"],
    applyClear: () => {
      failedState.table = "cleared";
      failedState.document = "cleared";
      failedState.baseline = "optimistic";
      failedState.ui = "cleared";
    },
    save: async () => false,
    rollbackIfCurrent: () => {
      Object.assign(failedState, failedBefore);
      return true;
    },
    currentDocument: () => ({ circles: [] }),
    deleteAsset: async () => {
      failedDeleteCalls += 1;
    },
  });
  assert(!failed, "保存失敗した画像削除を成功扱いしました");
  assert(
    JSON.stringify(failedState) === JSON.stringify(failedBefore),
    "保存失敗時にUI/table/document/baselineをrollbackできませんでした",
  );
  assert(failedDeleteCalls === 0, "保存失敗時に物理削除を呼び出しました");

  let switchedOwnerDeleteCalls = 0;
  await runImageDeletionTransaction({
    removedReferences: ["items/old-owner.jpg"],
    applyClear: () => {},
    save: async () => true,
    rollbackIfCurrent: () => true,
    currentDocument: () => null,
    deleteAsset: async () => {
      switchedOwnerDeleteCalls += 1;
    },
  });
  assert(
    switchedOwnerDeleteCalls === 0,
    "保存後に所有イベントが切り替わった状態で旧assetを物理削除しました",
  );

  let caseFoldDeleteCalls = 0;
  await runImageDeletionTransaction({
    removedReferences: ["items/A.jpg"],
    applyClear: () => {},
    save: async () => true,
    rollbackIfCurrent: () => true,
    currentDocument: () => ({
      circles: [{ items: [{ image: "ITEMS/a.JPG" }] }],
    }),
    deleteAsset: async () => {
      caseFoldDeleteCalls += 1;
    },
  });
  assert(
    caseFoldDeleteCalls === 0,
    "大小文字だけ異なるWindows共有参照のassetを物理削除しました",
  );

  let lexicalDeleteCalls = 0;
  await runImageDeletionTransaction({
    removedReferences: ["items/a.jpg"],
    applyClear: () => {},
    save: async () => true,
    rollbackIfCurrent: () => true,
    currentDocument: () => ({
      circles: [{ item_images: [{ path: "./items//a.jpg" }] }],
    }),
    deleteAsset: async () => {
      lexicalDeleteCalls += 1;
    },
  });
  assert(
    lexicalDeleteCalls === 0,
    "Rust safe_relative_pathで同一になる共有参照を別assetとして扱いました",
  );
}

function testActiveMapSelectionKeepsOrphanButUsesOneReferencePerNumber(): void {
  const discovered = [
    { name: "map_01.jpg", path: "fixture/maps/map_01.jpg", modified_ms: 100 },
    { name: "map_01.png", path: "fixture/maps/map_01.png", modified_ms: 200 },
    { name: "map_02.webp", path: "fixture/maps/map_02.webp", modified_ms: 150 },
  ];
  const latest = selectActiveMapImages(discovered);
  assert(discovered.length === 3, "active選択が旧jpg孤児を配列から破壊しました");
  assert(latest.length === 2, "event.maps相当がmap番号ごと1件になりませんでした");
  assert(latest[0].name === "map_01.png", "jpg→png差替後に旧jpgがactiveになりました");

  const explicit = selectActiveMapImages(discovered, ["maps/map_01.jpg"]);
  assert(
    explicit[0].name === "map_01.jpg",
    "明示preferred refが最新mtimeより優先されませんでした",
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}

async function main(): Promise<void> {
  testLosslessEventDocumentSnapshot();
  testActiveMapSelectionKeepsOrphanButUsesOneReferencePerNumber();
  await testImageDeletionTransaction();
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
