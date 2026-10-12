/** Phone side of file transfer: sends or receives one explicitly chosen file at a time; depends on OrbitSession; never browses folders or keeps bytes beyond the sink the app provides. */
import { fromBase64, toBase64 } from './base64.js';
import { InvalidDesktopReply } from './agent.js';
import { FILE_CHUNK_BYTES, fileChunkAckSchema, fileOfferedEventSchema, fileOffersSchema, fileReadResultSchema, fileSubscriptionSchema,
  transferManifestSchema, transferStatusSchema, type TransferManifest, type TransferState, type TransferStatus } from './protocol.js';
import { CommandError, NotSent, type DesktopEvent, type OrbitSession } from './session.js';

/** Platform pieces the app supplies (expo-crypto, expo-file-system); tests use Node. */
export interface FileEnv {
  uuid(): string;
  sha256Bytes(bytes: Uint8Array): Promise<string>;
}
export interface FileSource { name: string; size: number; sha256(): Promise<string>; read(offset: number, length: number): Promise<Uint8Array> }
export interface FileSink {
  /** Bytes already stored (for resume). */
  size(): Promise<number>;
  write(offset: number, bytes: Uint8Array): Promise<void>;
  /** SHA-256 of the first `length` bytes, or all bytes when omitted. */
  sha256(length?: number): Promise<string>;
  /** Called once the whole file is verified. */
  finalize(): Promise<void>;
  discard(): Promise<void>;
}
export interface TransferView {
  transferId: string; name: string; direction: 'to-desktop' | 'to-client';
  state: TransferState | 'preparing'; doneBytes: number; sizeBytes: number; error?: string;
}
export interface FilesState { transfer?: TransferView; offers: TransferManifest[] }

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export class FileApi {
  private state: FilesState = { offers: [] };
  private listeners = new Set<() => void>();
  private busy = false;
  private cancelled = false;
  private retryJob?: () => Promise<void>;
  private offs: (() => void)[] = [];

  constructor(private readonly session: OrbitSession, private readonly env: FileEnv, private readonly pollMs = 100) {
    this.offs.push(session.onEvent(e => this.onEvent(e)));
  }
  getState = (): FilesState => this.state;
  subscribe = (l: () => void): (() => void) => { this.listeners.add(l); return () => this.listeners.delete(l); };
  dispose(): void { for (const off of this.offs.splice(0)) off(); this.listeners.clear(); }

  /** Starts listening for files the computer offers and loads any already waiting. */
  async watch(): Promise<void> {
    const sub = fileSubscriptionSchema.safeParse(await this.session.command('file.subscribe', {}));
    if (!sub.success) throw new InvalidDesktopReply();
    await this.refreshOffers();
  }
  async refreshOffers(): Promise<TransferManifest[]> {
    const all: TransferManifest[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 8; page++) {
      const parsed = fileOffersSchema.safeParse(await this.session.command('file.offers', cursor ? { cursor } : {}));
      if (!parsed.success) throw new InvalidDesktopReply();
      all.push(...parsed.data.offers);
      cursor = parsed.data.nextCursor;
      if (!cursor) break;
    }
    this.set({ ...this.state, offers: all });
    return all;
  }

  /** Sends a chosen file to the computer. Resolves when the computer has verified it. */
  async upload(source: FileSource): Promise<void> {
    this.begin();
    try {
      this.set({ ...this.state, transfer: { transferId: '', name: source.name, direction: 'to-desktop', state: 'preparing', doneBytes: 0, sizeBytes: source.size } });
      const manifest = transferManifestSchema.parse({ transferId: this.env.uuid(), direction: 'to-desktop', name: source.name,
        sizeBytes: source.size, sha256: await source.sha256(), chunkBytes: FILE_CHUNK_BYTES });
      this.retryJob = () => this.runUpload(manifest, source);
      await this.runUpload(manifest, source);
    } catch (error) { this.fail(error); throw error; } finally { this.busy = false; }
  }
  /** Downloads a file the computer offered into the sink. */
  async download(manifest: TransferManifest, sink: FileSink): Promise<void> {
    this.begin();
    try {
      this.retryJob = () => this.runDownload(manifest, sink);
      await this.runDownload(manifest, sink);
    } catch (error) { this.fail(error); throw error; } finally { this.busy = false; }
  }
  /** Continues the last interrupted transfer from where the computer says it stopped. */
  async retry(): Promise<void> {
    if (!this.retryJob) throw new NotSent('Nothing to resume');
    this.begin();
    try { await this.retryJob(); } catch (error) { this.fail(error); throw error; } finally { this.busy = false; }
  }
  async cancel(): Promise<void> {
    const t = this.state.transfer;
    this.cancelled = true;
    if (!t?.transferId) return;
    try { await this.session.command('file.cancel', { transferId: t.transferId }); } catch { /* connection gone; the computer expires it */ }
    this.retryJob = undefined;
    this.set({ ...this.state, transfer: { ...t, state: 'cancelled' } });
  }

  private begin(): void {
    if (this.busy) throw new NotSent('Another transfer is running');
    this.busy = true; this.cancelled = false;
  }
  private fail(error: unknown): void {
    const t = this.state.transfer;
    if (!t || t.state === 'cancelled') return;
    const code = error instanceof CommandError ? error.code : undefined;
    const permanent = code?.startsWith('FILE_') && code !== 'FILE_INVALID_LEASE';
    if (permanent) this.retryJob = undefined;
    this.set({ ...this.state, transfer: { ...t, state: permanent ? 'failed' : 'paused', ...(code ? { error: code } : {}) } });
  }
  private async call<T>(type: string, payload: Record<string, unknown>, parse: (v: unknown) => T | undefined): Promise<T> {
    if (this.cancelled) throw new NotSent('Transfer cancelled');
    const out = parse(await this.session.command(type, payload as never));
    if (out === undefined) throw new InvalidDesktopReply();
    return out;
  }
  private status(type: string, payload: Record<string, unknown>): Promise<TransferStatus> {
    return this.call(type, payload, v => { const p = transferStatusSchema.safeParse(v); return p.success ? p.data : undefined; });
  }
  private progress(m: TransferManifest, state: TransferState, doneBytes: number): void {
    this.set({ ...this.state, transfer: { transferId: m.transferId, name: m.name, direction: m.direction, state, doneBytes, sizeBytes: m.sizeBytes } });
  }
  /** Waits out the computer's verification step and returns the final status. */
  private async settle(m: TransferManifest, status: TransferStatus): Promise<TransferStatus> {
    let s = status;
    for (let i = 0; s.state === 'verifying' && i < 600; i++) { await wait(this.pollMs); s = await this.status('file.status', { transferId: m.transferId }); }
    return s;
  }

  private async runUpload(m: TransferManifest, source: FileSource): Promise<void> {
    this.progress(m, 'offered', 0);
    let status: TransferStatus;
    try { status = await this.status('file.status', { transferId: m.transferId }); }
    catch (e) {
      if (!(e instanceof CommandError && e.code === 'FILE_NOT_FOUND')) throw e;
      status = await this.status('file.offer', m as never);
    }
    if (JSON.stringify(status.manifest) !== JSON.stringify(m)) throw new CommandError('FILE_INTEGRITY');
    if (status.state !== 'completed') {
      if (await source.sha256() !== m.sha256 || source.size !== m.sizeBytes) throw new CommandError('FILE_SOURCE_CHANGED');
      status = await this.status('file.resume', { transferId: m.transferId });
    }
    for (;;) {
      if (status.state === 'completed') { this.progress(m, 'completed', m.sizeBytes); this.retryJob = undefined; return; }
      if (status.state === 'verifying') { status = await this.settle(m, status); continue; }
      if (status.state !== 'transferring' || !status.leaseId) throw new CommandError(status.error ? 'FILE_IO' : 'FILE_INVALID_STATE');
      const ref = { transferId: m.transferId, leaseId: status.leaseId };
      let next = status.nextOffset;
      if (next === m.sizeBytes) { status = await this.status('file.finish', ref); continue; }
      const bytes = await source.read(next, Math.min(FILE_CHUNK_BYTES, m.sizeBytes - next));
      if (bytes.length === 0) throw new CommandError('FILE_SOURCE_CHANGED');
      const ack = await this.call('file.chunk', { ...ref, offset: next, dataBase64: toBase64(bytes), sha256: await this.env.sha256Bytes(bytes) },
        v => { const p = fileChunkAckSchema.safeParse(v); return p.success ? p.data : undefined; });
      if (ack.transferId !== m.transferId || ack.nextOffset !== next + bytes.length) throw new CommandError('FILE_OFFSET');
      next = ack.nextOffset;
      this.progress(m, 'transferring', next);
      status = { ...status, nextOffset: next };
    }
  }

  private async runDownload(m: TransferManifest, sink: FileSink): Promise<void> {
    if (m.direction !== 'to-client') throw new CommandError('FILE_INVALID_STATE');
    const have = await sink.size();
    this.progress(m, 'offered', have);
    let status = await this.status('file.status', { transferId: m.transferId });
    if (JSON.stringify(status.manifest) !== JSON.stringify(m)) throw new CommandError('FILE_INTEGRITY');
    const checkpoint = { receivedBytes: have, prefixSha256: await sink.sha256(have) };
    status = await this.status('file.resume', { transferId: m.transferId, checkpoint });
    let done = status.nextOffset;
    for (;;) {
      if (status.state === 'completed') {
        if (await sink.sha256() !== m.sha256) throw new CommandError('FILE_INTEGRITY');
        await sink.finalize(); this.retryJob = undefined; this.progress(m, 'completed', m.sizeBytes); return;
      }
      if (['cancelled', 'failed', 'expired'].includes(status.state)) throw new CommandError('FILE_INVALID_STATE');
      if (status.state === 'verifying') { status = await this.settle(m, status); continue; }
      if (status.state !== 'transferring' || !status.leaseId) throw new CommandError('FILE_INVALID_LEASE');
      const ref = { transferId: m.transferId, leaseId: status.leaseId };
      if (done === m.sizeBytes) {
        if (await sink.sha256() !== m.sha256) throw new CommandError('FILE_INTEGRITY');
        status = await this.status('file.finish', ref); continue;
      }
      const chunk = await this.call('file.read', { ...ref, offset: done }, v => { const p = fileReadResultSchema.safeParse(v); return p.success ? p.data : undefined; });
      if (chunk.transferId !== m.transferId || chunk.offset !== done) throw new CommandError('FILE_OFFSET');
      let bytes: Uint8Array;
      try { bytes = fromBase64(chunk.dataBase64); } catch { throw new CommandError('FILE_INTEGRITY'); }
      if (bytes.length === 0 || done + bytes.length > m.sizeBytes || await this.env.sha256Bytes(bytes) !== chunk.sha256) throw new CommandError('FILE_INTEGRITY');
      await sink.write(done, bytes);
      done += bytes.length;
      await this.call('file.ack', { ...ref, nextOffset: done, sha256: chunk.sha256 }, v => fileChunkAckSchema.safeParse(v).success ? true : undefined);
      this.progress(m, 'transferring', done);
      status = { ...status, nextOffset: done };
    }
  }

  private onEvent(event: DesktopEvent): void {
    if (event.eventType !== 'file.offered') return;
    const parsed = fileOfferedEventSchema.safeParse(event.data);
    if (!parsed.success || this.state.offers.some(o => o.transferId === parsed.data.manifest.transferId)) return;
    this.set({ ...this.state, offers: [...this.state.offers, parsed.data.manifest] });
  }
  private set(next: FilesState): void { this.state = next; for (const l of [...this.listeners]) l(); }
}
