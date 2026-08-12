# Unlimited OCR 移行計画書（Tesseract 完全削除）

対象: マップOCR（`src/space_locator/`）のOCRエンジンを Tesseract から baidu/Unlimited-OCR に置き換える。
実装担当: Codex。本書は main ブランチ上で直接作業する前提で書かれている（ブランチ・worktree は作らない）。

---

## 1. 背景と目的

- 現行のマップOCR（`src/space_locator/ocr_engine.py`）は pytesseract + 大量の前処理バリアント（CLAHE / 二値化 / 回転 / 左帯ROI）で番号検出しているが、検出率が実用に耐えない。
- 動作実証済みの Unlimited OCR（Hugging Face `baidu/Unlimited-OCR`、DeepSeek-OCR系VLMアーキテクチャ）へ全面置換する。
- Tesseract は依存・セットアップ手順・ドキュメント含め**完全削除**する。フォールバックとしても残さない。

## 2. 調査済みの前提事実（実装前に再調査不要）

### 2.1 現行構成（本リポジトリ）

- 本体 venv: **Python 3.10.11**（`venv/`）。`requirements.txt` は軽量依存のみ。
- OCRの唯一の利用経路: `OCREngine.extract_numbers_with_coordinates()` と `OCREngine.analyze_grid_pattern()`。
  呼び出し元は `src/space_locator/auto_coordinate_generator.py` のみ（714行付近）。
  その上流は `main.py::_generate_coordinates()`、`src/commands/desktop_bridge.py`（auto_place_map_pins ジョブ）、`auto_coordinate_generator.py` のCLI `main()` の3つ。
- OCR結果の下流契約（**維持必須**）: 各要素が以下のdictのリスト。
  ```json
  {"number": "12", "x": 468, "y": 304, "width": 20, "height": 18,
   "confidence": 85, "variant": "..."}
  ```
  - `number`: `zfill(2)` した文字列。値域 1〜99。
  - `x`/`y`/`width`/`height`: **元画像ピクセル座標**（左上原点）。
  - `variant`: `auto_coordinate_generator.py::select_horizontal_numbers()` が
    `variant.endswith("_0")`（回転なし判定）と `"_90" / "_-90" を含む`（回転除外）を参照している。
  - `confidence`: `NumberValidator`（LLM検証）が後段にあるため厳密な意味は不要。
- Tesseract への参照箇所（削除対象の全リスト）:
  - `requirements.txt`: `pytesseract==0.3.13`
  - `setup.bat`: 冒頭の Tesseract インストール確認ブロック
  - `setup.sh`: OS別 Tesseract インストールブロック
  - `src/space_locator/ocr_engine.py`: 実装本体
  - `ai-rules/SPACE_LOCATOR_DESIGN.md`: 設計記述
  - `docs/desktop/tauri-python-windows-plan.md`: 「Tesseract（OCR利用時）」「tesseractPath（任意）」
  - ※ `desktop-app/` 内のコードに tesseract 参照は無い（確認済み）。

### 2.2 実証済みのUnlimited OCR構成（別checkoutのprototype repository）

- 専用 venv（**Python 3.12**）+ 依存:
  - `torch==2.10.0+cu130` / `torchvision==0.25.0+cu130`（extra index: `https://download.pytorch.org/whl/cu130`）
  - `transformers==4.57.1`, `Pillow==12.1.1`, `matplotlib==3.10.8`, `einops==0.8.2`,
    `addict==2.4.0`, `easydict==1.13`, `pymupdf==1.27.2.2`, `psutil==7.2.2`
  - ※ pymupdf はPDF用なので本リポジトリでは不要（マップは画像のみ）。
- GPU: RTX 5090 (32GB)。cu130 ビルドが動作確認済み。CPUフォールバックも `device="cpu"` + float32 で動く（遅い）。
- モデル: `baidu/Unlimited-OCR`、単一 safetensors 約 **6.4GB**、
  ダウンロード済みキャッシュ: `<prototype-root>/temp/hf_cache/hub/models--baidu--Unlimited-OCR`
  （snapshot revision: `ee63731b6461c8afcdcc7b15352e7d2ffecc2ead`）。
