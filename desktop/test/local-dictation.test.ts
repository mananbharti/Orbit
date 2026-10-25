/** Desktop dictation toggle: the state machine, window identity capture, verified-target parsing, and the confirmed-insertion path (activate, re-verify, then bounded typing); depends on fakes only; performs no OS calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { typeVerified, confirmedInsert, windowsFocusProbe, x11FocusProbe, focusProbeFor, focusActivatorFor } from '../src/dictation/local-insert.js';
import { LocalDictation } from '../src/dictation/local-dictation.js';

const clip = () => new Int16Array(16000).fill(100);

test('windows probe parses handle+pid+label and rejects a null window', async () => {
  const probe = windowsFocusProbe(async () => ' 49680 4232 notepad\r\n');
  assert.deepEqual(await probe.current(), { id: '49680', pid: 4232, label: 'notepad' });
  const none = windowsFocusProbe(async () => '0 0');
  assert.equal(await none.current(), undefined);
  const boom = windowsFocusProbe(async () => { throw new Error('no powershell'); });
  assert.equal(await boom.current(), undefined);
});

test('x11 probe reads window id + pid + title; wayland and macOS get no probe and no activator', async () => {
  const probe = x11FocusProbe(async (_c, args) => (args[0] === 'getactivewindow' ? ' 12345\n' : args[0] === 'getwindowpid' ? ' 777\n' : ' Editor - notes.txt\n'));
  assert.deepEqual(await probe.current(), { id: '12345', pid: 777, label: 'Editor - notes.txt' });
  assert.equal(focusProbeFor('linux', 'wayland'), undefined);
  assert.equal(focusActivatorFor('linux', 'wayland'), undefined);
  assert.equal(focusProbeFor('darwin', undefined), undefined);
  assert.ok(focusProbeFor('win32'));
  assert.ok(focusActivatorFor('win32'));
});

test('toggle: transcript always goes to preview with the captured target; nothing is ever typed by the machine', async () => {
  const previews: { text: string; target?: unknown }[] = []; const states: string[] = [];
  const d = new LocalDictation({ probe: { current: async () => ({ id: '5', pid: 1, label: 'Editor' }) }, transcribe: async () => 'hello orbit',
    onPreview: (t, target) => previews.push({ text: t, target }), onState: s => states.push(s) });
  assert.equal(await d.toggle(async () => clip()), 'started');
  assert.equal(d.current, 'recording');
  assert.equal(await d.toggle(async () => clip()), 'stopped');
  assert.deepEqual(previews, [{ text: 'hello orbit', target: { id: '5', pid: 1, label: 'Editor' } }]);
  assert.deepEqual(states, ['recording', 'working', 'idle']);
});

test('toggle without a probe (wayland/macOS) still previews, with no target to confirm into', async () => {
  const previews: { text: string; target?: unknown }[] = [];
  const d = new LocalDictation({ probe: undefined, transcribe: async () => 'text', onPreview: (t, target) => previews.push({ text: t, target }) });
  await d.toggle(async () => clip());
  await d.toggle(async () => clip());
  assert.deepEqual(previews, [{ text: 'text', target: undefined }]);
});

test('silence and engine failure stop cleanly without previewing; working state ignores re-entry', async () => {
  let previewed = 0;
  const d = new LocalDictation({ probe: { current: async () => ({ id: '1', pid: 1 }) }, transcribe: async () => undefined, onPreview: () => { previewed++; } });
  await d.toggle(async () => clip());
  assert.equal(await d.toggle(async () => clip()), 'stopped');
  assert.equal(previewed, 0);
  assert.equal(d.current, 'idle');
});

test('an empty outcome is never silent: no-speech and engine failure each reach onEmpty, cancel does not', async () => {
  const empties: string[] = [];
  const silent = new LocalDictation({ transcribe: async () => undefined, onPreview: () => {}, onEmpty: r => empties.push(r) });
  await silent.toggle(async () => clip());
  await silent.toggle(async () => clip());
  assert.deepEqual(empties, ['no-speech']);
  const broken = new LocalDictation({ transcribe: async () => { throw new Error('engine died'); }, onPreview: () => {}, onEmpty: r => empties.push(r) });
  await broken.toggle(async () => clip());
  await broken.toggle(async () => clip());
  assert.deepEqual(empties, ['no-speech', 'error']);
  assert.equal(broken.current, 'idle');
  const cancelled = new LocalDictation({ transcribe: async () => undefined, onPreview: () => {}, onEmpty: r => empties.push(r) });
  await cancelled.toggle(async () => clip());
  const stop = cancelled.toggle(async () => clip());
  cancelled.cancel();
  await stop;
  assert.deepEqual(empties, ['no-speech', 'error'], 'a cancelled transcription must not cry wolf');
});

test('cancel while recording drops the capture; cancel while working suppresses the preview', async () => {
  let previewed = 0;
  const d = new LocalDictation({ probe: { current: async () => ({ id: '1', pid: 1 }) }, transcribe: async () => 'text', onPreview: () => { previewed++; } });
  await d.toggle(async () => clip());
  assert.equal(d.current, 'recording');
  assert.equal(d.cancel(), true);
  assert.equal(d.current, 'idle');
  await d.toggle(async () => clip());
  const stop = d.toggle(async () => clip());
  assert.equal(d.current, 'working');
  assert.equal(d.cancel(), true);
  await stop;
  assert.equal(previewed, 0);
  assert.equal(d.current, 'idle');
  assert.equal(d.cancel(), false);
});

test('typeVerified bounds a mid-type focus flip to the chunks already sent and returns the rest', async () => {
  const typed: string[] = [];
  let focus = { id: '5', pid: 1 };
  const probe = { current: async () => focus };
  const out = await typeVerified('x'.repeat(500), { id: '5', pid: 1 }, probe, async c => { typed.push(c); if (typed.length === 2) focus = { id: '6', pid: 1 }; });
  assert.equal(typed.length, 2);
  assert.deepEqual(out, { action: 'aborted', remaining: 'x'.repeat(20) });
  const no = await typeVerified('hello', { id: '1', pid: 1 }, { current: async () => ({ id: '2', pid: 1 }) }, async () => { throw new Error('must not type'); });
  assert.deepEqual(no, { action: 'preview', reason: 'focus-changed' });
});

test('confirmedInsert: activation then identity re-verification gate every keystroke; failures never type', async () => {
  const handle = { id: '9', pid: 3, label: 'Editor' };
  // happy path: activation succeeds and the same window holds focus
  const typedOk: string[] = [];
  const ok = await confirmedInsert(handle, 'hello', { current: async () => ({ id: '9', pid: 3 }) }, { activate: async () => true }, async c => { typedOk.push(c); });
  assert.equal(ok, 'typed');
  assert.deepEqual(typedOk, ['hello']);
  // activation failed: nothing typed
  const noAct = await confirmedInsert(handle, 'hello', { current: async () => ({ id: '9', pid: 3 }) }, { activate: async () => false }, async () => { throw new Error('must not type'); });
  assert.equal(noAct, 'activation-failed');
  // activation "worked" but a different window holds focus now: nothing typed
  const wrong = await confirmedInsert(handle, 'hello', { current: async () => ({ id: '10', pid: 3 }) }, { activate: async () => true }, async () => { throw new Error('must not type'); });
  assert.equal(wrong, 'focus-mismatch');
});
