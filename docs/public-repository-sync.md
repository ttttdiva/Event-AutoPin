# 公開リポジトリ同期

`scripts/sync_public_repo.ps1` は、開発リポジトリの **HEADにcommit済み** かつ `scripts/public-sync-manifest.txt` に完全一致するファイルだけを、公開リポジトリのrootへ同期します。untrackedファイルやmanifest外ファイルは候補になりません。

## 安全ゲート

- 公開先は既存Git working treeで、`origin` のfetch/push URLがともに `https://github.com/ttttdiva/Event-AutoPin.git` と完全一致すること。
- `gh api repos/ttttdiva/Event-AutoPin --jq .visibility` が `public` を返すこと。
- 公開先working treeがcleanであること。
- `origin` を `fetch --prune` した後、現在branchがremoteのdefault branchと一致し、そのupstreamが対応する `origin/<default>` で、local `HEAD` がfetch済みの同refと完全一致すること。detached HEAD、未push commit、未pull commitでは停止します。
- 入出力は同一pathや相互の配下でないこと。
- manifest pathは相対安全pathで、すべてHEADに存在すること。`.git`、`.github`、`latest.json`、`release/`、`releases/`、`public-payload/` と同期用一時pathはmanifestに指定できません。
- `scripts/check_public_dependency_closure.py` がHEADのmanifestを起点に、TypeScript/JavaScriptのrelative import・`@/` alias・`require`・`export ... from`・local dynamic import、Pythonのrelative importとrepository絶対import（packageの`__init__.py`を含む）、`app.json` のlocal Expo plugin、packageのtest/build/typecheck script、明示test runnerを再帰検査します。Pythonのstdlib/external importは、同じHEADのtracked Python pathにlocal module候補がない場合だけ除外します。local dependencyが未解決、複数解決、未commit、manifest外、または安全に解釈できないcomputed loadなら同期前にfail closedします。
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

必ず先にdry-runし、`[dependency-closure]`、`[candidates]`、`[excluded]`、`[scan]`、`[diff]` を確認します。dependency検査もworking treeではなくHEADを読み、uncommitted fileで欠落を隠せません。

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

## CI

Private側 `.github/workflows/private-public-sync.yml` は最小権限 `contents: read` で次を実行します。

1. dependency closure checkerとfocused Python tests
2. 認証情報を永続化しないPublic checkoutに対するPrivate→Public dry-run（secret scanとexact diffを含む）
3. `scripts/check_desktop_release_gate.ps1 -FailOnMismatch` によるPrivate/Public desktop source、3箇所のversion、`desktop-v<version>` の `EventAutoPin.exe`、`latest.json.desktop` の一致確認

`.github/workflows/public-source-build.yml` はPrivate sourceをcheckoutせず、Public repositoryだけを匿名取得します。Private secretを環境変数へ渡さず、PublicのPythonについてrequirements install、dependency closure、compile、公開manifest内のpytest suiteを実行します。Private側だけに保持するcanonical OCR reference reportを直接読む1 assertionだけはnode IDで明示除外し、それ以外の公開Python testsを実行します。desktopについてTypeScript/test/Vite/Tauri debug buildを、shopping appについてTypeScript/test/Expo prebuild/Gradle debug APK buildを行います。どちらのworkflowもSHA固定action、最小permissions、concurrency cancelを使用し、commit・push・Release upload・metadata更新は行いません。

`.github/` は公開同期scriptの保護対象なので、manifest同期ではPublic側workflowを新規作成・更新できません。初回導入時とworkflow変更時は、Private側の `.github/workflows/public-source-build.yml` だけを内容review後にPublic checkoutへ別作業・別commitでcopyし、Public側の差分とGitHub Actions実行結果を確認してください。`.github/` をmanifest管理可能に変更する、Public workflowからPrivate repositoryをcheckoutする、またはPrivate用credential/secretsをPublic workflowへ設定・受け渡す方法で自動化してはいけません。Public側でこのworkflowがinstall済みであることは、source同期完了とは別の運用ゲートとして確認します。

desktop sourceが変わったのにversion、Release asset、`latest.json`、またはPublic syncが古い場合、strict gateは意図的に失敗します。先にrelease checklistを完了させてからgreenに戻してください。

## テスト

```powershell
python -m pytest tests/unit/test_public_dependency_closure.py tests/unit/test_sync_public_repo_script.py tests/unit/test_desktop_release_gate.py -q
python scripts/check_public_dependency_closure.py --repository . --revision HEAD
```
