package expo.modules.orbitpinned

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.Looper
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

  private fun client(pin: String, readTimeoutSeconds: Long, connectTimeoutSeconds: Long = 10): OkHttpClient {
    val trust = PinTrustManager(pin)
    val context = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), SecureRandom()) }
    return OkHttpClient.Builder()
      .sslSocketFactory(context.socketFactory, trust)
      .hostnameVerifier { _, _ -> true } // identity is the pinned certificate, not a hostname
      .followRedirects(false)
      .followSslRedirects(false)
      .connectTimeout(connectTimeoutSeconds, TimeUnit.SECONDS)
      .readTimeout(readTimeoutSeconds, TimeUnit.SECONDS)
      .pingInterval(20, TimeUnit.SECONDS)
      .build()
  }

  override fun definition() = ModuleDefinition {
    Name("OrbitPinnedTransport")
    Events("orbitChannel")

    AsyncFunction("post") { url: String, pin: String, bearer: String, timeoutMs: Double?, promise: Promise ->
      val secs = ((timeoutMs ?: 10_000.0) / 1000.0).toLong().coerceIn(1L, 30L)
      Thread {
        try {
          val request = Request.Builder().url(url).header("Authorization", "Bearer $bearer")
            .post(ByteArray(0).toRequestBody(null)).build()
          client(pin, secs, secs).newCall(request).execute().use { response: Response ->
            val body = response.body?.source()?.let { src -> src.request(16_385); src.buffer.snapshot().utf8() } ?: ""
            if (body.length > 16_384) promise.reject("RESPONSE_TOO_LARGE", "Desktop response exceeded limit", null)
            else promise.resolve(mapOf("status" to response.code, "body" to body))
          }
        } catch (e: Exception) {
          val code = when {
            e.message?.contains("pin mismatch") == true || e is javax.net.ssl.SSLException -> "PIN_MISMATCH"
            e is java.net.SocketTimeoutException -> "TIMEOUT"
            e is java.net.ConnectException -> if (e.message?.contains("refused", true) == true) "REFUSED" else "UNREACHABLE"
            e is java.net.NoRouteToHostException || e is java.net.UnknownHostException -> "UNREACHABLE"
            else -> "UNKNOWN"
          }
          promise.reject(code, "Encrypted desktop request failed", null)
        }
      }.start()
    }

    // Finds Orbit desktops advertising _orbit._tcp on the local network. Returns [{host, port}] (IPv4 only); may be empty.
    AsyncFunction("discover") { timeoutMs: Double, promise: Promise ->
      val ctx = appContext.reactContext
      if (ctx == null) { promise.resolve(emptyList<Map<String, Any>>()); return@AsyncFunction }
      val nsd = ctx.getSystemService(Context.NSD_SERVICE) as NsdManager
      val results = java.util.Collections.synchronizedList(mutableListOf<Map<String, Any>>())
      val pending = java.util.concurrent.ConcurrentLinkedQueue<NsdServiceInfo>()
      val handler = Handler(Looper.getMainLooper())
      val state = java.util.concurrent.atomic.AtomicBoolean(false)
      val resolving = java.util.concurrent.atomic.AtomicBoolean(false)
      var listener: NsdManager.DiscoveryListener? = null
      fun finish() {
        if (!state.compareAndSet(false, true)) return
        try { listener?.let { nsd.stopServiceDiscovery(it) } } catch (_: Exception) {}
        promise.resolve(results.toList())
      }
      fun next() {
        if (state.get() || !resolving.compareAndSet(false, true)) return
        val info = pending.poll()
        if (info == null) { resolving.set(false); return }
        @Suppress("DEPRECATION")
        nsd.resolveService(info, object : NsdManager.ResolveListener {
          override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) { resolving.set(false); next() }
          override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
            @Suppress("DEPRECATION") val address = serviceInfo.host
            if (address is java.net.Inet4Address) {
              results.add(mapOf("host" to (address.hostAddress ?: ""), "port" to serviceInfo.port))
              handler.postDelayed({ finish() }, 400)
            }
            resolving.set(false); next()
          }
        })
      }
      listener = object : NsdManager.DiscoveryListener {
        override fun onDiscoveryStarted(serviceType: String) {}
        override fun onServiceFound(serviceInfo: NsdServiceInfo) { pending.add(serviceInfo); next() }
        override fun onServiceLost(serviceInfo: NsdServiceInfo) {}
        override fun onDiscoveryStopped(serviceType: String) {}
        override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) { finish() }
        override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
      }
      try { nsd.discoverServices("_orbit._tcp", NsdManager.PROTOCOL_DNS_SD, listener) } catch (_: Exception) { finish() }
      handler.postDelayed({ finish() }, timeoutMs.toLong().coerceIn(500L, 15_000L))
    }

    // This phone's own IPv4 address on the local network, used to scan the subnet when discovery is blocked.
    Function("localAddress") {
      try {
        java.net.NetworkInterface.getNetworkInterfaces().toList()
          .filter { it.isUp && !it.isLoopback }
          .flatMap { it.inetAddresses.toList() }
          .filterIsInstance<java.net.Inet4Address>()
          .firstOrNull { it.isSiteLocalAddress }?.hostAddress
      } catch (_: Exception) { null }
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
