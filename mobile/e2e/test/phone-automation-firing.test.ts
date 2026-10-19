/** The real clock path: a saved automation fires at its minute on the live desktop and runs its action exactly once. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startDesktop } from '../../../desktop/src/desktop-service.js';
import { AutomationApi } from '../../core/src/automation.js';
import { LauncherApi } from '../../core/src/launcher.js';
import { pairWithQr } from '../../core/src/pairing.js';
import { OrbitSession } from '../../core/src/session.js';
import { NodePinnedTransport } from './node-pinned-transport.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('a saved automation actually fires at its minute and launches the app exactly once', { timeout: 200_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-auto-fire-'));
  const launches: string[] = [];
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false,
    launcher: { createAdapter: () => ({
      list: async () => [{ key: 'registration', name: 'Notes', revision: 'one' }],
      launch: async (app, authorize) => { authorize(); launches.push(app.key); } }) } });
  t.after(async () => { await service.stop(); rmSync(root, { recursive: true, force: true }); });
  const transport = new NodePinnedTransport(new Map());
  const qr = service.pairing.open();
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  const session = new OrbitSession(paired, transport, { uuid: randomUUID });
  t.after(() => session.stop());
  await session.start();

  const appId = (await new LauncherApi(session).list())[0]!.appId;
  const target = new Date(Date.now() + 70_000); // land safely inside the next minute, past any tick alignment
  const hhmm = `${String(target.getHours()).padStart(2, '0')}:${String(target.getMinutes()).padStart(2, '0')}`;
  const automations = new AutomationApi(session);
  const saved = await automations.save({ time: hhmm, days: [], action: { type: 'app', appId } });
  const id = saved[0]!.id;

  const deadline = Date.now() + 150_000;
  let fired: number | undefined;
  while (Date.now() < deadline) {
    await sleep(5_000);
    fired = (await automations.refresh()).find(a => a.id === id)?.lastFiredAt;
    if (fired !== undefined) break;
  }
  assert.ok(fired !== undefined, 'the automation fired on the desktop clock');
  assert.deepEqual(launches, ['registration'], 'its action ran exactly once, on the right app');
  await sleep(16_000); // one more tick window...
  assert.equal(launches.length, 1, '...does not fire it again');
});
