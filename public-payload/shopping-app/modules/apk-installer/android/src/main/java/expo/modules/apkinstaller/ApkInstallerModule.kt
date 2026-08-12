package expo.modules.apkinstaller

import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Environment
import androidx.core.content.FileProvider
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class ApkInstallerModule : Module() {
  private var downloadId: Long = -1
  private var receiver: BroadcastReceiver? = null

  override fun definition() = ModuleDefinition {
    Name("ApkInstaller")

    AsyncFunction("installApk") { url: String ->
      val context = appContext.reactContext ?: throw Exception("Context is null")

      // 既存のダウンロードファイルを削除
      try {
        val downloadDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        val existingFile = File(downloadDir, "EventAutoPin-update.apk")
        if (existingFile.exists()) existingFile.delete()
      } catch (_: Exception) {}

      val request = DownloadManager.Request(Uri.parse(url))
        .setTitle("Event AutoPin Update")
        .setDescription("APKをダウンロードしています…")
        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "EventAutoPin-update.apk")
        .setMimeType("application/vnd.android.package-archive")

      val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
      downloadId = dm.enqueue(request)

      // ダウンロード完了を監視して自動でインストーラーを起動
      receiver?.let {
        try { context.unregisterReceiver(it) } catch (_: Exception) {}
      }

      receiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
          val id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1)
          if (id != downloadId) return

          try { ctx.unregisterReceiver(this) } catch (_: Exception) {}
          receiver = null

          // ダウンロード結果を確認
          val query = DownloadManager.Query().setFilterById(downloadId)
          val cursor = dm.query(query)
          if (cursor == null || !cursor.moveToFirst()) {
            cursor?.close()
            return
          }

          val status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
          cursor.close()

          if (status != DownloadManager.STATUS_SUCCESSFUL) return

          // APKファイルのインストーラーを起動
          val apkFile = File(
            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
            "EventAutoPin-update.apk"
          )
          if (!apkFile.exists()) return

          val installIntent = Intent(Intent.ACTION_VIEW).apply {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
              val contentUri = FileProvider.getUriForFile(
                ctx,
                "${ctx.packageName}.FileSystemFileProvider",
                apkFile
              )
              setDataAndType(contentUri, "application/vnd.android.package-archive")
              addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            } else {
              setDataAndType(Uri.fromFile(apkFile), "application/vnd.android.package-archive")
            }
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          }
          ctx.startActivity(installIntent)
        }
      }

      val filter = IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        context.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
      } else {
        context.registerReceiver(receiver, filter)
      }
    }
  }
}
