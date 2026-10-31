# 投稿本文・複数画像の同時おしながき解析

## 処理単位と適用範囲

おしながき解析の単位はX投稿1件である。候補投稿の本文、添付画像の全枚数、対象イベント名・開催日・追加コンテキストを一つのjoint入力として扱う。画像付き投稿を本文だけの「予告」判定で打ち切らず、本文だけの投稿も同じrole・分類・抽出・検証を使う。候補modelは固定リストを正本にせず、デスクトップの実行直前model catalogで更新する。API一覧はmetadata read専用であり、completion probeを行わない。

次の3経路は同じ`oshinagaki_post`候補列を使う。

- 通常収集（twscrapeで得た候補投稿）
- URL指定の再処理
- 添付画像のない本文のみの投稿

`oshinagaki_post` roleが保存されていない旧設定では、既存のimage主候補・予備候補を使う互換経路を残す。roleが保存されている場合は、本文だけの投稿をtext roleへ、画像付き投稿をvision roleへ切り替えない。

## 設定と既定値

roleは主候補と予備候補を同じブロックで保持する。例えば次のように保存する。

```yaml
oshinagaki_post:
  provider: "api:openai"
  model: "gpt-5.6-luna"
  effort: "max"
  fallback_enabled: true
  fallback_provider: "cli:grok"
  fallback_model: "grok-4.7"
  fallback_effort: "none"
```

postの主既定はOpenAI API `gpt-5.6-luna` / `max`。postのfallback項目を省略したroleは、既存のimage fallback provider/model/effortと`image_fallback_llm_enabled`を継承する。したがって、image fallbackを明示的に無効化した設定ではpostにも予備を作らない。role自体がない旧設定も既存image主・予備互換を使う。backend側でGrok fallbackのeffortが`medium`として残る旧設定は、GUIでGrok対応値の`none`へ正規化する。

主候補と同じprovider・modelを予備に指定した場合は重複を除去するだけで、未選択のGrok、Codex、OpenAI Solなどを自動注入しない。異なる候補を複数指定した場合は、保存された順序をそのまま試す。GUIで候補が対応しないeffortを読み込んだ場合は、その候補が対応する値へ正規化し、provider/modelは変更しない。

