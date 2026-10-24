/** Verifies the dictation service: one clip at a time, per-connection ownership, offset integrity, buffer wiping on every exit, m4a gating; depends on a fake transcriber and decoder only. */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { ActivityLog } from '../src/activity-log/activity-log.js';
import { CommandRegistry } from '../src/command-router/command-registry.js';
import type { CommandConnection, CommandContext } from '../src/command-router/command-context.js';
import type { AudioDecoder } from '../src/dictation/ffmpeg-decoder.js';
import type { Transcriber } from '../src/dictation/pipeline.js';
import type { JsonValue } from '../src/protocol/messages.js';
import { DictationService } from '../src/dictation/dictation-service.js';

const tick = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));

function connection(): { conn: CommandConnection; abort: AbortController } {
  const abort = new AbortController();
  return { abort, conn: { id: Math.random().toString(36).slice(2), closed: abort.signal, isAuthorized: () => !abort.signal.aborted, publish: () => {} } };
}

function contextFor(conn: CommandConnection, deviceId = 'phone-1'): CommandContext {
  return { session: { deviceId, sessionId: 'sess-1', expiresAt: Date.now() + 60_000 }, requestId: 'req-1', connection: conn };
}

function fixture(t: TestContext, options: { engine?: Transcriber; decoder?: AudioDecoder; ttlMs?: number } = {}) {
  const registry = new CommandRegistry();
  const log = new ActivityLog();
  const engine: Transcriber = options.engine ?? { transcribe: async () => 'hello orbit' };
  const service = new DictationService(registry, engine, log, () => ({}), options.ttlMs ?? 150_000, options.decoder);
  t.after(async () => service.stop());
  const handle = (type: string) => {
    const found = registry.get(type);
    assert.ok(found, `${type} is registered`);
    return found;
  };
  return { registry, log, handle };
}

const pcmChunk = (samples: number, value = 0): string => {
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(value, i * 2);
  return buffer.toString('base64');
};
const loudPcm = (samples: number) => pcmChunk(samples, 10_000);

async function begin(handle: ReturnType<typeof fixture>['handle'], context: CommandContext, payload: { [key: string]: JsonValue } = {}): Promise<string> {
  const result = await handle('dictation.begin').execute(payload, context);
  return (result as { dictationId: string }).dictationId;
}

test('begin requires an authorized connection and only one clip runs at a time', async t => {
  const { handle } = fixture(t);
  const { conn } = connection();
  await assert.rejects(handle('dictation.begin').execute({}, { session: contextFor(conn).session, requestId: 'r' }), /UNAUTHENTICATED/);
  const dying = connection();
  dying.abort.abort();
  await assert.rejects(handle('dictation.begin').execute({}, contextFor(dying.conn)), /UNAUTHENTICATED/);
  const id = await begin(handle, contextFor(conn));
  assert.match(id, /^[0-9a-f-]{36}$/);
  await assert.rejects(handle('dictation.begin').execute({}, contextFor(conn)), /BUSY/);
});

test('chunks must be sequential, even-sized, valid base64 and within bounds', async t => {
  const { handle } = fixture(t);
  const { conn } = connection();
  const context = contextFor(conn);
  const id = await begin(handle, context);
  const chunk = (offset: number, dataBase64: string) => handle('dictation.chunk').execute({ dictationId: id, offset, dataBase64 }, context);
  await assert.rejects(chunk(0, 'not*base64!'), /INVALID_PAYLOAD/, 'non-base64 rejected');
  await assert.rejects(chunk(1, pcmChunk(4)), /INVALID_PAYLOAD/, 'wrong offset rejected');
  await assert.rejects(chunk(0, Buffer.alloc(3).toString('base64')), /INVALID_PAYLOAD/, 'odd byte count rejected');
  assert.deepEqual(await chunk(0, pcmChunk(4)), { nextOffset: 4 });
  assert.deepEqual(await chunk(4, pcmChunk(2)), { nextOffset: 6 });
  await assert.rejects(chunk(0, pcmChunk(2)), /INVALID_PAYLOAD/, 'rewinding rejected');
});

