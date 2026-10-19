import assert from 'node:assert/strict';
import test from 'node:test';
import { eventSchema, responseSchema } from '../src/protocol.js';
import { FakeTransport, paired } from './fakes.js';
import { OrbitSession, type SessionStatus } from '../src/session.js';

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

/** Deterministic PRNG so a fuzz failure is exactly reproducible from the seed. */
const mulberry32 = (seed: number) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};

const BASE_ENVELOPES = [
  JSON.stringify({ version: 1, type: 'event', requestId: null, payload: { eventType: 'terminal.output', data: { sessionId: 'x', chunk: 'hi' } } }),
  JSON.stringify({ version: 1, type: 'response', requestId: uuid(), payload: { ok: true, result: null } }),
  JSON.stringify({ version: 1, type: 'response', requestId: uuid(), payload: { ok: false, error: { code: 'UNKNOWN_COMMAND' } } }),
];

function mutate(input: string, random: () => number): string {
  switch (Math.floor(random() * 7)) {
    case 0: { const c = [...input]; const i = Math.floor(random() * c.length); c[i] = String.fromCharCode(32 + Math.floor(random() * 95)); return c.join(''); }
    case 1: return input.slice(0, Math.floor(random() * input.length));
    case 2: return input + String.fromCharCode(...Array.from({ length: 8 }, () => Math.floor(random() * 65536)));
    case 3: { const parsed = JSON.parse(input) as Record<string, unknown>; delete parsed[['version', 'type', 'payload'][Math.floor(random() * 3)]!]; return JSON.stringify(parsed); }
    case 4: { const parsed = JSON.parse(input) as Record<string, unknown>; parsed.payload = random() < 0.5 ? Math.floor(random() * 1e9) : 'x'.repeat(Math.floor(random() * 4096)); return JSON.stringify(parsed); }
    case 5: return String.fromCharCode(...Array.from({ length: Math.floor(random() * 256) }, () => Math.floor(random() * 65536)));
    default: { const parsed = JSON.parse(input) as Record<string, unknown>; let payload: unknown = null; for (let d = 0; d < Math.floor(random() * 50); d++) payload = [payload]; parsed.payload = payload; return JSON.stringify(parsed); }
  }
}

test('500 mutated wire messages never crash the session message handler', async () => {
  const random = mulberry32(20261019);
  let t1 = new FakeTransport();
  let s = new OrbitSession(paired, t1, { uuid, retryBaseMs: 5, retryMaxMs: 20, random: () => 0 });
  const seen: SessionStatus[] = []; s.onStatus(x => seen.push(x));
  await s.start();
  let malformed = 0;
  for (let i = 0; i < 500; i++) {
    if (t1.last.closed) { // the session defensively dropped the channel; start fresh
      s.stop();
      t1 = new FakeTransport();
      s = new OrbitSession(paired, t1, { uuid, retryBaseMs: 5, retryMaxMs: 20, random: () => 0 });
      await s.start();
      malformed++;
    }
    const junk = mutate(BASE_ENVELOPES[Math.floor(random() * BASE_ENVELOPES.length)]!, random);
    t1.last.deliver(junk); // throws here if the handler crashes
  }
  s.stop();
  assert.ok(malformed >= 0); // any mix of survived/dropped channels is safe; the assertion is the absence of a throw
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
});

test('boundary schemas never throw on mutated structures', () => {
  const random = mulberry32(42);
  for (let i = 0; i < 1000; i++) {
    let value: unknown;
    const junk = mutate(BASE_ENVELOPES[Math.floor(random() * BASE_ENVELOPES.length)]!, random);
    try { value = JSON.parse(junk); } catch { continue; }
    eventSchema.safeParse(value);
    responseSchema.safeParse(value);
  }
  assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
});

test('a valid event after junk still reaches listeners when the channel survived', async () => {
  const random = mulberry32(7);
  const t1 = new FakeTransport();
  const s = new OrbitSession(paired, t1, { uuid, retryBaseMs: 5, retryMaxMs: 20, random: () => 0 });
  await s.start();
  const events: unknown[] = []; s.onEvent(p => events.push(p));
  for (let i = 0; i < 200 && !t1.last.closed; i++) {
    t1.last.deliver(mutate(BASE_ENVELOPES[0]!, random));
  }
  if (!t1.last.closed) {
    t1.last.deliver({ version: 1, type: 'event', requestId: null, payload: { eventType: 'clipboard.changed', data: { text: 'after' } } });
    assert.deepEqual(events, [{ eventType: 'clipboard.changed', data: { text: 'after' } }]);
  }
  s.stop();
});
