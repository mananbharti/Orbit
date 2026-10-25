/** Local whisper.cpp engine: runs the user's own whisper-cli binary and model file on this computer; writes the clip to a private temp file that is overwritten and deleted afterwards; never opens a network connection. */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, openSync, writeSync, closeSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Transcriber } from './pipeline.js';
import { SAMPLE_RATE, DictationError } from './pipeline.js';

export interface WhisperCppOptions { binary: string; model: string; threads?: number; timeoutMs?: number }

/** Per-clip engine timeout when none is given. Large/turbo models get 115 s: auto language detection roughly doubles their work, and on a slow machine that can exceed a minute; the cap still fails honestly just inside the phone's own 120 s wait (mobile/core dictation.finish) instead of hanging past it. */
export function defaultEngineTimeoutMs(modelPath: string): number {
  return /large/.test(basename(modelPath)) ? 115_000 : 60_000;
}

export function wavBytes(pcm: Int16Array, rate = SAMPLE_RATE): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export class WhisperCpp implements Transcriber {
  constructor(private readonly options: WhisperCppOptions) {
    if (!existsSync(options.binary) || !existsSync(options.model)) throw new DictationError('ENGINE_FAILED');
  }
  async transcribe(pcm: Int16Array, { language, signal }: { language?: string; signal: AbortSignal }): Promise<string> {
    if (language !== undefined && !/^[a-z]{2,3}$|^auto$/.test(language)) throw new DictationError('ENGINE_FAILED');
    const dir = mkdtempSync(join(tmpdir(), 'orbit-dictation-'), { }); // mode 0700 by mkdtemp
    const file = join(dir, 'clip.wav');
    const wav = wavBytes(pcm);
    try {
      writeFileSync(file, wav, { mode: 0o600 });
      const args = ['-m', this.options.model, '-f', file, '-nt', '-np', '-t', String(this.options.threads ?? 4), '-l', language ?? 'auto'];
      return await new Promise<string>((resolve, reject) => {
        execFile(this.options.binary, args, { timeout: this.options.timeoutMs ?? defaultEngineTimeoutMs(this.options.model), maxBuffer: 1 << 20, signal, windowsHide: true },
          (error, stdout) => (error ? reject(error) : resolve(String(stdout).trim())));
      });
    } finally {
      try { const fd = openSync(file, 'r+'); try { writeSync(fd, Buffer.alloc(wav.length)); } finally { closeSync(fd); } } catch { /* file may not exist */ }
      wav.fill(0);
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
