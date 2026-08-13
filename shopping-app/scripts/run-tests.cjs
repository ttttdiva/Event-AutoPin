const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const appRoot = path.resolve(__dirname, "..");
const childMarker = "--run-test-file";
const testCases = [
  ["plugins/withAndroidPlatformCompatibility.test.js"],
  ["lib/database-core.test.ts", "runDatabaseCoreTests"],
  ["lib/database-filesystem.test.ts"],
  ["lib/database-instrumentation.test.ts"],
  ["lib/database-shared-settings.test.ts"],
  ["lib/event-load-epoch.test.ts", "runEventLoadEpochTests"],
  ["lib/map-pin-index.test.ts", "runMapPinIndexTests"],
  ["lib/mutation-epoch.test.ts", "runMutationEpochTests"],
  ["lib/performance-core.test.ts"],
  ["lib/text-collation.test.ts", "runTextCollationTests"],
  ["lib/update-service.test.js"],
];

function discoverTestFiles(directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...discoverTestFiles(absolutePath));
    } else if (/\.test\.(?:js|ts)$/.test(entry.name)) {
      found.push(path.relative(appRoot, absolutePath).replaceAll(path.sep, "/"));
    }
  }
  return found;
}

function assertAllTestsAreClassified() {
  const discovered = [
    ...discoverTestFiles(path.join(appRoot, "lib")),
    ...discoverTestFiles(path.join(appRoot, "plugins")),
  ].sort();
  const classified = testCases.map(([relativePath]) => relativePath).sort();
  const missing = discovered.filter((relativePath) => !classified.includes(relativePath));
  const stale = classified.filter((relativePath) => !discovered.includes(relativePath));
  if (missing.length > 0 || stale.length > 0) {
    throw new Error(
      `テスト分類を更新してください。未分類=[${missing.join(", ")}] 不在=[${stale.join(", ")}]`,
    );
  }
}

function loadTypeScript() {
  try {
    return require("typescript");
  } catch (error) {
    console.error(
      "TypeScriptがありません。shopping-appで `npm ci --legacy-peer-deps` を実行してください。",
    );
    throw error;
  }
}

function registerTypeScriptLoader() {
  const ts = loadTypeScript();
  const compile = (module, filename) => {
    const source = fs.readFileSync(filename, "utf8");
    const result = ts.transpileModule(source, {
      fileName: filename,
      reportDiagnostics: true,
      compilerOptions: {
        esModuleInterop: true,
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    });
    const errors = (result.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    );
    if (errors.length > 0) {
      throw new Error(
        ts.formatDiagnosticsWithColorAndContext(errors, {
          getCanonicalFileName: (fileName) => fileName,
          getCurrentDirectory: () => appRoot,
          getNewLine: () => "\n",
        }),
      );
    }
    module._compile(result.outputText, filename);
  };
  require.extensions[".ts"] = compile;
  require.extensions[".tsx"] = compile;
}

async function runTestFile(relativePath, exportedRunner) {
  registerTypeScriptLoader();
  const loaded = require(path.join(appRoot, relativePath));
  if (!exportedRunner) return;
  const runner = loaded[exportedRunner];
  if (typeof runner !== "function") {
    throw new Error(`${relativePath} に ${exportedRunner} がありません。`);
  }
  await runner();
}

function runAllTests() {
  assertAllTestsAreClassified();
  for (const [relativePath, exportedRunner = ""] of testCases) {
    const completed = spawnSync(
      process.execPath,
      [__filename, childMarker, relativePath, exportedRunner],
      { cwd: appRoot, encoding: "utf8" },
    );
    if (completed.stdout) process.stdout.write(completed.stdout);
    if (completed.stderr) process.stderr.write(completed.stderr);
    if (completed.error) throw completed.error;
    if (completed.status !== 0) {
      throw new Error(`${relativePath} が終了コード ${completed.status} で失敗しました。`);
    }
    console.log(`PASS ${relativePath}`);
  }
}

if (process.argv[2] === childMarker) {
  runTestFile(process.argv[3], process.argv[4]).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  try {
    runAllTests();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
