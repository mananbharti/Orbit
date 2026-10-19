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

test('a phone never sees its own text echoed back, while the other phone gets it', async t => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-phone-echo-'));
  const desktopClipboard = new MemoryClipboard();
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false,
    clipboard: { createAdapter: () => desktopClipboard, pollMs: 10 } });
  const sessions: OrbitSession[] = []; const apis: ClipboardApi[] = [];
  t.after(async () => { for (const a of apis) a.dispose(); for (const s of sessions) s.stop(); await service.stop(); rmSync(root, { recursive: true, force: true }); });
  const addPhone = async () => {
    const transport = new NodePinnedTransport(new Map());
    const qr = service.pairing.open();
    (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
    const paired = await pairWithQr(JSON.stringify(qr), transport);
    const session = new OrbitSession(paired, transport, { uuid: randomUUID }); sessions.push(session);
    const api = new ClipboardApi(session); apis.push(api);
    await session.start(); await api.start();
    return api;
  };
  const a = await addPhone(); const b = await addPhone();
  assert.equal(await a.send('echo me'), 'sent');
  await waitForClipboard(() => b.getState().incoming?.text === 'echo me'); // the other phone gets it
  await new Promise(r => setTimeout(r, 150));
  assert.equal(a.getState().incoming, undefined, 'writer must not see its own text as incoming');
  assert.equal(await b.send('reply'), 'sent');
  await waitForClipboard(() => a.getState().incoming?.text === 'reply');
  await new Promise(r => setTimeout(r, 150));
  assert.equal(b.getState().incoming?.text, 'echo me', 'second writer keeps the earlier incoming, not its own echo');
});

test('history pages newest-first by byte budget, marks sources, and apply puts an old clip back', async t => {
  const f = await phone(t);
  await f.api.start();
  for (let i = 0; i < 7; i++) {
    const text = `clip-${i}-` + 'x'.repeat(7900);
    f.desktopClipboard.value = { kind: 'text', text };
    await waitForClipboard(() => f.api.getState().incoming?.text === text);
    f.api.dismissIncoming();
  }
  assert.equal(await f.api.send('from-the-phone'), 'sent');
  await waitForClipboard(() => f.api.getState().incoming === undefined); // no echo of own clip
  const page1 = await f.api.history();
  assert.ok(page1.entries.length >= 1 && page1.entries.length < 8, `page 1 bounded by bytes, got ${page1.entries.length}`);
  assert.equal(page1.entries[0]!.text, 'from-the-phone');
  assert.equal(page1.entries[0]!.source, 'phone');
  assert.ok(page1.entries.slice(1).every(e => e.source === 'pc'));
  assert.ok(page1.nextCursor, 'more pages exist past 48 KB');
  const page2 = await f.api.history(page1.nextCursor!);
  assert.equal(page2.nextCursor, null);
  const all = [...page1.entries, ...page2.entries];
  assert.equal(new Set(all.map(e => e.id)).size, all.length, 'no duplicates across pages');
  assert.equal(all.length, 8);
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1]!.at >= all[i]!.at, 'newest first across page boundaries');
  const oldest = all[all.length - 1]!;
  await f.api.apply(oldest.id);
  await waitForClipboard(() => f.api.getState().incoming?.text === oldest.text);
  assert.ok(f.desktopClipboard.writes.includes(oldest.text), 'old clip written back to the PC clipboard');
});
