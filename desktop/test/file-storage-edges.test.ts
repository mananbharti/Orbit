/** Verifies the createPartial exclusivity edge the main suite leaves open: an existing partial is never silently replaced; depends on temp directories only. */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPartial } from '../src/file-transfer/file-storage.js';

test('createPartial never replaces an existing partial', () => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-partial-edges-'));
  const path = join(root, 'data.part');
  writeFileSync(path, 'precious');
  assert.throws(() => createPartial(path), /EEXIST/, 'exclusive create refuses the existing file');
  const fresh = join(root, 'fresh.part');
  createPartial(fresh);
  assert.throws(() => createPartial(fresh), /EEXIST/, 'even one it made itself');
});
