import type { ImportDiffResult } from "./database";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface ImportRunResultLike {
  eventCount: number;
  isFullSync: boolean;
  importedEventIds: number[];
  addedEventIds: number[];
  changedEventIds: number[];
  unchangedEventIds: number[];
  removedEventIds: number[];
  targetEventIds: number[];
}

function loadBuildImportRunResult(): (eventId: number, diff: ImportDiffResult, targetEventIds: number[], summary: any) => ImportRunResultLike {
  const runtimeRequire = eval("require") as NodeRequire;
  const Module = runtimeRequire("module") as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = Module._load;
  const helpersPath = runtimeRequire.resolve("./import-helpers");
  delete runtimeRequire.cache[helpersPath];
  Module._load = function mockLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === "expo-document-picker" || request === "expo-file-system/legacy") return {};
    if (request === "./database") {
      return {
        getEventImportSummary: async () => ({}),
        getLastImportDiff: () => ({}),
        importFromZip: async () => 1,
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const helpers = runtimeRequire("./import-helpers") as {
      buildImportRunResult: (eventId: number, diff: ImportDiffResult, targetEventIds: number[], summary: any) => ImportRunResultLike;
    };
    return helpers.buildImportRunResult;
  } finally {
    delete runtimeRequire.cache[helpersPath];
    Module._load = originalLoad;
  }
}

async function assertDocumentPickerCacheOwnership(): Promise<void> {
  const runtimeRequire = eval("require") as NodeRequire;
  const Module = runtimeRequire("module") as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = Module._load;
  const helpersPath = runtimeRequire.resolve("./import-helpers");
  delete runtimeRequire.cache[helpersPath];
  let capturedOptions: { deleteSourceAfterUnzip?: boolean } | undefined;

  Module._load = function mockLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === "expo-document-picker") {
      return {
        getDocumentAsync: async () => ({
          canceled: false,
          assets: [{ uri: "file:///cache/document-picker-full-sync.zip" }],
        }),
      };
    }
    if (request === "expo-file-system/legacy") {
      return {
        cacheDirectory: "file:///cache/",
      };
    }
    if (request === "./database") {
      return {
        importFromZip: async (
          _uri: string,
          _onProgress: unknown,
          options?: { deleteSourceAfterUnzip?: boolean },
        ) => {
          capturedOptions = options;
          return 7;
        },
        getLastImportDiff: () =>
          makeDiff({
            kind: "single",
            incremental: false,
            importedEventIds: [7],
            addedEventIds: [7],
            targetEventIds: [7],
          }),
        getEventImportSummary: async () => ({
          eventName: "テスト",
          circleCount: 1,
          mapCount: 1,
          imageCount: 1,
          itemCount: 1,
        }),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const helpers = runtimeRequire("./import-helpers") as {
      handleImportZip: (onProgress: () => void) => Promise<unknown>;
    };
    await helpers.handleImportZip(() => undefined);
    assert(
      capturedOptions?.deleteSourceAfterUnzip === true,
      "DocumentPicker cache copy must be released after native unzip",
    );
  } finally {
    delete runtimeRequire.cache[helpersPath];
    Module._load = originalLoad;
  }
}

function makeDiff(overrides: Partial<ImportDiffResult>): ImportDiffResult {
  return {
    kind: "full",
    incremental: true,
    importedEventIds: [],
    addedEventIds: [],
    changedEventIds: [],
    unchangedEventIds: [],
    removedEventIds: [],
    targetEventIds: [],
    failedEventIds: [],
    ...overrides,
  };
}

export async function runImportHelperContractTests(): Promise<void> {
  const buildImportRunResult = loadBuildImportRunResult();
  const summary = {
    eventName: "同期イベント",
    circleCount: 1,
    mapCount: 2,
    imageCount: 3,
    itemCount: 4,
  };

  // All rows can be unchanged: no new SQLite IDs are created, but the full
  // manifest still targets every event and remains a full sync.
  const unchanged = buildImportRunResult(
    11,
    makeDiff({ unchangedEventIds: [10, 11], targetEventIds: [10, 11] }),
    [10, 11],
    summary,
  );
  assert(unchanged.isFullSync && unchanged.eventCount === 2, "all unchanged remains full sync");
  assert(unchanged.importedEventIds.length === 0, "unchanged rows are not newly imported IDs");
  assert(JSON.stringify(unchanged.targetEventIds) === JSON.stringify([10, 11]), "unchanged target IDs preserved");

  // Changed IDs remain live IDs, while added/removed are independently
  // visible to the UI and eventCount counts current targets only.
  const mixed = buildImportRunResult(
    31,
    makeDiff({
      importedEventIds: [20, 31],
      addedEventIds: [31],
      changedEventIds: [20],
      unchangedEventIds: [10],
      removedEventIds: [40],
      targetEventIds: [31, 20, 10],
    }),
    [31, 20, 10],
    summary,
  );
  assert(mixed.eventCount === 3 && mixed.removedEventIds[0] === 40, "mixed diff is exposed without removed target");
  assert(JSON.stringify(mixed.addedEventIds) === JSON.stringify([31]), "added IDs remain separate from changed IDs");

  const single = buildImportRunResult(
    20,
    makeDiff({
      kind: "single",
      incremental: false,
      importedEventIds: [20],
      changedEventIds: [20],
      targetEventIds: [20],
    }),
    [20],
    summary,
  );
  assert(!single.isFullSync && single.eventCount === 1, "single import does not depend on ID delta size");

  await assertDocumentPickerCacheOwnership();
}
