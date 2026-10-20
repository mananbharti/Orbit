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

async function withRelay(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-phone-tabs-relay-'));
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false });
  const transport = new NodePinnedTransport(new Map());
  const qr = service.pairing.open();
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  const session = new OrbitSession(paired, transport, { uuid: randomUUID });
  t.after(async () => { session.stop(); await service.stop(); rmSync(root, { recursive: true, force: true }); });
  await session.start();
  const keys = JSON.parse(readFileSync(join(root, 'private', 'browser-extension.json'), 'utf8')) as { port: number; token: string };
  const connect = async (token = keys.token) => {
    const ext = new WebSocket(`ws://127.0.0.1:${keys.port}/?token=${token}`);
    t.after(() => ext.terminate());
    await new Promise<void>(resolve => { ext.on('open', resolve); ext.on('error', () => resolve()); ext.on('unexpected-response', () => resolve()); });
    return ext;
  };
  return { api: new TabsApi(session), connect };
}
const settle = (ms: number) => new Promise(r => setTimeout(r, ms));

test('a relay connection with the wrong token is never treated as the extension', async t => {
  const { api, connect } = await withRelay(t);
  const impostor = await connect('0'.repeat(64));
  await settle(300);
  assert.notEqual(impostor.readyState, WebSocket.OPEN, 'the relay refused it');
  assert.deepEqual(await api.status(), { connected: false });
  await assert.rejects(api.list(), (e: CommandError) => e.code === 'TABS_EXTENSION_OFFLINE');
});

test('the extension can reconnect after dropping and the phone works again without re-pairing', async t => {
  const { api, connect } = await withRelay(t);
  const answer = (ext: WebSocket) => ext.on('message', raw => {
    const req = JSON.parse(raw.toString()) as { id: string };
    ext.send(JSON.stringify({ id: req.id, ok: true, result: { tabs: [] } }));
  });
  const first = await connect(); answer(first);
  assert.deepEqual((await api.list()).tabs, []);
  first.close();
  const deadline = Date.now() + 5_000;
  while ((await api.status()).connected && Date.now() < deadline) await settle(25);
  await assert.rejects(api.list(), (e: CommandError) => e.code === 'TABS_EXTENSION_OFFLINE');
  const second = await connect(); answer(second);
  assert.deepEqual((await api.list()).tabs, []);
});

test('an extension that answers with garbage gives a safe error and the next request still works', async t => {
  const { api, connect } = await withRelay(t);
  const ext = await connect();
  let calls = 0;
  ext.on('message', raw => {
    const req = JSON.parse(raw.toString()) as { id: string };
    calls += 1;
    if (calls === 1) ext.send(JSON.stringify({ id: req.id, ok: true, result: { tabs: 'not-a-list' } }));
    else ext.send(JSON.stringify({ id: req.id, ok: true, result: { tabs: [] } }));
  });
  await assert.rejects(api.list(), CommandError);
  assert.deepEqual((await api.list()).tabs, []);
});

test('an extension that never answers is a clean timeout error, and a dropped extension fails the waiting request at once', { timeout: 30_000 }, async t => {
  const { api, connect } = await withRelay(t);
  const ext = await connect();
  let calls = 0;
  ext.on('message', raw => {
    const req = JSON.parse(raw.toString()) as { id: string };
    calls += 1;
    if (calls === 1) return; // silent: never answers
    if (calls === 2) { ext.close(); return; } // answers by vanishing
    ext.send(JSON.stringify({ id: req.id, ok: true, result: { tabs: [] } }));
  });
  const started = Date.now();
  await assert.rejects(api.list(), CommandError);
  assert.ok(Date.now() - started < 9_000, `timed out cleanly in ${Date.now() - started}ms, before the phone's own 10s limit`);
  const second = Date.now();
  await assert.rejects(api.list(), CommandError);
  assert.ok(Date.now() - second < 3_000, 'a dropped extension fails the request right away, not after the timeout');
  const again = await connect();
  again.on('message', raw => { const req = JSON.parse(raw.toString()) as { id: string }; again.send(JSON.stringify({ id: req.id, ok: true, result: { tabs: [] } })); });
  assert.deepEqual((await api.list()).tabs, []);
});
