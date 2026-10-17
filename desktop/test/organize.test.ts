/** Verifies received-file organization: type folders, name dedupe, never overwriting; depends on temp directories only. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { organizedDestination, typeFolder } from '../src/file-transfer/organize.js';

test('extensions land in their type folder; unknown and extensionless files go to Other', () => {
  assert.equal(typeFolder('photo.HEIC'), 'Images');
  assert.equal(typeFolder('clip.mp4'), 'Videos');
  assert.equal(typeFolder('song.m4a'), 'Audio');
  assert.equal(typeFolder('Invoice-October.pdf'), 'Documents');
  assert.equal(typeFolder('backup.zip'), 'Archives');
  assert.equal(typeFolder('setup.exe'), 'Apps');
  assert.equal(typeFolder('README'), 'Other');
  assert.equal(typeFolder('data.bin'), 'Other');
});

test('the destination is created under inbox/<Type> and taken names step to " (2)"', t => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-organize-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = organizedDestination(root, 'report.pdf');
  assert.equal(first, join(root, 'Documents', 'report.pdf'));
  writeFileSync(first, 'one');
  const second = organizedDestination(root, 'report.pdf');
  assert.equal(second, join(root, 'Documents', 'report (2).pdf'));
  writeFileSync(second, 'two');
  assert.equal(organizedDestination(root, 'report.pdf'), join(root, 'Documents', 'report (3).pdf'));
  assert.equal(organizedDestination(root, 'report (2).pdf'), join(root, 'Documents', 'report (2) (2).pdf'));
});
