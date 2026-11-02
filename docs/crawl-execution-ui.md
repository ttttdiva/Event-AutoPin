# デスクトップ版クロール実行画面

本書は、デスクトップ版の「クロール実行」画面と `run_main_pipeline` の入力契約をまとめたものです。画面から実行する場合も、バックエンドは実行直前に同じ入力を再検証します。

## 実行開始と再処理

1. サイドバーで対象イベントを選択します。
2. 収集対象にソースを1件以上登録し、必要ならソースごとのマップURLと追加プロンプトを設定します。
3. 開催日、収集オプション、4つのモデル役割、必要なGrok方式を確認します。
4. 画面下部の実行前チェックが「実行可能」になってから「実行開始」を押します。

通常実行では、複数ソースをソース単位で処理してから、サークル・マップ・画像を選択イベントの出力先へ統合します。イベントURL、ソース設定、実行オプションは実行前にイベントメタデータへ反映されます。

`再処理=true` は新しいURLを取得する操作ではありません。選択イベントの既存 `event.json` を読み、次の対象だけを再検索します。

- 未取得（品目のないもの、または `needs_recheck`）
- 予告のみ（`preview` または予告タグ）
- 既存の確定済み品目は処理対象から外し、その品目・画像・メモを保持

再処理対象にはXアカウントURLまたは保存済みのおしながきポストURLが必要です。検索に失敗した対象は、成功した対象の更新と混ぜず既存データを保持します。保存済みイベント日がある場合、再処理で日付を省略しても今日の日付へ置き換えません。対象イベントの選択、`event.json`、出力先が確認できない場合は開始しません。

## ソース別設定

ソースは次の形でイベントメタデータと実行payloadへ渡されます。

```yaml
event_sources:
  - name: 公式一覧
    url: "https://example.invalid/event"
    map_urls:
      - "https://example.invalid/event/map"
    catalog_additional_prompt: |
      このソースに固有の指示
```

共通プロンプトは全ソースへ適用し、ソース固有プロンプトはそのソースの設定へ結合します。旧来の単一 `url` / `map_url` / プロンプト形式も読み込み時にソース形式へ補完します。各ソースの結果はbridgeのsource resultとして区別されます。

単一ソースでは、そのソースのmap/promptを実行設定へ接続します。複数ソースではソースごとに独立した実行へ渡し、統合後の各サークルに `source_event_url`（および表示用の`source_event_name`）を残して、どのソース由来かを追跡できます。

再処理では新しいcrawl URLとして `url` / `urls` を使わず、保存済みサークルの `source_event_url` に一致する `event_sources[].catalog_additional_prompt` を選びます。これにより、直接保存されたポストの処理とtimeline検索の両方へソース固有promptを適用し、timeline検索はpromptごとに分けて実行します。ソース切替時は日付を含む実効promptと動的キーワードも同期し、同一promptの再利用ではキーワード抽出を重複実行しません。保存済み `source_event_url` がない、または一致するソース設定がない対象は共通promptへ戻ります。

## オプションの依存関係

| オプション | 依存・動作 |
| --- | --- |
| `collect_catalogs` | `false` ならおしながき本文・画像の収集/解析を起動しません。再処理でも既存 `event.json` を変更せず、座標再生成だけは明示時に実行できます。 |
| `enable_twitter_catalog` | `false` ならX検索を行いません。保存済み・payloadで明示されたポストURLだけを処理する契約です。 |
| `use_grok_search` / `grok_search_mode` | `use_grok_search=false` ならAPI/Build/Botをすべて停止します。`true` のときも `api` / `build` / `bot` の選択方式だけを使います。 |
| `skip_circle_images` | 通常の新規サイト収集でサークルカットの取得を省略します。再処理では保存済みサークル画像を保持し、この切替は新規サイト収集段階にだけ適用されます。おしながき画像の収集設定とは別です。 |
| `regenerate_coordinates` | クロール後に座標生成を実行します。再処理では、おしながき処理をせず座標だけを行う用途にも使えます。 |
| `backup` | 実行前に選択イベントの既存出力をプロジェクトの `.local/crawl-backups/` 配下へ複製します。イベント一覧の探索対象である `events/` 配下には作成しません。 |
| `days_before` / `days_after` | 開催日の前後のX検索範囲です。通常実行では開催日が必須、再処理では保存済み開催日を利用できます。 |
| `cookie_file` | 明示選択したNetscape Cookieファイルをサイト取得へ渡します。X用認証への利用可否はdomainと `auth_token` / `ct0` の組み合わせを別途検証します。 |
| `verbose` | 詳細ログの出力だけを切り替えます。 |

実行前計画は有効なstage（通常実行のサイト解析、Xおしながき、サークル画像、座標、再処理の保存済みおしながき/Xまたは座標）へ展開されます。再処理では `collect_catalogs=true` のときだけ保存済みおしながき（`enable_twitter_catalog=false` なら明示URLのみ）をstageに追加し、`regenerate_coordinates=true` なら座標stageを追加します。有効なstageが1つもない（再処理で `collect_catalogs=false` かつ `regenerate_coordinates=false`）場合は、実行対象がないため停止します。日数は0以上3650以下の整数、通常実行の開催日は実在する `YYYY-MM-DD` です。

## CookieのX routing

明示した `cookie_file` はbridgeでプロジェクトルート基準に検証し、実行設定へ渡します。Twitter/X側の認証Cookieは、Netscape形式のうち `x.com` / `twitter.com` ドメインにある `auth_token` と `ct0` の組だけを使います。