- 参照実装: `<prototype-root>/src/image_processing/unlimited_ocr.py`（推論）、
  `<prototype-root>/src/utilities/setup_unlimited_ocr_env.py`（venv構築 + doctor）、
  `<prototype-root>/scripts/setup_unlimited_ocr.bat` / `unlimited_ocr.bat`（ラッパー）。

### 2.3 モデルAPI仕様（`modeling_unlimitedocr.py` 読解済み）

- ロード:
  ```python
  tokenizer = AutoTokenizer.from_pretrained(model_name, trust_remote_code=True)
  model = AutoModel.from_pretrained(model_name, trust_remote_code=True,
                                    use_safetensors=True, torch_dtype=dtype)
  model = model.eval().cuda()  # CPU時は .cuda() しない
  ```
- 推論: `model.infer(tokenizer, prompt=..., image_file=..., output_path=..., base_size, image_size, crop_mode, eval_mode, save_results, max_length, no_repeat_ngram_size, ngram_window, temperature=0.0)`
- **`eval_mode=True` にすると生の出力テキストが return される**（`<|ref|>`/`<|det|>` トークンを含む）。
  `save_results=True` はファイル出力専用（result.md はrefタグ除去済みで座標が失われる）ので使わない。
  ※ `eval_mode=True` でも `infer()` 冒頭で `output_path` に対して `os.makedirs` するため、書き込み可能なダミー出力ディレクトリを渡す必要がある。
- grounding出力形式: `<|ref|>テキスト<|/ref|><|det|>[[x1, y1, x2, y2]]<|/det|>`
  - 座標は **0〜999 正規化**。ピクセル変換は `px = int(v / 999 * 画像幅または高さ)`（モデル同梱の `draw_bounding_boxes` と同一式）。
  - 1つのrefに複数boxが付く場合あり（`[[...],[...]]`）。
  - 抽出regex（モデル同梱 `re_match` と同等）:
    `r'<\|ref\|>(.*?)<\|/ref\|><\|det\|>(.*?)<\|/det\|>'`（DOTALL）
- プロンプト候補（モデルコード内コメントより）:
  - `"<image>\n<|grounding|>OCR this image. "` ← 座標付き全文OCR。**これを既定候補とする**
  - `"<image>\n<|grounding|>Given the layout of the image. "` ← レイアウト検出
  - `"<image>\nFree OCR. "` ← 座標なし（使わない）
  - ※ `<|grounding|>` を含まないプロンプトでは ref/det が出ない。テスト時の `"<image>document parsing."` は座標が取れないので流用しない。
- モード: gundam（`base_size=1024, image_size=640, crop_mode=True`）/ base（`base_size=1024, image_size=1024, crop_mode=False`）。高解像度マップには gundam を既定とする。det座標は crop_mode でも**元画像全体**に対する 0–999 正規化。
- 生成パラメータの実証値: `max_length=32768, no_repeat_ngram_size=35, ngram_window=128, temperature=0.0`。

## 3. 設計方針

### 3.1 プロセス分離（専用venv + サブプロセス）

本体 venv は Python 3.10・軽量依存であり、torch cu130 / transformers 4.57.1 / Python 3.12 とは共存できない。テストリポジトリで実証済みの「専用venv + 起動スクリプト」方式をそのまま採用する。

```
[本体venv Python 3.10]
  OCREngine.extract_numbers_with_coordinates()
    └─ subprocess: temp/unlimited_ocr_venv/Scripts/python.exe
         src/space_locator/unlimited_ocr_runner.py --image <map> --output-json <tmp>
           └─ [OCR専用venv Python 3.12 + torch cu130]
                AutoModel(baidu/Unlimited-OCR).infer(eval_mode=True)
                → ref/det パース → ピクセルbox JSON 出力
```

