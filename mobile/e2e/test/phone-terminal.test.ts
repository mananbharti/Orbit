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
