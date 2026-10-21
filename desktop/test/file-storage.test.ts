/** Direct adversarial tests for the file-storage security primitives; the wire schemas add their own validation, these pin the primitives themselves. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CHUNK_BYTES, MAX_FILE_BYTES } from '../src/protocol/file-transfer.js';
import { createPartial, decodeChunk, hashFile, publishFile, readChunk, receivingPaths, recoverPartial, regularFile,
  removePartial, safeDirectory, selectedFile, sha256, writeChunk } from '../src/file-transfer/file-storage.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'orbit-fs-'));
const FILE_IO = (e: unknown) => (e as Error).message === 'FILE_IO';
const FILE_INTEGRITY = (e: unknown) => (e as Error).message === 'FILE_INTEGRITY';

test('safeDirectory creates a missing private directory and refuses files and links', () => {
  const root = tmp();
  const made = safeDirectory(join(root, 'new-dir'));
  assert.ok(statSync(made).isDirectory());
  if (process.platform !== 'win32') assert.equal(statSync(made).mode & 0o777, 0o700); // Windows reports 0o666; permissions are ACLs there
  const file = join(root, 'plain'); writeFileSync(file, 'x');
  assert.throws(() => safeDirectory(file), FILE_IO);
  const real = join(root, 'real'); mkdirSync(real);
  const link = join(root, 'link');
  symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => safeDirectory(link), FILE_IO, 'a linked directory must be refused');
});

test('selectedFile refuses symlinks and files over the byte cap', () => {
  const root = tmp();
  const real = join(root, 'real.bin'); writeFileSync(real, 'payload');
  assert.equal(selectedFile(real), real);
  const link = join(root, 'link.bin');
  symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'file');
  assert.throws(() => selectedFile(link), FILE_IO);
  const huge = join(root, 'huge.bin'); writeFileSync(huge, '');
  truncateSync(huge, MAX_FILE_BYTES + 1);
  assert.throws(() => selectedFile(huge), FILE_IO, 'over-cap file must be refused');
  const atCap = join(root, 'cap.bin'); writeFileSync(atCap, '');
  truncateSync(atCap, MAX_FILE_BYTES);
  assert.equal(selectedFile(atCap), atCap, 'exactly at the cap is allowed');
});

test('hashFile rejects a byte-count mismatch and can hash a prefix', async () => {
  const root = tmp();
  const path = join(root, 'data.bin');
  writeFileSync(path, Buffer.from('0123456789'));
  // A byte count below the file size hashes that prefix on purpose (the resume-prefix check); only an over-declared size fails.
  assert.equal(await hashFile(path, 5), createHash('sha256').update(Buffer.from('01234')).digest('hex'));
  await assert.rejects(hashFile(path, 20), FILE_INTEGRITY, 'file shorter than declared');
  assert.equal(await hashFile(path), createHash('sha256').update(Buffer.from('0123456789')).digest('hex'));
  assert.equal(await hashFile(path, 4), createHash('sha256').update(Buffer.from('0123')).digest('hex'), 'prefix hashing for resume checks');
  const empty = join(root, 'empty.bin'); writeFileSync(empty, '');
  assert.equal(await hashFile(empty, 0), createHash('sha256').digest('hex'));
  assert.equal(await hashFile(empty), createHash('sha256').digest('hex'));
});

test('readChunk reads exactly and refuses to read past the end of the file', () => {
  const root = tmp();
  const path = join(root, 'data.bin');
  writeFileSync(path, Buffer.from('0123456789'));
  assert.deepEqual(readChunk(path, 4, 3), Buffer.from('456'));
  assert.throws(() => readChunk(path, 9, 2), FILE_IO, 'reading past the end must fail');
  assert.throws(() => readChunk(root, 0, 1), FILE_IO, 'directories are not files');
});

test('writeChunk writes at the offset and a gap stays zero-filled', () => {
  const root = tmp();
  const path = join(root, 'part.bin');
  createPartial(path);
  writeChunk(path, 0, Buffer.from('ab'));
  writeChunk(path, 4, Buffer.from('ef'));
  assert.deepEqual(readFileSync(path), Buffer.from([0x61, 0x62, 0, 0, 0x65, 0x66]));
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600, 'partial is owner-only'); // ACLs on Windows
});

test('decodeChunk accepts valid chunks and rejects every malformed variant', () => {
  const full = Buffer.alloc(CHUNK_BYTES, 65);
  const tail = Buffer.from('short tail');
  const size = CHUNK_BYTES + tail.length;
  assert.deepEqual(decodeChunk(full.toString('base64'), sha256(full), 0, size), full);
  assert.deepEqual(decodeChunk(tail.toString('base64'), sha256(tail), CHUNK_BYTES, size), tail);
  assert.throws(() => decodeChunk(full.toString('base64'), sha256(full), 1, size), FILE_INTEGRITY, 'misaligned offset');
  assert.throws(() => decodeChunk(full.toString('base64'), sha256(tail), 0, size), FILE_INTEGRITY, 'wrong hash');
  assert.throws(() => decodeChunk(full.toString('base64') + '\n', sha256(full), 0, size), FILE_INTEGRITY, 'non-canonical base64');
  assert.throws(() => decodeChunk('', sha256(Buffer.alloc(0)), 0, size), FILE_INTEGRITY, 'empty chunk');
  assert.throws(() => decodeChunk(tail.toString('base64'), sha256(tail), 0, size), FILE_INTEGRITY, 'wrong length for the offset');
  assert.throws(() => decodeChunk(full.toString('base64'), sha256(full), size + CHUNK_BYTES, size), FILE_INTEGRITY, 'offset beyond the file');
});

test('decodeChunk rejects a negative offset, even one aligned to the chunk size', () => {
  const full = Buffer.alloc(CHUNK_BYTES, 65);
  // -CHUNK_BYTES % CHUNK_BYTES is -0, which used to slip past the alignment check.
  assert.throws(() => decodeChunk(full.toString('base64'), sha256(full), -CHUNK_BYTES, 2 * CHUNK_BYTES), FILE_INTEGRITY);
});

test('recoverPartial shrinks a longer partial and refuses a shorter one', () => {
  const root = tmp();
  const path = join(root, 'part.bin');
  writeFileSync(path, Buffer.from('0123456789'));
  recoverPartial(path, 4);
  assert.equal(statSync(path).size, 4);
  assert.deepEqual(readFileSync(path), Buffer.from('0123'));
  assert.throws(() => recoverPartial(path, 8), FILE_INTEGRITY, 'a shorter partial cannot serve a longer checkpoint');
});

test('publishFile links the partial and never overwrites an existing destination', () => {
  const root = tmp();
  const partial = join(root, 'part.bin');
  const destination = join(root, 'out.bin');
  writeFileSync(partial, 'payload');
  publishFile(partial, destination);
  assert.equal(readFileSync(destination, 'utf8'), 'payload');
  assert.throws(() => publishFile(partial, destination), (e: unknown) => (e as NodeJS.ErrnoException).code === 'EEXIST', 'link refuses to overwrite');
  assert.equal(readFileSync(destination, 'utf8'), 'payload', 'existing file untouched');
});

test('receivingPaths keeps every transfer inside the inbox', () => {
  const inbox = join(tmp(), 'inbox');
  for (const name of ['../../etc/passwd', '..\\win.ini', 'a/b/c.txt', '.hidden', 'normal.txt']) {
    const { partial, destination } = receivingPaths(inbox, 't1', name);
    for (const p of [partial, destination]) {
      const resolved = join(p);
      assert.ok(resolved.startsWith(join(inbox) + '/') || resolved.startsWith(join(inbox) + '\\') || resolved === join(inbox), `${name} escaped: ${p}`);
    }
  }
});

test('removePartial ignores a missing file and refuses a directory', () => {
  const root = tmp();
  removePartial(join(root, 'missing.part'));
  const dir = join(root, 'dir.part'); mkdirSync(dir);
  assert.throws(() => removePartial(dir), FILE_IO);
});

test('regularFile refuses a symlink', () => {
  const root = tmp();
  const real = join(root, 'real'); writeFileSync(real, 'x');
  const link = join(root, 'link');
  symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'file');
  assert.throws(() => regularFile(link), FILE_IO);
  assert.doesNotThrow(() => regularFile(real));
});
