/** Keeps one authenticated channel to the desktop and runs one command at a time; depends on the pinned transport; never replays a command whose outcome is unknown. */
import { MAX_MESSAGE_BYTES, COMMAND, eventSchema, responseSchema, sessionResponseSchema,
  type ErrorCode, type JsonValue, type PairedDesktop } from './protocol.js';
import { AuthenticationRejected, type Channel, type PinnedTransport } from './transport.js';

export type SessionStatus = 'stopped' | 'connecting' | 'connected' | 'reconnecting' | 'authentication-required';
export type DesktopEvent = { eventType: string; data: unknown };

export class CommandError extends Error {
  constructor(readonly code: ErrorCode) { super(code); }
}
/** The command may or may not have run on the desktop. Callers must reconcile, never blindly retry. */
export class OutcomeUnknown extends Error {
  constructor() { super('Command outcome is unknown; it was not replayed'); }
}
export class NotSent extends Error {
  constructor(message = 'Command was not sent') { super(message); }
}

export interface SessionOptions {
  uuid: () => string;
  now?: () => number;
  commandTimeoutMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  random?: () => number;
}
const RENEW_AFTER_COMMANDS = 3_000;
const MAX_QUEUED = 16;

export class OrbitSession {
  private channel?: Channel;
  private status_: SessionStatus = 'stopped';
  private timer?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private submitted = 0;
  private generation = 0;
  private pending?: { id: string; resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> };
  private queue: { type: string; payload: JsonValue; gen: number; resolve(v: unknown): void; reject(e: Error): void }[] = [];
  private statusListeners = new Set<(s: SessionStatus) => void>();
  private eventListeners = new Set<(e: DesktopEvent) => void>();
  private readonly now: () => number;

  constructor(private readonly paired: PairedDesktop, private readonly transport: PinnedTransport,
    private readonly options: SessionOptions) {
    this.now = options.now ?? Date.now;
  }

  get status(): SessionStatus { return this.status_; }
  onStatus(listener: (s: SessionStatus) => void): () => void { this.statusListeners.add(listener); return () => this.statusListeners.delete(listener); }
  onEvent(listener: (e: DesktopEvent) => void): () => void { this.eventListeners.add(listener); return () => this.eventListeners.delete(listener); }

  async start(): Promise<void> {
    if (this.status_ !== 'stopped') throw new Error('Session already started');
    this.setStatus('connecting');
    try { await this.establish(); } catch (error) { this.stop(); throw error; }
  }

  stop(): void {
    clearTimeout(this.timer);
    this.generation++;
    const channel = this.channel;
    this.channel = undefined;
    channel?.close();
    this.failPending();
    this.failQueue();
    this.setStatus('stopped');
  }

  /** Sends one command. Rejects with CommandError (desktop refused), OutcomeUnknown (connection lost or timeout) or NotSent. */
  command(type: string, payload: JsonValue): Promise<unknown> {
    if (this.status_ !== 'connected' || !this.channel) return Promise.reject(new NotSent('Not connected; command was not sent'));
    if (!COMMAND.test(type) || type.startsWith('session.')) return Promise.reject(new NotSent('Invalid command'));
    if (this.queue.length >= MAX_QUEUED) return Promise.reject(new NotSent('Too many commands waiting'));
    return new Promise((resolve, reject) => {
      this.queue.push({ type, payload, gen: this.generation, resolve, reject });
      this.drain();
    });
  }

  private drain(): void {
    if (this.pending || !this.queue.length) return;
    const entry = this.queue.shift()!;
    if (entry.gen !== this.generation || !this.channel || this.status_ !== 'connected') {
      entry.reject(new NotSent('Connection changed; command was not sent'));
      this.drain();
      return;
    }
    if (this.submitted >= RENEW_AFTER_COMMANDS) {
      entry.reject(new NotSent('Session renewing; command was not sent'));
      void this.reconnect();
      return;
    }
    const requestId = this.options.uuid();
    const text = JSON.stringify({ version: 1, type: entry.type, requestId, payload: entry.payload });
    if (new TextEncoder().encode(text).length > MAX_MESSAGE_BYTES) {
      entry.reject(new NotSent('Command is too large'));
      this.drain();
      return;
    }
    const channel = this.channel;
    const timer = setTimeout(() => {
      this.failPending();
      if (this.channel === channel) { channel.close(); this.onChannelClosed(channel); }
    }, this.options.commandTimeoutMs ?? 10_000);
    this.pending = { id: requestId, resolve: entry.resolve, reject: entry.reject, timer };
    this.submitted++;
    try { channel.send(text); } catch { this.failPending(); }
  }

