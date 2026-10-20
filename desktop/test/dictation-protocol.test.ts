/** Dictation wire schemas: strict shapes, language codes, chunk size and offset bounds. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_MESSAGE_BYTES } from '../src/config.js';
import { DICTATION_CHUNK_BYTES, MAX_COMPRESSED_BYTES, beginSchema, chunkSchema, refSchema } from '../src/protocol/dictation.js';

const dictationId = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';
const b64 = (bytes: number) => Buffer.alloc(bytes, 1).toString('base64');

test('begin accepts known formats and two or three letter languages or auto, nothing else', () => {
  for (const ok of [{}, { format: 'pcm16' }, { format: 'm4a', language: 'hi' }, { language: 'auto' }, { language: 'fil' }]) assert.ok(beginSchema.safeParse(ok).success, JSON.stringify(ok));
  for (const bad of [{ format: 'wav' }, { language: 'EN' }, { language: 'english' }, { language: 'e' }, { language: '' }, { extra: 1 }]) assert.equal(beginSchema.safeParse(bad).success, false, JSON.stringify(bad));
});

test('a chunk needs a uuid, an in-range whole offset and non-empty base64 within one chunk size', () => {
  const full = b64(DICTATION_CHUNK_BYTES);
  assert.ok(chunkSchema.safeParse({ dictationId, offset: 0, dataBase64: full }).success);
  assert.ok(chunkSchema.safeParse({ dictationId, offset: MAX_COMPRESSED_BYTES, dataBase64: 'AAAA' }).success);
  for (const bad of [{ dictationId, offset: -1, dataBase64: 'AAAA' }, { dictationId, offset: 1.5, dataBase64: 'AAAA' },
    { dictationId, offset: MAX_COMPRESSED_BYTES + 1, dataBase64: 'AAAA' }, { dictationId, offset: 0, dataBase64: '' },
    { dictationId, offset: 0, dataBase64: b64(DICTATION_CHUNK_BYTES + 3) }, { dictationId: 'x', offset: 0, dataBase64: 'AAAA' },
    { dictationId, offset: 0, dataBase64: 'AAAA', extra: true }]) {
    assert.equal(chunkSchema.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 70));
  }
});

test('a full chunk fits inside one protocol message, and refs are strict', () => {
  assert.ok(b64(DICTATION_CHUNK_BYTES).length + 512 < MAX_MESSAGE_BYTES);
  assert.ok(refSchema.safeParse({ dictationId }).success);
  assert.equal(refSchema.safeParse({ dictationId, x: 1 }).success, false);
  assert.equal(refSchema.safeParse({}).success, false);
});
