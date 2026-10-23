/** Tests the Hermes Runs API adapter; depends on a synthetic loopback server that mimics the documented endpoints; never contacts a real Hermes or model. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import type { AgentRunContext } from '../src/agent/agent-runner.js';
import { HermesRunner } from '../src/agent/hermes-runner.js';

interface Fake { server: Server; url: string; requests: { method: string; path: string; headers: IncomingMessage['headers']; body: string }[];
  events: string[]; status: Record<string, unknown>; holdEvents?: Promise<void>; approvals: unknown[]; approvalStatus: number }
async function fake(t: TestContext): Promise<Fake> {
  const state: Fake = { server: undefined as never, url: '', requests: [], events: [], status: { status: 'completed', output: 'Final answer' }, approvals: [], approvalStatus: 200 };
  state.server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      state.requests.push({ method: req.method!, path: req.url!, headers: req.headers, body });
      if (req.headers.authorization !== 'Bearer test-key') { res.writeHead(401).end(); return; }
      if (req.method === 'POST' && req.url === '/v1/runs') { res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ run_id: 'run_abc123', status: 'started' })); return; }
      if (req.url === '/v1/runs/run_abc123/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const frame of state.events) res.write(frame);
        await state.holdEvents; res.end(); return;
      }
      if (req.url === '/v1/runs/run_abc123/approval') { state.approvals.push(JSON.parse(body)); res.writeHead(state.approvalStatus, { 'Content-Type': 'application/json' }).end('{}'); return; }
      if (req.url === '/v1/runs/run_abc123/stop') { res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"stopping"}'); return; }
      if (req.url === '/v1/runs/run_abc123') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(state.status)); return; }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>(resolve => state.server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${(state.server.address() as AddressInfo).port}`;
  t.after(() => { state.server.closeAllConnections(); state.server.close(); });
  return state;
}
const frame = (name: string, data: object) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
function context(overrides: Partial<AgentRunContext> = {}) {
  const steps: string[] = []; const outputs: string[] = []; const controller = new AbortController();
  const ctx: AgentRunContext = { taskId: randomUUID(), prompt: 'list my files', signal: controller.signal,
    step: s => steps.push(s), output: o => outputs.push(o), requestApproval: async () => false, ...overrides };
  return { ctx, steps, outputs, controller };
}

test('a run streams tool progress, then returns the authoritative final output', async t => {
  const f = await fake(t);
  f.events = [': keepalive\n\n', frame('tool.started', { tool: 'terminal', preview: 'ls' }), frame('message.delta', { text: 'x' }),
    frame('tool.completed', { tool: 'terminal', error: false }), frame('message.interim', { text: 'Looking good', already_streamed: false }), frame('run.completed', {})];
  const { ctx, steps, outputs } = context();
  const result = await new HermesRunner({ apiKey: 'test-key', baseUrl: f.url }).run(ctx);
  assert.equal(result, 'Final answer');
  assert.deepEqual(steps, ['Using terminal: ls', 'Finished terminal']);
  assert.deepEqual(outputs, ['Looking good']);
  const create = f.requests.find(r => r.path === '/v1/runs')!;
  assert.equal(create.headers['idempotency-key'], ctx.taskId);
  assert.deepEqual(JSON.parse(create.body), { input: 'list my files', session_id: ctx.taskId });
});

test('approval requests wait for the user and relay the decision with the control identity', async t => {
  // The documented contract: { request_id, execution_generation, choice } - identityless answers get HTTP 409.
  const f = await fake(t);
  f.events = [frame('approval.request', { tool: 'write_file', preview: 'Write notes.txt', prompt_id: 'prompt-9', execution_generation: 3 }), frame('run.completed', {})];
  const asked: string[] = [];
  const { ctx } = context({ requestApproval: async d => { asked.push(d); return false; } });
  await new HermesRunner({ apiKey: 'test-key', baseUrl: f.url }).run(ctx);
  assert.deepEqual(asked, ['Write notes.txt']);
  assert.deepEqual(f.approvals, [{ request_id: 'prompt-9', execution_generation: 3, choice: 'deny' }]);
  const approved = context({ requestApproval: async () => true });
  const g = await fake(t); g.events = f.events;
  await new HermesRunner({ apiKey: 'test-key', baseUrl: g.url }).run(approved.ctx);
  assert.deepEqual(g.approvals, [{ request_id: 'prompt-9', execution_generation: 3, choice: 'once' }]);
});

test('an approval event without identity falls back to the run pending_controls', async t => {
  const f = await fake(t);
  f.events = [frame('approval.request', { tool: 'write_file', preview: 'Write notes.txt' }), frame('run.completed', {})];
  f.status = { status: 'completed', output: 'Final answer', pending_controls: { prompt_id: 'prompt-11', execution_generation: 7 } };
  const { ctx } = context({ requestApproval: async () => true });
  await new HermesRunner({ apiKey: 'test-key', baseUrl: f.url }).run(ctx);
  assert.deepEqual(f.approvals, [{ request_id: 'prompt-11', execution_generation: 7, choice: 'once' }]);
});

test('an approval with no identity anywhere is not delivered, and the run goes on', async t => {
  const f = await fake(t);
  f.events = [frame('approval.request', { tool: 'write_file' }), frame('run.completed', {})];
  const { ctx, steps } = context({ requestApproval: async () => true });
  const result = await new HermesRunner({ apiKey: 'test-key', baseUrl: f.url }).run(ctx);
  assert.equal(result, 'Final answer');
  assert.deepEqual(f.approvals, []); // an identityless POST would only earn a 409
  assert.ok(steps.some(step => step.includes('no approval identity')));
});

test('a stale approval (HTTP 409) is tolerated: the control already settled', async t => {
  const f = await fake(t);
  f.approvalStatus = 409;
  f.events = [frame('approval.request', { tool: 'write_file', prompt_id: 'prompt-9', execution_generation: 3 }), frame('run.completed', {})];
  const { ctx } = context({ requestApproval: async () => false });
  const result = await new HermesRunner({ apiKey: 'test-key', baseUrl: f.url }).run(ctx);
  assert.equal(result, 'Final answer');
  assert.equal(f.approvals.length, 1); // the answer was attempted; Hermes had moved on
});

test('aborting asks Hermes to stop the run and surfaces a failure', async t => {
  const f = await fake(t);
  let release!: () => void; f.holdEvents = new Promise<void>(resolve => { release = resolve; });
  f.events = [frame('tool.started', { tool: 'terminal', preview: 'sleep 100' })];
  f.status = { status: 'cancelled' };
  const { ctx, controller } = context();
  const running = new HermesRunner({ apiKey: 'test-key', baseUrl: f.url }).run(ctx);
  await new Promise(resolve => setTimeout(resolve, 100));
  controller.abort(); release();
  await assert.rejects(running);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(f.requests.some(r => r.method === 'POST' && r.path === '/v1/runs/run_abc123/stop'));
});

test('a failed or interrupted run rejects and never reports success from events alone', async t => {
  const f = await fake(t);
  f.events = [frame('run.completed', {})]; f.status = { status: 'interrupted', error: 'Gateway shutdown interrupted the run.' };
  await assert.rejects(new HermesRunner({ apiKey: 'test-key', baseUrl: f.url }).run(context().ctx), /interrupted/);
});

test('malformed frames, oversize text and control characters are contained', async t => {
  const f = await fake(t);
  f.events = ['data: {not json\n\n', frame('tool.started', { tool: 'a\u0000b\nc', preview: 'p'.repeat(5_000) }), frame('run.completed', {})];
  const { ctx, steps } = context();
  await new HermesRunner({ apiKey: 'test-key', baseUrl: f.url }).run(ctx);
  assert.equal(steps.length, 1);
  assert.ok(steps[0]!.length <= 2_000 + 20); assert.ok(!/[\u0000-\u001f]/.test(steps[0]!));
});

test('bad credentials and non-loopback endpoints are refused', async t => {
  const f = await fake(t);
  await assert.rejects(new HermesRunner({ apiKey: 'wrong', baseUrl: f.url }).run(context().ctx), /HTTP 401/);
  assert.throws(() => new HermesRunner({ apiKey: 'k', baseUrl: 'http://10.0.0.5:8642' }), /non-loopback/);
  assert.throws(() => new HermesRunner({ apiKey: '', baseUrl: f.url }), /key is required/);
  assert.doesNotThrow(() => new HermesRunner({ apiKey: 'k', baseUrl: 'https://hermes.example', allowRemote: true }));
});

test('requests refuse redirects, and a run id that could steer a request path is rejected', async t => {
  const f = await fake(t);
  const seen: (RequestInit | undefined)[] = [];
  const spy: typeof fetch = (input, init) => { seen.push(init); return fetch(input, init); };
  await new HermesRunner({ apiKey: 'test-key', baseUrl: f.url, fetchImpl: spy }).run(context().ctx);
  assert.ok(seen.length >= 3 && seen.every(init => init?.redirect === 'error'), 'every call refuses redirects, so the API key never follows one');
  for (const runId of ['../admin', 'run/1', 'a'.repeat(129), '', 5]) {
    const stub: typeof fetch = async () => new Response(JSON.stringify({ run_id: runId }), { status: 202, headers: { 'Content-Type': 'application/json' } });
    await assert.rejects(new HermesRunner({ apiKey: 'test-key', baseUrl: f.url, fetchImpl: stub }).run(context().ctx), /no run id/, `rejects ${JSON.stringify(runId)}`);
  }
});

test('an event stream with an oversize line or an unbounded buffer is cut off, and a newline in the key is refused', async t => {
  const f = await fake(t);
  f.events = [`data: ${'x'.repeat(300 * 1_024)}\n\n`];
  await assert.rejects(new HermesRunner({ apiKey: 'test-key', baseUrl: f.url }).run(context().ctx), /line too large/);
  f.events = [`data: ${'y'.repeat(1_200_000)}`]; // never a newline, so only the buffer cap can stop it
  await assert.rejects(new HermesRunner({ apiKey: 'test-key', baseUrl: f.url }).run(context().ctx), /stream too large/);
  assert.throws(() => new HermesRunner({ apiKey: 'k\nX-Injected: 1', baseUrl: f.url }), /key is required/);
});
