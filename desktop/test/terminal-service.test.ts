import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalService } from '../src/terminal/terminal-service.js';
import { CommandRegistry } from '../src/command-router/command-registry.js';
import { ActivityLog } from '../src/activity-log/activity-log.js';
import { ProtocolError } from '../src/protocol/errors.js';
import type { BiometricConfirmation } from '../src/security-pairing/biometric-confirmation.js';
import type { CommandContext, CommandConnection } from '../src/command-router/command-context.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed: string[] = [];
  kill(signal?: string): boolean { this.killed.push(signal ?? 'SIGTERM'); queueMicrotask(() => this.emit('exit', 1)); return true; }
  asChild(): ChildProcessWithoutNullStreams { return this as unknown as ChildProcessWithoutNullStreams; }
}
function connection(published: { eventType: string; data: unknown }[] = []): CommandConnection {
  return { id: 'conn', closed: new AbortController().signal, isAuthorized: () => true,
    publish: (eventType: string, data: unknown) => { published.push({ eventType, data }); } } as unknown as CommandConnection;
}
function context(conn: CommandConnection, authorized = true): CommandContext {
  return { session: { deviceId: 'ffffffff-ffff-4fff-bfff-ffffffffffff', sessionId: 'sess', expiresAt: Date.now() + 60_000, version: 1 } as unknown as CommandContext['session'],
    requestId: 'req', connection: authorized ? conn : undefined };
}
const approve: BiometricConfirmation = { verify: async () => true };
const deny: BiometricConfirmation = { verify: async () => false };

function setup(opts: { confirm?: BiometricConfirmation; spawn?: (command: string, cwd: string) => FakeChild; home?: string } = {}) {
  const registry = new CommandRegistry();
  const children: FakeChild[] = [];
  const spawn = (command: string, cwd: string): ChildProcessWithoutNullStreams => {
    const child = (opts.spawn ?? (() => new FakeChild()))(command, cwd);
    (child as unknown as { command: string }).command = command; (child as unknown as { cwd: string }).cwd = cwd;
    children.push(child);
    return child.asChild();
  };
  const home = opts.home ?? mkdtempSync(join(tmpdir(), 'orbit-term-home-'));
  const service = new TerminalService(registry, new ActivityLog(), opts.confirm ?? approve, spawn, home);
  return { registry, children, home, service };
}

test('terminal begin needs approval, reserves the slot, and end releases it', async () => {
  const { registry, home, service } = setup({ confirm: deny });
  const begin = registry.get('terminal.begin')!;
  await assert.rejects(begin.execute({}, context(connection())), (e: ProtocolError) => e.code === 'BIOMETRIC_REQUIRED');
  await service.stop();
  const ok = setup({ confirm: approve, home });
  const conn = connection();
  const ctx = context(conn);
  const started = await ok.registry.get('terminal.begin')!.execute({}, ctx) as { sessionId: string; cwd: string; idleTimeoutMs: number };
  assert.equal(started.cwd, home);
  await assert.rejects(ok.registry.get('terminal.begin')!.execute({}, ctx), (e: ProtocolError) => e.code === 'BUSY');
  await ok.registry.get('terminal.end')!.execute({ sessionId: started.sessionId }, ctx);
  const again = await ok.registry.get('terminal.begin')!.execute({}, ctx) as { sessionId: string };
  assert.notEqual(again.sessionId, started.sessionId);
  await ok.service.stop();
  rmSync(home, { recursive: true, force: true });
});

