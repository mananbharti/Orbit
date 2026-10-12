import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { ffmpegDecoder } from '../src/dictation/ffmpeg-decoder.js';

function fake(onInput: (input: Buffer, c: EventEmitter & { stdout: PassThrough }) => void) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { return true; } });
  const parts: Buffer[] = []; child.stdin.on('data', (d: Buffer) => parts.push(d)); child.stdin.on('end', () => onInput(Buffer.concat(parts), child));
  return child as unknown as ChildProcessWithoutNullStreams;
}
const pcm = (...v: number[]) => { const b = Buffer.alloc(v.length * 2); v.forEach((s, i) => b.writeInt16LE(s, i * 2)); return b; };
const ac = () => new AbortController().signal;

test('pipes the audio in and returns the decoded samples', async () => {
  let got = 0;
  const d = ffmpegDecoder('ffmpeg', 1000, () => fake((input, c) => { got = input.length; c.stdout.write(pcm(1, -2, 3)); c.emit('close', 0); }));
  assert.deepEqual([...await d(Buffer.from('abcd'), ac())], [1, -2, 3]); assert.equal(got, 4);
});
test('non-zero exit, no output, spawn failure, timeout, abort and oversize output are all DECODE_FAILED', async () => {
  const fails = (d: ReturnType<typeof ffmpegDecoder>, signal = ac()) => assert.rejects(d(Buffer.from('x'), signal), /DECODE_FAILED/);
  await fails(ffmpegDecoder('f', 1000, () => fake((_i, c) => c.emit('close', 1))));
  await fails(ffmpegDecoder('f', 1000, () => fake((_i, c) => c.emit('close', 0))));
  await fails(ffmpegDecoder('f', 1000, () => { throw new Error('ENOENT'); }));
  await fails(ffmpegDecoder('f', 30, () => fake(() => {})));
  const a = new AbortController(); a.abort(); await fails(ffmpegDecoder('f', 1000, () => fake(() => {})), a.signal);
  await fails(ffmpegDecoder('f', 1000, () => fake((_i, c) => { c.stdout.write(Buffer.alloc(16_000 * 2 * 121)); c.emit('close', 0); })));
});
