import assert from 'node:assert/strict';
import test from 'node:test';
import { InvalidDesktopReply } from '../src/agent.js';
import { OrbitSession } from '../src/session.js';
import { TabsApi } from '../src/tabs.js';
import { FakeTransport, paired, parseSent } from './fakes.js';

let n = 0;
const uuid = () => `99999999-9999-4999-8999-${String(++n).padStart(12, '0')}`;
async function setup(reply: unknown) {
  const t = new FakeTransport();
  const s = new OrbitSession(paired, t, { uuid, retryBaseMs: 5, random: () => 0 });
  await s.start();
  t.last.onSend = text => t.last.reply(parseSent(text).requestId, reply);
  return { s, api: new TabsApi(s) };
}
const tab = (id: number) => ({ id, title: 't', url: 'https://x', active: false, windowId: 1 });

test('500 tabs list and 501 are refused', async () => {
  const ok = await setup({ connected: true, tabs: Array.from({ length: 500 }, (_, i) => tab(i)) });
  assert.equal((await ok.api.list()).tabs.length, 500);
  ok.s.stop();
  const over = await setup({ connected: true, tabs: Array.from({ length: 501 }, (_, i) => tab(i)) });
  await assert.rejects(over.api.list(), InvalidDesktopReply);
  over.s.stop();
});
test('unknown fields in status, list and tab entries are rejected', async () => {
  for (const [call, reply] of [
    ['status', { connected: true, extra: 1 }],
    ['list', { connected: true, tabs: [], extra: 1 }],
    ['list', { connected: true, tabs: [{ ...tab(1), favicon: 'x' }] }],
    ['list', { connected: true, tabs: [{ ...tab(1), id: 1.5 }] }],
    ['list', { connected: true, tabs: [{ ...tab(1), windowId: 1.5 }] }],
    ['list', { connected: true, tabs: [{ ...tab(1), active: 'no' }] }],
    ['list', { connected: true }],
    ['status', {}],
  ] as const) {
    const { s, api } = await setup(reply);
    await assert.rejects(call === 'status' ? api.status() : api.list(), InvalidDesktopReply);
    s.stop();
  }
});
test('close and activate reject a non-object reply but accept extra fields', async () => {
  const good = await setup({ closed: true });
  await good.api.close(1); await good.api.activate(1); await good.api.open('https://x');
  good.s.stop();
  for (const bad of [null, 'ok', 5]) {
    const { s, api } = await setup(bad);
    await assert.rejects(api.close(1), InvalidDesktopReply);
    await assert.rejects(api.activate(1), InvalidDesktopReply);
    s.stop();
  }
});
