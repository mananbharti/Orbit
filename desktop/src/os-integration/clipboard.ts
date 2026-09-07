/** Defines OS clipboard access; depends on the clipboard protocol; does not authorize commands or synchronize devices. */
import type { ClipboardSnapshot } from '../protocol/clipboard.js';

export interface ClipboardAdapter {
  read(): Promise<ClipboardSnapshot>;
  write(text: string): Promise<void>;
  dispose(): Promise<void>;
}

export class ClipboardUnavailable extends Error {
  constructor() { super('Clipboard unavailable: check desktop session access and required platform tools'); }
}
