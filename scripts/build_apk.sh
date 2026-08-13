#!/bin/bash
# === Expo/React Native APKビルド＆リリーススクリプト ===
# 前提: JDK 17, Android SDK, gh CLI がインストール済み
# 初回: npm install --legacy-peer-deps と expo prebuild --platform android --clean を先に実行すること
#
# bashから実行: bash scripts/build_apk.sh
# ※ .bat はbashから cmd /c 経由で呼ぶと出力が返らないため、Claude Code等のbash環境ではこちらを使う

set -e

# ===== プロジェクト固有の設定 =====
APP_NAME="EventAutoPin"
MOBILE_DIR="shopping-app"
RELEASE_REPO="ttttdiva/Event-AutoPin"
ALLOW_RELEASE_OVERWRITE="${ALLOW_RELEASE_OVERWRITE:-0}"
# ==================================

if [ "$ALLOW_RELEASE_OVERWRITE" != "0" ] && [ "$ALLOW_RELEASE_OVERWRITE" != "1" ]; then
    echo "[ERROR] ALLOW_RELEASE_OVERWRITE は 0 または 1 を指定してください。"
    exit 1
fi

RUNNING_IN_CI=0
case "${CI:-}" in
    ""|0|false|FALSE|no|NO) ;;
    *) RUNNING_IN_CI=1 ;;
esac
case "${GITHUB_ACTIONS:-}" in
    1|true|TRUE|yes|YES) RUNNING_IN_CI=1 ;;
esac
if [ "$RUNNING_IN_CI" = "1" ] && [ "$ALLOW_RELEASE_OVERWRITE" = "1" ]; then
    echo "[ERROR] CI では既存リリースの上書きを許可できません。"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -z "${JAVA_HOME:-}" ] && [ -n "${ProgramFiles:-}" ]; then
    JAVA_HOME="$ProgramFiles/Microsoft/jdk-17.0.18.8-hotspot"
fi
if [ -z "${ANDROID_HOME:-}" ] && [ -n "${LOCALAPPDATA:-}" ]; then
    ANDROID_HOME="$LOCALAPPDATA/Android/Sdk"
fi
if [ -z "${JAVA_HOME:-}" ]; then
    echo "[ERROR] JAVA_HOME を設定してください（JDK 17 が必要です）。"
    exit 1
fi
if [ -z "${ANDROID_HOME:-}" ]; then
    echo "[ERROR] ANDROID_HOME を設定してください（Android SDK が必要です）。"
    exit 1
fi
if command -v cygpath >/dev/null 2>&1; then
    JAVA_HOME="$(cygpath -u "$JAVA_HOME" 2>/dev/null || printf '%s' "$JAVA_HOME")"
    ANDROID_HOME="$(cygpath -u "$ANDROID_HOME" 2>/dev/null || printf '%s' "$ANDROID_HOME")"
fi
if [ ! -d "$JAVA_HOME" ]; then
    echo "[ERROR] JAVA_HOME が存在しません: $JAVA_HOME"
    exit 1
fi
if [ ! -d "$ANDROID_HOME" ]; then
    echo "[ERROR] ANDROID_HOME が存在しません: $ANDROID_HOME"
    exit 1
fi
export JAVA_HOME ANDROID_HOME
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
JAVA_TMP_DIR="${JAVA_TMP_DIR:-${TMPDIR:-${TEMP:-/tmp}}}"
if command -v cygpath >/dev/null 2>&1; then
    JAVA_TMP_DIR="$(cygpath -u "$JAVA_TMP_DIR" 2>/dev/null || printf '%s' "$JAVA_TMP_DIR")"
fi
if [ -z "${_JAVA_OPTIONS:-}" ]; then
    export _JAVA_OPTIONS="-Djdk.net.unixdomain.tmpdir=$JAVA_TMP_DIR"
fi
if [ -z "${GRADLE_OPTS:-}" ]; then
    export GRADLE_OPTS="-Djdk.net.unixdomain.tmpdir=$JAVA_TMP_DIR"
fi

mkdir -p "$JAVA_TMP_DIR"

cd "$PROJECT_ROOT/$MOBILE_DIR"

if [ "${SKIP_VERSION_BUMP:-0}" != "1" ]; then
    echo "==================================="
    echo " モバイル版バージョンを自動更新"
    echo "==================================="
    node <<'NODE'
