import { randomUUID } from 'node:crypto';
import type { Channel, ChannelHandlers, PinnedTransport, PinnedTrust } from '../src/transport.js';
import { AuthenticationRejected } from '../src/transport.js';

export const DESKTOP = '11111111-1111-4111-8111-111111111111';
export const DEVICE = '22222222-2222-4222-8222-222222222222';
export const token = (c: string): string => c.repeat(43).slice(0, 43);
export const FINGERPRINT = 'ab'.repeat(32);
export const ENDPOINT = 'wss://192.168.1.20:8443/v1/channel';
export const paired = { desktopServiceId: DESKTOP, displayName: 'Desk', deviceId: DEVICE, endpoint: ENDPOINT,
  certificateFingerprint: FINGERPRINT, credential: token('c') };

export class FakeChannel implements Channel {
  sent: string[] = [];
  closed = false;
  constructor(readonly handlers: ChannelHandlers) {}
  send(text: string): void { this.sent.push(text); this.onSend?.(text); }
  close(): void { if (this.closed) return; this.closed = true; queueMicrotask(() => this.handlers.onClose()); }
  onSend?: (text: string) => void;
  /** Desktop side. */
  deliver(value: unknown): void { this.handlers.onMessage(typeof value === 'string' ? value : JSON.stringify(value)); }
  reply(requestId: string, result: unknown): void { this.deliver({ version: 1, type: 'response', requestId, payload: { ok: true, result } }); }
  fail(requestId: string, code: string): void { this.deliver({ version: 1, type: 'response', requestId, payload: { ok: false, error: { code } } }); }
  drop(): void { this.closed = true; this.handlers.onClose(); }
}

export class FakeTransport implements PinnedTransport {
  posts: { path: string; token: string; trust: PinnedTrust }[] = [];
  channels: FakeChannel[] = [];
  sessionExpiresIn = 3_600_000;
  postResult: (path: string) => unknown = path => path === '/v1/pair'
    ? { version: 1, desktopServiceId: DESKTOP, deviceId: DEVICE, credential: token('c') }
    : { version: 1, deviceId: DEVICE, sessionId: randomUUID(), expiresAt: Date.now() + this.sessionExpiresIn, sessionToken: token('s') };
  failPost?: Error;
  failOpen = false;
  autoOpen = true;
  async postCredential(trust: PinnedTrust, path: '/v1/pair' | '/v1/session', tok: string): Promise<unknown> {
    this.posts.push({ path, token: tok, trust });
    if (this.failPost) throw this.failPost;
    return this.postResult(path);
  }
  openChannel(_trust: PinnedTrust, _sessionToken: string, handlers: ChannelHandlers): Channel {
    const channel = new FakeChannel(handlers);
    this.channels.push(channel);
    queueMicrotask(() => {
      if (this.failOpen) { channel.closed = true; handlers.onClose(); } else if (this.autoOpen) handlers.onOpen();
    });
    return channel;
  }
  get last(): FakeChannel { return this.channels[this.channels.length - 1]!; }
}
export { AuthenticationRejected };
export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
export const parseSent = (text: string): { type: string; requestId: string; payload: unknown } => JSON.parse(text);
