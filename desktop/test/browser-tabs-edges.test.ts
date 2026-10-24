/** Verifies the desktop side of the browser bridge: key-file validation, token auth, single-client replacement, request correlation and offline mapping; depends on a real loopback server and stub extensions only. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { CommandRegistry } from '../src/command-router/command-registry.js';
import { ExtensionServer } from '../src/browser-tabs/extension-server.js';
import { TabsService } from '../src/browser-tabs/tabs-service.js';
import { ProtocolError } from '../src/protocol/errors.js';
import type { JsonValue } from '../src/protocol/messages.js';

function dir(t: TestContext): string { const d = mkdtempSync(join(tmpdir(), 'orbit-tabs-edges-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; }
const code = (name: string) => (error: unknown) => error instanceof ProtocolError && (error as ProtocolError).code === name;

function connect(port: number, token: string): Promise<{ socket: WebSocket; closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
    const closed = new Promise<number>(done => socket.on('close', (c: number) => done(c)));
    socket.on('open', () => resolve({ socket, closed }));
    socket.on('error', reject);
  });
}

test('persisted keys are reused only when both port and token are valid', t => {
  const bad = dir(t);
  writeFileSync(join(bad, 'browser-extension.json'), JSON.stringify({ port: 1024, token: 'a-perfectly-fine-token' }));
  const regenerated = new ExtensionServer(bad);
  assert.notEqual(regenerated.port, 1024, 'a system port is never honoured');
  assert.ok(regenerated.token.length >= 16);
  const good = dir(t);
  writeFileSync(join(good, 'browser-extension.json'), JSON.stringify({ port: 17654, token: 'x'.repeat(16) }));
  const reused = new ExtensionServer(good);
  assert.equal(reused.port, 17654, 'a valid port is kept');
  assert.equal(reused.token, 'x'.repeat(16), 'a token of exactly 16 characters is valid');
  const corrupt = dir(t);
  writeFileSync(join(corrupt, 'browser-extension.json'), '{nope');
  assert.ok(new ExtensionServer(corrupt).token.length >= 16, 'corrupt keys are regenerated');
});

test('a wrong token is refused with 4001 before any state changes', async t => {
  const server = new ExtensionServer(dir(t));
  await server.start(); t.after(() => server.stop());
  const { closed } = await connect(server.port, 'definitely-the-wrong-token').catch(() => ({ closed: Promise.resolve(-1) }));
  assert.equal(await closed, 4001);
  assert.equal(server.extensionConnected, false);
});

test('a newer extension replaces the older one, and the stale close never clears the live client', async t => {
  const server = new ExtensionServer(dir(t));
  await server.start(); t.after(() => server.stop());
  const first = await connect(server.port, server.token);
  assert.equal(server.extensionConnected, true);
  const second = await connect(server.port, server.token);
  assert.equal(await first.closed, 4000, 'the replaced socket is closed with 4000');
  assert.equal(server.extensionConnected, true, 'the replacement is the live client');
  second.socket.on('message', raw => {
    const message = JSON.parse(String(raw));
    second.socket.send(JSON.stringify({ id: message.id, ok: true, result: { tabs: [] } }));
  });
  const reply = await server.request('list');
  assert.deepEqual(reply.result, { tabs: [] }, 'the live client still answers after the stale close');
});

test('requests fail soft without an extension, ignore stranger replies and resolve on disconnect', async t => {
  const server = new ExtensionServer(dir(t));
  await server.start(); t.after(() => server.stop());
  assert.deepEqual(await server.request('list'), { id: '', ok: false, error: 'extension not connected' });
  const { socket } = await connect(server.port, server.token);
  const seen: string[] = [];
  socket.on('message', raw => seen.push(String(raw)));
  const pending = server.request('list');
  socket.send('not json at all'); // ignored
  socket.send(JSON.stringify({ id: 'ext-999999', ok: true, result: {} })); // a stranger's id: ignored
  socket.close();
  const reply = await pending;
  assert.equal(reply.ok, false);
  assert.equal(reply.error, 'disconnected', 'in-flight requests resolve instead of hanging');
});

test('tabs commands map extension failures to the right protocol errors', async t => {
  const registry = new CommandRegistry();
  const stub = { extensionConnected: true, replies: [] as { ok: boolean; result?: unknown; error?: string }[],
    request: async () => stub.replies.shift() ?? { ok: false } };
  const tabs = new TabsService(registry, stub as never);
  t.after(() => tabs.stop());
  const run = (type: string, payload: JsonValue) => registry.get(type)!.execute(payload, {} as never);
  stub.replies.push({ ok: false });
  await assert.rejects(run('tabs.list', {}), code('TABS_EXTENSION_OFFLINE'), 'offline maps to OFFLINE');
  stub.replies.push({ ok: true, result: { tabs: 'not-an-array' } });
  await assert.rejects(run('tabs.list', {}), code('TABS_EXTENSION_OFFLINE'), 'a malformed reply maps to OFFLINE');
  stub.replies.push({ ok: false, error: 'not found' });
  await assert.rejects(run('tabs.close', { tabId: 7 }), code('TABS_NOT_FOUND'), 'a missing tab is NOT_FOUND');
  stub.replies.push({ ok: false, error: 'not found' });
  await assert.rejects(run('tabs.activate', { tabId: 7 }), code('TABS_NOT_FOUND'), 'activate maps the same way');
  stub.replies.push({ ok: false, error: 'chrome exploded' });
  await assert.rejects(run('tabs.close', { tabId: 7 }), code('TABS_ACTION_FAILED'), 'an answered failure is ACTION_FAILED, not offline');
  stub.replies.push({ ok: false, error: 'timeout' });
  await assert.rejects(run('tabs.close', { tabId: 7 }), code('TABS_EXTENSION_OFFLINE'), 'a transport failure is OFFLINE');
  stub.replies.push({ ok: true });
  assert.deepEqual(await run('tabs.open', { url: 'https://example.com' }), { opened: true });
});
