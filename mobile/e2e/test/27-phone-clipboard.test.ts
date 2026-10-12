/** Phone core shares clipboard text with the real desktop service using a synthetic clipboard adapter. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { startDesktop } from '../../../desktop/src/desktop-service.js';
import { MemoryClipboard, waitForClipboard } from '../../../desktop/test/clipboard-helpers.js';
import { ClipboardApi } from '../../core/src/clipboard.js';
import { pairWithQr } from '../../core/src/pairing.js';
import { OrbitSession } from '../../core/src/session.js';
import { NodePinnedTransport } from './node-pinned-transport.js';

async function phone(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-phone-clip-'));
  const desktopClipboard = new MemoryClipboard();
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false,
    clipboard: { createAdapter: () => desktopClipboard, pollMs: 10 } });
  const transport = new NodePinnedTransport(new Map());
  const qr = service.pairing.open();
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  const session = new OrbitSession(paired, transport, { uuid: randomUUID });
  t.after(async () => { session.stop(); await service.stop(); rmSync(root, { recursive: true, force: true }); });
  await session.start();
  return { api: new ClipboardApi(session), desktopClipboard };
}

test('text sent from the phone lands on the desktop clipboard', async t => {
  const f = await phone(t);
  assert.equal(await f.api.send('from the phone'), 'sent');
  await waitForClipboard(() => f.desktopClipboard.writes.includes('from the phone'));
});
test('text copied on the desktop appears on the phone as an incoming item', async t => {
  const f = await phone(t);
  await f.api.start();
  f.desktopClipboard.value = { kind: 'text', text: 'copied on pc' };
  await waitForClipboard(() => f.api.getState().incoming?.text === 'copied on pc');
});
test('an unsupported desktop clipboard is flagged, not shown as text', async t => {
  const f = await phone(t);
  await f.api.start();
  f.desktopClipboard.value = { kind: 'unsupported' };
  await waitForClipboard(() => f.api.getState().blocked === 'unsupported');
  assert.equal(f.api.getState().incoming, undefined);
});
