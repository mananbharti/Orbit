/** Orders bidirectional Clipboard Sync for subscribed connections; depends on router, OS adapter and metadata log; retains no clipboard history or offline commands. */
import { randomUUID } from 'node:crypto';
import type { ActivityLog } from '../activity-log/activity-log.js';
import type { CommandConnection, CommandContext } from '../command-router/command-context.js';
import type { CommandRegistry } from '../command-router/command-registry.js';
import type { ClipboardAdapter } from '../os-integration/clipboard.js';
import { CLIPBOARD_POLL_MS, clipboardSubscribeSchema, clipboardUnsubscribeSchema, clipboardWriteSchema,
  clipboardSnapshotSchema, type ClipboardSnapshot } from '../protocol/clipboard.js';
import { ProtocolError } from '../protocol/errors.js';
import { snapshotKey } from './snapshot-key.js';

const MAX_PENDING_OPERATIONS = 32;
interface Subscription { id: string; context: CommandContext; connection: CommandConnection; remove: () => void }

export class ClipboardSync {
  private adapter?: ClipboardAdapter;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly key = snapshotKey();
  private fingerprint?: string;
  private revision = 0;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private polling = false;
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private readonly unregister: (() => void)[];

  constructor(registry: CommandRegistry, private readonly createAdapter: () => ClipboardAdapter,
    private readonly log: ActivityLog, private readonly pollMs = CLIPBOARD_POLL_MS) {
    if (!Number.isSafeInteger(pollMs) || pollMs < 1) throw new Error('Invalid clipboard polling interval');
    this.unregister = [
      registry.register('clipboard.subscribe', { validate: payload => clipboardSubscribeSchema.safeParse(payload).success,
        execute: (_payload, context) => this.run(() => this.subscribe(context)) }),
      registry.register('clipboard.unsubscribe', { validate: payload => clipboardUnsubscribeSchema.safeParse(payload).success,
        execute: async (payload, context) => {
          const subscription = this.requireSubscription(context, clipboardUnsubscribeSchema.parse(payload).subscriptionId);
          subscription.remove();
          return { unsubscribed: true };
        } }),
      registry.register('clipboard.write', { validate: payload => clipboardWriteSchema.safeParse(payload).success,
        execute: (payload, context) => this.run(async () => {
          const { subscriptionId, baseRevision, text } = clipboardWriteSchema.parse(payload);
          this.requireSubscription(context, subscriptionId);
          const current = await this.read();
          this.requireSubscription(context, subscriptionId);
          this.observe(current);
          if (baseRevision !== this.revision) {
            this.record('clipboard.conflict', context, 'rejected');
            return { status: 'conflict', revision: this.revision };
          }
          if (current.kind === 'text' && current.text === text) return { status: 'unchanged', revision: this.revision };
          // Reads and queued commands can outlive a token or socket. Recheck immediately before the OS action.
          this.requireSubscription(context, subscriptionId);
          try { await this.adapter!.write(text); }
          catch { this.unavailable(); throw new ProtocolError('CLIPBOARD_UNAVAILABLE'); }
          // A disconnect during an OS operation cannot undo that action. Do not retry it or claim a rollback.
          this.observe({ kind: 'text', text }, context.connection!.id);
          return { status: 'applied', revision: this.revision };
        }) }),
    ];
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    for (const subscription of [...this.subscriptions.values()]) subscription.remove();
    for (const unregister of this.unregister) unregister();
    try { await this.adapter?.dispose(); } finally { await this.tail; }
    this.adapter = undefined;
    this.fingerprint = undefined;
  }

  private async subscribe(context: CommandContext) {
    const connection = this.requireConnection(context);
    const existing = this.subscriptions.get(connection.id);
    if (existing) return { subscriptionId: existing.id, revision: this.revision };
    const current = await this.read();
    this.requireConnection(context);
    // Existing subscribers see newly observed changes; the new subscriber gets metadata only.
    this.observe(current);
    const remove = () => {
      connection.closed.removeEventListener('abort', remove);
      this.subscriptions.delete(connection.id);
      if (!this.subscriptions.size) { clearTimeout(this.timer); this.timer = undefined; this.fingerprint = undefined; }
    };
    const subscription = { id: randomUUID(), context, connection, remove };
    this.subscriptions.set(connection.id, subscription);
    connection.closed.addEventListener('abort', remove, { once: true });
    this.schedule();
    return { subscriptionId: subscription.id, revision: this.revision };
  }