- runner は「画像 → テキスト要素+ピクセルbox の汎用JSON」を返すだけにする（ドメイン非依存）。
- 番号フィルタ（1〜99、zfill、複数番号refの分割）は本体側 `ocr_engine.py` に置く。
  → チューニングをOCR venv側に触れず本体だけで反復できる。単体テストも本体venvで完結する。

### 3.2 既存契約の維持

`OCREngine` のクラス名・メソッドシグネチャは変えない。呼び出し元3経路（main.py / desktop_bridge.py / CLI）は**無修正**で動くこと。

- `extract_numbers_with_coordinates(image_path, min_confidence=55)`
  - `min_confidence` は互換のため残すが no-op（docstringに非推奨と明記）。
  - 返り値の `confidence` は固定値 `99`（後段の `NumberValidator` がLLM検証するため実害なし）。
  - `variant` は固定値 `"unlimited_ocr_0"`
    （`endswith("_0")` → True、`"_90"`/`"_-90"` を含まない → 既存フィルタで「回転なし」として扱われる）。
- `analyze_grid_pattern()` / `save_debug_image()` / `main()`（CLIテスト実行）は純粋なcv2/統計処理なので**そのまま残す**。
- `--ocr-result`（既存OCR結果JSON読込）経路も無修正。

## 4. 変更ファイル一覧

### 新規

| ファイル | 内容 |
|---|---|
| `src/space_locator/unlimited_ocr_parser.py` | ref/det パース + 0–999→px変換の**純stdlib**関数。runnerと単体テストの双方から import |
| `src/space_locator/unlimited_ocr_runner.py` | OCR venv内で実行する推論CLI。stdlib + torch/transformers/PIL のみ |
| `scripts/setup_unlimited_ocr.py` | OCR専用venv構築 + doctor（09_testの `setup_unlimited_ocr_env.py` を移植） |
| `scripts/setup_unlimited_ocr.bat` | 上記のbatラッパー（`py -3.12` 起動） |
| `tests/unit/test_unlimited_ocr_parser.py` | パーサ単体テスト |
| `tests/unit/test_ocr_engine_numbers.py` | 要素→番号変換（フィルタ・分割）の単体テスト |

### 変更

| ファイル | 内容 |
|---|---|
| `src/space_locator/ocr_engine.py` | pytesseract・前処理バリアント群を全削除し、subprocess呼び出し + 要素→番号変換に置換 |
| `requirements.txt` | `pytesseract==0.3.13` を削除（opencv-python は他で使うので残す） |
| `setup.bat` | Tesseractブロック削除。venv構築後に `scripts\setup_unlimited_ocr.bat` を呼ぶ手順を追加 |
| `setup.sh` | Tesseractブロック削除。Unlimited OCR は Windows運用が主のため「Windowsは setup_unlimited_ocr.bat 参照」の注記のみ |
| `.gitignore` | `/temp/` を追加（OCR venv・HFキャッシュ・実行時出力を置くため） |
| `ai-rules/SPACE_LOCATOR_DESIGN.md` | Step1 と実装状況の記述を Unlimited OCR に更新 |
| `docs/desktop/tauri-python-windows-plan.md` | Tesseract / tesseractPath の記述を削除し、OCR専用venv前提に差し替え |

### 削除

- なし（ファイル単位の削除は無し。`ocr_engine.py` 内のTesseract関連コードのみ削除）

### コミット禁止

- `temp/` 配下すべて（venv・HFキャッシュ・出力）。モデル(6.4GB)・venvは絶対にコミットしない。

## 5. 実装仕様

### 5.1 `src/space_locator/unlimited_ocr_parser.py`（純stdlib）

