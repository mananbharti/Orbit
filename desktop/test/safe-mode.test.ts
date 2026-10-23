/** Tests the agent kill switch (safe mode); depends on the real router and synthetic runners. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { AgentTasks } from '../src/agent/agent-tasks.js';
import type { AgentRunContext, AgentRunner } from '../src/agent/agent-runner.js';
import { AuditTrail } from '../src/agent/audit-trail.js';
import { TaskLedger } from '../src/agent/task-ledger.js';
import type { JsonValue, ResponseMessage } from '../src/protocol/messages.js';
import { core } from './helpers.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 10));
class Runner implements AgentRunner {
  async run(ctx: AgentRunContext): Promise<string> {
    if (ctx.prompt.includes('ask')) await ctx.requestApproval('x');
    if (ctx.signal.aborted) throw new Error('aborted');
    return new Promise<string>((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('x')), { once: true }));
  }
}
function boot(t: TestContext, directory: string) {
  const setup = core();
  const tasks = new AgentTasks(setup.registry, new TaskLedger(directory), new Runner(), new AuditTrail(directory), join(directory, 'agent-paused'));
  t.after(() => { void tasks.stop(); });
  const issued = setup.auth.issue(setup.credential)!;
  const conn = { id: randomUUID(), closed: new AbortController().signal, isAuthorized: () => !!setup.auth.authenticate(issued.sessionToken), publish: () => {} };
  const command = (type: string, payload: JsonValue): Promise<ResponseMessage> =>
    setup.router.dispatch({ version: 1, type, payload, requestId: randomUUID() }, issued.sessionToken, conn);
  return { ...setup, command, tasks };
}
const ok = (r: ResponseMessage): any => { assert.ok(r.payload.ok, JSON.stringify(r.payload)); return r.payload.result; };
const submit = (prompt = 'work') => ({ prompt, idempotencyKey: randomUUID() });
const directory = (t: TestContext) => { const d = mkdtempSync(join(tmpdir(), 'orbit-safe-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };

test('pause stops running and waiting tasks and refuses new ones until resumed', async t => {
  const f = boot(t, directory(t));
  const a = ok(await f.command('agent.submit', submit()));
  const b = ok(await f.command('agent.submit', submit('ask me')));
  await tick();
  assert.equal(ok(await f.command('agent.get', { taskId: b.taskId })).state, 'awaiting-approval');
  assert.deepEqual(ok(await f.command('agent.pause', {})), { paused: true });
  await tick();
  assert.equal(ok(await f.command('agent.get', { taskId: a.taskId })).state, 'cancelled');
  assert.equal(ok(await f.command('agent.get', { taskId: b.taskId })).state, 'cancelled');
  assert.deepEqual((await f.command('agent.submit', submit())).payload, { ok: false, error: { code: 'AGENT_PAUSED' } });
  assert.deepEqual(ok(await f.command('agent.status', {})), { paused: true, answerOnly: false });
  assert.deepEqual(ok(await f.command('agent.resume', {})), { paused: false });
  assert.equal(ok(await f.command('agent.submit', submit())).state, 'running');
});
test('pause is idempotent and reads still work while paused', async t => {
  const f = boot(t, directory(t));
  const a = ok(await f.command('agent.submit', submit()));
  await f.command('agent.pause', {}); await f.command('agent.pause', {});
  await tick();
  assert.equal(ok(await f.command('agent.list', {})).tasks.length, 1);
  assert.equal(ok(await f.command('agent.events', { taskId: a.taskId, afterSeq: 0 })).events.length > 0, true);
});
test('safe mode survives a desktop restart', async t => {
  const d = directory(t);
  const first = boot(t, d);
  await first.command('agent.pause', {});
  assert.ok(existsSync(join(d, 'agent-paused')));
  await first.tasks.stop();
  const second = boot(t, d);
  assert.deepEqual(ok(await second.command('agent.status', {})), { paused: true, answerOnly: false });
  assert.equal((await second.command('agent.submit', submit())).payload.ok, false);
  await second.command('agent.resume', {});
  assert.equal(existsSync(join(d, 'agent-paused')), false);
});
test('pause and resume are audited and the commands reject extra input', async t => {
  const f = boot(t, directory(t));
  await f.command('agent.pause', {}); await f.command('agent.resume', {});
  const kinds = ok(await f.command('agent.audit', {})).entries.map((e: any) => e.kind);
  assert.deepEqual(kinds, ['resumed', 'paused']);
  for (const type of ['agent.pause', 'agent.resume', 'agent.status']) assert.equal((await f.command(type, { x: 1 })).payload.ok, false);
});
test('an unauthenticated connection cannot pause or resume', async t => {
  const f = boot(t, directory(t));
  const response = await f.router.dispatch({ version: 1, type: 'agent.pause', payload: {}, requestId: randomUUID() }, 'bogus-token', undefined as any);
  assert.equal(response.payload.ok, false);
});
