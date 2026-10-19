/** Phone core sends and receives files through the real desktop service with synthetic files only. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { startDesktop } from '../../../desktop/src/desktop-service.js';
import { FileApi, type FileEnv, type FileSink, type FileSource } from '../../core/src/files.js';
import { pairWithQr } from '../../core/src/pairing.js';
import { OrbitSession } from '../../core/src/session.js';
import { NodePinnedTransport } from './node-pinned-transport.js';

const env: FileEnv = { uuid: randomUUID, sha256Bytes: async b => createHash('sha256').update(b).digest('hex') };

const memorySource = (name: string, data: Buffer): FileSource => ({ name, size: data.length,
  sha256: async () => createHash('sha256').update(data).digest('hex'), read: async (o, l) => new Uint8Array(data.subarray(o, o + l)) });
function memorySink() {
  let data = Buffer.alloc(0); let finalized = false;
  const sink: FileSink = {
    size: async () => data.length,
    write: async (o, b) => { assert.equal(o, data.length); data = Buffer.concat([data, Buffer.from(b)]); },
    sha256: async n => createHash('sha256').update(data.subarray(0, n ?? data.length)).digest('hex'),
    finalize: async () => { finalized = true; }, discard: async () => { data = Buffer.alloc(0); } };
  return { sink, get data() { return data; }, get finalized() { return finalized; } };
}

async function phone(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-phone-files-'));
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false });
  const transport = new NodePinnedTransport(new Map());
  const qr = service.pairing.open();
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  const session = new OrbitSession(paired, transport, { uuid: randomUUID });
  const api = new FileApi(session, env, 10);
  t.after(async () => { api.dispose(); session.stop(); await service.stop(); rmSync(root, { recursive: true, force: true }); });
  await session.start();
  return { api, service, root, deviceId: paired.deviceId };
}
const received = (root: string): Buffer[] => {
  const out: Buffer[] = [];
  const walk = (dir: string): void => { for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name); if (e.isDirectory()) walk(p); else if (!e.name.endsWith('.partial')) out.push(readFileSync(p)); } };
  walk(root); return out;
};

test('a multi-chunk file sent from the phone arrives intact on the desktop', async t => {
  const f = await phone(t);
  const data = randomBytes(100_000);
  await f.api.upload(memorySource('photo.bin', data));
  assert.equal(f.api.getState().transfer?.state, 'completed');
  assert.ok(received(f.root).some(b => b.equals(data)));
});
test('an interrupted upload resumes from where it stopped, not from zero', async t => {
  const f = await phone(t);
  const data = randomBytes(100_000);
  const reads: number[] = [];
  let failAt = 2; // die during the third chunk read
  const flaky: FileSource = { name: 'resume.bin', size: data.length,
    sha256: async () => createHash('sha256').update(data).digest('hex'),
    read: async (o, l) => { reads.push(o); if (failAt-- <= 0 && o > 0) throw new Error('network died'); return new Uint8Array(data.subarray(o, o + l)); } };
  await assert.rejects(f.api.upload(flaky));
  assert.equal(f.api.getState().transfer?.state, 'paused'); // honest pause, not a fake failure or a hang
  failAt = Number.MAX_SAFE_INTEGER;
  reads.length = 0;
  await f.api.retry();
  assert.equal(f.api.getState().transfer?.state, 'completed');
  assert.ok(received(f.root).some(b => b.equals(data)));
  assert.equal(reads[0]! > 0, true, `resumed from an offset, got reads at ${reads.join(',')}`);
});

test('an empty-looking small file also transfers', async t => {
  const f = await phone(t);
  const data = Buffer.from('hello');
  await f.api.upload(memorySource('note.txt', data));
  assert.ok(received(f.root).some(b => b.equals(data)));
});
test('a file offered by the desktop is received and verified on the phone', async t => {
  const f = await phone(t);
  const data = randomBytes(70_000);
  const path = join(f.root, 'from-pc.bin'); writeFileSync(path, data);
  await f.api.watch();
  await f.service.files.offerLocal(path, f.deviceId);
  const [offer] = await f.api.refreshOffers();
  assert.ok(offer);
  const sink = memorySink();
  await f.api.download(offer, sink.sink);
  assert.ok(sink.data.equals(data));
  assert.equal(sink.finalized, true);
  assert.equal(f.api.getState().transfer?.state, 'completed');
});
test('a changed source file is refused instead of sending mixed content', async t => {
  const f = await phone(t);
  const data = randomBytes(50_000);
  let calls = 0;
  const src = memorySource('x.bin', data);
  const flaky: FileSource = { ...src, sha256: async () => (++calls <= 1 ? src.sha256() : 'f'.repeat(64)) };
  await assert.rejects(f.api.upload(flaky));
  assert.equal(f.api.getState().transfer?.state, 'failed');
});

test('cancelling a paused upload wipes the partial on the desktop and nothing can resume it', async t => {
  const f = await phone(t);
  const data = randomBytes(100_000);
  let failAt = 1; // deliver one chunk, then stall out like a dead network
  const flaky: FileSource = { name: 'cancel.bin', size: data.length,
    sha256: async () => createHash('sha256').update(data).digest('hex'),
    read: async (o, l) => { if (failAt-- <= 0) throw new Error('network died'); return new Uint8Array(data.subarray(o, o + l)); } };
  await assert.rejects(f.api.upload(flaky));
  assert.equal(f.api.getState().transfer?.state, 'paused');
  const id = f.api.getState().transfer!.transferId;
  await f.api.cancel();
  assert.equal(f.api.getState().transfer?.state, 'cancelled');
  await assert.rejects(f.api.retry(), /nothing to resume/i); // the phone itself refuses: a cancelled transfer is dead
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
    .flatMap(e => { const p = join(dir, e.name); return e.isDirectory() ? walk(p) : [p]; });
  const leftovers = walk(f.root).filter(p => p.endsWith('.partial'));
  assert.deepEqual(leftovers, [], 'the partial bytes were wiped, nothing resume-shaped remains');
  const record = JSON.parse(readFileSync(join(f.root, 'private', 'transfers', id + '.json'), 'utf8'));
  assert.equal(record.state, 'cancelled', 'the desktop remembers it as cancelled, never as delivered');
  assert.ok(!received(f.root).some(b => b.equals(data)), 'the full file never materialized');
});
