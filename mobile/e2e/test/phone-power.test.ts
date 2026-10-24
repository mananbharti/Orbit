/** Power commands from the phone: each valid action reaches the OS adapter exactly once, anything else never does, failures are honest. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { startDesktop } from '../../../desktop/src/desktop-service.js';
import { SystemControlUnavailable } from '../../../desktop/src/os-integration/system-control.js';
import { pairWithQr } from '../../core/src/pairing.js';
import { CommandError, OrbitSession } from '../../core/src/session.js';
import { SystemApi } from '../../core/src/system.js';
import { NodePinnedTransport } from './node-pinned-transport.js';

async function phone(t: TestContext, failing = false, uuid: () => string = randomUUID, ownerApproves = true) {
  const powered: string[] = [];
  const root = mkdtempSync(join(tmpdir(), 'orbit-power-'));
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false,
    biometric: { verify: async () => ownerApproves }, // fixture stands in for the desktop owner's confirmation dialog
    system: { createAdapter: () => ({
      power: async action => { if (failing) throw new SystemControlUnavailable(); powered.push(action); },
      getVolume: async () => ({ level: 1, muted: false }), setVolume: async () => {}, getBrightness: async () => null, setBrightness: async () => {},
      getDisplayMode: async () => ({ theme: null, nightLight: null }), setDisplayMode: async () => {},
    }) } });
  const transport = new NodePinnedTransport(new Map());
  const qr = service.pairing.open();
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  const session = new OrbitSession(paired, transport, { uuid });
  t.after(async () => { session.stop(); await service.stop(); rmSync(root, { recursive: true, force: true }); });
  await session.start();
  return { system: new SystemApi(session), session, powered };
}

test('each valid power action reaches the OS adapter exactly once', async t => {
  const { system, powered } = await phone(t);
  for (const action of ['lock', 'sleep', 'restart', 'shutdown'] as const) await system.power(action);
  assert.deepEqual(powered, ['lock', 'sleep', 'restart', 'shutdown']);
});

test('an unknown or malformed power action is refused before the adapter is touched', async t => {
  const { session, powered } = await phone(t);
  for (const action of ['format', 'hibernate', '', 'LOCK', 'lock; shutdown', null, 7, ['lock']]) {
    await assert.rejects(session.command('system.power', { action } as never), (e: unknown) => e instanceof CommandError, `action ${JSON.stringify(action)}`);
  }
  await assert.rejects(session.command('system.power', { action: 'lock', extra: true } as never), CommandError);
  await assert.rejects(session.command('system.power', {} as never), CommandError);
  assert.deepEqual(powered, [], 'nothing reached the machine');
});

test('when the machine cannot do it the phone gets an honest error, not a fake success', async t => {
  const { system, powered } = await phone(t, true);
  await assert.rejects(system.power('sleep'), (e: unknown) => e instanceof CommandError);
  assert.deepEqual(powered, []);
});

test('without the desktop owner\'s confirmation a power command never reaches the adapter', async t => {
  const { system, powered } = await phone(t, false, randomUUID, false);
  await assert.rejects(system.power('shutdown'), (e: unknown) => e instanceof CommandError && e.code === 'BIOMETRIC_REQUIRED');
  assert.deepEqual(powered, [], 'nothing reached the machine');
});

test('a replayed request id never powers the machine a second time', async t => {
  const fixed = '11111111-1111-4111-8111-111111111111';
  let used = 0;
  const { system, powered } = await phone(t, false, () => (used++ === 0 ? fixed : used > 1 && used < 5 ? fixed : randomUUID()));
  await system.power('restart');
  await assert.rejects(system.power('restart'), (e: unknown) => e instanceof CommandError && e.code === 'DUPLICATE_REQUEST');
  assert.deepEqual(powered, ['restart'], 'the adapter ran once');
});
