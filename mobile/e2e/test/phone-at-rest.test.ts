/** What the desktop keeps on disk: secrets are never stored in the clear, and the private directory is owner-only. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startDesktop } from '../../../desktop/src/desktop-service.js';
import { pairWithQr } from '../../core/src/pairing.js';
import { OrbitSession } from '../../core/src/session.js';
import { NodePinnedTransport } from './node-pinned-transport.js';

test('the paired credential and pairing token are not stored in the clear, and files are owner-only', async t => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-atrest-'));
  const dir = join(root, 'private');
  const service = await startDesktop({ directory: dir, host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false });
  t.after(async () => { await service.stop(); rmSync(root, { recursive: true, force: true }); });
  const transport = new NodePinnedTransport(new Map());
  const qr = service.pairing.open();
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  const session = new OrbitSession(paired, transport, { uuid: randomUUID });
  t.after(() => session.stop());
  await session.start();

  const files = readdirSync(dir).filter(f => statSync(join(dir, f)).isFile());
  assert.ok(files.includes('credentials.json'));
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8');
    assert.ok(!text.includes(paired.credential), `${f} must not hold the credential in the clear`);
    assert.ok(!text.includes(qr.pairingToken), `${f} must not hold the pairing token`);
    if (process.platform !== 'win32') assert.equal(statSync(join(dir, f)).mode & 0o077, 0, `${f} is not readable by group or others`);
  }
  if (process.platform !== 'win32') assert.equal(statSync(dir).mode & 0o077, 0, 'the private directory itself is owner-only');
});
