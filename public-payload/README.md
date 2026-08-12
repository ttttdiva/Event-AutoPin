# EventTrail

イベントサイトからサークル情報を収集し、買い物リスト用の `event.json` と画像アセットを生成・編集するツールです。

## 構成

- `main.py` / `src/`: クロール、LLM解析、画像取得、再処理、マップピン自動配置
- `desktop-app/`: EventTrail Studio。クロール実行、`event.json` 編集、マップ編集、モバイル連携
- `shopping-app/`: EventTrail Go。`event.json` と画像アセットを読み込む買い物アプリ

## セットアップ

```bash
pip install -r requirements.txt
```

`.env` に利用するAPIキーを設定します。

```env
OPENAI_API_KEY=...
GOOGLE_API_KEY=...
```

## 基本実行

```bash
python main.py
python main.py -v
python main.py --reprocess
python main.py --regenerate-coordinates
```

`--reprocess` は既存の `event.json` を読み込み、おしながき未取得のサークルなどを再処理します。

## マップピン自動配置

マップ画像と `event.json` の `circles[].space` を使って、OCRと画像LLM解析で `pin_x` / `pin_y` / `map_number` を更新します。

```bash
python src/space_locator/auto_coordinate_generator.py events/example/maps/map_01.png events/example/event.json --map-number 1
```

EventTrail Studio のマップ編集画面では、次を実行できます。

- `自動配置`: 現在のマップ画像からピンを自動配置
- `校正点に追加`: 手動で置いたピンを校正点として保存
- `校正点で再処理`: 校正点を使って自動配置結果を補正

校正点は `event.map_calibration_points` に保存されます。

## 出力

標準のデータ形式は `event.json` です。主なフィールド:

- `event`: イベント名、開催日、マップ画像情報
- `circles[]`: サークル名、スペース、リンク、画像、購入状態、マップ座標
- `circles[].pin_x` / `pin_y`: 0から1の正規化マップ座標
- `circles[].map_number`: 対応するマップ番号

画像はイベントディレクトリ内の `circles/`、`items/`、`maps/` に保存します。モバイル連携は `event.json` と画像アセットをZIP化して行います。

## Desktop

```bash
cd desktop-app
npm install
npm run tauri:dev
```

## Mobile

```bash
cd shopping-app
npm install
npx expo start
```