  private async establish(): Promise<void> {
    const gen = ++this.generation;
    const trust = { desktopServiceId: this.paired.desktopServiceId, endpoint: this.paired.endpoint,
      certificateFingerprint: this.paired.certificateFingerprint };
    const raw = await this.transport.postCredential(trust, '/v1/session', this.paired.credential);
    if (gen !== this.generation) return;
    const parsed = sessionResponseSchema.safeParse(raw);
    if (!parsed.success || parsed.data.deviceId !== this.paired.deviceId || parsed.data.expiresAt <= this.now()) {
      throw new AuthenticationRejected();
    }
    const session = parsed.data;
    await new Promise<void>((resolve, reject) => {
      let opened = false;
      const channel: Channel = this.transport.openChannel(trust, session.sessionToken, {
        onOpen: () => {
          if (gen !== this.generation) { channel.close(); resolve(); return; }
          opened = true;
          this.channel = channel;
          this.submitted = 0;
          this.attempt = 0;
          resolve();
        },
        onMessage: text => { if (this.channel === channel) this.onMessage(channel, text); },
        onClose: () => {
          if (!opened) { reject(new Error('Encrypted channel closed before opening')); return; }
          this.onChannelClosed(channel);
        },
      });
    });
    if (gen !== this.generation || !this.channel) return;
    clearTimeout(this.timer);
    const renewIn = Math.max(1, Math.floor((session.expiresAt - this.now()) * 0.8));
    this.timer = setTimeout(() => { void this.reconnect(); }, renewIn);
    this.setStatus('connected');
  }

  private onMessage(channel: Channel, text: string): void {
    try {
      const value: unknown = JSON.parse(text);
      const event = eventSchema.safeParse(value);
      if (event.success) { for (const l of [...this.eventListeners]) l(event.data.payload); return; }
      const response = responseSchema.parse(value);
      const pending = this.pending;
      if (!pending || pending.id !== response.requestId) return;
      this.pending = undefined;
      clearTimeout(pending.timer);
      if (response.payload.ok) pending.resolve(response.payload.result);
      else pending.reject(new CommandError(response.payload.error.code));
      queueMicrotask(() => this.drain());
    } catch { channel.close(); this.onChannelClosed(channel); }
  }

  private onChannelClosed(channel: Channel): void {
    if (this.channel !== channel) return;
    this.channel = undefined;
    this.failPending();
    this.failQueue();
    if (this.status_ === 'stopped' || this.status_ === 'authentication-required') return;
    this.setStatus('reconnecting');
    this.scheduleRetry();
  }

  private async reconnect(): Promise<void> {
    if (this.status_ === 'stopped') return;
    clearTimeout(this.timer);
    const previous = this.channel;
    this.channel = undefined;
    this.failPending();
    this.failQueue();
    previous?.close();
    this.setStatus('reconnecting');
    try { await this.establish(); }
    catch (error) {
      if (this.currentStatus() === 'stopped') return;
      if (error instanceof AuthenticationRejected) {
        this.generation++;
        clearTimeout(this.timer);
        this.setStatus('authentication-required');
      } else this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    clearTimeout(this.timer);
    const base = this.options.retryBaseMs ?? 500;
    const max = this.options.retryMaxMs ?? 30_000;
    const backoff = Math.min(max, base * 2 ** Math.min(this.attempt++, 6));
    this.timer = setTimeout(() => { void this.reconnect(); }, Math.floor(backoff * (0.75 + (this.options.random ?? Math.random)() * 0.25)));
  }

  private failPending(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.reject(new OutcomeUnknown());
  }
  private failQueue(): void {
    for (const entry of this.queue.splice(0)) entry.reject(new NotSent('Connection changed; command was not sent'));
  }
  private currentStatus(): SessionStatus { return this.status_; }
  private setStatus(next: SessionStatus): void {
    if (this.status_ === next) return;
    this.status_ = next;
    for (const l of [...this.statusListeners]) l(next);
  }
}
