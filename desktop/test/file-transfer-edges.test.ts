/** Verifies the chunk-offset edge and the checkpoint rollback the main suite leaves open: out-of-order writes are refused, and a failed save never advances the in-memory offset; depends on the real module and core fixture. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { core } from './helpers.js';
import { FileTransfer } from '../src/file-transfer/file-transfer.js';
import { TransferStore } from '../src/file-transfer/transfer-store.js';
import { sha256 } from '../src/file-transfer/file-storage.js';
import * as protocol from '../src/protocol/file-transfer.js';
import { ProtocolError } from '../src/protocol/errors.js';
import type { CommandConnection } from '../src/command-router/command-context.js';
import type { JsonValue, ResponseMessage } from '../src/protocol/messages.js';

function ok(response: ResponseMessage): JsonValue { assert.ok(response.payload.ok); return response.payload.result; }
function manifest(bytes: Buffer, id = randomUUID()): protocol.Manifest {
  return { transferId: id, direction: 'to-desktop', name: 'edge-name.bin', sizeBytes: bytes.length,
    sha256: sha256(bytes), chunkBytes: protocol.CHUNK_BYTES };
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-file-edges-'));
  const setup = core();
  const store = new TransferStore(root, join(root, 'received'), 'to-desktop');
  const files = new FileTransfer(store, setup.registry, setup.log, () => true);
  t.after(async () => { await files.stop(); rmSync(root, { recursive: true, force: true }); });
  const connect = (credential = setup.credential) => {
    const issued = setup.auth.issue(credential)!;
    const abort = new AbortController();
    const connection: CommandConnection = { id: randomUUID(), closed: abort.signal,
      isAuthorized: () => !abort.signal.aborted && !!setup.auth.authenticate(issued.sessionToken), publish: () => {} };
    const command = (type: string, payload: JsonValue) => setup.router.dispatch({ version: 1, type, requestId: randomUUID(), payload }, issued.sessionToken, connection);
    return { command, abort };
  };
  return { ...setup, root, store, files, connect };
}

test('an aligned but out-of-order chunk is refused instead of written at the wrong offset', async t => {
  const { connect, store, deviceId } = fixture(t); const client = connect();
  const bytes = Buffer.alloc(protocol.CHUNK_BYTES * 2, 7); const offer = manifest(bytes);
  ok(await client.command('file.offer', offer));
  const status = protocol.statusSchema.parse(ok(await client.command('file.resume', { transferId: offer.transferId })));
  const second = bytes.subarray(protocol.CHUNK_BYTES);
  const reply = await client.command('file.chunk', { transferId: offer.transferId, leaseId: status.leaseId!, offset: protocol.CHUNK_BYTES,
    dataBase64: second.toString('base64'), sha256: sha256(second) });
  assert.deepEqual(reply.payload, { ok: false, error: { code: 'FILE_OFFSET' } }, 'a gap write is refused');
  assert.equal(store.get(offer.transferId, deviceId).nextOffset, 0, 'nothing was recorded');
});

test('a failed checkpoint save rolls the in-memory offset back so a retry writes the same spot', async t => {
  const { connect, store, deviceId } = fixture(t); const client = connect();
  const bytes = Buffer.alloc(protocol.CHUNK_BYTES, 3); const offer = manifest(bytes);
  ok(await client.command('file.offer', offer));
  const status = protocol.statusSchema.parse(ok(await client.command('file.resume', { transferId: offer.transferId })));
  const save = store.save.bind(store);
  store.save = () => { throw new ProtocolError('FILE_IO'); };
  t.after(() => { store.save = save; });
  const reply = await client.command('file.chunk', { transferId: offer.transferId, leaseId: status.leaseId!, offset: 0,
    dataBase64: bytes.toString('base64'), sha256: sha256(bytes) });
  assert.deepEqual(reply.payload, { ok: false, error: { code: 'FILE_IO' } }, 'the failed save surfaces');
  assert.equal(store.get(offer.transferId, deviceId).nextOffset, 0, 'the in-memory offset was rolled back');
  store.save = save;
  const retry = await client.command('file.chunk', { transferId: offer.transferId, leaseId: status.leaseId!, offset: 0,
    dataBase64: bytes.toString('base64'), sha256: sha256(bytes) });
  assert.deepEqual((retry.payload as { ok: boolean }).ok, true, 'the retry is accepted as a duplicate of the written bytes');
});
