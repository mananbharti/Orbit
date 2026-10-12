/** Phone core lists and launches apps on the real desktop service with a synthetic activation adapter. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { startDesktop } from '../../../desktop/src/desktop-service.js';
import { LauncherApi } from '../../core/src/launcher.js';
import { pairWithQr } from '../../core/src/pairing.js';
import { CommandError, NotSent, OrbitSession } from '../../core/src/session.js';
import { NodePinnedTransport } from './node-pinned-transport.js';

async function phone(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-phone-launch-'));
  let launches = 0; let revision = 'one';
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false,
    launcher: { createAdapter: () => ({
      list: async () => [{ key: 'registration', name: 'Notes', revision }, { key: 'registration-2', name: 'Browser', revision }],
      launch: async (_app, authorize) => { authorize(); launches++; } }) } });
  const transport = new NodePinnedTransport(new Map());
  const qr = service.pairing.open();
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  const session = new OrbitSession(paired, transport, { uuid: randomUUID });
  t.after(async () => { session.stop(); await service.stop(); rmSync(root, { recursive: true, force: true }); });
  await session.start();
  return { api: new LauncherApi(session), launches: () => launches, change: () => { revision = 'two'; } };
}

test('phone lists the desktop apps and launches one', async t => {
  const f = await phone(t);
  const apps = await f.api.list();
  assert.deepEqual(apps.map(a => a.name).sort(), ['Browser', 'Notes']);
  await f.api.launch(apps[0]!.appId);
  assert.equal(f.launches(), 1);
});
test('a launch with an old catalog is refused and nothing opens', async t => {
  const f = await phone(t);
  const apps = await f.api.list();
  f.change();
  await assert.rejects(f.api.launch(apps[0]!.appId), (e: CommandError) => e.code === 'LAUNCHER_STALE_CATALOG');
  assert.equal(f.launches(), 0);
  await assert.rejects(f.api.launch(apps[0]!.appId), NotSent);
  const fresh = await f.api.list();
  await f.api.launch(fresh[0]!.appId);
  assert.equal(f.launches(), 1);
});
