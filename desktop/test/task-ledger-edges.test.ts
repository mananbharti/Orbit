/** Ledger edges the routed suite does not pin; drives TaskLedger directly with a synthetic clock. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MAX_LEDGER_TASKS, TaskLedger } from '../src/agent/task-ledger.js';

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-ledger-edge-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let clock = 1_000;
  return { ledger: new TaskLedger(directory, () => clock++), device: randomUUID(), directory };
}

test('a prompt of only control characters falls back to a neutral headline', t => {
  const { ledger, device } = fixture(t);
  assert.equal(ledger.create(device, '', randomUUID()).task.headline, 'Task');
});
test('a step note is capped at 2000 characters', t => {
  const { ledger, device } = fixture(t);
  const task = ledger.create(device, 'work', randomUUID()).task;
  ledger.transition(task, 'running', 'Started');
  ledger.note(task, 'step', 'y'.repeat(3_000));
  assert.equal(task.events.at(-1)!.text.length, 2_000);
});
test('an unknown-outcome task is evictable like a finished one when the ledger is full', t => {
  const { ledger, device } = fixture(t);
  const stale = ledger.create(device, 'lost run', randomUUID()).task;
  ledger.transition(stale, 'running', 'Started');
  ledger.transition(stale, 'unknown', 'Service restarted; outcome unknown'); // the very oldest
  for (let i = 0; i < MAX_LEDGER_TASKS - 1; i++) ledger.transition(ledger.create(device, `t${i}`, randomUUID()).task, 'cancelled', 'done');
  ledger.create(device, 'the 501st', randomUUID());
  assert.throws(() => ledger.get(device, stale.taskId), /AGENT_NOT_FOUND/, 'the stale unknown task made room');
});
test('an unknown task can still be closed as cancelled or failed, but never revived', t => {
  const { ledger, device } = fixture(t);
  const a = ledger.create(device, 'a', randomUUID()).task;
  ledger.transition(a, 'running', 'Started');
  ledger.transition(a, 'unknown', 'Service restarted; outcome unknown');
  assert.throws(() => ledger.transition(a, 'running', 'revive'), /AGENT_INVALID_STATE/);
  ledger.transition(a, 'cancelled', 'Closed by user');
  const b = ledger.create(device, 'b', randomUUID()).task;
  ledger.transition(b, 'running', 'Started');
  ledger.transition(b, 'unknown', 'Service restarted; outcome unknown');
  ledger.transition(b, 'failed', 'Confirmed failed');
  assert.equal(b.state, 'failed');
});
test('a note on a finished task is dropped, not appended', t => {
  const { ledger, device } = fixture(t);
  const task = ledger.create(device, 'work', randomUUID()).task;
  ledger.transition(task, 'running', 'Started');
  ledger.transition(task, 'completed', 'Done');
  const before = task.events.length;
  ledger.note(task, 'step', 'late note');
  assert.equal(task.events.length, before);
});
test('the ledger file is private to this user', { skip: process.platform === 'win32' && 'file modes do not exist on Windows' }, t => {
  const { ledger, device, directory } = fixture(t);
  ledger.create(device, 'work', randomUUID());
  assert.equal(statSync(join(directory, 'agent-tasks.json')).mode & 0o777, 0o600);
});
