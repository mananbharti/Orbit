import test from 'node:test';
import assert from 'node:assert/strict';
import { isSharedFileUrl, sharedFileName } from '../src/share-intake.js';

test('isSharedFileUrl accepts file urls and rejects deep links', () => {
  assert.equal(isSharedFileUrl('file:///var/mobile/Containers/Data/Application/abc/Documents/Inbox/report.pdf'), true);
  assert.equal(isSharedFileUrl('orbit://pair?host=1.2.3.4'), false);
  assert.equal(isSharedFileUrl('https://example.com/x.pdf'), false);
  assert.equal(isSharedFileUrl('content://media/external/images/123'), false);
});

test('sharedFileName decodes the last path segment', () => {
  assert.equal(sharedFileName('file:///tmp/Inbox/report.pdf'), 'report.pdf');
  assert.equal(sharedFileName('file:///tmp/Inbox/My%20Photo%20(1).jpg'), 'My Photo (1).jpg');
  assert.equal(sharedFileName('file:///tmp/Inbox/report.pdf?x=1#y'), 'report.pdf');
});

test('sharedFileName strips unsafe characters', () => {
  assert.equal(sharedFileName('file:///tmp/a:b*c.txt'), 'abc.txt');
  assert.equal(sharedFileName('file:///tmp/..%2F..%2Fevil'), '....evil'); // slashes decoded then stripped, no traversal
});

test('sharedFileName falls back for empty segments', () => {
  const name = sharedFileName('file:///', 0);
  assert.match(name, /^Shared file 1970-01-01-00-00-00$/);
});

// The desktop's rule for a file name (desktop/src/protocol/file-transfer.ts), mirrored here.
const desktopAccepts = (name: string): boolean => name.length >= 1 && name.length <= 200 && new TextEncoder().encode(name).length <= 200
  && !/[\\/:*?"<>|\x00-\x1f\x7f\uD800-\uDFFF]/u.test(name) && !/[. ]$/.test(name)
  && !/^(\.|\.\.|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);

test('sharedFileName always yields a name the desktop accepts', () => {
  const urls = ['file:///tmp/report.', 'file:///tmp/notes%20', 'file:///tmp/CON.txt', 'file:///tmp/nul', 'file:///tmp/com1.log',
    'file:///tmp/a%0Ab.txt', 'file:///tmp/a%00b', 'file:///tmp/....', 'file:///tmp/%E0%A4%A', `file:///tmp/${'x'.repeat(300)}.pdf`,
    `file:///tmp/${encodeURIComponent('é'.repeat(150))}.txt`, `file:///tmp/${encodeURIComponent('日本語'.repeat(40))}.mp4`];
  for (const url of urls) {
    const name = sharedFileName(url, 0);
    assert.ok(desktopAccepts(name), `${url.slice(0, 40)} -> ${name.slice(0, 50)}`);
  }
  assert.equal(sharedFileName('file:///tmp/CON.txt'), '_CON.txt');
  assert.equal(sharedFileName('file:///tmp/report.'), 'report');
  assert.ok(sharedFileName(`file:///tmp/${'x'.repeat(300)}.pdf`).endsWith('.pdf'));
});
