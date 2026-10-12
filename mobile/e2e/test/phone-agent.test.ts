/** The Orbit 1.0 demo path: phone pairs by QR, submits a task, watches it run, approves a step, sees completion. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startDesktop } from '../../../desktop/src/desktop-service.js';
import type { AgentRunContext, AgentRunner } from '../../../desktop/src/agent/agent-runner.js';
import { AgentApi } from '../../core/src/agent.js';
import { pairWithQr } from '../../core/src/pairing.js';
import { CommandError, OrbitSession } from '../../core/src/session.js';
import { TERMINAL_TASK_STATES, type TaskSummary } from '../../core/src/protocol.js';
import { NodePinnedTransport } from './node-pinned-transport.js';

class DemoRunner implements AgentRunner {
  async run(ctx: AgentRunContext): Promise<string> {
    ctx.step('Reading your request');
    if (ctx.prompt.includes('approve')) {
      ctx.step('Needs permission to continue');
      if (!await ctx.requestApproval('Send the draft email to Sam')) throw new Error('declined');
    }
    if (ctx.prompt.includes('slow')) await new Promise<void>((_r, rej) => ctx.signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true }));
    ctx.output('All done');
    return 'Finished';
  }
}

async function phone(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-phone-e2e-'));
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test',
    discovery: false, agent: { runner: new DemoRunner() } });
  const transport = new NodePinnedTransport(new Map());
  const qr = service.pairing.open();
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  const session = new OrbitSession(paired, transport, { uuid: randomUUID });
  t.after(async () => { session.stop(); await service.stop(); rmSync(root, { recursive: true, force: true }); });
  await session.start();
  return { service, session, api: new AgentApi(session, randomUUID), paired, transport };
}
async function until(read: () => Promise<TaskSummary>, ok: (s: TaskSummary) => boolean): Promise<TaskSummary> {
  for (let i = 0; i < 200; i++) { const s = await read(); if (ok(s)) return s; await delay(10); }
  throw new Error('timed out waiting for task state');
}

test('phone pairs by QR, runs a task to completion and reads its history', async t => {
  const { api, service } = await phone(t);
  const created = await api.submit('tidy my downloads');
  const done = await until(() => api.get(created.taskId), s => TERMINAL_TASK_STATES.has(s.state));
  assert.equal(done.state, 'completed');
  const events = await api.events(created.taskId);
  assert.ok(events.some(e => e.kind === 'step' && e.text === 'Reading your request'));
  assert.ok(events.some(e => e.kind === 'output' && e.text === 'All done'));
  assert.equal((await api.list()).length, 1);
  assert.equal(service.log.snapshot().filter(e => e.eventType === 'pairing.completed').length, 1);
});

test('an approval request waits for the phone and the decision is honoured', async t => {
  const { api } = await phone(t);
  const approve = await api.submit('please approve this');
  await until(() => api.get(approve.taskId), s => s.state === 'awaiting-approval');
  assert.ok((await api.events(approve.taskId)).some(e => e.kind === 'approval-request'));
  assert.equal(await api.approve(approve.taskId, true), 'approved');
  assert.equal((await until(() => api.get(approve.taskId), s => TERMINAL_TASK_STATES.has(s.state))).state, 'completed');

  const deny = await api.submit('please approve this too');
  await until(() => api.get(deny.taskId), s => s.state === 'awaiting-approval');
  assert.equal(await api.approve(deny.taskId, false), 'denied');
  assert.equal((await until(() => api.get(deny.taskId), s => TERMINAL_TASK_STATES.has(s.state))).state, 'failed');
});

test('cancel stops a running task and a second cancel is a clear error', async t => {
  const { api } = await phone(t);
  const task = await api.submit('slow job');
  await until(() => api.get(task.taskId), s => s.state === 'running');
  await api.cancel(task.taskId);
  assert.equal((await until(() => api.get(task.taskId), s => TERMINAL_TASK_STATES.has(s.state))).state, 'cancelled');
  await assert.rejects(api.cancel(task.taskId), (e: CommandError) => e.code === 'AGENT_INVALID_STATE');
});

test('retrying a submit with the same idempotency key never starts a second task', async t => {
  const { api } = await phone(t);
  const key = randomUUID();
  const a = await api.submit('tidy my downloads', key);
  const b = await api.submit('tidy my downloads', key);
  assert.equal(a.taskId, b.taskId);
  await until(() => api.get(a.taskId), s => TERMINAL_TASK_STATES.has(s.state));
  assert.equal((await api.list()).length, 1);
});

test('live task updates are pushed to the phone without polling', async t => {
  const { api, session } = await phone(t);
  const seen: string[] = [];
  session.onEvent(e => { if (e.eventType === 'agent.task') seen.push((e.data as { state: string }).state); });
  const task = await api.submit('tidy my downloads');
  await until(() => api.get(task.taskId), s => TERMINAL_TASK_STATES.has(s.state));
  await delay(50);
  assert.ok(seen.includes('completed'), `saw ${seen.join(',')}`);
});

test('a revoked or unknown task id is an error, not a crash', async t => {
  const { api } = await phone(t);
  await assert.rejects(api.get(randomUUID()), (e: CommandError) => e.code === 'AGENT_NOT_FOUND');
});

test('a wrong pin is refused before any credential is sent', async t => {
  const { service, paired } = await phone(t);
  const bad = new NodePinnedTransport(new Map([['00'.repeat(32), service.hint.certificate]]));
  await assert.rejects(bad.postCredential({ desktopServiceId: paired.desktopServiceId, endpoint: paired.endpoint,
    certificateFingerprint: '00'.repeat(32) }, '/v1/session', paired.credential));
});