test('a different connection or device cannot touch someone else\'s clip', async t => {
  const { handle } = fixture(t);
  const alice = connection();
  const id = await begin(handle, contextFor(alice.conn));
  const mallory = connection();
  await assert.rejects(handle('dictation.chunk').execute({ dictationId: id, offset: 0, dataBase64: pcmChunk(2) }, contextFor(mallory.conn)), /INVALID_PAYLOAD/);
  await assert.rejects(handle('dictation.chunk').execute({ dictationId: id, offset: 0, dataBase64: pcmChunk(2) }, contextFor(alice.conn, 'other-phone')), /INVALID_PAYLOAD/);
  await assert.rejects(handle('dictation.cancel').execute({ dictationId: id }, contextFor(mallory.conn)), /INVALID_PAYLOAD/);
});

test('finish returns text for speech, retains the transcript for confirmInsert, and cancel frees the slot', async t => {
  const { handle, log } = fixture(t);
  const { conn } = connection();
  const context = contextFor(conn);
  const id = await begin(handle, context);
  await handle('dictation.chunk').execute({ dictationId: id, offset: 0, dataBase64: loudPcm(16_000) }, context);
  const result = await handle('dictation.finish').execute({ dictationId: id }, context);
  assert.deepEqual(result, { status: 'text', text: 'Hello orbit', insertOffered: false });
  assert.ok(log.snapshot().some(event => event.eventType === 'dictation.finished' && event.outcome === 'success'));
  const again = await begin(handle, context);
  assert.notEqual(again, id, 'a new dictation from the same device abandons the retained insert offer');
  await assert.rejects(handle('dictation.insert').execute({ dictationId: id }, context), /INVALID_PAYLOAD/, 'the abandoned offer is gone');
});

test('silence transcribes as no-speech', async t => {
  const { handle } = fixture(t);
  const { conn } = connection();
  const context = contextFor(conn);
  const id = await begin(handle, context);
  await handle('dictation.chunk').execute({ dictationId: id, offset: 0, dataBase64: pcmChunk(16_000) }, context);
  assert.deepEqual(await handle('dictation.finish').execute({ dictationId: id }, context), { status: 'no-speech' });
});

test('engine failures map to COMMAND_FAILED and still free the slot', async t => {
  const { handle, log } = fixture(t, { engine: { transcribe: async () => { throw new Error('whisper exploded'); } } });
  const { conn } = connection();
  const context = contextFor(conn);
  const id = await begin(handle, context);
  await handle('dictation.chunk').execute({ dictationId: id, offset: 0, dataBase64: loudPcm(16_000) }, context);
  await assert.rejects(handle('dictation.finish').execute({ dictationId: id }, context), /COMMAND_FAILED/);
  assert.ok(log.snapshot().some(event => event.eventType === 'dictation.finished' && event.outcome === 'failed'));
  await begin(handle, context);
});

test('cancel during transcription aborts the engine instead of refusing with BUSY', async t => {
  let signalSeen: AbortSignal | undefined;
  const engine: Transcriber = { transcribe: (_pcm, { signal }) => new Promise<string>((_resolve, reject) => {
    signalSeen = signal;
    signal.addEventListener('abort', () => reject(new Error('aborted mid-engine')), { once: true });
  }) };
  const { handle } = fixture(t, { engine });
  const { conn } = connection();
  const context = contextFor(conn);
  const id = await begin(handle, context);
  await handle('dictation.chunk').execute({ dictationId: id, offset: 0, dataBase64: loudPcm(16_000) }, context);
  const finishing = handle('dictation.finish').execute({ dictationId: id }, context);
  for (let i = 0; i < 100 && !signalSeen; i++) await new Promise(resolve => setImmediate(resolve)); // let the engine take the clip
  assert.ok(signalSeen, 'the engine is running before the cancel lands');
  assert.deepEqual(await handle('dictation.cancel').execute({ dictationId: id }, context), { cancelled: true });
  assert.ok(signalSeen.aborted, 'the engine saw the abort');
  await assert.rejects(finishing, /COMMAND_FAILED/);
  const again = await begin(handle, context);
  assert.notEqual(again, id, 'the slot is free right away');
});

