import assert from 'node:assert/strict';
import test from 'node:test';
import { InvalidDesktopReply } from '../src/agent.js';
import { DictationApi } from '../src/dictation.js';
import { OrbitSession } from '../src/session.js';
import { FakeTransport, paired, parseSent } from './fakes.js';

let n = 0;
const uuid = () => `77777777-7777-4777-8777-${String(++n).padStart(12, '0')}`;
const CLIP = '55555555-5555-4555-8555-555555555555';
const CHUNK = 16 * 1_024;
const size = (payload: any): number => Buffer.from(payload.dataBase64, 'base64').length;

async function setup(handler: (type: string, payload: any) => unknown) {
  const t = new FakeTransport();
  const s = new OrbitSession(paired, t, { uuid, retryBaseMs: 5, random: () => 0 });
  await s.start();
  const calls: { type: string; payload: any }[] = [];
  t.last.onSend = text => { const m = parseSent(text); calls.push({ type: m.type, payload: m.payload }); t.last.reply(m.requestId, handler(m.type, m.payload)); };
  return { s, calls, api: new DictationApi(s) };
}
const ok = (bytesPerUnit: number) => (type: string, payload: any) =>
  type === 'dictation.begin' ? { dictationId: CLIP } : type === 'dictation.chunk' ? { nextOffset: payload.offset + size(payload) / bytesPerUnit }
  : { status: 'text', text: 'ok' };

test('samples go out as little-endian signed 16-bit in chunks of exactly 16384 samples', async () => {
  const { s, calls, api } = await setup(ok(2));
  await api.transcribe(Int16Array.from([1, -2, 258, -32768, 32767]));
  assert.equal(calls[1]!.payload.dataBase64, Buffer.from([1, 0, 0xfe, 0xff, 2, 1, 0, 0x80, 0xff, 0x7f]).toString('base64'));
  const big = await setup(ok(2));
  await big.api.transcribe(new Int16Array(CHUNK + 1).fill(7));
  assert.deepEqual(big.calls.filter(c => c.type === 'dictation.chunk').map(c => size(c.payload)), [CHUNK * 2, 2]);
  s.stop(); big.s.stop();
});

test('m4a bytes go out in chunks of exactly 32768 bytes', async () => {
  const { s, calls, api } = await setup(ok(1));
  await api.transcribeCompressed(new Uint8Array(CHUNK * 2 + 1).fill(9));
  assert.deepEqual(calls.filter(c => c.type === 'dictation.chunk').map(c => size(c.payload)), [CHUNK * 2, 1]);
  s.stop();
});

test('clips of exactly the maximum length are accepted and finished', async () => {
  const pcm = await setup(ok(2));
  await pcm.api.transcribe(new Int16Array(16_000 * 120));
  const m4a = await setup(ok(1));
  await m4a.api.transcribeCompressed(new Uint8Array(3 * 1_024 * 1_024));
  assert.equal(pcm.calls.at(-1)!.type, 'dictation.finish');
  assert.equal(m4a.calls.at(-1)!.type, 'dictation.finish');
  pcm.s.stop(); m4a.s.stop();
});

test('a chunk ack that is malformed or at the wrong offset is an invalid reply, cancels the clip and frees the recorder', async () => {
  for (const bad of [{ nope: true }, { nextOffset: 3 }]) {
    const { s, calls, api } = await setup((type, payload) => type === 'dictation.begin' ? { dictationId: CLIP } : type === 'dictation.chunk' ? bad : (() => { throw new Error(`unexpected ${type} ${payload}`); })());
    await assert.rejects(api.transcribe(new Int16Array(10).fill(1)), InvalidDesktopReply);
    assert.deepEqual(calls.map(c => c.type), ['dictation.begin', 'dictation.chunk', 'dictation.cancel']);
    await assert.rejects(api.transcribeCompressed(new Uint8Array(10).fill(1)), InvalidDesktopReply);
    s.stop();
  }
});
