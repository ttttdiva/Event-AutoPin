# Unlimited OCR 運用・配布手順

## 責務

- OCRモデル推論・番号検出・座標評価はデスクトップ/Python側だけが担当する。
- `shopping-app/` は `event.json` の正規化済み `pin_x` / `pin_y` を表示し、必要なら
  手動ドラッグで補正する。APKへモデル・HFキャッシュ・OCR専用venvを含めない。
- 下流の番号要素は従来契約を維持する。

```json
{"number":"12","x":468,"y":304,"width":20,"height":18,
 "confidence":99,"variant":"unlimited_ocr_0"}
```

## 配布先PCのセットアップ

1. 本体環境を `setup.bat`（または `python -m venv venv` + `pip install -r requirements.txt`）で構築。
2. OCR専用環境を `scripts\\setup_unlimited_ocr.bat` で構築。
   - BATはWindows cmd向けUTF-8 BOM/CRLFで配布し、`cmd /d /c scripts\\setup_unlimited_ocr.bat --doctor` を使用する。
   - 既定revisionはremote codeがCUDA専用。CUDAがないPCではdoctorが非0で終了する。CPUを使う場合はCPU対応を確認した別モデルを明示する。
   - 専用venvの場所は `UNLIMITED_OCR_VENV`、HFキャッシュは `HF_HOME` で変更できる。
3. `scripts\\setup_unlimited_ocr.bat --doctor` を実行し、Python/torch/CUDA/モデルキャッシュを確認。
4. デスクトップ設定画面で「設定」→「マップOCR」を開き、必要に応じて次を指定。
   - **モデル名**: Hub ID（既定 `baidu/Unlimited-OCR`）。
   - **モデルパス**: ローカル snapshot を使う場合。モデル名より優先。
   - **OCR専用venv / HFキャッシュ**: PCごとの実パス。
   - **revision**: リモートコードを固定するため、検証済みrevisionを既定のまま推奨。
   - **デバイス**: 自動/CUDA/CPU。既定revisionではCPUおよびCUDAなしの自動をfail-closedし、CPU対応の別モデルだけCPUを選べる。
   - **戦略**: `small_digits`（gundamで小さい連番を優先し0件時baseへフォールバック）を推奨。full-frameの番号候補が12件未満の場合、320px/overlap 160pxの全体coarse sweepと相対detail ROIを最大160枚で走査する（設定で無効化可能）。tileはsingle/gundam標準groundingを使い、モデルは1回だけロードする。
5. 「OCR環境を診断」で設定が解決できることを確認してからマップの「自動配置」を実行。

UI操作中にpip installやモデルDLは自動実行しない。未構築の場合は setup 手順を含む
エラーを表示する。

## エラーの見方

OCR失敗時も下流の既存契約を壊さず空配列で処理を継続するが、次の診断を残す。

- `coordinates_map_*.json` の `ocr_diagnostics.error.code/message`。
- ブリッジレスポンスの `ocr_diagnostics` と stderr末尾。
- GUI結果ログの「専用venv」「モデル」「CUDA」「戦略」情報。

代表的なコードは `image_read_failed`、`runner_failed`、`timeout`、
`image_inference_failed`、`no_numbers`。モデル未配置とCUDAなしを混同しない。

## 実マップ評価

リポジトリの過去イベントで確認済みの `pin_x/pin_y` を評価用GTへ変換し、
複数イベント・複数戦略を同じ指標で比較する。例:

```powershell
venv\\Scripts\\python.exe scripts\\build_unlimited_ocr_ground_truth.py `
  --event-dir events\\Ariaers_Assort_Flowers_Fraternity_2025_20251005_000000 `
  --event-dir events\\KotonoHolic!!_2025_20251102_000000 `
  --output-json temp\\ocr-ground-truth.repo-events.json
```

評価本体は依存のある本体venvから起動し、推論だけをOCR専用venvへ委譲する。
`--runner-python` を省略すると `UNLIMITED_OCR_PYTHON` または
`UNLIMITED_OCR_VENV`（既定 `temp/unlimited_ocr_venv`）を自動解決する。

```powershell
venv\\Scripts\\python.exe scripts\\evaluate_unlimited_ocr.py `
  --image events\\Ariaers_Assort_Flowers_Fraternity_2025_20251005_000000\\maps\\map_01.jpg `
  --ground-truth temp\\ocr-ground-truth.repo-events.json `
  --runner-python temp\\unlimited_ocr_venv\\Scripts\\python.exe `
  --strategy small_digits --distance-threshold 50 `
  --output-json temp\\ocr-evaluation-small.json

venv\\Scripts\\python.exe scripts\\evaluate_unlimited_ocr.py `
  --image events\\Ariaers_Assort_Flowers_Fraternity_2025_20251005_000000\\maps\\map_01.jpg `
  --ground-truth temp\\ocr-ground-truth.repo-events.json `
  --runner-python temp\\unlimited_ocr_venv\\Scripts\\python.exe `
  --strategy gundam_then_base --output-json temp\\ocr-evaluation-fallback.json
```