動的catalogで新しいIDが見つかっても、保存済みのprovider/model/effortを別候補へ置き換えない。OpenAI `/v1/models`などが能力やeffortを広告しないIDは`unknown`として表示し、明示選択と警告を許可する。未知のeffortはAPI既定に委ね、最終requestへ`medium`等を自動注入しない。既知の専用モデルや提供終了モデルは`unsupported`/`retired`として選択対象から除外する。各providerのendpoint、`saved`/`stale-cache`/liveの区別、秘密情報の扱いは [LLM provider roles のAPI model catalog](provider-roles.md#api-model-catalog) に従う。

## 候補選択とpreflight

API候補とGrok Build CLI候補は、本文+全画像を同時に送れる場合にpost jointで使用できる。初期設定の復元後、手動refresh、APIキー保存後、post実行直前にcatalogを更新する。APIのlive一覧にある新しいIDは、個別能力whitelistにないだけでは削除しない。本文または画像能力が`unknown`のlive API候補は、能力未確認の警告を表示したうえで明示選択できるが、成功を保証しない。主候補の既知非対応、提供終了、認証情報未設定、権限エラーは開始前に停止する。fallbackだけの不備は、そのfallbackだけを実行時候補から除外して警告し、主候補によるjoint解析を継続する。保存設定は変更しない。

保存済み（`saved`）や更新失敗時の前回候補（`stale-cache`）は、選択値を保持するために一覧へ残すことがある。ただし現在のlive API取得済みとは表示しない。catalog全体の取得失敗や認証状態不明も「認証済み」とは扱わず、実行前に原因を表示する。CLIは既存のlive/cache取得結果だけを使い、根拠のない新IDを作らない。

postの最終requestは、選択providerに対応する正確な経路を使う。OpenAIの現行テキスト/画像モデル（Lunaを含む）はResponses APIへ、xAIのテキスト/画像モデルはxAIの対応chat/completions endpointへ送る。providerをmodel IDのprefixだけで推測せず、保存されたproviderを優先する。APIが受け付けるeffortを確認できない場合はeffortフィールドを省略してAPI既定へ委ねる。

URL指定再処理では、指定された候補順を守る。APIをCLIより優先するためのsortや、画像があるからvision候補へ並べ替える処理は行わない。

preflightは今回使うpost roleと候補だけを対象にし、認証・能力情報を実行直前に再取得する。未使用roleや未使用fallbackの認証不足で処理全体を止めない。表示された認証状態はその時点の観測であり、過去の日付の未認証記録から現在のPC状態を断定しない。

## 入力・画像の扱い

全画像を一時ディレクトリへ取得し、全画像が揃ってからモデルを呼ぶ。1枚でも取得できない場合は、取得できた画像だけで成功にせずエラーにする。画像の送信前リサイズ・合成・再エンコードは行わず、元画像を個別の`input_image`として本文と同時に送信する。OpenAI画像入力には`detail=high`を指定する。MIMEは拡張子でなく画像の実体から判定する。投稿あたりの元画像合計は32 MiBまでとし、超過時は画像を一部省略せずエラーにする。

モデル応答を検証し、全検証が成功してから画像と商品を反映する。取得・解析・期限切れの失敗では既存商品・メモ・画像参照を変更しない。通常収集の失敗では既読投稿IDも元に戻す。複数画像のファイル公開途中に障害が起きて未参照ファイルが残ることはあるが、既存の参照先は削除しない。

## 応答検証と候補遷移

正常な応答は1回で確定する。不正JSON、画像番号の不整合、価格と根拠表記の不一致、重複商品の価格矛盾、モデルの要再確認判定がある場合だけ、同じ本文・全画像で修正要求を一度だけ行う。それでも解消しない不正JSON・検証失敗は、保存順の次候補へ進む。一般的なAPI通信失敗、timeout、HTTP 429も同じく次候補へ進み、同一モデルで盲目的に検証再試行しない。SDK自体の通信再試行は候補遷移とは別である。

Grok Buildのキャンセル、`unknown_delivery`（送信後に応答を受け取れない）、共有の期限切れは後続候補へ再送しない。該当分類を保持して候補chainを停止する。Grok CLI内部で同じpromptを再試行しない。

価格の未記載は`price=0` / `price_basis=not_shown`、明記された無料は`price=0` / `price_basis=free_explicit`として区別する。金額を推測しない。本文の明示的な無料への訂正も、旧価格が正の値だからという理由で無視しない。整数の円表記、共通価格、全角数字、カンマ、万円・千円表記の整合性を検証する。

各商品の`catalog_evidence`には、根拠の画像番号・保存画像名、本文の原文引用、価格表記、価格の根拠画像番号（0は本文）、元投稿URL、使用モデルを保持する。モデルが任意の画像パスや購入状態を指定することはできない。単品・セットは`sale_kind`で区別する。同一商品の画像間重複は統合し、異なる商品の価格を混同しない。

## 更新境界・cache

商品更新は選択した確定投稿の一覧で置き換え、同一商品名・種別の購入状態は保持する。旧一覧にしかない商品を無条件に足し戻して、削除・訂正を打ち消さない。

未確定の「予告」は既存商品を消さない。通常収集では他の候補投稿の確定版を優先し、別投稿の画像に最初の候補の本文を組み合わせない。直接再処理のcacheは投稿IDだけでなくイベント・開催日・追加コンテキストで分離し、cache利用時も対象サークルの購入状態を優先する。共有の期限切れ後はcacheも更新しない。

画像ファイル名は内容のhashを含め、同一URLの画像が更新されても以前の画像を上書きしない。

## 互換性と対象外

保存済みのCLI選択は勝手に書き換えない。`skip_catalog_image_analysis`を指定した処理は従来経路を維持する。画像ファイル単独の既存解析API、Grok検索経路、モバイル独自のクロール実装は今回のpost joint契約の対象外である。

本文による候補投稿の収集・優先順位付け自体は既存処理を使う。すべてのX投稿を無条件に画像解析する変更ではない。一般的な小文字の誤読や実際の精度向上を、形式検証だけで保証するものでもない。

## 回帰テスト

```sh
python -m pytest tests/unit/test_catalog_post_joint.py -q
cd desktop-app
npm run test:runtime
```

PythonのテストはAPI・Xをモックし、投稿本文・全画像・reasoning設定、候補順、価格根拠、重複、イベント不一致、cache、購入状態、取得失敗、遅延応答、期限切れ、Grokの停止分類を検証する。デスクトップのruntimeテストには同時解析の進捗表示と別runのログ混入防止を含める。実renderer QAの範囲はrole選択、fallbackなしのcheckbox、今回の実行計画、予備除外の警告表示などUI境界に限る。

これらはオフラインの回帰確認であり、実APIを使った正解データとの精度比較、現在のprovider認証、実API受入、Windows/Android実機の動作確認を成功扱いするものではない。
