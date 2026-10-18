/** Verifies atomic private-file replacement: durability, permissions, symlink/directory refusal, no temp litter; depends on temp directories only. */
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { atomicWrite } from '../src/security-pairing/atomic-file.js';

function fixture(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-atomic-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('writes a new file with the exact content and owner-only permissions', t => {
  const directory = fixture(t);
  const target = join(directory, 'credentials.json');
  atomicWrite(target, '{"device":"one"}');
  assert.equal(readFileSync(target, 'utf8'), '{"device":"one"}');
  if (process.platform !== 'win32') assert.equal(lstatSync(target).mode & 0o777, 0o600);
});

test('replaces an existing file atomically and keeps the restrictive permissions', t => {
  const directory = fixture(t);
  const target = join(directory, 'history.json');
  atomicWrite(target, 'first');
  atomicWrite(target, 'second');
  assert.equal(readFileSync(target, 'utf8'), 'second');
  if (process.platform !== 'win32') assert.equal(lstatSync(target).mode & 0o777, 0o600);
});

test('refuses to replace a directory or a symlink', t => {
  const directory = fixture(t);
  const folder = join(directory, 'occupied');
  mkdirSync(folder);
  assert.throws(() => atomicWrite(folder, 'nope'), /Unsafe local file/);
  const real = join(directory, 'real.json');
  writeFileSync(real, 'original');
  const link = join(directory, 'link.json');
  symlinkSync(real, link);
  assert.throws(() => atomicWrite(link, 'nope'), /Unsafe local file/);
  assert.equal(readFileSync(real, 'utf8'), 'original', 'the symlink target is never written through');
});

test('leaves no temporary files behind on success or failure', t => {
  const directory = fixture(t);
  atomicWrite(join(directory, 'ok.json'), 'fine');
  assert.throws(() => atomicWrite(directory, 'nope'));
  assert.deepEqual(readdirSync(directory).filter(name => name.includes('.tmp')), []);
});

test('writing twice in a row cannot resurrect a stale temporary file', t => {
  const directory = fixture(t);
  const target = join(directory, 'state.json');
  writeFileSync(target, 'old', { mode: 0o600 });
  atomicWrite(target, 'new');
  atomicWrite(target, 'newer');
  assert.equal(readFileSync(target, 'utf8'), 'newer');
  assert.deepEqual(readdirSync(directory), ['state.json']);
});
