/** Verifies the dictation service edges the main suite leaves open: empty compressed uploads, engine-side length errors, and wiping of the stored buffers on drop; depends on a fake transcriber and decoder only. */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { ActivityLog } from '../src/activity-log/activity-log.js';
import { CommandRegistry } from '../src/command-router/command-registry.js';
import type { CommandConnection, CommandContext } from '../src/command-router/command-context.js';
import type { AudioDecoder } from '../src/dictation/ffmpeg-decoder.js';
import { DictationError, type Transcriber } from '../src/dictation/pipeline.js';
import { DictationService } from '../src/dictation/dictation-service.js';

function connection(): { conn: CommandConnection; abort: AbortController } {
  const abort = new AbortController();
  return { abort, conn: { id: Math.random().toString(36).slice(2), closed: abort.signal, isAuthorized: () => !abort.signal.aborted, publish: () => {} } };
}

function contextFor(conn: CommandConnection, deviceId = 'phone-1'): CommandContext {
  return { session: { deviceId, sessionId: 'sess-1', expiresAt: Date.now() + 60_000 }, requestId: 'req-1', connection: conn };
}

function fixture(t: TestContext, options: { engine?: Transcriber; decoder?: AudioDecoder } = {}) {
  const registry = new CommandRegistry();
  const engine: Transcriber = options.engine ?? { transcribe: async () => 'hello orbit' };
  const service = new DictationService(registry, engine, new ActivityLog(), () => ({}), 150_000, options.decoder);
  t.after(async () => service.stop());
  const handle = (type: string) => {
    const found = registry.get(type);
    assert.ok(found, `${type} is registered`);
    return found;
  };
  return { service, handle };
}

type ClipInternals = { samples: Int16Array; compressed?: Buffer };
const clipInternals = (service: DictationService): ClipInternals =>
  (service as unknown as { clip: ClipInternals }).clip;

test('finishing an m4a clip with no uploaded bytes fails without calling the decoder and frees the slot', async t => {
  let decoded = 0;
  const decoder: AudioDecoder = async () => { decoded++; return new Int16Array(16_000); };
  const { handle } = fixture(t, { decoder });
  const context = contextFor(connection().conn);
  const first = await handle('dictation.begin').execute({ language: 'en', format: 'm4a' }, context) as { dictationId: string };
  await assert.rejects(handle('dictation.finish').execute({ dictationId: first.dictationId }, context), /COMMAND_FAILED/);
  assert.equal(decoded, 0, 'the decoder never runs on an empty upload');
  const second = await handle('dictation.begin').execute({ format: 'm4a' }, context) as { dictationId: string };
  assert.notEqual(second.dictationId, first.dictationId, 'the slot is free right away');
});

test('an engine-side clip-length rejection maps to INVALID_PAYLOAD, not a generic failure', async t => {
  const engine: Transcriber = { transcribe: async () => { throw new DictationError('CLIP_TOO_LONG'); } };
  const { handle } = fixture(t, { engine });
  const context = contextFor(connection().conn);
  const { dictationId } = await handle('dictation.begin').execute({}, context) as { dictationId: string };
  const loud = Buffer.alloc(16_000);
  for (let i = 0; i < 8_000; i++) loud.writeInt16LE(9_000, i * 2);
  await handle('dictation.chunk').execute({ dictationId, offset: 0, dataBase64: loud.toString('base64') }, context);
  await assert.rejects(handle('dictation.finish').execute({ dictationId }, context), /INVALID_PAYLOAD/);
});

test('the stored pcm buffer is wiped when the clip is cancelled', async t => {
  const { service, handle } = fixture(t);
  const context = contextFor(connection().conn);
  const { dictationId } = await handle('dictation.begin').execute({}, context) as { dictationId: string };
  const loud = Buffer.alloc(32);
  for (let i = 0; i < 16; i++) loud.writeInt16LE(9_000, i * 2);
  await handle('dictation.chunk').execute({ dictationId, offset: 0, dataBase64: loud.toString('base64') }, context);
  const stored = clipInternals(service).samples;
  assert.ok(stored.some(v => v !== 0), 'the upload reached the stored buffer');
  await handle('dictation.cancel').execute({ dictationId }, context);
  assert.ok(stored.every(v => v === 0), 'cancel zeroes the stored pcm');
});

test('the stored compressed buffer is wiped when the clip is cancelled', async t => {
  const decoder: AudioDecoder = async () => new Int16Array(16_000);
  const { service, handle } = fixture(t, { decoder });
  const context = contextFor(connection().conn);
  const { dictationId } = await handle('dictation.begin').execute({ format: 'm4a' }, context) as { dictationId: string };
  await handle('dictation.chunk').execute({ dictationId, offset: 0, dataBase64: Buffer.from([0xff, 0xf1, 0x50, 0x80]).toString('base64') }, context);
  const stored = clipInternals(service).compressed!;
  assert.ok(stored.subarray(0, 4).some(b => b !== 0), 'the upload reached the stored buffer');
  await handle('dictation.cancel').execute({ dictationId }, context);
  assert.ok(stored.every(b => b === 0), 'cancel zeroes the stored compressed bytes');
});
