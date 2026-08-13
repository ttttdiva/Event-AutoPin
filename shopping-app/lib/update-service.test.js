const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadUpdateService(expoVersion = "1.0.0") {
  const filename = path.join(__dirname, "update-service.ts");
  const transpiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  }).outputText;

  const alerts = [];
  const installedUrls = [];
  const moduleRecord = { exports: {} };
  const mockRequire = (request) => {
    if (request === "expo-constants") {
      return { expoConfig: { version: expoVersion } };
    }
    if (request === "react-native") {
      return {
        Alert: { alert: (...args) => alerts.push(args) },
        Linking: { openURL: async () => undefined },
      };
    }
    if (request === "../modules/apk-installer") {
      return { installApk: async (url) => installedUrls.push(url) };
    }
    throw new Error(`予期しない import: ${request}`);
  };

  const execute = new Function(
    "exports",
    "require",
    "module",
    "__filename",
    "__dirname",
    transpiled,
  );
  execute(
    moduleRecord.exports,
    mockRequire,
    moduleRecord,
    filename,
    __dirname,
  );
  return { service: moduleRecord.exports, alerts, installedUrls };
}

function responseJson(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function validLatest(mobileVersion = "1.2.0") {
  return {
    desktop: {
      version: "0.1.11",
      url: "https://github.com/ttttdiva/Event-AutoPin/releases/download/desktop-v0.1.11/EventAutoPin.exe",
      notes: "desktop",
      date: "2026-08-13",
    },
    mobile: {
      version: mobileVersion,
      url: `https://github.com/ttttdiva/Event-AutoPin/releases/download/mobile-v${mobileVersion}/EventAutoPin.apk`,
      notes: "mobile",
      date: "2026-08-14",
    },
  };
}

function normalizeScriptLineEndings(source) {
  return source.replace(/\r\n?/g, "\n");
}

function extractEmbeddedReleaseValidators(shellSource, batchSource) {
  // Git's checkout settings may give the public Windows checkout CRLF files,
  // while the heredoc/marker contract itself is line-ending agnostic.
  const normalizedShellSource = normalizeScriptLineEndings(shellSource);
  const shellMatch = normalizedShellSource.match(
    /cat > "\$VALIDATOR_JS" <<'NODE'\n([\s\S]*?)\nNODE\n/,
  );
  assert.ok(shellMatch, "build_apk.sh validator が見つかる");

  const normalizedBatchSource = normalizeScriptLineEndings(batchSource);
  const beginMarker = "REM __RELEASE_" + "VALIDATOR_JS_BEGIN__";
  const endMarker = "REM __RELEASE_" + "VALIDATOR_JS_END__";
  const begin = normalizedBatchSource.indexOf(beginMarker);
  const bodyStart = normalizedBatchSource.indexOf("\n", begin) + 1;
  const end = normalizedBatchSource.indexOf(endMarker, bodyStart);
  assert.ok(begin >= 0 && bodyStart > begin && end > bodyStart);
  const batchValidator = normalizedBatchSource.slice(bodyStart, end).trimEnd();
  assert.equal(batchValidator, shellMatch[1], "bash/bat validator の契約が一致する");
  return [shellMatch[1], batchValidator];
}

function loadEmbeddedReleaseValidators() {
  const repositoryRoot = path.resolve(__dirname, "../..");
  const shellSource = fs.readFileSync(
    path.join(repositoryRoot, "scripts/build_apk.sh"),
    "utf8",
  );
  const batchSource = fs.readFileSync(
    path.join(repositoryRoot, "scripts/build_apk.bat"),
    "utf8",
  );
  return extractEmbeddedReleaseValidators(shellSource, batchSource);
}

test("release validator loader は CRLF の build script からも抽出できる", () => {
  const repositoryRoot = path.resolve(__dirname, "../..");
  const shellSource = fs.readFileSync(
    path.join(repositoryRoot, "scripts/build_apk.sh"),
    "utf8",
  );
  const batchSource = fs.readFileSync(
    path.join(repositoryRoot, "scripts/build_apk.bat"),
    "utf8",
  );
  const expected = extractEmbeddedReleaseValidators(shellSource, batchSource);
  const crlf = (source) => normalizeScriptLineEndings(source).replace(/\n/g, "\r\n");
  assert.deepEqual(
    extractEmbeddedReleaseValidators(crlf(shellSource), crlf(batchSource)),
    expected,
  );
});

test("latest.json は desktop と mobile の完全な trusted schema を必須にする", () => {
  const { service } = loadUpdateService();
  assert.equal(service.parseLatestJson(validLatest()).mobile.version, "1.2.0");
  assert.throws(
    () => service.parseLatestJson({ mobile: validLatest().mobile }),
    /desktop invalid/,
  );
  assert.throws(
    () =>
      service.parseLatestJson({
        ...validLatest(),
        mobile: {
          ...validLatest().mobile,
          url: "https://github.com/attacker/repo/releases/download/mobile-v1.2.0/EventAutoPin.apk",
        },
      }),
    /mobile invalid/,
  );
  assert.throws(
    () =>
      service.parseLatestJson({
        ...validLatest(),
        mobile: { ...validLatest().mobile, version: "1.2.0-rc.1" },
      }),
    /mobile invalid/,
  );
});

test("更新取得は React Native 対応の no-store 指定を付ける", async () => {
  const { service } = loadUpdateService();
  const calls = [];
  const result = await service.checkForUpdateWithDependencies("1.0.0", {
    fetch: async (url, init) => {
      calls.push({ url, init });
      return responseJson(validLatest("1.2.0"));
    },
  });

  assert.equal(result.available, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://raw.githubusercontent.com/ttttdiva/Event-AutoPin/main/latest.json");
  assert.equal(calls[0].init.cache, "no-store");
  assert.match(calls[0].init.headers["Cache-Control"], /no-store/);
  assert.equal(calls[0].init.headers.Pragma, "no-cache");
});

test("同梱 React Native fetch polyfill が no-store を cache busting に変換する", () => {
  const reactNativePackage = require.resolve("react-native/package.json");
  const polyfillPath = require.resolve("whatwg-fetch/fetch.js", {
    paths: [path.dirname(reactNativePackage)],
  });
  const source = fs.readFileSync(polyfillPath, "utf8");
  assert.match(source, /options\.cache === ['"]no-store['"]/);
  assert.match(source, /this\.url \+= .*new Date\(\)\.getTime\(\)/);
});

test("release validator は malformed metadata、digest不一致、post-write改変を拒否する", () => {
  for (const [index, source] of loadEmbeddedReleaseValidators().entries()) {
    const work = fs.mkdtempSync(
      path.join(os.tmpdir(), `event-autopin-release-validator-${index}-`),
    );
    try {
      const validator = path.join(work, "validator.js");
      const responsePath = path.join(work, "latest-response.json");
      const nextPath = path.join(work, "latest-next.json");
      const contextPath = path.join(work, "latest-context.json");
      fs.writeFileSync(validator, source);
      const latest = validLatest("1.2.0");
      fs.writeFileSync(
        responsePath,
        JSON.stringify({
          sha: "a".repeat(40),
          encoding: "base64",
          content: Buffer.from(JSON.stringify(latest)).toString("base64"),
        }),
      );
      childProcess.execFileSync(process.execPath, [
        validator,
        "prepare-latest",
        responsePath,
        nextPath,
        contextPath,
        "1.3.0",
        "https://github.com/ttttdiva/Event-AutoPin/releases/download/mobile-v1.3.0/EventAutoPin.apk",
        "notes",
        "2026-08-14",
      ]);
      assert.deepEqual(JSON.parse(fs.readFileSync(nextPath, "utf8")).desktop, latest.desktop);

      const malformedPath = path.join(work, "malformed.json");
      fs.writeFileSync(
        malformedPath,
        JSON.stringify({
          sha: "a".repeat(40),
          encoding: "base64",
          content: Buffer.from("{bad").toString("base64"),
        }),
      );
      const malformed = childProcess.spawnSync(process.execPath, [
        validator,
        "prepare-latest",
        malformedPath,
        path.join(work, "should-not-exist.json"),
        path.join(work, "should-not-exist-context.json"),
        "1.3.0",
        "https://github.com/ttttdiva/Event-AutoPin/releases/download/mobile-v1.3.0/EventAutoPin.apk",
        "notes",
        "2026-08-14",
      ]);
      assert.notEqual(malformed.status, 0);

      const releasePath = path.join(work, "release.json");
      fs.writeFileSync(
        releasePath,
        JSON.stringify({
          tag_name: "mobile-v1.3.0",
          draft: false,
          prerelease: false,
          assets: [{
            name: "EventAutoPin.apk",
            browser_download_url:
              "https://github.com/ttttdiva/Event-AutoPin/releases/download/mobile-v1.3.0/EventAutoPin.apk",
            state: "uploaded",
            size: 42,
            digest: `sha256:${"b".repeat(64)}`,
          }],
        }),
      );
      childProcess.execFileSync(process.execPath, [
        validator,
        "validate-release",
        releasePath,
        "mobile",
        "1.3.0",
        "EventAutoPin.apk",
        "https://github.com/ttttdiva/Event-AutoPin/releases/download/mobile-v1.3.0/EventAutoPin.apk",
        "b".repeat(64),
      ]);
      const wrongDigest = childProcess.spawnSync(process.execPath, [
        validator,
        "validate-release",
        releasePath,
        "mobile",
        "1.3.0",
        "EventAutoPin.apk",
        "https://github.com/ttttdiva/Event-AutoPin/releases/download/mobile-v1.3.0/EventAutoPin.apk",
        "c".repeat(64),
      ]);
      assert.notEqual(wrongDigest.status, 0);

      const nextBytes = fs.readFileSync(nextPath);
      const postPath = path.join(work, "post.json");
      fs.writeFileSync(
        postPath,
        JSON.stringify({
          sha: "d".repeat(40),
          encoding: "base64",
          content: nextBytes.toString("base64"),
        }),
      );
      childProcess.execFileSync(process.execPath, [
        validator,
        "verify-post",
        postPath,
        nextPath,
        contextPath,
        "d".repeat(40),
      ]);
      fs.writeFileSync(
        postPath,
        JSON.stringify({
          sha: "d".repeat(40),
          encoding: "base64",
          content: Buffer.concat([nextBytes, Buffer.from(" ")]).toString("base64"),
        }),
      );
      const changedPost = childProcess.spawnSync(process.execPath, [
        validator,
        "verify-post",
        postPath,
        nextPath,
        contextPath,
        "d".repeat(40),
      ]);
      assert.notEqual(changedPost.status, 0);
    } finally {
      assert.ok(path.resolve(work).startsWith(path.resolve(os.tmpdir())));
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
});

test("不正な latest.json は trusted GitHub Release API のみへフォールバックする", async () => {
  const { service } = loadUpdateService();
  const calls = [];
  const result = await service.checkForUpdateWithDependencies("1.0.0", {
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url.includes("raw.githubusercontent.com")) {
        return responseJson({ mobile: validLatest("1.3.0").mobile });
      }
      return responseJson([
        {
          tag_name: "mobile-v1.3.0",
          draft: false,
          prerelease: false,
          assets: [
            {
              name: "EventAutoPin.apk",
              browser_download_url:
                "https://github.com/ttttdiva/Event-AutoPin/releases/download/mobile-v1.3.0/EventAutoPin.apk",
            },
          ],
        },
      ]);
    },
    now: () => new Date("2026-08-14T00:00:00.000Z"),
  });

  assert.equal(result.available, true);
  assert.equal(result.latestVersion, "1.3.0");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.init.cache === "no-store"));
});

test("untrusted release asset しかない場合は更新なしで fail closed にする", async () => {
  const { service } = loadUpdateService();
  const result = await service.checkForUpdateWithDependencies("1.0.0", {
    fetch: async (url) => {
      if (url.includes("raw.githubusercontent.com")) {
        return responseJson({}, 404);
      }
      return responseJson([
        {
          tag_name: "mobile-v9.9.9",
          draft: false,
          prerelease: false,
          assets: [
            {
              name: "EventAutoPin.apk",
              browser_download_url:
                "https://github.com/attacker/repo/releases/download/mobile-v9.9.9/EventAutoPin.apk",
            },
          ],
        },
      ]);
    },
  });

  assert.equal(result.available, false);
  assert.match(result.errorMessage, /mobile release not found/);
});

test("外部から渡された untrusted URL は Alert と installer に到達しない", () => {
  const { service, alerts, installedUrls } = loadUpdateService();
  service.showUpdateAlert({
    available: true,
    currentVersion: "1.0.0",
    latestVersion: "2.0.0",
    downloadUrl: "https://example.com/malware.apk",
  });
  assert.equal(alerts.length, 0);
  assert.equal(installedUrls.length, 0);
});

test("検証後に結果objectが変更されても installer は検証済みURLだけを使う", async () => {
  const { service, alerts, installedUrls } = loadUpdateService();
  const trustedUrl =
    "https://github.com/ttttdiva/Event-AutoPin/releases/download/mobile-v2.0.0/EventAutoPin.apk";
  const result = {
    available: true,
    currentVersion: "1.0.0",
    latestVersion: "2.0.0",
    downloadUrl: trustedUrl,
  };
  service.showUpdateAlert(result);
  result.downloadUrl = "https://example.com/malware.apk";

  await alerts[0][2][1].onPress();
  assert.deepEqual(installedUrls, [trustedUrl]);
});
