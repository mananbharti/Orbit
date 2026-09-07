/** Stores bounded chunks and verifies selected files; depends on Node filesystem/crypto and private directories; never accepts remote paths or logs contents. */
import { createHash } from 'node:crypto';
import { createReadStream, closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readSync, realpathSync, statSync, truncateSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CHUNK_BYTES, MAX_FILE_BYTES } from '../protocol/file-transfer.js';
import { ProtocolError } from '../protocol/errors.js';

export const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
export function safeDirectory(path: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute)) mkdirSync(absolute, { mode: 0o700 });
  if (!lstatSync(absolute).isDirectory() || lstatSync(absolute).isSymbolicLink()
    || !samePath(realpathSync(absolute), absolute)) throw new ProtocolError('FILE_IO');
  return absolute;
}
export function regularFile(path: string): void {
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new ProtocolError('FILE_IO');
}
export function selectedFile(path: string): string {
  const absolute = resolve(path);
  regularFile(absolute);
  if (!samePath(realpathSync(absolute), absolute) || statSync(absolute).size > MAX_FILE_BYTES) throw new ProtocolError('FILE_IO');
  return absolute;
}
export async function hashFile(path: string, bytes?: number, signal?: AbortSignal): Promise<string> {
  regularFile(path);
  const hash = createHash('sha256');
  if (bytes === 0) return hash.digest('hex');
  const input = createReadStream(path, { highWaterMark: 256 * 1_024, ...(bytes === undefined ? {} : { end: bytes - 1 }), signal });
  let count = 0;
  for await (const data of input) {
    const chunk = data as Buffer;
    count += chunk.length;
    if (count > MAX_FILE_BYTES) { input.destroy(); throw new ProtocolError('FILE_QUOTA'); }
    hash.update(chunk);
  }
  if (bytes !== undefined && count !== bytes) throw new ProtocolError('FILE_INTEGRITY');
  return hash.digest('hex');
}
export function readChunk(path: string, offset: number, length: number): Buffer {
  regularFile(path);
  const file = openSync(path, 'r');
  try {
    const bytes = Buffer.alloc(length);
    let total = 0;
    while (total < length) {
      const count = readSync(file, bytes, total, length - total, offset + total);
      if (!count) throw new ProtocolError('FILE_IO');
      total += count;
    }
    return bytes;
  } finally { closeSync(file); }
}
export function writeChunk(path: string, offset: number, bytes: Buffer): void {
  regularFile(path);
  const file = openSync(path, 'r+');
  try {
    let written = 0;
    while (written < bytes.length) {
      const count = writeSync(file, bytes, written, bytes.length - written, offset + written);
      if (!count) throw new ProtocolError('FILE_IO');
      written += count;
    }
    fsyncSync(file);
  } finally { closeSync(file); }
}
export function decodeChunk(data: string, hash: string, offset: number, size: number): Buffer {
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data || bytes.length !== Math.min(CHUNK_BYTES, size - offset)
    || !bytes.length || offset % CHUNK_BYTES !== 0 || sha256(bytes) !== hash) throw new ProtocolError('FILE_INTEGRITY');
  return bytes;
}
export function createPartial(path: string): void {
  const fd = openSync(path, 'wx', 0o600); try { fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}
export function removePartial(path: string): void { if (existsSync(path)) { regularFile(path); unlinkSync(path); } }
export function recoverPartial(path: string, bytes: number): void {
  regularFile(path);
  if (statSync(path).size < bytes) throw new ProtocolError('FILE_INTEGRITY');
  truncateSync(path, bytes);
}
export function publishFile(partial: string, destination: string): void {
  regularFile(partial);
  // link is atomic and refuses an existing destination on both platforms; never rename over a user's file.
  linkSync(partial, destination);
  syncDirectory(dirname(destination));
}
function syncDirectory(path: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function receivingPaths(inbox: string, transferId: string, name: string) {
  return { partial: join(inbox, `.${transferId}.part`), destination: join(inbox, `${transferId}-${name}`) };
}
