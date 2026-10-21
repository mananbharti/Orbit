/** The backup cursor rules that keep every photo flowing to the computer exactly once, even across failures and same-second shots. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceCursor, emptyCursor, forgetFailure, migrateBackupState, MAX_FAILED_PHOTOS,
  recordFailure, selectNewPhotos } from '../src/photo-backup.js';

const photo = (id: string, creationTime: number) => ({ id, creationTime });

test('only strictly-newer photos and unfinished same-second ones are selected', () => {
  const cursor = { time: 1000, ids: ['a'], failed: [] };
  const page = [photo('a', 1000), photo('b', 1000), photo('c', 2000), photo('d', 500)];
  assert.deepEqual(selectNewPhotos(page, cursor), [photo('b', 1000), photo('c', 2000)],
    'a is done at the boundary, d is older; b (same second) and c (newer) remain');
});

test('two photos in the same second both back up', () => {
  let cursor = emptyCursor();
  cursor = advanceCursor(cursor, photo('burst-1', 5000));
  assert.deepEqual(cursor, { time: 5000, ids: ['burst-1'], failed: [] });
  assert.deepEqual(selectNewPhotos([photo('burst-1', 5000), photo('burst-2', 5000)], cursor), [photo('burst-2', 5000)]);
  cursor = advanceCursor(cursor, photo('burst-2', 5000));
  assert.deepEqual(cursor.ids, ['burst-1', 'burst-2']);
  assert.equal(selectNewPhotos([photo('burst-1', 5000), photo('burst-2', 5000)], cursor).length, 0, 'both done: nothing re-uploads');
});

test('a failed photo does not block newer ones, and the next pass selects only what is left', () => {
  let cursor = emptyCursor();
  const page = [photo('p1', 100), photo('p2', 200), photo('p3', 300)];
  cursor = advanceCursor(cursor, page[0]!);
  cursor = recordFailure(cursor, page[1]!); // p2 unreadable this pass
  cursor = advanceCursor(cursor, page[2]!); // p3 still uploads: no wedge
  assert.deepEqual(cursor, { time: 300, ids: ['p3'], failed: ['p2'] });
  assert.equal(selectNewPhotos(page, cursor).length, 0, 'next pass re-queries nothing new');
  assert.deepEqual(cursor.failed, ['p2'], 'p2 waits for the retry path');
  cursor = advanceCursor(cursor, page[1]!); // retry succeeds: older than the cursor, so time stays
  assert.deepEqual(cursor, { time: 300, ids: ['p3'], failed: [] });
});

test('failures are newest-first, de-duplicated, capped, and forgotten when the photo is gone', () => {
  let cursor = emptyCursor();
  cursor = recordFailure(recordFailure(cursor, photo('x', 1)), photo('y', 2));
  cursor = recordFailure(cursor, photo('x', 1));
  assert.deepEqual(cursor.failed, ['x', 'y'], 'most recent failure first, no duplicate');
  for (let i = 0; i < MAX_FAILED_PHOTOS + 10; i++) cursor = recordFailure(cursor, photo(`f${i}`, i));
  assert.equal(cursor.failed.length, MAX_FAILED_PHOTOS, 'the list is bounded');
  cursor = forgetFailure(cursor, 'f0');
  assert.ok(!cursor.failed.includes('f0'));
});

test('the boundary id list is capped so state stays small', () => {
  let cursor = emptyCursor();
  for (let i = 0; i < 100; i++) cursor = advanceCursor(cursor, photo(`same-${i}`, 9000));
  assert.equal(cursor.time, 9000);
  assert.ok(cursor.ids.length <= 64, `bounded, got ${cursor.ids.length}`);
  assert.equal(cursor.ids[cursor.ids.length - 1], 'same-99', 'newest kept');
});

test('persisted state migrates number-only cursors and survives corruption', () => {
  assert.deepEqual(migrateBackupState(JSON.stringify({ enabled: true, cursors: { pc1: 4200 } })),
    { enabled: true, cursors: { pc1: { time: 4200, ids: [], failed: [] } } }, 'the v1 shape upgrades');
  const current = { enabled: false, cursors: { pc1: { time: 5, ids: ['a'], failed: ['b'] } } };
  assert.deepEqual(migrateBackupState(JSON.stringify(current)), current, 'the current shape round-trips');
  assert.deepEqual(migrateBackupState('not json'), { enabled: false, cursors: {} });
  assert.deepEqual(migrateBackupState(null), { enabled: false, cursors: {} });
  assert.deepEqual(migrateBackupState(JSON.stringify({ enabled: 'yes', cursors: [] })), { enabled: false, cursors: {} });
  assert.deepEqual(migrateBackupState(JSON.stringify({ enabled: true, cursors: { pc1: { time: -5, ids: [] } } })), { enabled: false, cursors: {} }, 'a bad cursor poisons nothing');
});
