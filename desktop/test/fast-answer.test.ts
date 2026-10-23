/** Answer-only wrapper: the picked model answers; anything unexpected throws so the task fails honestly. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeFastAnswer } from '../src/agent/fast-answer.js';

const SIGNAL = new AbortController().signal;
const MODEL = { kind: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434', model: 'qwen3:4b' };
const fake = (body: unknown) => (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;

test('the picked model answers; no model means no answerer at all', async () => {
  const answer = makeFastAnswer(MODEL, fake({ message: { role: 'assistant', content: 'Paris.' } }))!;
  assert.equal(await answer('What is the capital of France?', SIGNAL), 'Paris.');
  assert.equal(makeFastAnswer(undefined), undefined);
});

test('junk from the port throws instead of passing for an answer', async () => {
  const answer = makeFastAnswer(MODEL, fake({ hello: 1 }))!;
  await assert.rejects(answer('q', SIGNAL), /no answer/);
});
