import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { Sha256, sha256Hex, type FileEnv, type FileSink, type FileSource } from '@orbit/core';

const PIECE = 256 * 1024;
const yieldToUi = (): Promise<void> => new Promise(r => setTimeout(r, 0));

export const fileEnv: FileEnv = { uuid: () => Crypto.randomUUID(), sha256Bytes: async bytes => sha256Hex(bytes) };

/** Hashes a prefix of a file in pieces so a large file never sits in memory and the UI keeps moving. */
async function hashFile(file: File, length?: number): Promise<string> {
  const total = length ?? file.size;
  const hash = new Sha256();
  if (total === 0) return hash.hex();
  const handle = file.open();
  try {
    handle.offset = 0;
    for (let done = 0; done < total;) {
      const bytes = handle.readBytes(Math.min(PIECE, total - done));
      if (bytes.length === 0) throw new Error('File ended early');
      hash.update(bytes); done += bytes.length;
      await yieldToUi();
    }
  } finally { handle.close(); }
  return hash.hex();
}

export function sourceFromUri(uri: string, name: string): FileSource {
  const file = new File(uri);
  return {
    name, size: file.size, sha256: () => hashFile(file),
    async read(offset, length) {
      const handle = file.open();
      try { handle.offset = offset; return handle.readBytes(length); } finally { handle.close(); }
    },
  };
}

/** Receives into the app cache, then moves into the app's Orbit folder once the whole file is verified. */
export function sinkForDownload(transferId: string, name: string): FileSink {
  const cache = new Directory(Paths.cache, 'orbit-incoming');
  if (!cache.exists) cache.create({ intermediates: true });
  const partial = new File(cache, `${transferId}.partial`);
  const ensure = (): void => { if (!partial.exists) partial.create(); };
  return {
    size: async () => (partial.exists ? partial.size : 0),
    async write(offset, bytes) {
      ensure();
      const handle = partial.open();
      try { handle.offset = offset; handle.writeBytes(bytes); } finally { handle.close(); }
    },
    async sha256(length) { ensure(); return hashFile(partial, length); },
    async finalize() {
      const dir = new Directory(Paths.document, 'Orbit');
      if (!dir.exists) dir.create({ intermediates: true });
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name; const ext = dot > 0 ? name.slice(dot) : '';
      let target = new File(dir, name);
      for (let i = 2; target.exists; i++) target = new File(dir, `${stem} (${i})${ext}`);
      partial.move(target);
    },
    async discard() { if (partial.exists) partial.delete(); },
  };
}
