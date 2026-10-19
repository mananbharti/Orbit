/** Clipboard sharing with the desktop plus the desktop's shared clipboard history; depends on OrbitSession and Zod; never reads the phone clipboard by itself. */
import { InvalidDesktopReply } from './agent.js';
import { MAX_CLIPBOARD_BYTES, clipboardChangedSchema, clipboardHistoryResultSchema, clipboardStatusSchema, clipboardSubscriptionSchema,
  clipboardWriteResultSchema, type ClipboardHistoryEntry } from './protocol.js';
import { CommandError, NotSent, type DesktopEvent, type OrbitSession } from './session.js';

export type SendResult = 'sent' | 'unchanged' | 'conflict';
export interface ClipboardState {
  active: boolean;
  /** Latest text copied on the computer that the user has not dismissed. */
  incoming?: { text: string; revision: number };
  /** The computer's clipboard holds something Orbit cannot share (not text, or too large). */
  blocked?: 'unsupported' | 'oversized';
}

export class ClipboardApi {
  private sub?: { id: string; revision: number };
  private state: ClipboardState = { active: false };
  private listeners = new Set<() => void>();
  private wanted = false;
  private starting?: Promise<void>;
  private offs: (() => void)[] = [];

  constructor(private readonly session: OrbitSession) {
    this.offs.push(session.onEvent(e => this.onEvent(e)));
    this.offs.push(session.onStatus(status => {
      this.sub = undefined;
      this.set({ active: false });
      if (status === 'connected' && this.wanted) void this.start().catch(() => {});
    }));
  }
  getState = (): ClipboardState => this.state;
  subscribe = (l: () => void): (() => void) => { this.listeners.add(l); return () => this.listeners.delete(l); };

  /** Begins receiving the computer's clipboard while the screen is open. Safe to call twice. */
  start(): Promise<void> {
    this.wanted = true;
    if (this.sub) return Promise.resolve();
    this.starting ??= (async () => {
      try {
        const result = await this.session.command('clipboard.subscribe', {});
        const parsed = clipboardSubscriptionSchema.safeParse(result);
        if (!parsed.success) throw new InvalidDesktopReply();
        this.sub = { id: parsed.data.subscriptionId, revision: parsed.data.revision };
        this.set({ active: true });
      } finally { this.starting = undefined; }
    })();
    return this.starting;
  }

  async stop(): Promise<void> {
    this.wanted = false;
    const sub = this.sub;
    this.sub = undefined;
    this.set({ active: false });
    if (!sub) return;
    try { await this.session.command('clipboard.unsubscribe', { subscriptionId: sub.id }); }
    catch (error) { if (!(error instanceof CommandError && error.code === 'CLIPBOARD_NOT_SUBSCRIBED')) { /* connection gone; the desktop drops it */ } }
  }

  dispose(): void { this.wanted = false; for (const off of this.offs.splice(0)) off(); this.listeners.clear(); }
  dismissIncoming(): void { const { incoming: _gone, ...rest } = this.state; this.set(rest); }

  /** Sends text the user typed or pasted. 'conflict' means the computer's clipboard changed first; nothing was overwritten. */
  async send(text: string): Promise<SendResult> {
    if (!text) throw new NotSent('Nothing to send');
    if (new TextEncoder().encode(text).length > MAX_CLIPBOARD_BYTES) throw new NotSent('That is too long to share (limit 8 KB)');
    if (/[\uD800-\uDFFF\0]/u.test(text)) throw new NotSent('That text contains characters that cannot be shared');
    await this.start();
    const sub = this.sub;
    if (!sub) throw new NotSent('Not connected');
    const result = await this.session.command('clipboard.write', { subscriptionId: sub.id, baseRevision: sub.revision, text });
    const parsed = clipboardWriteResultSchema.safeParse(result);
    if (!parsed.success) throw new InvalidDesktopReply();
    if (this.sub === sub) sub.revision = Math.max(sub.revision, parsed.data.revision);
    return parsed.data.status === 'applied' ? 'sent' : parsed.data.status;
  }

  /** Recent clips from both devices, newest first. Paged; pass the previous page's cursor in `before`. */
  async history(before?: string): Promise<{ entries: ClipboardHistoryEntry[]; nextCursor: string | null }> {
    await this.start();
    if (!this.sub) throw new NotSent('Not connected');
    const result = await this.session.command('clipboard.history', before ? { before } : {});
    const parsed = clipboardHistoryResultSchema.safeParse(result);
    if (!parsed.success) throw new InvalidDesktopReply();
    return parsed.data;
  }

  /** Puts a history entry back on the computer's clipboard; it syncs to the phone through the normal changed event. */
  async apply(historyId: string): Promise<void> {
    await this.start();
    const sub = this.sub;
    if (!sub) throw new NotSent('Not connected');
    const result = await this.session.command('clipboard.apply', { subscriptionId: sub.id, historyId });
    const parsed = clipboardWriteResultSchema.safeParse(result);
    if (!parsed.success) throw new InvalidDesktopReply();
    // Unlike send(), do not pre-bump the revision: the desktop includes this phone in the applied
    // clip's changed event, and accepting that event is how the clip surfaces as incoming here.
  }

  private onEvent(event: DesktopEvent): void {
    const sub = this.sub;
    if (!sub) return;
    if (event.eventType === 'clipboard.changed') {
      const parsed = clipboardChangedSchema.safeParse(event.data);
      if (!parsed.success || parsed.data.subscriptionId !== sub.id || parsed.data.revision <= sub.revision) return;
      sub.revision = parsed.data.revision;
      const { blocked: _b, ...rest } = this.state;
      this.set({ ...rest, incoming: { text: parsed.data.text, revision: parsed.data.revision } });
    } else if (event.eventType === 'clipboard.status') {
      const parsed = clipboardStatusSchema.safeParse(event.data);
      if (!parsed.success || parsed.data.subscriptionId !== sub.id) return;
      if (parsed.data.status === 'unavailable') { this.sub = undefined; this.set({ active: false }); return; }
      if (parsed.data.revision <= sub.revision) return;
      sub.revision = parsed.data.revision;
      const { incoming: _i, ...rest } = this.state;
      this.set({ ...rest, blocked: parsed.data.status });
    }
  }
  private set(next: ClipboardState): void { this.state = next; for (const l of [...this.listeners]) l(); }
}
