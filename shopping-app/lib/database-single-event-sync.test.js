const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Module = require("node:module");
const { DatabaseSync } = require("node:sqlite");

function createFileSystem() {
  const entries = new Map();
  const archives = new Map();
  let moveHook = null;

  const normalize = (value) => String(value ?? "")
    .replace(/^file:\/\/\//i, "/")
    .replace(/^file:\/\//i, "/")
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "") || "/";
  const parentOf = (path) => {
    const slash = path.lastIndexOf("/");
    return slash <= 0 ? "/" : path.slice(0, slash);
  };
  const ensureDirectory = (path) => {
    const key = normalize(path);
    if (key === "/") {
      entries.set(key, { kind: "directory" });
      return;
    }
    ensureDirectory(parentOf(key));
    entries.set(key, { kind: "directory" });
  };
  const setFile = (path, content) => {
    const key = normalize(path);
    ensureDirectory(parentOf(key));
    entries.set(key, { kind: "file", content: Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(String(content)) });
  };
  const removeTree = (path) => {
    const key = normalize(path);
    for (const candidate of [...entries.keys()]) {
      if (candidate === key || candidate.startsWith(`${key}/`)) entries.delete(candidate);
    }
  };
  const copyTree = (source, destination) => {
    const sourceKey = normalize(source);
    const destinationKey = normalize(destination);
    const sourceEntry = entries.get(sourceKey);
    if (!sourceEntry) throw new Error(`missing source: ${source}`);
    ensureDirectory(parentOf(destinationKey));
    if (sourceEntry.kind === "file") {
      entries.set(destinationKey, { kind: "file", content: Buffer.from(sourceEntry.content) });
      return;
    }
    ensureDirectory(destinationKey);
    for (const [key, entry] of [...entries.entries()]) {
      if (!key.startsWith(`${sourceKey}/`)) continue;
      const suffix = key.slice(sourceKey.length + 1);
      const next = `${destinationKey}/${suffix}`;
      if (entry.kind === "directory") ensureDirectory(next);
      else setFile(next, entry.content);
    }
  };
  const md5 = (content) => crypto.createHash("md5").update(content).digest("hex");

  ensureDirectory("file:///cache/");
  ensureDirectory("file:///documents/");
  return {
    documentDirectory: "file:///documents/",
    cacheDirectory: "file:///cache/",
    EncodingType: { Base64: "base64", UTF8: "utf8" },
    entries,
    archives,
    setFile,
    setMoveHook(hook) { moveHook = hook; },
    fileBytes(path) {
      const entry = entries.get(normalize(path));
      return entry?.kind === "file" ? Buffer.from(entry.content) : null;
    },
    async getInfoAsync(path, options = {}) {
      const key = normalize(path);
      const entry = entries.get(key);
      if (!entry) return { exists: false, uri: path };
      if (entry.kind === "directory") {
        return { exists: true, uri: path, isDirectory: true, size: 0, modificationTime: 1 };
      }
      return {
        exists: true,
        uri: path,
        isDirectory: false,
        size: entry.content.length,
        modificationTime: 1,
        ...(options.md5 ? { md5: md5(entry.content) } : {}),
      };
    },
    async readDirectoryAsync(path) {
      const root = normalize(path);
      if (!entries.has(root) || entries.get(root).kind !== "directory") throw new Error(`missing directory: ${path}`);
      const prefix = root === "/" ? "/" : `${root}/`;
      const result = new Set();
      for (const key of entries.keys()) {
        if (!key.startsWith(prefix) || key === root) continue;
        const remainder = key.slice(prefix.length);
        if (remainder) result.add(remainder.split("/")[0]);
      }
      return [...result];
    },
    async makeDirectoryAsync(path) { ensureDirectory(path); },
    async deleteAsync(path) { removeTree(path); },
    async copyAsync({ from, to }) { copyTree(from, to); },
    async moveAsync({ from, to }) {
      copyTree(from, to);
      removeTree(from);
      if (moveHook) await moveHook(normalize(from), normalize(to));
    },
    async readAsStringAsync(path, options = {}) {
      const entry = entries.get(normalize(path));
      if (!entry || entry.kind !== "file") throw new Error(`missing file: ${path}`);
      return entry.content.toString(options.encoding === "base64" ? "base64" : "utf8");
    },
    async writeAsStringAsync(path, value, options = {}) {
      setFile(path, options.encoding === "base64" ? Buffer.from(String(value), "base64") : Buffer.from(String(value), "utf8"));
    },
  };
}

function createDatabase(sqlite) {
  const database = {
    async execAsync(sql) { sqlite.exec(sql); },
    async getAllAsync(sql, ...params) { return sqlite.prepare(sql).all(...params); },
    async getFirstAsync(sql, ...params) { return sqlite.prepare(sql).get(...params) ?? null; },
    async runAsync(sql, ...params) {
      const result = sqlite.prepare(sql).run(...params);
      return { lastInsertRowId: Number(result.lastInsertRowid), changes: Number(result.changes) };
    },
    async withTransactionAsync(callback) { return transaction(callback); },
    async withExclusiveTransactionAsync(callback) { return transaction(() => callback(database)); },
    async closeAsync() { sqlite.close(); },
  };
  async function transaction(callback) {
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = await callback();
      sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  return database;
}

function registerArchive(fileSystem, zipPath, data, assets) {
  const files = { "event.json": JSON.stringify(data), ...assets };
  fileSystem.setFile(zipPath, "fixture ZIP bytes");
  fileSystem.archives.set(zipPath.replace(/^file:\/\/\//, "/"), files);
}

function eventArchive(eventName, mapFilename, circleChecked = 0) {
  return {
    event_uid: "uid-target",
    event: {
      name: eventName,
      url: "https://example.test/event",
      date: "2026-10-31",
      memo: `memo-${eventName}`,
      maps: [{ filename: mapFilename, map_number: 1 }],
    },
    circles: [{ name: "Target circle", space: "A-01", checked: circleChecked, items: [] }],
    metadata: { generated_at: "2026-10-31", format_version: "1.0", total_circles: 1 },
  };
}

async function runDatabaseSingleEventSyncTests() {
  const sqlite = new DatabaseSync(":memory:");
  const database = createDatabase(sqlite);
  const fileSystem = createFileSystem();
  const originalLoad = Module._load;
  let mutateDbAfterImagePublish = false;
  const targetLiveDir = "/documents/images/1";
  fileSystem.setMoveHook(async (from, to) => {
    if (mutateDbAfterImagePublish && to === targetLiveDir && from.includes("__live_1_")) {
      mutateDbAfterImagePublish = false;
      sqlite.prepare("UPDATE events SET memo = ? WHERE id = 1").run("concurrent edit");
    }
  });

  Module._load = function mockLoad(request, parent, isMain) {
    if (request === "expo-sqlite") {
      return { openDatabaseAsync: async () => database, deleteDatabaseAsync: async () => undefined };
    }
    if (request === "expo-file-system/legacy") return fileSystem;
    if (request === "expo-image-picker") return {};
    if (request === "react-native-zip-archive") {
      return {
        getUncompressedSize: async (source) => {
          const archive = fileSystem.archives.get(String(source).replace(/\\/g, "/"));
          if (!archive) throw new Error(`missing archive: ${source}`);
          return Object.values(archive).reduce((size, value) => size + Buffer.byteLength(value), 0);
        },
        unzip: async (source, destination) => {
          const archive = fileSystem.archives.get(String(source).replace(/\\/g, "/"));
          if (!archive) throw new Error(`missing archive: ${source}`);
          await fileSystem.makeDirectoryAsync(destination, { intermediates: true });
          for (const [relative, value] of Object.entries(archive)) {
            fileSystem.setFile(`${destination}/${relative}`, value);
          }
          return destination;
        },
        zip: async (sourceDirectory, destination) => {
          fileSystem.setFile(destination, `backup:${sourceDirectory}:${Date.now()}`);
        },
      };
    }
    if (request === "./performance") {
      return { __sqlMetricsDevOnly: false, estimateSqlResultBytes: () => 0, recordSqlMetric: () => undefined };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const databasePath = require.resolve("./database");
  try {
    delete require.cache[databasePath];
    const db = require("./database");
    await db.getDatabase();
    await database.runAsync(
      "INSERT INTO events (id, name, url, date, memo, sync_uid) VALUES (?, ?, ?, ?, ?, ?)",
      1, "Target old", "https://example.test/old", "2026-10-31", "mobile memo", "uid-target",
    );
    await database.runAsync(
      "INSERT INTO events (id, name, url, date, memo, sync_uid) VALUES (?, ?, ?, ?, ?, ?)",
      2, "Other event", "https://example.test/other", "2026-11-01", "other memo", "uid-other",
    );
    await database.runAsync(
      "INSERT INTO event_maps (event_id, filename, map_number, raw_json) VALUES (?, ?, ?, ?)",
      1, "file:///documents/images/1/map_1_old.png", 1, JSON.stringify({ map_number: 1 }),
    );
    await database.runAsync(
      "INSERT INTO event_maps (event_id, filename, map_number, raw_json) VALUES (?, ?, ?, ?)",
      2, "file:///documents/images/2/map_1_other.png", 1, JSON.stringify({ map_number: 1 }),
    );
    await database.runAsync(
      "INSERT INTO circles (event_id, name, space, checked, raw_json, name_key, penname_key) VALUES (?, ?, ?, ?, ?, ?, ?)",
      1, "Target circle", "A-01", 1, JSON.stringify({ name: "Target circle", space: "A-01", checked: 1 }), "target circle", "",
    );
    await database.runAsync(
      "INSERT INTO circles (event_id, name, space, checked, raw_json, name_key, penname_key) VALUES (?, ?, ?, ?, ?, ?, ?)",
      2, "Other circle", "B-01", 1, JSON.stringify({ name: "Other circle", space: "B-01", checked: 1 }), "other circle", "",
    );
    fileSystem.setFile("file:///documents/images/1/map_1_old.png", "old-image-bytes");
    fileSystem.setFile("file:///documents/images/2/map_1_other.png", "other-image-bytes");

    const originalOtherEvent = await database.getFirstAsync("SELECT * FROM events WHERE id = 2");
    const originalOtherMap = await database.getFirstAsync("SELECT * FROM event_maps WHERE event_id = 2");
    const otherImagePath = "file:///documents/images/2/map_1_other.png";

    const firstZip = "file:///cache/single-event-changed-image.zip";
    registerArchive(
      fileSystem,
      firstZip,
      eventArchive("Target from PC", "maps/pc-map.png", 0),
      { "maps/pc-map.png": "new-image-bytes" },
    );
    // Synthetic desktop QR and authenticated session share the real mobile parser
    // and the SQLite/ZIP fixture below. The desktop adds direction to its URL.
    const contract = require("./single-event-sync");
    const sessionToken = "contract-token";
    const sessionId = crypto.createHash("sha256").update(sessionToken).digest("hex");
    const serverUrl = `http://192.168.1.25:43123/upload?token=${sessionToken}&mode=single-event-sync&target_uid=uid-target&target_name=Target&target_date=2026-10-31`;
    const makeDesktopQr = (direction) => {
      const pairingUrl = new URL(serverUrl);
      pairingUrl.searchParams.set("direction", direction);
      return pairingUrl.toString();
    };
    for (const direction of ["send", "receive"]) {
      const qr = contract.parseSingleEventSyncUploadUrl(makeDesktopQr(direction));
      assert.equal(qr.direction, direction);
      const pending = JSON.stringify({ state: "pending", target_uid: qr.targetUid, sessionId });
      assert.equal(contract.validateSingleEventSyncSession(pending, qr.targetUid, qr.token).state, "pending");
      assert.throws(() => contract.validateSingleEventSyncSession(pending, qr.targetUid, "wrong"));
      if (direction === "receive") {
        const terminal = JSON.stringify({ state: "mobile-applied", target_uid: qr.targetUid, sessionId });
        assert.equal(contract.validateSingleEventSyncSession(terminal, qr.targetUid, qr.token).state, "mobile-applied");
      } else {
        const download = `http://192.168.1.25:43124/mobile_export.zip?token=outbound&mode=single-event-sync&target_uid=${qr.targetUid}`;
        const ready = JSON.stringify({ state: "pc-ready", target_uid: qr.targetUid, sessionId, download_url: download });
        assert.equal(contract.validateSingleEventSyncSession(ready, qr.targetUid, qr.token).downloadUrl, download);
      }
    }
    const firstPreview = await db.previewSingleEventSyncZip(firstZip, 1, "uid-target");
    const firstResult = await db.applySingleEventSyncZip(
      firstZip,
      1,
      "uid-target",
      firstPreview.revision,
    );
    // Model the completion acknowledgement only after the actual SQLite apply.
    const ack = { mode: "single-event-sync", target_uid: firstResult.eventUid, state: "mobile-applied" };
    assert.deepEqual(ack, { mode: "single-event-sync", target_uid: "uid-target", state: "mobile-applied" });
    assert.equal(contract.validateSingleEventSyncSession(JSON.stringify({ ...ack, sessionId }), ack.target_uid, sessionToken).state, "mobile-applied");
    assert.equal(firstResult.eventId, 1);
    assert.deepEqual(firstResult.diff.changedEventIds, [1]);
    assert.equal((await database.getFirstAsync("SELECT name FROM events WHERE id = 1")).name, "Target from PC");
    assert.equal((await database.getFirstAsync("SELECT checked FROM circles WHERE event_id = 1")).checked, 0);
    const targetMap = await database.getFirstAsync("SELECT filename FROM event_maps WHERE event_id = 1");
    assert.match(targetMap.filename, /pc-map\.png$/);
    assert.equal(fileSystem.fileBytes(targetMap.filename).toString(), "new-image-bytes");
    assert.deepEqual(await database.getFirstAsync("SELECT * FROM events WHERE id = 2"), originalOtherEvent);
    assert.deepEqual(await database.getFirstAsync("SELECT * FROM event_maps WHERE event_id = 2"), originalOtherMap);
    assert.equal(fileSystem.fileBytes(otherImagePath).toString(), "other-image-bytes");

    const staleZip = "file:///cache/single-event-concurrent-edit.zip";
    registerArchive(
      fileSystem,
      staleZip,
      eventArchive("Target stale preview", "maps/stale-map.png", 3),
      { "maps/stale-map.png": "stale-image-bytes" },
    );
    const stalePreview = await db.previewSingleEventSyncZip(staleZip, 1, "uid-target");
    mutateDbAfterImagePublish = true;
    await assert.rejects(
      db.applySingleEventSyncZip(staleZip, 1, "uid-target", stalePreview.revision),
      /対象イベントが変更されました/,
    );
    assert.equal((await database.getFirstAsync("SELECT memo FROM events WHERE id = 1")).memo, "concurrent edit");
    assert.equal((await database.getFirstAsync("SELECT name FROM events WHERE id = 1")).name, "Target from PC");
    const restoredTargetMap = await database.getFirstAsync("SELECT filename FROM event_maps WHERE event_id = 1");
    assert.equal(restoredTargetMap.filename, targetMap.filename);
    assert.equal(fileSystem.fileBytes(restoredTargetMap.filename).toString(), "new-image-bytes");
    assert.equal(fileSystem.fileBytes(otherImagePath).toString(), "other-image-bytes");
    assert.deepEqual(await database.getFirstAsync("SELECT * FROM events WHERE id = 2"), originalOtherEvent);
    assert.deepEqual(await database.getFirstAsync("SELECT * FROM event_maps WHERE event_id = 2"), originalOtherMap);
    console.log("single-event import: changed image publish succeeds; post-publish DB CAS rejects stale target and restores only target images PASS");

    // Legacy single ZIPs have no sync_bundle.json. PC event IDs are not mobile
    // row IDs; matching must retain the existing graph and mobile-owned state.
    for (const [id, uid, incomingUid] of [[10, null, "pc-uid-a"], [20, "old-mobile-uid", "different-pc-uid"]]) {
      const name = `旧 イベント ${id}`;
      await database.runAsync(
        "INSERT INTO events (id, name, url, date, memo, sync_uid, event_image_filename) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id, name, "", "2026/11/1", "mobile memo", uid, `file:///documents/images/${id}/local.png`,
      );
      fileSystem.setFile(`file:///documents/images/${id}/local.png`, `local image ${id}`);
      const circle = await database.runAsync(
        "INSERT INTO circles (id, event_id, name, space, checked, raw_json, name_key, penname_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        1000 + id, id, "Target circle", "A-01", 1, JSON.stringify({ name: "Target circle", space: "A-01" }), "target circle", "",
      );
      const item = await database.runAsync(
        "INSERT INTO items (id, circle_id, name, purchase_status, raw_json, name_key) VALUES (?, ?, ?, ?, ?, ?)",
        2000 + id, circle.lastInsertRowId, "Book", 1, JSON.stringify({ name: "Book" }), "book",
      );
      const archive = eventArchive(`旧　イベント　${id}`, "maps/pc-map.png");
      archive.event_uid = incomingUid;
      archive.event.id = 9999; // upstream ID, never the mobile events.id
      archive.event.date = "２０２６年１１月１日";
      archive.circles[0].items = [{ name: "Book", purchase_status: 0 }];
      const zip = `file:///cache/legacy-update-${id}.zip`;
      registerArchive(fileSystem, zip, archive, { "maps/pc-map.png": "incoming map" });
      assert.equal(await db.importFromZip(zip), id);
      assert.deepEqual(db.getLastImportDiff().changedEventIds, [id]);
      const updated = await database.getFirstAsync("SELECT * FROM events WHERE id = ?", id);
      assert.equal(updated.sync_uid, uid);
      assert.equal(updated.memo, "mobile memo");
      assert.equal(fileSystem.fileBytes(updated.event_image_filename).toString(), `local image ${id}`);
      const updatedCircle = await database.getFirstAsync("SELECT * FROM circles WHERE event_id = ?", id);
      assert.equal(updatedCircle.id, circle.lastInsertRowId);
      assert.equal(updatedCircle.checked, 1);
      const updatedItem = await database.getFirstAsync("SELECT * FROM items WHERE circle_id = ?", updatedCircle.id);
      assert.equal(updatedItem.id, item.lastInsertRowId);
      assert.equal(updatedItem.purchase_status, 1);
      const map = await database.getFirstAsync("SELECT filename FROM event_maps WHERE event_id = ?", id);
      assert.equal(fileSystem.fileBytes(map.filename).toString(), "incoming map");
    }

    await database.runAsync("INSERT INTO events (id, name, url, date) VALUES (?, ?, ?, ?)", 30, "同名イベント", "", "2026-11-01");
    const otherDay = eventArchive("同名イベント", "maps/pc-map.png");
    delete otherDay.event_uid;
    otherDay.event.date = "2026-11-02";
    const otherDayZip = "file:///cache/legacy-other-day.zip";
    registerArchive(fileSystem, otherDayZip, otherDay, { "maps/pc-map.png": "other day map" });
    const otherDayId = await db.importFromZip(otherDayZip);
    assert.notEqual(otherDayId, 30);
    assert.equal((await database.getFirstAsync("SELECT date FROM events WHERE id = 30")).date, "2026-11-01");
    assert.deepEqual(db.getLastImportDiff().addedEventIds, [otherDayId]);

    await database.runAsync("INSERT INTO events (id, name, url, date) VALUES (?, ?, ?, ?)", 40, "曖昧イベント", "", "2026-11-01");
    await database.runAsync("INSERT INTO events (id, name, url, date) VALUES (?, ?, ?, ?)", 41, "曖昧イベント", "", "2026/11/1");
    const ambiguous = eventArchive("曖昧イベント", "maps/pc-map.png");
    delete ambiguous.event_uid;
    ambiguous.event.date = "2026-11-01";
    const ambiguousZip = "file:///cache/legacy-ambiguous.zip";
    registerArchive(fileSystem, ambiguousZip, ambiguous, { "maps/pc-map.png": "ambiguous map" });
    const beforeAmbiguous = await database.getAllAsync("SELECT id, name, date FROM events ORDER BY id");
    await assert.rejects(db.importFromZip(ambiguousZip), /複数|一意|曖昧/);
    assert.deepEqual(await database.getAllAsync("SELECT id, name, date FROM events ORDER BY id"), beforeAmbiguous);
    const cancelSnapshot = await database.getAllAsync("SELECT * FROM events ORDER BY id");
    await assert.rejects(db.importFromZip(ambiguousZip, undefined, { selectLegacyTarget: async (candidates) => {
      assert.deepEqual(candidates.map((row) => row.id), [40, 41]);
      return null;
    } }), db.ImportCancelledError);
    assert.deepEqual(await database.getAllAsync("SELECT * FROM events ORDER BY id"), cancelSnapshot);
    await database.runAsync("INSERT INTO circles (id, event_id, name, space, checked, raw_json, name_key, penname_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", 4041, 41, "Other circle", "B-01", 1, "{}", "other circle", "");
    await database.runAsync("INSERT INTO event_maps (event_id, filename, map_number, raw_json) VALUES (?, ?, ?, ?)", 41, "file:///documents/images/41/other.png", 1, "{}");
    fileSystem.setFile("file:///documents/images/41/other.png", "other candidate image");
    await database.runAsync("INSERT INTO circles (id, event_id, name, space, checked, raw_json, name_key, penname_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", 4040, 40, "Target circle", "A-01", 1, "{}", "target circle", "");
    await database.runAsync("INSERT INTO items (id, circle_id, name, purchase_status, raw_json, name_key) VALUES (?, ?, ?, ?, ?, ?)", 4042, 4040, "Book", 1, "{}", "book");
    ambiguous.circles[0].items = [{ name: "Book", purchase_status: 0 }];
    registerArchive(fileSystem, ambiguousZip, ambiguous, { "maps/pc-map.png": "ambiguous map" });
    const otherBefore = await database.getFirstAsync("SELECT * FROM events WHERE id = 41");
    const circlesBefore = await database.getAllAsync("SELECT * FROM circles WHERE event_id = 41");
    const countBefore = (await database.getFirstAsync("SELECT COUNT(*) AS count FROM events")).count;
    assert.equal(await db.importFromZip(ambiguousZip, undefined, { selectLegacyTarget: async () => 40 }), 40);
    assert.equal((await database.getFirstAsync("SELECT COUNT(*) AS count FROM events")).count, countBefore);
    assert.equal((await database.getFirstAsync("SELECT checked FROM circles WHERE id = 4040")).checked, 1);
    assert.equal((await database.getFirstAsync("SELECT purchase_status FROM items WHERE id = 4042")).purchase_status, 1);
    assert.deepEqual(await database.getFirstAsync("SELECT * FROM events WHERE id = 41"), otherBefore);
    assert.deepEqual(await database.getAllAsync("SELECT * FROM circles WHERE event_id = 41"), circlesBefore);
    assert.equal(fileSystem.fileBytes("file:///documents/images/41/other.png").toString(), "other candidate image");
    await database.runAsync("UPDATE events SET sync_uid = ? WHERE id = 41", "explicit-uid");
    ambiguous.event_uid = "explicit-uid";
    registerArchive(fileSystem, ambiguousZip, ambiguous, { "maps/pc-map.png": "uid map" });
    assert.equal(await db.importFromZip(ambiguousZip, undefined, { selectLegacyTarget: async () => { throw new Error("unexpected selection"); } }), 41);
    delete ambiguous.event_uid;
    registerArchive(fileSystem, ambiguousZip, ambiguous, { "maps/pc-map.png": "stale map" });
    await assert.rejects(db.importFromZip(ambiguousZip, undefined, { selectLegacyTarget: async () => {
      await database.runAsync("UPDATE events SET memo = ? WHERE id = 40", "concurrent change");
      return 40;
    } }), /対象イベントが変更されました/);
    console.log("legacy ZIP import: unique name/date updates preserve mobile state; different dates and ambiguous candidates remain separate PASS");
  } finally {
    Module._load = originalLoad;
    delete require.cache[databasePath];
    sqlite.close();
  }
}

module.exports = { runDatabaseSingleEventSyncTests };
