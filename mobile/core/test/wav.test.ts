import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WavError, wavToPcm16k } from '../src/wav.js';

function wav(samples: number[], rate = 16_000, channels = 1, opts: { dataSize?: number; format?: number; bits?: number; extra?: boolean } = {}): Uint8Array {
  const body = new Uint8Array(samples.length * 2); const bv = new DataView(body.buffer); samples.forEach((s, i) => bv.setInt16(i * 2, s, true));
  const head = new Uint8Array(44 + (opts.extra ? 12 : 0)); const v = new DataView(head.buffer); let o = 0;
  const w4 = (s: string) => { for (const c of s) head[o++] = c.charCodeAt(0); };
  w4('RIFF'); v.setUint32(o, 36 + body.length, true); o += 4; w4('WAVE');
  if (opts.extra) { w4('LIST'); v.setUint32(o, 4, true); o += 4; w4('INFO'); }
  w4('fmt '); v.setUint32(o, 16, true); o += 4; v.setUint16(o, opts.format ?? 1, true); v.setUint16(o + 2, channels, true); v.setUint32(o + 4, rate, true);
  v.setUint32(o + 8, rate * channels * 2, true); v.setUint16(o + 12, channels * 2, true); v.setUint16(o + 14, opts.bits ?? 16, true); o += 16;
  w4('data'); v.setUint32(o, opts.dataSize ?? body.length, true);
  const out = new Uint8Array(head.length + body.length); out.set(head); out.set(body, head.length); return out;
}

test('16 kHz mono passes through unchanged, skipping extra chunks', () => {
  assert.deepEqual([...wavToPcm16k(wav([1, -2, 300, 32767], 16_000, 1, { extra: true }))], [1, -2, 300, 32767]);
});
test('stereo is averaged to mono', () => {
  assert.deepEqual([...wavToPcm16k(wav([100, 300, -50, 50], 16_000, 2))], [200, 0]);
});
test('48 kHz is resampled to a third of the length', () => {
  const out = wavToPcm16k(wav(Array.from({ length: 480 }, (_, i) => i * 10), 48_000));
  assert.equal(out.length, 160); assert.equal(out[0], 0); assert.equal(out[1], 30);
});
test('streamed files with a zero or oversized data length use the bytes present', () => {
  assert.equal(wavToPcm16k(wav([1, 2, 3, 4], 16_000, 1, { dataSize: 0 })).length, 4);
  assert.equal(wavToPcm16k(wav([1, 2, 3, 4], 16_000, 1, { dataSize: 0xffffffff })).length, 4);
  assert.equal(wavToPcm16k(wav([1, 2, 3, 4], 16_000, 1, { dataSize: 1000 })).length, 4);
});
test('bad input is a clear error, never a crash', () => {
  const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as WavError).code; } return 'none'; };
  assert.equal(code(() => wavToPcm16k(new Uint8Array(5))), 'NOT_WAV');
  assert.equal(code(() => wavToPcm16k(new Uint8Array(100))), 'NOT_WAV');
  assert.equal(code(() => wavToPcm16k(wav([1, 2], 16_000, 1, { bits: 8 }))), 'UNSUPPORTED');
  assert.equal(code(() => wavToPcm16k(wav([1, 2], 16_000, 1, { format: 3 }))), 'UNSUPPORTED');
  assert.equal(code(() => wavToPcm16k(wav([], 16_000))), 'EMPTY');
  assert.equal(code(() => wavToPcm16k(wav(new Array(100).fill(1)), 50)), 'TOO_LONG');
  const cut = wav([1, 2, 3, 4]).subarray(0, 30); assert.equal(code(() => wavToPcm16k(cut)), 'NOT_WAV');
});
