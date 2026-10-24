/** Decodes a compressed phone recording (m4a/AAC) to 16 kHz mono PCM with a local ffmpeg; depends on ffmpeg being installed; caps both input and output. The MP4 container cannot be demuxed from a pipe (its index needs a seekable input - proven against real ffmpeg 4.4 on 2026-10-24), so the compressed bytes go to a private temp file that is overwritten and deleted right after the decode, the same pattern the whisper engine uses for its clip. */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MAX_DICTATION_SAMPLES } from '../protocol/dictation.js';

export type AudioDecoder = (bytes: Buffer, signal: AbortSignal) => Promise<Int16Array>;
export class DecodeError extends Error { constructor() { super('DECODE_FAILED'); } }

export type DecoderChild = ChildProcessByStdio<null, Readable, Readable>;
export type DecoderSpawn = (inputFile: string) => DecoderChild;

export function ffmpegDecoder(binary = 'ffmpeg', timeoutMs = 30_000, spawnImpl?: DecoderSpawn): AudioDecoder {
  const make: DecoderSpawn = spawnImpl ?? (file => spawn(binary, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:1'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
  return (bytes, signal) => new Promise<Int16Array>((resolve, reject) => {
    if (signal.aborted) { reject(new DecodeError()); return; }
    const dir = mkdtempSync(join(tmpdir(), 'orbit-decode-'));
    const file = join(dir, 'clip.m4a');
    const cleanup = (): void => {
      try { const fd = openSync(file, 'r+'); try { writeSync(fd, Buffer.alloc(bytes.length)); } finally { closeSync(fd); } } catch { /* file may not exist */ }
      rmSync(dir, { recursive: true, force: true });
    };
    try { writeFileSync(file, bytes, { mode: 0o600 }); }
    catch { cleanup(); reject(new DecodeError()); return; }
    const limit = MAX_DICTATION_SAMPLES * 2;
    const chunks: Buffer[] = []; let size = 0; let done = false;
    let child: DecoderChild;
    const finish = (err?: Error): void => {
      if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', onAbort);
      try { child.kill(); } catch { /* already gone */ }
      cleanup();
      if (err) { for (const c of chunks) c.fill(0); reject(err); return; }
      const all = Buffer.concat(chunks, size); for (const c of chunks) c.fill(0);
      const samples = new Int16Array(Math.floor(all.length / 2));
      for (let i = 0; i < samples.length; i++) samples[i] = all.readInt16LE(i * 2);
      all.fill(0);
      if (samples.length === 0) reject(new DecodeError()); else resolve(samples);
    };
    const onAbort = (): void => finish(new DecodeError());
    const timer = setTimeout(() => finish(new DecodeError()), timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    try { child = make(file); } catch { finish(new DecodeError()); return; }
    child.stdout.on('data', (c: Buffer) => { size += c.length; if (size > limit) { finish(new DecodeError()); return; } chunks.push(c); });
    child.stderr.resume();
    child.on('error', () => finish(new DecodeError()));
    child.on('close', code => finish(code === 0 ? undefined : new DecodeError()));
  });
}
