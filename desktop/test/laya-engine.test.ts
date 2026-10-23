import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LayaClient, LayaError, layaEngine } from '../src/router/laya-engine.js';
import { Router } from '../src/router/router.js';

const input = { state: 'charged twice', instructions: 'Which team?', criteria: { billing: 'refunds', tech: 'login' } };
const reply = (body: unknown, status = 200): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
const good = { model: 'laya-rl-agent', answers: { q: { type: 'choice', choice: 'billing', probabilities: { billing: 0.95, tech: 0.05 }, answer_confidence: 0.95 } } };

test('sends the documented request and reads the choice', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const f = (async (u: URL, init: RequestInit) => { seen = { url: String(u), init }; return new Response(JSON.stringify(good)); }) as unknown as typeof fetch;
  const d = await new LayaClient('http://127.0.0.1:8000', { apiKey: 'k', fetchImpl: f }).decide(input);
  assert.equal(d.choice, 'billing'); assert.equal(d.probability, 0.95);
  assert.equal(seen!.url, 'http://127.0.0.1:8000/v1/systemone');
  assert.equal((seen!.init.headers as Record<string, string>).authorization, 'Bearer k');
  const body = JSON.parse(String(seen!.init.body));
  assert.equal(body.model, 'laya', 'the Jev wire contract requires a model field');
  assert.deepEqual(body.questions.q, { type: 'choice', instructions: 'Which team?', criteria: input.criteria });
});
test('criteria descriptions may be null, matching the laya-server request shape', async () => {
  const d = await new LayaClient('http://127.0.0.1:8000', { fetchImpl: reply(good) })
    .decide({ state: 'x', instructions: 'Which?', criteria: { billing: 'refunds', other: null } });
  assert.equal(d.choice, 'billing');
});
test('non-loopback servers are refused, bad responses and unknown choices fail closed', async () => {
  assert.throws(() => new LayaClient('http://192.168.1.5:8000'), (e: LayaError) => e.code === 'BAD_URL');
  assert.throws(() => new LayaClient('http://0.0.0.0:8000'), (e: LayaError) => e.code === 'BAD_URL');
  const c = (b: unknown, s = 200) => new LayaClient('http://localhost:8000', { fetchImpl: reply(b, s) });
  await assert.rejects(() => c(good, 500).decide(input), (e: LayaError) => e.code === 'HTTP');
  await assert.rejects(() => c({ nope: 1 }).decide(input), (e: LayaError) => e.code === 'BAD_RESPONSE');
  await assert.rejects(() => c({ answers: { q: { ...good.answers.q, choice: 'other' } } }).decide(input), (e: LayaError) => e.code === 'UNKNOWN_CHOICE');
  await assert.rejects(() => c(good).decide({ ...input, criteria: { only: 'one' } }));
});
test('as a router engine it classifies, abstains below the confidence floor, and is never asked to write text', async () => {
  const client = new LayaClient('http://localhost:8000', { fetchImpl: reply(good) });
  const router = new Router([layaEngine(client, 0.5)]);
  assert.equal((await router.route({ task: 'classify', prompt: JSON.stringify(input) })).text, 'billing');
  await assert.rejects(() => router.route({ task: 'summarize', prompt: 'x' }), /NO_ENGINE/);
  const strict = new Router([layaEngine(client, 0.99)]);
  await assert.rejects(() => strict.route({ task: 'classify', prompt: JSON.stringify(input) }), /ALL_FAILED/);
});
test('health probe is false when the server is down', async () => {
  assert.equal(await new LayaClient('http://127.0.0.1:1', { fetchImpl: (async () => { throw new Error('x'); }) as typeof fetch }).healthy(), false);
  let healthUrl = '';
  const hf = (async (u: URL) => { healthUrl = String(u); return new Response('{"models":[{"id":"laya"}]}'); }) as unknown as typeof fetch;
  assert.equal(await new LayaClient('http://127.0.0.1:8000', { fetchImpl: hf }).healthy(), true);
  assert.equal(healthUrl, 'http://127.0.0.1:8000/v1/models', 'readiness probes the Jev models list, not a /health route the contract does not define');
  const noLaya = (async () => new Response('{"models":[{"id":"some-other-model"}]}')) as unknown as typeof fetch;
  assert.equal(await new LayaClient('http://127.0.0.1:8000', { fetchImpl: noLaya }).healthy(), false, 'an unrelated server on the port is not a decision engine');
  const withLaya = (async () => new Response('{"models":[{"id":"laya"}]}')) as unknown as typeof fetch;
  assert.equal(await new LayaClient('http://127.0.0.1:8000', { fetchImpl: withLaya }).healthy(), true);
});

test('decideMany: one POST, one decision per named question; unknown choices and missing answers throw', async () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: unknown, init?: { body?: string }) => {
    seen.push(String(url));
    const body = JSON.parse((init?.body ?? '{}') as string);
    assert.deepEqual(Object.keys(body.questions).sort(), ['act', 'cur']);
    return { ok: true, status: 200, text: async () => JSON.stringify({ answers: {
      act: { type: 'choice', choice: 'no', probabilities: { no: 0.97, yes: 0.03 } },
      cur: { type: 'choice', choice: 'yes', probabilities: { yes: 0.88, no: 0.12 } } } }) };
  }) as unknown as typeof fetch;
  const client = new LayaClient('http://127.0.0.1:8000', { fetchImpl });
  const out = await client.decideMany({ state: 's', questions: {
    act: { instructions: 'i', criteria: { yes: 'y', no: 'n' } },
    cur: { instructions: 'i', criteria: { yes: 'y', no: 'n' } } } });
  assert.deepEqual(seen, ['http://127.0.0.1:8000/v1/systemone']);
  assert.equal(out.act?.choice, 'no'); assert.equal(out.act?.probability, 0.97);
  assert.equal(out.cur?.choice, 'yes'); assert.equal(out.cur?.probability, 0.88);

  const badChoice = new LayaClient('http://127.0.0.1:8000', { fetchImpl: (async () => ({ ok: true, status: 200,
    text: async () => JSON.stringify({ answers: { act: { type: 'choice', choice: 'maybe', probabilities: {} }, cur: { type: 'choice', choice: 'no', probabilities: { no: 1 } } } }) })) as unknown as typeof fetch });
  await assert.rejects(badChoice.decideMany({ state: 's', questions: { act: { instructions: 'i', criteria: { yes: 'y', no: 'n' } }, cur: { instructions: 'i', criteria: { yes: 'y', no: 'n' } } } }), /UNKNOWN_CHOICE/);

  const missing = new LayaClient('http://127.0.0.1:8000', { fetchImpl: (async () => ({ ok: true, status: 200,
    text: async () => JSON.stringify({ answers: { act: { type: 'choice', choice: 'no', probabilities: { no: 1 } } } }) })) as unknown as typeof fetch });
  await assert.rejects(missing.decideMany({ state: 's', questions: { act: { instructions: 'i', criteria: { yes: 'y', no: 'n' } }, cur: { instructions: 'i', criteria: { yes: 'y', no: 'n' } } } }), /BAD_RESPONSE/);
});