const fs = require('fs');
const path = 'app.json';
const raw = fs.readFileSync(path, 'utf8');
const data = JSON.parse(raw);
const expo = data.expo ?? {};
const android = expo.android ?? {};
const version = String(expo.version ?? '0.0.0');
const parts = version.split('.').map((p) => Number.parseInt(p, 10));
while (parts.length < 3) parts.push(0);
if (parts.some((p) => !Number.isFinite(p))) {
  throw new Error(`app.json の version が不正です: ${version}`);
}
parts[2] += 1;
expo.version = parts.join('.');
android.versionCode = Number(android.versionCode ?? 0) + 1;
expo.android = android;
data.expo = expo;
fs.writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
console.log(`version: ${version} -> ${expo.version}`);
console.log(`versionCode: ${android.versionCode - 1} -> ${android.versionCode}`);
NODE
else
    echo "[INFO] SKIP_VERSION_BUMP=1 のため app.json のバージョン更新をスキップします"
fi

echo "==================================="
echo " Expo prebuild でネイティブ設定を同期"
echo "==================================="

npx expo prebuild --platform android

cd "$PROJECT_ROOT/$MOBILE_DIR/android"

if [ ! -f "./gradlew" ]; then
    echo "[ERROR] android/ ディレクトリが見つかりません。"
    echo "        先に以下を実行してください:"
    echo "          cd $MOBILE_DIR"
    echo "          npm install --legacy-peer-deps"
    echo "          npx expo prebuild --platform android --clean"
    exit 1
fi

echo "==================================="
echo " APK ローカルビルド開始"
echo "==================================="

rm -rf build app/build app/.cxx
./gradlew assembleRelease --no-daemon

cp app/build/outputs/apk/release/app-release.apk "$PROJECT_ROOT/$APP_NAME.apk"

echo ""
echo "==================================="
echo " ビルド成功！ APK: $APP_NAME.apk"
echo "==================================="

cd "$PROJECT_ROOT"

# === リリース処理（RELEASE_REPO が設定されている場合のみ） ===
if [ -z "$RELEASE_REPO" ]; then
    echo ""
    echo "[INFO] RELEASE_REPO が未設定のためリリース処理をスキップ"
    exit 0
fi

# app.json からバージョンを取得
VERSION=$(node -e "console.log(require('./$MOBILE_DIR/app.json').expo.version)")

