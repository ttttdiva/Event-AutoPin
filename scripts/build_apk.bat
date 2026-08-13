@echo off
REM === Expo/React Native APKビルド＆リリーススクリプト ===
REM 前提: JDK 17, Android SDK, gh CLI がインストール済み
REM 初回: npm install --legacy-peer-deps と expo prebuild --platform android --clean を先に実行すること
REM
REM ※ bashから cmd /c 経由で呼ぶと出力が返らないため、
REM   Claude Code等のbash環境では build_apk.sh を使うこと

set APP_NAME=EventAutoPin
set MOBILE_DIR=shopping-app
set RELEASE_REPO=ttttdiva/Event-AutoPin
if "%ALLOW_RELEASE_OVERWRITE%"=="" set ALLOW_RELEASE_OVERWRITE=0
if not "%ALLOW_RELEASE_OVERWRITE%"=="0" if not "%ALLOW_RELEASE_OVERWRITE%"=="1" (
    echo [ERROR] ALLOW_RELEASE_OVERWRITE は 0 または 1 を指定してください。
    exit /b 1
)

set RUNNING_IN_CI=0
if defined CI if /I not "%CI%"=="false" if /I not "%CI%"=="no" if not "%CI%"=="0" set RUNNING_IN_CI=1
if /I "%GITHUB_ACTIONS%"=="true" set RUNNING_IN_CI=1
if "%GITHUB_ACTIONS%"=="1" set RUNNING_IN_CI=1
if "%RUNNING_IN_CI%"=="1" if "%ALLOW_RELEASE_OVERWRITE%"=="1" (
    echo [ERROR] CI では既存リリースの上書きを許可できません。
    exit /b 1
)

if not defined JAVA_HOME if defined ProgramFiles set "JAVA_HOME=%ProgramFiles%\Microsoft\jdk-17.0.18.8-hotspot"
if not defined ANDROID_HOME if defined LOCALAPPDATA set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
if not defined JAVA_HOME (
    echo [ERROR] JAVA_HOME を設定してください（JDK 17 が必要です）。
    exit /b 1
)
if not defined ANDROID_HOME (
    echo [ERROR] ANDROID_HOME を設定してください（Android SDK が必要です）。
    exit /b 1
)
if not defined ANDROID_SDK_ROOT set "ANDROID_SDK_ROOT=%ANDROID_HOME%"
if not exist "%JAVA_HOME%" (
    echo [ERROR] JAVA_HOME が存在しません: %JAVA_HOME%
    exit /b 1
)
if not exist "%ANDROID_HOME%" (
    echo [ERROR] ANDROID_HOME が存在しません: %ANDROID_HOME%
    exit /b 1
)

REM JDK 17+ の Unix Domain Socket 問題を回避（Windows 必須）
if not defined JAVA_TMP_DIR set "JAVA_TMP_DIR=%TEMP%"
if not defined _JAVA_OPTIONS set "_JAVA_OPTIONS=-Djdk.net.unixdomain.tmpdir=%JAVA_TMP_DIR%"
if not defined GRADLE_OPTS set "GRADLE_OPTS=-Djdk.net.unixdomain.tmpdir=%JAVA_TMP_DIR%"

if not exist "%JAVA_TMP_DIR%" mkdir "%JAVA_TMP_DIR%"

cd /d "%~dp0..\%MOBILE_DIR%"

echo ===================================
echo  Expo prebuild でネイティブ設定を同期
echo ===================================

call npx expo prebuild --platform android

if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Expo prebuild に失敗しました
    exit /b 1
)

cd /d "%~dp0..\%MOBILE_DIR%\android"

if not exist "gradlew.bat" (
    echo [ERROR] android/ ディレクトリが見つかりません。
    echo         先に以下を実行してください:
    echo           cd %MOBILE_DIR%
    echo           npm install --legacy-peer-deps
    echo           npx expo prebuild --platform android --clean
    echo         その後 android/gradle.properties に以下を追記してください:
    echo           org.gradle.jvmargs=-Xmx4g -Djdk.net.unixdomain.tmpdir=%%JAVA_TMP_DIR%%
    exit /b 1
)

