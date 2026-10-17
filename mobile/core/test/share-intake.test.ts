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
