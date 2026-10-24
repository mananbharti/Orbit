/** Verifies paste-based confirmed insertion: clipboard preservation rules, focus verification before and after the single paste keystroke, honest focus-lost/paste-failed reporting, restore on every exit; fakes only, no OS calls. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmedPaste, type FocusHandle } from '../src/dictation/local-insert.js';

const handle: FocusHandle = { id: '100', pid: 42 };
const probeTo = (h?: FocusHandle) => ({ current: async () => h });

function fakeClipboard(initial: { kind: string; text?: string }) {
  const state = { current: initial, writes: [] as string[] };
  return { writes: state.writes, read: async () => ({ ...state.current }), write: async (t: string) => { state.writes.push(t); state.current = { kind: 'text', text: t }; } };
}

test('inserted: transcript pasted, focus verified before and after, prior clipboard restored', async () => {
  const clip = fakeClipboard({ kind: 'text', text: 'prior' });
  let probed = 0; let pasted = false;
  const outcome = await confirmedPaste(handle, 'dictated words', { current: async () => { probed++; return handle; } },
    { activate: async () => true }, clip, async () => { pasted = true; }, 1);
  assert.equal(outcome, 'inserted');
  assert.equal(pasted, true);
  assert.deepEqual(clip.writes, ['dictated words', 'prior']);
  assert.equal(probed, 2);
});

test('sensitive, non-text or oversized clipboard is never clobbered', async () => {
  for (const kind of ['sensitive', 'unsupported', 'oversized']) {
    const clip = fakeClipboard({ kind });
    let pasted = false;
    const outcome = await confirmedPaste(handle, 'x', probeTo(handle), { activate: async () => true }, clip, async () => { pasted = true; }, 1);
    assert.equal(outcome, 'clipboard-unavailable');
    assert.equal(pasted, false);
    assert.deepEqual(clip.writes, []);
  }
});

test('activation failure and focus mismatch restore the clipboard and never paste', async () => {
  const clip = fakeClipboard({ kind: 'text', text: 'prior' });
  let pasted = false;
  const outcome = await confirmedPaste(handle, 'x', probeTo(handle), { activate: async () => false }, clip, async () => { pasted = true; }, 1);
  assert.equal(outcome, 'activation-failed');
  assert.equal(pasted, false);
  assert.deepEqual(clip.writes, ['x', 'prior']);

  const clip2 = fakeClipboard({ kind: 'text', text: 'prior' });
  const outcome2 = await confirmedPaste(handle, 'x', probeTo({ id: '999', pid: 7 }), { activate: async () => true }, clip2, async () => { pasted = true; }, 1);
  assert.equal(outcome2, 'focus-mismatch');
  assert.deepEqual(clip2.writes, ['x', 'prior']);
});

test('a focus flip after the paste keystroke is reported as focus-lost, never retried', async () => {
  const clip = fakeClipboard({ kind: 'text', text: 'prior' });
  let pastes = 0; let focused: FocusHandle | undefined = handle;
  const outcome = await confirmedPaste(handle, 'x', { current: async () => focused }, { activate: async () => true }, clip,
    async () => { pastes++; focused = { id: '999', pid: 7 }; }, 1);
  assert.equal(outcome, 'focus-lost');
  assert.equal(pastes, 1);
  assert.deepEqual(clip.writes, ['x', 'prior']);
});

test('a failing paste keystroke reports paste-failed and still restores the clipboard', async () => {
  const clip = fakeClipboard({ kind: 'text', text: 'prior' });
  const outcome = await confirmedPaste(handle, 'x', probeTo(handle), { activate: async () => true }, clip,
    async () => { throw new Error('xdotool died'); }, 1);
  assert.equal(outcome, 'paste-failed');
  assert.deepEqual(clip.writes, ['x', 'prior']);
});

test('an unreadable clipboard reports clipboard-unavailable and never pastes', async () => {
  let pasted = false;
  const outcome = await confirmedPaste(handle, 'x', probeTo(handle), { activate: async () => true },
    { read: async () => { throw new Error('no xclip'); }, write: async () => {} }, async () => { pasted = true; }, 1);
  assert.equal(outcome, 'clipboard-unavailable');
  assert.equal(pasted, false);
});
