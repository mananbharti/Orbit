import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { FileApi, type FileEnv, type FileSink } from '../src/files.js';
import { CommandError, NotSent, OrbitSession } from '../src/session.js';
import { FILE_CHUNK_BYTES, type TransferManifest } from '../src/protocol.js';
import { FakeTransport, paired, parseSent } from './fakes.js';

const LEASE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const env: FileEnv = { uuid: () => 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', sha256Bytes: async b => hex(b) };
let n = 0;
const uuid = () => `99999999-9999-4999-8999-${String(++n).padStart(12, '0')}`;
const offer = (id: string, name: string): TransferManifest => ({ transferId: id, direction: 'to-client', name, sizeBytes: 5, sha256: hex(new Uint8Array(5)), chunkBytes: FILE_CHUNK_BYTES });
const id = (i: number) => `abababab-abab-4bab-8bab-${String(i).padStart(12, '0')}`;

async function setup(handler: (type: string, payload: any) => unknown) {
  const t = new FakeTransport();
  const s = new OrbitSession(paired, t, { uuid, retryBaseMs: 5, random: () => 0 });
  await s.start();
  const sent: { type: string; payload: any }[] = [];
  t.last.onSend = text => { const m = parseSent(text); sent.push({ type: m.type, payload: m.payload });
    const r = handler(m.type, m.payload);
    if (r instanceof CommandError) return t.last.fail(m.requestId, r.code);
    t.last.reply(m.requestId, r); };
  return { t, s, sent, api: new FileApi(s, env, 1) };
}

test('the offer list walks at most 8 pages and never loops on a desktop that always has more', async () => {
  const { s, sent, api } = await setup(type => {
    if (type === 'file.subscribe') return { subscriptionId: LEASE };
    const page = sent.filter(c => c.type === 'file.offers').length;
    return { offers: [offer(id(page), `f${page}.txt`)], nextCursor: uuid() };
  });
  await api.watch();
  assert.equal(sent.filter(c => c.type === 'file.offers').length, 8);
  assert.equal(api.getState().offers.length, 8);
  api.dispose(); s.stop();
});
test('a malformed offered event is ignored, a valid one still lands', async () => {
  const { t, s, api } = await setup(type => type === 'file.subscribe' ? { subscriptionId: LEASE } : { offers: [], nextCursor: null });
  await api.watch();
  t.last.deliver({ version: 1, type: 'event', requestId: null, payload: { eventType: 'file.offered', data: { subscriptionId: LEASE, manifest: { nope: 1 } } } });
  t.last.deliver({ version: 1, type: 'event', requestId: null, payload: { eventType: 'file.offered', data: 'garbage' } });
  assert.deepEqual(api.getState().offers, []);
  t.last.deliver({ version: 1, type: 'event', requestId: null, payload: { eventType: 'file.offered', data: { subscriptionId: LEASE, manifest: offer(id(1), 'ok.txt') } } });
  assert.deepEqual(api.getState().offers.map(o => o.name), ['ok.txt']);
  api.dispose(); s.stop();
});
test('a dropped lease pauses the download and retry picks it up again', async () => {
  const m: TransferManifest = { transferId: id(7), direction: 'to-client', name: 'empty.bin', sizeBytes: 0, sha256: hex(new Uint8Array(0)), chunkBytes: FILE_CHUNK_BYTES };
  let attempts = 0;
  const { s, api } = await setup(type => {
    if (type === 'file.status') return { manifest: m, state: 'transferring', nextOffset: 0, leaseId: LEASE };
    if (type === 'file.resume') { attempts++; return attempts === 1 ? { manifest: m, state: 'transferring', nextOffset: 0 } : { manifest: m, state: 'completed', nextOffset: 0, leaseId: LEASE }; }
    throw new Error(`unexpected ${type}`);
  });
  const sink: FileSink & { finalized: boolean } = { finalized: false, size: async () => 0, write: async () => {}, sha256: async () => hex(new Uint8Array(0)), finalize: async () => { sink.finalized = true; }, discard: async () => {} };
  await assert.rejects(api.download(m, sink), (e: CommandError) => e.code === 'FILE_INVALID_LEASE');
  assert.equal(api.getState().transfer?.state, 'paused');
  await api.retry();
  assert.equal(sink.finalized, true);
  assert.equal(api.getState().transfer?.state, 'completed');
  api.dispose(); s.stop();
});
test('cancelling a paused transfer survives the computer being unreachable', async () => {
  const m: TransferManifest = { transferId: id(8), direction: 'to-client', name: 'x.bin', sizeBytes: 0, sha256: hex(new Uint8Array(0)), chunkBytes: FILE_CHUNK_BYTES };
  const { s, api } = await setup(type => {
    if (type === 'file.status') return { manifest: m, state: 'transferring', nextOffset: 0, leaseId: LEASE };
    if (type === 'file.resume') return { manifest: m, state: 'transferring', nextOffset: 0 };
    if (type === 'file.cancel') return new CommandError('GONE' as never);
    throw new Error(`unexpected ${type}`);
  });
  const sink: FileSink = { size: async () => 0, write: async () => {}, sha256: async () => hex(new Uint8Array(0)), finalize: async () => {}, discard: async () => {} };
  await assert.rejects(api.download(m, sink), CommandError);
  await api.cancel();
  assert.equal(api.getState().transfer?.state, 'cancelled');
  await assert.rejects(api.retry(), NotSent);
  api.dispose(); s.stop();
});
