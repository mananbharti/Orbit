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
