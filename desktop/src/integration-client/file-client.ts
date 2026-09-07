/** Transfers explicitly selected files through the paired channel; depends on durable checkpoints and online command arbitration; never browses the peer filesystem or blindly replays commands. */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { ProtocolError } from '../protocol/errors.js';
import type { JsonValue } from '../protocol/messages.js';
import * as protocol from '../protocol/file-transfer.js';
import { TransferStore, type TransferRecord } from '../file-transfer/transfer-store.js';
import { decodeChunk, hashFile, publishFile, readChunk, regularFile, removePartial, selectedFile, sha256, writeChunk } from '../file-transfer/file-storage.js';
import type { OrbitClient } from './orbit-client.js';

export class FileClient extends EventEmitter {
  readonly store: TransferStore;
  private epoch = 0;
  private stopped = false;
  private running?: Promise<void>;
  private requested = false;
  private pendingCommands = 0;
  private subscriptionId?: string;
  private abort = new AbortController();
  private readonly cleanupTimer: NodeJS.Timeout;
  private readonly onStatus = (status: string) => {
    this.subscriptionId = undefined;
    this.epoch++; this.abort.abort(); this.abort = new AbortController();
    if (status === 'connected') this.kick();
    else this.emit('status', { state: 'paused' });
  };
  constructor(private readonly client: OrbitClient, directory: string, private readonly owner: string) {
    super();
    this.store = new TransferStore(directory, join(directory, 'received'), 'to-client');
    this.cleanupTimer = setInterval(() => {
      try { this.store.cleanup(); } catch { this.emit('status', { state: 'paused', error: 'FILE_IO' }); }
    }, 1_000);
    this.cleanupTimer.unref();
    this.client.on('status', this.onStatus);
    if (client.connected) this.kick();
  }
  async upload(path: string): Promise<string> {
    const sourcePath = selectedFile(path);
    const manifest = protocol.manifestSchema.parse({ transferId: randomUUID(), direction: 'to-desktop', name: basename(sourcePath),
      sizeBytes: statSync(sourcePath).size, sha256: await hashFile(sourcePath, undefined, this.abort.signal), chunkBytes: protocol.CHUNK_BYTES });
    if (this.stopped || !this.client.connected) throw new Error('A live connection is required to start a transfer');
    this.store.create(manifest, this.owner, sourcePath);
    this.kick();
    return manifest.transferId;
  }
  async offers(): Promise<protocol.Manifest[]> {
    const all: protocol.Manifest[] = [];
    let cursor: string | null = null;
    do {
      const response = z.strictObject({ offers: z.array(protocol.manifestSchema).max(16), nextCursor: protocol.id.nullable() })
        .parse(await this.call('file.offers', cursor ? { cursor } : {}, this.epoch));
      all.push(...response.offers);
      if (response.nextCursor === cursor || all.length > protocol.MAX_ACTIVE_TRANSFERS) { if (response.nextCursor) throw new ProtocolError('FILE_IO'); }
      cursor = response.nextCursor;
    } while (cursor);
    return all;
  }
  async download(transferId: string): Promise<void> {
    protocol.id.parse(transferId);
    const status = protocol.statusSchema.parse(await this.call('file.status', { transferId }, this.epoch));
    if (status.manifest.direction !== 'to-client' || protocol.terminal(status.state)) throw new ProtocolError('FILE_INVALID_STATE');
    this.store.create(status.manifest, this.owner);
    await this.call('file.accept', { transferId }, this.epoch);
    this.kick();
  }
  resume(transferId: string): void {
    const record = this.store.get(protocol.id.parse(transferId), this.owner);
    if (protocol.terminal(record.state)) throw new ProtocolError('FILE_INVALID_STATE');
    this.kick();
  }
  async cancel(transferId: string): Promise<void> {
    const record = this.store.get(protocol.id.parse(transferId), this.owner);
    this.epoch++; this.abort.abort(); this.abort = new AbortController();
    await this.call('file.cancel', { transferId }, this.epoch);
    if (!protocol.terminal(record.state)) {
      record.state = 'cancelled'; this.store.save(record);
      if (record.manifest.direction === 'to-client') removePartial(this.store.paths(record).partial);
    }
  }
  async stop(): Promise<void> {
    const subscriptionId = this.subscriptionId;
    clearInterval(this.cleanupTimer);
    this.stopped = true; this.epoch++; this.abort.abort(); this.client.off('status', this.onStatus);
    if (this.pendingCommands) this.client.stop();
    await this.running;
    if (subscriptionId && this.client.connected) {
      try { await this.client.scheduledCommand('file.unsubscribe', { subscriptionId }); } catch { this.client.stop(); }
    }
  }
  private current(epoch: number): boolean { return !this.stopped && this.client.connected && this.epoch === epoch; }
  private async call(type: string, payload: JsonValue, epoch: number): Promise<JsonValue> {
    if (!this.current(epoch)) throw new Error('Connection changed');
    this.pendingCommands++;
    let response;
    try { response = await this.client.scheduledCommand(type, payload); } finally { this.pendingCommands--; }
    if (!this.current(epoch)) throw new Error('Connection changed');
    if (!response.payload.ok) throw new ProtocolError(response.payload.error.code);
    return response.payload.result;
  }
  private kick(): void {
    this.requested = true;
    if (this.running || this.stopped || !this.client.connected) return;
    this.requested = false;
    const epoch = this.epoch;
    this.running = this.run(epoch).catch(() => this.emit('status', { state: 'paused' })).then(() => {}).finally(() => {
      this.running = undefined;
      if (this.current(this.epoch) && (this.requested || epoch !== this.epoch)) this.kick();
    });
  }
  private async run(epoch: number): Promise<void> {
    this.store.cleanup();
    try { this.subscriptionId = z.strictObject({ subscriptionId: protocol.id }).parse(await this.call('file.subscribe', {}, epoch)).subscriptionId; } catch { return; }
    const record = [...this.store.records.values()].find(row => row.owner === this.owner && !protocol.terminal(row.state));
    if (!record) return;
    try {
      let receipt: protocol.TransferStatus | undefined;
      try { receipt = protocol.statusSchema.parse(await this.call('file.status', { transferId: record.manifest.transferId }, epoch)); }
      catch (error) { if (!(error instanceof ProtocolError) || error.code !== 'FILE_NOT_FOUND' || record.manifest.direction !== 'to-desktop') throw error; }
      if (receipt && JSON.stringify(receipt.manifest) !== JSON.stringify(record.manifest)) throw new ProtocolError('FILE_INTEGRITY');
      if ((!receipt || !protocol.terminal(receipt.state)) && record.manifest.direction === 'to-desktop') {
        if (!record.sourcePath || await hashFile(record.sourcePath, undefined, this.abort.signal) !== record.manifest.sha256) throw new ProtocolError('FILE_SOURCE_CHANGED');
        await this.call('file.offer', record.manifest, epoch);
      }
      const checkpoint = record.manifest.direction === 'to-client' && !protocol.terminal(receipt?.state ?? 'offered') ? { receivedBytes: record.nextOffset,
        prefixSha256: await hashFile(this.store.paths(record).partial, record.nextOffset, this.abort.signal) } : undefined;
      let status = receipt && protocol.terminal(receipt.state) ? receipt : protocol.statusSchema.parse(await this.call('file.resume', { transferId: record.manifest.transferId,
        ...(checkpoint ? { checkpoint } : {}) }, epoch));
      while (this.current(epoch)) {
        if (protocol.terminal(status.state)) {
          if (status.state === 'completed' && record.manifest.direction === 'to-client') await this.completeDownload(record, epoch);
          else {
            record.state = status.state; this.store.save(record);
            if (record.manifest.direction === 'to-client') removePartial(this.store.paths(record).partial);
          }
          this.emit('status', { transferId: record.manifest.transferId, state: record.state });
          return;
        }
        if (status.state === 'verifying') {
          await delay(100, undefined, { signal: this.abort.signal });
          status = protocol.statusSchema.parse(await this.call('file.status', { transferId: record.manifest.transferId }, epoch));
          continue;
        }
        if (status.state !== 'transferring' || !status.leaseId) throw new ProtocolError('FILE_INVALID_LEASE');
        const ref = { transferId: record.manifest.transferId, leaseId: status.leaseId };
        record.state = 'transferring';
        if (record.manifest.direction === 'to-desktop') record.nextOffset = status.nextOffset;
        if (record.nextOffset === record.manifest.sizeBytes) {
          if (record.manifest.direction === 'to-client'
            && await hashFile(this.store.paths(record).partial, undefined, this.abort.signal) !== record.manifest.sha256) throw new ProtocolError('FILE_INTEGRITY');
          status = protocol.statusSchema.parse(await this.call('file.finish', ref, epoch));
          continue;
        }
        if (record.manifest.direction === 'to-desktop') {
          const bytes = readChunk(record.sourcePath!, record.nextOffset, Math.min(protocol.CHUNK_BYTES, record.manifest.sizeBytes - record.nextOffset));
          const ack = await this.call('file.chunk', { ...ref, offset: record.nextOffset, dataBase64: bytes.toString('base64'), sha256: sha256(bytes) }, epoch);
          const next = z.strictObject({ transferId: protocol.id, nextOffset: protocol.offset, state: protocol.stateSchema }).parse(ack);
          if (next.transferId !== ref.transferId || next.nextOffset !== record.nextOffset + bytes.length) throw new ProtocolError('FILE_OFFSET');
          record.nextOffset = next.nextOffset;
        } else {
          const result = z.strictObject({ transferId: protocol.id, offset: protocol.offset, dataBase64: z.string().max(protocol.MAX_CHUNK_BASE64_BYTES), sha256: protocol.digest })
            .parse(await this.call('file.read', { ...ref, offset: record.nextOffset }, epoch));
          if (result.transferId !== ref.transferId || result.offset !== record.nextOffset) throw new ProtocolError('FILE_OFFSET');
          const bytes = decodeChunk(result.dataBase64, result.sha256, result.offset, record.manifest.sizeBytes);
          const previous = record.nextOffset;
          writeChunk(this.store.paths(record).partial, previous, bytes);
          record.nextOffset += bytes.length;
          try { this.store.save(record); } catch (error) { record.nextOffset = previous; throw error; }
          await this.call('file.ack', { ...ref, nextOffset: record.nextOffset, sha256: result.sha256 }, epoch);
        }
        this.store.save(record);
        status.nextOffset = record.nextOffset;
        this.emit('status', { transferId: record.manifest.transferId, state: 'transferring', committedBytes: record.nextOffset, sizeBytes: record.manifest.sizeBytes });
        // Offer other live feature requests a slot between chunks; no offline queue is retained.
        await delay(0, undefined, { signal: this.abort.signal });
      }
    } catch (error) {
      if (!protocol.terminal(record.state)) {
        record.state = error instanceof ProtocolError && !['BUSY', 'FILE_INVALID_LEASE', 'UNAUTHENTICATED'].includes(error.code) ? 'failed' : 'paused';
        if (record.state === 'failed') record.error = error instanceof ProtocolError && error.code.startsWith('FILE_') ? error.code : 'FILE_IO';
        try {
          this.store.save(record);
          if (record.state === 'failed' && record.manifest.direction === 'to-client') removePartial(this.store.paths(record).partial);
        } catch { /* Preserve the last durable checkpoint on storage failure. */ }
      }
      this.emit('status', { transferId: record.manifest.transferId, state: record.state });
    }
  }
  private async completeDownload(record: TransferRecord, epoch: number): Promise<void> {
    const paths = this.store.paths(record);
    if (await hashFile(paths.partial, undefined, this.abort.signal) !== record.manifest.sha256) throw new ProtocolError('FILE_INTEGRITY');
    if (!this.current(epoch)) throw new Error('Connection changed');
    if (existsSync(paths.destination)) {
      regularFile(paths.destination);
      const a = statSync(paths.partial); const b = statSync(paths.destination);
      if (a.ino !== b.ino || a.dev !== b.dev) throw new ProtocolError('FILE_IO');
    } else publishFile(paths.partial, paths.destination);
    record.state = 'completed'; this.store.save(record); removePartial(paths.partial);
  }
}
