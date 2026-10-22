import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceCursor, emptyCursor, forgetFailure, migrateBackupState, MAX_BOUNDARY_IDS, MAX_FAILED_PHOTOS,
  recordFailure, selectNewPhotos } from '../src/photo-backup.js';

const photo = (id: string, creationTime: number) => ({ id, creationTime });
const state = (cursor: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ enabled: true, cursors: { desk: cursor }, ...extra });

test('uploading the same boundary photo twice never lists it twice or shrinks the retained window', () => {
  let cursor = advanceCursor(emptyCursor(), photo('a', 100));
  cursor = advanceCursor(cursor, photo('a', 100));
  assert.deepEqual(cursor.ids, ['a']);
  for (let i = 0; i < MAX_BOUNDARY_IDS + 5; i++) cursor = advanceCursor(cursor, photo(`p${i}`, 100));
  assert.equal(cursor.ids.length, MAX_BOUNDARY_IDS);
  assert.equal(cursor.ids.at(-1), `p${MAX_BOUNDARY_IDS + 4}`);
  assert.equal(cursor.ids[0], `p${5}`);
});

test('a newer photo resets the boundary and an older retry changes neither time nor boundary', () => {
  const base = { time: 100, ids: ['a', 'b'], failed: ['old'] };
  assert.deepEqual(advanceCursor(base, photo('n', 101)), { time: 101, ids: ['n'], failed: ['old'] });
  assert.deepEqual(advanceCursor(base, photo('old', 50)), { time: 100, ids: ['a', 'b'], failed: [] });
  assert.deepEqual(advanceCursor(base, photo('c', 100)), { time: 100, ids: ['a', 'b', 'c'], failed: ['old'] });
});

test('recording or forgetting a failure keeps the cursor position and only touches that id', () => {
  const base = { time: 100, ids: ['a'], failed: ['x', 'y'] };
  assert.deepEqual(recordFailure(base, photo('z', 120)), { time: 100, ids: ['a'], failed: ['z', 'x', 'y'] });
  assert.deepEqual(forgetFailure(base, 'x'), { time: 100, ids: ['a'], failed: ['y'] });
  assert.deepEqual(forgetFailure(base, 'missing'), base);
  assert.equal(recordFailure({ ...base, failed: Array.from({ length: MAX_FAILED_PHOTOS }, (_, i) => `f${i}`) }, photo('n', 1)).failed.length, MAX_FAILED_PHOTOS);
});

test('selection ignores order within the page and treats an empty page as nothing to do', () => {
  const cursor = { time: 100, ids: ['a'], failed: [] };
  assert.deepEqual(selectNewPhotos([], cursor), []);
  assert.deepEqual(selectNewPhotos([photo('b', 100), photo('a', 100), photo('old', 99), photo('new', 101)], cursor).map(p => p.id), ['b', 'new']);
});

test('persisted state accepts the exact limits and rejects anything beyond them or malformed', () => {
  const full = { time: 5, ids: Array.from({ length: MAX_BOUNDARY_IDS }, (_, i) => `i${i}`), failed: Array.from({ length: MAX_FAILED_PHOTOS }, (_, i) => `f${i}`) };
  assert.deepEqual(migrateBackupState(state(full)).cursors.desk, full);
  assert.deepEqual(migrateBackupState(state({ time: 0, ids: ['x'.repeat(256)], failed: [] })).cursors.desk?.ids, ['x'.repeat(256)]);
  const clean = { enabled: false, cursors: {} };
  const bad: unknown[] = [
    { ...full, time: -1 }, { ...full, time: 1.5 }, { ...full, ids: [...full.ids, 'extra'] }, { ...full, failed: [...full.failed, 'extra'] },
    { ...full, ids: [''] }, { ...full, failed: [''] }, { ...full, ids: ['x'.repeat(257)] }, { ...full, failed: ['x'.repeat(257)] },
    { ...full, extra: true }, -5, 2.5, 'text', null,
  ];
  for (const cursor of bad) assert.deepEqual(migrateBackupState(state(cursor)), clean, JSON.stringify(cursor).slice(0, 60));
  assert.deepEqual(migrateBackupState(state(full, { unexpected: 1 })), clean);
  assert.deepEqual(migrateBackupState(JSON.stringify({ enabled: 'yes', cursors: {} })), clean);
  assert.equal(migrateBackupState(state(7)).cursors.desk?.time, 7);
  assert.equal(migrateBackupState(state(0)).enabled, true);
});