echo ===================================
echo  APK ローカルビルド開始
echo ===================================

if exist build rmdir /S /Q build
if exist app\build rmdir /S /Q app\build
if exist app\.cxx rmdir /S /Q app\.cxx
call gradlew.bat assembleRelease --no-daemon

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ===================================
    echo  ビルド失敗 (exit code: %ERRORLEVEL%)
    echo ===================================
    exit /b 1
)

echo.
cd /d "%~dp0.."
move /Y "%MOBILE_DIR%\android\app\build\outputs\apk\release\app-release.apk" "%APP_NAME%.apk"
echo ===================================
echo  ビルド成功！ APK: %APP_NAME%.apk
echo ===================================

REM === リリース処理（RELEASE_REPO が設定されている場合のみ） ===
if "%RELEASE_REPO%"=="" (
    echo.
    echo [INFO] RELEASE_REPO が未設定のためリリース処理をスキップ
    exit /b 0
)

REM app.json からバージョンを取得し、厳密な X.Y.Z 形式を検証
set "VERSION="
for /f "delims=" %%V in ('node -e "process.stdout.write(String(require('./%MOBILE_DIR:\=/%/app.json').expo.version??''))"') do set VERSION=%%V

if not defined VERSION (
    echo [ERROR] app.json のバージョンが空です
    exit /b 1
)
powershell -NoProfile -Command "if ('%VERSION%' -cnotmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') { exit 1 }"
if errorlevel 1 (
    echo [ERROR] app.json のバージョンが不正です: %VERSION%
    exit /b 1
)

set "APK_PATH=%CD%\%APP_NAME%.apk"
set "APK_SHA256="
for /f "usebackq delims=" %%H in (`powershell -NoProfile -Command "(Get-FileHash -LiteralPath '%APK_PATH%' -Algorithm SHA256).Hash.ToLowerInvariant()"`) do set "APK_SHA256=%%H"
if not defined APK_SHA256 (
    echo [ERROR] APK の SHA-256 を計算できませんでした
    exit /b 1
)

set "EXPECTED_TAG=mobile-v%VERSION%"
set "EXPECTED_APK_URL=https://github.com/%RELEASE_REPO%/releases/download/%EXPECTED_TAG%/%APP_NAME%.apk"
for /f "delims=" %%D in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%D

set "VALIDATOR_JS=%TEMP%\event-autopin-release-validator-%RANDOM%-%RANDOM%.js"
set "LATEST_RESPONSE=%TEMP%\event-autopin-latest-response-%RANDOM%-%RANDOM%.json"
set "LATEST_JSON=%TEMP%\event-autopin-latest-next-%RANDOM%-%RANDOM%.json"
set "LATEST_CONTEXT=%TEMP%\event-autopin-latest-context-%RANDOM%-%RANDOM%.json"
set "DESKTOP_RELEASE_RESPONSE=%TEMP%\event-autopin-desktop-release-%RANDOM%-%RANDOM%.json"
set "MOBILE_RELEASE_RESPONSE=%TEMP%\event-autopin-mobile-release-%RANDOM%-%RANDOM%.json"
set "RELEASE_LOOKUP_RESPONSE=%TEMP%\event-autopin-release-lookup-%RANDOM%-%RANDOM%.txt"
set "RELEASE_LOOKUP_ERROR=%TEMP%\event-autopin-release-error-%RANDOM%-%RANDOM%.txt"
set "PUT_RESPONSE=%TEMP%\event-autopin-put-%RANDOM%-%RANDOM%.json"
set "POST_RESPONSE=%TEMP%\event-autopin-post-%RANDOM%-%RANDOM%.json"

