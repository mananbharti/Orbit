/** Bridges the harness clipboard to a paired Orbit client; depends on the OS adapter and clipboard protocol; implements no mobile UI, history or offline replay. */
import { EventEmitter } from 'node:events';
import { snapshotKey } from '../clipboard-sync/snapshot-key.js';
import type { ClipboardAdapter } from '../os-integration/clipboard.js';
import { CLIPBOARD_POLL_MS, clipboardChangedSchema, clipboardSnapshotSchema, clipboardStatusSchema,
  clipboardSubscriptionSchema, clipboardWriteResultSchema } from '../protocol/clipboard.js';
import type { OrbitClient } from './orbit-client.js';

interface Subscription { subscriptionId: string; revision: number; fingerprint: string }
type Change = ReturnType<typeof clipboardChangedSchema.parse>;
type ClipboardChannel = Pick<OrbitClient, 'connected' | 'command' | 'stop'> & Partial<Pick<OrbitClient, 'scheduledCommand'>> & Pick<EventEmitter, 'on' | 'off'>;
export type ClipboardClientStatus = 'active' | 'disconnected' | 'sent' | 'received' | 'conflict'
  | 'unsupported' | 'oversized' | 'unavailable' | 'unknown-outcome' | 'stopped';

export class ClipboardClient extends EventEmitter {
  private readonly key = snapshotKey();
  private subscription?: Subscription;
  private change?: Change;
  private timer?: NodeJS.Timeout;
  private generation = 0;
  private stopped = false;
  private commandPending = false;
  private tail: Promise<void> = Promise.resolve();
  private readonly onStatus = (status: string) => {
    this.reset();
    if (status === 'connected') this.connect();
    else this.status('disconnected');
  };
  private readonly onEvent = (event: { eventType: string; data: unknown }) => {
    const subscription = this.subscription;
    if (!subscription || this.stopped) return;
    if (event.eventType === 'clipboard.changed') {
      const parsed = clipboardChangedSchema.safeParse(event.data);
      if (!parsed.success) { this.disable(); return; }
      if (parsed.data.subscriptionId !== subscription.subscriptionId || parsed.data.revision <= subscription.revision) return;
      if (!this.change || parsed.data.revision > this.change.revision) this.change = parsed.data;
    } else if (event.eventType === 'clipboard.status') {
      const parsed = clipboardStatusSchema.safeParse(event.data);
      if (!parsed.success) { this.disable(); return; }
      if (parsed.data.subscriptionId !== subscription.subscriptionId) return;
      if (parsed.data.status === 'unavailable') { this.disable(); return; }
      if (parsed.data.revision <= subscription.revision) return;
      subscription.revision = parsed.data.revision;
      // Superseded text must not be applied after a newer unsupported clipboard change.
      if (this.change && this.change.revision <= subscription.revision) this.change = undefined;
      this.status(parsed.data.status);
    }
  };

  constructor(private readonly client: ClipboardChannel, private readonly adapter: ClipboardAdapter,
    private readonly pollMs = CLIPBOARD_POLL_MS) {
    super();
    if (!Number.isSafeInteger(pollMs) || pollMs < 1) throw new Error('Invalid clipboard polling interval');
    client.on('status', this.onStatus);
    client.on('desktop-event', this.onEvent);
    if (client.connected) this.connect();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const subscription = this.subscription;
    // An unacknowledged subscription has no known ID; an in-flight write has an unknown outcome.
    // Closing the socket cancels queued work and enrollment without attempting a replay.
    if (this.commandPending) this.client.stop();
    this.reset();
    this.client.off('status', this.onStatus);
    this.client.off('desktop-event', this.onEvent);
    try { await this.adapter.dispose(); } finally {
      await this.tail;
      if (subscription && this.client.connected) await this.unsubscribe(subscription.subscriptionId);
      this.status('stopped');
    }
  }

