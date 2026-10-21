import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { FileApi, type FileEnv, type FileSink, type FileSource } from '../src/files.js';
import { CommandError, NotSent, OrbitSession } from '../src/session.js';
import { FILE_CHUNK_BYTES, type TransferManifest } from '../src/protocol.js';
import { fromBase64, toBase64 } from '../src/base64.js';
import { FakeTransport, paired, parseSent } from './fakes.js';

const LEASE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const env: FileEnv = { uuid: () => 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', sha256Bytes: async b => hex(b) };
let n = 0;
const uuid = () => `ffffffff-ffff-4fff-8fff-${String(++n).padStart(12, '0')}`;

function memSource(name: string, bytes: Uint8Array): FileSource & { reads: number[] } {
  const reads: number[] = [];
  return { name, size: bytes.length, reads,
    sha256: async () => hex(bytes),
    read: async (offset, length) => { reads.push(offset); return bytes.subarray(offset, offset + length); } };
}
function memSink(): FileSink & { writes: number[]; finalized: boolean } {
  let bytes = new Uint8Array(0);
  const sink = { writes: [] as number[], finalized: false,
    size: async () => bytes.length,
    write: async (offset: number, chunk: Uint8Array) => { const next = new Uint8Array(offset + chunk.length); next.set(bytes); next.set(chunk, offset); bytes = next; sink.writes.push(offset); },
    sha256: async (length?: number) => hex(bytes.subarray(0, length)),
    finalize: async () => { sink.finalized = true; },
    discard: async () => { bytes = new Uint8Array(0); } };
  return sink;
}

async function setup(handler: (type: string, payload: any, ctx: { manifest?: TransferManifest }) => unknown) {
  const t = new FakeTransport();
  const s = new OrbitSession(paired, t, { uuid, retryBaseMs: 5, random: () => 0 });
  await s.start();
  const sent: { type: string; payload: any }[] = [];
  const ctx: { manifest?: TransferManifest } = {};
  t.last.onSend = text => { const m = parseSent(text); sent.push({ type: m.type, payload: m.payload });
    const r = handler(m.type, m.payload, ctx);
    if (r instanceof CommandError) return t.last.fail(m.requestId, r.code);
    t.last.reply(m.requestId, r); };
  return { t, s, sent, ctx, api: new FileApi(s, env, 1) };
}

test('an upload resumes from the computer offset, sends each chunk once in order and completes', async () => {
  const bytes = new Uint8Array(70_000).map((_, i) => i % 251);
  const source = memSource('notes.bin', bytes);
  let phase: 'pre' | 'run' | 'done' = 'pre';
  const received: Uint8Array[] = [];
  const { s, api } = await setup((type, p, ctx) => {
    if (type === 'file.status') return phase === 'done' ? { manifest: ctx.manifest, state: 'completed', nextOffset: bytes.length }
      : phase === 'pre' ? new CommandError('FILE_NOT_FOUND') : { manifest: ctx.manifest, state: 'verifying', nextOffset: bytes.length };
    if (type === 'file.offer') { ctx.manifest = p; phase = 'run'; return { manifest: p, state: 'transferring', nextOffset: 0, leaseId: LEASE }; }
    if (type === 'file.resume') return { manifest: ctx.manifest, state: 'transferring', nextOffset: FILE_CHUNK_BYTES, leaseId: LEASE };
    if (type === 'file.chunk') { received.push(fromBase64(p.dataBase64)); return { transferId: p.transferId, nextOffset: p.offset + received.at(-1)!.length, state: 'transferring' }; }
    if (type === 'file.finish') { phase = 'done'; return { manifest: ctx.manifest, state: 'verifying', nextOffset: bytes.length }; }
    throw new Error(`unexpected ${type}`);
  });
  await api.upload(source);
  const view = api.getState().transfer!;
  assert.equal(view.state, 'completed');
  assert.equal(view.doneBytes, bytes.length);
  assert.deepEqual(source.reads, [FILE_CHUNK_BYTES, FILE_CHUNK_BYTES * 2]);
  assert.equal(Buffer.concat(received.map(b => Buffer.from(b))).compare(Buffer.from(bytes.subarray(FILE_CHUNK_BYTES))), 0);
  await assert.rejects(api.retry(), NotSent); // a completed transfer leaves nothing to resume
  api.dispose(); s.stop();
});

test('an upload the computer acknowledges at the wrong offset fails instead of corrupting', async () => {
  const bytes = new Uint8Array(1000).fill(3);
  const source = memSource('data.bin', bytes);
  const { s, api } = await setup((type, p, ctx) => {
    if (type === 'file.status') return new CommandError('FILE_NOT_FOUND');
    if (type === 'file.offer') { ctx.manifest = p; return { manifest: p, state: 'transferring', nextOffset: 0, leaseId: LEASE }; }
    if (type === 'file.resume') return { manifest: ctx.manifest, state: 'transferring', nextOffset: 0, leaseId: LEASE };
    if (type === 'file.chunk') return { transferId: p.transferId, nextOffset: p.offset + 1, state: 'transferring' }; // an ack that does not match the chunk sent
    throw new Error(`unexpected ${type}`);
  });
  await assert.rejects(api.upload(source), (e: CommandError) => e instanceof CommandError && e.code === 'FILE_OFFSET');
  assert.equal(api.getState().transfer!.state, 'failed');
  assert.equal(api.getState().transfer!.doneBytes < bytes.length, true, 'never reports completion');
  api.dispose(); s.stop();
});

test('an upload the computer echoes with a different manifest fails before any bytes are sent', async () => {
  const bytes = new Uint8Array(1000).fill(5);
  const source = memSource('report.pdf', bytes);
  const { s, api } = await setup((type, p) => {
    if (type === 'file.status') return new CommandError('FILE_NOT_FOUND');
    if (type === 'file.offer') return { manifest: { ...p, sha256: hex(new Uint8Array(1000).fill(6)) }, state: 'transferring', nextOffset: 0, leaseId: LEASE }; // not the manifest the phone offered
    throw new Error(`unexpected ${type}`);
  });
  await assert.rejects(api.upload(source), (e: CommandError) => e instanceof CommandError && e.code === 'FILE_INTEGRITY');
  assert.equal(api.getState().transfer!.state, 'failed');
  assert.deepEqual(source.reads, [], 'no file bytes are read or sent against a mismatched manifest');
  api.dispose(); s.stop();
});

test('a source whose hash changes after the offer fails permanently and cannot be retried', async () => {
  const bytes = new Uint8Array(1000).fill(7);
  const source = memSource('changing.bin', bytes);
  const realSha = source.sha256;
  let calls = 0;
  source.sha256 = async () => { calls++; return calls === 1 ? realSha() : hex(new Uint8Array(1000).fill(9)); };
  const { s, api } = await setup((type, p, ctx) => {
    if (type === 'file.status') return new CommandError('FILE_NOT_FOUND');
    if (type === 'file.offer') { ctx.manifest = p; return { manifest: p, state: 'transferring', nextOffset: 0, leaseId: LEASE }; }
    throw new Error(`unexpected ${type}`);
  });
  await assert.rejects(api.upload(source), (e: unknown) => e instanceof CommandError && e.code === 'FILE_SOURCE_CHANGED');
  assert.equal(api.getState().transfer!.state, 'failed');
  await assert.rejects(api.retry(), NotSent);
  api.dispose(); s.stop();
});

test('a download chunk whose hash does not match is never written and fails the transfer', async () => {
  const manifest: TransferManifest = { transferId: env.uuid(), direction: 'to-client', name: 'photo.jpg', sizeBytes: 100, sha256: hex(new Uint8Array(100).fill(3)), chunkBytes: FILE_CHUNK_BYTES };
  const sink = memSink();
  const { s, api } = await setup(type => {
    if (type === 'file.status') return { manifest, state: 'transferring', nextOffset: 0, leaseId: LEASE };
    if (type === 'file.resume') return { manifest, state: 'transferring', nextOffset: 0, leaseId: LEASE };
    if (type === 'file.read') return { transferId: manifest.transferId, offset: 0, dataBase64: toBase64(new Uint8Array(100).fill(3)), sha256: hex(new Uint8Array(100).fill(4)) };
    throw new Error(`unexpected ${type}`);
  });
  await assert.rejects(api.download(manifest, sink), (e: unknown) => e instanceof CommandError && e.code === 'FILE_INTEGRITY');
  assert.equal(sink.writes.length, 0);
  assert.equal(api.getState().transfer!.state, 'failed');
  api.dispose(); s.stop();
});

test('a download chunk served at the wrong offset fails instead of corrupting the file', async () => {
  const manifest: TransferManifest = { transferId: env.uuid(), direction: 'to-client', name: 'video.mp4', sizeBytes: 100, sha256: hex(new Uint8Array(100).fill(3)), chunkBytes: FILE_CHUNK_BYTES };
  const sink = memSink();
  const { s, api } = await setup(type => {
    if (type === 'file.status') return { manifest, state: 'transferring', nextOffset: 0, leaseId: LEASE };
    if (type === 'file.resume') return { manifest, state: 'transferring', nextOffset: 0, leaseId: LEASE };
    if (type === 'file.read') return { transferId: manifest.transferId, offset: 50, dataBase64: toBase64(new Uint8Array(100).fill(3)), sha256: hex(new Uint8Array(100).fill(3)) }; // a chunk for the wrong position
    throw new Error(`unexpected ${type}`);
  });
  await assert.rejects(api.download(manifest, sink), (e: unknown) => e instanceof CommandError && e.code === 'FILE_OFFSET');
  assert.equal(sink.writes.length, 0, 'a wrong-offset chunk is never written');
  assert.equal(api.getState().transfer!.state, 'failed');
  api.dispose(); s.stop();
});

test('a download the computer calls complete is only trusted when the local bytes match', async () => {
  const manifest: TransferManifest = { transferId: env.uuid(), direction: 'to-client', name: 'archive.zip', sizeBytes: 100, sha256: hex(new Uint8Array(100).fill(3)), chunkBytes: FILE_CHUNK_BYTES };
  const sink = memSink();
  await sink.write(0, new Uint8Array(100).fill(9)); // local bytes that do not match the manifest
  const { s, api } = await setup(type => {
    if (type === 'file.status') return { manifest, state: 'completed', nextOffset: 100 };
    if (type === 'file.resume') return { manifest, state: 'completed', nextOffset: 100 };
    throw new Error(`unexpected ${type}`);
  });
  await assert.rejects(api.download(manifest, sink), (e: unknown) => e instanceof CommandError && e.code === 'FILE_INTEGRITY');
  assert.equal(api.getState().transfer!.state, 'failed');
  api.dispose(); s.stop();
});

test('watch loads waiting offers and a pushed offer is added once', async () => {
  const offer: TransferManifest = { transferId: LEASE, direction: 'to-client', name: 'a.txt', sizeBytes: 5, sha256: hex(new Uint8Array(5)), chunkBytes: FILE_CHUNK_BYTES };
  const { t, s, api } = await setup(type => type === 'file.subscribe' ? { subscriptionId: LEASE }
    : type === 'file.offers' ? { offers: [offer], nextCursor: null } : (() => { throw new Error(`unexpected ${type}`); })());
  await api.watch();
  assert.deepEqual(api.getState().offers.map(o => o.name), ['a.txt']);
  const pushOffer = (id: string, name: string) => t.last.deliver({ version: 1, type: 'event', requestId: null,
    payload: { eventType: 'file.offered', data: { subscriptionId: LEASE, manifest: { ...offer, transferId: id, name } } } });
  pushOffer(LEASE, 'a.txt');
  pushOffer('abababab-abab-4bab-8bab-abababababab', 'b.txt');
  assert.deepEqual(api.getState().offers.map(o => o.name), ['a.txt', 'b.txt']);
  api.dispose(); s.stop();
});