- 明示ファイルに両方があれば、そのファイルを優先します。
- 明示ファイルがサイト用CookieだけでX認証情報を含まない場合は、`<project-root>/cookies/*.txt` の自動検出へ切り替えます。
- 明示ファイルにX用ドメインとCookie名はあるのに片方だけ欠ける場合は、選択ミスとして明示エラーにし、自動検出で別アカウントへ黙って切り替えません。
- 明示ファイルがない場合も、`<project-root>/cookies/*.txt` からX用の完全な組だけを検出します。

Cookie本文・値・選択ファイルの絶対パスは画面表示、プリセット、localStorage、通常ログ、bridge診断へ保存・出力しません。Cookie routingはX認証の経路であり、サイト取得へ渡すCookieのdomain判定とは分離しています。

## 出力先

画面の「出力先フォルダ」は読み取り専用です。実行時の書き込み先は任意入力欄ではなく、現在選択しているイベントのディレクトリ（`event.json` の所有ディレクトリ）に固定されます。ソース統合時も最終出力はこのイベントディレクトリです。イベント未選択、または選択イベントと `event.json` の所有者が一致しない場合は実行を中止します。

バックエンドは出力ディレクトリ単位の排他ロックを取得し、同時実行を拒否します。`backup=true` のバックアップはイベント一覧の探索対象外となるプロジェクトの `.local/crawl-backups/` 配下へ、イベント名と時刻を含む一意なディレクトリとして作成されます。`events/` 配下の兄弟ディレクトリには作成しません。

## 4つのモデル役割とプリセット

モデル設定は次の4役割を持ち、各役割に主モデル・effort・必要に応じたフォールバックを指定します。

- テキスト解析（`text`）
- サイト構造解析（`site_structure`）
- おしながき解析（`oshinagaki_post`）
- 画像処理（`vision`）

実行開始時に、今回有効な役割だけをpreflightします。おしながき取得を無効にした場合は、画像・おしながき役割を不要として扱います。保存済み設定のモデル候補が現在のカタログにない場合は、実行前に確認が必要です。

モデル設定プリセットはブラウザの `localStorage`（キー `eventtrail-crawl-presets-v1`）に保存するUI補助です。4役割それぞれのprovider・主モデル・effort・フォールバック設定だけを対象とし、イベントソース、URL、共通/個別プロンプト、収集オプション、再処理・バックアップ・日数などのイベント実行設定は保存・適用しません。同名保存は上書き、別名は追加です。読込は明示操作でモデル設定へ適用します。秘密値やCookieはプリセットへ保存しません。

## 保存の優先順位

同じ項目を復元するときの基本順序は次のとおりです。

1. 選択イベントのメタデータ（`event_sources`、`crawl_settings` など）
2. プロジェクトの `config.yaml`
3. プロジェクトYAMLが読めない場合だけ、ブラウザフォームのlocalStorage
4. アプリ既定値

画面変更はイベント単位のメタデータへデバウンス保存され、実行・イベント切替・終了の前には保留中の保存をflushします。入力を空にした既知項目は削除として扱います。プロジェクト設定の保存はbridgeの `save_crawl_project_config` が行い、既存YAMLと入力YAMLを `safe_load` して辞書としてdeep mergeし、atomic writeします。未知のtop-level/nestedキーは保持し、mapping同士は再帰マージします。入力で明示した配列・scalarは置換され、空mapping `{}` も明示的なクリアとして置換されます。画面のURL・`event_sources`・`map_urls` を空にして保存した場合は、それぞれ `url: ""`、`urls: []`、`event_sources: []`、`map_urls: []` を明示してクリアします。保存応答はstatusだけで、YAML内容や資格情報を返しません。

## Grok検索方式

### API

`use_grok_search=true`、`grok_search_mode=api` を指定します。xAI APIキーは環境変数 `XAI_API_KEY` から読み、画面のprobeは設定済みかどうかだけを返します。キーの値はpayload、ログ、画面へ返しません。明示modeではAPI失敗時にBuildやBotへ自動切替しません。

### Grok Build

`grok_search_mode=build` を指定します。xAI APIではなく、ログイン済みのローカル `grok` CLIを使います。実行ファイルは `GROK_BIN`、PATH、またはユーザーの一般的なCLIインストール位置から解決します。送信前に `grok models` 相当の無課金probeを行い、未インストール・未ログインならその理由を表示して処理を継続します。送信後に結果が不明（タイムアウト等）になったリクエストは二重送信しません。

### Grok Bot（AoiTalk）

BotはxAI APIモデルではなく、AoiTalkのChat gatewayへ委譲する任意依存です。必要な場合だけ、次のような一般化した設定を用意します（実際のIDやパス、秘密値は環境側で管理してください）。

```yaml
use_grok_search: true
grok_search_mode: bot
grok_bot_chat:
  enabled: true
  target_identity: "<bot-identity>"
  owners:
    "<owner-id>": "<binding>"
grok_bot_root: "<AoiTalk-project-root>"   # 省略時は環境既定
grok_bot_owner_id: "<owner-id>"            # ownersから解決する場合は省略可
grok_bot_chat_id: "event-autopin-twitter"  # 任意
grok_bot_python: "<python-executable>"     # 任意
grok_bot_timeout: 900                       # 任意（秒）
grok_search_run_id: "<run-id>"              # 任意（再実行の冪等キー）
```

実行時にはAoiTalk側のBot chat設定と、`src/llm/grok_bot_client.py` / `src/services/grok_bot_chat_service.py` に相当するoptional runtimeが必要です。環境変数 `AOITALK_ROOT` でもAoiTalkルートを指定できます。probeは設定・依存コード・ローカルstatusの確認に留まり、秘密ファイルの中身を読みません。

Botは今回ユーザーが実際には使用しない前提のため、Bot固有の実送信・会話・外部サービス接続の検証は行っていません。Bot機能の実運用可否は、AoiTalk側の設定・認証・runtimeを用意した環境で別途確認してください。
