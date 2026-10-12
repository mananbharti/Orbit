import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { fromBase64, toBase64 } from '../src/base64.js';

test('base64 matches Node for every length around the padding boundaries', () => {
  for (let n = 0; n < 70; n++) {
    const b = randomBytes(n);
    assert.equal(toBase64(b), b.toString('base64'));
    assert.deepEqual(Buffer.from(fromBase64(b.toString('base64'))), b);
  }
});
test('base64 rejects malformed input', () => {
  for (const bad of ['abc', 'ab=c', '@@@@', 'a===', 'YQ=']) assert.throws(() => fromBase64(bad));
});
