import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalApi } from '../src/terminal.js';
import type { OrbitSession } from '../src/session.js';

const SID = 'aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa';
function fake(handler: (type: string, payload: unknown) => unknown) {
  const calls: { type: string; payload: unknown; options: unknown }[] = [];
  const eventListeners: ((e: unknown) => void)[] = [];
  const statusListeners: ((s: string) => void)[] = [];
  const session = {
    command: async (type: string, payload: unknown, options?: unknown) => { calls.push({ type, payload, options }); return handler(type, payload); },
    onStatus: (l: (s: string) => void) => { statusListeners.push(l); return () => undefined; },
    onEvent: (l: (e: unknown) => void) => { eventListeners.push(l); return () => undefined; },
  } as unknown as OrbitSession;
  return { session, calls, emit: (e: unknown) => eventListeners.forEach(l => l(e)), status: (s: string) => statusListeners.forEach(l => l(s)) };
}
const begun = { sessionId: SID, cwd: '/home/manan', idleTimeoutMs: 300000 };

test('losing the connection drops the session: output stops and exec needs a new begin', async () => {
  const f = fake(type => type === 'terminal.begin' ? begun : { exitCode: 0, cwd: '/home/manan', truncated: false, timedOut: false });
  const api = new TerminalApi(f.session);
  const got: string[] = [];
  api.onOutput((_s, d) => got.push(d));
  await api.begin();
  f.status('reconnecting');
  assert.equal(api.activeSessionId, undefined);
  f.emit({ eventType: 'terminal.output', data: { sessionId: SID, stream: 'stdout', data: 'late' } });
  assert.deepEqual(got, []);
  await assert.rejects(api.exec('dir'), /TERMINAL_SESSION_REQUIRED/);
  await api.begin();
  assert.equal(api.activeSessionId, SID);
  api.dispose();
});

test('end with no session sends nothing; an ended session ignores its late output', async () => {
  const f = fake(() => begun);
  const api = new TerminalApi(f.session);
  await api.end();
  assert.deepEqual(f.calls, []);
  const got: string[] = [];
  api.onOutput((_s, d) => got.push(d));
  await api.begin();
  await api.end();
  f.emit({ eventType: 'terminal.output', data: { sessionId: SID, stream: 'stdout', data: 'after end' } });
  assert.deepEqual(got, []);
  api.dispose();
});

test('malformed output events never reach listeners and unsubscribe works', async () => {
  const f = fake(() => begun);
  const api = new TerminalApi(f.session);
  const got: string[] = [];
  const off = api.onOutput((_s, d) => got.push(d));
  await api.begin();
  f.emit({ eventType: 'terminal.output', data: { sessionId: SID, stream: 'stdin', data: 'x' } });
  f.emit({ eventType: 'terminal.output', data: { sessionId: SID, stream: 'stdout' } });
  f.emit({ eventType: 'terminal.output', data: 'junk' });
  f.emit({ eventType: 'terminal.output', data: { sessionId: SID, stream: 'stderr', data: 'ok' } });
  off();
  f.emit({ eventType: 'terminal.output', data: { sessionId: SID, stream: 'stdout', data: 'after unsub' } });
  assert.deepEqual(got, ['ok']);
  api.dispose();
});

test('exec sends its timeout only when given and the wire wait is the command time plus a pad', async () => {
  const f = fake(type => type === 'terminal.begin' ? begun : { exitCode: 0, cwd: '/home/manan', truncated: false, timedOut: false });
  const api = new TerminalApi(f.session);
  await api.begin();
  await api.exec('dir');
  await api.exec('npm test', 120_000);
  assert.deepEqual(f.calls[1]!.payload, { sessionId: SID, command: 'dir' });
  assert.deepEqual((f.calls[1]!.options as { timeoutMs: number }).timeoutMs, 75_000);
  assert.deepEqual(f.calls[2]!.payload, { sessionId: SID, command: 'npm test', timeoutMs: 120_000 });
  assert.deepEqual((f.calls[2]!.options as { timeoutMs: number }).timeoutMs, 135_000);
  api.dispose();
});
