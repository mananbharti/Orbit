/** Drives the TypeScript integration client; depends on pinned HTTPS/ws; does not provide mobile UI, replay commands, or execute OS actions. */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { endpointSchema, sessionResponseSchema } from '../protocol/pairing.js';
import { COMMAND_PATTERN, IDENTIFIER_PATTERN } from '../protocol/validation.js';
import type { JsonValue, ResponseMessage } from '../protocol/messages.js';
import { MAX_MESSAGE_BYTES } from '../config.js';
import { AuthenticationRejected, pinnedOptions, postCredential } from './pinned-https.js';
import { pairedDesktopSchema, type PairedDesktop } from './paired-desktop.js';

const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 30_000;
const COMMAND_TIMEOUT_MS = 10_000;
// Launch revalidates discovery and activation through two native helpers, each bounded to eight seconds.
const LAUNCHER_COMMAND_TIMEOUT_MS = 20_000;
export const RENEW_AFTER_COMMANDS = 3_000;
const MAX_ONLINE_COMMANDS = 16;
const responseSchema = z.strictObject({ version: z.literal(1), type: z.literal('response'),
  requestId: z.string().regex(IDENTIFIER_PATTERN).nullable(), payload: z.union([
    z.strictObject({ ok: z.literal(true), result: z.unknown() }),
    z.strictObject({ ok: z.literal(false), error: z.strictObject({ code: z.enum([
      'INVALID_MESSAGE', 'UNSUPPORTED_VERSION', 'UNAUTHENTICATED', 'UNKNOWN_COMMAND',
      'INVALID_PAYLOAD', 'BIOMETRIC_REQUIRED', 'COMMAND_FAILED', 'DUPLICATE_REQUEST', 'BUSY',
      'CLIPBOARD_UNAVAILABLE', 'CLIPBOARD_NOT_SUBSCRIBED',
      'FILE_NOT_FOUND', 'FILE_INVALID_STATE', 'FILE_INVALID_LEASE', 'FILE_QUOTA',
      'FILE_OFFSET', 'FILE_INTEGRITY', 'FILE_SOURCE_CHANGED', 'FILE_IO', 'FILE_EXPIRED',
      'LAUNCHER_UNAVAILABLE', 'LAUNCHER_LIMIT', 'LAUNCHER_STALE_CATALOG', 'LAUNCHER_NOT_FOUND', 'LAUNCHER_UNKNOWN_OUTCOME',
      'INPUT_UNAVAILABLE', 'INPUT_SESSION_REQUIRED', 'INPUT_SEQUENCE',
    ]) }) }),
  ]) });
const eventSchema = z.strictObject({ version: z.literal(1), type: z.literal('event'), requestId: z.null(),
  payload: z.strictObject({ eventType: z.string().max(64).regex(COMMAND_PATTERN), data: z.unknown() }) });

export class OrbitClient extends EventEmitter {
  private socket?: WebSocket;
  private connecting?: WebSocket;
  private timer?: NodeJS.Timeout;
  private stopped = true;
  private started = false;
  private attempt = 0;
  private submitted = 0;
  private draining = false;
  private readonly queue: { type: string; payload: JsonValue; socket: WebSocket;
    resolve: (response: ResponseMessage) => void; reject: (error: Error) => void }[] = [];
  private abort = new AbortController();
  private pending?: { id: string; resolve: (response: ResponseMessage) => void;
    reject: (error: Error) => void; timer: NodeJS.Timeout };

  private readonly paired: PairedDesktop;
  constructor(paired: PairedDesktop, private readonly resolveEndpoint?: (signal: AbortSignal) => Promise<string>) {
    super();
    this.paired = pairedDesktopSchema.parse(paired);
  }
  get connected(): boolean { return this.socket?.readyState === WebSocket.OPEN; }

  async start(): Promise<void> {
    if (this.started) throw new Error('Client already started; create a new instance after stop');
    this.started = true;
    this.stopped = false;
    this.abort = new AbortController();
    try { await this.establish(); } catch (error) { this.stop(); throw error; }
  }

  stop(): void {
    const wasRunning = !this.stopped;
    this.stopped = true;
    clearTimeout(this.timer);
    this.abort.abort();
    this.connecting?.terminate();
    this.socket?.terminate();
    this.socket = undefined;
    this.failPending();
    this.failQueue();
    if (wasRunning) this.emit('status', 'stopped');
  }

