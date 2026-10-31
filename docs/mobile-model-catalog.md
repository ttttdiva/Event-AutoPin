# モバイルモデルカタログ

この文書は、`shopping-app/` が利用するAPIモデルカタログと、モデル選択を実行経路へ渡す契約を定義する。現在の固定6件リストを正本にせず、providerのread-onlyモデル一覧を候補の根拠にする。デスクトップのCLI候補・Anthropic API候補・`config.yaml` roleはこの文書の対象外であり、デスクトップ側は [LLM provider roles](provider-roles.md) に従う。

## 対応providerと一覧取得

モバイルで動的カタログを取得するproviderは従来どおり次の3つだけである。今回、モバイルにAnthropic providerを追加しない。

| provider | read-only endpoint | 認証 | 取得時の扱い |
| --- | --- | --- | --- |
| OpenAI | `GET https://api.openai.com/v1/models` | `Authorization: Bearer <key>` | 一覧に現れた新しいIDを、個別の固定whitelistにないだけで捨てない。`/v1/models`が能力やeffortを保証しないため、画像入力・reasoning effortは`unknown`のまま明示する。embedding、audio/transcription、moderation、image-generationなど既知の専用モデルはtext/vision候補に混ぜない |
| Gemini | `GET https://generativelanguage.googleapis.com/v1beta/models` | `x-goog-api-key: <key>` | `nextPageToken`を使って全ページを読む。`supportedGenerationMethods`に`generateContent`があるものを生成候補とし、画像入力の広告がなければ能力を推測しない |
| xAI | `GET https://api.x.ai/v1/language-models` | `Authorization: Bearer <key>` | `input_modalities`/`output_modalities`を読み、text/image能力を広告している場合だけ確認済みとする。広告がないIDは`unknown`のまま残す |

一覧取得はmetadata readだけであり、completion probeや画像を送る疎通試験を行わない。HTTP応答本文、APIキー、アカウント名をモデル候補・ログ・cacheへ保存しない。APIキーは既存のSecureStore経路から読み、一覧取得のためだけに一時利用する。

## 状態と表示

providerごとに、候補配列とは別に取得状態を持つ。設定画面では、候補の有無だけでなく状態と取得時刻を表示する。

| 状態 | 表示例 | 選択値への影響 |
| --- | --- | --- |
| `idle` | 未取得（初期候補を表示） | 初期seedを候補として表示するが、API取得済みとは表示しない |
| `loading` | 取得中… | 更新中も保存済み選択を消さない |
| `credential-missing` | 認証情報未設定 | そのproviderのAPI取得は行わず、seedと保存済み選択だけを表示する |
| `ready` | 取得済み（件数・取得時刻） | `provider:id`単位で候補を表示する |
| `error`（`stale=false`） | 取得失敗 | 失敗を可視化し、取得失敗をlive候補とは扱わない |
| `error`（`stale=true`） | 取得失敗・前回候補を表示中 | メモリ上の直前候補を`stale-cache`として残すが、現在のlive取得済みとは表示しない |

候補にも出所を付ける。`provider-api`は今回の一覧取得、`stale-cache`は更新失敗時の前回取得、`saved`は保存設定を消さないために補った候補、`seed`は未取得時の互換初期候補である。能力が`unknown`のAPI候補は「API取得・能力未確認」と表示し、確認済みと同じラベルにしない。提供終了や既知の専用モデルは候補から除外するか、非対応状態として表示する。

更新失敗時にも保存済みのmodel ID・provider・effortを自動変更しない。動的一覧にない保存値を別providerへ差し替えたり、より高額なモデルへ昇格させたりしない。

## 保存形式と旧設定の互換性

APIキーは`expo-secure-store`の既存ルート（`apikey_openai`、`apikey_gemini`、`apikey_xai`）へ保存し、モデル一覧やログにはキーの値を保存しない。モデルIDとeffortは既存のSQLite `app_settings`へ保存する。

モデル選択はIDだけでなく、次の組を保存する。

```ts
type SavedModelSelection = {
  id: string;
  apiType: "openai" | "gemini" | "xai";
};
```

主・予備・画像・サイト構造の各選択には、model ID用キーとは別にprovider用キーを持たせる。例えば主モデルは`llm_primary_model`と`llm_primary_model_provider`、画像モデルは`llm_vision_model`と`llm_vision_model_provider`を使う。明示保存されたproviderを常に優先し、同じIDが複数providerに存在してもprefixだけでrouteしない。

provider列がない旧string ID設定だけは、読み込み時に互換推測する。

