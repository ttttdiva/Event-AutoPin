# 公開リポジトリ同期

`scripts/sync_public_repo.ps1` は、開発リポジトリの **HEADにcommit済み** かつ `scripts/public-sync-manifest.txt` に完全一致するファイルだけを、公開リポジトリの `public-payload/` へ同期します。untrackedファイルやmanifest外ファイルは候補になりません。

## 安全ゲート

- 公開先は既存Git working treeで、`origin` が `https://github.com/ttttdiva/Event-AutoPin-Publish.git` と完全一致すること。
- `gh api repos/ttttdiva/Event-AutoPin-Publish --jq .visibility` が `public` を返すこと。
- 公開先working treeがcleanであること。
- `origin` を `fetch --prune` した後、現在branchがremoteのdefault branchと一致し、そのupstreamが対応する `origin/<default>` で、local `HEAD` がfetch済みの同refと完全一致すること。detached HEAD、未push commit、未pull commitでは停止します。
- 入出力は同一pathや相互の配下でないこと。
- manifest pathは相対安全pathで、すべてHEADに存在すること。
- `git archive HEAD` でmanifestファイルだけを新規一時stagingへ展開すること。
- binary/credentialファイル名、NULを含むbinary、任意driveのWindows絶対path、ホームpath、個人名、API key、token、password/session/cookie等のcredential代入、database URL、private keyをscanし、1件でも検出すればfail closedすること。

画像asset（`.png`、`.jpg`、`.jpeg`、`.gif`、`.webp`、`.ico`、`.icns`）は通常のmanifest pathでは公開できません。内容をreviewしたうえで、commit対象と同じbyte列のSHA-256を固定した次の形式だけを使用します。hash不一致、拡張子とsignatureの不一致、画像以外へのhash指定はfail closedします。

```text
sha256:<64桁のSHA-256> relative/path/to/asset.png
```

既存の1行1path形式はそのまま利用できます。hash固定行も含め、同一pathを複数回指定できません。

現在のTauri `icon.icns` はsuffixと異なりPNG signatureの既知assetです。この1ファイルを改名・変換せず同期できるよう、`.icns` は正規ICNSまたはPNG signatureを許可しますが、いずれもmanifestのexact SHA-256一致が必須です。

同期対象は `public-payload/` だけです。`.git`、`.github/`、`README.md`、`LICENSE`、`latest.json`、`release/`、`releases/` など公開先所有ファイルをrootから削除・上書きしません。適用時は次payloadを別directoryへ作成してhash確認後にswapし、swap後もhash確認します。失敗時は旧payloadへrollbackします。

## 実行

必ず先にdry-runし、`[candidates]`、`[excluded]`、`[scan]`、`[diff]` を確認します。

```powershell
$SourceRoot = (Resolve-Path .).Path
# 現在の既存checkout。改名時は末尾を Event-AutoPin-Publish に置き換える。
# ドライブ文字はscanに誤検出されないよう分割して記述している。
$DestinationRoot = ('D:' + '\Dev\Event-AutoPin-Publish')
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sync_public_repo.ps1 `
  -SourceRoot $SourceRoot -DestinationRoot $DestinationRoot
```

scanが0件で差分が意図どおりの場合だけ適用します。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sync_public_repo.ps1 `
  -SourceRoot $SourceRoot -DestinationRoot $DestinationRoot -Apply
```

このscriptはcommit、push、Release upload、`latest.json` 更新をしません。適用後は公開先で `git status --short --branch` と `git diff` を確認し、`docs/release-checklist.md` に従います。

## テスト

```powershell
venv\Scripts\python.exe -m pytest tests/unit/test_sync_public_repo_script.py -q
```
