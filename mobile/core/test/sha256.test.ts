import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { Sha256, sha256Hex } from '../src/sha256.js';

const ref = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
test('sha256 matches Node for lengths around the block and padding boundaries', () => {
  for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000, 32768, 100001]) {
    const b = randomBytes(n);
    assert.equal(sha256Hex(b), ref(b), `length ${n}`);
  }
});
test('sha256 in uneven pieces equals one shot', () => {
  const b = randomBytes(10_000);
  const h = new Sha256();
  for (let i = 0, step = 1; i < b.length; i += step, step = (step * 7 + 3) % 211 + 1) h.update(b.subarray(i, i + step));
  assert.equal(h.hex(), ref(b));
});
test('sha256 of known vector', () => {
  assert.equal(sha256Hex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
