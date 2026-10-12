/** Decodes a compressed phone recording (m4a/AAC) to 16 kHz mono PCM by piping it through a local ffmpeg; depends on ffmpeg being installed; never writes audio to disk and caps both input and output. UNTESTED WITH REAL FFMPEG. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { MAX_DICTATION_SAMPLES } from '../protocol/dictation.js';

export type AudioDecoder = (bytes: Buffer, signal: AbortSignal) => Promise<Int16Array>;
export type DecoderSpawn = () => ChildProcessWithoutNullStreams;
export class DecodeError extends Error { constructor() { super('DECODE_FAILED'); } }

export function ffmpegDecoder(binary = 'ffmpeg', timeoutMs = 30_000, spawnImpl?: DecoderSpawn): AudioDecoder {
  const make: DecoderSpawn = spawnImpl ?? (() => spawn(binary, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', 'pipe:0', '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:1'],
    { windowsHide: true, stdio: 'pipe' }));
  return (bytes, signal) => new Promise<Int16Array>((resolve, reject) => {
    if (signal.aborted) { reject(new DecodeError()); return; }
    const limit = MAX_DICTATION_SAMPLES * 2;
    const chunks: Buffer[] = []; let size = 0; let done = false;
    let child: ChildProcessWithoutNullStreams;
    const finish = (err?: Error): void => {
      if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', onAbort);
      try { child.kill(); } catch { /* already gone */ }
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
    try { child = make(); } catch { finish(new DecodeError()); return; }
    child.stdout.on('data', (c: Buffer) => { size += c.length; if (size > limit) { finish(new DecodeError()); return; } chunks.push(c); });
    child.stderr.resume();
    child.stdin.on('error', () => { /* ffmpeg may close early; exit code decides */ });
    child.on('error', () => finish(new DecodeError()));
    child.on('close', code => finish(code === 0 ? undefined : new DecodeError()));
    child.stdin.end(bytes);
  });
}
