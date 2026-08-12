# Event AutoPin (Tauri)

日本語UIで、クロール実行・サークルリスト編集・モバイル互換チェックをタブ分離して行うデスクトップアプリです。

## 画面構成（タブ）
- クロール実行
- サークルリスト編集
- モバイル連携確認
- 設定

## 主な機能
- 日本語UI（タブ分離）
- クロール実行の進捗バー表示（擬似進捗 + 実行結果ログ）
- サークルリスト編集GUI（event.json）
  - event.json 読込 / 保存
  - Twitter URL をクリックして確認
  - サークル画像/アイテム画像のプレビュー表示
- 過去出展検索
  - `events/*/event.json` のサークル名と本タイトルを横断検索
  - 全角半角・大小文字・空白記号・ひらがな/カタカナの表記差と軽微な入力違いに対応
  - 一致したサークルごとに過去イベント、開催日、配置、本タイトルを表示
- マップ編集
  - マップ画像の追加・差し替え
  - ピン自動配置
  - 校正点追加と再処理
- モバイルアプリ取り込み前の互換性チェック
  - `event / circles / metadata` 構造
  - circlesの主要互換キー確認（`pin_x`, `pin_y`, `map_number`, `absence_status`, `existing_only_status`）
  - 画像埋め込み（`image_data`）件数チェック
- 実行設定の保存/読込（`desktop.config.json`）

## モバイル連携ファイルについて
- 連携フォーマットは **JSON** を想定。
- 画像は `circle_cut_data` / `item_images[].image_data` / `event.maps[].image_data` として埋め込み可能です。

## 開発
```bash
cd desktop-app
npm install
npm run tauri:dev
```
