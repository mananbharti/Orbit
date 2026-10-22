import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { FileApi, type FileEnv, type FileSource } from '../src/files.js';
import { NotSent, OrbitSession } from '../src/session.js';
import { FILE_CHUNK_BYTES, type TransferManifest } from '../src/protocol.js';
import { FakeTransport, paired, parseSent, sleep } from './fakes.js';

const LEASE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const env: FileEnv = { uuid: () => 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', sha256Bytes: async b => hex(b) };
let n = 0;
const uuid = () => `99999999-9999-4999-8999-${String(++n).padStart(12, '0')}`;
const offer = (id: string, name: string): TransferManifest => ({ transferId: id, direction: 'to-client', name, sizeBytes: 5, sha256: hex(new Uint8Array(5)), chunkBytes: FILE_CHUNK_BYTES });
const ID_B = 'abababab-abab-4bab-8bab-abababababab';

test('an offer pushed while the offer list is loading is kept when the older list arrives', async () => {
  const t = new FakeTransport();
  const s = new OrbitSession(paired, t, { uuid, retryBaseMs: 5, random: () => 0 });
  await s.start();
  let answerOffers: () => void = () => {};
  t.last.onSend = text => {
    const m = parseSent(text);
    if (m.type === 'file.subscribe') t.last.reply(m.requestId, { subscriptionId: LEASE });
    else answerOffers = () => t.last.reply(m.requestId, { offers: [offer(LEASE, 'a.txt')], nextCursor: null });
  };
  const api = new FileApi(s, env, 1);
  const watching = api.watch();
  await sleep(20);
  t.last.deliver({ version: 1, type: 'event', requestId: null,
    payload: { eventType: 'file.offered', data: { subscriptionId: LEASE, manifest: offer(ID_B, 'b.txt') } } });
  await sleep(5);
  answerOffers();
  await watching;
  assert.deepEqual(api.getState().offers.map(o => o.name).sort(), ['a.txt', 'b.txt']);
  api.dispose(); s.stop();
});

test('cancelling while the file is still being prepared stops the upload and leaves nothing to resume', async () => {
  const t = new FakeTransport();
  const s = new OrbitSession(paired, t, { uuid, retryBaseMs: 5, random: () => 0 });
  await s.start();
  const sent: string[] = [];
  t.last.onSend = text => { sent.push(parseSent(text).type); };
  const api = new FileApi(s, env, 1);
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const source: FileSource = { name: 'big.bin', size: 10, sha256: async () => { await gate; return hex(new Uint8Array(10)); }, read: async () => new Uint8Array(10) };
  const upload = api.upload(source);
  const outcome = upload.then(() => 'done', (error: unknown) => error);
  await sleep(5);
  await api.cancel();
  release();
  assert.ok(await outcome instanceof NotSent);
  assert.equal(api.getState().transfer?.state, 'cancelled');
  await assert.rejects(api.retry(), NotSent);
  assert.deepEqual(sent, []);
  api.dispose(); s.stop();
});

test('a refresh replaces the list: an offer the computer no longer lists disappears, and one pushed during the load is not duplicated', async () => {
  const t = new FakeTransport();
  const s = new OrbitSession(paired, t, { uuid, retryBaseMs: 5, random: () => 0 });
  await s.start();
  let listed = [offer(LEASE, 'a.txt')];
  let hold = false;
  let answer: () => void = () => {};
  t.last.onSend = text => {
    const m = parseSent(text);
    if (m.type === 'file.offers') { const reply = () => t.last.reply(m.requestId, { offers: listed, nextCursor: null }); if (hold) answer = reply; else reply(); }
  };
  const api = new FileApi(s, env, 1);
  await api.refreshOffers();
  listed = [];
  await api.refreshOffers();
  assert.deepEqual(api.getState().offers, []);
  listed = [offer(ID_B, 'b.txt')];
  hold = true;
  const refreshing = api.refreshOffers();
  await sleep(10);
  t.last.deliver({ version: 1, type: 'event', requestId: null,
    payload: { eventType: 'file.offered', data: { subscriptionId: LEASE, manifest: offer(ID_B, 'b.txt') } } });
  await sleep(5);
  answer();
  await refreshing;
  assert.deepEqual(api.getState().offers.map(o => o.name), ['b.txt']);
  api.dispose(); s.stop();
});
