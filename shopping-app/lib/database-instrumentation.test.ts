function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface RecordedMetric {
  sql: string;
  elapsedMs: number;
  rows: number;
  bytes: number;
}

async function run(): Promise<void> {
  const runtimeRequire = eval("require") as NodeRequire;
  const Module = runtimeRequire("module");
  const originalLoad = Module._load;

  function loadSqliteLifecycleTestHooks(
    opened: Array<{
      databaseName: string;
      options: Record<string, unknown> | undefined;
    }>,
  ) {
    Module._load = function mockLoad(request: string, parent: unknown, isMain: boolean) {
      if (request === "expo-sqlite") {
        return {
          openDatabaseAsync: async (
            databaseName: string,
            options?: Record<string, unknown>,
          ) => {
            opened.push({ databaseName, options });
            return {
              closeAsync: async () => undefined,
            };
          },
        };
      }
      if (request === "expo-file-system/legacy") {
        return {
          documentDirectory: "file:///documents/",
          cacheDirectory: "file:///cache/",
        };
      }
      if (request === "expo-image-picker") return {};
      if (request === "react-native-zip-archive") {
        return { unzip: async () => undefined, zip: async () => undefined };
      }
      if (request === "./types") return { PURCHASE_STATUS: {} };
      if (request === "./database-core") return {};
      if (request === "./performance") {
        return {
          __sqlMetricsDevOnly: false,
          estimateSqlResultBytes: () => 0,
          recordSqlMetric: () => undefined,
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    const databasePath = runtimeRequire.resolve("./database");
    delete runtimeRequire.cache[databasePath];
    return (runtimeRequire("./database") as {
      databaseSqliteLifecycleTestHooks: {
        openEventTrailDatabaseAsync: (databaseName: string) => Promise<unknown>;
        openLegacyTemporaryDatabaseAsync: (databaseName: string) => Promise<unknown>;
        openLegacyStageDatabaseAsync: (databaseName: string) => Promise<unknown>;
      };
    }).databaseSqliteLifecycleTestHooks;
  }

  function loadInstrumentDatabase(dev: boolean, metrics: RecordedMetric[]) {
    Module._load = function mockLoad(request: string, parent: unknown, isMain: boolean) {
      if (request === "expo-sqlite") return {};
      if (request === "expo-file-system/legacy") {
        return { documentDirectory: "file:///documents/", cacheDirectory: "file:///cache/" };
      }
      if (request === "expo-image-picker") return {};
      if (request === "react-native-zip-archive") {
        return { unzip: async () => undefined, zip: async () => undefined };
      }
      if (request === "./types") return { PURCHASE_STATUS: {} };
      if (request === "./database-core") return {};
      if (request === "./performance") {
        return {
          __sqlMetricsDevOnly: dev,
          estimateSqlResultBytes: (value: unknown) =>
            value == null ? 0 : JSON.stringify(value).length * 2,
          recordSqlMetric: (sql: string, elapsedMs: number, rows: number, bytes: number) =>
            metrics.push({ sql, elapsedMs, rows, bytes }),
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    const databasePath = runtimeRequire.resolve("./database");
    delete runtimeRequire.cache[databasePath];
    return (runtimeRequire("./database") as {
      instrumentDatabase: <T>(database: T) => T;
    }).instrumentDatabase;
  }

  try {
    const devMetrics: RecordedMetric[] = [];
    const instrumentDatabase = loadInstrumentDatabase(true, devMetrics);
    let regularTaskCalls = 0;
    const exclusiveTransaction = {
      runAsync: async (_sql: string) => ({ lastInsertRowId: 0, changes: 1 }),
    };
    const rawDatabase = {
      getAllAsync: async (_sql: string) => [{ id: 1 }, { id: 2 }],
      getFirstAsync: async (_sql: string) => ({ id: 1 }),
      runAsync: async (_sql: string) => ({ lastInsertRowId: 0, changes: 1 }),
      execAsync: async (_sql: string) => undefined,
      withTransactionAsync: async (task: () => Promise<void>) => {
        regularTaskCalls += 1;
        await task();
      },
      withExclusiveTransactionAsync: async (
        task: (txn: typeof exclusiveTransaction) => Promise<void>,
      ) => {
        await task(exclusiveTransaction);
      },
    };
    const database = instrumentDatabase(rawDatabase);
    assert(database !== rawDatabase, "development database must be proxied");
    assert(instrumentDatabase(rawDatabase) === database, "development proxy must be cached");

    const rows = await database.getAllAsync("SELECT id FROM test_rows");
    await database.getFirstAsync("SELECT id FROM test_first");
    await database.execAsync("PRAGMA user_version");
    assert(rows.length === 2, "instrumentation must preserve query results");

    await database.withTransactionAsync(async (...args: unknown[]) => {
      assert(args.length === 0, "withTransactionAsync callback must receive no transaction argument");
      await database.runAsync("UPDATE regular_transaction");
    });
    assert(regularTaskCalls === 1, "regular transaction task should run exactly once");

    let receivedExclusiveTransaction: typeof exclusiveTransaction | undefined;
    await database.withExclusiveTransactionAsync(async (txn) => {
      receivedExclusiveTransaction = txn;
      await txn.runAsync("UPDATE exclusive_transaction");
    });
    assert(receivedExclusiveTransaction !== exclusiveTransaction, "exclusive transaction must be instrumented");
    assert(
      devMetrics.map((metric) => metric.sql).join("|") ===
        "SELECT id FROM test_rows|SELECT id FROM test_first|PRAGMA user_version|UPDATE regular_transaction|UPDATE exclusive_transaction",
      "queries in direct and transaction modes must remain covered",
    );
    assert(devMetrics[0].rows === 2, "getAllAsync row count must be measured");
    assert(devMetrics[1].rows === 1, "getFirstAsync row count must be measured");
    assert(devMetrics[0].bytes > 0, "query result bytes must be estimated");
    assert(devMetrics.every((metric) => metric.elapsedMs >= 0), "elapsed time must be non-negative");

    const prodMetrics: RecordedMetric[] = [];
    const productionInstrumentDatabase = loadInstrumentDatabase(false, prodMetrics);
    const productionRawDatabase = {
      getAllAsync: async () => [{ id: 1 }],
    };
    const productionDatabase = productionInstrumentDatabase(productionRawDatabase);
    assert(
      productionDatabase === productionRawDatabase,
      "production instrumentation must preserve raw database identity",
    );
    await productionDatabase.getAllAsync();
    assert(prodMetrics.length === 0, "production database must not record metrics");

    const opened: Array<{
      databaseName: string;
      options: Record<string, unknown> | undefined;
    }> = [];
    const lifecycleHooks = loadSqliteLifecycleTestHooks(opened);
    await lifecycleHooks.openEventTrailDatabaseAsync(
      "doujin_shopping.db",
    );
    await lifecycleHooks.openLegacyTemporaryDatabaseAsync(
      "eventtrail_legacy_old_test.db",
    );
    await lifecycleHooks.openLegacyStageDatabaseAsync(
      "eventtrail_legacy_stage_test.db",
    );
    assert(opened.length === 3, "all tested databases must open exactly once");
    assert(
      opened[0].databaseName === "doujin_shopping.db",
      "live database name must be preserved",
    );
    assert(
      opened[0].options?.finalizeUnusedStatementsBeforeClosing === false,
      "live database must disable expo-sqlite close-time auto-finalization",
    );
    assert(
      opened[1].databaseName === "eventtrail_legacy_old_test.db",
      "legacy temporary database name must be preserved",
    );
    assert(
      opened[1].options?.finalizeUnusedStatementsBeforeClosing === false,
      "legacy temporary database must disable expo-sqlite close-time auto-finalization",
    );
    assert(
      opened[2].databaseName === "eventtrail_legacy_stage_test.db",
      "legacy stage database must use the temporary database open path",
    );
    assert(
      opened[2].options?.finalizeUnusedStatementsBeforeClosing === false,
      "legacy stage database must disable expo-sqlite close-time auto-finalization",
    );
  } finally {
    Module._load = originalLoad;
  }
}

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
