/** Supplies synthetic clipboard state and bounded waits; depends on clipboard types; never accesses a native clipboard or stores real user data. */
import { setTimeout as delay } from 'node:timers/promises';
import type { ClipboardAdapter } from '../src/os-integration/clipboard.js';
import type { ClipboardSnapshot } from '../src/protocol/clipboard.js';

export class MemoryClipboard implements ClipboardAdapter {
  value: ClipboardSnapshot = { kind: 'text', text: 'initial synthetic clipboard' };
  writes: string[] = [];
  reads = 0;
  disposed = false;
  failRead = false;
  failWrite = false;
  beforeRead?: () => Promise<void>;
  async read(): Promise<ClipboardSnapshot> {
    this.reads++;
    await this.beforeRead?.();
    if (this.disposed || this.failRead) throw new Error('synthetic sensitive diagnostic');
    return { ...this.value };
  }
  async write(text: string): Promise<void> {
    if (this.disposed || this.failWrite) throw new Error('synthetic sensitive diagnostic');
    this.writes.push(text);
    this.value = { kind: 'text', text };
  }
  async dispose(): Promise<void> { this.disposed = true; }
}

export async function waitForClipboard(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Expected synthetic clipboard state did not arrive');
    await delay(10);
  }
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
