import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WavError, wavToPcm16k } from '../src/wav.js';

/** Builds a WAV from raw chunks so header oddities can be tested. */
function riff(chunks: Uint8Array[]): Uint8Array {
  const body = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(12 + body); const v = new DataView(out.buffer);
  out.set([...'RIFF'].map(c => c.charCodeAt(0)), 0); v.setUint32(4, 4 + body, true); out.set([...'WAVE'].map(c => c.charCodeAt(0)), 8);
  let o = 12; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
function chunk(id: string, payload: Uint8Array, declared = payload.length): Uint8Array {
  const pad = payload.length % 2;
  const out = new Uint8Array(8 + payload.length + pad); const v = new DataView(out.buffer);
  out.set([...id].map(c => c.charCodeAt(0)), 0); v.setUint32(4, declared, true); out.set(payload, 8);
  return out;
}
function fmt(rate: number, channels: number, tag = 1, extensible = false): Uint8Array {
  const p = new Uint8Array(extensible ? 40 : 16); const v = new DataView(p.buffer);
  v.setUint16(0, extensible ? 0xfffe : tag, true); v.setUint16(2, channels, true); v.setUint32(4, rate, true);
  v.setUint32(8, rate * channels * 2, true); v.setUint16(12, channels * 2, true); v.setUint16(14, 16, true);
  if (extensible) { v.setUint16(16, 22, true); v.setUint16(24, tag, true); }
  return chunk('fmt ', p);
}
const pcm = (...s: number[]) => { const b = new Uint8Array(s.length * 2); const v = new DataView(b.buffer); s.forEach((x, i) => v.setInt16(i * 2, x, true)); return b; };
const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as WavError).code; } return 'none'; };

test('WAVE_FORMAT_EXTENSIBLE with an integer PCM sub-format is accepted, a float sub-format is not', () => {
  assert.deepEqual([...wavToPcm16k(riff([fmt(16_000, 1, 1, true), chunk('data', pcm(5, -6))]))], [5, -6]);
  assert.equal(code(() => wavToPcm16k(riff([fmt(16_000, 1, 3, true), chunk('data', pcm(5, -6))]))), 'UNSUPPORTED');
});

test('an odd-sized chunk before fmt is skipped using its pad byte', () => {
  const odd = chunk('junk', new Uint8Array([1, 2, 3]));
  assert.deepEqual([...wavToPcm16k(riff([odd, fmt(16_000, 1), chunk('data', pcm(7, 8))]))], [7, 8]);
});

test('more than two channels and rates outside 8 to 96 kHz are unsupported', () => {
  assert.equal(code(() => wavToPcm16k(riff([fmt(16_000, 3), chunk('data', pcm(1, 2, 3))]))), 'UNSUPPORTED');
  assert.equal(code(() => wavToPcm16k(riff([fmt(16_000, 0), chunk('data', pcm(1, 2))]))), 'UNSUPPORTED');
  assert.equal(code(() => wavToPcm16k(riff([fmt(7_999, 1), chunk('data', pcm(1, 2))]))), 'UNSUPPORTED');
  assert.equal(code(() => wavToPcm16k(riff([fmt(96_001, 1), chunk('data', pcm(1, 2))]))), 'UNSUPPORTED');
});

test('8 kHz is upsampled to double the length and a missing data or fmt chunk is NOT_WAV', () => {
  assert.equal(wavToPcm16k(riff([fmt(8_000, 1), chunk('data', pcm(0, 100, 200, 300))])).length, 8);
  assert.equal(code(() => wavToPcm16k(riff([fmt(16_000, 1)]))), 'NOT_WAV');
  assert.equal(code(() => wavToPcm16k(riff([chunk('data', pcm(1, 2))]))), 'NOT_WAV');
});

test('a trailing half sample is ignored and extreme values stay in range', () => {
  const d = new Uint8Array([...pcm(32767, -32768), 9]);
  assert.deepEqual([...wavToPcm16k(riff([fmt(16_000, 1), chunk('data', d)]))], [32767, -32768]);
});
