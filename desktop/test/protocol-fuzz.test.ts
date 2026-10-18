/** Fuzzes the protocol boundary with seeded mutations: parseMessage must only ever throw ProtocolError, schemas must never crash, and nothing may pollute prototypes; depends on no I/O. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProtocolError } from '../src/protocol/errors.js';
import { parseMessage } from '../src/protocol/validation.js';
import { clipboardSnapshotSchema } from '../src/protocol/clipboard.js';
import { automationSchema, saveAutomationSchema } from '../src/protocol/automation.js';
import { tabListSchema, openTabSchema } from '../src/protocol/tabs.js';
import type { z } from 'zod';

/** Deterministic PRNG so a failing seed is reproducible forever. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VALID = JSON.stringify({ version: 1, type: 'clipboard.get', requestId: '11111111-1111-4111-8111-111111111111', payload: null });
const UNICODE_TRICKS = ['\u0000', '\uFEFF', '💣', '\\uD800', 'ﷺ', 'x'.repeat(10_000), '\n\r\t', '".*"', '__proto__', 'constructor'];

function mutate(random: () => number, input: string): string {
  const mode = Math.floor(random() * 8);
  const trick = UNICODE_TRICKS[Math.floor(random() * UNICODE_TRICKS.length)]!;
  const at = Math.floor(random() * (input.length + 1));
  switch (mode) {
    case 0: return input.slice(0, at) + trick + input.slice(at); // inject
    case 1: return input.slice(0, at) + input.slice(at + 1); // delete a char
    case 2: return input.slice(0, Math.max(1, at)); // truncate
    case 3: return input + trick; // append
    case 4: { const parsed = JSON.parse(input) as Record<string, unknown>; delete parsed[['version', 'type', 'requestId', 'payload'][Math.floor(random() * 4)]!]; return JSON.stringify(parsed); }
    case 5: { const parsed = JSON.parse(input) as Record<string, unknown>; parsed.version = [0, 2, '1', null, 1.5][Math.floor(random() * 5)]; return JSON.stringify(parsed); }
    case 6: { const parsed = JSON.parse(input) as Record<string, unknown>; let payload: unknown = null; for (let d = 0; d < Math.floor(random() * 50); d++) payload = [payload]; parsed.payload = payload; return JSON.stringify(parsed); }
    default: return input.replaceAll('"', '\\"').slice(0, 200); // corrupt quotes
  }
}

test('500 mutated envelopes only ever throw ProtocolError or parse cleanly', () => {
  const random = mulberry32(20261019);
  for (let i = 0; i < 500; i++) {
    const input = mutate(random, VALID);
    try {
      const message = parseMessage(input);
      assert.equal(message.version, 1, 'a parsed message always has version 1');
      assert.match(message.type, /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){1,3}$/, 'a parsed message always has a valid command type');
      assert.match(message.requestId, /^[0-9a-f]{8}-/i, 'a parsed message always has a uuid request id');
    } catch (error) {
      assert.ok(error instanceof ProtocolError, `iteration ${i} threw ${String(error)} for input ${input.slice(0, 80)}`);
    }
    assert.equal(({} as Record<string, unknown>).polluted, undefined, 'no prototype pollution');
  }
});

test('random binary-ish strings and deep nesting never crash the parser', () => {
  const random = mulberry32(42);
  for (let i = 0; i < 200; i++) {
    const bytes = Array.from({ length: Math.floor(random() * 200) }, () => Math.floor(random() * 256));
    try { parseMessage(Buffer.from(bytes).toString('utf8')); } catch (error) { assert.ok(error instanceof ProtocolError); }
  }
  const deep = `{"version":1,"type":"clipboard.get","requestId":"11111111-1111-4111-8111-111111111111","payload":${'['.repeat(50_000)}${']'.repeat(50_000)}}`;
  try { parseMessage(deep); } catch (error) { assert.ok(error instanceof ProtocolError, 'even a stack overflow surfaces as INVALID_MESSAGE'); }
});

test('boundary schemas never throw on mutated structures', () => {
  const random = mulberry32(7);
  const schemas: z.ZodType[] = [clipboardSnapshotSchema, automationSchema, saveAutomationSchema, tabListSchema, openTabSchema];
  const seeds: unknown[] = [
    { kind: 'text', text: 'hi' }, { kind: 'oversized' }, { tabs: [] }, { url: 'https://heyorbit.xyz' },
    { id: '11111111-1111-4111-8111-111111111111', time: '07:30', days: [], enabled: true, action: { type: 'power', action: 'lock' } },
    null, undefined, 0, 'x', [], {}, Number.NaN, Number.POSITIVE_INFINITY, -1,
  ];
  for (let i = 0; i < 1_000; i++) {
    const schema = schemas[Math.floor(random() * schemas.length)]!;
    let value = seeds[Math.floor(random() * seeds.length)];
    if (typeof value === 'object' && value !== null) value = { ...(value as object), [UNICODE_TRICKS[Math.floor(random() * UNICODE_TRICKS.length)]!]: value };
    schema.safeParse(value); // must simply return, never throw
  }
});
