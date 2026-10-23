/** VAD, pipeline and cleanup boundaries the main dictation suites do not pin; synthetic PCM only. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanTranscript } from '../src/dictation/cleanup.js';
import { DictationError, dictate, MAX_CLIP_SECONDS, SAMPLE_RATE, type Transcriber } from '../src/dictation/pipeline.js';
import { trimSilence } from '../src/dictation/vad.js';

const flat = (ms: number, value: number): Int16Array => new Int16Array((16_000 * ms) / 1000).fill(value);
const tone = (ms: number, amp: number): Int16Array => Int16Array.from({ length: 16 * ms }, (_v, i) => Math.round(amp * Math.sin(i / 4)));

test('a frame exactly at the RMS threshold is voiced, one just below is not', () => {
  assert.equal(trimSilence(flat(200, 500)).speech, true);
  assert.equal(trimSilence(flat(200, 499)).speech, false);
});
test('a speech run of exactly 120ms counts, 100ms does not', () => {
  assert.equal(trimSilence(Int16Array.from([...flat(500, 0), ...flat(120, 500), ...flat(500, 0)])).speech, true);
  assert.equal(trimSilence(Int16Array.from([...flat(500, 0), ...flat(100, 500), ...flat(500, 0)])).speech, false);
});
test('the trim keeps exactly 200ms of padding on each side', () => {
  const clip = Int16Array.from([...flat(500, 0), ...tone(500, 8000), ...flat(500, 0)]);
  const r = trimSilence(clip);
  assert.equal(r.start, 8_000 - 3_200);
  assert.equal(r.end, 16_000 + 3_200);
});
test('a clip of exactly 120 seconds is dictated, one sample over is refused and wiped', async () => {
  const engine: Transcriber = { transcribe: async () => 'hello' };
  const at = new Int16Array(SAMPLE_RATE * MAX_CLIP_SECONDS).fill(500);
  const r = await dictate(at, engine);
  assert.equal(r.status, 'text');
  const over = new Int16Array(SAMPLE_RATE * MAX_CLIP_SECONDS + 1).fill(500);
  await assert.rejects(dictate(over, engine), (e: DictationError) => e.code === 'CLIP_TOO_LONG');
  assert.ok(over.every(s => s === 0), 'the refused clip is still wiped');
});
test('a signal aborted before transcription starts cancels without calling the engine', async () => {
  let called = false;
  const engine: Transcriber = { transcribe: async () => { called = true; return 'x'; } };
  const controller = new AbortController();
  controller.abort();
  const clip = Int16Array.from([...flat(500, 0), ...tone(500, 8000), ...flat(500, 0)]);
  await assert.rejects(dictate(clip, engine, { signal: controller.signal }), (e: DictationError) => e.code === 'CANCELLED');
  assert.equal(called, false);
  assert.ok(clip.every(s => s === 0), 'audio still wiped');
});
test('a longer dictionary key wins even when the shorter one would change the casing', () => {
  const dictionary = { 'open ai': 'OpenAI', open: 'XXX' };
  assert.equal(cleanTranscript('open ai please', { dictionary }), 'OpenAI please');
  assert.equal(cleanTranscript('open sesame', { dictionary }), 'XXX sesame');
});
test('a comma before a letter gets a space, a comma before a digit never does', () => {
  assert.equal(cleanTranscript('hello,world', { removeFillers: false }), 'Hello, world');
  assert.equal(cleanTranscript('it costs 1,000 or 3,50,000', { removeFillers: false }), 'It costs 1,000 or 3,50,000');
});
