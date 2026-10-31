# Event AutoPin

イベントサイトからサークル情報を収集し、買い物リスト用の `event.json` と画像アセットを生成・編集するツールです。

## 構成

- `main.py` / `src/`: クロール、LLM解析、画像取得、再処理、マップピン自動配置
- `desktop-app/`: Event AutoPin desktop app。クロール実行、`event.json` 編集、マップ編集、モバイル連携
- `shopping-app/`: Event AutoPin mobile app。`event.json` と画像アセットを読み込む買い物アプリ

## セットアップ

```bash
pip install -r requirements.txt
```

マップOCRを使う場合は、本体とは別の専用環境も構築します（配布先PCごとに一度だけ）。

```bat
scripts\setup_unlimited_ocr.bat
scripts\setup_unlimited_ocr.bat --doctor
```

モデルパス/HFキャッシュ/実行デバイス/小さい連番戦略は Event AutoPin desktop app の設定画面で変更できます。既定の固定revisionはCUDA必須で、CPU指定またはCUDAのないautoはdoctorがfail-closedします。
詳しい運用と実マップ評価は [`docs/unlimited-ocr-operations.md`](docs/unlimited-ocr-operations.md) を参照してください。

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

Event AutoPin desktop app のマップ編集画面では、次を実行できます。

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

## 特定イベントの比較同期

デスクトップアプリとモバイルアプリの「モバイルと同期」／「PCと同期」から、選択した1件のイベントだけを比較して反映できます。両方の端末を同じ信頼できるLANに接続してください。接続元はデスクトップが広告するプライベートIPv4と同じ `/24` に制限されます（`/23` や `/16` など広いサブネットでは、同じLANでも使えない場合があります）。通信には有効期限20分のBearer tokenを使いますが、HTTP通信は暗号化されません。トークンの期限内に差分確認と最終確認を完了してください。信頼できないWi-Fiやネットワークでは使用しないでください。イベントの同定にはイベントUIDを使うため、名前や日付だけで別イベントを同一視しません。同期用UIDが未登録の場合は、登録確認が表示されます。

1. デスクトップとモバイルの両方で同じイベントを選びます。
2. デスクトップで「モバイルと同期」を開始し、表示されたQRをモバイルの「PCと同期」で1回だけ読み取ります。以降の送受信はこの同期セッションを使います。
3. モバイルのイベントZIPがPCへ届くと、イベント情報、サークルの追加・変更・削除、頒布物、購入状態、マップピン、画像ハッシュの差分がデスクトップに表示されます。
4. 差分を確認して「モバイル」か「PC」のどちらを正とするか選び、明示確認します。選択と必要な最終確認の前に保存済みイベントを変更することはありません。
5. 「モバイル」を選ぶと、対象イベントだけをPCへ反映します。モバイルは同じセッションで完了を受け取ります。
6. 「PC」を選ぶと、PCのZIPを同じセッションからモバイルが自動取得します。モバイルに差分が表示された後、最終確認すると対象イベントだけが反映され、双方に完了が通知されます。QRの再読み取りは不要です。

反映前に対象イベントのバックアップを作成します。比較や最終確認の途中で中止すると、反映処理が始まる前の保存済みデータは変更されません。デスクトップのモバイルタブ通常操作には「モバイルと同期」「全イベント同期」「ZIPエクスポート」「ZIPインポート」の4ボタンがあります。ZIPインポートは、ローカルで選択したroot直下の`event.json`を持つ単一イベントZIPを検証し、既存イベントの上書きを確認してから取り込みます。`circle_master.json`や`default_cuts/`など共有設定は対象外で、`sync_bundle.json`を含む全イベントbundle ZIPのデスクトップ取り込みには対応していません。旧単方向転送と手動ZIP入出力は、モバイルでは「インポート」画面の「高度な操作・バックアップ」から利用できます。