  command(type: string, payload: JsonValue): Promise<ResponseMessage> {
    if (!this.connected) return Promise.reject(new Error('Client is disconnected; command was not sent'));
    if (this.pending) return Promise.reject(new Error('A command is already pending'));
    if (this.submitted >= RENEW_AFTER_COMMANDS) {
      void this.reconnect();
      return Promise.reject(new Error('Session renewing; command was not sent'));
    }
    if (!COMMAND_PATTERN.test(type) || type.length > 64 || type.startsWith('session.')) {
      return Promise.reject(new Error('Invalid feature command'));
    }
    const requestId = randomUUID();
    const message = JSON.stringify({ version: 1, type, requestId, payload });
    if (Buffer.byteLength(message) > MAX_MESSAGE_BYTES) return Promise.reject(new Error('Command exceeds message limit'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failPending();
        this.socket?.terminate();
      }, type === 'launcher.list' || type === 'launcher.launch' ? LAUNCHER_COMMAND_TIMEOUT_MS : COMMAND_TIMEOUT_MS);
      this.pending = { id: requestId, resolve, reject, timer };
      this.submitted++;
      this.socket!.send(message, error => { if (error) this.failPending(); });
    });
  }

  /** Fair, bounded arbitration on the current live socket; disconnect discards unsent requests. */
  scheduledCommand(type: string, payload: JsonValue): Promise<ResponseMessage> {
    if (!this.connected || this.queue.length >= MAX_ONLINE_COMMANDS) return Promise.reject(new Error('No live command slot'));
    return new Promise((resolve, reject) => {
      this.queue.push({ type, payload, socket: this.socket!, resolve, reject });
      this.drain();
    });
  }
  private drain(): void {
    if (this.draining || this.pending || !this.queue.length) return;
    const entry = this.queue.shift()!;
    if (!this.connected || entry.socket !== this.socket) { entry.reject(new Error('Command was not sent')); this.drain(); return; }
    this.draining = true;
    void this.command(entry.type, entry.payload).then(entry.resolve, entry.reject).finally(() => {
      this.draining = false;
      setImmediate(() => this.drain());
    });
  }
  private failQueue(): void {
    for (const entry of this.queue.splice(0)) entry.reject(new Error('Connection changed; queued command was not sent'));
  }

  private async establish(): Promise<void> {
    if (this.resolveEndpoint) this.paired.endpoint = endpointSchema.parse(await this.resolveEndpoint(this.abort.signal));
    if (this.stopped) return;
    const parsed = sessionResponseSchema.safeParse(await postCredential(this.paired, '/v1/session',
      this.paired.credential, this.abort.signal));
    if (!parsed.success || parsed.data.deviceId !== this.paired.deviceId || parsed.data.expiresAt <= Date.now()) {
      throw new AuthenticationRejected();
    }
    if (this.stopped) return;
    const session = parsed.data;
    const socket = new WebSocket(this.paired.endpoint, { ...pinnedOptions(this.paired),
      headers: { Authorization: `Bearer ${session.sessionToken}` }, handshakeTimeout: 10_000,
      maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
    this.connecting = socket;
    socket.on('error', () => {});
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', () => reject(new Error('Encrypted channel connection failed')));
      socket.once('close', () => reject(new Error('Encrypted channel closed before opening')));
    });
    this.connecting = undefined;
    if (this.stopped) { socket.terminate(); return; }
    if (socket.readyState !== WebSocket.OPEN) throw new Error('Encrypted channel closed during setup');
    this.socket = socket;
    this.submitted = 0;
    this.attempt = 0;
    socket.on('message', (data, binary) => {
      if (socket !== this.socket) return;
      try {
        if (binary) throw new Error('Binary server message');
        const value: unknown = JSON.parse(data.toString());
        const event = eventSchema.safeParse(value);
        if (event.success) { this.emit('desktop-event', event.data.payload); return; }
        const response = responseSchema.parse(value);
        if (this.pending?.id === response.requestId) {
          const pending = this.pending;
          this.pending = undefined;
          clearTimeout(pending.timer);
          pending.resolve(response as ResponseMessage);
          setImmediate(() => this.drain());
        }
      } catch { socket.terminate(); }
    });
    socket.on('close', () => {
      if (socket !== this.socket) return;
      this.socket = undefined;
      this.failPending();
      this.failQueue();
      if (!this.stopped) { this.emit('status', 'disconnected'); this.scheduleRetry(); }
    });
    clearTimeout(this.timer);
    const renewalDelay = Math.max(1, Math.floor((session.expiresAt - Date.now()) * 0.8));
    this.timer = setTimeout(() => { void this.reconnect(); }, renewalDelay);
    this.emit('status', 'connected');
  }

  private async reconnect(): Promise<void> {
    if (this.stopped) return;
    clearTimeout(this.timer);
    const previous = this.socket;
    this.socket = undefined;
    this.failPending();
    this.failQueue();
    previous?.terminate();
    this.emit('status', 'reconnecting');
    try { await this.establish(); }
    catch (error) {
      this.connecting?.terminate();
      this.connecting = undefined;
      if (this.stopped) return;
      if (error instanceof AuthenticationRejected) {
        this.stop();
        this.emit('status', 'authentication-required');
      } else this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    clearTimeout(this.timer);
    const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(this.attempt++, 6));
    this.timer = setTimeout(() => { void this.reconnect(); }, Math.floor(backoff * (0.75 + Math.random() * 0.25)));
  }

  private failPending(): void {
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.reject(new Error('Command outcome is unknown; it will not be replayed'));
  }
}
