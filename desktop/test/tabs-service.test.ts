/** Verifies the tabs.* command family: payload validation, offline/error mapping, request passthrough; depends on a loopback ExtensionServer with a stubbed request method. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { CommandRegistry } from '../src/command-router/command-registry.js';
import type { ExtensionResponse } from '../src/browser-tabs/extension-server.js';
import type { JsonValue } from '../src/protocol/messages.js';
import { ExtensionServer } from '../src/browser-tabs/extension-server.js';
import { TabsService } from '../src/browser-tabs/tabs-service.js';

type RequestStub = (type: string, payload: Record<string, unknown>) => Promise<ExtensionResponse>;

function fixture(t: TestContext, behavior: RequestStub) {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-tabs-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const registry = new CommandRegistry();
  const server = new ExtensionServer(directory);
  const calls: { type: string; payload: Record<string, unknown> }[] = [];
  server.request = async (type: string, payload: Record<string, unknown> = {}) => { calls.push({ type, payload }); return behavior(type, payload); };
  const tabs = new TabsService(registry, server);
  t.after(async () => tabs.stop());
  return { registry, server, calls };
}

function handler(registry: CommandRegistry, type: string) {
  const found = registry.get(type);
  assert.ok(found, `${type} is registered`);
  return found;
}

const context = { session: { deviceId: 'phone-1', sessionId: 'sess-1', expiresAt: Date.now() + 60_000 }, requestId: 'req-1' };
const sampleTab = { id: 7, title: 'Orbit', url: 'https://heyorbit.xyz', active: true, windowId: 1 };

test('tabs.status reports the extension as offline when nothing is connected', async t => {
  const { registry } = fixture(t, async () => ({ id: 'x', ok: true }));
  assert.deepEqual(await handler(registry, 'tabs.status').execute(null, context), { connected: false });
  assert.equal(handler(registry, 'tabs.status').validate({}), true, 'empty object payloads are accepted');
  assert.equal(handler(registry, 'tabs.status').validate({ extra: 1 }), false, 'unexpected fields are rejected');
});

test('tabs.list maps a dead or confused extension to TABS_EXTENSION_OFFLINE', async t => {
  const offline = fixture(t, async () => ({ id: 'x', ok: false, error: 'no client' }));
  await assert.rejects(handler(offline.registry, 'tabs.list').execute(null, context), /TABS_EXTENSION_OFFLINE/);
  const garbage = fixture(t, async () => ({ id: 'x', ok: true, result: { tabs: [{ id: 'not-a-number' }] } }));
  await assert.rejects(handler(garbage.registry, 'tabs.list').execute(null, context), /TABS_EXTENSION_OFFLINE/);
});

test('tabs.list returns the validated tab list with connected: true', async t => {
  const { registry, calls } = fixture(t, async () => ({ id: 'x', ok: true, result: { tabs: [sampleTab] } }));
  assert.deepEqual(await handler(registry, 'tabs.list').execute(null, context), { connected: true, tabs: [sampleTab] });
  assert.deepEqual(calls, [{ type: 'list', payload: {} }]);
});

test('tabs.open validates the URL and passes it through; failures map to offline', async t => {
  const { registry, calls } = fixture(t, async () => ({ id: 'x', ok: true }));
  const open = handler(registry, 'tabs.open');
  assert.equal(open.validate({ url: 'https://heyorbit.xyz' }), true);
  const badUrls: JsonValue[] = [{ url: 'ftp://x' }, { url: 'javascript:alert(1)' }, { url: 'not a url' }, { url: 'https://x', extra: 1 }, {}];
  for (const bad of badUrls)
    assert.equal(open.validate(bad), false, `rejects ${JSON.stringify(bad)}`);
  assert.deepEqual(await open.execute({ url: 'https://heyorbit.xyz' }, context), { opened: true });
  assert.deepEqual(calls[0], { type: 'open', payload: { url: 'https://heyorbit.xyz' } });
  const offline = fixture(t, async () => ({ id: 'x', ok: false, error: 'extension not connected' }));
  await assert.rejects(handler(offline.registry, 'tabs.open').execute({ url: 'https://heyorbit.xyz' }, context), /TABS_EXTENSION_OFFLINE/);
  const denied = fixture(t, async () => ({ id: 'x', ok: false, error: 'tab was not created' }));
  await assert.rejects(handler(denied.registry, 'tabs.open').execute({ url: 'https://heyorbit.xyz' }, context), /TABS_ACTION_FAILED/);
});

test('tabs.close and tabs.activate map "not found" distinctly from extension failures', async t => {
  const notFound = fixture(t, async () => ({ id: 'x', ok: false, error: 'not found' }));
  await assert.rejects(handler(notFound.registry, 'tabs.close').execute({ tabId: 7 }, context), /TABS_NOT_FOUND/);
  await assert.rejects(handler(notFound.registry, 'tabs.activate').execute({ tabId: 7 }, context), /TABS_NOT_FOUND/);
  const offline = fixture(t, async () => ({ id: 'x', ok: false, error: 'timeout' }));
  await assert.rejects(handler(offline.registry, 'tabs.close').execute({ tabId: 7 }, context), /TABS_EXTENSION_OFFLINE/);
  await assert.rejects(handler(offline.registry, 'tabs.activate').execute({ tabId: 7 }, context), /TABS_EXTENSION_OFFLINE/);
  const denied = fixture(t, async () => ({ id: 'x', ok: false, error: 'Cannot access a chrome:// URL' }));
  await assert.rejects(handler(denied.registry, 'tabs.close').execute({ tabId: 7 }, context), /TABS_ACTION_FAILED/);
  await assert.rejects(handler(denied.registry, 'tabs.activate').execute({ tabId: 7 }, context), /TABS_ACTION_FAILED/);
  const ok = fixture(t, async () => ({ id: 'x', ok: true }));
  assert.deepEqual(await handler(ok.registry, 'tabs.close').execute({ tabId: 7 }, context), { closed: true });
  assert.deepEqual(await handler(ok.registry, 'tabs.activate').execute({ tabId: 7 }, context), { activated: true });
  assert.deepEqual(ok.calls.map(c => c.type), ['close', 'activate']);
  assert.deepEqual(ok.calls.map(c => c.payload), [{ tabId: 7 }, { tabId: 7 }]);
});

test('tab id payloads must be positive integers', async t => {
  const { registry } = fixture(t, async () => ({ id: 'x', ok: true }));
  for (const type of ['tabs.close', 'tabs.activate']) {
    const h = handler(registry, type);
    assert.equal(h.validate({ tabId: 7 }), true);
    const badIds: JsonValue[] = [{ tabId: 0 }, { tabId: -3 }, { tabId: 1.5 }, { tabId: '7' }, {}];
    for (const bad of badIds)
      assert.equal(h.validate(bad), false, `${type} rejects ${JSON.stringify(bad)}`);
  }
});

test('stop() unregisters every tabs command', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-tabs-stop-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const registry = new CommandRegistry();
  const tabs = new TabsService(registry, new ExtensionServer(directory));
  for (const type of ['tabs.status', 'tabs.list', 'tabs.open', 'tabs.close', 'tabs.activate'])
    assert.throws(() => registry.register(type, { validate: () => true, execute: async () => null }), /duplicate/);
  await tabs.stop();
  for (const type of ['tabs.status', 'tabs.list', 'tabs.open', 'tabs.close', 'tabs.activate'])
    assert.equal(registry.get(type), undefined, `${type} is gone`);
});
