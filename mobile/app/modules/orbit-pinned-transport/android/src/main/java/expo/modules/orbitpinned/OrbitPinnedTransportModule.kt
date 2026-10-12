package expo.modules.orbitpinned

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/**
 * Pins the desktop by the SHA-256 of its leaf certificate (from the pairing QR). The pin is the only trust anchor:
 * system CAs are never consulted, and a mismatch fails the handshake before any request bytes are sent.
 */
class OrbitPinnedTransportModule : Module() {
  private val sockets = ConcurrentHashMap<String, WebSocket>()

  private class PinTrustManager(private val pin: String) : X509TrustManager {
    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = throw CertificateException("client auth unsupported")
    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
      val leaf = chain.firstOrNull() ?: throw CertificateException("no certificate")
      val digest = MessageDigest.getInstance("SHA-256").digest(leaf.encoded).joinToString("") { "%02x".format(it) }
      if (!MessageDigest.isEqual(digest.toByteArray(), pin.lowercase().toByteArray())) throw CertificateException("pin mismatch")
    }
    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
  }

  private fun client(pin: String, readTimeoutSeconds: Long): OkHttpClient {
    val trust = PinTrustManager(pin)
    val context = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), SecureRandom()) }
    return OkHttpClient.Builder()
      .sslSocketFactory(context.socketFactory, trust)
      .hostnameVerifier { _, _ -> true } // identity is the pinned certificate, not a hostname
      .followRedirects(false)
      .followSslRedirects(false)
      .connectTimeout(10, TimeUnit.SECONDS)
      .readTimeout(readTimeoutSeconds, TimeUnit.SECONDS)
      .pingInterval(20, TimeUnit.SECONDS)
      .build()
  }

  override fun definition() = ModuleDefinition {
    Name("OrbitPinnedTransport")
    Events("orbitChannel")

    AsyncFunction("post") { url: String, pin: String, bearer: String, promise: Promise ->
      Thread {
        try {
          val request = Request.Builder().url(url).header("Authorization", "Bearer $bearer")
            .post(ByteArray(0).toRequestBody(null)).build()
          client(pin, 10).newCall(request).execute().use { response: Response ->
            val body = response.body?.source()?.let { src -> src.request(16_385); src.buffer.snapshot().utf8() } ?: ""
            if (body.length > 16_384) promise.reject("RESPONSE_TOO_LARGE", "Desktop response exceeded limit", null)
            else promise.resolve(mapOf("status" to response.code, "body" to body))
          }
        } catch (e: Exception) {
          promise.reject(if (e.message?.contains("pin mismatch") == true) "PIN_MISMATCH" else "NETWORK", "Encrypted desktop request failed", null)
        }
      }.start()
    }

    Function("open") { id: String, url: String, pin: String, bearer: String ->
      val request = Request.Builder().url(url).header("Authorization", "Bearer $bearer").build()
      val socket = client(pin, 0).newWebSocket(request, object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) { emit(id, "open", null) }
        override fun onMessage(webSocket: WebSocket, text: String) { emit(id, "message", text) }
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(1000, null) }
        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { sockets.remove(id); emit(id, "close", null) }
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { sockets.remove(id); emit(id, "close", null) }
      })
      sockets[id] = socket
    }

    Function("send") { id: String, text: String -> sockets[id]?.send(text) }
    Function("close") { id: String -> sockets.remove(id)?.cancel() }
    OnDestroy { sockets.values.forEach { it.cancel() }; sockets.clear() }
  }

  private fun emit(id: String, kind: String, text: String?) {
    sendEvent("orbitChannel", if (text == null) mapOf("id" to id, "kind" to kind) else mapOf("id" to id, "kind" to kind, "text" to text))
  }
}
