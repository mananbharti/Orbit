/** Guards against drift between server error codes and the client response schema; depends on the protocol source text; never opens a socket. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { responseSchema } from '../src/integration-client/orbit-client.js';

test('the integration client accepts every error code the server can emit', () => {
  const source = readFileSync(new URL('../../src/protocol/errors.ts', import.meta.url), 'utf8');
  const codes = [...source.slice(0, source.indexOf('export class')).matchAll(/'([A-Z_]+)'/g)].map(match => match[1]!);
  assert.ok(codes.length > 30);
  for (const code of codes) {
    const parsed = responseSchema.safeParse({ version: 1, type: 'response', requestId: null, payload: { ok: false, error: { code } } });
    assert.ok(parsed.success, `client rejects ${code}`);
  }
});
