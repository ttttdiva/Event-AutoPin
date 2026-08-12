# Tauri + Python 併用アーキテクチャ方針（Windows実行前提）

## 結論
- **併用で進めるのが最適**です。
  - UI/配布: **Tauri (Rust + Web UI)**
  - 既存ロジック: **Python（twscrape/OCR/既存スクレイピング資産）**
- Rust側でPythonを再実装するより、まずは既存Pythonをプロセス連携で呼ぶ方が圧倒的に早く、リスクが低いです。

## 推奨構成

```text
Desktop App (Tauri)
  ├─ Frontend (TypeScript)
  ├─ Rust Command Layer
  │    ├─ run_python_job(job_name, payload_json)
  │    └─ stream_logs / handle timeout / error mapping
  └─ Python Runtime (venv)
       ├─ cli entrypoint (python -m src.commands.desktop_bridge)
       ├─ twscrape / OCR / adapters / formatters
       └─ JSON I/O (stdin/stdout or temp files)
```

## 連携方式（最初はこれで十分）
1. Tauri(Rust) から `python -m ...` を `std::process::Command` で実行
2. 入力は JSON（ファイル or stdin）
3. 出力も JSON（stdout）
4. 失敗時は `exit code + stderr` をUIに表示

この方式なら、既存のPythonコードをほぼそのまま活用できます。

## Windows で動かす方針

### 1) Python依存をWindowsネイティブで固定
- WSL2内ではなく、Windows側で以下を整備
  - Python 3.11+（推奨）
  - venv
  - OCR専用 Python 3.12 venv（マップOCR利用時）
  - 必要なら Visual C++ Build Tools

### 2) 実行スクリプトを分離
- `scripts/windows/` に Windows起動用スクリプトを置き、
  - venv有効化
  - 環境変数設定
  - Pythonコマンド実行
  を一元化する。

### 3) Tauri から参照する Python パスを設定化
- `desktop.config.json`（今後追加）に下記を持つ方針
  - `pythonExecutable`
  - `projectRoot`
  - `unlimitedOcrVenvPath`（任意）
  - `ocrModelCacheDir`（任意）

### 4) マップOCR
- マップOCRは本体 `venv` ではなく `temp/unlimited_ocr_venv` の Python 3.12 環境で `baidu/Unlimited-OCR` を実行する。
- 初回セットアップは `scripts\setup_unlimited_ocr.bat` を使う。
- モデルキャッシュは既定で `temp\hf_cache` を使い、`HF_HOME` で上書きできる。

### 5) 配布戦略（段階的）
- Phase 1: Python同梱なし（ユーザー環境のPythonを参照）
- Phase 2: Python埋め込み配布（embedded Python / installer同梱）


## 実装ステータス (2026-03-12)
- ✅ `src.commands.desktop_bridge` を追加（`ping`, `list_jobs`, `extract_twitter_catalogs`）
- ✅ JSON入出力で1プロセス連携の土台を実装
- ✅ Windows補助スクリプトから `--job` / `--payload` 指定で起動可能

## 直近タスク（実装順）
1. Tauri実装を本運用UIへ拡張（設定保存・実ジョブ入力フォーム・ログ表示）
2. PythonブリッジCLI拡張（`run_main_pipeline` 追加、一時config生成実行）
3. Tauri→Pythonで「1ジョブ実行」疎通
4. 既存処理（twscrape取得 → JSON整形）を1ユースケース移植
5. Windowsネイティブ環境でE2E確認

## 注意点
- `twscrape` はレート制限/認証失効を前提に、
  - 再試行
  - エラー分類
  - ユーザー向けメッセージ
  をUI層で明示する。
- PythonとRustの責務を分離する。
  - Rust: 配布/プロセス制御/OS連携
  - Python: ドメインロジック（収集・解析・整形）

## 判断基準（将来）
- Python呼び出しがボトルネック化しない限り、再実装しない。
- 高頻度・低遅延が必要な一部処理のみRust化を検討。


- 日本語UI化、クロール進捗バー、event.json手動編集GUI、モバイル互換チェックをデスクトップ機能として追加
