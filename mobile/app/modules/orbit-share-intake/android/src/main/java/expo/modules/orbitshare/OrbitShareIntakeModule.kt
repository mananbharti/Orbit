package expo.modules.orbitshare

import android.content.Intent
import android.net.Uri
import android.os.Build
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

/**
 * Hands files and text other Android apps share into Orbit to the JS side. Shares arrive as
 * ACTION_SEND / ACTION_SEND_MULTIPLE intents on the main activity (declared via android.intentFilters
 * in app.json). Streamed files are copied into the app cache because the granting content URI may be
 * revoked once the source app's share sheet closes; JS then uploads the cached copy to the computer.
 * Events are buffered until JS drains them once, so nothing is lost while React Native boots.
 */
class OrbitShareIntakeModule : Module() {
  private val pending = mutableListOf<Map<String, Any?>>()
  private var coldStartConsumed = false

  override fun definition() = ModuleDefinition {
    Name("OrbitShareIntake")
    Events("orbitShared")

    OnNewIntent { intent -> deliver(intent) }

    AsyncFunction("drainPendingShares") { promise: Promise ->
      if (!coldStartConsumed) {
        coldStartConsumed = true
        appContext.currentActivity?.intent?.let { extract(it)?.let(pending::add) }
      }
      val out = pending.toList()
      pending.clear()
      promise.resolve(out)
    }
  }

  private fun deliver(intent: Intent) {
    val share = extract(intent) ?: return
    pending.add(share)
    sendEvent("orbitShared", share)
  }

  private fun extract(intent: Intent): Map<String, Any?>? {
    if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) return null
    val files = mutableListOf<String>()
    for (uri in streamUris(intent)) copyToCache(uri)?.let(files::add)
    val text = intent.getStringExtra(Intent.EXTRA_TEXT)
    if (files.isEmpty() && text.isNullOrBlank()) return null
    return mapOf("files" to files, "text" to text)
  }

  private fun streamUris(intent: Intent): List<Uri> {
    return if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
      val list = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
        intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
      else @Suppress("DEPRECATION") intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
      list?.filterNotNull() ?: emptyList()
    } else {
      val uri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
        intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
      else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri
      if (uri != null) listOf(uri) else emptyList()
    }
  }

  private fun copyToCache(uri: Uri): String? {
    return try {
      val context = appContext.reactContext ?: return null
      val raw = uri.lastPathSegment?.substringAfterLast('/')?.substringAfterLast(':') ?: "shared"
      val safe = raw.replace(Regex("[/\\\\:*?\"<>|-]"), "").ifBlank { "shared" }
      val dir = File(context.cacheDir, "shared-in").apply { mkdirs() }
      val out = File(dir, "${System.currentTimeMillis()}-$safe")
      context.contentResolver.openInputStream(uri)?.use { input ->
        out.outputStream().use { input.copyTo(it) }
      } ?: return null
      "file://${out.absolutePath}"
    } catch (_: Exception) { null }
  }
}
