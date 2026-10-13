import CryptoKit
import ExpoModulesCore
import Foundation

/// Pins the desktop by the SHA-256 of its leaf certificate (from the pairing QR). System trust is never consulted.
/// A mismatch cancels the challenge before any request bytes are sent.
public final class OrbitPinnedTransportModule: Module {
  private var sockets: [String: URLSessionWebSocketTask] = [:]
  private var sessions: [String: URLSession] = [:]
  private let lock = NSLock()

  private final class PinDelegate: NSObject, URLSessionDelegate, URLSessionWebSocketDelegate, URLSessionTaskDelegate {
    let pin: String
    var mismatch = false
    var onOpen: (() -> Void)?
    var onClose: (() -> Void)?
    init(pin: String) { self.pin = pin.lowercased() }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
      guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
            let trust = challenge.protectionSpace.serverTrust,
            let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else {
        completionHandler(.cancelAuthenticationChallenge, nil); return
      }
      let digest = SHA256.hash(data: SecCertificateCopyData(leaf) as Data).map { String(format: "%02x", $0) }.joined()
      if digest == pin { completionHandler(.useCredential, URLCredential(trust: trust)) }
      else { mismatch = true; completionHandler(.cancelAuthenticationChallenge, nil) }
    }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) { onOpen?() }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) { onClose?() }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) { if error != nil { onClose?() } }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
  }

  /// Browses _orbit._tcp over Bonjour and returns the IPv4 address and port of each Orbit desktop it resolves.
  private final class OrbitBrowser: NSObject, NetServiceBrowserDelegate, NetServiceDelegate {
    private let browser = NetServiceBrowser()
    private var services: [NetService] = []
    private var results: [[String: Any]] = []
    private var done: (([[String: Any]]) -> Void)?
    private var finished = false

    func start(timeout: TimeInterval, done: @escaping ([[String: Any]]) -> Void) {
      self.done = done
      DispatchQueue.main.async {
        self.browser.delegate = self
        self.browser.searchForServices(ofType: "_orbit._tcp.", inDomain: "local.")
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { self.finish() }
      }
    }
    func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
      services.append(service); service.delegate = self; service.resolve(withTimeout: 3)
    }
    func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String: NSNumber]) { finish() }
    func netServiceDidResolveAddress(_ sender: NetService) {
      for data in sender.addresses ?? [] {
        data.withUnsafeBytes { raw in
          guard let sa = raw.baseAddress?.assumingMemoryBound(to: sockaddr.self), sa.pointee.sa_family == sa_family_t(AF_INET) else { return }
          var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
          if getnameinfo(sa, socklen_t(data.count), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
            results.append(["host": String(cString: host), "port": sender.port])
          }
        }
      }
      if !results.isEmpty { DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.finish() } }
    }
    func finish() {
      if finished { return }
      finished = true
      browser.stop(); services.forEach { $0.stop() }
      let callback = done; done = nil
      callback?(results)
    }
  }

  private func makeSession(pin: String, delegate: PinDelegate, timeout: TimeInterval = 10) -> URLSession {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = timeout
    config.tlsMinimumSupportedProtocolVersion = .TLSv12
    return URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
  }

  /// Maps a URLSession failure to a stable code the app turns into plain language.
  static func classify(_ error: Error?, mismatch: Bool) -> String {
    if mismatch { return "PIN_MISMATCH" }
    guard let ns = error as NSError? else { return "UNKNOWN" }
    if let reason = ns.userInfo[NSURLErrorNetworkUnavailableReasonKey] as? Int,
       reason == NSURLErrorNetworkUnavailableReason.localNetworkProhibited.rawValue { return "LOCAL_NETWORK_DENIED" }
    switch ns.code {
    case NSURLErrorTimedOut: return "TIMEOUT"
    case NSURLErrorCannotConnectToHost: return "REFUSED"
    case NSURLErrorCancelled, NSURLErrorServerCertificateUntrusted, NSURLErrorSecureConnectionFailed: return "PIN_MISMATCH"
    case NSURLErrorNotConnectedToInternet, NSURLErrorCannotFindHost, NSURLErrorNetworkConnectionLost: return "UNREACHABLE"
    default: return "UNKNOWN"
    }
  }

  public func definition() -> ModuleDefinition {
    Name("OrbitPinnedTransport")
    Events("orbitChannel")

    AsyncFunction("post") { (url: String, pin: String, bearer: String, timeoutMs: Double?, promise: Promise) in
      guard let target = URL(string: url) else { promise.reject("NETWORK", "Invalid address"); return }
      var request = URLRequest(url: target)
      request.httpMethod = "POST"
      request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
      let pinDelegate = PinDelegate(pin: pin)
      let session = self.makeSession(pin: pin, delegate: pinDelegate, timeout: min(30, max(1, (timeoutMs ?? 10_000) / 1000)))
      session.dataTask(with: request) { data, response, error in
        session.finishTasksAndInvalidate()
        guard error == nil, let http = response as? HTTPURLResponse else {
          promise.reject(OrbitPinnedTransportModule.classify(error, mismatch: pinDelegate.mismatch), "Encrypted desktop request failed"); return
        }
        let body = data ?? Data()
        if body.count > 16_384 { promise.reject("RESPONSE_TOO_LARGE", "Desktop response exceeded limit"); return }
        promise.resolve(["status": http.statusCode, "body": String(decoding: body, as: UTF8.self)])
      }.resume()
    }

    AsyncFunction("discover") { (timeoutMs: Double, promise: Promise) in
      let browser = OrbitBrowser()
      browser.start(timeout: min(15, max(0.5, timeoutMs / 1000))) { results in promise.resolve(results) }
    }

    /// This phone's own Wi-Fi IPv4 address, used to scan the subnet when Bonjour is blocked.
    Function("localAddress") { () -> String? in
      var list: UnsafeMutablePointer<ifaddrs>?
      guard getifaddrs(&list) == 0, let first = list else { return nil }
      defer { freeifaddrs(list) }
      var cursor: UnsafeMutablePointer<ifaddrs>? = first
      while let current = cursor {
        let entry = current.pointee
        if let addr = entry.ifa_addr, addr.pointee.sa_family == sa_family_t(AF_INET), String(cString: entry.ifa_name) == "en0" {
          var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
          if getnameinfo(addr, socklen_t(addr.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 { return String(cString: host) }
        }
        cursor = entry.ifa_next
      }
      return nil
    }

    Function("open") { (id: String, url: String, pin: String, bearer: String) in
      guard let target = URL(string: url) else { return }
      var request = URLRequest(url: target)
      request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
      let delegate = PinDelegate(pin: pin)
      let session = self.makeSession(pin: pin, delegate: delegate)
      let task = session.webSocketTask(with: request)
      task.maximumMessageSize = 64 * 1024
      var closed = false
      let finish: () -> Void = { [weak self] in
        self?.lock.lock(); defer { self?.lock.unlock() }
        if closed { return }
        closed = true
        self?.sockets[id] = nil; self?.sessions[id]?.invalidateAndCancel(); self?.sessions[id] = nil
        self?.sendEvent("orbitChannel", ["id": id, "kind": "close"])
      }
      delegate.onOpen = { [weak self] in self?.sendEvent("orbitChannel", ["id": id, "kind": "open"]) }
      delegate.onClose = finish
      self.lock.lock(); self.sockets[id] = task; self.sessions[id] = session; self.lock.unlock()
      func receive() {
        task.receive { result in
          switch result {
          case .failure: finish()
          case .success(let message):
            if case .string(let text) = message { self.sendEvent("orbitChannel", ["id": id, "kind": "message", "text": text]); receive() }
            else { task.cancel(with: .unsupportedData, reason: nil); finish() } // text frames only
          }
        }
      }
      task.resume()
      receive()
    }

    Function("send") { (id: String, text: String) in
      self.lock.lock(); let task = self.sockets[id]; self.lock.unlock()
      task?.send(.string(text)) { _ in }
    }
    Function("close") { (id: String) in
      self.lock.lock(); let task = self.sockets[id]; self.lock.unlock()
      task?.cancel(with: .normalClosure, reason: nil)
    }
  }
}
