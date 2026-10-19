/** Phone core talks to the tabs service on the real desktop: offline extension is reported honestly, scoped phones are refused. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
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

test('with the extension connected, the phone lists, opens, activates and closes tabs through the relay', async t => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-phone-tabs-ext-'));
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false });
  const transport = new NodePinnedTransport(new Map());
  const qr = service.pairing.open();
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  const session = new OrbitSession(paired, transport, { uuid: randomUUID });
  t.after(async () => { session.stop(); await service.stop(); rmSync(root, { recursive: true, force: true }); });
  await session.start();
  const api = new TabsApi(session);

  // Stand in for the browser extension on the loopback relay, with the keys the desktop wrote.
  const keys = JSON.parse(readFileSync(join(root, 'private', 'browser-extension.json'), 'utf8')) as { port: number; token: string };
  const ext = new WebSocket(`ws://127.0.0.1:${keys.port}/?token=${keys.token}`);
  t.after(() => ext.terminate());
  const seen: { type: string; [k: string]: unknown }[] = [];
  const tabs = [
    { id: 1, title: 'Docs', url: 'https://docs.example.com/', active: true, windowId: 1 },
    { id: 2, title: 'Mail', url: 'https://mail.example.com/', active: false, windowId: 1 },
  ];
  ext.on('message', raw => {
    const req = JSON.parse(raw.toString()) as { id: string; type: string; [k: string]: unknown };
    seen.push(req);
    if (req.type === 'list') ext.send(JSON.stringify({ id: req.id, ok: true, result: { tabs } }));
    else if (req.type === 'close' && !tabs.some(tab => tab.id === req.tabId)) ext.send(JSON.stringify({ id: req.id, ok: false, error: 'not found' }));
    else ext.send(JSON.stringify({ id: req.id, ok: true, result: {} }));
  });
  await new Promise<void>(resolve => ext.on('open', resolve));

  assert.deepEqual(await api.status(), { connected: true });
  assert.deepEqual((await api.list()).tabs, tabs);
  await api.open('https://example.com/');
  assert.deepEqual(seen.find(r => r.type === 'open'), { id: seen.find(r => r.type === 'open')!.id, type: 'open', url: 'https://example.com/' });
  await api.activate(2);
  assert.equal(seen.find(r => r.type === 'activate')!.tabId, 2);
  await api.close(1);
  assert.equal(seen.find(r => r.type === 'close')!.tabId, 1);
  await assert.rejects(api.close(999), (e: CommandError) => e.code === 'TABS_NOT_FOUND');

  ext.close();
  const deadline = Date.now() + 5_000;
  while ((await api.status()).connected && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
  assert.deepEqual(await api.status(), { connected: false }, 'the phone sees the extension drop at once');
  await assert.rejects(api.list(), (e: CommandError) => e.code === 'TABS_EXTENSION_OFFLINE');
});
