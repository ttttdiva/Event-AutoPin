# tests/

Pythonバックエンド（`src/`）のユニットテスト。

## 実行

```bash
# venv有効化後
pytest tests/ -v
```

## 方針

- **外部APIを叩かない**: OpenAI/Gemini/xAI への実呼び出しは一切行わない。LLMに依存する処理は対象外。
- **純粋ロジック・I/O最小**: date処理、JSON整形、ファイル読み書き、コマンド組立など、外部依存の少ない部分を中心に網羅。
- **tmp_path fixture使用**: ファイルI/Oは必ず `tmp_path` fixtureで隔離し、リポジトリを汚染しない。
- **`return True/False` 禁止**: 必ず `assert` で検証。

## 構成

```
tests/
  conftest.py            # プロジェクトルートをsys.pathに追加
  fixtures/              # テスト用固定データ（今後追加予定）
  unit/
    test_date_utils.py       # 日付整形（6件）
    test_desktop_bridge.py   # Tauri橋渡し（78件）
    test_circle_master.py    # circle_master.json管理（19件）
    test_json_formatter.py   # event.json整形（12件）
```

2026-10-26のrole経路修正前に完了した全件実行は **847 passed**。最終role/diagnostic修正後のfocused Python testsは **99 passed**。最新の全件再実行はPlaywrightの`test_help_escape_consumes_document_event_before_map_shortcut`でViteページの`DOMContentLoaded` timeoutとなり、全件結果は未完了扱い。テスト追加時は記録を実測に合わせて更新する。

## テスト対象外

次のLLM関連テストは固定fixture/mockを使い、外部APIを呼び出さない。

- `test_grok_build.py` — Grok Build ACPの認証選択、画像content block、rate-limit、timeout/cancel/unknown-deliveryと応答不明後の送信停止
- `test_llm_provider_routing.py` — xAI/Anthropic API endpoint dispatch、Anthropic画像payload、Grokの応答不明後にfallbackしないこと
- `test_site_parsing_llm.py` / `test_site_structure_role.py` — site_structure role選択とknown/unknownサイトの呼出し経路

以下は引き続きテストなし（理由あり）:

- `src/adapters/*` — 実サイトHTMLへの依存が大きく、フィクスチャ整備が重い
- `src/utils/llm_client.py` の実API応答 — 実APIに依存。transport/payloadはfixtureで検証
- `src/processors/twitter_post_processor.py` — Twitter API + LLM依存
- `src/utils/catalog_image_analyzer.py` 等 画像処理 — LLM依存

これらを追加する場合は、事前にHTMLフィクスチャを `tests/fixtures/` に固定するか、LLMクライアントを完全にmockする設計を選ぶこと。
