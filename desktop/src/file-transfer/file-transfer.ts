/** Routes owned File Transfer operations and connection leases; depends on checkpoint storage and authenticated contexts; never exposes remote filesystem browsing or executes received files. */
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { z } from 'zod';
import type { ActivityLog } from '../activity-log/activity-log.js';
import type { CommandContext } from '../command-router/command-context.js';
import type { CommandRegistry } from '../command-router/command-registry.js';
import type { JsonValue } from '../protocol/messages.js';
import { ProtocolError } from '../protocol/errors.js';
import * as protocol from '../protocol/file-transfer.js';
import { TransferStore, type TransferRecord } from './transfer-store.js';
import { decodeChunk, hashFile, publishFile, readChunk, recoverPartial, regularFile, removePartial, selectedFile, sha256, writeChunk } from './file-storage.js';

interface Lease { id: string; context: CommandContext; abort: AbortController; remove: () => void; lastProgress: number }
export class FileTransfer {
  private readonly leases = new Map<string, Lease>();
  private readonly watchers = new Map<string, { id: string; context: CommandContext; remove: () => void }>();
  private readonly jobs = new Set<Promise<void>>();
  private readonly unregister: (() => void)[] = [];
  private readonly timer: NodeJS.Timeout;
  private stopped = false;
  private readonly preparationAbort = new AbortController();
  constructor(readonly store: TransferStore, registry: CommandRegistry, private readonly log: ActivityLog,
    private readonly isActive: (owner: string) => boolean) {
    const register = <T>(type: string, schema: z.ZodType<T>, handler: (payload: T, context: CommandContext) => JsonValue | Promise<JsonValue>) => {
      this.unregister.push(registry.register(type, { validate: payload => schema.safeParse(payload).success,
        execute: async (payload, context) => {
          this.authorize(context);
          try { return await handler(schema.parse(payload), context); }
          catch (error) { if (error instanceof ProtocolError) throw error; throw new ProtocolError('FILE_IO'); }
        } }));
    };
    register('file.subscribe', protocol.emptySchema, (_payload, context) => {
      const connection = context.connection!;
      const existing = this.watchers.get(connection.id);
      if (existing) return { subscriptionId: existing.id };
      const id = randomUUID();
      const remove = () => { this.watchers.delete(connection.id); connection.closed.removeEventListener('abort', remove); };
      this.watchers.set(connection.id, { id, context, remove });
      connection.closed.addEventListener('abort', remove, { once: true });
      return { subscriptionId: id };
    });
    register('file.unsubscribe', protocol.unsubscribeSchema, (payload, context) => {
      const watcher = this.watchers.get(context.connection!.id);
      if (watcher?.id === payload.subscriptionId) watcher.remove();
      return { unsubscribed: true };
    });
    register('file.offers', protocol.offersSchema, (payload, context) => {
      this.store.cleanup();
      const records = [...this.store.records.values()].filter(record => record.owner === context.session.deviceId
        && record.manifest.direction === 'to-client' && !protocol.terminal(record.state)
        && (!payload.cursor || record.manifest.transferId > payload.cursor)).sort((a, b) => a.manifest.transferId.localeCompare(b.manifest.transferId));
      return { offers: records.slice(0, 16).map(record => record.manifest), nextCursor: records.length > 16 ? records[15]!.manifest.transferId : null };
    });
    register('file.offer', protocol.manifestSchema, (manifest, context) => {
      if (manifest.direction !== 'to-desktop') throw new ProtocolError('INVALID_PAYLOAD');
      return this.view(this.store.create(manifest, context.session.deviceId), context);
    });
    register('file.status', protocol.transferRef, (payload, context) => this.view(this.owned(payload.transferId, context), context));
    register('file.accept', protocol.transferRef, (payload, context) => {
      const record = this.owned(payload.transferId, context);
      if (record.manifest.direction !== 'to-client') throw new ProtocolError('INVALID_PAYLOAD');
      return this.resume(record, context, { receivedBytes: 0, prefixSha256: sha256(Buffer.alloc(0)) });
    });
    register('file.resume', protocol.resumeSchema, (payload, context) => this.resume(this.owned(payload.transferId, context), context, payload.checkpoint));
    register('file.chunk', protocol.chunkSchema, (payload, context) => {
      const record = this.leased(payload, context, 'to-desktop');
      const bytes = decodeChunk(payload.dataBase64, payload.sha256, payload.offset, record.manifest.sizeBytes);
      const path = this.store.paths(record).partial;
      if (payload.offset < record.nextOffset && payload.offset + bytes.length <= record.nextOffset) {
        if (!readChunk(path, payload.offset, bytes.length).equals(bytes)) throw new ProtocolError('FILE_INTEGRITY');
      } else {
        if (payload.offset !== record.nextOffset) throw new ProtocolError('FILE_OFFSET');
        const previous = record.nextOffset;
        writeChunk(path, previous, bytes);
        record.nextOffset += bytes.length;
        try { this.store.save(record); } catch (error) { record.nextOffset = previous; throw error; }
      }
      this.progress(record);
      return { transferId: record.manifest.transferId, nextOffset: record.nextOffset, state: record.state };
    });
    register('file.read', protocol.readSchema, (payload, context) => {
      const record = this.leased(payload, context, 'to-client');
      if (payload.offset !== record.nextOffset || payload.offset >= record.manifest.sizeBytes) throw new ProtocolError('FILE_OFFSET');
      this.source(record);
      const bytes = readChunk(record.sourcePath!, payload.offset, Math.min(protocol.CHUNK_BYTES, record.manifest.sizeBytes - payload.offset));
      return { transferId: record.manifest.transferId, offset: payload.offset, dataBase64: bytes.toString('base64'), sha256: sha256(bytes) };
    });
    register('file.ack', protocol.ackSchema, (payload, context) => {
      const record = this.leased(payload, context, 'to-client');
      if (payload.nextOffset !== record.nextOffset + Math.min(protocol.CHUNK_BYTES, record.manifest.sizeBytes - record.nextOffset)
        && payload.nextOffset !== record.nextOffset) throw new ProtocolError('FILE_OFFSET');
      if (payload.nextOffset === 0) throw new ProtocolError('FILE_OFFSET');
      this.source(record);
      const start = Math.floor((payload.nextOffset - 1) / protocol.CHUNK_BYTES) * protocol.CHUNK_BYTES;
      if (sha256(readChunk(record.sourcePath!, start, payload.nextOffset - start)) !== payload.sha256) throw new ProtocolError('FILE_INTEGRITY');
      record.nextOffset = payload.nextOffset;
      this.store.save(record);
      this.progress(record);
      return { transferId: record.manifest.transferId, nextOffset: record.nextOffset, state: record.state };
    });
    register('file.finish', protocol.leaseRef, (payload, context) => {
      const record = this.owned(payload.transferId, context);
      if (protocol.terminal(record.state)) return this.view(record, context);
      const lease = this.requireLease(record, payload.leaseId, context);
      if (record.state === 'verifying') return this.view(record, context);
      if (record.nextOffset !== record.manifest.sizeBytes) throw new ProtocolError('FILE_OFFSET');
      this.verify(record, lease, async () => {
        const path = record.manifest.direction === 'to-desktop' ? this.store.paths(record).partial : this.source(record);
        if (await hashFile(path, undefined, lease.abort.signal) !== record.manifest.sha256) throw new ProtocolError('FILE_INTEGRITY');
        this.requireLease(record, lease.id, context);
        if (record.manifest.direction === 'to-desktop') {
          const paths = this.store.paths(record);
          if (existsSync(paths.destination)) {
            regularFile(paths.destination);
            const a = statSync(paths.partial); const b = statSync(paths.destination);
            if (a.ino !== b.ino || a.dev !== b.dev) throw new ProtocolError('FILE_IO');
          } else publishFile(paths.partial, paths.destination);
        }
        record.state = 'completed';
        this.store.save(record);
        if (record.manifest.direction === 'to-desktop') removePartial(this.store.paths(record).partial);
      });
      return this.view(record, context);
    });
    register('file.cancel', protocol.transferRef, (payload, context) => {
      const record = this.owned(payload.transferId, context);
      if (!protocol.terminal(record.state)) {
        this.leases.get(record.manifest.transferId)?.remove();
        if (record.manifest.direction === 'to-desktop') removePartial(this.store.paths(record).partial);
        record.state = 'cancelled'; this.store.save(record);
      }
      return this.view(record, context);
    });
    this.timer = setInterval(() => {
      try {
        for (const [id, lease] of this.leases) if (!this.valid(lease.context) || protocol.terminal(this.store.records.get(id)!.state)) lease.remove();
        this.store.cleanup();
      } catch { this.record('failed'); }
    }, 1_000);
    this.timer.unref();
  }
  async offerLocal(path: string, owner: string): Promise<protocol.Manifest> {
    protocol.id.parse(owner);
    if (this.stopped || !this.isActive(owner)) throw new ProtocolError('UNAUTHENTICATED');
    const sourcePath = selectedFile(path);
    const sizeBytes = statSync(sourcePath).size;
    const manifest = protocol.manifestSchema.parse({ transferId: randomUUID(), direction: 'to-client', name: basename(sourcePath),
      sizeBytes, sha256: await hashFile(sourcePath, undefined, this.preparationAbort.signal), chunkBytes: protocol.CHUNK_BYTES });
    if (this.stopped || !this.isActive(owner) || statSync(sourcePath).size !== sizeBytes) throw new ProtocolError('FILE_SOURCE_CHANGED');
    this.store.create(manifest, owner, sourcePath);
    for (const watcher of this.watchers.values()) if (watcher.context.session.deviceId === owner && this.valid(watcher.context)) {
      watcher.context.connection!.publish('file.offered', { subscriptionId: watcher.id, manifest });
    }
    return manifest;
  }
  async stop(): Promise<void> {
    this.stopped = true; this.preparationAbort.abort(); clearInterval(this.timer);
    for (const remove of this.unregister) remove();
    for (const watcher of [...this.watchers.values()]) watcher.remove();
    for (const lease of [...this.leases.values()]) lease.remove();
    await Promise.allSettled(this.jobs);
  }
  private valid(context: CommandContext): boolean { return !this.stopped && !!context.connection?.isAuthorized() && this.isActive(context.session.deviceId); }
  private authorize(context: CommandContext): void { if (!this.valid(context)) throw new ProtocolError('UNAUTHENTICATED'); }
  private owned(id: string, context: CommandContext): TransferRecord { return this.store.get(id, context.session.deviceId); }
  private requireLease(record: TransferRecord, id: string, context: CommandContext): Lease {
    this.authorize(context);
    const lease = this.leases.get(record.manifest.transferId);
    if (!lease || lease.id !== id || lease.context.connection!.id !== context.connection!.id || lease.abort.signal.aborted || protocol.terminal(record.state)) throw new ProtocolError('FILE_INVALID_LEASE');
    return lease;
  }
  private leased(payload: { transferId: string; leaseId: string }, context: CommandContext, direction: protocol.Manifest['direction']): TransferRecord {
    const record = this.owned(payload.transferId, context);
    this.requireLease(record, payload.leaseId, context);
    if (record.state !== 'transferring' || record.manifest.direction !== direction) throw new ProtocolError('FILE_INVALID_STATE');
    return record;
  }
  private bind(record: TransferRecord, context: CommandContext): Lease {
    this.leases.get(record.manifest.transferId)?.remove();
    const abort = new AbortController();
    const remove = () => {
      abort.abort(); context.connection!.closed.removeEventListener('abort', remove);
      if (this.leases.get(record.manifest.transferId) !== lease) return;
      this.leases.delete(record.manifest.transferId);
      if (!protocol.terminal(record.state)) { record.state = 'paused'; try { this.store.save(record, false); } catch { this.record('failed'); } }
    };
    const lease: Lease = { id: randomUUID(), context, abort, remove, lastProgress: 0 };
    this.leases.set(record.manifest.transferId, lease);
    context.connection!.closed.addEventListener('abort', remove, { once: true });
    return lease;
  }
  private resume(record: TransferRecord, context: CommandContext, checkpoint?: z.infer<typeof protocol.checkpointSchema>): JsonValue {
    if (protocol.terminal(record.state)) return this.view(record, context);
    if (record.manifest.direction === 'to-desktop' ? !!checkpoint : !checkpoint) throw new ProtocolError('INVALID_PAYLOAD');
    const lease = this.bind(record, context);
    if (record.manifest.direction === 'to-desktop') {
      recoverPartial(this.store.paths(record).partial, record.nextOffset);
      record.state = 'transferring'; this.store.save(record); this.progress(record, true);
    } else {
      const received = checkpoint!.receivedBytes;
      if (received > record.manifest.sizeBytes || (received !== record.manifest.sizeBytes && received % protocol.CHUNK_BYTES !== 0)) throw new ProtocolError('FILE_OFFSET');
      this.verify(record, lease, async () => {
        const path = this.source(record);
        if (await hashFile(path, undefined, lease.abort.signal) !== record.manifest.sha256) throw new ProtocolError('FILE_SOURCE_CHANGED');
        if (await hashFile(path, received, lease.abort.signal) !== checkpoint!.prefixSha256) throw new ProtocolError('FILE_INTEGRITY');
        this.requireLease(record, lease.id, context);
        record.nextOffset = received; record.state = 'transferring'; this.store.save(record);
      });
    }
    return this.view(record, context);
  }
  private source(record: TransferRecord): string {
    if (!record.sourcePath) throw new ProtocolError('FILE_SOURCE_CHANGED');
    selectedFile(record.sourcePath);
    if (statSync(record.sourcePath).size !== record.manifest.sizeBytes) throw new ProtocolError('FILE_SOURCE_CHANGED');
    return record.sourcePath;
  }
  private verify(record: TransferRecord, lease: Lease, task: () => Promise<void>): void {
    record.state = 'verifying'; this.store.save(record); this.progress(record, true);
    const job = task().then(() => this.progress(record, true)).catch(error => {
      if (lease.abort.signal.aborted || !this.valid(lease.context)) { lease.remove(); return; }
      record.state = 'failed'; record.error = error instanceof ProtocolError ? error.code : 'FILE_IO';
      if (!record.error.startsWith('FILE_')) record.error = 'FILE_IO';
      try {
        this.store.save(record);
        if (record.manifest.direction === 'to-desktop') removePartial(this.store.paths(record).partial);
      } catch { this.record('failed'); }
      this.progress(record, true);
    }).finally(() => this.jobs.delete(job));
    this.jobs.add(job);
  }
  private view(record: TransferRecord, context: CommandContext): JsonValue {
    const lease = this.leases.get(record.manifest.transferId);
    return { manifest: record.manifest, state: record.state, nextOffset: record.nextOffset,
      ...(lease?.context.connection!.id === context.connection!.id ? { leaseId: lease.id } : {}), ...(record.error ? { error: record.error } : {}) };
  }
  private progress(record: TransferRecord, immediate = false): void {
    const lease = this.leases.get(record.manifest.transferId);
    if (lease && this.valid(lease.context) && (immediate || Date.now() - lease.lastProgress >= protocol.PROGRESS_INTERVAL_MS)) {
      lease.lastProgress = Date.now();
      lease.context.connection!.publish('file.progress', { transferId: record.manifest.transferId, state: record.state,
        committedBytes: record.nextOffset, sizeBytes: record.manifest.sizeBytes });
    }
    if (immediate) this.record(record.state === 'failed' ? 'failed' : 'success');
  }
  private record(outcome: 'success' | 'failed'): void { this.log.record({ severity: outcome === 'success' ? 'info' : 'warn', eventType: 'file.state', outcome }); }
}
