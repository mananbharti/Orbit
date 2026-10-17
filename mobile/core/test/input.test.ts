import assert from 'node:assert/strict';
import test from 'node:test';
import { InvalidDesktopReply } from '../src/agent.js';
import { InputApi } from '../src/input.js';
import { OrbitSession } from '../src/session.js';
import { FakeTransport, paired, parseSent } from './fakes.js';

import type { KeyboardMacro } from '../src/protocol.js';
const MACRO: KeyboardMacro = { id: '99999999-9999-4999-8999-999999999999', name: 'Paste plain', steps: [{ key: 'v', modifiers: ['ctrl', 'shift'] }, { key: 'enter' }] };
let n = 0;
const uuid = () => `88888888-8888-4888-8888-${String(++n).padStart(12, '0')}`;
async function setup(handler: (type: string, payload: any) => unknown) {
  const t = new FakeTransport();
  const s = new OrbitSession(paired, t, { uuid, retryBaseMs: 5, random: () => 0 });
  await s.start();
  const calls: { type: string; payload: any }[] = [];
  t.last.onSend = text => { const m = parseSent(text); calls.push({ type: m.type, payload: m.payload }); t.last.reply(m.requestId, handler(m.type, m.payload)); };
  return { t, s, calls, api: new InputApi(s) };
}
const begin = () => ({ controlSessionId: '77777777-7777-4777-8777-777777777777', nextSequence: 1, heartbeatTimeoutMs: 5000 });
const sent = (seq: number) => ({ nextSequence: seq });

test('macros list, save and delete through the desktop', async () => {
  const { s, api, calls } = await setup(() => ({ macros: [MACRO] }));
  assert.deepEqual(await api.macros(), [MACRO]);
  await api.saveMacro('Paste plain', MACRO.steps.map(step => ({ ...step })));
  await api.saveMacro('Renamed', MACRO.steps.map(step => ({ ...step })), MACRO.id);
  assert.equal(calls[2]!.payload.id, MACRO.id);
  await api.deleteMacro(MACRO.id);
  assert.deepEqual(calls.map(c => c.type), ['input.macros', 'input.macro.save', 'input.macro.save', 'input.macro.delete']);
  s.stop();
});
test('a malformed macros reply is rejected', async () => {
  const { s, api } = await setup(() => ({ macros: [{ id: 'nope' }] }));
  await assert.rejects(api.macros(), InvalidDesktopReply);
  s.stop();
});
test('runMacro queues each chord inside the control session, in order', async () => {
  const { s, api, calls } = await setup((type, p) => type === 'input.begin' ? begin() : type === 'input.send' ? sent(p.sequence + 1) : {});
  await api.begin();
  await api.runMacro(MACRO);
  const sends = calls.filter(c => c.type === 'input.send');
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0]!.payload.events, [{ t: 'key', key: 'v', modifiers: ['ctrl', 'shift'] }, { t: 'key', key: 'enter' }]);
  await api.end();
  s.stop();
});
