/** Desktop push-to-talk: the toggle state machine and the fail-closed insertion rule (window identity, never title); depends on fakes only; performs no OS calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideInsertion, windowsFocusProbe, x11FocusProbe, focusProbeFor } from '../src/dictation/local-insert.js';
import { LocalDictation } from '../src/dictation/local-dictation.js';

const clip = () => new Int16Array(16000).fill(100);

test('insertion rule: same window id+pid types, any mismatch or unknown focus previews', () => {
  assert.deepEqual(decideInsertion({ id: '10', pid: 4 }, { id: '10', pid: 4 }), { action: 'type' });
  assert.deepEqual(decideInsertion({ id: '10', pid: 4 }, { id: '11', pid: 4 }), { action: 'preview', reason: 'focus-changed' });
  assert.deepEqual(decideInsertion({ id: '10', pid: 4 }, { id: '10', pid: 9 }), { action: 'preview', reason: 'focus-changed' });
  assert.deepEqual(decideInsertion(undefined, { id: '10', pid: 4 }), { action: 'preview', reason: 'focus-unknown' });
  assert.deepEqual(decideInsertion({ id: '10', pid: 4 }, undefined), { action: 'preview', reason: 'focus-unknown' });
});

test('windows probe parses handle+pid and rejects a null window', async () => {
  const probe = windowsFocusProbe(async () => ' 49680 4232\r\n');
  assert.deepEqual(await probe.current(), { id: '49680', pid: 4232 });
  const none = windowsFocusProbe(async () => '0 0');
  assert.equal(await none.current(), undefined);
  const boom = windowsFocusProbe(async () => { throw new Error('no powershell'); });
  assert.equal(await boom.current(), undefined);
});

test('x11 probe reads window id + pid; wayland gets no probe and fails closed', async () => {
  const probe = x11FocusProbe(async (_c, args) => (args[0] === 'getactivewindow' ? ' 12345\n' : ' 777\n'));
  assert.deepEqual(await probe.current(), { id: '12345', pid: 777 });
  assert.equal(focusProbeFor('linux', 'wayland'), undefined);
  assert.equal(focusProbeFor('darwin', undefined), undefined);
  assert.ok(focusProbeFor('win32'));
});

test('toggle: start captures focus, stop transcribes and types only into the same window', async () => {
  const typed: string[] = []; const states: string[] = [];
  const d = new LocalDictation({ probe: { current: async () => ({ id: '5', pid: 1 }) }, transcribe: async () => 'hello orbit',
    typeText: async t => { typed.push(t); }, onPreview: () => { throw new Error('must not preview'); }, onState: s => states.push(s) });
  assert.equal(await d.toggle(async () => clip()), 'started');
  assert.equal(d.current, 'recording');
  assert.equal(await d.toggle(async () => clip()), 'stopped');
  assert.deepEqual(typed, ['hello orbit']);
  assert.deepEqual(states, ['recording', 'working', 'idle']);
});

test('focus change mid-dictation fails closed to preview with the text preserved', async () => {
  const previews: { text: string; reason: string }[] = [];
  let focus = { id: '5', pid: 1 };
  const d = new LocalDictation({ probe: { current: async () => focus }, transcribe: async () => 'secret draft',
    typeText: async () => { throw new Error('must never type into the wrong window'); }, onPreview: (t, r) => previews.push({ text: t, reason: r }) });
  await d.toggle(async () => clip());
  focus = { id: '6', pid: 1 }; // user alt-tabbed while speaking
  await d.toggle(async () => clip());
  assert.deepEqual(previews, [{ text: 'secret draft', reason: 'focus-changed' }]);
});

test('no probe (wayland) means every dictation lands in preview, never typed blind', async () => {
  const previews: string[] = [];
  const d = new LocalDictation({ probe: undefined, transcribe: async () => 'text',
    typeText: async () => { throw new Error('must not type'); }, onPreview: t => previews.push(t) });
  await d.toggle(async () => clip());
  await d.toggle(async () => clip());
  assert.deepEqual(previews, ['text']);
});

test('silence and engine failure stop cleanly without typing; working state ignores re-entry', async () => {
  let typed = 0;
  const d = new LocalDictation({ probe: { current: async () => ({ id: '1', pid: 1 }) }, transcribe: async () => undefined,
    typeText: async () => { typed++; }, onPreview: () => undefined });
  await d.toggle(async () => clip());
  assert.equal(await d.toggle(async () => clip()), 'stopped');
  assert.equal(typed, 0);
  assert.equal(d.current, 'idle');
});
