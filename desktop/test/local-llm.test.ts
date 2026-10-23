/** Local LLM discovery + answer client: what is reported, what is refused, and exact wire shapes,
 *  all against a fake fetch - no server is started and nothing leaves the test. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LocalLlmClient, OLLAMA_URL, LMSTUDIO_URL, type LocalLlmServer } from '../src/router/local-llm.js';

type FakeReply = { ok?: boolean; status?: number; body?: unknown } | Error;
function fakeFetch(routes: Record<string, FakeReply>, seen?: { url: string; body?: any }[]) {
  return async (url: string, init?: { body?: string }) => {
    seen?.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    const hit = routes[url];
    if (!hit) throw new Error(`unexpected fetch ${url}`);
    if (hit instanceof Error) throw hit;
    return { ok: hit.ok ?? true, status: hit.status ?? (hit.ok === false ? 500 : 200), json: async () => hit.body };
  };
}
const OLLAMA_TAGS = { models: [{ name: 'qwen3:4b' }, { name: 'llama3.2:3b' }] };
const LMS_MODELS = { data: [{ id: 'nemotron-3-nano' }] };

test('detect: Ollama wins when both answer; its model names come from /api/tags', async () => {
  const c = new LocalLlmClient(fakeFetch({ [`${OLLAMA_URL}/api/tags`]: { body: OLLAMA_TAGS }, [`${LMSTUDIO_URL}/v1/models`]: { body: LMS_MODELS } }));
  assert.deepEqual(await c.detect(), { kind: 'ollama', baseUrl: OLLAMA_URL, models: ['qwen3:4b', 'llama3.2:3b'] });
});

test('detect: falls back to LM Studio when Ollama is down; a model-less install is reported honestly', async () => {
  const down = new LocalLlmClient(fakeFetch({ [`${OLLAMA_URL}/api/tags`]: new Error('ECONNREFUSED'), [`${LMSTUDIO_URL}/v1/models`]: { body: LMS_MODELS } }));
  assert.deepEqual(await down.detect(), { kind: 'lmstudio', baseUrl: LMSTUDIO_URL, models: ['nemotron-3-nano'] });
  const empty = new LocalLlmClient(fakeFetch({ [`${OLLAMA_URL}/api/tags`]: { body: { models: [] } }, [`${LMSTUDIO_URL}/v1/models`]: new Error('x') }));
  assert.deepEqual(await empty.detect(), { kind: 'ollama', baseUrl: OLLAMA_URL, models: [] });
  const none = new LocalLlmClient(fakeFetch({ [`${OLLAMA_URL}/api/tags`]: new Error('x'), [`${LMSTUDIO_URL}/v1/models`]: { ok: false, status: 404 } }));
  assert.equal(await none.detect(), undefined);
});

test('detect: junk JSON from something else on the port is not a model server', async () => {
  const c = new LocalLlmClient(fakeFetch({ [`${OLLAMA_URL}/api/tags`]: { body: { hello: 1 } }, [`${LMSTUDIO_URL}/v1/models`]: { body: null } }));
  assert.equal(await c.detect(), undefined);
});

test('answer (Ollama): POSTs /api/chat with stream off and returns the message content, capped', async () => {
  const seen: { url: string; body?: any }[] = [];
  const c = new LocalLlmClient(fakeFetch({ [`${OLLAMA_URL}/api/chat`]: { body: { message: { role: 'assistant', content: ` ${'a'.repeat(5000)} ` } } } }, seen));
  const server: LocalLlmServer = { kind: 'ollama', baseUrl: OLLAMA_URL, models: ['qwen3:4b'] };
  const text = await c.answer(server, 'qwen3:4b', 'What port does Ollama use?');
  assert.deepEqual(seen, [{ url: `${OLLAMA_URL}/api/chat`, body: { model: 'qwen3:4b', messages: [{ role: 'user', content: 'What port does Ollama use?' }], stream: false } }]);
  assert.equal(text.length, 4000);
});

test('answer (LM Studio): POSTs the OpenAI chat shape and reads choices[0]', async () => {
  const seen: { url: string; body?: any }[] = [];
  const c = new LocalLlmClient(fakeFetch({ [`${LMSTUDIO_URL}/v1/chat/completions`]: { body: { choices: [{ message: { content: 'Blue.' } }] } } }, seen));
  const server: LocalLlmServer = { kind: 'lmstudio', baseUrl: LMSTUDIO_URL, models: ['nemotron-3-nano'] };
  assert.equal(await c.answer(server, 'nemotron-3-nano', 'Sky color?'), 'Blue.');
  assert.deepEqual(seen.at(0)?.body, { model: 'nemotron-3-nano', messages: [{ role: 'user', content: 'Sky color?' }] });
});

test('answer: errors, empty answers and junk shapes all throw; long prompts and remote addresses refused', async () => {
  const server: LocalLlmServer = { kind: 'ollama', baseUrl: OLLAMA_URL, models: ['m'] };
  await assert.rejects(new LocalLlmClient(fakeFetch({ [`${OLLAMA_URL}/api/chat`]: { ok: false, status: 503 } })).answer(server, 'm', 'q'), /503/);
  await assert.rejects(new LocalLlmClient(fakeFetch({ [`${OLLAMA_URL}/api/chat`]: { body: { message: { content: '  ' } } } })).answer(server, 'm', 'q'), /no answer/);
  await assert.rejects(new LocalLlmClient(fakeFetch({ [`${OLLAMA_URL}/api/chat`]: { body: {} } })).answer(server, 'm', 'q'), /no answer/);
  await assert.rejects(new LocalLlmClient(fakeFetch({})).answer(server, 'm', 'x'.repeat(9000)), /too long/);
  await assert.rejects(new LocalLlmClient(fakeFetch({})).answer({ kind: 'ollama', baseUrl: 'http://10.0.0.9:11434', models: ['m'] }, 'm', 'q'), /loopback/);
});
