/** Explicitly checks the real desktop clipboard with synthetic text; depends on native adapters; is excluded from the default suite and never prints clipboard contents. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClipboard } from '../src/os-integration/create-clipboard.js';
import { MAX_CLIPBOARD_BYTES } from '../src/protocol/clipboard.js';

test('native clipboard preserves Unicode, line endings, empty text and the 8 KiB boundary', { timeout: 30_000 }, async () => {
  const clipboard = createClipboard();
  try {
    for (const text of ['Orbit plain text', '雪😀\n\t\r\n', '\uFEFFOrbit Unicode marker', '',
      '😀'.repeat(MAX_CLIPBOARD_BYTES / 4), 'Orbit Clipboard Sync native check passed.']) {
      await clipboard.write(text);
      const snapshot = await clipboard.read();
      assert.ok(snapshot.kind === 'text' && snapshot.text === text, 'Native clipboard did not preserve the synthetic test value; contents omitted');
    }
  } finally { await clipboard.dispose(); }
});