  private connect(): void {
    const generation = this.generation;
    this.enqueue(async () => {
      if (!this.current(generation)) return;
      const baseline = clipboardSnapshotSchema.parse(await this.adapter.read());
      if (!this.current(generation)) return;
      this.commandPending = true;
      let response;
      try { response = await this.command('clipboard.subscribe', {}); }
      finally { this.commandPending = false; }
      if (!this.current(generation)) return;
      if (!response.payload.ok) { this.disable(); return; }
      const parsed = clipboardSubscriptionSchema.safeParse(response.payload.result);
      if (!parsed.success) { this.client.stop(); this.disable(); return; }
      this.subscription = { ...parsed.data, fingerprint: this.key(baseline) };
      // Discard local changes made while enrollment was in flight as well as changes made offline.
      const current = clipboardSnapshotSchema.parse(await this.adapter.read());
      if (!this.current(generation)) return;
      this.subscription.fingerprint = this.key(current);
      this.status('active');
      this.schedule(generation);
    });
  }

  private schedule(generation: number): void {
    if (!this.current(generation) || !this.subscription || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.enqueue(async () => {
        if (!this.current(generation) || !this.subscription) return;
        await this.poll(generation, this.subscription);
        this.schedule(generation);
      });
    }, this.pollMs);
    this.timer.unref();
  }

  private async poll(generation: number, subscription: Subscription): Promise<void> {
    const revisionBeforeRead = subscription.revision;
    const local = clipboardSnapshotSchema.parse(await this.adapter.read());
    if (!this.current(generation) || this.subscription !== subscription) return;
    const fingerprint = this.key(local);
    const changedLocally = fingerprint !== subscription.fingerprint;
    const remote = this.change;
    this.change = undefined;
    if (remote && remote.revision > subscription.revision) {
      subscription.revision = remote.revision;
      if (changedLocally) {
        // Preserve a concurrent local copy, but do not resend it under a newer revision.
        subscription.fingerprint = fingerprint;
        this.status('conflict');
        return;
      }
      if (local.kind !== 'text' || local.text !== remote.text) {
        await this.adapter.write(remote.text);
        if (!this.current(generation) || this.subscription !== subscription) return;
      }
      subscription.fingerprint = this.key({ kind: 'text', text: remote.text });
      this.status('received');
      return;
    }
    if (!changedLocally) return;
    subscription.fingerprint = fingerprint;
    if (local.kind !== 'text') { this.status(local.kind); return; }
    let response;
    this.commandPending = true;
    try {
      response = await this.command('clipboard.write', { subscriptionId: subscription.subscriptionId,
        baseRevision: revisionBeforeRead, text: local.text });
    } catch {
      if (this.current(generation)) this.status('unknown-outcome');
      return;
    } finally { this.commandPending = false; }
    if (!this.current(generation) || this.subscription !== subscription) return;
    if (!response.payload.ok) {
      if (response.payload.error.code === 'BUSY') this.status('unknown-outcome');
      else this.disable();
      return;
    }
    const result = clipboardWriteResultSchema.parse(response.payload.result);
    subscription.revision = Math.max(subscription.revision, result.revision);
    this.status(result.status === 'conflict' ? 'conflict' : 'sent');
  }

  private enqueue(action: () => Promise<void>): void {
    const generation = this.generation;
    this.tail = this.tail.then(action).catch(() => { if (this.current(generation)) this.disable(); });
  }

  private current(generation: number): boolean { return !this.stopped && this.generation === generation && this.client.connected; }
  private reset(): void {
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.subscription = undefined;
    this.change = undefined;
  }
  private disable(): void {
    const subscription = this.subscription;
    this.reset();
    this.status('unavailable');
    if (subscription && this.client.connected) {
      void this.unsubscribe(subscription.subscriptionId);
    }
  }
  private async unsubscribe(subscriptionId: string): Promise<void> {
    try {
      const response = await this.command('clipboard.unsubscribe', { subscriptionId });
      if (!response.payload.ok && response.payload.error.code !== 'CLIPBOARD_NOT_SUBSCRIBED') this.client.stop();
    } catch { this.client.stop(); }
  }
  private status(status: ClipboardClientStatus): void { this.emit('status', status); }
  private command(type: string, payload: import('../protocol/messages.js').JsonValue) {
    return this.client.scheduledCommand ? this.client.scheduledCommand(type, payload) : this.client.command(type, payload);
  }
}
