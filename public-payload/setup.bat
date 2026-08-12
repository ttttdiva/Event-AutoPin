@echo off
chcp 65001 >nul

echo.
echo === Python環境のセットアップ ===
echo.

py -m venv venv
call venv\Scripts\activate

pip install -r requirements.txt

echo.
echo === Unlimited OCR環境のセットアップ ===
echo.

call scripts\setup_unlimited_ocr.bat
if %ERRORLEVEL% NEQ 0 (
    echo [警告] Unlimited OCR環境のセットアップに失敗しました
    echo マップOCRを使う前に scripts\setup_unlimited_ocr.bat を再実行してください
)

echo.
echo === ファイアウォール設定（モバイル連携用） ===
echo.

set "EXE_PATH=%~dp0EventTrailStudio.exe"

REM 既存ルールを削除（エラーは無視）
netsh advfirewall firewall delete rule name="EventTrailStudio" >nul 2>&1

REM 受信許可ルールを追加
netsh advfirewall firewall add rule name="EventTrailStudio" dir=in action=allow program="%EXE_PATH%" profile=private,public enable=yes >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo ファイアウォールルールを設定しました: %EXE_PATH%
) else (
    echo [警告] ファイアウォール設定に失敗しました（管理者権限が必要です）
    echo 管理者として再実行するか、手動でEventTrailStudio.exeの受信を許可してください
)

echo.
echo セットアップが完了しました！