node -e "const fs=require('fs');const source=fs.readFileSync(process.argv[1],'utf8');const begin='REM __RELEASE_'+'VALIDATOR_JS_BEGIN__';const end='REM __RELEASE_'+'VALIDATOR_JS_END__';const start=source.indexOf(begin);const finish=source.indexOf(end,start);if(start<0||finish<0)process.exit(1);const firstLine=source.indexOf('\n',start);fs.writeFileSync(process.argv[2],source.slice(firstLine+1,finish).replace(/\r\n/g,'\n'),'utf8');" "%~f0" "%VALIDATOR_JS%"
if errorlevel 1 (
    echo [ERROR] failed to extract release validator
    call :cleanup_release_temp
    exit /b 1
)

echo.
echo ===================================
echo  既存 latest.json と desktop release を検証
echo ===================================

gh api repos/%RELEASE_REPO%/contents/latest.json > "%LATEST_RESPONSE%"
if errorlevel 1 (
    echo [ERROR] 既存 latest.json を取得できません。desktop section を保護するため中止します。
    call :cleanup_release_temp
    exit /b 1
)

node "%VALIDATOR_JS%" prepare-latest "%LATEST_RESPONSE%" "%LATEST_JSON%" "%LATEST_CONTEXT%" "%VERSION%" "%EXPECTED_APK_URL%" "v%VERSION% release" "%TODAY%"
if errorlevel 1 (
    echo [ERROR] 既存 latest.json を安全に更新できないため中止します。
    call :cleanup_release_temp
    exit /b 1
)

for /f "delims=" %%S in ('powershell -NoProfile -Command "$x=Get-Content -Raw -Encoding UTF8 -LiteralPath '%LATEST_CONTEXT%'|ConvertFrom-Json;[Console]::Write($x.fileSha)"') do set "FILE_SHA=%%S"
for /f "delims=" %%S in ('powershell -NoProfile -Command "$x=Get-Content -Raw -Encoding UTF8 -LiteralPath '%LATEST_CONTEXT%'|ConvertFrom-Json;[Console]::Write($x.desktop.version)"') do set "DESKTOP_VERSION=%%S"
for /f "delims=" %%S in ('powershell -NoProfile -Command "$x=Get-Content -Raw -Encoding UTF8 -LiteralPath '%LATEST_CONTEXT%'|ConvertFrom-Json;[Console]::Write($x.desktop.tag)"') do set "DESKTOP_TAG=%%S"
for /f "delims=" %%S in ('powershell -NoProfile -Command "$x=Get-Content -Raw -Encoding UTF8 -LiteralPath '%LATEST_CONTEXT%'|ConvertFrom-Json;[Console]::Write($x.desktop.asset)"') do set "DESKTOP_ASSET=%%S"
for /f "delims=" %%S in ('powershell -NoProfile -Command "$x=Get-Content -Raw -Encoding UTF8 -LiteralPath '%LATEST_CONTEXT%'|ConvertFrom-Json;[Console]::Write($x.desktop.url)"') do set "DESKTOP_URL=%%S"
if not defined FILE_SHA (
    echo [ERROR] latest.json の CAS SHA を読み取れませんでした。
    call :cleanup_release_temp
    exit /b 1
)
if not defined DESKTOP_VERSION (
    echo [ERROR] desktop release version を読み取れませんでした。
    call :cleanup_release_temp
    exit /b 1
)
if not defined DESKTOP_TAG (
    echo [ERROR] desktop release tag を読み取れませんでした。
    call :cleanup_release_temp
    exit /b 1
)
if not defined DESKTOP_ASSET (
    echo [ERROR] desktop release asset を読み取れませんでした。
    call :cleanup_release_temp
    exit /b 1
)
if not defined DESKTOP_URL (
    echo [ERROR] desktop release URL を読み取れませんでした。
    call :cleanup_release_temp
    exit /b 1
)

