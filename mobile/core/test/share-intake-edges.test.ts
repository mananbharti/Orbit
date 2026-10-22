import test from 'node:test';
import assert from 'node:assert/strict';
import { isSharedFileUrl, sharedFileName } from '../src/share-intake.js';

const bytes = (value: string) => new TextEncoder().encode(value).length;

test('only urls that start with file:// count as shared files', () => {
  assert.equal(isSharedFileUrl('orbit://pair?x=file://'), false);
  assert.equal(isSharedFileUrl('https://example.com/file://x'), false);
  assert.equal(isSharedFileUrl('FILE:///a'), false);
  assert.equal(isSharedFileUrl('file:///a'), true);
});

test('a folder-style url keeps its last real segment and a leading space is trimmed', () => {
  assert.equal(sharedFileName('file:///var/mobile/Inbox/report.pdf/'), 'report.pdf');
  assert.equal(sharedFileName('file:///var//mobile///report.pdf'), 'report.pdf');
  assert.equal(sharedFileName('file:///Inbox/%20%20spaced.txt'), 'spaced.txt');
});

test('the 200-byte limit is exact for ascii and multibyte names, and the extension survives truncation', () => {
  const exact = `${'a'.repeat(196)}.txt`;
  assert.equal(sharedFileName(`file:///${exact}`), exact);
  const over = `${'a'.repeat(197)}.txt`;
  const cut = sharedFileName(`file:///${over}`);
  assert.equal(bytes(cut), 200);
  assert.ok(cut.endsWith('.txt'));
  const emoji = `${'😀'.repeat(60)}.png`;
  const fitted = sharedFileName(`file:///${encodeURIComponent(emoji)}`);
  assert.ok(bytes(fitted) <= 200 && fitted.endsWith('.png'));
  assert.equal([...fitted].filter(char => char === '😀').length, 49);
  const noExt = sharedFileName(`file:///${'b'.repeat(250)}`);
  assert.equal(noExt, 'b'.repeat(200));
});
