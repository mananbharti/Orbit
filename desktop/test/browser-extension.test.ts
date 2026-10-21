/** The browser bridge must answer every command, even when a Chrome API call fails; depends on the extension source text and stubbed Chrome/WebSocket globals. */
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const source = readFileSync(new URL('../../../extension/background.js', import.meta.url), 'utf8');

interface FakeSocket { sent: string[]; readyState: number; onopen?: () => void; onmessage?: (e: { data: string }) => void; onclose?: () => void; onerror?: () => void; close(): void; send(s: string): void }

function harness(chromeBehavior: { queryFails?: string; createFails?: string }) {
  const sockets: FakeSocket[] = [];
  const lastError: { message?: string } = {};
  const chrome = {
    storage: { local: { get: (_keys: string[], cb: (v: object) => void) => cb({ port: 9123, token: 'tok' }) },
      onChanged: { addListener: () => {} } },
    action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {} },
    runtime: { get lastError() { return lastError.message ? { message: lastError.message } : undefined; } },
    tabs: {
      query: (_q: object, cb: (tabs?: object[]) => void) => { lastError.message = chromeBehavior.queryFails; cb(chromeBehavior.queryFails ? undefined : [{ id: 1, title: 'T', url: 'https://x', active: true, windowId: 7 }]); lastError.message = undefined; },
      create: (_c: object, cb: (tab?: { id: number }) => void) => { lastError.message = chromeBehavior.createFails; cb(chromeBehavior.createFails ? undefined : { id: 2 }); lastError.message = undefined; },
      remove: (_id: number, cb: () => void) => cb(),
      update: (_id: number, _u: object, cb: (tab?: { windowId: number }) => void) => cb({ windowId: 7 }),
    },
    windows: { update: (_id: number, _u: object, cb: () => void) => cb() },
  };
  class FakeWebSocket implements FakeSocket {
    static OPEN = 1;
    sent: string[] = [];
    readyState = 0;
    onopen?: () => void; onmessage?: (e: { data: string }) => void; onclose?: () => void; onerror?: () => void;
    constructor(public url: string) { sockets.push(this as FakeSocket); queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
    close(): void { this.readyState = 3; this.onclose?.(); }
    send(s: string): void { this.sent.push(s); }
  }
  const sandbox = { chrome, WebSocket: FakeWebSocket, setTimeout: () => 0, queueMicrotask, JSON };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const deliver = async (message: object): Promise<void> => {
    await new Promise(r => setImmediate(r)); // let onopen fire
    sockets[0]!.onmessage?.({ data: JSON.stringify(message) });
    await new Promise(r => setImmediate(r));
  };
  return { sockets, deliver };
}

test('a failed tabs.create still gets an error reply, never silence', async () => {
  const { sockets, deliver } = harness({ createFails: 'Cannot open a tab here' });
  await deliver({ id: 'a', type: 'open', url: 'https://example.com' });
  assert.equal(sockets[0]!.sent.length, 1, 'the desktop must get a reply');
  const reply = JSON.parse(sockets[0]!.sent[0]!);
  assert.deepEqual(reply, { id: 'a', ok: false, error: 'Cannot open a tab here' });
});

test('a failed tabs.query still gets an error reply, never silence', async () => {
  const { sockets, deliver } = harness({ queryFails: 'Tabs unavailable' });
  await deliver({ id: 'b', type: 'list' });
  assert.equal(sockets[0]!.sent.length, 1, 'the desktop must get a reply');
  const reply = JSON.parse(sockets[0]!.sent[0]!);
  assert.deepEqual(reply, { id: 'b', ok: false, error: 'Tabs unavailable' });
});

test('a healthy list answers with mapped tabs', async () => {
  const { sockets, deliver } = harness({});
  await deliver({ id: 'c', type: 'list' });
  const reply = JSON.parse(sockets[0]!.sent[0]!);
  assert.deepEqual(reply, { id: 'c', ok: true, result: { tabs: [{ id: 1, title: 'T', url: 'https://x', active: true, windowId: 7 }] } });
});
