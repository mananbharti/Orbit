import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Router, RouteError, type Engine } from '../src/router/router.js';

const eng = (id: string, tier: 'local' | 'cloud', run: () => Promise<string>, tasks: Engine['tasks'] = ['classify', 'plan']): Engine => ({ id, tier, tasks, run });
const ok = (s: string) => async () => s;
const fail = async (): Promise<string> => { throw new Error('boom'); };

test('local engine is preferred even when listed after cloud', async () => {
  const r = await new Router([eng('c', 'cloud', ok('C')), eng('l', 'local', ok('L'))], { allowCloud: true }).route({ task: 'plan', prompt: 'x', private: false });
  assert.equal(r.engine, 'l');
});
test('private data never reaches cloud, even as a fallback', async () => {
  const router = new Router([eng('l', 'local', fail), eng('c', 'cloud', ok('C'))], { allowCloud: true });
  await assert.rejects(() => router.route({ task: 'plan', prompt: 'secret' }), (e: RouteError) => e.code === 'ALL_FAILED' && e.attempts.length === 1);
});
test('non-private work falls back to cloud when local fails and records the failure', async () => {
  const r = await new Router([eng('l', 'local', fail), eng('c', 'cloud', ok('C'))], { allowCloud: true }).route({ task: 'plan', prompt: 'x', private: false });
  assert.equal(r.engine, 'c'); assert.deepEqual(r.attempts, [{ engine: 'l', error: 'boom' }]);
});
test('cloud is off by default and reported as blocked, unsupported task as no engine', async () => {
  const router = new Router([eng('c', 'cloud', ok('C'))]);
  await assert.rejects(() => router.route({ task: 'plan', prompt: 'x', private: false }), (e: RouteError) => e.code === 'CLOUD_BLOCKED');
  await assert.rejects(() => router.route({ task: 'summarize', prompt: 'x' }), (e: RouteError) => e.code === 'NO_ENGINE');
});
test('a hung engine times out and the next one answers; bad input is rejected', async () => {
  const hang = () => new Promise<string>(() => {});
  const router = new Router([eng('a', 'local', hang), eng('b', 'local', ok('B'))], { allowCloud: false, timeoutMs: 20 });
  assert.equal((await router.route({ task: 'classify', prompt: 'x' })).engine, 'b');
  await assert.rejects(() => router.route({ task: 'classify', prompt: '' }));
  await assert.rejects(() => router.route({ task: 'rm' as never, prompt: 'x' }));
});
