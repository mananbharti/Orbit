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

function setup(opts: { confirm?: BiometricConfirmation; spawn?: (command: string, cwd: string) => FakeChild; home?: string; idleMs?: number } = {}) {
  const registry = new CommandRegistry();
  const children: FakeChild[] = [];
  const spawn = (command: string, cwd: string): ChildProcessWithoutNullStreams => {
    const child = (opts.spawn ?? (() => new FakeChild()))(command, cwd);
    (child as unknown as { command: string }).command = command; (child as unknown as { cwd: string }).cwd = cwd;
    children.push(child);
    return child.asChild();
  };
  const home = opts.home ?? mkdtempSync(join(tmpdir(), 'orbit-term-home-'));
  const service = new TerminalService(registry, new ActivityLog(), opts.confirm ?? approve, spawn, home, opts.idleMs);
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

test('a running command pauses the idle watchdog instead of being killed by it', async () => {
  const child = new FakeChild();
  const { registry, service } = setup({ spawn: () => child, idleMs: 60 });
  const conn = connection();
  const ctx = context(conn);
  const started = await registry.get('terminal.begin')!.execute({}, ctx) as { sessionId: string };
  const exec = registry.get('terminal.exec')!.execute({ sessionId: started.sessionId, command: 'npm run build', timeoutMs: 10_000 }, ctx) as Promise<{ exitCode: number | null }>;
  await new Promise(resolve => setTimeout(resolve, 140)); // well past the idle window, command still running
  child.emit('exit', 0);
  assert.equal((await exec).exitCode, 0, 'the command outlived the idle window and completed normally');
  const interrupt = await registry.get('terminal.interrupt')!.execute({ sessionId: started.sessionId }, ctx) as { interrupted: boolean };
  assert.equal(interrupt.interrupted, false, 'the session is still alive afterwards (nothing to interrupt)');
  await service.stop();
});

test('the idle watchdog still ends a session with no command running', async () => {
  const { registry, service } = setup({ idleMs: 50 });
  const ctx = context(connection());
  const started = await registry.get('terminal.begin')!.execute({}, ctx) as { sessionId: string };
  await new Promise(resolve => setTimeout(resolve, 100));
  await assert.rejects(registry.get('terminal.exec')!.execute({ sessionId: started.sessionId, command: 'echo ok' }, ctx),
    (e: ProtocolError) => e.code === 'TERMINAL_SESSION_REQUIRED');
  await service.stop();
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

test('a session answers only to the connection, login session and device that began it, and only while they are valid', async () => {
  // A command that exits at once: if a guard is missing the attempt succeeds and the test fails fast instead of hanging.
  const { registry, service } = setup({ spawn: () => { const c = new FakeChild(); queueMicrotask(() => c.emit('exit', 0)); return c; } });
  const conn = connection(); const ctx = context(conn);
  const { sessionId } = await registry.get('terminal.begin')!.execute({}, ctx) as { sessionId: string };
  const exec = registry.get('terminal.exec')!;
  const attempt = (c: CommandContext) => exec.execute({ sessionId, command: 'echo hi' }, c);
  const code = (e: unknown) => (e as ProtocolError).code;
  await assert.rejects(attempt(context(connection())), (e: unknown) => code(e) === 'TERMINAL_SESSION_REQUIRED'); // same user, a different socket
  const otherLogin = context(conn); (otherLogin.session as { sessionId: string }).sessionId = 'another-login';
  await assert.rejects(attempt(otherLogin), (e: unknown) => code(e) === 'TERMINAL_SESSION_REQUIRED');
  const otherDevice = context(conn); (otherDevice.session as { deviceId: string }).deviceId = 'eeeeeeee-eeee-4eee-beee-eeeeeeeeeeee';
  await assert.rejects(attempt(otherDevice), (e: unknown) => code(e) === 'TERMINAL_SESSION_REQUIRED');
  const expired = context(conn); (expired.session as { expiresAt: number }).expiresAt = Date.now() - 1;
  await assert.rejects(attempt(expired), (e: unknown) => code(e) === 'UNAUTHENTICATED');
  const dead = new AbortController(); dead.abort();
  const closedConn = { ...conn, closed: dead.signal } as CommandConnection;
  await assert.rejects(attempt(context(closedConn)), (e: unknown) => code(e) === 'UNAUTHENTICATED');
  await service.stop();
});

test('dropping the connection kills the running command and frees the terminal for the next approved session', async () => {
  const { registry, children, service } = setup({ spawn: () => new FakeChild() });
  const gone = new AbortController();
  const conn = { ...connection(), closed: gone.signal } as CommandConnection;
  const ctx = context(conn);
  const { sessionId } = await registry.get('terminal.begin')!.execute({}, ctx) as { sessionId: string };
  const running = registry.get('terminal.exec')!.execute({ sessionId, command: 'sleep 600' }, ctx);
  await new Promise(r => setTimeout(r, 25));
  gone.abort(); // the phone vanished mid-command
  await running;
  assert.ok(children[0]!.killed.includes('SIGTERM'), 'the orphaned command is killed, not left running');
  const next = await registry.get('terminal.begin')!.execute({}, context(connection())) as { sessionId: string };
  assert.notEqual(next.sessionId, sessionId, 'the slot is free again');
  await service.stop();
});

test('output is capped at 48 KB, chunked at 4 KB, and the command is killed once the cap is hit', async () => {
  const published: { eventType: string; data: unknown }[] = [];
  const { registry, children, service } = setup({ spawn: () => {
    const child = new FakeChild();
    queueMicrotask(() => { for (let i = 0; i < 20; i++) child.stdout.emit('data', 'x'.repeat(4_096)); child.emit('exit', 0); });
    return child;
  } });
  const ctx = context(connection(published));
  const { sessionId } = await registry.get('terminal.begin')!.execute({}, ctx) as { sessionId: string };
  const result = await registry.get('terminal.exec')!.execute({ sessionId, command: 'yes' }, ctx) as { truncated: boolean };
  const sent = published.filter(e => e.eventType === 'terminal.output').map(e => (e.data as { data: string }).data);
  assert.equal(result.truncated, true);
  assert.equal(sent.join('').length, 48 * 1024, 'nothing past the cap reaches the phone');
  assert.ok(children[0]!.killed.includes('SIGTERM'), 'a flood is killed, not just ignored');
  const big = setup({ spawn: () => { const c = new FakeChild(); queueMicrotask(() => { c.stdout.emit('data', 'y'.repeat(10_000)); c.emit('exit', 0); }); return c; } });
  const bigPublished: { eventType: string; data: unknown }[] = [];
  const bigCtx = context(connection(bigPublished));
  const started = await big.registry.get('terminal.begin')!.execute({}, bigCtx) as { sessionId: string };
  await big.registry.get('terminal.exec')!.execute({ sessionId: started.sessionId, command: 'big' }, bigCtx);
  assert.deepEqual(bigPublished.filter(e => e.eventType === 'terminal.output').map(e => (e.data as { data: string }).data.length), [4_096, 4_096, 1_808]);
  await service.stop(); await big.service.stop();
});

test('a command that outlives its timeout is killed and reported as timed out, escalating to SIGKILL', async () => {
  const { registry, children, service } = setup({ spawn: () => new FakeChild() });
  const ctx = context(connection());
  const { sessionId } = await registry.get('terminal.begin')!.execute({}, ctx) as { sessionId: string };
  const result = await registry.get('terminal.exec')!.execute({ sessionId, command: 'hang', timeoutMs: 1_000 }, ctx) as { timedOut: boolean };
  assert.equal(result.timedOut, true);
  assert.ok(children[0]!.killed.includes('SIGTERM'));
  await new Promise(r => setTimeout(r, 2_100));
  assert.ok(children[0]!.killed.includes('SIGKILL'), 'a stubborn process gets a forced kill two seconds later');
  await service.stop();
});
