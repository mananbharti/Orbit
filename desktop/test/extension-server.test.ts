import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { ExtensionServer } from '../src/browser-tabs/extension-server.js';

async function withServer(run: (server: ExtensionServer) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-ext-'));
  const server = new ExtensionServer(dir);
  await server.start();
  try { await run(server); } finally { await server.stop(); rmSync(dir, { recursive: true, force: true }); }
}

test('persists port and token across instances', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-ext-'));
  try {
    const a = new ExtensionServer(dir);
    await a.start();
    const port = a.port; const token = a.token;
    assert.ok(port > 1024 && token.length >= 16);
    await a.stop();
    const b = new ExtensionServer(dir);
    assert.equal(b.port, port);
    assert.equal(b.token, token);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rejects a connection with a bad token', () => withServer(async server => {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}?token=wrong`);
  const code = await new Promise<number>(resolve => socket.on('close', resolve));
  assert.equal(code, 4001);
}));

test('request/response round trip with a connected extension', () => withServer(async server => {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}?token=${server.token}`);
  await new Promise<void>(resolve => socket.on('open', resolve));
  socket.on('message', raw => {
    const request = JSON.parse(String(raw)) as { id: string; type: string };
    socket.send(JSON.stringify({ id: request.id, ok: true, result: { tabs: [{ id: 1, title: 'Example', url: 'https://example.com' }] } }));
  });
  const response = await server.request('list');
  assert.equal(response.ok, true);
  const tabs = (response.result as { tabs: { id: number }[] }).tabs;
  assert.equal(tabs[0]?.id, 1);
  socket.close();
}));

test('request resolves ok:false when no extension is connected', () => withServer(async server => {
  const response = await server.request('list');
  assert.equal(response.ok, false);
  assert.equal(response.error, 'extension not connected');
}));

test('disconnect resolves inflight requests and reports the connection callback', () => withServer(async () => {
  const events: boolean[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'orbit-ext-'));
  const watched = new ExtensionServer(dir, connected => events.push(connected));
  await watched.start();
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${watched.port}?token=${watched.token}`);
    await new Promise<void>(resolve => socket.on('open', resolve));
    await new Promise<void>(resolve => setTimeout(resolve, 50));
    const pending = watched.request('list'); // extension never answers
    socket.close();
    const response = await pending;
    assert.equal(response.ok, false);
    await new Promise<void>(resolve => setTimeout(resolve, 50));
    assert.deepEqual(events, [true, false]);
  } finally { await watched.stop(); rmSync(dir, { recursive: true, force: true }); }
}));

test('a newer extension connection replaces the older one', () => withServer(async server => {
  const first = new WebSocket(`ws://127.0.0.1:${server.port}?token=${server.token}`);
  await new Promise<void>(resolve => first.on('open', resolve));
  const second = new WebSocket(`ws://127.0.0.1:${server.port}?token=${server.token}`);
  await new Promise<void>(resolve => second.on('open', resolve));
  const firstCode = await new Promise<number>(resolve => first.on('close', resolve));
  assert.equal(firstCode, 4000);
  second.close();
}));
