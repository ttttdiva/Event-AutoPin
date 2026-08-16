#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
# Windowsジャンクション/シンボリックリンクを実パスに解決（Vite/Rollupがパス不一致でエラーになる対策）
if command -v readlink &>/dev/null; then
  PROJECT_ROOT="$(readlink -f "$PROJECT_ROOT")"
fi
DESKTOP_DIR="$PROJECT_ROOT/desktop-app"
EXE_PATH="$PROJECT_ROOT/EventAutoPin.exe"

echo "=== Event AutoPin.exe / EventAutoPin.exe 起動中チェック ==="
EXE_PID=$(tasklist 2>/dev/null | grep -E 'Event AutoPin\.exe|EventAutoPin\.exe' | awk '{print $2}' | head -1)
if [ -n "$EXE_PID" ]; then
  echo "エラー: Event AutoPin.exe または EventAutoPin.exe が起動中です (PID:$EXE_PID)。終了してから再試行してください。" >&2
  exit 1
fi

echo "=== npm install ==="
cd "$DESKTOP_DIR"
npm install

echo "=== ポート1420チェック ==="
PID1420=$(netstat -ano 2>/dev/null | grep ':1420 ' | grep LISTENING | awk '{print $5}' | head -1)
if [ -n "$PID1420" ]; then
  taskkill //PID $PID1420 //F 2>/dev/null
  echo "ポート1420のプロセス(PID:$PID1420)を停止"
  sleep 1
fi

echo "=== Tauri release build (raw) ==="
touch "$DESKTOP_DIR/src-tauri/src/main.rs"
npm run tauri:build:raw
BUILD_EXIT=$?
if [ $BUILD_EXIT -ne 0 ]; then
  echo "エラー: Tauriビルド失敗 (exit code: $BUILD_EXIT)" >&2
  exit 1
fi

echo "=== exe をプロジェクトルートにコピー ==="
RELEASE_DIR="$DESKTOP_DIR/src-tauri/target/release"
SOURCE_EXE=""
for candidate in \
  "$RELEASE_DIR/Event AutoPin.exe" \
  "$RELEASE_DIR/EventAutoPin.exe" \
  "$RELEASE_DIR/event-autopin-desktop.exe"
do
  if [ -f "$candidate" ]; then
    SOURCE_EXE="$candidate"
    break
  fi
done
if [ -z "$SOURCE_EXE" ] && [ -d "$RELEASE_DIR" ]; then
  SOURCE_EXE="$(ls -t "$RELEASE_DIR"/*.exe 2>/dev/null | head -1)"
fi
if [ -z "$SOURCE_EXE" ] || [ ! -f "$SOURCE_EXE" ]; then
  echo "エラー: release 配下に exe が見つかりません: $RELEASE_DIR" >&2
  exit 1
fi
TMP_EXE="$EXE_PATH.$$.tmp"
cleanup_tmp() { rm -f "$TMP_EXE"; }
trap cleanup_tmp EXIT
if ! cp "$SOURCE_EXE" "$TMP_EXE"; then
  echo "エラー: exeのプロジェクトルート配置に失敗しました" >&2
  exit 1
fi
SOURCE_SIZE=$(stat -c %s "$SOURCE_EXE" 2>/dev/null || stat -f %z "$SOURCE_EXE" 2>/dev/null)
COPIED_SIZE=$(stat -c %s "$TMP_EXE" 2>/dev/null || stat -f %z "$TMP_EXE" 2>/dev/null)
if [ -z "$SOURCE_SIZE" ] || [ "$SOURCE_SIZE" -le 0 ] || [ "$COPIED_SIZE" != "$SOURCE_SIZE" ]; then
  echo "エラー: exeコピー後のサイズ検証に失敗しました" >&2
  exit 1
fi
if ! mv -f "$TMP_EXE" "$EXE_PATH"; then
  echo "エラー: exeの最終配置に失敗しました" >&2
  exit 1
fi
if [ ! -s "$EXE_PATH" ]; then
  echo "エラー: 配置されたexeが存在しないか空です" >&2
  exit 1
fi
NEW_TS=$(stat -c %Y "$EXE_PATH" 2>/dev/null || stat -f %m "$EXE_PATH" 2>/dev/null)
echo "完了: $EXE_PATH (timestamp: $NEW_TS, bytes: $COPIED_SIZE)"
ls -la "$EXE_PATH"
