/** Answer-only tasks end to end: phone pairs by QR, submits an explicit answer-only request, and the picked local
 *  model answers over its real wire contract - the agent runner is never invoked, failures stay honest, and a
 *  desktop with no model picked fails closed instead of falling back to the agent the person opted out of. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import { startDesktop } from '../../../desktop/src/desktop-service.js';
import type { AgentRunContext, AgentRunner } from '../../../desktop/src/agent/agent-runner.js';
import { AgentApi } from '../../core/src/agent.js';
import { pairWithQr } from '../../core/src/pairing.js';
import { OrbitSession } from '../../core/src/session.js';
import { TERMINAL_TASK_STATES, type TaskSummary } from '../../core/src/protocol.js';
import { NodePinnedTransport } from './node-pinned-transport.js';

class SpyRunner implements AgentRunner {
  calls = 0;
  async run(ctx: AgentRunContext): Promise<string> {
    this.calls++;
    ctx.step('Agent started');
    ctx.output('Agent output');
    return 'Agent finished';
  }
}

interface MockModel { server: Server; url: string; requests: { model: string; prompt: string; stream: unknown }[] }

async function mockOllama(t: TestContext, answer: string): Promise<MockModel> {
  const requests: MockModel['requests'] = [];
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/chat') { res.writeHead(404).end(); return; }
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
    req.on('end', () => {
      const body = JSON.parse(raw) as { model: string; messages: { content: string }[]; stream: unknown };
      requests.push({ model: body.model, prompt: body.messages[0]?.content ?? '', stream: body.stream });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: body.model, message: { role: 'assistant', content: answer }, done: true }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

async function phone(t: TestContext, runner: SpyRunner, modelUrl?: string) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-answer-e2e-'));
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test',
    discovery: false, agent: { runner, ...(modelUrl ? { fastModel: { kind: 'ollama' as const, baseUrl: modelUrl, model: 'mock-small' } } : {}) } });
  const transport = new NodePinnedTransport(new Map());
  const qr = service.pairing.open();
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  const session = new OrbitSession(paired, transport, { uuid: randomUUID });
  t.after(async () => { session.stop(); await service.stop(); rmSync(root, { recursive: true, force: true }); });
  await session.start();
  return { service, session, api: new AgentApi(session, randomUUID) };
}

async function until(read: () => Promise<TaskSummary>): Promise<TaskSummary> {
  for (let i = 0; i < 200; i++) { const s = await read(); if (TERMINAL_TASK_STATES.has(s.state)) return s; await delay(10); }
  throw new Error('timed out waiting for task state');
}

test('an answer-only request gets the picked model text over the real wire contract and the agent never runs', async t => {
  const runner = new SpyRunner();
  const model = await mockOllama(t, 'The capital is Oslo.');
  const { api } = await phone(t, runner, model.url);
  assert.equal((await api.status()).answerOnly, true, 'the phone sees the answer-only capability when a model is picked');

  const created = await api.submit('what is the capital of Norway?', randomUUID(), { answerOnly: true });
  const done = await until(() => api.get(created.taskId));
  assert.equal(done.state, 'completed');
  const events = await api.events(created.taskId);
  assert.ok(events.some(e => e.kind === 'output' && e.text.includes('The capital is Oslo.')
    && e.text.includes('no actions')), 'the timeline carries the model answer marked as action-free');

  assert.equal(model.requests.length, 1, 'exactly one call to the model server');
  assert.deepEqual(model.requests[0], { model: 'mock-small', prompt: 'what is the capital of Norway?', stream: false },
    'the desktop spoke the real Ollama chat contract with the picked model and streaming off');
  assert.equal(runner.calls, 0, 'the agent runner was never invoked for an answer-only request');

  const normal = await api.submit('tidy my downloads');
  const normalDone = await until(() => api.get(normal.taskId));
  assert.equal(normalDone.state, 'completed');
  assert.equal(runner.calls, 1, 'a normal task still runs the agent as usual');
  assert.equal(model.requests.length, 1, 'a normal task never touches the answer model');
});

test('a model that does not answer fails the task honestly and never falls back to the agent', async t => {
  const runner = new SpyRunner();
  const model = await mockOllama(t, 'unused');
  const { api } = await phone(t, runner, model.url);
  model.server.close(); // the model went offline after setup
  const created = await api.submit('answer me this', randomUUID(), { answerOnly: true });
  const done = await until(() => api.get(created.taskId));
  assert.equal(done.state, 'failed');
  const events = await api.events(created.taskId);
  assert.ok(events.some(e => /did not answer/i.test(e.text)), 'the failure is stated honestly in the timeline');
  assert.equal(runner.calls, 0, 'no silent fallback to the agent the person opted out of');
});

test('answer-only with no model picked on the computer fails closed, never runs the agent', async t => {
  const runner = new SpyRunner();
  const { api } = await phone(t, runner); // no fastModel configured
  assert.equal((await api.status()).answerOnly, false, 'the phone hides the answer-only choice with no model picked');
  const created = await api.submit('answer me anyway', randomUUID(), { answerOnly: true });
  const done = await until(() => api.get(created.taskId));
  assert.equal(done.state, 'failed');
  const events = await api.events(created.taskId);
  assert.ok(events.some(e => /pick one in Settings/i.test(e.text)), 'the failure says exactly what to do');
  assert.equal(runner.calls, 0, 'the agent still never ran');
});
