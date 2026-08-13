# Mobile Auto Update Standard

この文書は、Mobile アプリを採用し、自前配布 APK の自動更新を実装する場合の標準。
テンプレート初期化時に Mobile 以外を選ぶ場合、または自動更新を使わない場合は削除する。

## 基準

- 既存実装をばらばらに再発明しない。`57_Hydrus_App` の更新体験を基準にする。
- UI、Alert、Android DownloadManager 通知、エラー時フォールバックのユーザー表示は日本語で統一する。
- `app.json` の `expo.version` を現在バージョンの唯一の基準にする。
- 配布メタデータは公開用 Public リポジトリの `latest.json` を参照する。
- APK インストールには Android 権限 `android.permission.REQUEST_INSTALL_PACKAGES` を含める。
- APK ダウンロードは Android の `DownloadManager` を使い、通知バーから完了後にインストールできる形にする。

## latest.json

公開用 Public リポジトリに置く `latest.json` は次の形に統一する。

```json
{
  "mobile": {
    "version": "0.1.0",
    "url": "https://github.com/<owner>/<repo>/releases/download/v0.1.0/<app>.apk",
    "notes": "更新内容",
    "date": "YYYY-MM-DD"
  }
}
```

## update-service

`src/lib/update-service.ts` または同等の場所に、次の責務をまとめる。

- `getCurrentVersion()` は `Constants.expoConfig?.version ?? "0.0.0"` を返す。
- `checkForUpdate()` は `UPDATE_CHECK_URL` を `cache: "no-store"` で取得する。
- `mobile.version` が現在より新しい場合だけ `available: true` を返す。
- セマンティックバージョンは `major.minor.patch` の数値比較にする。
- 通信失敗、JSON 不備、メタデータ未公開はクラッシュさせず `available: false` にする。
- `showUpdateAlert()` は日本語 Alert を出す。
- Android では native `ApkInstaller.installApk(url)` を呼ぶ。
- native 失敗時は、エラー内容を表示し、ブラウザで開くフォールバックを出す。

ユーザー表示文言の標準:

- タイトル: `アプリの更新があります`
- キャンセル: `後で`
- 実行: `更新する`
- ダウンロード開始: `ダウンロード開始`
- 開始説明: `通知バーにダウンロードの進捗が表示されます。\n完了後、通知をタップしてインストールしてください。`
- 失敗: `ダウンロードに失敗`
- フォールバック: `ブラウザで開く`

## Android native installer

`modules/apk-installer/android/src/main/java/.../ApkInstallerModule.kt` は次を満たす。

- 既存の同名 APK を削除してから `DownloadManager` に enqueue する。
- ファイル名はアプリごとに固定する。例: `<slug>-update.apk`
- `setMimeType("application/vnd.android.package-archive")` を設定する。
- `setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)` を設定する。
- `setTitle()` と `setDescription()` は日本語にする。

通知文言の標準:

- title: `<アプリ名> 更新`
- description: `APKをダウンロードしています...`

## 起動時チェックと手動チェック

- 起動時に一度 `checkForUpdate()` を呼び、更新がある場合だけ `showUpdateAlert()` を出す。
- 設定画面や About 画面に手動更新チェックを置く場合も、同じ `checkForUpdate()` と `showUpdateAlert()` を使う。
- 手動チェックで最新版の場合は `最新版です` のように日本語で通知する。
- 複数箇所で別実装を作らない。

## Release と merge

Mobile APK を公開する `/merge` では次を同時に満たす。

1. `app.json` の version をリリース版へ更新する。
2. APK をビルドする。
3. 開発リポジトリではなく、公開用 Public リポジトリの GitHub Release に APK をアップロードする。
4. 公開用 Public リポジトリの `latest.json` を同じ version、APK URL、notes、date に更新する。
5. 実機または最低限の Android 環境で、更新検出、通知文言、ダウンロード開始までを確認する。

公開用 Public リポジトリが未指定の場合、Release アップロードと `latest.json` 更新は開始しない。
`owner/repo` をユーザーに要求し、確定後に続行する。
