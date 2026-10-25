// The Electron shell's pure decisions (desktop/shell/logic.mjs): the file list the window shows,
// the path allowlist the page may act on, and which transfers raise a system notification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transferRows, knownPath, freshTerminalTransfers, notificationFor,
  type ShellTransferRecord, type ShellFileRow } from '../src/shell-logic.js';

function rec(over: Partial<Omit<ShellTransferRecord, 'manifest'>> & { manifest?: Partial<ShellTransferRecord['manifest']> }): ShellTransferRecord {
  const { manifest, ...rest } = over;
  return {
    manifest: { transferId: 't1', name: 'photo.jpg', sizeBytes: 100, direction: 'to-desktop', ...manifest },
    state: 'receiving', nextOffset: 0, updatedAt: 1000, owner: 'phone-1', ...rest,
  };
}
const destinations = new Map<string, string>();
const destinationOf = (r: ShellTransferRecord) => destinations.get(r.manifest.transferId);

test('shell rows: newest first, capped at the limit', () => {
  const rows = transferRows([
    rec({ updatedAt: 10, manifest: { transferId: 'old' } }),
    rec({ updatedAt: 30, manifest: { transferId: 'new' } }),
    rec({ updatedAt: 20, manifest: { transferId: 'mid' } }),
  ], destinationOf, 2);
  assert.deepEqual(rows.map((r: ShellFileRow) => r.id), ['new', 'mid']); // newest two, oldest dropped
});
test('shell rows: progress is nextOffset/sizeBytes, clamped at 1', () => {
  assert.equal(transferRows([rec({ nextOffset: 40 })], destinationOf)[0]!.progress, 0.4);
  assert.equal(transferRows([rec({ nextOffset: 250 })], destinationOf)[0]!.progress, 1); // never over 100%
  assert.equal(transferRows([rec({ state: 'completed', manifest: { sizeBytes: 0 } })], destinationOf)[0]!.progress, 1);
  assert.equal(transferRows([rec({ manifest: { sizeBytes: 0 } })], destinationOf)[0]!.progress, 0); // zero-size still in flight
});
test('shell rows: a local path appears only for transfers completed onto this computer', () => {
  destinations.set('done', '/inbox/photo.jpg');
  const done = transferRows([rec({ state: 'completed', manifest: { transferId: 'done' } })], destinationOf)[0]!;
  assert.equal(done.path, '/inbox/photo.jpg');
  assert.equal(transferRows([rec({ manifest: { transferId: 'done' } })], destinationOf)[0]!.path, undefined); // still receiving
  assert.equal(transferRows([rec({ state: 'completed', manifest: { direction: 'to-client' } })], () => '/sent/photo.jpg')[0]!.path, undefined);
});
test('shell rows: retryable only for a failed outgoing transfer with a source on record', () => {
  const retry = rec({ state: 'failed', sourcePath: '/home/user/report.pdf', manifest: { direction: 'to-client' } });
  assert.equal(transferRows([retry], destinationOf)[0]!.retryable, true);
  assert.equal(transferRows([rec({ state: 'failed', sourcePath: '/x', manifest: { direction: 'to-desktop' } })], destinationOf)[0]!.retryable, undefined); // incoming failures retry from the phone
  assert.equal(transferRows([rec({ state: 'failed', manifest: { direction: 'to-client' } })], destinationOf)[0]!.retryable, undefined); // no surviving source path
  assert.equal(transferRows([rec({ state: 'cancelled', sourcePath: '/x', manifest: { direction: 'to-client' } })], destinationOf)[0]!.retryable, undefined); // user-cancelled stays quiet
});
test('knownPath: the page may act on a completed incoming destination', () => {
  destinations.set('t1', '/inbox/photo.jpg');
  const records = [rec({ state: 'completed' })];
  assert.equal(knownPath(records, destinationOf, '/inbox/photo.jpg'), '/inbox/photo.jpg');
  assert.equal(knownPath(records, destinationOf, '/etc/passwd'), undefined); // typed text is not a transfer
  assert.equal(knownPath(records, destinationOf, 42), undefined);
  assert.equal(knownPath(records, destinationOf, ''), undefined);
});
test('knownPath: an in-flight incoming destination is not yet actionable', () => {
  destinations.set('t1', '/inbox/photo.jpg');
  assert.equal(knownPath([rec({ state: 'receiving' })], destinationOf, '/inbox/photo.jpg'), undefined);
});
test('knownPath: an outgoing transfer matches its source path, not its destination', () => {
  const outgoing = rec({ manifest: { direction: 'to-client' }, sourcePath: '/docs/report.pdf' });
  assert.equal(knownPath([outgoing], () => '/phone-side/report.pdf', '/docs/report.pdf'), '/docs/report.pdf');
  assert.equal(knownPath([outgoing], () => '/phone-side/report.pdf', '/phone-side/report.pdf'), undefined);
});
test('freshTerminalTransfers: boot seeds without notifying, only fresh finishes notify', () => {
  const seen = new Set<string>();
  const row = (id: string, state: string): ShellFileRow =>
    ({ id, name: id, size: 1, direction: 'to-desktop', state, progress: 1, updatedAt: 1, device: 'd' });
  const first = freshTerminalTransfers([row('a', 'completed'), row('b', 'receiving')], seen, false);
  assert.deepEqual(first.fresh, []); // already-finished at boot: silent
  assert.equal(first.seeded, true);
  const second = freshTerminalTransfers([row('a', 'completed'), row('b', 'receiving'), row('c', 'failed')], seen, true);
  assert.deepEqual(second.fresh.map((r: ShellFileRow) => r.id), ['c']); // 'a' already seen, 'b' still in flight
});
test('freshTerminalTransfers: an in-flight transfer still notifies when it later finishes', () => {
  const seen = new Set<string>();
  const row = (state: string): ShellFileRow =>
    ({ id: 'a', name: 'a', size: 1, direction: 'to-desktop', state, progress: 1, updatedAt: 1, device: 'd' });
  freshTerminalTransfers([row('receiving')], seen, true);
  assert.equal(seen.has('a'), false); // in-flight rows are not remembered
  const later = freshTerminalTransfers([row('completed')], seen, true);
  assert.deepEqual(later.fresh.map((r: ShellFileRow) => r.id), ['a']);
  assert.deepEqual(freshTerminalTransfers([row('completed')], seen, true).fresh, []); // and never twice
});
test('notificationFor: only received, delivered, and failed-incoming transfers notify', () => {
  const row = (state: string, direction: 'to-desktop' | 'to-client', path?: string): ShellFileRow =>
    ({ id: 'a', name: 'photo.jpg', size: 1, direction, state, progress: 1, updatedAt: 1, device: 'd', ...(path ? { path } : {}) });
  assert.deepEqual(notificationFor(row('completed', 'to-desktop', '/inbox/photo.jpg')),
    { title: 'File received', body: 'photo.jpg is on this computer.', reveal: true });
  assert.deepEqual(notificationFor(row('completed', 'to-client')),
    { title: 'File delivered', body: 'Your phone received photo.jpg.', reveal: false });
  assert.deepEqual(notificationFor(row('failed', 'to-desktop')),
    { title: 'File transfer failed', body: 'photo.jpg could not be received.', reveal: false });
  assert.equal(notificationFor(row('failed', 'to-client')), undefined); // sender already sees it on the phone
  assert.equal(notificationFor(row('cancelled', 'to-desktop')), undefined);
  assert.equal(notificationFor(row('expired', 'to-desktop')), undefined);
  assert.equal(notificationFor(row('receiving', 'to-desktop')), undefined);
});
