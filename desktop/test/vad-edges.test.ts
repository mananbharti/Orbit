/** Voice activity edges: padding clamps to the clip, a partial last frame is ignored, thresholds and sample rates apply. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trimSilence } from '../src/dictation/vad.js';

const tone = (ms: number, amp: number, rate = 16_000) => new Int16Array(Math.round(rate * ms / 1000)).fill(amp);
const cat = (...parts: Int16Array[]) => Int16Array.from(parts.flatMap(p => [...p]));

test('speech at the very start and end is padded only up to the clip bounds', () => {
  const clip = tone(400, 8000);
  const r = trimSilence(clip);
  assert.deepEqual(r, { speech: true, start: 0, end: clip.length });
});

test('padding is applied on both sides of the speech and respects padMs', () => {
  const clip = cat(tone(1000, 0), tone(400, 8000), tone(1000, 0));
  const r = trimSilence(clip, { padMs: 100 });
  assert.equal(r.start, 16_000 - 1_600);
  assert.equal(r.end, 16_000 + 6_400 + 1_600);
});

test('the threshold decides: a quiet voice is speech only below the cutoff', () => {
  const clip = cat(tone(500, 0), tone(400, 300), tone(500, 0));
  assert.equal(trimSilence(clip).speech, false);
  assert.equal(trimSilence(clip, { thresholdRms: 200 }).speech, true);
});

test('empty or shorter-than-a-frame input has no speech and does not throw', () => {
  assert.equal(trimSilence(new Int16Array(0)).speech, false);
  assert.equal(trimSilence(Int16Array.from([30000, 30000, 30000])).speech, false);
});

test('a second, longer burst after a click still counts and the click is ignored', () => {
  const clip = cat(tone(500, 0), tone(20, 20000), tone(500, 0), tone(400, 8000), tone(500, 0));
  const r = trimSilence(clip, { padMs: 0 });
  assert.equal(r.speech, true);
  assert.equal(r.start, 16_000 * 1.02);
  assert.equal(r.end, 16_000 * 1.42);
});