gh api repos/%RELEASE_REPO%/releases/tags/%DESKTOP_TAG% > "%DESKTOP_RELEASE_RESPONSE%"
if errorlevel 1 (
    echo [ERROR] latest.json が参照する desktop release を取得できません。
    call :cleanup_release_temp
    exit /b 1
)
node "%VALIDATOR_JS%" validate-release "%DESKTOP_RELEASE_RESPONSE%" desktop "%DESKTOP_VERSION%" "%DESKTOP_ASSET%" "%DESKTOP_URL%"
if errorlevel 1 (
    call :cleanup_release_temp
    exit /b 1
)

echo.
echo ===================================
echo  GitHub Release 作成: %EXPECTED_TAG%
echo ===================================

set "RELEASE_EXISTS=0"
gh api --include repos/%RELEASE_REPO%/releases/tags/%EXPECTED_TAG% > "%RELEASE_LOOKUP_RESPONSE%" 2> "%RELEASE_LOOKUP_ERROR%"
if errorlevel 1 (
    findstr /B /C:"HTTP/2.0 404 " /C:"HTTP/1.1 404 " "%RELEASE_LOOKUP_RESPONSE%" >nul
    if errorlevel 1 (
        type "%RELEASE_LOOKUP_ERROR%" 1>&2
        echo [ERROR] 既存 mobile release の有無を確認できないため中止します。
        call :cleanup_release_temp
        exit /b 1
    )
) else (
    set "RELEASE_EXISTS=1"
)

if "%RELEASE_EXISTS%"=="1" (
    if not "%ALLOW_RELEASE_OVERWRITE%"=="1" (
        echo [ERROR] %EXPECTED_TAG% は既に存在します。既存リリースを上書きしないため中止します。
        echo         上書きが必要な場合のみ ALLOW_RELEASE_OVERWRITE=1 を指定してください。
        call :cleanup_release_temp
        exit /b 1
    )
    echo 既存リリース %EXPECTED_TAG% にAPKを上書きアップロード（ローカル明示許可済み）...
    gh release upload "%EXPECTED_TAG%" "%APK_PATH%" --clobber --repo %RELEASE_REPO%
) else (
    echo 新規リリース %EXPECTED_TAG% を作成...
    gh release create "%EXPECTED_TAG%" "%APK_PATH%" --repo %RELEASE_REPO% --title "Mobile v%VERSION%" --notes "v%VERSION% リリース"
)

if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] GitHub Release の作成/アップロードに失敗しました
    call :cleanup_release_temp
    exit /b 1
)

gh api repos/%RELEASE_REPO%/releases/tags/%EXPECTED_TAG% > "%MOBILE_RELEASE_RESPONSE%"
if errorlevel 1 (
    echo [ERROR] upload 後の mobile release を取得できません。
    call :cleanup_release_temp
    exit /b 1
)
node "%VALIDATOR_JS%" validate-release "%MOBILE_RELEASE_RESPONSE%" mobile "%VERSION%" "%APP_NAME%.apk" "%EXPECTED_APK_URL%" "%APK_SHA256%"
if errorlevel 1 (
    call :cleanup_release_temp
    exit /b 1
)

echo.
echo ===================================
echo  latest.json 更新
echo ===================================

set "B64="
for /f "delims=" %%B in ('powershell -NoProfile -Command "[Console]::Write([Convert]::ToBase64String([IO.File]::ReadAllBytes('%LATEST_JSON%')))"') do set B64=%%B
if not defined B64 (
    echo [ERROR] latest.json の base64 encoding に失敗しました。
    call :cleanup_release_temp
    exit /b 1
)

echo latest.json を CAS 更新 (sha: %FILE_SHA%)...
gh api repos/%RELEASE_REPO%/contents/latest.json --method PUT --raw-field "message=latest.json を %EXPECTED_TAG% に更新" --raw-field "content=%B64%" --raw-field "sha=%FILE_SHA%" > "%PUT_RESPONSE%"