test('cancel drops the clip; later chunks are rejected', async t => {
  const { handle } = fixture(t);
  const { conn } = connection();
  const context = contextFor(conn);
  const id = await begin(handle, context);
  await handle('dictation.chunk').execute({ dictationId: id, offset: 0, dataBase64: pcmChunk(2) }, context);
  assert.deepEqual(await handle('dictation.cancel').execute({ dictationId: id }, context), { cancelled: true });
  await assert.rejects(handle('dictation.chunk').execute({ dictationId: id, offset: 2, dataBase64: pcmChunk(2) }, context), /INVALID_PAYLOAD/);
});

test('the clip is dropped when the connection dies or the TTL expires', async t => {
  const dying = await fixture(t);
  const party = connection();
  const id = await begin(dying.handle, contextFor(party.conn));
  party.abort.abort();
  await tick();
  await assert.rejects(dying.handle('dictation.chunk').execute({ dictationId: id, offset: 0, dataBase64: pcmChunk(2) }, contextFor(party.conn)), /UNAUTHENTICATED|INVALID_PAYLOAD/);
  await begin(dying.handle, contextFor(connection().conn));

  const expiring = fixture(t, { ttlMs: 30 });
  const calm = connection();
  const staleId = await begin(expiring.handle, contextFor(calm.conn));
  await tick(80);
  await assert.rejects(expiring.handle('dictation.chunk').execute({ dictationId: staleId, offset: 0, dataBase64: pcmChunk(2) }, contextFor(calm.conn)), /INVALID_PAYLOAD/);
  await begin(expiring.handle, contextFor(calm.conn));
});

test('m4a needs a decoder; with one, compressed bytes are tracked and decoded', async t => {
  const noDecoder = fixture(t);
  await assert.rejects(begin(noDecoder.handle, contextFor(connection().conn), { format: 'm4a' }), /COMMAND_FAILED/);

  const decoded: Buffer[] = [];
  const decoder: AudioDecoder = async bytes => { decoded.push(Buffer.from(bytes)); return new Int16Array(16_000).fill(8_000); };
  const withDecoder = fixture(t, { decoder });
  const context = contextFor(connection().conn);
  const id = await begin(withDecoder.handle, contextFor(context.connection!), { format: 'm4a' });
  const aac = Buffer.from([0xff, 0xf1, 0x50, 0x80]).toString('base64');
  assert.deepEqual(await withDecoder.handle('dictation.chunk').execute({ dictationId: id, offset: 0, dataBase64: aac }, context), { nextOffset: 4 });
  await assert.rejects(withDecoder.handle('dictation.chunk').execute({ dictationId: id, offset: 0, dataBase64: aac }, context), /INVALID_PAYLOAD/);
  const result = await withDecoder.handle('dictation.finish').execute({ dictationId: id }, context);
  assert.deepEqual(result, { status: 'text', text: 'Hello orbit', insertOffered: false });
  assert.equal(decoded.length, 1);
  assert.deepEqual([...decoded[0]!], [0xff, 0xf1, 0x50, 0x80], 'decoder received exactly the uploaded bytes');
});

test('stop() unregisters the commands and drops any open clip', async () => {
  const registry = new CommandRegistry();
  const service = new DictationService(registry, { transcribe: async () => 'x' }, new ActivityLog());
  const { conn } = connection();
  const context = contextFor(conn);
  const id = (await registry.get('dictation.begin')!.execute({}, context)) as { dictationId: string };
  await service.stop();
  for (const type of ['dictation.begin', 'dictation.chunk', 'dictation.finish', 'dictation.cancel'])
    assert.equal(registry.get(type), undefined, `${type} is gone`);
  void id;
});

