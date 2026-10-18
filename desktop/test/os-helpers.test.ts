/** Verifies small pure helpers: the PowerShell 5.1 environment fix and the clipboard echo-suppression fingerprint; depends on no OS features. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClipboardSnapshot } from '../src/protocol/clipboard.js';
import { snapshotKey } from '../src/clipboard-sync/snapshot-key.js';
import { windowsPowerShellEnv } from '../src/os-integration/powershell-env.js';

test('windowsPowerShellEnv drops an inherited PSModulePath but keeps the rest', () => {
  const original = process.env.PSModulePath;
  process.env.PSModulePath = 'C:\\ps7\\modules';
  try {
    const env = windowsPowerShellEnv();
    assert.equal(env.PSModulePath, undefined, 'PSModulePath is removed so powershell.exe uses its own default');
    assert.equal(env.Path, process.env.Path, 'other variables survive');
    assert.equal(process.env.PSModulePath, 'C:\\ps7\\modules', 'process.env itself is untouched');
    const merged = windowsPowerShellEnv({ ORBIT_TEST_FLAG: '1' });
    assert.equal(merged.ORBIT_TEST_FLAG, '1', 'extra variables merge in');
  } finally {
    if (original === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = original;
  }
});

test('snapshotKey is stable, kind- and text-sensitive, and never contains the text', () => {
  const key = snapshotKey();
  const text = (value: string): ClipboardSnapshot => ({ kind: 'text', text: value } as ClipboardSnapshot);
  const first = key(text('meet at 7'));
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(key(text('meet at 7')), first, 'same value, same fingerprint');
  assert.notEqual(key(text('meet at 8')), first, 'different text, different fingerprint');
  const image = key({ kind: 'unsupported' } as ClipboardSnapshot);
  assert.notEqual(image, first, 'different kinds never collide');
  assert.equal(key({ kind: 'unsupported' } as ClipboardSnapshot), image, 'non-text kinds fingerprint stably');
  assert.ok(!first.includes('meet'), 'the fingerprint carries no readable content');
  const other = snapshotKey();
  assert.notEqual(other(text('meet at 7')), first, 'a fresh instance uses a fresh random key');
});
