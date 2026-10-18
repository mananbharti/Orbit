/** Phone core talks to the tabs service on the real desktop: offline extension is reported honestly, scoped phones are refused. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { startDesktop } from '../../../desktop/src/desktop-service.js';
import { TabsApi } from '../../core/src/tabs.js';
import { pairWithQr } from '../../core/src/pairing.js';
import { CommandError, OrbitSession } from '../../core/src/session.js';
import { NodePinnedTransport } from './node-pinned-transport.js';

async function phone(t: TestContext, scopes?: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-phone-tabs-'));
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false });
  const transport = new NodePinnedTransport(new Map());
  const qr = service.pairing.open(scopes as never);
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  const session = new OrbitSession(paired, transport, { uuid: randomUUID });
  t.after(async () => { session.stop(); await service.stop(); rmSync(root, { recursive: true, force: true }); });
  await session.start();
  return new TabsApi(session);
}

test('with no extension connected, status is honest and tab commands fail safe', async t => {
  const api = await phone(t);
  assert.deepEqual(await api.status(), { connected: false });
  await assert.rejects(api.list(), (e: CommandError) => e.code === 'TABS_EXTENSION_OFFLINE');
  await assert.rejects(api.open('https://heyorbit.xyz'), (e: CommandError) => e.code === 'TABS_EXTENSION_OFFLINE');
  await assert.rejects(api.close(1), (e: CommandError) => e.code === 'TABS_EXTENSION_OFFLINE');
});

test('a javascript: URL never reaches the extension channel', async t => {
  const api = await phone(t);
  await assert.rejects(api.open('javascript:alert(1)'), (e: CommandError) => e.code === 'INVALID_PAYLOAD');
});

test('a phone without full access cannot read tabs at all', async t => {
  const api = await phone(t, ['clipboard']);
  await assert.rejects(api.status(), (e: CommandError) => typeof e.code === 'string');
  await assert.rejects(api.list(), (e: CommandError) => typeof e.code === 'string');
});
