import assert from 'node:assert/strict';
import test from 'node:test';
import { InvalidDesktopReply } from '../src/agent.js';
import { OrbitSession } from '../src/session.js';
import { TabsApi } from '../src/tabs.js';
import { FakeTransport, paired, parseSent } from './fakes.js';

let n = 0;
const uuid = () => `99999999-9999-4999-8999-${String(++n).padStart(12, '0')}`;
async function setup(handler: (type: string, payload: any) => unknown) {
  const t = new FakeTransport();
  const s = new OrbitSession(paired, t, { uuid, retryBaseMs: 5, random: () => 0 });
  await s.start();
  const calls: { type: string; payload: any }[] = [];
  t.last.onSend = text => { const m = parseSent(text); calls.push({ type: m.type, payload: m.payload }); t.last.reply(m.requestId, handler(m.type, m.payload)); };
  return { t, s, calls, api: new TabsApi(s) };
}

test('status and list validate the desktop reply and pass it through', async () => {
  const tab = { id: 3, title: 'Orbit', url: 'https://heyorbit.xyz', active: true, windowId: 1 };
  const { s, api, calls } = await setup(type => type === 'tabs.status' ? { connected: true } : { connected: true, tabs: [tab] });
  assert.deepEqual(await api.status(), { connected: true });
  assert.deepEqual(await api.list(), { connected: true, tabs: [tab] });
  assert.deepEqual(calls.map(c => c.type), ['tabs.status', 'tabs.list']);
  assert.deepEqual(calls.map(c => c.payload), [{}, {}]);
  s.stop();
});

test('open, close and activate carry the documented payloads', async () => {
  const { s, api, calls } = await setup(() => ({}));
  await api.open('https://heyorbit.xyz');
  await api.close(3);
  await api.activate(3);
  assert.deepEqual(calls, [
    { type: 'tabs.open', payload: { url: 'https://heyorbit.xyz' } },
    { type: 'tabs.close', payload: { tabId: 3 } },
    { type: 'tabs.activate', payload: { tabId: 3 } },
  ]);
  s.stop();
});

test('malformed desktop replies are rejected instead of trusted', async () => {
  const bad1 = await setup(() => ({ connected: 'yes' }));
  await assert.rejects(bad1.api.status(), InvalidDesktopReply);
  bad1.s.stop();
  const bad2 = await setup(() => ({ connected: true, tabs: [{ id: 'three' }] }));
  await assert.rejects(bad2.api.list(), InvalidDesktopReply);
  bad2.s.stop();
  const bad3 = await setup(() => null);
  await assert.rejects(bad3.api.open('https://heyorbit.xyz'), InvalidDesktopReply);
  bad3.s.stop();
});
