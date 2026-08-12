# Unlimited OCR 評価の再現情報

## 追跡済み生成fixture

- 画像: `tests/fixtures/unlimited_ocr_pin_center/map_01.png`
- SHA-256: `2705E6DA0181921DBC5D3529A7E9C833D9EFA0EBE316C4BF77FC24EBCDD0D2EC`
- GT: `tests/fixtures/unlimited_ocr_pin_center/ground_truth.json`
- GT SHA-256: `4DB0D629317E33C5E97BCE91D16A71A684C64BE0678DB74E8E287ED7C3D16236`
- provenance: 320x160の白地と番号01/02を本評価専用に生成し、pin-center GTを人手で記録した。第三者画像・イベントデータは含まない。

```powershell
venv\Scripts\python.exe scripts\evaluate_unlimited_ocr.py --image tests\fixtures\unlimited_ocr_pin_center\map_01.png --ground-truth tests\fixtures\unlimited_ocr_pin_center\ground_truth.json --predictions tests\fixtures\unlimited_ocr_pin_center\predictions.json --output-json tests\fixtures\unlimited_ocr_pin_center\evaluation.json
```

期待値は predicted 2 / GT 2 / matched 2、precision 1.0、recall 1.0、pin-center平均距離10px、IoU対象外。これは評価器の再現fixtureであり、モデル精度を示すものではない。

## 利用者ローカルの過去イベント実マップ

- 入力: `events/Ariaers_Assort_Flowers_Fraternity_2025_20251005_000000/maps/map_01.jpg`
- SHA-256: `DF3A6C28F5FCB751B54E764F317E00AD9E9F3EF48AC4FF6CAAE9139775D179A7`
- 寸法: 3035x1803
- 権利/provenance: 利用者のローカル過去イベント入力。画像自体はこの変更で追加・再配布しない。権利状態は本reportで主張しない。
- GT: `docs/ocr-ground-truth.repo-events.json`（SHA-256 `AB1556A521B0FC6406815F4FE8A3C32179B0226BD19D92A6E77F52001E4AA93D`）
- GT provenance: `scripts/build_unlimited_ocr_ground_truth.py` で同eventの `event.json` に保存済みの `pin_x/pin_y` 56点を画像pixelのpin-centerへ変換。文字輪郭の手動bboxではないためIoUは採点しない。
- モデル: `baidu/Unlimited-OCR`、revision `ee63731b6461c8afcdcc7b15352e7d2ffecc2ead`

```powershell
temp\unlimited_ocr_venv\Scripts\python.exe src\space_locator\unlimited_ocr_runner.py --image events\Ariaers_Assort_Flowers_Fraternity_2025_20251005_000000\maps\map_01.jpg --output-json temp\phase1_accuracy_roi_standard.json --device cuda --strategy small_digits --mode gundam --max-length 4096 --include-raw
venv\Scripts\python.exe scripts\evaluate_unlimited_ocr.py --image events\Ariaers_Assort_Flowers_Fraternity_2025_20251005_000000\maps\map_01.jpg --ground-truth docs\ocr-ground-truth.repo-events.json --predictions temp\phase1_accuracy_roi_standard.json --distance-threshold 50 --output-json temp\phase1_accuracy_roi_eval50_dedup.json
```

RTX 5090 32GBでrunnerは434.6秒、158 tile。重複排除後は predicted 76 / matched 35、precision 46.05%、recall 62.50%、平均pin-center距離21.657px。50px閾値は保存pinがブース中心で印字中心とずれるためで、文字bbox IoUと混同しない。詳細比較は `docs/ocr-evaluation.repo-events.json`。

別のUnlimited-OCR互換モデルはローカルに無く、安全性・ライセンス未確認の巨大モデルを自動取得していない。次のように複数specを一括指定すれば、Hub ID/ローカルpath/revision/mode/strategyを同じGTで比較できる。

```powershell
venv\Scripts\python.exe scripts\evaluate_unlimited_ocr.py --image events\Ariaers_Assort_Flowers_Fraternity_2025_20251005_000000\maps\map_01.jpg --ground-truth docs\ocr-ground-truth.repo-events.json --model-spec '{"label":"pinned-gundam","model":"baidu/Unlimited-OCR","revision":"ee63731b6461c8afcdcc7b15352e7d2ffecc2ead","mode":"gundam","strategy":"small_digits"}' --model-spec '{"label":"alternate-local-base","model_path":"models/alternate","revision":"<fixed-revision>","mode":"base","strategy":"single"}' --output-json temp\ocr-evaluation-model-specs.json
```