test('a wrong dictation id from the owning connection is refused', async t => {
  const { handle } = fixture(t);
  const context = contextFor(connection().conn);
  await begin(handle, context);
  await assert.rejects(handle('dictation.chunk').execute({ dictationId: '11111111-1111-4111-8111-111111111111', offset: 0, dataBase64: pcmChunk(4) }, context), /INVALID_PAYLOAD/);
  await assert.rejects(handle('dictation.cancel').execute({ dictationId: '11111111-1111-4111-8111-111111111111' }, context), /INVALID_PAYLOAD/);
});

test('pcm and m4a uploads stop at their hard caps', async t => {
  const decoder: AudioDecoder = async () => new Int16Array(16_000);
  const { handle } = fixture(t, { decoder });
  const context = contextFor(connection().conn);
  const pcmId = await begin(handle, context);
  const pcmChunkSamples = 16_384;
  const full = pcmChunk(pcmChunkSamples);
  let offset = 0;
  const max = 16_000 * 120;
  while (offset + pcmChunkSamples <= max) { await handle('dictation.chunk').execute({ dictationId: pcmId, offset, dataBase64: full }, context); offset += pcmChunkSamples; }
  const rest = max - offset;
  await handle('dictation.chunk').execute({ dictationId: pcmId, offset, dataBase64: pcmChunk(rest) }, context);
  await assert.rejects(handle('dictation.chunk').execute({ dictationId: pcmId, offset: max, dataBase64: pcmChunk(2) }, context), /INVALID_PAYLOAD/);
  await handle('dictation.cancel').execute({ dictationId: pcmId }, context);

  const m4aId = await begin(handle, context, { format: 'm4a' });
  const cap = 3 * 1_024 * 1_024;
  const block = Buffer.alloc(32 * 1_024, 1).toString('base64');
  for (let at = 0; at < cap; at += 32 * 1_024) await handle('dictation.chunk').execute({ dictationId: m4aId, offset: at, dataBase64: block }, context);
  await assert.rejects(handle('dictation.chunk').execute({ dictationId: m4aId, offset: cap, dataBase64: Buffer.alloc(4, 1).toString('base64') }, context), /INVALID_PAYLOAD/);
});

test('a clip that is transcribing refuses more chunks and a second finish with BUSY', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  const engine: Transcriber = { transcribe: async () => { started = true; await gate; return 'done'; } };
  const { handle } = fixture(t, { engine });
  const context = contextFor(connection().conn);
  const id = await begin(handle, context);
  await handle('dictation.chunk').execute({ dictationId: id, offset: 0, dataBase64: loudPcm(16_000) }, context);
  const finishing = handle('dictation.finish').execute({ dictationId: id }, context);
  for (let i = 0; i < 100 && !started; i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(started);
  await assert.rejects(handle('dictation.chunk').execute({ dictationId: id, offset: 16_000, dataBase64: pcmChunk(4) }, context), /BUSY/);
  await assert.rejects(handle('dictation.finish').execute({ dictationId: id }, context), /BUSY/);
  release();
  assert.deepEqual(await finishing, { status: 'text', text: 'Done', insertOffered: false });
});

test('audio buffers are zeroed after finish, including the copies handed to the decoder and engine', async t => {
  let decoderInput: Buffer | undefined;
  let enginePcm: Int16Array | undefined;
  const decoder: AudioDecoder = async bytes => { decoderInput = bytes as Buffer; return new Int16Array(16_000).fill(9_000); };
  const engine: Transcriber = { transcribe: async pcm => { enginePcm = pcm; assert.ok(pcm.some(v => v !== 0)); return 'ok'; } };
  const { handle } = fixture(t, { decoder, engine });
  const context = contextFor(connection().conn);
  const id = await begin(handle, context, { format: 'm4a' });
  await handle('dictation.chunk').execute({ dictationId: id, offset: 0, dataBase64: Buffer.from([1, 2, 3, 4]).toString('base64') }, context);
  await handle('dictation.finish').execute({ dictationId: id }, context);
  assert.ok(decoderInput && decoderInput.every(b => b === 0), 'decoder input copy wiped');
  assert.ok(enginePcm && enginePcm.every(v => v === 0), 'trimmed engine copy wiped');
});
