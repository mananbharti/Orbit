/** Edges the main agent-tasks suite does not pin; same fixture style as agent-tasks.test.ts. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { AgentTasks, APPROVAL_TIMEOUT_MS } from '../src/agent/agent-tasks.js';
import type { AgentRunContext, AgentRunner } from '../src/agent/agent-runner.js';
import { TaskLedger } from '../src/agent/task-ledger.js';
import type { JsonValue, ResponseMessage } from '../src/protocol/messages.js';
import { core } from './helpers.js';

class ScriptedRunner implements AgentRunner {
  contexts: AgentRunContext[] = [];
  releases: ((value: string) => void)[] = [];
  failures: ((error: Error) => void)[] = [];
  async run(context: AgentRunContext): Promise<string> {
    this.contexts.push(context);
    return new Promise<string>((resolve, reject) => {
      this.releases.push(resolve); this.failures.push(reject);
      context.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t: TestContext, directory = mkdtempSync(join(tmpdir(), 'orbit-agent-edge-'))) {
  const setup = core(); const runner = new ScriptedRunner();
  const ledger = new TaskLedger(directory);
  const tasks = new AgentTasks(setup.registry, ledger, runner);
  t.after(() => { void tasks.stop(); rmSync(directory, { recursive: true, force: true }); });
  const issued = setup.auth.issue(setup.credential)!;
  const connection = { id: randomUUID(), closed: new AbortController().signal, isAuthorized: () => true, publish: () => {} };
  const command = (type: string, payload: JsonValue) =>
    setup.router.dispatch({ version: 1, type, payload, requestId: randomUUID() }, issued.sessionToken, connection as never);
  return { runner, ledger, tasks, command, deviceId: setup.deviceId };
}
function result(response: ResponseMessage): Record<string, any> { assert.ok(response.payload.ok, JSON.stringify(response.payload)); return response.payload.result as Record<string, any>; }
const submit = (prompt = 'do the thing') => ({ prompt, idempotencyKey: randomUUID() });

test('a late runner result can never overwrite a cancelled task', async t => {
  const { command, runner } = fixture(t);
  const created = result(await command('agent.submit', submit()));
  result(await command('agent.cancel', { taskId: created.taskId }));
  assert.equal(result(await command('agent.get', { taskId: created.taskId })).state, 'cancelled');
  runner.releases[0]!('too late'); await tick(); await tick();
  const view = result(await command('agent.get', { taskId: created.taskId }));
  assert.equal(view.state, 'cancelled');
  const texts = result(await command('agent.events', { taskId: created.taskId })).events.map((e: any) => e.text);
  assert.ok(!texts.includes('too late'), JSON.stringify(texts));
});
test('the approval deadline is five minutes, the value the phone shows', () => {
  assert.equal(APPROVAL_TIMEOUT_MS, 5 * 60_000);
});
test('the completion headline is capped at 500 characters', async t => {
  const { command, runner, ledger, deviceId } = fixture(t);
  const created = result(await command('agent.submit', submit()));
  runner.releases[0]!('x'.repeat(600)); await tick(); await tick();
  assert.equal(result(await command('agent.get', { taskId: created.taskId })).state, 'completed');
  const last = ledger.get(deviceId, created.taskId).events.at(-1)!;
  assert.equal(last.text.length, 500);
});
test('stopping the service aborts the run, which settles the task cancelled, not completed', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-agent-stop-'));
  const setup = core(); const runner = new ScriptedRunner();
  const ledger = new TaskLedger(directory);
  const tasks = new AgentTasks(setup.registry, ledger, runner);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const issued = setup.auth.issue(setup.credential)!;
  const connection = { id: randomUUID(), closed: new AbortController().signal, isAuthorized: () => true, publish: () => {} };
  const command = (type: string, payload: JsonValue) =>
    setup.router.dispatch({ version: 1, type, payload, requestId: randomUUID() }, issued.sessionToken, connection as never);
  const created = result(await command('agent.submit', submit()));
  await tasks.stop();
  assert.ok(runner.contexts[0]!.signal.aborted);
  await tick(); await tick();
  assert.equal(ledger.get(setup.deviceId, created.taskId).state, 'cancelled');
});