if ! [[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
    echo "[ERROR] app.json のバージョンが不正です: ${VERSION}"
    exit 1
fi

APK_PATH="$PROJECT_ROOT/$APP_NAME.apk"
APK_SHA256=$(sha256sum "$APK_PATH" | awk '{print tolower($1)}')
if ! [[ "$APK_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
    echo "[ERROR] APK の SHA-256 を計算できませんでした"
    exit 1
fi

EXPECTED_TAG="mobile-v${VERSION}"
EXPECTED_APK_URL="https://github.com/${RELEASE_REPO}/releases/download/${EXPECTED_TAG}/${APP_NAME}.apk"
DATE=$(date +%Y-%m-%d)

VALIDATOR_JS=$(mktemp)
LATEST_RESPONSE=$(mktemp)
LATEST_JSON=$(mktemp)
LATEST_CONTEXT=$(mktemp)
DESKTOP_RELEASE_RESPONSE=$(mktemp)
MOBILE_RELEASE_RESPONSE=$(mktemp)
RELEASE_LOOKUP_ERROR=$(mktemp)
PUT_RESPONSE=$(mktemp)
POST_RESPONSE=$(mktemp)
cleanup_release_temp() {
    rm -f "$VALIDATOR_JS" "$LATEST_RESPONSE" "$LATEST_JSON" "$LATEST_CONTEXT" \
        "$DESKTOP_RELEASE_RESPONSE" "$MOBILE_RELEASE_RESPONSE" \
        "$RELEASE_LOOKUP_ERROR" "$PUT_RESPONSE" "$POST_RESPONSE"
}
trap cleanup_release_temp EXIT

cat > "$VALIDATOR_JS" <<'NODE'
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
NODE

echo ""
echo "==================================="
echo " 既存 latest.json と desktop release を検証"
echo "==================================="

# latest.json がない、読めない、壊れている、または両 section が完全でない場合は
# 新規作成や部分更新を行わず停止する。
if ! gh api "repos/$RELEASE_REPO/contents/latest.json" > "$LATEST_RESPONSE"; then
    echo "[ERROR] 既存 latest.json を取得できません。desktop section を保護するため中止します。"
    exit 1
fi
if ! node "$VALIDATOR_JS" prepare-latest \
    "$LATEST_RESPONSE" "$LATEST_JSON" "$LATEST_CONTEXT" \
    "$VERSION" "$EXPECTED_APK_URL" "v${VERSION} リリース" "$DATE"; then
    echo "[ERROR] 既存 latest.json を安全に更新できないため中止します。"
    exit 1
fi

FILE_SHA=$(node -e "const x=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(x.fileSha)" "$LATEST_CONTEXT")
DESKTOP_VERSION=$(node -e "const x=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(x.desktop.version)" "$LATEST_CONTEXT")
DESKTOP_TAG=$(node -e "const x=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(x.desktop.tag)" "$LATEST_CONTEXT")
DESKTOP_ASSET=$(node -e "const x=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(x.desktop.asset)" "$LATEST_CONTEXT")
DESKTOP_URL=$(node -e "const x=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(x.desktop.url)" "$LATEST_CONTEXT")

if ! gh api "repos/$RELEASE_REPO/releases/tags/$DESKTOP_TAG" > "$DESKTOP_RELEASE_RESPONSE"; then
    echo "[ERROR] latest.json が参照する desktop release を取得できません。"
    exit 1
fi
node "$VALIDATOR_JS" validate-release "$DESKTOP_RELEASE_RESPONSE" desktop \
    "$DESKTOP_VERSION" "$DESKTOP_ASSET" "$DESKTOP_URL"

echo ""
echo "==================================="
echo " GitHub Release 作成: ${EXPECTED_TAG}"
echo "==================================="

RELEASE_EXISTS=0
if gh api "repos/$RELEASE_REPO/releases/tags/$EXPECTED_TAG" \
    > "$MOBILE_RELEASE_RESPONSE" 2> "$RELEASE_LOOKUP_ERROR"; then
    RELEASE_EXISTS=1
elif grep -Eq "HTTP 404|Not Found" "$RELEASE_LOOKUP_ERROR"; then
    RELEASE_EXISTS=0
else
    cat "$RELEASE_LOOKUP_ERROR" >&2
    echo "[ERROR] 既存 mobile release の有無を確認できないため中止します。"
    exit 1
fi

# 既存リリースはローカルで明示許可された場合以外は保護する。
if [ "$RELEASE_EXISTS" = "1" ]; then
    if [ "$ALLOW_RELEASE_OVERWRITE" != "1" ]; then
        echo "[ERROR] ${EXPECTED_TAG} は既に存在します。既存リリースを上書きしないため中止します。"
        echo "        上書きが必要な場合のみ ALLOW_RELEASE_OVERWRITE=1 を指定してください。"
        exit 1
    fi
    echo "既存リリース ${EXPECTED_TAG} にAPKを上書きアップロード（ローカル明示許可済み）..."
    gh release upload "$EXPECTED_TAG" "$APK_PATH" --clobber --repo "$RELEASE_REPO"
else
    echo "新規リリース ${EXPECTED_TAG} を作成..."
    gh release create "$EXPECTED_TAG" "$APK_PATH" --repo "$RELEASE_REPO" \
        --title "Mobile v${VERSION}" --notes "v${VERSION} リリース"
fi

if ! gh api "repos/$RELEASE_REPO/releases/tags/$EXPECTED_TAG" > "$MOBILE_RELEASE_RESPONSE"; then
    echo "[ERROR] upload 後の mobile release を取得できません。"
    exit 1
fi
node "$VALIDATOR_JS" validate-release "$MOBILE_RELEASE_RESPONSE" mobile \
    "$VERSION" "$APP_NAME.apk" "$EXPECTED_APK_URL" "$APK_SHA256"

echo ""
echo "==================================="
echo " latest.json 更新"
echo "==================================="

B64=$(node -e "process.stdout.write(require('fs').readFileSync(process.argv[1]).toString('base64'))" "$LATEST_JSON")
echo "latest.json を CAS 更新 (sha: ${FILE_SHA})..."
if ! gh api "repos/$RELEASE_REPO/contents/latest.json" \
    --method PUT \
    --raw-field "message=latest.json を ${EXPECTED_TAG} に更新" \
    --raw-field "content=${B64}" \
    --raw-field "sha=${FILE_SHA}" > "$PUT_RESPONSE"; then
    echo "[ERROR] latest.json の CAS 更新に失敗しました。競合の可能性があります。"
    exit 1
fi

PUT_SHA=$(node "$VALIDATOR_JS" put-sha "$PUT_RESPONSE")
if ! gh api "repos/$RELEASE_REPO/contents/latest.json" > "$POST_RESPONSE"; then
    echo "[ERROR] latest.json 更新後の GET に失敗しました。"
    exit 1
fi
node "$VALIDATOR_JS" verify-post "$POST_RESPONSE" "$LATEST_JSON" "$LATEST_CONTEXT" "$PUT_SHA"

echo ""
echo "==================================="
echo " リリース完了！"
echo " バージョン: mobile-v${VERSION}"
echo " Release: https://github.com/${RELEASE_REPO}/releases/tag/mobile-v${VERSION}"
echo "==================================="
