/** Verifies type-folder routing edges and checkpoint-file guards the main suites leave open: uppercase extensions, the Other fallback, filename/id mismatch and oversize refusal; depends on temp directories only. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ProtocolError } from '../src/protocol/errors.js';
import { typeFolder } from '../src/file-transfer/organize.js';
import { TransferStore } from '../src/file-transfer/transfer-store.js';
import { sha256 } from '../src/file-transfer/file-storage.js';
import { CHUNK_BYTES, type Manifest } from '../src/protocol/file-transfer.js';

const root = (t: TestContext) => { const dir = mkdtempSync(join(tmpdir(), 'orbit-organize-edges-')); t.after(() => {}); return dir; };
function manifest(name: string): Manifest {
  const bytes = Buffer.from('edge');
  return { transferId: randomUUID(), direction: 'to-desktop', name, sizeBytes: bytes.length, sha256: sha256(bytes), chunkBytes: CHUNK_BYTES };
}

test('uppercase and mixed-case extensions route to their type folders', () => {
  assert.equal(typeFolder('PHOTO.JPG'), 'Images');
  assert.equal(typeFolder('Clip.Mp4'), 'Videos');
  assert.equal(typeFolder('Track.FLAC'), 'Audio');
  assert.equal(typeFolder('Report.PDF'), 'Documents');
  assert.equal(typeFolder('Archive.ZIP'), 'Archives');
  assert.equal(typeFolder('Setup.EXE'), 'Apps');
});

test('unknown and missing extensions fall into Other', () => {
  assert.equal(typeFolder('notes.xyz'), 'Other');
  assert.equal(typeFolder('no-extension'), 'Other');
  assert.equal(typeFolder('.hidden'), 'Other');
});

test('a checkpoint file whose name does not match its transfer id is refused', t => {
  const dir = root(t);
  const store = new TransferStore(dir, join(dir, 'received'), 'to-desktop');
  const record = store.create(manifest('paperwork.bin'), randomUUID());
  record.state = 'completed';
  store.save(record);
  const stored = readFileSync(join(store.directory, `${record.manifest.transferId}.json`), 'utf8');
  const rogue = mkdtempSync(join(tmpdir(), 'orbit-organize-rogue-'));
  mkdirSync(join(rogue, 'transfers'));
  writeFileSync(join(rogue, 'transfers', `${randomUUID()}.json`), stored);
  assert.throws(() => new TransferStore(rogue, join(rogue, 'received'), 'to-desktop'),
    (error: unknown) => error instanceof ProtocolError && (error as ProtocolError).code === 'FILE_IO');
});

test('an oversized checkpoint file is refused instead of parsed', t => {
  const dir = root(t);
  const store = new TransferStore(dir, join(dir, 'received'), 'to-desktop');
  writeFileSync(join(store.directory, `${randomUUID()}.json`), 'x'.repeat(20_000));
  assert.throws(() => new TransferStore(dir, join(dir, 'received'), 'to-desktop'),
    (error: unknown) => error instanceof ProtocolError && (error as ProtocolError).code === 'FILE_IO');
});
