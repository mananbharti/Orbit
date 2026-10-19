/** TEST-ONLY transport: Node TLS standing in for the phone's native pinned transport, so the core runs against a real desktop. */
import { request } from 'node:https';
import { X509Certificate } from 'node:crypto';
import { WebSocket } from 'ws';
import { identityHostname } from '../../../desktop/src/security-pairing/desktop-identity.js';
import { AuthenticationRejected, TransportError, type Channel, type ChannelHandlers, type PinnedTransport, type PinnedTrust } from '../../core/src/transport.js';

/** certificates maps fingerprint to PEM; production phones pin the fingerprint natively without needing the PEM. */
export class NodePinnedTransport implements PinnedTransport {
  constructor(private readonly certificates: Map<string, string>) {}
  private tls(trust: PinnedTrust) {
    const pem = this.certificates.get(trust.certificateFingerprint);
    if (!pem) throw new Error('No certificate for this pin');
    const servername = identityHostname(trust.desktopServiceId);
    return { ca: pem, rejectUnauthorized: true, minVersion: 'TLSv1.2' as const, servername,
      checkServerIdentity: (_h: string, peer: { raw: Buffer }) =>
        new X509Certificate(peer.raw).fingerprint256.replaceAll(':', '').toLowerCase() === trust.certificateFingerprint
          ? undefined : new Error('Certificate pin mismatch') };
  }
  postCredential(trust: PinnedTrust, path: '/v1/pair' | '/v1/session', token: string): Promise<unknown> {
    const url = new URL(trust.endpoint); url.protocol = 'https:'; url.pathname = path;
    return new Promise((resolve, reject) => {
      const req = request(url, { ...this.tls(trust), method: 'POST', agent: false,
        headers: { Authorization: `Bearer ${token}`, 'Content-Length': '0' } }, res => {
        let body = '';
        res.on('data', (c: Buffer) => { body += c.toString('utf8'); });
        res.on('end', () => {
          if (res.statusCode === 401) return reject(new AuthenticationRejected());
          if (res.statusCode !== 200) return reject(new TransportError('desktop-refused', String(res.statusCode)));
          try { resolve(JSON.parse(body)); } catch { reject(new Error('bad json')); }
        });
      });
      req.on('error', (e: NodeJS.ErrnoException) => {
        const kind = e.code === 'ECONNREFUSED' ? 'refused' : e.code === 'ETIMEDOUT' ? 'timeout'
          : /pin|certificate/i.test(e.message) ? 'pin-mismatch' : 'unreachable';
        reject(new TransportError(kind, e.code));
      });
      req.end();
    });
  }
  openChannel(trust: PinnedTrust, sessionToken: string, handlers: ChannelHandlers): Channel {
    const socket = new WebSocket(trust.endpoint, { ...this.tls(trust), headers: { Authorization: `Bearer ${sessionToken}` },
      perMessageDeflate: false, maxPayload: 64 * 1024 });
    socket.on('open', () => handlers.onOpen());
    socket.on('message', (data, binary) => { if (binary) socket.terminate(); else handlers.onMessage(data.toString()); });
    socket.on('error', () => {});
    socket.on('close', () => handlers.onClose());
    return { send: text => socket.send(text), close: () => socket.terminate() };
  }
}