```python
REF_DET_PATTERN = re.compile(
    r'<\|ref\|>(.*?)<\|/ref\|><\|det\|>(.*?)<\|/det\|>', re.DOTALL)

def parse_grounding_output(raw_text, image_width, image_height) -> list[dict]:
    """ref/det付き生出力を要素リストに変換する。
    返り値: [{"text": str, "x1": int, "y1": int, "x2": int, "y2": int}, ...]
    - det部は json ではなく Python リテラル形式のことがあるため
      ast.literal_eval でパースする（eval は使わない）。
    - 単一box `[x1,y1,x2,y2]` と複数box `[[..],[..]]` の両対応
      （先頭要素が数値なら1重にラップ）。
    - 変換式: px = int(v / 999 * image_width)  # y は image_height
    - x1>x2 等の不正boxはスキップ。パース不能なdetはスキップして続行。
    """
```

### 5.2 `src/space_locator/unlimited_ocr_runner.py`（OCR venv内で実行）

- 引数: `--image <path>`（複数指定可）, `--output-json <path>`, `--device auto|cuda|cpu`（既定 auto）,
  `--mode gundam|base`（既定 gundam）, `--prompt`（既定 `"<image>\n<|grounding|>OCR this image. "`）,
  `--max-length 32768`, `--no-repeat-ngram-size 35`, `--ngram-window 128`,
  `--include-raw`（デバッグ用に生出力をJSONへ含める）。
- 処理:
  1. `HF_HOME` 未設定なら `os.environ.setdefault("HF_HOME", str(REPO_ROOT / "temp" / "hf_cache"))`。
  2. モデルロードは 09_test の `load_model()` を踏襲。ただし
     `from_pretrained(..., revision="ee63731b6461c8afcdcc7b15352e7d2ffecc2ead")` で**revision固定**
     （trust_remote_code でリモートコードを実行するため、供給元改変への防御。定数として定義し、環境変数 `UNLIMITED_OCR_REVISION` で上書き可）。
  3. 画像ごとに `model.infer(..., eval_mode=True, save_results=False, output_path=<temp/unlimited_ocr_output>)` を実行し、返ってきた生テキストを `parse_grounding_output()`（`sys.path` にリポジトリrootを追加して import）でパース。
  4. 画像サイズは PIL で取得（cv2 はOCR venvに入れない）。
- 出力JSON（`--output-json` へUTF-8で書き出し、stdoutには進捗ログのみ）:
  ```json
  {
    "schema_version": 1,
    "model": "baidu/Unlimited-OCR",
    "revision": "ee63731b...",
    "device": "cuda",
    "results": [
      {
        "image": "<absolute-map-path>/map_01.png",
        "image_width": 2480, "image_height": 3508,
        "elapsed_sec": 3.2,
        "elements": [
          {"text": "12", "x1": 100, "y1": 200, "x2": 130, "y2": 224}
        ],
        "raw_output": "（--include-raw 時のみ）"
      }
    ]
  }
  ```
- 終了コード: 全画像成功=0、一部失敗=0（該当resultに `"error"` キー）、致命的失敗（モデルロード不能等）=1。

### 5.3 `scripts/setup_unlimited_ocr.py` + `.bat`

09_test の `setup_unlimited_ocr_env.py` を移植し、以下だけ変える:

- venv パス: `<repo>/temp/unlimited_ocr_venv`（環境変数 `UNLIMITED_OCR_VENV` で上書き可）。
- 依存リストから `pymupdf` を除外（PDF非対応で良い）。
- `--doctor` はそのまま（CUDA検出チェック）。CPUのみ環境でも警告止まりにし exit 0 とする（runnerがcpuフォールバックするため。09_test版の「CUDA無しで exit 2」は変更する）。
- doctor 出力に「モデルキャッシュの有無」（`HF_HOME/hub/models--baidu--Unlimited-OCR` の存在）を追加。

### 5.4 `src/space_locator/ocr_engine.py` の書き換え

**削除するもの**: `pytesseract` import、`cv2` の前処理バリアント生成（scaled/CLAHE/thresh/leftband/rotations）、`ocr_configs`、Tesseract結果ループ。

