@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0.."

rem 配布先の Python ランチャー差を吸収する。Python のバージョン選択や
rem venv作成は setup_unlimited_ocr.py 側に委譲し、固定バージョンを指定しない。
if defined UNLIMITED_OCR_PYTHON goto :use_configured

where uv >nul 2>nul
if not errorlevel 1 (
    goto :use_uv
)

where python >nul 2>nul
if not errorlevel 1 (
    goto :use_python
)

where py >nul 2>nul
if not errorlevel 1 (
    goto :use_py
)

echo Python/uv/py が見つかりません。UNLIMITED_OCR_PYTHON を設定してください。
exit /b 1

:use_uv
set "UV_PYTHON="
for /f "usebackq delims=" %%P in (`uv python find 3.12 2^>nul`) do set "UV_PYTHON=%%P"
if defined UV_PYTHON goto :run_uv_python
echo uv 経由の起動に失敗したため、python/py ランチャーへフォールバックします。
where python >nul 2>nul
if not errorlevel 1 goto :use_python
where py >nul 2>nul
if not errorlevel 1 goto :use_py
echo uv は失敗し、python/py も見つかりませんでした。
exit /b 1

:run_uv_python
"%UV_PYTHON%" scripts\setup_unlimited_ocr.py %*
exit /b %ERRORLEVEL%

:use_configured
"%UNLIMITED_OCR_PYTHON%" scripts\setup_unlimited_ocr.py %*
exit /b %ERRORLEVEL%

:use_python
python scripts\setup_unlimited_ocr.py %*
exit /b %ERRORLEVEL%

:use_py
py scripts\setup_unlimited_ocr.py %*
exit /b %ERRORLEVEL%
