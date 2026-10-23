/** Unit-pins FileClient integrity guards against a misbehaving peer; depends on real temp files and the protocol schemas. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test, type TestContext } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { FileClient } from '../src/integration-client/file-client.js';
import type { OrbitClient } from '../src/integration-client/orbit-client.js';
import { success, failure, type JsonValue, type ResponseMessage } from '../src/protocol/messages.js';
import { CHUNK_BYTES, type Manifest } from '../src/protocol/file-transfer.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('state did not arrive'); await new Promise(r => setTimeout(r, 10)); }
};

type Handler = (payload: Record<string, unknown>) => ResponseMessage | Promise<ResponseMessage>;
function stubClient(handlers: Record<string, Handler>) {
  const emitter = new EventEmitter();
  const client = Object.assign(emitter, {
    connected: true,
    stop: () => { client.connected = false; },
    scheduledCommand: async (type: string, payload: JsonValue) => {
      const handler = handlers[type];
      if (!handler) throw new Error(`unexpected command ${type}`);
      return handler(payload as Record<string, unknown>);
    },
  });
  return client as unknown as OrbitClient & { connected: boolean };
}

function setup(t: TestContext, handlers: Record<string, Handler>) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-fc-hard-'));
  mkdirSync(join(root, 'files'));
  const owner = randomUUID();
  const client = stubClient(handlers);
  const fc = new FileClient(client, join(root, 'files'), owner);
  t.after(async () => { await fc.stop(); rmSync(root, { recursive: true, force: true }); });
  return { root, owner, client, fc, inbox: join(root, 'files', 'received') };
}

const dlManifest = (transferId: string, sizeBytes: number, digest: string): Manifest =>
  ({ transferId, direction: 'to-client', name: 'dl.bin', sizeBytes, sha256: digest, chunkBytes: CHUNK_BYTES });
const okSub = { 'file.subscribe': () => success('r', { subscriptionId: randomUUID() } as never) };

test('a receipt manifest that differs from the stored one fails with FILE_INTEGRITY', async t => {
  const s = setup(t, { ...okSub,
    'file.status': () => success('r', { manifest: { transferId: tid, direction: 'to-desktop', name: 'src.txt',
      sizeBytes: 6, sha256: sha('tampered'), chunkBytes: CHUNK_BYTES }, state: 'offered', nextOffset: 0 } as never) });
  const source = join(s.root, 'src.txt'); writeFileSync(source, 'hello!');
  const tid = await s.fc.upload(source);
  await waitFor(() => s.fc.store.get(tid, s.owner).state === 'failed');
  assert.equal(s.fc.store.get(tid, s.owner).error, 'FILE_INTEGRITY');
});

test('a source file changed after upload fails with FILE_SOURCE_CHANGED instead of sending new bytes under the old hash', async t => {
  let release: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const s = setup(t, { 'file.subscribe': async () => { await gate; return success('r', { subscriptionId: randomUUID() } as never); },
    'file.status': () => failure('r', 'FILE_NOT_FOUND' as never) });
  const source = join(s.root, 'src.txt'); writeFileSync(source, 'hello!');
  const tid = await s.fc.upload(source);
  writeFileSync(source, 'CHANGED'); // same length, different bytes
  release!();
  await waitFor(() => s.fc.store.get(tid, s.owner).state === 'failed');
  assert.equal(s.fc.store.get(tid, s.owner).error, 'FILE_SOURCE_CHANGED');
});

test('per-chunk-valid bytes that do not add up to the manifest hash fail with FILE_INTEGRITY at finish', async t => {
  const tid = randomUUID();
  const manifest = dlManifest(tid, 6, sha('expect'));
  const s = setup(t, { ...okSub,
    'file.status': () => success('r', { manifest, state: 'transferring', nextOffset: 0, leaseId: randomUUID() } as never),
    'file.accept': () => success('r', {} as never),
    'file.resume': () => success('r', { manifest, state: 'transferring', nextOffset: 0, leaseId: randomUUID() } as never),
    'file.read': () => success('r', { transferId: tid, offset: 0,
      dataBase64: Buffer.from('actual').toString('base64'), sha256: sha('actual') } as never),
    'file.ack': () => success('r', {} as never) });
  await s.fc.download(tid);
  await waitFor(() => s.fc.store.get(tid, s.owner).state === 'failed');
  assert.equal(s.fc.store.get(tid, s.owner).error, 'FILE_INTEGRITY');
});

test('an upload ack with a wrong nextOffset fails with FILE_OFFSET', async t => {
  const s = setup(t, { ...okSub,
    'file.status': () => failure('r', 'FILE_NOT_FOUND' as never),
    'file.offer': () => success('r', {} as never),
    'file.resume': () => success('r', { manifest: stored(), state: 'transferring', nextOffset: 0, leaseId: randomUUID() } as never),
    'file.chunk': () => success('r', { transferId: tid, nextOffset: 999, state: 'transferring' } as never) });
  const source = join(s.root, 'src.txt'); writeFileSync(source, 'hello!');
  const stored = () => s.fc.store.get(tid, s.owner).manifest;
  const tid = await s.fc.upload(source);
  await waitFor(() => s.fc.store.get(tid, s.owner).state === 'failed');
  assert.equal(s.fc.store.get(tid, s.owner).error, 'FILE_OFFSET');
});

test('a download chunk for a wrong offset fails with FILE_OFFSET', async t => {
  const tid = randomUUID();
  const manifest = dlManifest(tid, 6, sha('actual'));
  const s = setup(t, { ...okSub,
    'file.status': () => success('r', { manifest, state: 'transferring', nextOffset: 0, leaseId: randomUUID() } as never),
    'file.accept': () => success('r', {} as never),
    'file.resume': () => success('r', { manifest, state: 'transferring', nextOffset: 0, leaseId: randomUUID() } as never),
    'file.read': () => success('r', { transferId: tid, offset: 3,
      dataBase64: Buffer.from('actual').toString('base64'), sha256: sha('actual') } as never) });
  await s.fc.download(tid);
  await waitFor(() => s.fc.store.get(tid, s.owner).state === 'failed');
  assert.equal(s.fc.store.get(tid, s.owner).error, 'FILE_OFFSET');
});

test('an unrelated file already sitting at the destination fails with FILE_IO instead of being replaced', async t => {
  const tid = randomUUID();
  const manifest = dlManifest(tid, 6, sha('actual'));
  const s = setup(t, { ...okSub,
    'file.status': () => success('r', { manifest, state: 'transferring', nextOffset: 0, leaseId: randomUUID() } as never),
    'file.accept': () => success('r', {} as never),
    'file.resume': () => success('r', { manifest, state: 'transferring', nextOffset: 0, leaseId: randomUUID() } as never),
    'file.read': () => success('r', { transferId: tid, offset: 0,
      dataBase64: Buffer.from('actual').toString('base64'), sha256: sha('actual') } as never),
    'file.ack': () => success('r', {} as never),
    'file.finish': () => success('r', { manifest, state: 'completed', nextOffset: 6 } as never) });
  mkdirSync(s.inbox, { recursive: true });
  writeFileSync(join(s.inbox, `${tid}-dl.bin`), 'pre-existing unrelated file');
  await s.fc.download(tid);
  await waitFor(() => s.fc.store.get(tid, s.owner).state === 'failed');
  assert.equal(s.fc.store.get(tid, s.owner).error, 'FILE_IO');
  assert.equal(readFileSync(join(s.inbox, `${tid}-dl.bin`), 'utf8'), 'pre-existing unrelated file');
});
