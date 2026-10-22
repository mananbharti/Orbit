/** Pins browser-extension channel guards: key file validation and permissions, loopback binding, message hygiene, stale-socket isolation and shutdown; depends on real loopback sockets and a temp directory. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { ExtensionServer } from '../src/browser-tabs/extension-server.js';

const tempDir = (t: test.TestContext) => { const dir = mkdtempSync(join(tmpdir(), 'orbit-ext-guards-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const connect = async (server: ExtensionServer): Promise<WebSocket> => {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}?token=${server.token}`);
  await new Promise<void>(resolve => socket.on('open', resolve));
  return socket;
};

test('a key file with an out-of-range port or a weak token is replaced, never trusted', t => {
  const dir = tempDir(t);
  const file = join(dir, 'browser-extension.json');
  const good = 'A'.repeat(24);
  for (const bad of [{ port: 80, token: good }, { port: 1024, token: good }, { port: 65536, token: good }, { port: 17400, token: 'short' }, { port: 17400, token: 123456789012345678 }, { port: '17400', token: good }]) {
    writeFileSync(file, JSON.stringify(bad));
    const server = new ExtensionServer(dir);
    assert.ok(server.port > 1024 && server.port < 65536 && typeof server.port === 'number');
    assert.ok(server.token.length >= 16 && typeof server.token === 'string');
    assert.notDeepEqual({ port: server.port, token: server.token }, bad);
  }
  writeFileSync(file, JSON.stringify({ port: 17400, token: good }));
  assert.equal(new ExtensionServer(dir).token, good, 'a valid file is kept');
});

test('the key file is private to its owner and the channel listens on loopback only', async t => {
  const dir = tempDir(t);
  const server = new ExtensionServer(dir);
  await server.start();
  t.after(() => server.stop());
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'browser-extension.json')).mode & 0o077, 0);
  const address = (server as unknown as { http: { address(): { address: string } } }).http.address();
  assert.equal(address.address, '127.0.0.1');
});

test('stray, malformed or unknown responses are ignored and the next real answer still lands', async t => {
  const dir = tempDir(t);
  const server = new ExtensionServer(dir);
  await server.start();
  t.after(() => server.stop());
  const socket = await connect(server);
  socket.on('message', raw => {
    const request = JSON.parse(String(raw)) as { id: string };
    socket.send('not json');
    socket.send(JSON.stringify({ ok: true }));
    socket.send(JSON.stringify({ id: 7, ok: true, result: 'numeric id' }));
    socket.send(JSON.stringify({ id: 'ext-999', ok: true, result: 'nobody asked' }));
    socket.send(JSON.stringify({ id: request.id, ok: true, result: 'real' }));
  });
  const response = await server.request('list');
  assert.deepEqual(response, { id: 'ext-1', ok: true, result: 'real' });
  socket.close();
});

test('the replaced socket closing does not disconnect the new extension or fail its requests', async t => {
  const dir = tempDir(t);
  const events: boolean[] = [];
  const server = new ExtensionServer(dir, connected => events.push(connected));
  await server.start();
  t.after(() => server.stop());
  const first = await connect(server);
  const firstClosed = new Promise<number>(resolve => first.on('close', resolve));
  const second = await connect(server);
  second.on('message', raw => { const request = JSON.parse(String(raw)) as { id: string }; setTimeout(() => second.send(JSON.stringify({ id: request.id, ok: true, result: 'second' })), 100); });
  const pending = server.request('list');
  assert.equal(await firstClosed, 4000);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(server.extensionConnected, true);
  assert.deepEqual(events, [true, true], 'the replaced socket closing is not reported as a disconnect');
  assert.equal((await pending).result, 'second');
  second.close();
});

test('stopping the server closes the extension and answers pending requests with shutdown', async t => {
  const dir = tempDir(t);
  const server = new ExtensionServer(dir);
  await server.start();
  const socket = await connect(server);
  const closed = new Promise<number>(resolve => socket.on('close', resolve));
  socket.on('message', () => { /* never answers */ });
  const pending = server.request('list');
  await new Promise(r => setTimeout(r, 30));
  await server.stop();
  assert.deepEqual(await pending, { id: 'ext-1', ok: false, error: 'shutdown' });
  assert.equal(await closed, 4000);
  assert.equal(server.extensionConnected, false);
});
