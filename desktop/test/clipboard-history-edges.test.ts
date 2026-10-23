/** Clipboard history paging edges the main suite does not pin. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ClipboardHistory } from '../src/clipboard-sync/clipboard-history.js';
import { HISTORY_PAGE_BYTES } from '../src/protocol/clipboard.js';

test('an entry bigger than the whole page budget is still returned, alone, so paging never stalls', () => {
  const history = new ClipboardHistory();
  history.add('x'.repeat(HISTORY_PAGE_BYTES * 2), 'pc');
  history.add('small', 'phone');
  const page = history.page();
  assert.deepEqual(page.entries.map(e => e.text), ['small'], 'the oversized entry waits for its own page');
  const second = history.page(page.nextCursor!);
  assert.equal(second.entries.length, 1, 'the oversized entry is returned alone instead of stalling the page');
  assert.equal(second.entries[0]!.text.length, HISTORY_PAGE_BYTES * 2);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(history.page(second.entries[0]!.id), { entries: [], nextCursor: null });
});
test('the byte budget counts UTF-8 bytes, not characters', () => {
  const history = new ClipboardHistory();
  const euro = '€'.repeat(16_000); // 48,000 UTF-8 bytes, 16,000 characters
  history.add(euro, 'pc');
  history.add('second', 'pc');
  const page = history.page();
  assert.deepEqual(page.entries.map(e => e.text), ['second'], 'newest first: the small entry pages alone');
  const next = history.page(page.nextCursor!);
  assert.equal(next.entries.length, 1, 'the 48KB entry plus overhead leaves no room to share a page');
  assert.equal(next.entries[0]!.text, euro);
  assert.equal(next.nextCursor, null);
});
