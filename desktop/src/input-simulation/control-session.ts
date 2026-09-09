/** Guards one controlling connection and releases its native session; depends on verified contexts, a biometric hook and an adapter; does not register commands, encode events or implement native input. */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { ActivityLog } from '../activity-log/activity-log.js';
import type { CommandContext, CommandConnection } from '../command-router/command-context.js';
import type { InputSessionAdapter } from '../os-integration/input-session.js';
import { ProtocolError } from '../protocol/errors.js';
import { requireBiometricConfirmation, type BiometricConfirmation } from '../security-pairing/biometric-confirmation.js';

export const INPUT_HEARTBEAT_TIMEOUT_MS = 5_000;
export const INPUT_AUTHORIZATION_POLL_MS = 100;
export const INPUT_CLEANUP_TIMEOUT_MS = 5_000;

interface Lease<T extends InputSessionAdapter> {
  id: string;
  context: CommandContext;
  connection: CommandConnection;
  abort: AbortController;
  detach: () => void;
  timer?: ReturnType<typeof setInterval>;
  adapter?: T;
  pending?: Promise<unknown>;
  cleanup?: Promise<void>;
  ready: boolean;
  busy: boolean;
  sequence: number;
  heartbeatAt: number;
}

export class InputControlSession<T extends InputSessionAdapter> {
  private lease?: Lease<T>;
  private stopped = false;
  private quarantined = false;

  constructor(private readonly createAdapter: () => T, private readonly log: ActivityLog,
    private readonly biometric: BiometricConfirmation = requireBiometricConfirmation) {}

  async begin(context: CommandContext): Promise<{ controlSessionId: string; nextSequence: number; heartbeatTimeoutMs: number }> {
    this.authorize(context);
    if (this.stopped || this.quarantined) throw new ProtocolError('INPUT_UNAVAILABLE');
    if (this.lease) throw new ProtocolError('BUSY');
    const connection = context.connection!;
    const lease: Lease<T> = { id: randomUUID(), context, connection, abort: new AbortController(),
      detach: () => {}, ready: false, busy: false, sequence: 1, heartbeatAt: 0 };
    // Reserve before awaiting verification so two connections cannot race into native control.
    this.lease = lease;
    const onClose = () => { void this.endLease(lease); };
    connection.closed.addEventListener('abort', onClose, { once: true });
    lease.detach = () => connection.closed.removeEventListener('abort', onClose);
    lease.timer = setInterval(() => {
      if (!this.authorized(context) || (lease.ready && performance.now() - lease.heartbeatAt >= INPUT_HEARTBEAT_TIMEOUT_MS)) {
        void this.endLease(lease);
      }
    }, INPUT_AUTHORIZATION_POLL_MS);
    lease.timer.unref();
    try {
      const confirmed = await this.interruptible(Promise.resolve().then(() => this.biometric.verify({
        version: 1, type: 'input.begin', requestId: context.requestId, payload: {},
      }, context)), lease.abort.signal);
      this.live(lease);
      if (!confirmed) throw new ProtocolError('BIOMETRIC_REQUIRED');
      lease.adapter = this.createAdapter();
      lease.pending = Promise.resolve().then(() => { this.live(lease); return lease.adapter!.open(lease.abort.signal); });
      await this.interruptible(lease.pending, lease.abort.signal);
      this.live(lease);
      lease.ready = true;
      lease.heartbeatAt = performance.now();
      this.record(lease, 'input.started', 'success');
      return { controlSessionId: lease.id, nextSequence: 1, heartbeatTimeoutMs: INPUT_HEARTBEAT_TIMEOUT_MS };
    } catch (error) {
      await this.endLease(lease);
      throw error instanceof ProtocolError ? error : new ProtocolError('INPUT_UNAVAILABLE');
    }
  }

  keepalive(context: CommandContext, id: string): void {
    const lease = this.owned(context, id);
    lease.heartbeatAt = performance.now();
  }