if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] latest.json の CAS 更新に失敗しました。競合の可能性があります。
    call :cleanup_release_temp
    exit /b 1
)

set "PUT_SHA="
for /f "delims=" %%S in ('node "%VALIDATOR_JS%" put-sha "%PUT_RESPONSE%"') do set "PUT_SHA=%%S"
if not defined PUT_SHA (
    echo [ERROR] latest.json PUT response の SHA を読み取れませんでした。
    call :cleanup_release_temp
    exit /b 1
)
gh api repos/%RELEASE_REPO%/contents/latest.json > "%POST_RESPONSE%"
if errorlevel 1 (
    echo [ERROR] latest.json 更新後の GET に失敗しました。
    call :cleanup_release_temp
    exit /b 1
)
node "%VALIDATOR_JS%" verify-post "%POST_RESPONSE%" "%LATEST_JSON%" "%LATEST_CONTEXT%" "%PUT_SHA%"
if errorlevel 1 (
    call :cleanup_release_temp
    exit /b 1
)

call :cleanup_release_temp

echo.
echo ===================================
echo  リリース完了！
echo  バージョン: mobile-v%VERSION%
echo  Release: https://github.com/%RELEASE_REPO%/releases/tag/mobile-v%VERSION%
echo ===================================
exit /b 0

:cleanup_release_temp
for %%F in ("%VALIDATOR_JS%" "%LATEST_RESPONSE%" "%LATEST_JSON%" "%LATEST_CONTEXT%" "%DESKTOP_RELEASE_RESPONSE%" "%MOBILE_RELEASE_RESPONSE%" "%RELEASE_LOOKUP_RESPONSE%" "%RELEASE_LOOKUP_ERROR%" "%PUT_RESPONSE%" "%POST_RESPONSE%") do if exist "%%~F" del /q "%%~F" >nul 2>&1
exit /b 0

REM __RELEASE_VALIDATOR_JS_BEGIN__
const fs = require("fs");

const REPOSITORY = "ttttdiva/Event-AutoPin";
const ASSETS = { desktop: "EventAutoPin.exe", mobile: "EventAutoPin.apk" };
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^sha256:([0-9a-f]{64})$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJson(path, label) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} の JSON が不正です: ${error.message}`);
  }
}

function validDate(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function expectedUrl(channel, version) {
  return `https://github.com/${REPOSITORY}/releases/download/${channel}-v${version}/${ASSETS[channel]}`;
}

function validateSection(value, channel) {
  assert(isRecord(value), `latest.json の ${channel} がありません`);
  assert(typeof value.version === "string" && VERSION_RE.test(value.version), `${channel}.version が不正です`);
  assert(value.url === expectedUrl(channel, value.version), `${channel}.url が version/tag/asset と一致しません`);
  assert(typeof value.notes === "string", `${channel}.notes が不正です`);
  assert(validDate(value.date), `${channel}.date が不正です`);
}

function validateLatest(value) {
  assert(isRecord(value), "latest.json は JSON object である必要があります");
  validateSection(value.desktop, "desktop");
  validateSection(value.mobile, "mobile");
}

function decodeContentsResponse(path) {
  const response = readJson(path, "GitHub Contents API response");
  assert(isRecord(response), "GitHub Contents API response が不正です");
  assert(typeof response.sha === "string" && SHA_RE.test(response.sha), "latest.json の CAS SHA が不正です");
  assert(response.encoding === "base64", "latest.json の encoding が base64 ではありません");
  assert(typeof response.content === "string", "latest.json の content がありません");
  const encoded = response.content.replace(/\s/g, "");
  assert(encoded.length > 0 && encoded.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded), "latest.json の base64 が不正です");
  const bytes = Buffer.from(encoded, "base64");
  assert(bytes.toString("base64") === encoded, "latest.json の base64 が canonical ではありません");
  let json;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`latest.json の JSON が不正です: ${error.message}`);
  }
  return { response, bytes, json };
}

