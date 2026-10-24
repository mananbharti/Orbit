import assert from 'node:assert/strict';
import test from 'node:test';
import { InvalidDesktopReply } from '../src/agent.js';
import { DictationApi } from '../src/dictation.js';
import { OrbitSession, NotSent } from '../src/session.js';
import { FakeTransport, paired, parseSent } from './fakes.js';

let n = 0;
const uuid = () => `99999999-9999-4999-8999-${String(++n).padStart(12, '0')}`;
const CLIP = '66666666-6666-4666-8666-666666666666';
const CHUNK = 16 * 1_024;

async function setup(handler: (type: string, payload: any) => unknown) {
  const t = new FakeTransport();
  const s = new OrbitSession(paired, t, { uuid, retryBaseMs: 5, random: () => 0 });
  await s.start();
  const calls: { type: string; payload: any }[] = [];
  t.last.onSend = text => { const m = parseSent(text); calls.push({ type: m.type, payload: m.payload }); t.last.reply(m.requestId, handler(m.type, m.payload)); };
  return { t, s, calls, api: new DictationApi(s) };
}

const bytesOf = (payload: any): number => Buffer.from(payload.dataBase64, 'base64').length;
const okHandler = (type: string, payload: any) =>
  type === 'dictation.begin' ? { dictationId: CLIP }
  : type === 'dictation.chunk' ? { nextOffset: payload.offset + bytesOf(payload) / 2 }
  : { status: 'text', text: 'Hello orbit' };

test('a pcm clip streams in sample-offset chunks, finishes, and is zeroed afterwards', async () => {
  const { s, api, calls } = await setup(okHandler);
  const pcm = new Int16Array(CHUNK * 2 + 100).fill(5000);
  const result = await api.transcribe(pcm);
  assert.deepEqual(result, { status: 'text', text: 'Hello orbit' });
  assert.deepEqual(calls.map(c => c.type), ['dictation.begin', 'dictation.chunk', 'dictation.chunk', 'dictation.chunk', 'dictation.finish']);
  assert.deepEqual(calls[0]!.payload, {});
  assert.deepEqual(calls.slice(1, 4).map(c => c.payload.offset), [0, CHUNK, CHUNK * 2]);
  assert.deepEqual(calls[4]!.payload, { dictationId: CLIP });
  assert.ok(pcm.every(v => v === 0), 'the phone wipes the audio buffer after the call');
  s.stop();
});

test('the language is forwarded on begin', async () => {
  const { s, api, calls } = await setup(okHandler);
  await api.transcribe(new Int16Array(10).fill(1), 'hi');
  assert.deepEqual(calls[0]!.payload, { language: 'hi' });
  s.stop();
});

test('empty and over-long clips are refused before anything is sent', async () => {
  const { s, api, calls } = await setup(okHandler);
  await assert.rejects(api.transcribe(new Int16Array(0)), (e: any) => e instanceof NotSent && /Nothing was recorded/.test(e.message));
  await assert.rejects(api.transcribe(new Int16Array(16_000 * 120 + 1)), (e: any) => e instanceof NotSent && /too long/.test(e.message));
  assert.equal(calls.length, 0, 'nothing reached the desktop');
  s.stop();
});

test('a second transcription while one is running is refused', async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const t = new FakeTransport();
  const s = new OrbitSession(paired, t, { uuid, retryBaseMs: 5, random: () => 0 });
  await s.start();
  t.last.onSend = text => {
    const m = parseSent(text);
    if (m.type === 'dictation.finish') { void gate.then(() => t.last.reply(m.requestId, { status: 'no-speech' })); return; }
    const p: any = m.payload;
    t.last.reply(m.requestId, m.type === 'dictation.begin' ? { dictationId: CLIP } : { nextOffset: p.offset + bytesOf(p) / 2 });
  };
  const api = new DictationApi(s);
  const first = api.transcribe(new Int16Array(10).fill(1));
  await assert.rejects(api.transcribe(new Int16Array(10).fill(1)), (e: any) => e instanceof NotSent && /Already transcribing/.test(e.message));
  release();
  assert.deepEqual(await first, { status: 'no-speech' });
  await api.transcribe(new Int16Array(10).fill(1)), 'the slot frees afterwards';
  s.stop();
});

