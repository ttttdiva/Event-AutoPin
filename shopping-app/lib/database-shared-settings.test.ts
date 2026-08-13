function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const runtimeRequire = eval("require") as (id: string) => any;
  const Module = runtimeRequire("module");
  const originalLoad = Module._load;
  const names = Array.from({ length: 500 }, (_, index) => `${String(index).padStart(4, "0")}.jpg`);
  let copyCalls = 0;
  const fileSystem = {
    documentDirectory: "file:///documents/",
    cacheDirectory: "file:///cache/",
    readDirectoryAsync: async (path: string) => {
      if (path === "file:///extract/default_cuts/") return names;
      throw new Error(`unexpected readDirectoryAsync: ${path}`);
    },
    readAsStringAsync: async (path: string) => {
      if (path === "file:///extract/circle_master.json") return '{"circles":{"sample":{"favorite":false}}}';
      throw new Error(`unexpected readAsStringAsync: ${path}`);
    },
    getInfoAsync: async (path: string) => {
      if (path === "file:///extract/circle_master.json") return { exists: true, isDirectory: false, size: 10 };
      if (path === "file:///extract/default_cuts/") return { exists: true, isDirectory: true };
      const name = path.split("/").pop() ?? "";
      const index = names.indexOf(name);
      if (index >= 0 && (path.startsWith("file:///extract/default_cuts/") || path.startsWith("file:///documents/default_cuts/"))) {
        return { exists: true, isDirectory: false, size: index + 1, md5: `hash-${index}` };
      }
      return { exists: false };
    },
    copyAsync: async () => { copyCalls += 1; },
  };

  Module._load = function mockLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === "expo-sqlite") return {};
    if (request === "expo-file-system/legacy") return fileSystem;
    if (request === "expo-image-picker") return {};
    if (request === "react-native-zip-archive") return { unzip: async () => undefined, zip: async () => undefined };
    if (request === "./types") return { PURCHASE_STATUS: {} };
    if (request === "./performance") return { estimateSqlResultBytes: () => 0, recordSqlMetric: () => undefined };
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const { databaseSharedSettingsTestHooks } = runtimeRequire("./database") as typeof import("./database");
    const inspection = await databaseSharedSettingsTestHooks.inspectSharedBundleSettings("file:///extract/");
    assert(inspection.cutFiles.length === 500, "500-cut fixture must be fully fingerprinted");
    assert(inspection.changedCuts.length === 0, "equal live cuts must not be selected for copy");
    await databaseSharedSettingsTestHooks.copyDefaultCutsFromBundle(
      "file:///extract/",
      "file:///documents/default_cuts/",
      inspection,
    );
    assert(copyCalls === 0, "second equal 500-cut sync must perform zero copyAsync calls");
  } finally {
    Module._load = originalLoad;
  }
}

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
