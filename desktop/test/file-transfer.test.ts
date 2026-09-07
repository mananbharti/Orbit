/** Verifies file checkpoints, leases, integrity and retention with synthetic files; depends on the real module and core fixture; never reads user files. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { core } from './helpers.js';
import { waitForClipboard as waitFor } from './clipboard-helpers.js';
import { FileTransfer } from '../src/file-transfer/file-transfer.js';
import { TransferStore } from '../src/file-transfer/transfer-store.js';
import { sha256 } from '../src/file-transfer/file-storage.js';
import * as protocol from '../src/protocol/file-transfer.js';
import type { CommandConnection } from '../src/command-router/command-context.js';
import type { JsonValue, ResponseMessage } from '../src/protocol/messages.js';

function ok(response: ResponseMessage): JsonValue { assert.ok(response.payload.ok); return response.payload.result; }
function manifest(bytes: Buffer, id = randomUUID()): protocol.Manifest {
  return { transferId: id, direction: 'to-desktop', name: 'private-test-name.bin', sizeBytes: bytes.length,
    sha256: sha256(bytes), chunkBytes: protocol.CHUNK_BYTES };
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-file-unit-'));
  const setup = core();
  const store = new TransferStore(root, join(root, 'received'), 'to-desktop');
  const files = new FileTransfer(store, setup.registry, setup.log, () => true);
  t.after(async () => { await files.stop(); rmSync(root, { recursive: true, force: true }); });
  const connect = (credential = setup.credential) => {
    const issued = setup.auth.issue(credential)!;
    const abort = new AbortController();
    const events: JsonValue[] = [];
    const connection: CommandConnection = { id: randomUUID(), closed: abort.signal,
      isAuthorized: () => !abort.signal.aborted && !!setup.auth.authenticate(issued.sessionToken), publish: (_type, payload) => events.push(payload) };
    const command = (type: string, payload: JsonValue) => setup.router.dispatch({ version: 1, type, requestId: randomUUID(), payload }, issued.sessionToken, connection);
    return { command, abort, events };
  };
  return { ...setup, root, store, files, connect };
}

test('file manifest rejects remote paths, platform-reserved names and oversized files', () => {
  for (const name of ['../secret', 'C:\\secret', 'a/b', 'CON.txt', 'nul', 'name.', 'bad\0name']) {
    assert.equal(protocol.manifestSchema.safeParse({ ...manifest(Buffer.alloc(0)), name }).success, false);
  }
  assert.equal(protocol.manifestSchema.safeParse({ ...manifest(Buffer.alloc(0)), sizeBytes: protocol.MAX_FILE_BYTES + 1 }).success, false);
  const uuid = randomUUID();
  assert.equal(protocol.id.parse(uuid.toUpperCase()), uuid);
});

test('upload verifies chunks, refuses conflicting duplicates, completes once and excludes file metadata from Activity Log', async t => {
  const { connect, store, log, deviceId } = fixture(t);
  const client = connect();
  const bytes = Buffer.from('private synthetic file content');
  const offer = manifest(bytes);
  ok(await client.command('file.offer', offer));
  const status = protocol.statusSchema.parse(ok(await client.command('file.resume', { transferId: offer.transferId })));
  const chunk = { transferId: offer.transferId, leaseId: status.leaseId!, offset: 0, dataBase64: bytes.toString('base64'), sha256: sha256(bytes) };
  ok(await client.command('file.chunk', chunk));
  ok(await client.command('file.chunk', chunk));
  const changed = Buffer.alloc(bytes.length, 1);
  assert.deepEqual((await client.command('file.chunk', { ...chunk, dataBase64: changed.toString('base64'), sha256: sha256(changed) })).payload,
    { ok: false, error: { code: 'FILE_INTEGRITY' } });
  ok(await client.command('file.finish', { transferId: offer.transferId, leaseId: status.leaseId! }));
  const row = store.get(offer.transferId, deviceId);
  await waitFor(() => row.state === 'completed');
  assert.deepEqual(readFileSync(store.paths(row).destination), bytes);
  assert.equal(existsSync(store.paths(row).partial), false);
  assert.equal(protocol.statusSchema.parse(ok(await client.command('file.finish', { transferId: offer.transferId, leaseId: status.leaseId! }))).state, 'completed');
  ok(await client.command('file.cancel', { transferId: offer.transferId }));
  assert.equal(existsSync(store.paths(row).destination), true);
  const metadata = JSON.stringify(log.snapshot());
  for (const secret of [bytes.toString(), offer.name, offer.sha256]) assert.equal(metadata.includes(secret), false);
});

test('fresh leases reject old sockets and ownership is checked before status or cancellation', async t => {
  const { connect, addDevice } = fixture(t);
  const a = connect(); const b = connect();
  const offer = manifest(Buffer.from('abc'));
  ok(await a.command('file.offer', offer));
  const old = protocol.statusSchema.parse(ok(await a.command('file.resume', { transferId: offer.transferId })));
  const fresh = protocol.statusSchema.parse(ok(await b.command('file.resume', { transferId: offer.transferId })));
  assert.notEqual(old.leaseId, fresh.leaseId);
  assert.deepEqual((await a.command('file.chunk', { transferId: offer.transferId, leaseId: old.leaseId!, offset: 0,
    dataBase64: 'YWJj', sha256: sha256(Buffer.from('abc')) })).payload, { ok: false, error: { code: 'FILE_INVALID_LEASE' } });
  const stranger = connect(addDevice().credential);
  assert.equal((await stranger.command('file.status', { transferId: offer.transferId })).payload.ok, false);
  b.abort.abort();
  assert.equal((await b.command('file.cancel', { transferId: offer.transferId })).payload.ok, false);
});

test('restart discards unacknowledged bytes and enforces quotas, inactivity expiry and receipt cleanup', () => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-file-store-'));
  let now = Date.now();
  try {
    const store = new TransferStore(root, join(root, 'received'), 'to-desktop', () => now);
    const owner = randomUUID(); const bytes = Buffer.alloc(protocol.CHUNK_BYTES * 2, 7);
    const row = store.create(manifest(bytes), owner);
    writeFileSync(store.paths(row).partial, bytes);
    row.nextOffset = protocol.CHUNK_BYTES; store.save(row);
    assert.throws(() => store.create(manifest(Buffer.alloc(0)), owner), /FILE_QUOTA/);
    const reopened = new TransferStore(root, store.inbox, 'to-desktop', () => now);
    assert.equal(reopened.get(row.manifest.transferId, owner).state, 'paused');
    assert.equal(statSync(store.paths(row).partial).size, protocol.CHUNK_BYTES);
    now += protocol.TRANSFER_TTL_MS + 1; reopened.cleanup();
    assert.equal(reopened.get(row.manifest.transferId, owner).state, 'expired');
    assert.equal(existsSync(store.paths(row).partial), false);
    now += protocol.TRANSFER_TTL_MS + 1; reopened.cleanup();
    assert.throws(() => reopened.get(row.manifest.transferId, owner), /FILE_NOT_FOUND/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('whole-file mismatch never publishes a file', async t => {
  const { connect, store, deviceId } = fixture(t); const client = connect();
  const bytes = Buffer.from('abc'); const offer = { ...manifest(bytes), sha256: '0'.repeat(64) };
  ok(await client.command('file.offer', offer));
  const status = protocol.statusSchema.parse(ok(await client.command('file.resume', { transferId: offer.transferId })));
  ok(await client.command('file.chunk', { transferId: offer.transferId, leaseId: status.leaseId!, offset: 0,
    dataBase64: bytes.toString('base64'), sha256: sha256(bytes) }));
  ok(await client.command('file.finish', { transferId: offer.transferId, leaseId: status.leaseId! }));
  const row = store.get(offer.transferId, deviceId);
  await waitFor(() => row.state === 'failed');
  assert.equal(existsSync(store.paths(row).destination), false);
});

test('four global reservations reach 4 GiB and orphan partials count until 24-hour cleanup', () => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-file-quota-'));
  let now = Date.now();
  try {
    const store = new TransferStore(root, join(root, 'received'), 'to-desktop', () => now);
    const orphan = join(store.inbox, `.${randomUUID()}.part`);
    writeFileSync(orphan, Buffer.from('x'));
    utimesSync(orphan, new Date(now), new Date(now));
    const unrelated = join(store.inbox, 'keep.txt'); writeFileSync(unrelated, 'keep');
    const completed = join(store.inbox, `${randomUUID()}-completed.bin`); writeFileSync(completed, 'keep');
    const fullManifest = () => ({ ...manifest(Buffer.alloc(0)), sizeBytes: protocol.MAX_FILE_BYTES });
    const rows = Array.from({ length: 3 }, () => store.create(fullManifest(), randomUUID()));
    assert.throws(() => store.create(fullManifest(), randomUUID()), /FILE_QUOTA/);
    now += protocol.TRANSFER_TTL_MS + 1;
    for (const row of rows) store.save(row);
    store.cleanup();
    assert.equal(existsSync(orphan), false);
    store.create(fullManifest(), randomUUID());
    assert.throws(() => store.create(manifest(Buffer.alloc(0)), randomUUID()), /FILE_QUOTA/);
    assert.equal(readFileSync(unrelated, 'utf8'), 'keep');
    assert.equal(readFileSync(completed, 'utf8'), 'keep');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('download resume rejects an incorrect receiver prefix before serving more bytes', async t => {
  const { root, files, connect, store, deviceId } = fixture(t); const client = connect();
  const source = join(root, 'prefix.bin'); writeFileSync(source, Buffer.alloc(protocol.CHUNK_BYTES * 2, 8));
  const offer = await files.offerLocal(source, deviceId);
  ok(await client.command('file.resume', { transferId: offer.transferId,
    checkpoint: { receivedBytes: protocol.CHUNK_BYTES, prefixSha256: '0'.repeat(64) } }));
  const row = store.get(offer.transferId, deviceId);
  await waitFor(() => row.state === 'failed');
  assert.equal(row.error, 'FILE_INTEGRITY');
  assert.equal(row.nextOffset, 0);
});

for (const interruption of ['disconnect', 'cancel'] as const) {
  test(`${interruption} during final hashing prevents publication`, async t => {
    const { connect, store, deviceId } = fixture(t); const client = connect();
    const bytes = Buffer.alloc(protocol.CHUNK_BYTES, 5); const offer = manifest(bytes);
    ok(await client.command('file.offer', offer));
    const status = protocol.statusSchema.parse(ok(await client.command('file.resume', { transferId: offer.transferId })));
    ok(await client.command('file.chunk', { transferId: offer.transferId, leaseId: status.leaseId!, offset: 0,
      dataBase64: bytes.toString('base64'), sha256: sha256(bytes) }));
    ok(await client.command('file.finish', { transferId: offer.transferId, leaseId: status.leaseId! }));
    if (interruption === 'cancel') ok(await client.command('file.cancel', { transferId: offer.transferId }));
    else client.abort.abort();
    const row = store.get(offer.transferId, deviceId);
    await waitFor(() => row.state === (interruption === 'cancel' ? 'cancelled' : 'paused'));
    assert.equal(existsSync(store.paths(row).destination), false);
    assert.equal(existsSync(store.paths(row).partial), interruption === 'disconnect');
  });
}

test('existing destination files are never overwritten, even after successful integrity verification', async t => {
  const { connect, store, deviceId } = fixture(t); const client = connect();
  const bytes = Buffer.from('verified data'); const offer = manifest(bytes);
  ok(await client.command('file.offer', offer));
  const row = store.get(offer.transferId, deviceId);
  writeFileSync(store.paths(row).destination, 'existing unrelated file');
  const status = protocol.statusSchema.parse(ok(await client.command('file.resume', { transferId: offer.transferId })));
  ok(await client.command('file.chunk', { transferId: offer.transferId, leaseId: status.leaseId!, offset: 0,
    dataBase64: bytes.toString('base64'), sha256: sha256(bytes) }));
  ok(await client.command('file.finish', { transferId: offer.transferId, leaseId: status.leaseId! }));
  await waitFor(() => row.state === 'failed');
  assert.equal(readFileSync(store.paths(row).destination, 'utf8'), 'existing unrelated file');
});

test('changed local sources fail before download; cancellation deletes only the receiving partial', async t => {
  const { root, files, connect, store, deviceId } = fixture(t); const client = connect();
  const source = join(root, 'source.bin'); writeFileSync(source, 'initial');
  const offer = await files.offerLocal(source, deviceId);
  writeFileSync(source, 'changed');
  ok(await client.command('file.accept', { transferId: offer.transferId }));
  await waitFor(() => store.get(offer.transferId, deviceId).state === 'failed');
  assert.equal(readFileSync(source, 'utf8'), 'changed');
  const incoming = manifest(Buffer.from('cancel me'));
  ok(await client.command('file.offer', incoming));
  const row = store.get(incoming.transferId, deviceId);
  assert.equal(existsSync(store.paths(row).partial), true);
  ok(await client.command('file.cancel', { transferId: incoming.transferId }));
  assert.equal(row.state, 'cancelled');
  assert.equal(existsSync(store.paths(row).partial), false);
  assert.equal(readFileSync(source, 'utf8'), 'changed');
});

test('revocation during final hashing prevents publication', async t => {
  const { connect, store, deviceId, revoke } = fixture(t); const client = connect();
  const bytes = Buffer.alloc(protocol.CHUNK_BYTES, 6); const offer = manifest(bytes);
  ok(await client.command('file.offer', offer));
  const status = protocol.statusSchema.parse(ok(await client.command('file.resume', { transferId: offer.transferId })));
  ok(await client.command('file.chunk', { transferId: offer.transferId, leaseId: status.leaseId!, offset: 0,
    dataBase64: bytes.toString('base64'), sha256: sha256(bytes) }));
  ok(await client.command('file.finish', { transferId: offer.transferId, leaseId: status.leaseId! }));
  revoke();
  const row = store.get(offer.transferId, deviceId);
  await waitFor(() => row.state === 'paused');
  assert.equal(existsSync(store.paths(row).destination), false);
});