test('a bad chunk ack cancels the clip, zeroes the buffer and surfaces the failure', async () => {
  const { s, api, calls } = await setup((type, _payload) =>
    type === 'dictation.begin' ? { dictationId: CLIP }
    : type === 'dictation.chunk' ? { nextOffset: 999_999 }
    : type === 'dictation.cancel' ? { cancelled: true }
    : { status: 'text', text: 'x' });
  const pcm = new Int16Array(10).fill(7);
  await assert.rejects(api.transcribe(pcm), InvalidDesktopReply);
  assert.deepEqual(calls.map(c => c.type), ['dictation.begin', 'dictation.chunk', 'dictation.cancel']);
  assert.deepEqual(calls[2]!.payload, { dictationId: CLIP });
  assert.ok(pcm.every(v => v === 0), 'audio is wiped even on failure');
  s.stop();
});

test('a malformed finish reply also cancels and reports the failure', async () => {
  const { s, api, calls } = await setup(type =>
    type === 'dictation.begin' ? { dictationId: CLIP }
    : type === 'dictation.chunk' ? { nextOffset: 10 }
    : type === 'dictation.cancel' ? { cancelled: true }
    : { status: 'mystery' });
  await assert.rejects(api.transcribe(new Int16Array(10).fill(1)), InvalidDesktopReply);
  assert.deepEqual(calls.map(c => c.type), ['dictation.begin', 'dictation.chunk', 'dictation.finish', 'dictation.cancel']);
  s.stop();
});

test('m4a clips stream in byte offsets with format on begin and are zeroed afterwards', async () => {
  const { s, api, calls } = await setup((type, payload) =>
    type === 'dictation.begin' ? { dictationId: CLIP }
    : type === 'dictation.chunk' ? { nextOffset: payload.offset + bytesOf(payload) }
    : { status: 'text', text: 'Hello orbit' });
  const audio = new Uint8Array(CHUNK * 2 + 50).fill(0x55);
  const result = await api.transcribeCompressed(audio, 'en');
  assert.deepEqual(result, { status: 'text', text: 'Hello orbit' });
  assert.deepEqual(calls[0]!.payload, { format: 'm4a', language: 'en' });
  assert.deepEqual(calls.slice(1, 3).map(c => c.payload.offset), [0, CHUNK * 2]);
  assert.ok(audio.every(v => v === 0), 'compressed bytes are wiped after the call');
  s.stop();
});

test('empty or oversized compressed clips are refused before anything is sent', async () => {
  const { s, api, calls } = await setup(okHandler);
  await assert.rejects(api.transcribeCompressed(new Uint8Array(0)), (e: any) => e instanceof NotSent && /Nothing was recorded/.test(e.message));
  await assert.rejects(api.transcribeCompressed(new Uint8Array(3 * 1_024 * 1_024 + 1)), (e: any) => e instanceof NotSent && /too long/.test(e.message));
  assert.equal(calls.length, 0);
  s.stop();
});

test('setupState parses the computer dictation engine state', async () => {
  const { s, api, calls } = await setup(() => ({ state: 'downloading' }));
  assert.deepEqual(await api.setupState(), { state: 'downloading' });
  assert.equal(calls[0]?.type, 'dictation.status');
  s.stop();
});

test('setupState rejects a malformed reply and retrySetup returns the new state', async () => {
  const good = await setup((type: string) => type === 'dictation.retry' ? { state: 'downloading' } : { state: 'failed', reason: 'HASH_MISMATCH' });
  assert.deepEqual(await good.api.setupState(), { state: 'failed', reason: 'HASH_MISMATCH' });
  assert.deepEqual(await good.api.retrySetup(), { state: 'downloading' });
  assert.equal(good.calls[1]?.type, 'dictation.retry');
  const bad = await setup(() => ({ state: 'melting' }));
  await assert.rejects(bad.api.setupState(), InvalidDesktopReply);
  good.s.stop();
  bad.s.stop();
});