**残すもの**: クラス名 `OCREngine`、`analyze_grid_pattern()`、`save_debug_image()`、`main()`（CLI）。

**新しい `extract_numbers_with_coordinates()`**:

1. OCR venv の python（`_resolve_ocr_python()`）を解決。
   - 既定: `<repo>/temp/unlimited_ocr_venv/Scripts/python.exe`、`UNLIMITED_OCR_VENV` で上書き。
   - **存在しない場合は自動セットアップせず**、`RuntimeError("Unlimited OCR環境が未構築です。scripts\\setup_unlimited_ocr.bat を実行してください")` を投げる
     （デスクトップUI操作中に10分級のpip installが勝手に走るのを防ぐ。setup.bat 実行時に構築される運用）。
2. 一時JSONパス（`tempfile`）を作り、runner をサブプロセス実行。
   - タイムアウト: 既定 900 秒（`UNLIMITED_OCR_TIMEOUT_SEC` で上書き。初回はモデルDLが走り得るため長め）。
   - `HF_HOME` / `UNLIMITED_OCR_DEVICE` 環境変数を透過。
   - 失敗時は stderr 末尾を含む例外を投げる（呼び出し元 `generate_coordinates_from_map` は既に「OCR 0件→そのマップをスキップして継続」のエラーハンドリングを持つが、例外は捕捉していないため、**ここでは例外を投げず空リストを返し、logger.error に詳細を出す**方が既存のエラー方針（設計書「エラーハンドリング」表）に合う。venv未構築の場合のみ例外とし、明確にユーザー操作を促す）。
3. `elements` を `_elements_to_numbers(elements)`（純関数・単体テスト対象）で契約形式へ変換:
   - ref テキストを `strip()` し、全体が1〜2桁の数字（`1 <= int <= 99`）なら単独採用。
   - そうでなければ空白区切りでトークン分割し、トークンの8割以上が1〜2桁数字なら、boxを**トークン数で横等分**して各数字に割り当てる（マップの番号列が1refに束ねられた場合の救済）。それ以外のrefは捨てる。
   - `number=str(n).zfill(2)`, `x=x1`, `y=y1`, `width=x2-x1`, `height=y2-y1`,
     `confidence=99`, `variant="unlimited_ocr_0"`。
   - 同一番号かつ中心距離15px以内は重複統合（既存 `add_candidate` 相当）。
   - `(y, x)` でソートして返す（既存挙動維持）。

### 5.5 セットアップ手順の変更（`setup.bat`）

1. Tesseract確認ブロックを削除。
2. 既存の venv 構築 + `pip install -r requirements.txt` はそのまま。
3. その後に `call scripts\setup_unlimited_ocr.bat` を追加（失敗時は警告表示のみで続行。OCR以外の機能はOCR venv無しで動くため）。

### 5.6 モデルキャッシュの移行（コード外・一度きりの手作業）

再ダウンロード(6.4GB)を避けるため、既存キャッシュをコピーする:

```powershell
$PrototypeRoot = Read-Host 'Prototype repository root'
$RepositoryRoot = (Resolve-Path .).Path
$SourceCache = Join-Path $PrototypeRoot 'temp\hf_cache\hub\models--baidu--Unlimited-OCR'
$DestinationCache = Join-Path $RepositoryRoot 'temp\hf_cache\hub'
New-Item -ItemType Directory -Force $DestinationCache
Copy-Item -Recurse $SourceCache $DestinationCache
```

（コピーしない場合は初回実行時に自動ダウンロードされる。`HF_HOME` をprototype側の `temp/hf_cache` に向ける運用でも可だが、リポジトリ内完結を既定とする。）

## 6. 検証計画（マイルストーン）

実行環境: 本マシン（RTX 5090 / Python 3.12 は `py -3.12` で利用可能）。

- **M1: 環境構築**
  `scripts\setup_unlimited_ocr.bat` → doctor で torch 2.10.0+cu130 / cuda_available=True / モデルキャッシュ有を確認。
