# Release Checklist

Event AutoPin の APK、EXE、installer、GitHub Release asset など公開用 artifact を作る merge/release では、この checklist と既存の README、docs、scripts を先に確認する。

## Common Gate

- 作業前と完了前に `git status --short --branch` を確認する。
- 公開リポジトリを使う場合は `ttttdiva/Event-AutoPin` を対象にし、tag・asset・`latest.json` の参照先を一致させる。
- ユーザーが明示的に `releaseなし` / `APK不要` / `upload不要` と言わない限り、公開対象の build、upload、metadata 更新を省略しない。
- version、tag、asset 名、公開先リポジトリ、`latest.json` などの前提が不足している場合は、merge だけ先に進めない。
- 既存の release / publish / build script がある場合は、その script と引数を優先する。

## APK

- `scripts/check_mobile_release_gate.ps1` がある場合は先に実行し、`RELEASE_REQUIRED=True` なら release 対応を完了条件に含める。
- `app.json`、`mobile/app.json`、`android/`、`modules/*/android/` など mobile 関連差分を確認する。
- release version と versionCode を更新する。
- APK / AAB をビルドし、成果物のパスと version を確認する。
- GitHub Release に asset を upload する運用の場合は、公開先と tag を確認して upload する。
- 自動更新を使う場合は、公開用 `latest.json` を同じ version、APK URL、notes、date に更新する。

## EXE / Desktop

デスクトップ機能の変更は通常の実装・修正でも以下の一括リリースを実行する。APKのgateが `RELEASE_REQUIRED=False` でもEXEの判定は別である。

### 一括実行（Windows開発checkout専用）

実装・manifestの変更を先にcommit・pushし、作業ツリーをcleanにする。Git、認証済みGitHub CLI、Node.js、PowerShell 7（`pwsh.exe`）、既存Tauriビルド環境が必要。起動中のEventAutoPinは終了しておく。

```powershell
# 公開予定の版を確認（バージョン変更・build・uploadはしない）
node scripts/release_desktop.cjs --plan
# patch番号を自動で繰り上げ、EXE公開と更新情報の反映まで実行
node scripts/release_desktop.cjs --notes "欠席切替を右クリックへ統合し、欠席中の優先度を低に固定"
# 途中失敗した場合、同じバージョン・同じ成果物で続きを実行
node scripts/release_desktop.cjs --resume
```

既定のPublic checkoutは `('D:' + '\Publish\Event-AutoPin')`。別の既存checkoutを使う場合は `--public-root` を指定し、再開時も同じ値を渡す。この開発側専用スクリプトは公開manifestには含めない。

処理順は、公開済み版も確認したpatch繰り上げ → package.json/package-lock.json/Tauri/Cargo.toml/Cargo.lockの更新と対象限定commit・push → 既存buildスクリプトで型チェック・test・Tauri release build・ルートEXE配置 → manifest検査を伴うPublic同期 → draft ReleaseへのEXE upload・SHA256一致確認・公開 → mobile等を保持したlatest.json.desktop更新・commit・push → strict gate → Public source build CI成功確認。既存assetを上書きしない。新しい公開ソースはmanifestへ明示登録してから実行する。

進行状況は開発checkoutの `.git/desktop-release-state.json` に保存する。build/upload/metadata/CI失敗は非ゼロ終了とし、公開完了扱いにしない。`--resume` は元の開発HEADとEXEのSHA256を照合し、別ソースや別成果物へのすり替わりを防ぐ。再開前にコード変更が必要になった場合は旧リリースの公開状況を確認し、新版としてやり直す。バージョンcommit前やPublic同期commit直後に失敗して未コミット・未pushが残った場合は、示された差分を確認して整理してから再開する。

### 個別の完了条件

- `scripts/check_desktop_release_gate.ps1` をPublic checkoutとともに実行する。`-FailOnMismatch` はPrivate/Publicのdesktop source、`desktop-app/package.json`・`src-tauri/tauri.conf.json`・`src-tauri/Cargo.toml` のversion、`desktop-v<version>`、`EventAutoPin.exe`、`latest.json.desktop` のversion/URLをstrictに検証する。
- desktop sourceに差分がある場合、既存Releaseのversionを使い回さず3箇所のversionを同じ新versionへ更新する。
- desktop build script、Tauri / Electron / PyInstaller / installer 設定を確認する。
- EXE / installer をビルドし、成果物のパス、version、起動可否を確認する。
- GitHub Release や配布先へ upload する運用の場合は、tag、asset 名、公開先を確認して upload する。
- `ttttdiva/Event-AutoPin` の `desktop-v<version>` に `EventAutoPin.exe` が存在し、`latest.json.desktop.version` とURLが同じtag/assetを指すことを確認する。
- Public sync後、strict gateとPublic source build CIがgreenになるまで完了扱いにしない。
- 生成物を開発リポジトリに残す必要がない場合は、追跡対象に含めない。

## Report

完了報告では、少なくとも次を明記する。

- mobile changed
- release required
- build
- upload
- metadata
- debug
