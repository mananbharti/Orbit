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
      else { completionHandler(.cancelAuthenticationChallenge, nil) }
    }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) { onOpen?() }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) { onClose?() }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) { if error != nil { onClose?() } }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
  }

  private func makeSession(pin: String, delegate: PinDelegate) -> URLSession {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 10
    config.tlsMinimumSupportedProtocolVersion = .TLSv12
    return URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
  }

  public func definition() -> ModuleDefinition {
    Name("OrbitPinnedTransport")
    Events("orbitChannel")

    AsyncFunction("post") { (url: String, pin: String, bearer: String, promise: Promise) in
      guard let target = URL(string: url) else { promise.reject("NETWORK", "Invalid address"); return }
      var request = URLRequest(url: target)
      request.httpMethod = "POST"
      request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
      let session = self.makeSession(pin: pin, delegate: PinDelegate(pin: pin))
      session.dataTask(with: request) { data, response, error in
        session.finishTasksAndInvalidate()
        guard error == nil, let http = response as? HTTPURLResponse else { promise.reject("PIN_MISMATCH_OR_NETWORK", "Encrypted desktop request failed"); return }
        let body = data ?? Data()
        if body.count > 16_384 { promise.reject("RESPONSE_TOO_LARGE", "Desktop response exceeded limit"); return }
        promise.resolve(["status": http.statusCode, "body": String(decoding: body, as: UTF8.self)])
      }.resume()
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