function prepareLatest(args) {
  const [responsePath, outputPath, contextPath, version, url, notes, date] = args;
  assert(VERSION_RE.test(version), "mobile.version が不正です");
  assert(url === expectedUrl("mobile", version), "mobile URL/tag/asset が不正です");
  assert(validDate(date), "mobile.date が不正です");
  const current = decodeContentsResponse(responsePath);
  validateLatest(current.json);
  const next = {
    desktop: current.json.desktop,
    mobile: { version, url, notes, date },
  };
  validateLatest(next);
  fs.writeFileSync(outputPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.writeFileSync(contextPath, JSON.stringify({
    fileSha: current.response.sha,
    originalDesktop: current.json.desktop,
    desktop: {
      version: current.json.desktop.version,
      tag: `desktop-v${current.json.desktop.version}`,
      asset: ASSETS.desktop,
      url: current.json.desktop.url,
    },
  }), "utf8");
}

function validateRelease(args) {
  const [path, channel, version, assetName, url, expectedDigest = ""] = args;
  assert(channel === "desktop" || channel === "mobile", "release channel が不正です");
  assert(VERSION_RE.test(version), `${channel} release version が不正です`);
  assert(assetName === ASSETS[channel], `${channel} asset name が不正です`);
  assert(url === expectedUrl(channel, version), `${channel} release URL が不正です`);
  const release = readJson(path, `${channel} release API response`);
  assert(isRecord(release), `${channel} release API response が不正です`);
  assert(release.tag_name === `${channel}-v${version}`, `${channel} release tag が不正です`);
  assert(release.draft === false && release.prerelease === false, `${channel} release が公開済みではありません`);
  assert(Array.isArray(release.assets), `${channel} release assets が不正です`);
  const matches = release.assets.filter((asset) => isRecord(asset) && asset.name === assetName);
  assert(matches.length === 1, `${channel} release asset が一意に存在しません`);
  const asset = matches[0];
  assert(asset.browser_download_url === url, `${channel} asset URL が不正です`);
  assert(asset.state === "uploaded" && Number.isSafeInteger(asset.size) && asset.size > 0, `${channel} asset が upload 完了していません`);
  assert(typeof asset.digest === "string" && DIGEST_RE.test(asset.digest), `${channel} asset digest が不正です`);
  if (expectedDigest) {
    assert(DIGEST_RE.test(`sha256:${expectedDigest}`), "local APK digest が不正です");
    assert(asset.digest === `sha256:${expectedDigest}`, "GitHub asset digest が local APK と一致しません");
  }
}

function readPutSha(path) {
  const response = readJson(path, "latest.json PUT response");
  assert(isRecord(response) && isRecord(response.content), "latest.json PUT response に content がありません");
  assert(typeof response.content.sha === "string" && SHA_RE.test(response.content.sha), "latest.json PUT response SHA が不正です");
  process.stdout.write(response.content.sha);
}

function verifyPost(args) {
  const [responsePath, expectedPath, contextPath, putSha] = args;
  const actual = decodeContentsResponse(responsePath);
  const expectedBytes = fs.readFileSync(expectedPath);
  const context = readJson(contextPath, "latest context");
  assert(actual.response.sha === putSha, "post-write GET の SHA が PUT response と一致しません");
  assert(actual.bytes.equals(expectedBytes), "post-write GET の content が書き込み内容と一致しません");
  validateLatest(actual.json);
  assert(JSON.stringify(actual.json.desktop) === JSON.stringify(context.originalDesktop), "desktop section が変更されました");
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "prepare-latest") prepareLatest(args);
  else if (command === "validate-release") validateRelease(args);
  else if (command === "put-sha") readPutSha(args[0]);
  else if (command === "verify-post") verifyPost(args);
  else throw new Error(`unknown validator command: ${command}`);
} catch (error) {
  console.error(`[ERROR] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
REM __RELEASE_VALIDATOR_JS_END__