  private requireConnection(context: CommandContext): CommandConnection {
    if (this.stopped || !context.connection?.isAuthorized()) throw new ProtocolError('UNAUTHENTICATED');
    return context.connection;
  }

  private requireSubscription(context: CommandContext, id: string): Subscription {
    const connection = this.requireConnection(context);
    const subscription = this.subscriptions.get(connection.id);
    if (!subscription || subscription.id !== id) throw new ProtocolError('CLIPBOARD_NOT_SUBSCRIBED');
    return subscription;
  }

  private async read(): Promise<ClipboardSnapshot> {
    try {
      this.adapter ??= this.createAdapter();
      return clipboardSnapshotSchema.parse(await this.adapter.read());
    } catch { this.unavailable(); throw new ProtocolError('CLIPBOARD_UNAVAILABLE'); }
  }

  private observe(snapshot: ClipboardSnapshot, excludeConnection?: string): void {
    const fingerprint = this.key(snapshot);
    if (this.fingerprint === fingerprint) return;
    const baseline = this.fingerprint === undefined;
    this.fingerprint = fingerprint;
    if (baseline) return;
    this.revision++;
    for (const subscription of [...this.subscriptions.values()]) {
      if (!subscription.connection.isAuthorized()) { subscription.remove(); continue; }
      if (subscription.connection.id === excludeConnection) continue;
      const metadata = { subscriptionId: subscription.id, revision: this.revision };
      subscription.connection.publish(snapshot.kind === 'text' ? 'clipboard.changed' : 'clipboard.status',
        snapshot.kind === 'text' ? { ...metadata, text: snapshot.text } : { ...metadata, status: snapshot.kind });
    }
    this.record(snapshot.kind === 'text' ? 'clipboard.changed' : 'clipboard.ignored', undefined,
      snapshot.kind === 'text' ? 'success' : 'rejected');
  }

  private unavailable(): void {
    this.record('clipboard.unavailable', undefined, 'failed');
    for (const subscription of [...this.subscriptions.values()]) {
      subscription.connection.publish('clipboard.status', { subscriptionId: subscription.id, revision: this.revision, status: 'unavailable' });
      subscription.remove();
    }
    this.fingerprint = undefined;
  }

  private schedule(): void {
    if (this.stopped || this.timer || this.polling || !this.subscriptions.size) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.polling = true;
      void this.run(async () => {
        for (const subscription of [...this.subscriptions.values()]) if (!subscription.connection.isAuthorized()) subscription.remove();
        if (!this.stopped && this.subscriptions.size) this.observe(await this.read());
      }).catch(() => {}).finally(() => { this.polling = false; this.schedule(); });
    }, this.pollMs);
    this.timer.unref();
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new ProtocolError('UNAUTHENTICATED'));
    if (this.pending >= MAX_PENDING_OPERATIONS) return Promise.reject(new ProtocolError('BUSY'));
    this.pending++;
    const result = this.tail.then(() => {
      if (this.stopped) throw new ProtocolError('UNAUTHENTICATED');
      return operation();
    }).finally(() => { this.pending--; });
    this.tail = result.then(() => {}, () => {});
    return result;
  }

  private record(eventType: 'clipboard.changed' | 'clipboard.ignored' | 'clipboard.conflict' | 'clipboard.unavailable',
    context: CommandContext | undefined, outcome: 'success' | 'rejected' | 'failed'): void {
    this.log.record({ severity: outcome === 'success' ? 'info' : 'warn', eventType, outcome,
      deviceId: context?.session.deviceId, sessionId: context?.session.sessionId, requestId: context?.requestId });
  }
}
