/** Phone core controls a fake desktop input device through the real desktop service; no native input is ever produced. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { startDesktop } from '../../../desktop/src/desktop-service.js';
import type { InputDevice } from '../../../desktop/src/os-integration/input-device.js';
import type { InputEvent as DesktopEvent } from '../../../desktop/src/protocol/input.js';
import { InputApi } from '../../core/src/input.js';
import { pairWithQr } from '../../core/src/pairing.js';
import { CommandError, OrbitSession } from '../../core/src/session.js';
import { NodePinnedTransport } from './node-pinned-transport.js';

class FakeDevice implements InputDevice {
  applied: DesktopEvent[] = []; opened = false; released = 0; disposed = false;
  async open(): Promise<void> { this.opened = true; }
  async apply(e: DesktopEvent): Promise<void> { this.applied.push(e); }
  async releaseAll(): Promise<void> { this.released++; }
  async dispose(): Promise<void> { this.disposed = true; }
}
async function phone(t: TestContext, approve: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-phone-input-'));
  const device = new FakeDevice();
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false,
    input: { createDevice: () => device, confirmation: { verify: async () => approve } } });
  const transport = new NodePinnedTransport(new Map());
  const qr = service.pairing.open();
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  const session = new OrbitSession(paired, transport, { uuid: randomUUID });
  const api = new InputApi(session);
  t.after(async () => { api.dispose(); session.stop(); await service.stop(); rmSync(root, { recursive: true, force: true }); });
  await session.start();
  return { api, device };
}

test('without the owner confirming, no control starts and the device is never opened', async t => {
  const f = await phone(t, false);
  await assert.rejects(f.api.begin(), (e: unknown) => e instanceof CommandError && e.code === 'BIOMETRIC_REQUIRED');
  assert.equal(f.api.getState().status, 'idle');
  assert.equal(f.device.opened, false);
  assert.throws(() => f.api.push({ t: 'move', dx: 1, dy: 1 }));
});
test('a confirmed session applies events in order without losing pointer movement', async t => {
  const f = await phone(t, true);
  await f.api.begin();
  assert.equal(f.api.getState().status, 'active');
  f.api.push({ t: 'move', dx: 5, dy: 2 }); f.api.push({ t: 'move', dx: 3, dy: -1 });
  f.api.push({ t: 'button', button: 'left', action: 'click' });
  f.api.push({ t: 'text', text: 'hi' });
  f.api.push({ t: 'key', key: 'enter' });
  await f.api.flush();
  const moves = f.device.applied.filter(e => e.t === 'move');
  assert.deepEqual([moves.reduce((n, e) => n + e.dx, 0), moves.reduce((n, e) => n + e.dy, 0)], [8, 1]);
  assert.deepEqual(f.device.applied.filter(e => e.t !== 'move').map(e => e.t), ['button', 'text', 'key']);
  assert.equal(f.device.applied.findIndex(e => e.t === 'button') > f.device.applied.findLastIndex(e => e.t === 'move'), true);
  await f.api.end();
  assert.equal(f.api.getState().status, 'ended');
  await new Promise(r => setTimeout(r, 50));
  assert.ok(f.device.released >= 1 && f.device.disposed);
});
test('the desktop rejects an invalid event and ends the session instead of guessing', async t => {
  const f = await phone(t, true);
  await f.api.begin();
  f.api.push({ t: 'key', key: 'f13' as never });
  await f.api.flush();
  assert.equal(f.api.getState().status, 'ended');
  assert.deepEqual(f.device.applied, []);
});
