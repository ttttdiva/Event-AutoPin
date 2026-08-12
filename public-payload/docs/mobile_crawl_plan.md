# モバイルアプリ大規模改修 計画書

**作成日**: 2026-04-17（更新）
**対象**: `shopping-app/` (Expo / React Native)
**目的**: モバイルアプリ単体で「AIを使ったイベントのサークルリスト準備」が完結できるようにする

---

## 1. ゴール

現状モバイルアプリは **閲覧・購入管理に特化した消費側クライアント**。デスクトップアプリで生成したZIPを取り込んで使う前提になっている。

本改修で以下を実現する：

1. **クロール機能**: モバイル単体でイベントサイトURLからサークルリストを自動生成する
2. **フル編集機能**: デスクトップにあるサークル編集機能をモバイルにも移植
3. **APIキー設定タブ**: OpenAI / Gemini / xAI のAPIキーをアプリ内から入力・保存

**両立方針**: デスクトップアプリは維持。モバイル版はデスクトップと同じZIP/circle_master.jsonを互換フォーマットとして使う。

---

## 2. 設計方針

### 2.1 基本設計

- **ヘッダー判定＋機械パース**: `GenericAdapter` は表の列名だけをLLMに渡し、検証済みmappingで行を端末内抽出する。同一ホストかつ列名完全一致のmappingだけを再利用する
- **2段階プレビュー**: クロール結果をユーザー確認させてから本実行に入る（デスクトップの `parse_site_preview → reparse_with_feedback → 本実行` と同じ流れ）
- **Adapterパターン**: Picrea / Generic / LearnedPattern を順に試行
- **ZIP import パスを再利用**: クロール結果は `event.json + 画像` 構造を生成し、既存の `importFromZip()` 相当のDB投入ロジックに流す
- **APIキーは `expo-secure-store`** で暗号化保存
- **既定LLM: `gemini-3-flash-preview`**（テキスト・画像両用）
  - OpenAIフォールバック: `gpt-5-mini`
  - 高性能パース用: `gpt-5.4`（オプション）
- **マルチモデルfallback**: デスクトップの `LLMClient` と同じく、プライマリ失敗時に自動でフォールバック

### 2.2 OCR / twscrape の扱い

- **OCR（マップ座標自動推定）**: モバイルでは省略。手動ピン配置は既実装でドラッグ対応済のため致命傷ではない。
- **twscrape**: ヘッドレスブラウザ前提でモバイル不可。お品書き抽出は **Grok API（xAI）** に一本化。

### 2.3 ナビゲーション変更

現在 Stack ルーター → タブへ変更:

```
Tabs
├── イベント (現 app/index.tsx を (tabs)/index.tsx に格納)
│   └── Nested Stack → event/[id]
├── クロール (新規 (tabs)/crawl.tsx)
└── 設定 (新規 (tabs)/settings.tsx)
```

Expo Router の `(tabs)` グループで実装。

---

## 3. 実装範囲（全フェーズ通しで実施）

### Phase 1: 基盤
- タブナビゲーション（Stack → Tabs）
- 設定タブ新規作成（テーマ・バージョンチェック移設 + APIキー入力 + モデル設定）
- `expo-secure-store` 導入
- APIキー接続テスト機能

### Phase 2: クロール骨組み
- クロールタブ新規（URL・イベント名・日付・モデル選択・Cookieファイル）
- `lib/crawl/` ディレクトリ構成
  - `adapter-factory.ts` / `adapters/picrea.ts` / `adapters/generic.ts`
  - `llm-client.ts`（OpenAI/Gemini/xAI 抽象化 + フォールバック）
  - `html-fetcher.ts`（Cookie注入）
  - `pipeline.ts`
- 2フェーズ（プレビュー → 承認 → 本実行）

### Phase 3: Generic Adapter（LLMパース）
- 表ヘッダーだけを使う列mapping判定と、行データの機械抽出
- ページネーション対応
- ユーザーフィードバック再解析ボタン
- 判定済み列mappingをSQLite設定へ保存し、ホスト名・列名完全一致時だけ再利用

### Phase 4: 画像DL
- サークルカット画像 逐次ダウンロード
- `expo-image-manipulator` リサイズ
- `expo-keep-awake` で画面維持
- SQLite投入

### Phase 5: Twitter お品書き（Grok）
- Grok API クライアント
- 検索→画像DL→保存

### Phase 6: Gemini画像認識
- お品書き画像からアイテム・ジャンル抽出
- `circle_master.json` の genre 自動埋め

### Phase 7: サークル編集機能拡張
- 編集モーダルに 名前・スペース・ホール・各種URL・説明・欠席/既刊 を追加
- チップUIで欠席/既刊トグル

### Phase 8: メモリーバンク更新＋コミット/プッシュ

---

## 4. 追加ライブラリ

| ライブラリ | 用途 |
|----------|------|
| `expo-secure-store` | APIキー暗号化保存 |
| `node-html-parser` | 軽量HTMLパース（Pure JS） |
| `expo-image-manipulator` | 画像リサイズ |
| `expo-keep-awake` | 長時間処理中の画面維持 |

LLMはすべて `fetch` 直叩き（SDK不使用で依存軽量化）。

---

## 5. DB変更

| テーブル | 追加 | 用途 |
|---------|------|------|
| `circles` | `crawled_from_url`, `crawled_at` | クロール由来の追跡 |
| 新規 `crawl_history` | `id`, `event_id`, `url`, `status`, `error`, `created_at` | クロール履歴 |

APIキーは SQLite ではなく `expo-secure-store`。

---

## 6. 対応サイト

- **Picrea** (`picrea.jp`): 専用Adapter（API直叩き）
- **LearnedPattern**: `learned_patterns/site_patterns.json` 既知パターン
- **Generic (LLM)**: 上記に該当しない全サイト → LLMで汎用パース

これはデスクトップと同じ構成。

---

## 7. LLMモデル設定

### デフォルト
- **テキスト**: `gemini-3-flash-preview`
- **画像**: `gemini-3-flash-preview`（マルチモーダル対応）
- **フォールバック**: `gpt-5-mini` (OpenAI)
- **高性能パース（オプション）**: `gpt-5.4` (OpenAI)

### ユーザー選択肢
設定タブでモデル切替可能:
- `gemini-3-flash-preview` / `gemini-3.1-pro-preview` / `gemini-3.1-flash-lite`
- `gpt-5-mini` / `gpt-5.4`

APIキー未設定のモデルは選択肢から除外。

---

## 8. 既存機能への影響

- ZIP import / export: **後方互換**維持
- circle_master.json: **変更なし**
- デスクトップ↔モバイルのZIPやり取りは引き続き動く

---

## 9. リスク

| リスク | 対策 |
|-------|------|
| LLM API料金のユーザー負担 | 設定に件数上限＋モデル選択。モバイルは `gemini-3-flash-preview` を既定で安価運用 |
| JavaScriptレンダリング型SPAのスクレイプ不能 | 初期版では対応サイト（Picrea以外）で機能するLLMパースで頑張る。将来のWebView統合は別issue |
| 長時間処理の中断 | `expo-keep-awake`、chunk単位でDB逐次書き込み |
| APKビルドにAPIキー埋込はしない | ユーザー入力＋secure-storeのみ |
