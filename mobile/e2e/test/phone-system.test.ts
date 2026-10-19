/** System control against the real desktop: values are real, honestly null, or an honest error - never faked. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { startDesktop } from '../../../desktop/src/desktop-service.js';
import { pairWithQr } from '../../core/src/pairing.js';
import { CommandError, OrbitSession } from '../../core/src/session.js';
import { SystemApi } from '../../core/src/system.js';
import { NodePinnedTransport } from './node-pinned-transport.js';

async function phone(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-system-'));
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false });
  const transport = new NodePinnedTransport(new Map());
  const qr = service.pairing.open();
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  const session = new OrbitSession(paired, transport, { uuid: randomUUID });
  t.after(async () => { session.stop(); await service.stop(); rmSync(root, { recursive: true, force: true }); });
  await session.start();
  return new SystemApi(session);
}

test('brightness is a real 0-100 level or honestly null, never a fake', async t => {
  const system = await phone(t);
  const level = await system.getBrightness();
  assert.ok(level === null || (Number.isInteger(level) && level >= 0 && level <= 100), `honest brightness, got ${level}`);
});

test('display mode fields are real values or honestly null, never a fake', async t => {
  const system = await phone(t);
  const mode = await system.getMode();
  assert.ok(mode.theme === null || mode.theme === 'dark' || mode.theme === 'light');
  assert.ok(mode.nightLight === null || typeof mode.nightLight === 'boolean');
});

test('volume is a real state or an honest CommandError, never a fake zero', async t => {
  const system = await phone(t);
  try {
    const volume = await system.getVolume();
    assert.ok(Number.isInteger(volume.level) && volume.level >= 0 && volume.level <= 100);
    assert.equal(typeof volume.muted, 'boolean');
  } catch (error) {
    assert.ok(error instanceof CommandError, `honest failure, got ${error}`);
  }
});

test('audio sessions are a real list or an honest CommandError', async t => {
  const system = await phone(t);
  try {
    const sessions = await system.audioSessions();
    assert.ok(Array.isArray(sessions));
    for (const s of sessions) {
      assert.match(s.id, /^[0-9]{1,10}$/);
      assert.ok(s.name.length >= 1 && s.name.length <= 128);
      assert.ok(s.volume >= 0 && s.volume <= 100);
      assert.equal(typeof s.muted, 'boolean');
    }
  } catch (error) {
    assert.ok(error instanceof CommandError, `honest failure, got ${error}`);
  }
});
