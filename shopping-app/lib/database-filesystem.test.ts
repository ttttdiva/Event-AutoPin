function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface FileEntry {
  kind: "file";
  size: number;
  md5: string;
  modificationTime: number;
}

interface DirectoryEntry {
  kind: "directory";
}

type Entry = FileEntry | DirectoryEntry;

function normalize(path: string): string {
  return path.endsWith("/") && path !== "file:///" ? path.slice(0, -1) : path;
}

function createFileSystemMock(initial: Record<string, Entry>) {
  const entries = new Map(Object.entries(initial).map(([path, entry]) => [normalize(path), { ...entry }]));
  const md5Requests: string[] = [];
  let corruptCopies = false;
  let mutateBeforeDigest: string | null = null;

  const ensureParentDirectories = (path: string) => {
    const slash = path.lastIndexOf("/");
    if (slash <= "file://".length) return;
    const parent = path.slice(0, slash);
    if (!entries.has(parent)) {
      ensureParentDirectories(parent);
      entries.set(parent, { kind: "directory" });
    }
  };

  const api = {
    documentDirectory: "file:///documents/",
    cacheDirectory: "file:///cache/",
    async getInfoAsync(path: string, options?: { md5?: boolean }) {
      const key = normalize(path);
      const entry = entries.get(key);
      if (!entry) return { exists: false, uri: path };
      if (options?.md5) {
        md5Requests.push(key);
        if (entry.kind === "directory") throw new Error(`EISDIR: ${key}`);
        if (mutateBeforeDigest === key) {
          entry.size += 1;
          entry.modificationTime += 1;
          mutateBeforeDigest = null;
        }
      }
      if (entry.kind === "directory") {
        return { exists: true, uri: path, isDirectory: true, size: 0, modificationTime: 1 };
      }
      return {
        exists: true,
        uri: path,
        isDirectory: false,
        size: entry.size,
        modificationTime: entry.modificationTime,
        ...(options?.md5 ? { md5: entry.md5 } : {}),
      };
    },
    async readDirectoryAsync(path: string) {
      const root = `${normalize(path)}/`;
      const children = new Set<string>();
      for (const key of entries.keys()) {
        if (!key.startsWith(root)) continue;
        const relative = key.slice(root.length);
        if (relative && !relative.includes("/")) children.add(relative);
      }
      return [...children];
    },
    async deleteAsync(path: string) {
      const root = normalize(path);
      for (const key of [...entries.keys()]) {
        if (key === root || key.startsWith(`${root}/`)) entries.delete(key);
      }
    },
    async makeDirectoryAsync(path: string) {
      const key = normalize(path);
      ensureParentDirectories(key);
      entries.set(key, { kind: "directory" });
    },
    async copyAsync({ from, to }: { from: string; to: string }) {
      const sourceRoot = normalize(from);
      const destinationRoot = normalize(to);
      const source = entries.get(sourceRoot);
      if (!source) throw new Error(`missing source: ${sourceRoot}`);
      ensureParentDirectories(destinationRoot);
      entries.set(destinationRoot, { ...source });
      if (source.kind === "directory") {
        for (const [key, entry] of [...entries.entries()]) {
          if (!key.startsWith(`${sourceRoot}/`)) continue;
          const copied = { ...entry };
          if (corruptCopies && copied.kind === "file") copied.size += 1;
          const destination = `${destinationRoot}${key.slice(sourceRoot.length)}`;
          ensureParentDirectories(destination);
          entries.set(destination, copied);
        }
      }
    },
    setCorruptCopies(value: boolean) {
      corruptCopies = value;
    },
    mutateFileBeforeDigest(path: string) {
      mutateBeforeDigest = normalize(path);
    },
    md5Requests,
    entries,
  };
  return api;
}

async function run(): Promise<void> {
  const runtimeRequire = eval("require") as NodeRequire;
  const Module = runtimeRequire("module");
  const originalLoad = Module._load;
  const fileSystem = createFileSystemMock({
    "file:///source": { kind: "directory" },
    "file:///source/top.jpg": { kind: "file", size: 3, md5: "AABB", modificationTime: 10 },
    "file:///source/nested": { kind: "directory" },
    "file:///source/nested/item.png": { kind: "file", size: 5, md5: "CCDD", modificationTime: 20 },
  });

  Module._load = function mockLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === "expo-sqlite") return {};
    if (request === "expo-file-system/legacy") return fileSystem;
    if (request === "expo-image-picker") return {};
    if (request === "react-native-zip-archive") return { unzip: async () => undefined, zip: async () => undefined };
    if (request === "./types") return { PURCHASE_STATUS: {} };
    if (request === "./database-core") return {};
    if (request === "./performance") {
      return { __sqlMetricsDevOnly: false, estimateSqlResultBytes: () => 0, recordSqlMetric: () => undefined };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const databasePath = runtimeRequire.resolve("./database");
    delete runtimeRequire.cache[databasePath];
    const { listDirectoryFiles, copyDirectoryVerified } = runtimeRequire("./database") as {
      listDirectoryFiles: (root: string) => Promise<Array<{ relative: string; size: number; md5: string }>>;
      copyDirectoryVerified: (source: string, destination: string) => Promise<void>;
    };

    const fingerprints = await listDirectoryFiles("file:///source/");
    assert(
      JSON.stringify(fingerprints) === JSON.stringify([
        { relative: "nested/item.png", size: 5, md5: "ccdd" },
        { relative: "top.jpg", size: 3, md5: "aabb" },
      ]),
      "nested files must be fingerprinted in stable relative-path order",
    );
    assert(
      fileSystem.md5Requests.every((path) => !path.endsWith("/nested") && path !== "file:///source"),
      "directories must never be queried with md5:true",
    );

    await copyDirectoryVerified("file:///source/", "file:///backup/");
    const backupFingerprints = await listDirectoryFiles("file:///backup/");
    assert(JSON.stringify(backupFingerprints) === JSON.stringify(fingerprints), "verified copy must preserve nested fingerprints");

    fileSystem.mutateFileBeforeDigest("file:///source/top.jpg");
    let mutationRejected = false;
    try {
      await listDirectoryFiles("file:///source/");
    } catch {
      mutationRejected = true;
    }
    assert(mutationRejected, "file size/identity changes between metadata and digest reads must fail closed");

    fileSystem.setCorruptCopies(true);
    let corruptCopyRejected = false;
    try {
      await copyDirectoryVerified("file:///source/", "file:///corrupt-backup/");
    } catch {
      corruptCopyRejected = true;
    }
    assert(corruptCopyRejected, "source/destination fingerprint mismatch must fail closed");
    assert(!fileSystem.entries.has("file:///corrupt-backup"), "failed verified copy must clean its destination");
  } finally {
    Module._load = originalLoad;
  }
}

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
