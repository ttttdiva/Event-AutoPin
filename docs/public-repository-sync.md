# 公開リポジトリ同期

`scripts/sync_public_repo.ps1` は、開発リポジトリの **HEADにcommit済み** かつ `scripts/public-sync-manifest.txt` に完全一致するファイルだけを、公開リポジトリのrootへ同期します。untrackedファイルやmanifest外ファイルは候補になりません。

## 安全ゲート

- 公開先は既存Git working treeで、`origin` のfetch/push URLがともに `https://github.com/ttttdiva/Event-AutoPin.git` と完全一致すること。
- `gh api repos/ttttdiva/Event-AutoPin --jq .visibility` が `public` を返すこと。
- 公開先working treeがcleanであること。
- `origin` を `fetch --prune` した後、現在branchがremoteのdefault branchと一致し、そのupstreamが対応する `origin/<default>` で、local `HEAD` がfetch済みの同refと完全一致すること。detached HEAD、未push commit、未pull commitでは停止します。
- 入出力は同一pathや相互の配下でないこと。
- manifest pathは相対安全pathで、すべてHEADに存在すること。`.git`、`.github`、`latest.json`、`release/`、`releases/`、`public-payload/` と同期用一時pathはmanifestに指定できません。
- `git archive HEAD` でmanifestファイルだけを新規一時stagingへ展開すること。
- binary/credentialファイル名、NULを含むbinary、任意driveのWindows絶対path、ホームpath、個人名、API key、token、password/session/cookie等のcredential代入、database URL、private keyをscanし、1件でも検出すればfail closedすること。

画像asset（`.png`、`.jpg`、`.jpeg`、`.gif`、`.webp`、`.ico`、`.icns`）は通常のmanifest pathでは公開できません。内容をreviewしたうえで、commit対象と同じbyte列のSHA-256を固定した次の形式だけを使用します。hash不一致、拡張子とsignatureの不一致、画像以外へのhash指定はfail closedします。

```text
sha256:<64桁のSHA-256> relative/path/to/asset.png
```

既存の1行1path形式はそのまま利用できます。hash固定行も含め、同一pathを複数回指定できません。

現在のTauri `icon.icns` はsuffixと異なりPNG signatureの既知assetです。この1ファイルを改名・変換せず同期できるよう、`.icns` は正規ICNSまたはPNG signatureを許可しますが、いずれもmanifestのexact SHA-256一致が必須です。

同期対象はmanifestに記載したroot配下のファイルだけです。`.git`、`.github/`、`latest.json`、`release/`、`releases/` は常に公開先所有として削除・上書きしません。`README.md` や `LICENSE` はmanifestに明示した場合だけ同期します。

適用時は次treeを別directoryへ作成してhash確認し、旧manifestと新manifestの対象ファイルだけをbackupしてからrootへ設置します。設置後もexact hash、旧管理ファイルの削除、`.git` と `latest.json` の維持を確認し、失敗時はbackupからrollbackします。旧形式の `public-payload/` がある初回移行では、同directoryのcommit済みmanifestとtracked fileが完全一致する場合だけrootへ移行し、検証後に旧directoryを削除します。

## 実行

必ず先にdry-runし、`[candidates]`、`[excluded]`、`[scan]`、`[diff]` を確認します。

```powershell
$SourceRoot = (Resolve-Path .).Path
# 公開リポジトリの既存checkout。
# ドライブ文字はscanに誤検出されないよう分割して記述している。
$DestinationRoot = ('D:' + '\Publish\Event-AutoPin')
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
