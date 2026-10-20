/** Phone core runs a real terminal session through the real desktop service; harmless sh commands only. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { startDesktop } from '../../../desktop/src/desktop-service.js';
import { pairWithQr } from '../../core/src/pairing.js';
import { CommandError, OrbitSession } from '../../core/src/session.js';
import { TerminalApi } from '../../core/src/terminal.js';
import { NodePinnedTransport } from './node-pinned-transport.js';

async function phone(t: TestContext, approve: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-terminal-'));
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false,
    terminal: { confirmation: { verify: async () => approve } } });
  const transport = new NodePinnedTransport(new Map());
  const qr = service.pairing.open();
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  const session = new OrbitSession(paired, transport, { uuid: randomUUID });
  const api = new TerminalApi(session);
  t.after(async () => { api.dispose(); session.stop(); await service.stop(); rmSync(root, { recursive: true, force: true }); });
  await session.start();
  return api;
}

test('without the owner approving, no session starts', async t => {
  const api = await phone(t, false);
  await assert.rejects(api.begin(), (e: unknown) => e instanceof CommandError && e.code === 'BIOMETRIC_REQUIRED');
  assert.equal(api.activeSessionId, undefined);
});

test('an approved session runs commands, streams output, and reports exit codes', async t => {
  const api = await phone(t, true);
  const { cwd } = await api.begin();
  assert.ok(cwd.length > 0);
  assert.ok(api.activeSessionId);
  const chunks: { stream: string; data: string }[] = [];
  const off = api.onOutput((stream, data) => chunks.push({ stream, data }));
  const ok = await api.exec('echo orbit-terminal');
  assert.equal(ok.exitCode, 0);
  await new Promise(r => setTimeout(r, 100)); // output events race the reply by design
  assert.ok(chunks.some(c => c.stream === 'stdout' && c.data.includes('orbit-terminal')), JSON.stringify(chunks));
  const failed = await api.exec('echo oops >&2; exit 3');
  assert.equal(failed.exitCode, 3);
  await new Promise(r => setTimeout(r, 100));
  assert.ok(chunks.some(c => c.stream === 'stderr' && c.data.includes('oops')), JSON.stringify(chunks));
  off();
  await api.end();
  assert.equal(api.activeSessionId, undefined);
});

test('one session at a time: a second begin is refused while the first is open', async t => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-terminal-'));
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false,
    terminal: { confirmation: { verify: async () => true } } });
  const apis: TerminalApi[] = []; const sessions: OrbitSession[] = [];
  t.after(async () => { for (const a of apis) a.dispose(); for (const s of sessions) s.stop(); await service.stop(); rmSync(root, { recursive: true, force: true }); });
  const addPhone = async () => {
    const transport = new NodePinnedTransport(new Map());
    const qr = service.pairing.open();
    (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
    const paired = await pairWithQr(JSON.stringify(qr), transport);
    const session = new OrbitSession(paired, transport, { uuid: randomUUID }); sessions.push(session);
    const api = new TerminalApi(session); apis.push(api);
    await session.start();
    return api;
  };
  const api = await addPhone(); const other = await addPhone();
  await api.begin();
  await assert.rejects(other.begin(), (e: unknown) => e instanceof CommandError && e.code === 'BUSY');
  await api.end();
  await other.begin(); // after the first ends, a new one is fine
  await other.end();
});

test('interrupt stops a running command like Ctrl+C and the session stays usable', async t => {
  const api = await phone(t, true);
  await api.begin();
  const started = Date.now();
  const running = api.exec('sleep 30');
  await new Promise(r => setTimeout(r, 300)); // let the sleep actually start
  await api.interrupt();
  const result = await running;
  assert.ok(Date.now() - started < 10_000, 'the 30s sleep was cut short');
  assert.notEqual(result.exitCode, 0, `interrupted exit reported honestly, got ${result.exitCode}`);
  const after = await api.exec('echo still-alive');
  assert.equal(after.exitCode, 0);
  await api.end();
});

test('runaway output is capped and flagged truncated, and the session still works afterwards', async t => {
  const api = await phone(t, true);
  await api.begin();
  let bytes = 0;
  api.onOutput((_s, data) => { bytes += data.length; });
  const flood = await api.exec('i=0; while [ $i -lt 4000 ]; do echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; i=$((i+1)); done', 30_000);
  assert.equal(flood.truncated, true);
  await new Promise(r => setTimeout(r, 200));
  assert.ok(bytes <= 64 * 1024, `streamed output stays near the 48KB budget, got ${bytes}`);
  assert.equal((await api.exec('echo still-alive')).exitCode, 0);
});

test('a command past its timeout is stopped and flagged, and the session stays usable', async t => {
  const api = await phone(t, true);
  await api.begin();
  const slow = await api.exec('sleep 30', 1_000);
  assert.equal(slow.timedOut, true);
  assert.equal((await api.exec('echo after-timeout')).exitCode, 0);
});

test('the working directory persists between commands in one session', async t => {
  const api = await phone(t, true);
  await api.begin();
  const moved = await api.exec('cd /tmp');
  assert.equal(moved.exitCode, 0);
  assert.equal(moved.cwd, '/tmp');
  const chunks: string[] = [];
  api.onOutput((_s, data) => chunks.push(data));
  await api.exec('pwd');
  await new Promise(r => setTimeout(r, 100));
  assert.ok(chunks.join('').includes('/tmp'));
});
