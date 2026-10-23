/** Hermes adapter edges the main suite does not pin; same synthetic loopback server. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { AgentRunContext } from '../src/agent/agent-runner.js';
import { HermesRunner } from '../src/agent/hermes-runner.js';

interface Fake { server: Server; url: string; events: string[]; status: Record<string, unknown> }
async function fake(t: test.TestContext): Promise<Fake> {
  const state: Fake = { server: undefined as never, url: '', events: [], status: { status: 'completed', output: 'Final answer' } };
  state.server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      if (req.method === 'POST' && req.url === '/v1/runs') { res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ run_id: 'run_abc123' })); return; }
      if (req.url === '/v1/runs/run_abc123/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); for (const frame of state.events) res.write(frame); res.end(); return; }
      if (req.url === '/v1/runs/run_abc123') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(state.status)); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
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
  const ctx: AgentRunContext = { taskId: randomUUID(), prompt: 'p', signal: controller.signal,
    step: s => steps.push(s), output: o => outputs.push(o), requestApproval: async () => false, ...overrides };
  return { ctx, steps, outputs, controller };
}

test('a status endpoint that still says running rejects; it never reports success from the stream alone', async t => {
  const f = await fake(t);
  f.events = [frame('run.completed', {})];
  f.status = { status: 'running' };
  const { ctx } = context();
  await assert.rejects(new HermesRunner({ apiKey: 'k', baseUrl: f.url }).run(ctx), /did not finish/);
});
test('a completed run with empty output reports a neutral Done, with output the output', async t => {
  const f = await fake(t);
  f.status = { status: 'completed', output: '' };
  assert.equal(await new HermesRunner({ apiKey: 'k', baseUrl: f.url }).run(context().ctx), 'Done');
  f.status = { status: 'completed' };
  assert.equal(await new HermesRunner({ apiKey: 'k', baseUrl: f.url }).run(context().ctx), 'Done');
  f.status = { status: 'completed', output: 'real answer' };
  assert.equal(await new HermesRunner({ apiKey: 'k', baseUrl: f.url }).run(context().ctx), 'real answer');
});
test('an IPv6 loopback endpoint is accepted, a lookalike remote one is not', () => {
  assert.doesNotThrow(() => new HermesRunner({ apiKey: 'k', baseUrl: 'http://[::1]:8642' }));
  assert.throws(() => new HermesRunner({ apiKey: 'k', baseUrl: 'http://[::ffff:127.0.0.1]:8642' }), /non-loopback/);
  assert.throws(() => new HermesRunner({ apiKey: 'k', baseUrl: 'http://127.0.0.1.evil.example:8642' }), /non-loopback/);
});
test('event text is capped at exactly 1900 characters after control characters are cleaned', async t => {
  const f = await fake(t);
  f.events = [frame('message.interim', { text: 'y'.repeat(2_000) })];
  const { ctx, outputs } = context();
  await new HermesRunner({ apiKey: 'k', baseUrl: f.url }).run(ctx);
  assert.equal(outputs[0]!.length, 1_900);
});
