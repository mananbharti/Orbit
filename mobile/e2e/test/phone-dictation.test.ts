/** Phone core dictates through the real desktop service with a fake local engine and synthetic audio. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { AudioDecoder } from '../../../desktop/src/dictation/ffmpeg-decoder.js';
import { startDesktop } from '../../../desktop/src/desktop-service.js';
import type { Transcriber } from '../../../desktop/src/dictation/pipeline.js';
import { DictationApi } from '../../core/src/dictation.js';
import { pairWithQr } from '../../core/src/pairing.js';
import { CommandError, OrbitSession } from '../../core/src/session.js';
import { NodePinnedTransport } from './node-pinned-transport.js';

const tone = (ms: number, amp: number): Int16Array => Int16Array.from({ length: 16 * ms }, (_v, i) => Math.round(amp * Math.sin(i / 4)));
const speech = (): Int16Array => Int16Array.from([...tone(600, 0), ...tone(1500, 9000), ...tone(600, 0)]);

async function phone(t: TestContext, engine: Transcriber, scopes?: string, decoder?: AudioDecoder) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-phone-dict-'));
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false,
    dictation: { engine, cleanup: () => ({ dictionary: { orbit: 'Orbit' } }), ...(decoder ? { decoder } : {}) } });
  const transport = new NodePinnedTransport(new Map());
  const qr = service.pairing.open();
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  const session = new OrbitSession(paired, transport, { uuid: randomUUID });
  t.after(async () => { session.stop(); await service.stop(); rmSync(root, { recursive: true, force: true }); });
  await session.start();
  void scopes;
  return new DictationApi(session);
}

test('a clip is streamed, transcribed locally and returned as cleaned text; audio is wiped', async t => {
  let samples = 0;
  const api = await phone(t, { transcribe: async pcm => { samples = pcm.length; return 'um hello orbit'; } });
  const clip = speech();
  assert.deepEqual(await api.transcribe(clip, 'en'), { status: 'text', text: 'Hello Orbit' });
  assert.ok(samples > 16_000 && samples < clip.length);
  assert.ok(clip.every(s => s === 0));
});
test('silence returns no-speech without calling the engine', async t => {
  let called = false;
  const api = await phone(t, { transcribe: async () => { called = true; return 'x'; } });
  assert.deepEqual(await api.transcribe(tone(2000, 0)), { status: 'no-speech' });
  assert.equal(called, false);
});
test('an engine failure is a safe error and the next dictation works', async t => {
  let fail = true;
  const api = await phone(t, { transcribe: async () => { if (fail) throw new Error('boom /secret'); return 'ok now'; } });
  await assert.rejects(api.transcribe(speech()), (e: unknown) => e instanceof CommandError && e.code === 'COMMAND_FAILED');
  fail = false;
  assert.deepEqual(await api.transcribe(speech()), { status: 'text', text: 'Ok now' });
});
test('an invalid language is refused before anything is sent', async t => {
  const api = await phone(t, { transcribe: async () => 'x' });
  await assert.rejects(api.transcribe(speech(), 'en; rm'), (e: unknown) => e instanceof CommandError);
});

test('Android path: compressed audio is decoded on the computer, transcribed, and wiped', async t => {
  let received = 0;
  const decoder: AudioDecoder = async bytes => { received = bytes.length; return speech(); };
  const api = await phone(t, { transcribe: async () => 'um hello orbit' }, undefined, decoder);
  const audio = new Uint8Array(70_000).fill(7); // two full chunks and a partial one
  assert.deepEqual(await api.transcribeCompressed(audio, 'en'), { status: 'text', text: 'Hello Orbit' });
  assert.equal(received, 70_000);
  assert.ok(audio.every(b => b === 0));
});
test('compressed audio is refused cleanly when the computer has no decoder, and a decoder failure is a safe error', async t => {
  const noDecoder = await phone(t, { transcribe: async () => 'x' });
  await assert.rejects(noDecoder.transcribeCompressed(new Uint8Array(100).fill(1)));
  const failing = await phone(t, { transcribe: async () => 'x' }, undefined, async () => { throw new Error('boom'); });
  await assert.rejects(failing.transcribeCompressed(new Uint8Array(100).fill(1)));
  assert.deepEqual(await (await phone(t, { transcribe: async () => 'hello' }, undefined, async () => speech())).transcribeCompressed(new Uint8Array(10).fill(1)), { status: 'text', text: 'Hello' });
});

test('cancelling mid-stream frees the clip; double-cancel and finish-after-cancel are clean errors', async t => {
  let called = 0;
  const root = mkdtempSync(join(tmpdir(), 'orbit-phone-dict-cancel-'));
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false,
    dictation: { engine: { transcribe: async () => { called++; return 'after cancel'; } }, cleanup: () => ({ dictionary: {} }) } });
  const transport = new NodePinnedTransport(new Map());
  const qr = service.pairing.open();
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  const session = new OrbitSession(paired, transport, { uuid: randomUUID });
  t.after(async () => { session.stop(); await service.stop(); rmSync(root, { recursive: true, force: true }); });
  await session.start();

  const begun = await session.command('dictation.begin', {}) as { dictationId: string };
  const chunk = Buffer.alloc(1600 * 2); // 100ms of quiet synthetic audio
  const ack = await session.command('dictation.chunk', { dictationId: begun.dictationId, offset: 0, dataBase64: chunk.toString('base64') }) as { nextOffset: number };
  assert.equal(ack.nextOffset, 1600);
  assert.deepEqual(await session.command('dictation.cancel', { dictationId: begun.dictationId }), { cancelled: true });
  await assert.rejects(session.command('dictation.cancel', { dictationId: begun.dictationId }),
    (e: unknown) => e instanceof CommandError && e.code === 'INVALID_PAYLOAD');
  await assert.rejects(session.command('dictation.finish', { dictationId: begun.dictationId }),
    (e: unknown) => e instanceof CommandError && e.code === 'INVALID_PAYLOAD');
  assert.equal(called, 0, 'the engine never saw the cancelled clip');
  // The clip slot is truly free: a full dictation afterwards works.
  assert.deepEqual(await new DictationApi(session).transcribe(speech(), 'en'), { status: 'text', text: 'After cancel' });
  assert.equal(called, 1);
});

test('an over-long clip is refused on the phone before any audio is sent, and the engine is never called', async t => {
  let calls = 0;
  const api = await phone(t, { transcribe: async () => { calls += 1; return 'x'; } });
  await assert.rejects(api.transcribe(new Int16Array(16_000 * 120 + 1), 'en'), /too long/i);
  await assert.rejects(api.transcribeCompressed(new Uint8Array(3 * 1024 * 1024 + 1), 'en'), /too long/i);
  assert.equal(calls, 0);
  assert.deepEqual(await api.transcribe(speech(), 'en'), { status: 'text', text: 'X' }, 'the session still works');
});

test('a decoder that returns more audio than the limit is a safe error, not an engine run', async t => {
  let calls = 0;
  const api = await phone(t, { transcribe: async () => { calls += 1; return 'x'; } }, undefined, async () => new Int16Array(16_000 * 121).fill(5000));
  await assert.rejects(api.transcribeCompressed(new Uint8Array(100).fill(1), 'en'));
  assert.equal(calls, 0, 'the engine never saw the oversize decode');
});

test('when the phone drops mid-clip, the desktop discards the audio and the old clip cannot be finished later', async t => {
  let called = 0;
  const root = mkdtempSync(join(tmpdir(), 'orbit-phone-dict-drop-'));
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false,
    dictation: { engine: { transcribe: async () => { called++; return 'late words'; } }, cleanup: () => ({ dictionary: {} }) } });
  const transport = new NodePinnedTransport(new Map());
  const qr = service.pairing.open();
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  const session = new OrbitSession(paired, transport, { uuid: randomUUID });
  t.after(async () => { session.stop(); await service.stop(); rmSync(root, { recursive: true, force: true }); });
  await session.start();
  const begun = await session.command('dictation.begin', {}) as { dictationId: string };
  await session.command('dictation.chunk', { dictationId: begun.dictationId, offset: 0, dataBase64: Buffer.alloc(3200).toString('base64') });
  session.stop();
  await session.start();
  await assert.rejects(session.command('dictation.finish', { dictationId: begun.dictationId }),
    (e: unknown) => e instanceof CommandError && e.code === 'INVALID_PAYLOAD');
  assert.equal(called, 0, 'the engine never saw the abandoned audio');
  assert.deepEqual(await new DictationApi(session).transcribe(speech(), 'en'), { status: 'text', text: 'Late words' });
});

test('only one clip is open at a time: a second phone is refused as BUSY, and can start once the first finishes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-phone-dict-two-'));
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false,
    dictation: { engine: { transcribe: async () => 'one at a time' }, cleanup: () => ({ dictionary: {} }) } });
  const sessions: OrbitSession[] = [];
  t.after(async () => { for (const s of sessions) s.stop(); await service.stop(); rmSync(root, { recursive: true, force: true }); });
  const add = async () => {
    const transport = new NodePinnedTransport(new Map());
    const qr = service.pairing.open();
    (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
    const paired = await pairWithQr(JSON.stringify(qr), transport);
    const session = new OrbitSession(paired, transport, { uuid: randomUUID }); sessions.push(session);
    await session.start();
    return session;
  };
  const a = await add(); const b = await add();
  const begun = await a.command('dictation.begin', {}) as { dictationId: string };
  await assert.rejects(b.command('dictation.begin', {}), (e: unknown) => e instanceof CommandError && e.code === 'BUSY');
  await a.command('dictation.cancel', { dictationId: begun.dictationId });
  assert.deepEqual(await new DictationApi(b).transcribe(speech(), 'en'), { status: 'text', text: 'One at a time' });
});
