/** Tests the durable agent audit trail and its command; depends on the real router and synthetic runners. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { AgentTasks } from '../src/agent/agent-tasks.js';
import type { AgentRunContext, AgentRunner } from '../src/agent/agent-runner.js';
import { AuditTrail, MAX_AUDIT_ENTRIES } from '../src/agent/audit-trail.js';
import { TaskLedger } from '../src/agent/task-ledger.js';
import type { JsonValue, ResponseMessage } from '../src/protocol/messages.js';
import { core } from './helpers.js';

const dir = (t: TestContext) => { const d = mkdtempSync(join(tmpdir(), 'orbit-audit-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

class Runner implements AgentRunner {
  release!: (v: string) => void;
  async run(ctx: AgentRunContext): Promise<string> {
    if (ctx.prompt.includes('ask')) { if (!await ctx.requestApproval('SECRET-DESCRIPTION')) throw new Error('declined'); }
    return new Promise<string>((resolve, reject) => { this.release = resolve; ctx.signal.addEventListener('abort', () => reject(new Error('x')), { once: true }); });
  }
}
function fixture(t: TestContext) {
  const directory = dir(t); const setup = core(); const runner = new Runner();
  const audit = new AuditTrail(directory);
  const tasks = new AgentTasks(setup.registry, new TaskLedger(directory), runner, audit);
  t.after(() => { void tasks.stop(); });
  const issued = setup.auth.issue(setup.credential)!;
  const conn = { id: randomUUID(), closed: new AbortController().signal, isAuthorized: () => !!setup.auth.authenticate(issued.sessionToken), publish: () => {} };
  const command = (type: string, payload: JsonValue): Promise<ResponseMessage> =>
    setup.router.dispatch({ version: 1, type, payload, requestId: randomUUID() }, issued.sessionToken, conn);
  return { ...setup, directory, audit, command, runner };
}
const result = (r: ResponseMessage): any => { assert.ok(r.payload.ok, JSON.stringify(r.payload)); return r.payload.result; };

test('submit, approval, decision and completion are recorded, without prompt or approval text', async t => {
  const f = fixture(t);
  const { taskId } = result(await f.command('agent.submit', { prompt: 'PRIVATE-PROMPT ask', idempotencyKey: randomUUID() }));
  await tick();
  const ask = result(await f.command('agent.events', { taskId })).events.at(-1);
  result(await f.command('agent.approve', { taskId, approve: true, controlId: ask.controlId }));
  await tick(); f.runner.release('done'); await tick();
  const kinds = result(await f.command('agent.audit', {})).entries.map((e: any) => e.kind).reverse();
  assert.deepEqual(kinds, ['submitted', 'approval-requested', 'approved', 'finished']);
  const raw = readFileSync(join(f.directory, 'agent-audit.jsonl'), 'utf8');
  assert.doesNotMatch(raw, /PRIVATE-PROMPT|SECRET-DESCRIPTION/);
  // POSIX permission bits do not exist on Windows; there the file is protected by the private directory's ACL instead.
  if (process.platform !== 'win32') assert.equal(statSync(join(f.directory, 'agent-audit.jsonl')).mode & 0o077, 0);
});
test('denial and cancellation are recorded; an idempotent retry is not a second submission', async t => {
  const f = fixture(t);
  const key = randomUUID();
  const a = result(await f.command('agent.submit', { prompt: 'ask one', idempotencyKey: key }));
  await f.command('agent.submit', { prompt: 'ask one', idempotencyKey: key });
  await tick();
  const askA = result(await f.command('agent.events', { taskId: a.taskId })).events.at(-1);
  result(await f.command('agent.approve', { taskId: a.taskId, approve: false, controlId: askA.controlId })); await tick();
  const b = result(await f.command('agent.submit', { prompt: 'plain', idempotencyKey: randomUUID() }));
  result(await f.command('agent.cancel', { taskId: b.taskId })); await tick();
  const entries = result(await f.command('agent.audit', {})).entries;
  assert.equal(entries.filter((e: any) => e.kind === 'submitted').length, 2);
  assert.ok(entries.some((e: any) => e.kind === 'denied'));
  assert.ok(entries.some((e: any) => e.kind === 'cancelled-by-user'));
  assert.ok(entries.some((e: any) => e.kind === 'finished' && e.outcome === 'cancelled'));
});
test('a failed command is not audited as a decision', async t => {
  const f = fixture(t);
  const r = await f.command('agent.approve', { taskId: randomUUID(), approve: true, controlId: randomUUID() });
  assert.equal(r.payload.ok, false);
  assert.equal(result(await f.command('agent.audit', {})).entries.length, 0);
});
test('each device sees only its own entries', async t => {
  const f = fixture(t);
  f.audit.record({ taskId: randomUUID(), deviceId: randomUUID(), kind: 'submitted' });
  result(await f.command('agent.submit', { prompt: 'plain', idempotencyKey: randomUUID() }));
  const entries = result(await f.command('agent.audit', {})).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].deviceId, f.deviceId);
});
test('survives restart, ignores a torn last line and rejects extra audit payload', async t => {
  const f = fixture(t);
  const id = randomUUID();
  f.audit.record({ taskId: randomUUID(), deviceId: id, kind: 'submitted' });
  appendFileSync(join(f.directory, 'agent-audit.jsonl'), '{"at":1,"task');
  const again = new AuditTrail(f.directory);
  assert.equal(again.forDevice(id).length, 1);
  const bad = await f.command('agent.audit', { extra: 1 });
  assert.equal(bad.payload.ok, false);
});
test('the file is bounded and keeps the newest entries', t => {
  const directory = dir(t); const trail = new AuditTrail(directory); const device = randomUUID();
  for (let i = 0; i < MAX_AUDIT_ENTRIES + 300; i++) trail.record({ taskId: randomUUID(), deviceId: device, kind: 'submitted', outcome: String(i) });
  const lines = readFileSync(join(directory, 'agent-audit.jsonl'), 'utf8').trim().split('\n');
  assert.ok(lines.length <= MAX_AUDIT_ENTRIES + 200);
  assert.equal(trail.forDevice(device, 1)[0]!.outcome, String(MAX_AUDIT_ENTRIES + 299));
});
test('an unwritable audit file never throws into the agent path', t => {
  const directory = dir(t); const trail = new AuditTrail(directory);
  rmSync(directory, { recursive: true, force: true });
  assert.equal(trail.record({ taskId: randomUUID(), deviceId: randomUUID(), kind: 'submitted' }), false);
});

test('export lists every device oldest first as JSON and CSV with ISO times', async () => {
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'orbit-audit-export-'));
  let t = Date.UTC(2026, 9, 12, 12, 0, 0);
  const trail = new AuditTrail(dir, () => (t += 1000));
  const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
  trail.record({ deviceId: a, kind: 'submitted', taskId: '33333333-3333-4333-8333-333333333333' });
  trail.record({ deviceId: b, kind: 'paused' });
  const rows = trail.exportAll('csv').trim().split('\n');
  assert.equal(rows[0], 'time,kind,deviceId,taskId,outcome');
  assert.equal(rows.length, 3);
  assert.ok(rows[1]!.startsWith('2026-10-12T12:00:01.000Z,submitted,' + a));
  assert.ok(rows[2]!.includes(',paused,' + b));
  const json = JSON.parse(trail.exportAll('json')) as { kind: string; time: string }[];
  assert.deepEqual(json.map(e => e.kind), ['submitted', 'paused']);
});

test('compaction keeps the newest 2,000 entries, and a page limit caps what a device sees', t => {
  const trail = new AuditTrail(dir(t)); const device = randomUUID();
  for (let i = 0; i < MAX_AUDIT_ENTRIES + 300; i++) trail.record({ deviceId: device, kind: 'paused', outcome: String(i) });
  const kept = (JSON.parse(trail.exportAll('json')) as { outcome: string }[]);
  assert.ok(kept.length >= MAX_AUDIT_ENTRIES, 'compaction never trims below the retention size');
  assert.ok(kept.length <= MAX_AUDIT_ENTRIES + 200);
  assert.equal(kept[0]!.outcome, String(MAX_AUDIT_ENTRIES + 300 - kept.length), 'what survives is a contiguous newest suffix');
  assert.equal(trail.forDevice(device, 7).length, 7);
  assert.equal(trail.forDevice(device).length, 50, 'the default page is 50');
});

test('CSV export neutralises spreadsheet formulas and quotes separators', t => {
  const trail = new AuditTrail(dir(t)); const device = randomUUID();
  trail.record({ deviceId: device, kind: 'finished', outcome: '=SUM(A1)' });
  trail.record({ deviceId: device, kind: 'finished', outcome: 'a,"b"' });
  const rows = trail.exportAll('csv').trim().split('\n');
  assert.ok(rows[1]!.endsWith(",'=SUM(A1)"), 'a leading = is defused with an apostrophe');
  assert.ok(rows[2]!.endsWith(',"a,""b"""'), 'commas and quotes are escaped');
});