  async execute(context: CommandContext, id: string, sequence: number,
    operation: (adapter: T, signal: AbortSignal) => Promise<void>): Promise<void> {
    const lease = this.owned(context, id);
    if (lease.busy) throw new ProtocolError('BUSY');
    if (!Number.isSafeInteger(sequence) || sequence !== lease.sequence || sequence >= Number.MAX_SAFE_INTEGER) {
      throw new ProtocolError('INPUT_SEQUENCE');
    }
    // Consume before native work. An interrupted or partly applied batch must never be replayed.
    lease.sequence++;
    lease.busy = true;
    lease.pending = Promise.resolve().then(() => { this.live(lease); return operation(lease.adapter!, lease.abort.signal); });
    try {
      await this.interruptible(lease.pending, lease.abort.signal);
      this.live(lease);
    } catch (error) {
      await this.endLease(lease);
      throw error instanceof ProtocolError ? error : new ProtocolError('INPUT_UNAVAILABLE');
    } finally { lease.busy = false; }
  }

  async end(context: CommandContext, id: string): Promise<void> {
    await this.endLease(this.owned(context, id));
    if (this.quarantined) throw new ProtocolError('INPUT_UNAVAILABLE');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.lease) await this.endLease(this.lease);
  }

  private authorized(context: CommandContext): boolean {
    try {
      return !!context.connection && !context.connection.closed.aborted
        && context.session.expiresAt > Date.now() && context.connection.isAuthorized();
    } catch { return false; }
  }
  private authorize(context: CommandContext): void {
    if (!this.authorized(context)) throw new ProtocolError('UNAUTHENTICATED');
  }
  private live(lease: Lease<T>): void {
    if (lease.abort.signal.aborted || this.stopped || !this.authorized(lease.context)) {
      void this.endLease(lease);
      throw new ProtocolError('UNAUTHENTICATED');
    }
    if (lease.ready && performance.now() - lease.heartbeatAt >= INPUT_HEARTBEAT_TIMEOUT_MS) {
      void this.endLease(lease);
      throw new ProtocolError('INPUT_SESSION_REQUIRED');
    }
  }
  private owned(context: CommandContext, id: string): Lease<T> {
    this.authorize(context);
    const lease = this.lease;
    // Identity is the transport capability itself, not a client-provided connection identifier.
    if (!lease || !lease.ready || lease.abort.signal.aborted || id !== lease.id
      || context.connection !== lease.connection || context.session.sessionId !== lease.context.session.sessionId
      || context.session.deviceId !== lease.context.session.deviceId) throw new ProtocolError('INPUT_SESSION_REQUIRED');
    this.live(lease);
    return lease;
  }
  private endLease(lease: Lease<T>): Promise<void> {
    if (lease.cleanup) return lease.cleanup;
    const cleanup = Promise.resolve().then(async () => {
      // Never release ahead of an in-flight native operation that could press a key afterwards.
      await lease.pending?.catch(() => {});
      if (lease.adapter) {
        try { await lease.adapter.releaseAll(); } finally { await lease.adapter.dispose(); }
      }
    });
    lease.cleanup = this.boundedCleanup(cleanup).then(() => {
      this.record(lease, 'input.ended', 'success');
    }, () => {
      // A hung operation may still settle and run cleanup later; reserve the service until restart.
      this.quarantined = true;
      this.record(lease, 'input.release_failed', 'failed');
    }).finally(() => { if (this.lease === lease) this.lease = undefined; });
    // Install the shared cleanup promise before abort listeners can reenter stop/end.
    // Revoke synchronously so no queued callback may enter native code after this point.
    lease.abort.abort();
    lease.detach();
    clearInterval(lease.timer);
    return lease.cleanup;
  }
  private record(lease: Lease<T>, eventType: 'input.started' | 'input.ended' | 'input.release_failed', outcome: 'success' | 'failed'): void {
    this.log.record({ severity: outcome === 'failed' ? 'error' : 'info', eventType, outcome,
      deviceId: lease.context.session.deviceId, sessionId: lease.context.session.sessionId });
  }
  private interruptible<R>(work: Promise<R>, signal: AbortSignal): Promise<R> {
    return new Promise((resolve, reject) => {
      const aborted = () => reject(new ProtocolError('UNAUTHENTICATED'));
      if (signal.aborted) aborted();
      else signal.addEventListener('abort', aborted, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    });
  }
  private boundedCleanup(work: Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Cleanup deadline')), INPUT_CLEANUP_TIMEOUT_MS);
      work.then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }
}