- **M2: runner 単体検証（最重要）**
  実マップ画像1枚（`events/*/maps/map_*.png` がローカルにあればそれを使用。無ければユーザーにサンプル画像の場所を確認する）に対し
  `--include-raw` 付きで実行し、以下を確認:
  1. ref/det が出力されること（出なければプロンプトを `Given the layout of the image. ` 等へ変更して比較）。
  2. **boxの粒度**: スペース番号が1refずつ分かれるか、行単位で束ねられるか。束ねられる場合は 5.4 の横等分ヒューリスティックの妥当性を raw_output で確認し、必要なら分割ロジックを調整する。
  3. gundam と base の両モードで検出数を比較し、良い方を既定にする。
- **M3: ocr_engine 統合検証**
  `venv\Scripts\python.exe src\space_locator\ocr_engine.py <マップ画像>` を実行し、
  `.ocr.json` の検出番号数・座標と `save_debug_image` の目視確認（従来の検出率約60%を上回ること）。
- **M4: 回帰テスト**
  - `venv\Scripts\python.exe -m pytest tests/unit` 全通過。
  - 新規単体テスト: パーサ（単一box/複数box/不正det/リテラル形式）、`_elements_to_numbers`（単独数字・複数数字分割・非数字除外・重複統合・zfill）。
- **M5: E2E（任意・LLM APIコストが発生するためユーザー確認の上で実施）**
  `auto_coordinate_generator.py <map> <event.json>` で座標マップJSON生成まで確認。
  実施しない場合は M3 の `.ocr.json` を `--ocr-result` に渡す経路で Step2 以降の互換を確認する。
- **M6: Tesseract残骸ゼロ確認**
  `grep -ri tesseract` がヒット0（本計画書と git 履歴を除く）。`pip show pytesseract` は本体venvに残っていても良い（アンインストールは任意）が、requirements.txt に無いこと。

## 7. リスクと対策

| リスク | 対策 |
|---|---|
| groundingのbox粒度が行単位で、番号ごとの座標が取れない | M2で最初に検証。横等分分割ヒューリスティック + プロンプト変更（layout系）で対処。それでも不十分なら `Locate <|ref|>...<|/ref|>` 型の番号指定プロンプトを検討（event.jsonから番号一覧は取得可能） |
| 初回実行時のモデルロードが遅い（10〜20秒/プロセス） | マップは1イベント数枚のため許容。runnerは `--image` 複数指定可にしてあり、将来まとめ処理に拡張可能 |
| `no_repeat_ngram_size=35` が番号の繰り返し出力を抑制する懸念 | 番号列は35-gramに満たないため通常影響なし。M2で検出漏れが規則的に出る場合は 0（無効）と比較する |
| trust_remote_code のサプライチェーンリスク | revision固定（`ee63731b...`）。HFキャッシュ済みコードと同一revisionのため追加DLも発生しない |
| GPU非搭載環境（他ユーザー配布時） | `--device auto` でCPUフォールバック（低速だが動作）。doctor はCUDA無しでも exit 0 |
| OCR venv未構築でデスクトップからOCR実行 | 明確なメッセージの例外 → desktop_bridge がエラーとして返す。setup.bat に構築手順を組込み |

## 8. 完了条件チェックリスト

- [ ] 新規6ファイル作成、変更7ファイル反映（§4の一覧どおり）
- [ ] `grep -ri tesseract` ヒット0（本計画書を除く）
- [ ] M1〜M4 完了（M2の粒度検証結果を報告に含める）
- [ ] `ai-rules/SPACE_LOCATOR_DESIGN.md` の処理フロー・実装状況を更新済み
- [ ] `temp/` がgitignoreされ、`git status --short` にモデル・venv・生成物が出ない
- [ ] コミットメッセージは日本語（例: `マップOCRをTesseractからUnlimited OCRへ置換`）