手動で正解番号とboxを記録した ground-truth JSONも同じ形式で利用できる。
ただし repo event 由来GTは `pin_x/pin_y` が番号輪郭を示さないため、
`center_x/center_y` の pin-center 形式を採用する。pin-center評価では
IoUを計算せず、番号一致後の中心距離（px）だけを採点する。実画像の番号
輪郭を手動採寸できる場合に限り、従来の `x/y/width/height` GTを使って
IoUを併記する。

```powershell
venv\\Scripts\\python.exe scripts\\evaluate_unlimited_ocr.py `
  --image-dir events\\<event>\\maps `
  --ground-truth docs\\ocr-ground-truth.example.json `
  --model baidu/Unlimited-OCR `
  --runner-python temp\\unlimited_ocr_venv\\Scripts\\python.exe `
  --output-json temp\\ocr-evaluation.json
```

保存済みrunner出力の比較（モデル再実行なし）は `--predictions <runner.json>` を使う。
評価値は本番engineと同じ grouped/table 正規化後の番号一致 precision/recall、中心座標平均誤差（px）、
pin-center時はIoUなし、画像別の false-positive/false-negative。モデル、revision、
ローカル `--model-path` や `--strategy gundam_then_base` を複数回実行して
同一画像の値を比較する。実マップが存在しないCIでは parser/metrics の単体テストだけを行い、
評価未実施を成功とみなさない。

クリーンcheckoutで再現できる合法な生成fixture（320x160、番号01/02）も
`tests/fixtures/unlimited_ocr_pin_center/` に収録している。モデルをダウンロード
せず、pin-center GTと保存済み予測の評価を次で検証できる（recall=1.0、IoU=null）。

```powershell
venv\Scripts\python.exe scripts\evaluate_unlimited_ocr.py `
  --image tests\fixtures\unlimited_ocr_pin_center\map_01.png `
  --ground-truth tests\fixtures\unlimited_ocr_pin_center\ground_truth.json `
  --predictions tests\fixtures\unlimited_ocr_pin_center\predictions.json `
  --output-json tests\fixtures\unlimited_ocr_pin_center\evaluation.json
```

異なるモデル/リビジョンを比較する場合（別モデルがキャッシュ済みの場合のみ実行）:

```powershell
venv\Scripts\python.exe scripts\evaluate_unlimited_ocr.py `
  --image events\<event>\maps\map_01.jpg `
  --ground-truth docs\ocr-ground-truth.repo-events.json `
  --model baidu/Unlimited-OCR --model org/other-model `
  --runner-python temp\unlimited_ocr_venv\Scripts\python.exe `
  --output-json temp\ocr-evaluation-models.json

venv\Scripts\python.exe scripts\evaluate_unlimited_ocr.py `
  --image events\<event>\maps\map_01.jpg `
  --ground-truth docs\ocr-ground-truth.repo-events.json `
  --model-path <local-model-snapshot> --strategy single `
  --runner-python temp\unlimited_ocr_venv\Scripts\python.exe `
  --output-json temp\ocr-evaluation-local.json
```

このリポジトリで取得済みの実行結果は `docs/ocr-evaluation.repo-events.json` に保存している。
Ariaers実マップ（GT 56 pin-center、番号一致+50px以内、IoU対象外）の比較は次のとおり。

| モデル/解決方法 | revision | mode / strategy | tile | matched | recall |
|---|---|---|---|---:|---:|
| `baidu/Unlimited-OCR` (Hub ID) | `ee63731b...` | gundam→base / `small_digits` | なし | 0/56 | 0% |
| `baidu/Unlimited-OCR` (Hub ID) | `ee63731b...` | base / `single` | なし | 0/56 | 0% |
| 同上 | 同上 | full=`small_digits`, tile=`single/gundam` | 320/160、158枚 | **36/56** | **64.29%** |
| 同revisionのローカルsnapshot (`--model-path`) | `ee63731b...` | gundam / `single` | なし | 0/56 | 0% |

標準ROI経路のpredictedは89、precision 40.45%、平均中心距離21.68px、RTX 5090で434.6秒。
50pxは、repo event由来pinがブース中心で、右端の印字番号中心が約45〜55pxずれることを明示して
採用した閾値であり、文字box GTのIoUと混同しない。別のUnlimited-OCR互換モデルはローカルに無く、
未検証モデルを自動ダウンロードして比較していない。GUI/CLIのHub ID・ローカルpath切替は維持し、
新モデル導入時は同じrevision固定・同じGT・同じ50px指標で再測定する。

overlap tileの同番号boxをIoU/中心距離で重複排除した現在の正規化では predicted 76、
matched 35、precision 46.05%、recall 62.50%、平均中心距離21.657px。画像/GTのSHA、
provenance、厳密な再現コマンドは `docs/ocr-evaluation-reproduction.md` を参照する。
