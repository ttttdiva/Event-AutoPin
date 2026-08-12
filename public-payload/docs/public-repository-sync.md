# 公開リポジトリ同期

`scripts/sync_public_repo.ps1` は、開発リポジトリの **HEADにcommit済み** かつ `scripts/public-sync-manifest.txt` に完全一致するファイルだけを、公開リポジトリの `public-payload/` へ同期します。untrackedファイルやmanifest外ファイルは候補になりません。

## 安全ゲート

- 公開先は既存Git working treeで、`origin` が `https://github.com/ttttdiva/autocircle.git` と完全一致すること。
- `gh api repos/ttttdiva/autocircle --jq .visibility` が `public` を返すこと。
- 公開先working treeがcleanであること。
- 入出力は同一pathや相互の配下でないこと。
- manifest pathは相対安全pathで、すべてHEADに存在すること。
- `git archive HEAD` でmanifestファイルだけを新規一時stagingへ展開すること。
- binary/credentialファイル名、NULを含むbinary、ホームpath、個人名、API key、token、private keyをscanし、1件でも検出すればfail closedすること。

同期対象は `public-payload/` だけです。`.git`、`.github/`、`README.md`、`LICENSE`、`latest.json`、`release/`、`releases/` など公開先所有ファイルをrootから削除・上書きしません。適用時は次payloadを別directoryへ作成してhash確認後にswapし、swap後もhash確認します。失敗時は旧payloadへrollbackします。

## 実行

必ず先にdry-runし、`[candidates]`、`[excluded]`、`[scan]`、`[diff]` を確認します。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sync_public_repo.ps1 `
  -SourceRoot D:\Dev\40_caico-list-gen -DestinationRoot D:\Dev\caico-public
```

scanが0件で差分が意図どおりの場合だけ適用します。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sync_public_repo.ps1 `
  -SourceRoot D:\Dev\40_caico-list-gen -DestinationRoot D:\Dev\caico-public -Apply
```

このscriptはcommit、push、Release upload、`latest.json` 更新をしません。適用後は公開先で `git status --short --branch` と `git diff` を確認し、`docs/release-checklist.md` に従います。

## テスト

```powershell
venv\Scripts\python.exe -m pytest tests/unit/test_sync_public_repo_script.py -q
```
