/** The fast-answer double gate: kind alone never qualifies; the decision model must confidently say a
 *  text-only answer fully satisfies the request. Misclassification, mixed intent, low confidence and
 *  server trouble all keep the task with the agent. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeFastAnswer } from '../src/agent/fast-answer.js';

const SIGNAL = new AbortController().signal;
const MODEL = { kind: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434', model: 'qwen3:4b' };
const verdict = (choice: string, confidence: number) => ({ type: 'choice', choice, probabilities: { yes: confidence, no: 1 - confidence }, answer_confidence: confidence });
const sysone = (act: [string, number], cur: [string, number]) => ({ answers: { act: verdict(...act), cur: verdict(...cur) } });

function fakeFetch(routes: Record<string, unknown>, seen: string[] = []) {
  return (async (url: unknown, init?: { body?: string }) => {
    const u = String(url); seen.push(u); void init;
    const body = routes[u];
    if (body === undefined) throw new Error(`unexpected fetch ${u}`);
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  }) as unknown as typeof fetch;
}

test('a static research question passes both gates and is answered by the picked model', async () => {
  const seen: string[] = [];
  const answer = makeFastAnswer(MODEL, undefined, fakeFetch({
    'http://127.0.0.1:8000/v1/systemone': sysone(['no', 0.95], ['no', 0.9]),
    'http://127.0.0.1:11434/api/chat': { message: { role: 'assistant', content: 'Paris.' } },
  }, seen))!;
  assert.equal(await answer('What is the capital of France?', 'research', SIGNAL), 'Paris.');
  assert.deepEqual(seen, ['http://127.0.0.1:8000/v1/systemone', 'http://127.0.0.1:11434/api/chat']);
});

test('mixed intent ("research X and book it") is refused by the current-data gate: the model is never asked', async () => {
  const seen: string[] = [];
  // The real laya-multilingual said act:no 0.956 (wrong) but cur:yes 0.989 (right) for this prompt - the compound gate holds.
  const answer = makeFastAnswer(MODEL, undefined, fakeFetch({ 'http://127.0.0.1:8000/v1/systemone': sysone(['no', 0.956], ['yes', 0.989]) }, seen))!;
  assert.equal(await answer('Research current flight prices and book the cheapest', 'research', SIGNAL), undefined);
  assert.deepEqual(seen, ['http://127.0.0.1:8000/v1/systemone'], 'the answer model must never be called for a refused request');
});

test('an action request is refused by the action gate even with no current-data need', async () => {
  const answer = makeFastAnswer(MODEL, undefined, fakeFetch({ 'http://127.0.0.1:8000/v1/systemone': sysone(['yes', 0.97], ['no', 0.9]) }))!;
  assert.equal(await answer('Add milk to my shopping list', 'other', SIGNAL), undefined);
});

test('a low-confidence verdict on either question keeps the task with the agent', async () => {
  const answer = makeFastAnswer(MODEL, undefined, fakeFetch({ 'http://127.0.0.1:8000/v1/systemone': sysone(['no', 0.95], ['yes', 0.56]) }))!;
  assert.equal(await answer('Check if my Downloads folder has any PDFs and list them', 'research', SIGNAL), undefined);
});

test('a missing or malformed verdict is fail-safe', async () => {
  const answer = makeFastAnswer(MODEL, undefined, fakeFetch({ 'http://127.0.0.1:8000/v1/systemone': { answers: { act: verdict('no', 0.95) } } }))!;
  assert.equal(await answer('What is the capital of France?', 'research', SIGNAL), undefined);
});

test('a decision-server outage is fail-safe: undefined, and the agent runs as before', async () => {
  const answer = makeFastAnswer(MODEL, undefined, fakeFetch({ 'http://127.0.0.1:8000/v1/systemone': new Error('ECONNREFUSED') }))!;
  assert.equal(await answer('What is the capital of France?', 'research', SIGNAL), undefined);
});

test('non-answerable kinds are refused without any network call at all', async () => {
  const seen: string[] = [];
  const answer = makeFastAnswer(MODEL, undefined, fakeFetch({}, seen))!;
  for (const kind of ['coding', 'files', 'communication', 'system'])
    assert.equal(await answer('anything', kind, SIGNAL), undefined, kind);
  assert.deepEqual(seen, [], 'kind gating happens before the decision model is even asked');
});

test('no picked model means no fast answerer exists at all', () => {
  assert.equal(makeFastAnswer(undefined), undefined);
});