- `gemini`で始まるIDはGemini
- `grok`で始まるIDはxAI
- その他はOpenAI

この推測はprovider列を追加するための移行に限る。明示providerが保存されている場合は、IDのprefixによる再推測を行わない。既存ユーザーのmodel ID、provider、effortを、catalogのseed追加や更新を理由に書き換えない。

### Grok検索モデル

Xのおしながき検索と、XポストURLの再処理で使うGrok検索モデルは、通常の主・予備・vision・site parsingとは独立した選択である。保存キーは`llm_grok_search_model`で、Grok検索roleのproviderはxAIに固定するため、同キーにprovider列を追加せず、読み出し結果を`{ id, apiType: "xai" }`として扱う。設定画面のpickerは動的xAI catalogだけを候補にし、選択した`provider:id`を保持する。

旧バージョンで`llm_grok_search_model`が未保存の場合は、互換表示として`grok-2-latest`をxAIの保存候補として返す。この暗黙値は旧設定を壊さないためのsaved候補であり、APIから取得したlive ID、現在も提供されること、画像/検索能力を意味しない。画面には「保存済み（一覧未確認）」として表示し、xAIの一覧取得後に同じ`provider:id`がliveで確認できた場合だけ取得済み表示へ変わる。別providerへのprefix推測や、自動的な新モデルへの置換は行わない。実行時はこの選択を`LlmClient`へxAI provider付きで渡し、request codeに固定した`grok-2-latest`を直接使わない。

## 選択・能力・effort

モデルpickerは`provider:id`で重複排除し、text/vision roleごとに候補を絞る。Grok検索roleを開いた場合はxAI providerだけに絞る。API一覧に新しいIDが現れた場合も、能力whitelistに登録されていないだけなら候補から削除しない。

- text/image能力が`verified`なら、対応roleで確認済み候補として表示する。
- 能力が`unknown`なら、明示選択を許可するが、能力未確認の警告を表示する。選択しただけで成功や画像対応を保証しない。
- `unsupported`、提供終了、認証不足など実行できないことが分かる状態は、選択不可または実行時エラーとして区別する。
- OpenAI `/v1/models`がreasoning effortを広告しないID、またはproviderがeffortを広告しないIDへ、既知モデル由来の`medium`/`high`などを推測して表示・送信しない。
- unknown model/effortでは`none`をAPI既定（effortフィールドを省略）として扱う。保存済みのeffortをUI上で勝手に高額モデル向けへ変更しない。

設定画面のeffort選択肢と候補ラベルは「確認済み」「能力未確認」「未取得」「前回取得（更新失敗）」を区別する。未取得や更新失敗でも、保存済み選択を失わせない。

## 実行時のdispatch

実行側へは、IDだけでなく保存済みproviderを含むモデル設定を渡す。文字列IDだけを受け付ける旧呼び出しでは上記の互換inferを使うが、`{ id, apiType }`が渡された場合は明示providerを優先する。

`LlmClient`のprovider別経路は次の契約とする。

| provider | text | image |
| --- | --- | --- |
| OpenAI | 現行モデル（Luna等のResponses対応モデルを含む）は`POST /v1/responses` | 同じResponses APIへ`input_image`を含めて送る。既知の旧Chat Completions専用IDだけは従来endpointを使う |
| Gemini | `models/{id}:generateContent` | 同じ`generateContent`へinline imageを含めて送る |
| xAI | `POST https://api.x.ai/v1/chat/completions` | 同じxAI endpointの画像content blockを使う。OpenAI endpointへ誤routeしない |

最終requestへ送るeffortは、対象provider/modelで確認できた値だけにする。`none`またはunknownの場合はreasoning/effortフィールドを省略してAPI既定へ委ねる。モデルIDのprefixからproviderやeffortを再推測して、別providerの設定値を転送しない。

## 更新のタイミング

- 設定画面を開き、既存設定とSecureStoreのキーを復元した後に全providerを自動取得する。
- 「モデル一覧を再取得」は全providerを読み取り更新し、更新中状態を表示する。
- APIキーの保存後は、そのproviderの一覧を再取得する。キー値は一覧状態やログへ残さない。
- providerごとの取得は独立しており、一つの未設定・失敗で他providerの候補や保存選択を消さない。

## 検証範囲

catalogのユニット/mock検証では、ページング、認証未設定、HTTP失敗、stale候補、provider+ID保存、能力unknown、effort省略、endpoint dispatchを確認する。mockで一覧が読めたことを、実APIの受入・現在の認証状態・画像精度・Android実機動作の成功とは混同しない。実API受入や精度比較は別の診断結果として記録する。
