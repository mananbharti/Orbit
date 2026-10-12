import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanTranscript } from '../src/dictation/cleanup.js';
import { trimSilence } from '../src/dictation/vad.js';

test('fillers go, real words that look like fillers stay', () => {
  assert.equal(cleanTranscript('um so uh send the file, hmm to Rahul'), 'So send the file, to Rahul');
  assert.equal(cleanTranscript('the umbrella is human'), 'The umbrella is human');
});
test('personal dictionary replaces whole words, longest first, case-insensitively', () => {
  const dictionary = { 'open ai': 'OpenAI', open: 'Open', 'orbit one': 'Orbit 1.0' };
  assert.equal(cleanTranscript('ask Open AI about orbit one', { dictionary }), 'Ask OpenAI about Orbit 1.0');
  assert.equal(cleanTranscript('opened it', { dictionary }), 'Opened it');
});
test('dictionary values are literal text, not regex replacement patterns', () => {
  assert.equal(cleanTranscript('price is cost', { dictionary: { cost: '$& $1' } }), 'Price is $& $1');
});
test('spacing and sentence capitals are fixed, Hindi danda handled', () => {
  assert.equal(cleanTranscript('hello  ,world . this is fine'), 'Hello, world. This is fine');
  assert.equal(cleanTranscript('kal aana। phir baat karenge'), 'Kal aana। Phir baat karenge');
});
test('empty or filler-only input gives empty text', () => {
  assert.equal(cleanTranscript('  '), '');
  assert.equal(cleanTranscript('um uh'), '');
});
const tone = (ms: number, amp: number, rate = 16_000): Int16Array => Int16Array.from({ length: (rate * ms) / 1000 }, (_v, i) => Math.round(amp * Math.sin(i / 4)));
test('silence is trimmed with padding and a pure-silence clip has no speech', () => {
  const clip = Int16Array.from([...tone(1000, 0), ...tone(500, 8000), ...tone(1000, 0)]);
  const r = trimSilence(clip);
  assert.equal(r.speech, true);
  assert.ok(r.start >= 16_000 - 3_300 && r.start <= 16_000, `start ${r.start}`);
  assert.ok(r.end >= 24_000 && r.end <= 24_000 + 3_300, `end ${r.end}`);
  assert.equal(trimSilence(tone(2000, 0)).speech, false);
});
test('a short click is not speech', () => {
  assert.equal(trimSilence(Int16Array.from([...tone(1000, 0), ...tone(20, 20000), ...tone(1000, 0)])).speech, false);
});
import { DictationError, dictate, type Transcriber } from '../src/dictation/pipeline.js';

const speech = (): Int16Array => Int16Array.from([...tone(500, 0), ...tone(800, 9000), ...tone(500, 0)]);
test('dictation returns cleaned text and wipes the audio it was given', async () => {
  let heard = 0;
  const engine: Transcriber = { transcribe: async pcm => { heard = pcm.length; return 'um hello orbit'; } };
  const clip = speech();
  const r = await dictate(clip, engine, { cleanup: { dictionary: { orbit: 'Orbit' } } });
  assert.deepEqual(r, { status: 'text', text: 'Hello Orbit' });
  assert.ok(heard > 0 && heard < clip.length, 'silence was trimmed before the engine');
  assert.ok(clip.every(s => s === 0), 'caller buffer wiped');
});
test('silence never reaches the engine', async () => {
  let called = false;
  const r = await dictate(tone(1500, 0), { transcribe: async () => { called = true; return 'x'; } });
  assert.deepEqual(r, { status: 'no-speech' });
  assert.equal(called, false);
});
test('engine failure and cancellation are safe codes, and audio is still wiped', async () => {
  const clip = speech();
  await assert.rejects(dictate(clip, { transcribe: async () => { throw new Error('secret path /home/x'); } }), (e: unknown) => e instanceof DictationError && e.code === 'ENGINE_FAILED' && !e.message.includes('secret'));
  assert.ok(clip.every(s => s === 0));
  const ac = new AbortController(); ac.abort();
  await assert.rejects(dictate(speech(), { transcribe: async () => 'x' }, { signal: ac.signal }), (e: unknown) => e instanceof DictationError && e.code === 'CANCELLED');
});
test('a clip over the limit is refused', async () => {
  await assert.rejects(dictate(new Int16Array(16_000 * 121), { transcribe: async () => 'x' }), (e: unknown) => e instanceof DictationError && e.code === 'CLIP_TOO_LONG');
});
test('a result that cleans to nothing counts as no speech', async () => {
  assert.deepEqual(await dictate(speech(), { transcribe: async () => 'um uh' }), { status: 'no-speech' });
});
