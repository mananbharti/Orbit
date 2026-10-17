import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalApi } from '../src/terminal.js';
import type { OrbitSession } from '../src/session.js';

const SID = 'aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa';
function fake(handler: (type: string, payload: unknown) => unknown): { session: OrbitSession; calls: { type: string; payload: unknown }[]; emit: (e: unknown) => void } {
  const calls: { type: string; payload: unknown }[] = [];
  const listeners: ((e: unknown) => void)[] = [];
  const session = { command: async (type: string, payload: unknown) => { calls.push({ type, payload }); return handler(type, payload); },
    onStatus: () => { /* noop */ }, onEvent: (l: (e: unknown) => void) => { listeners.push(l); return () => { /* noop */ }; } } as unknown as OrbitSession;
  return { session, calls, emit: e => listeners.forEach(l => l(e)) };
}

test('terminal begins, execs with the session id, and ends', async () => {
  const { session, calls } = fake(type =>
    type === 'terminal.begin' ? { sessionId: SID, cwd: 'C:\\Users\\Manan', idleTimeoutMs: 300000 }
    : type === 'terminal.exec' ? { exitCode: 0, cwd: 'C:\\Users\\Manan', truncated: false, timedOut: false }
    : { ended: true });
  const api = new TerminalApi(session);
  const { cwd } = await api.begin();
  assert.equal(cwd, 'C:\\Users\\Manan');
  const result = await api.exec('dir');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls[1]!.payload, { sessionId: SID, command: 'dir' });
  await api.interrupt();
  await api.end();
  assert.equal(api.activeSessionId, undefined);
  assert.deepEqual(calls.map(c => c.type), ['terminal.begin', 'terminal.exec', 'terminal.interrupt', 'terminal.end']);
});

test('terminal routes output events to listeners only for the active session', async () => {
  const { session, emit } = fake(() => ({ sessionId: SID, cwd: '/home', idleTimeoutMs: 300000 }));
  const api = new TerminalApi(session);
  const got: [string, string][] = [];
  api.onOutput((stream, data) => got.push([stream, data]));
  await api.begin();
  emit({ eventType: 'terminal.output', data: { sessionId: SID, stream: 'stdout', data: 'hello' } });
  emit({ eventType: 'terminal.output', data: { sessionId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', stream: 'stdout', data: 'stray' } });
  emit({ eventType: 'clipboard.changed', data: {} });
  assert.deepEqual(got, [['stdout', 'hello']]);
});

test('terminal exec before begin throws and a bad reply is rejected', async () => {
  const bad = new TerminalApi(fake(() => ({ nonsense: true })).session);
  await assert.rejects(bad.exec('dir'), /TERMINAL_SESSION_REQUIRED/);
  await assert.rejects(bad.begin(), /unexpected reply/);
});
