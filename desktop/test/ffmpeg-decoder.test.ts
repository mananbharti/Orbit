/** Compressed-audio decoding through a local ffmpeg: temp-file input (MP4 cannot demux from a pipe), decoded samples, and every failure mode honestly DECODE_FAILED; depends on fake child processes and temp dirs; performs no real decode. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, existsSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { DecoderChild } from '../src/dictation/ffmpeg-decoder.js';
import { ffmpegDecoder } from '../src/dictation/ffmpeg-decoder.js';

function fake(onInput: (input: Buffer, c: EventEmitter & { stdout: PassThrough }) => void) {
  return (inputFile: string) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill() { return true; } });
    setImmediate(() => onInput(readFileSync(inputFile), child));
    return child as unknown as DecoderChild;
  };
}
const pcm = (...v: number[]) => { const b = Buffer.alloc(v.length * 2); v.forEach((s, i) => b.writeInt16LE(s, i * 2)); return b; };
const ac = () => new AbortController().signal;

test('writes the compressed clip to a private temp file, decodes it, and wipes the file afterwards', async () => {
  let got = 0; let seen = '';
  const d = ffmpegDecoder('ffmpeg', 1000, file => { seen = file; return fake((input, c) => { got = input.length; c.stdout.write(pcm(1, -2, 3)); c.emit('close', 0); })(file); });
  assert.deepEqual([...await d(Buffer.from('abcd'), ac())], [1, -2, 3]);
  assert.equal(got, 4);
  assert.ok(seen.endsWith('clip.m4a'));
  assert.ok(!existsSync(seen)); // the temp clip is gone after the decode
});
test('non-zero exit, no output, spawn failure, timeout, abort and oversize output are all DECODE_FAILED', async () => {
  const fails = (d: ReturnType<typeof ffmpegDecoder>, signal = ac()) => assert.rejects(d(Buffer.from('x'), signal), /DECODE_FAILED/);
  await fails(ffmpegDecoder('f', 1000, fake((_i, c) => c.emit('close', 1))));
  await fails(ffmpegDecoder('f', 1000, fake((_i, c) => c.emit('close', 0))));
  await fails(ffmpegDecoder('f', 1000, () => { throw new Error('ENOENT'); }));
  await fails(ffmpegDecoder('f', 30, fake(() => {})));
  const a = new AbortController(); a.abort(); await fails(ffmpegDecoder('f', 1000, fake(() => {})), a.signal);
  await fails(ffmpegDecoder('f', 1000, fake((_i, c) => { c.stdout.write(Buffer.alloc(16_000 * 2 * 121)); c.emit('close', 0); })));
});
