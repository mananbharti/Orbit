/** Persists owned transfer checkpoints and applies quotas/expiry; depends on private filesystem storage; stores no activity history or credentials. */
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWrite } from '../security-pairing/atomic-file.js';
import { MAX_ACTIVE_TRANSFERS, MAX_PARTIAL_BYTES, TRANSFER_TTL_MS, id, manifestSchema, offset, stateSchema, terminal, type Manifest } from '../protocol/file-transfer.js';
import { ProtocolError } from '../protocol/errors.js';
import { createPartial, receivingPaths, recoverPartial, regularFile, removePartial, safeDirectory } from './file-storage.js';

const recordSchema = z.strictObject({ manifest: manifestSchema, owner: id, state: stateSchema, nextOffset: offset,
  updatedAt: z.number().int().nonnegative(), sourcePath: z.string().optional(), error: z.string().regex(/^FILE_[A-Z_]+$/).optional() });
export type TransferRecord = z.infer<typeof recordSchema>;
export class TransferStore {
  readonly records = new Map<string, TransferRecord>();
  readonly directory: string;
  readonly inbox: string;
  constructor(parent: string, inbox: string, private readonly receivingDirection: Manifest['direction'], private readonly now = Date.now) {
    this.directory = safeDirectory(join(parent, 'transfers'));
    this.inbox = safeDirectory(inbox);
    for (const name of readdirSync(this.directory)) {
      if (!name.endsWith('.json')) continue;
      const path = join(this.directory, name);
      regularFile(path);
      if (statSync(path).size > 16_384) throw new ProtocolError('FILE_IO');
      const record = recordSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
      if (name !== `${record.manifest.transferId}.json` || record.nextOffset > record.manifest.sizeBytes) throw new ProtocolError('FILE_IO');
      if (!terminal(record.state)) {
        record.state = 'paused';
        if (record.manifest.direction === receivingDirection) {
          try { recoverPartial(this.paths(record).partial, record.nextOffset); }
          catch { record.state = 'failed'; record.error = 'FILE_INTEGRITY'; }
        }
      }
      if (terminal(record.state) && record.manifest.direction === receivingDirection) removePartial(this.paths(record).partial);
      this.records.set(record.manifest.transferId, record);
    }
    this.cleanup();
  }
  paths(record: TransferRecord) { return receivingPaths(this.inbox, record.manifest.transferId, record.manifest.name); }
  save(record: TransferRecord, touch = true): void {
    if (touch) record.updatedAt = this.now();
    atomicWrite(join(this.directory, `${record.manifest.transferId}.json`), JSON.stringify(recordSchema.parse(record)));
    this.records.set(record.manifest.transferId, record);
  }
  get(transferId: string, owner: string): TransferRecord {
    const record = this.records.get(transferId);
    if (!record || record.owner !== owner) throw new ProtocolError('FILE_NOT_FOUND');
    return record;
  }
  create(manifest: Manifest, owner: string, sourcePath?: string): TransferRecord {
    this.cleanup();
    const existing = this.records.get(manifest.transferId);
    if (existing) {
      if (existing.owner !== owner) throw new ProtocolError('FILE_NOT_FOUND');
      if (JSON.stringify(existing.manifest) !== JSON.stringify(manifest)) throw new ProtocolError('FILE_INTEGRITY');
      return existing;
    }
    const active = [...this.records.values()].filter(record => !terminal(record.state));
    if (active.some(record => record.owner === owner) || active.length >= MAX_ACTIVE_TRANSFERS
      || active.filter(record => record.manifest.direction === this.receivingDirection)
        .reduce((sum, record) => sum + record.manifest.sizeBytes, this.orphanBytes()) + (manifest.direction === this.receivingDirection ? manifest.sizeBytes : 0) > MAX_PARTIAL_BYTES) {
      throw new ProtocolError('FILE_QUOTA');
    }
    const record: TransferRecord = { manifest, owner, state: 'offered', nextOffset: 0, updatedAt: this.now(), sourcePath };
    if (manifest.direction === this.receivingDirection) createPartial(this.paths(record).partial);
    try { this.save(record); } catch (error) {
      if (manifest.direction === this.receivingDirection) removePartial(this.paths(record).partial);
      throw error;
    }
    return record;
  }
  cleanup(): void {
    for (const record of this.records.values()) {
      if (terminal(record.state) && record.manifest.direction === this.receivingDirection) removePartial(this.paths(record).partial);
      if (this.now() - record.updatedAt < TRANSFER_TTL_MS) continue;
      if (record.manifest.direction === this.receivingDirection) removePartial(this.paths(record).partial);
      if (!terminal(record.state)) { record.state = 'expired'; this.save(record); }
      else {
        const path = join(this.directory, `${record.manifest.transferId}.json`);
        if (existsSync(path)) unlinkSync(path);
        this.records.delete(record.manifest.transferId);
      }
    }
    this.orphanBytes();
  }
  private orphanBytes(): number {
    let bytes = 0;
    // A crash between partial creation and the first checkpoint must not evade retention or quotas.
    for (const name of readdirSync(this.inbox)) {
      if (!name.startsWith('.') || !name.endsWith('.part')) continue;
      const transferId = name.slice(1, -5);
      if (!id.safeParse(transferId).success || this.records.has(transferId)) continue;
      const path = join(this.inbox, name);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if (this.now() - stat.mtimeMs >= TRANSFER_TTL_MS) unlinkSync(path);
      else bytes += stat.size;
    }
    return bytes;
  }
}
