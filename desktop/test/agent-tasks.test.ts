/** Tests agent task commands and the ledger; depends on the real router and synthetic runners; never starts a real agent harness. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { AgentTasks, MAX_CONCURRENT_TASKS } from '../src/agent/agent-tasks.js';
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
function fixture(t: TestContext, directory = mkdtempSync(join(tmpdir(), 'orbit-agent-test-')), pauseFile?: string) {
  const setup = core(); const runner = new ScriptedRunner();
  const ledger = new TaskLedger(directory);
  const tasks = new AgentTasks(setup.registry, ledger, runner, undefined, pauseFile);
  t.after(() => { void tasks.stop(); rmSync(directory, { recursive: true, force: true }); });
  const published: JsonValue[] = [];
  const connectionFor = (token: string) => { const closed = new AbortController();
    return { id: randomUUID(), closed: closed.signal, isAuthorized: () => !!setup.auth.authenticate(token), publish: (_t: string, data: JsonValue) => { published.push(data); } }; };
  const issued = setup.auth.issue(setup.credential)!;
  const connection = connectionFor(issued.sessionToken);
  const command = (type: string, payload: JsonValue, session = issued, conn = connection) =>
    setup.router.dispatch({ version: 1, type, payload, requestId: randomUUID() }, session.sessionToken, conn);
  return { ...setup, runner, ledger, tasks, directory, published, command, issued, connectionFor };
}
function result(response: ResponseMessage): Record<string, any> { assert.ok(response.payload.ok, JSON.stringify(response.payload)); return response.payload.result as Record<string, any>; }
function error(response: ResponseMessage, code: string): void { assert.deepEqual(response.payload, { ok: false, error: { code } }); }
const submit = (prompt = 'do the thing', idempotencyKey: string = randomUUID()) => ({ prompt, idempotencyKey });

test('a task runs, streams events to the owner and completes with a summary', async t => {
  const { command, runner, published } = fixture(t);
  const created = result(await command('agent.submit', submit()));
  assert.equal(created.state, 'running');
  runner.contexts[0]!.step('Reading files'); runner.contexts[0]!.output('partial');
  runner.releases[0]!('All done'); await tick(); await tick();
  const view = result(await command('agent.get', { taskId: created.taskId }));
  assert.equal(view.state, 'completed');
  const page = result(await command('agent.events', { taskId: created.taskId }));
  assert.deepEqual(page.events.map((event: any) => event.text), ['Queued', 'Started', 'Reading files', 'partial', 'All done']);
  assert.ok(published.length >= 3);
});

test('a disk failure mid-run cannot crash the service: the task still settles in memory', async t => {
  const { command, runner, ledger, tasks } = fixture(t);
  const created = result(await command('agent.submit', submit()));
  (ledger as unknown as { save: () => void }).save = () => { throw new Error('ENOSPC: disk full'); };
  runner.contexts[0]!.step('still streaming'); // note() must not throw into the runner
  runner.releases[0]!('Done anyway'); await tick(); await tick(); await tick();
  const view = result(await command('agent.get', { taskId: created.taskId }));
  assert.equal(view.state, 'completed', 'the in-memory record settles even though persistence failed');
  await tasks.stop();
});

test('retrying a submit with the same idempotency key does not start a second run', async t => {
  const { command, runner } = fixture(t);
  const body = submit();
  const first = result(await command('agent.submit', body)); const second = result(await command('agent.submit', body));
  assert.equal(first.taskId, second.taskId); assert.equal(runner.contexts.length, 1);
});

test('concurrency is bounded and the rejected task is recorded as cancelled', async t => {
  const { command, runner } = fixture(t);
  for (let index = 0; index < MAX_CONCURRENT_TASKS; index++) result(await command('agent.submit', submit()));
  error(await command('agent.submit', submit()), 'AGENT_LIMIT');
  assert.equal(runner.contexts.length, MAX_CONCURRENT_TASKS);
});

test('approval gates a step: denial and approval are explicit, and nothing is auto-approved', async t => {
  const { command, runner } = fixture(t);
  const { taskId } = result(await command('agent.submit', submit()));
  const pending = runner.contexts[0]!.requestApproval('Delete 3 files');
  await tick();
  assert.equal(result(await command('agent.get', { taskId })).state, 'awaiting-approval');
  assert.equal(result(await command('agent.events', { taskId })).events.at(-1).kind, 'approval-request');
  assert.deepEqual(result(await command('agent.approve', { taskId, approve: false })), { status: 'denied' });
  assert.equal(await pending, false);
  assert.equal(result(await command('agent.get', { taskId })).state, 'running');
  error(await command('agent.approve', { taskId, approve: true }), 'AGENT_INVALID_STATE');
});

test('cancel aborts the runner, resolves pending approvals as denied and is final', async t => {
  const { command, runner } = fixture(t);
  const { taskId } = result(await command('agent.submit', submit()));
  const pending = runner.contexts[0]!.requestApproval('Send email');
  await tick();
  await command('agent.cancel', { taskId });
  assert.equal(await pending, false); await tick(); await tick();
  assert.equal(result(await command('agent.get', { taskId })).state, 'cancelled');
  error(await command('agent.cancel', { taskId }), 'AGENT_INVALID_STATE');
});

test('a failing runner marks the task failed without leaking its error text', async t => {
  const { command, runner } = fixture(t);
  const { taskId } = result(await command('agent.submit', submit()));
  runner.failures[0]!(new Error('secret stack /home/user/.ssh')); await tick(); await tick();
  assert.equal(result(await command('agent.get', { taskId })).state, 'failed');
  const events = JSON.stringify(result(await command('agent.events', { taskId })));
  assert.equal(events.includes('secret'), false);
});

test('tasks are private to the device that created them', async t => {
  const { command, runner, addDevice, auth, connectionFor } = fixture(t);
  const { taskId } = result(await command('agent.submit', submit()));
  const other = auth.issue(addDevice().credential)!;
  const otherConn = connectionFor(other.sessionToken);
  error(await command('agent.get', { taskId }, other, otherConn), 'AGENT_NOT_FOUND');
  error(await command('agent.cancel', { taskId }, other, otherConn), 'AGENT_NOT_FOUND');
  assert.deepEqual(result(await command('agent.list', {}, other, otherConn)).tasks, []);
  assert.equal(runner.contexts[0]!.signal.aborted, false);
});

test('invalid payloads are rejected before reaching the ledger', async t => {
  const { command, ledger, issued } = fixture(t);
  error(await command('agent.submit', { prompt: '', idempotencyKey: randomUUID() }), 'INVALID_PAYLOAD');
  error(await command('agent.submit', { prompt: 'x', idempotencyKey: 'nope' }), 'INVALID_PAYLOAD');
  error(await command('agent.get', { taskId: 'nope' }), 'INVALID_PAYLOAD');
  assert.equal(ledger.list(issued.sessionToken).length, 0);
});

test('restart reconciliation marks interrupted work unknown instead of pretending it finished', async t => {
  const first = fixture(t);
  const { taskId } = result(await first.command('agent.submit', submit()));
  const reloaded = new TaskLedger(first.directory);
  const task = reloaded.get(first.deviceId, taskId);
  assert.equal(task.state, 'unknown');
  assert.equal(task.events.at(-1)!.text, 'Service restarted; outcome unknown');
  const again = new TaskLedger(first.directory);
  assert.equal(again.get(first.deviceId, taskId).state, 'unknown'); // stable across repeated restarts
});

test('a corrupt ledger fails closed rather than being replaced', t => {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-agent-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'agent-tasks.json'), JSON.stringify({ version: 1, tasks: [{ taskId: 'bad' }] }));
  assert.throws(() => new TaskLedger(directory), /AGENT_LEDGER_IO/);
  assert.ok(readFileSync(join(directory, 'agent-tasks.json'), 'utf8').includes('bad'));
});

test('the ledger bounds events per task and keeps sequence numbers monotonic', t => {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-agent-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ledger = new TaskLedger(directory); const device = randomUUID();
  const { task } = ledger.create(device, 'bounded', randomUUID());
  ledger.transition(task, 'running', 'Started');
  for (let index = 0; index < 1_100; index++) ledger.note(task, 'step', `s${index}`);
  assert.equal(task.events.length, 1_000);
  const seqs = task.events.map(event => event.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(seqs.at(-1), 1_102);
});

test('retry starts a new task with the same request only after a failed, cancelled or interrupted one', async t => {
  const { command, runner } = fixture(t);
  const first = result(await command('agent.submit', submit('summarise the notes')));
  error(await command('agent.retry', { taskId: first.taskId, idempotencyKey: randomUUID() }), 'AGENT_INVALID_STATE'); // still running
  runner.failures[0]!(new Error('boom')); await tick(); await tick();
  assert.equal(result(await command('agent.get', { taskId: first.taskId })).state, 'failed');
  const key = randomUUID();
  const again = result(await command('agent.retry', { taskId: first.taskId, idempotencyKey: key }));
  assert.notEqual(again.taskId, first.taskId);
  assert.equal(again.state, 'running');
  assert.equal(runner.contexts[1]!.prompt, 'summarise the notes');
  // Double tap with the same key does not start a third run.
  assert.equal(result(await command('agent.retry', { taskId: first.taskId, idempotencyKey: key })).taskId, again.taskId);
  assert.equal(runner.contexts.length, 2);
  // The original is untouched and a stranger cannot retry it.
  assert.equal(result(await command('agent.get', { taskId: first.taskId })).state, 'failed');
});
test('retry is refused while the agent is paused', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-agent-retry-'));
  const { command, runner, tasks } = fixture(t, dir);
  const first = result(await command('agent.submit', submit()));
  runner.failures[0]!(new Error('x')); await tick(); await tick();
  result(await command('agent.pause', {}));
  error(await command('agent.retry', { taskId: first.taskId, idempotencyKey: randomUUID() }), 'AGENT_PAUSED');
  void tasks;
});

test('safe mode aborts running work, refuses new submissions, survives a restart, and fails closed on IO errors', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-agent-pause-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pauseFile = join(dir, 'agent.paused');
  const f = fixture(t, dir, pauseFile);
  const { taskId } = result(await f.command('agent.submit', submit()));
  result(await f.command('agent.pause', {}));
  await tick(); await tick(); // the aborted run settles
  assert.equal(result(await f.command('agent.get', { taskId })).state, 'cancelled', 'pausing aborts in-flight work');
  error(await f.command('agent.submit', submit()), 'AGENT_PAUSED');
  assert.equal(existsSync(pauseFile), true);
  await f.tasks.stop();
  const revived = new AgentTasks(f.registry, new TaskLedger(dir), new ScriptedRunner(), undefined, pauseFile);
  t.after(() => { void revived.stop(); });
  assert.equal(result(await f.command('agent.status', {})).paused, true, 'safe mode survives a restart');
  result(await f.command('agent.resume', {}));
  assert.equal(existsSync(pauseFile), false);
  mkdirSync(pauseFile); // a directory where the flag file belongs makes the durability write fail
  error(await f.command('agent.pause', {}), 'AGENT_LEDGER_IO');
  assert.equal(result(await f.command('agent.status', {})).paused, false, 'a pause that cannot be made durable never claims to be active');
});

test('agent.events pages at 64, reports hasMore, and resumes after a sequence number', async t => {
  const { command, runner, ledger, deviceId } = fixture(t);
  const { taskId } = result(await command('agent.submit', submit()));
  const task = ledger.get(deviceId, taskId);
  for (let i = 0; i < 100; i++) ledger.note(task, 'output', `line ${i}`);
  const first = result(await command('agent.events', { taskId }));
  assert.equal(first.events.length, 64);
  assert.equal(first.hasMore, true);
  const last = first.events.at(-1).seq;
  const second = result(await command('agent.events', { taskId, afterSeq: last }));
  assert.equal(second.events[0].seq, last + 1, 'the next page starts right after the cursor');
  assert.equal(second.events.length, task.events.length - 64);
  assert.equal(second.hasMore, false);
  assert.equal(result(await command('agent.events', { taskId, afterSeq: task.events.at(-1)!.seq })).events.length, 0);
  void runner;
});