test('terminal exec streams bounded output events and reports the exit code and cwd', async () => {
  const published: { eventType: string; data: unknown }[] = [];
  const conn = connection(published);
  const { registry, service, home } = setup({ spawn: () => {
    const child = new FakeChild();
    queueMicrotask(() => { child.stdout.emit('data', 'hello '); child.stderr.emit('data', 'oops'); child.emit('exit', 3); });
    return child;
  } });
  const ctx = context(conn);
  const { sessionId } = await registry.get('terminal.begin')!.execute({}, ctx) as { sessionId: string };
  const result = await registry.get('terminal.exec')!.execute({ sessionId, command: 'echo hi' }, ctx) as { exitCode: number; cwd: string; truncated: boolean; timedOut: boolean };
  assert.equal(result.exitCode, 3);
  assert.equal(result.cwd, home);
  const events = published.filter(e => e.eventType === 'terminal.output') as { data: { stream: string; data: string } }[];
  assert.deepEqual(events.map(e => [e.data.stream, e.data.data]), [['stdout', 'hello '], ['stderr', 'oops']]);
  await service.stop();
  rmSync(home, { recursive: true, force: true });
});

test('terminal tracks cd itself and rejects bad directories', async () => {
  const published: { eventType: string; data: unknown }[] = [];
  const conn = connection(published);
  const sub = mkdtempSync(join(tmpdir(), 'orbit-term-sub-'));
  const { registry, service, home } = setup();
  const ctx = context(conn);
  const { sessionId } = await registry.get('terminal.begin')!.execute({}, ctx) as { sessionId: string };
  const exec = registry.get('terminal.exec')!;
  const moved = await exec.execute({ sessionId, command: `cd ${sub}` }, ctx) as { exitCode: number; cwd: string };
  assert.equal(moved.exitCode, 0);
  assert.equal(moved.cwd, sub);
  const bad = await exec.execute({ sessionId, command: 'cd /no/such/place' }, ctx) as { exitCode: number; cwd: string };
  assert.equal(bad.exitCode, 1);
  assert.equal(bad.cwd, sub); // the failed cd changed nothing
  assert.match(String((published.find(e => e.eventType === 'terminal.output')!.data as { data: string }).data), /no such directory/);
  await service.stop();
  rmSync(sub, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
});

test('terminal enforces one command at a time, interrupt kills it, and foreign sessions are rejected', async () => {
  const { registry, children, service } = setup({ spawn: () => new FakeChild() }); // never exits on its own
  const conn = connection();
  const ctx = context(conn);
  const { sessionId } = await registry.get('terminal.begin')!.execute({}, ctx) as { sessionId: string };
  const exec = registry.get('terminal.exec')!;
  const running = exec.execute({ sessionId, command: 'sleep 60' }, ctx);
  await new Promise(r => setTimeout(r, 25));
  await assert.rejects(exec.execute({ sessionId, command: 'echo hi' }, ctx), (e: ProtocolError) => e.code === 'BUSY');
  await assert.rejects(exec.execute({ sessionId: '00000000-0000-4000-8000-000000000000', command: 'echo hi' }, ctx), (e: ProtocolError) => e.code === 'TERMINAL_SESSION_REQUIRED');
  const interrupted = await registry.get('terminal.interrupt')!.execute({ sessionId }, ctx) as { interrupted: boolean };
  assert.equal(interrupted.interrupted, true);
  assert.ok(children[0]!.killed.includes('SIGTERM'));
  const result = await running as { timedOut: boolean };
  assert.equal(result.timedOut, false);
  await service.stop();
});

test('terminal refuses unauthenticated callers and stops cleanly', async () => {
  const { registry, service } = setup();
  const begin = registry.get('terminal.begin')!;
  const exec = registry.get('terminal.exec')!;
  await assert.rejects(begin.execute({}, context(connection(), false)), (e: ProtocolError) => e.code === 'UNAUTHENTICATED');
  const started = await begin.execute({}, context(connection())) as { sessionId: string };
  await service.stop(); // an open session is ended and new ones are refused
  await assert.rejects(begin.execute({}, context(connection())), (e: ProtocolError) => e.code === 'TERMINAL_UNAVAILABLE');
  await assert.rejects(exec.execute({ sessionId: started.sessionId, command: 'echo hi' }, context(connection())), (e: ProtocolError) => e.code === 'TERMINAL_SESSION_REQUIRED' || e.code === 'TERMINAL_UNAVAILABLE');
});
