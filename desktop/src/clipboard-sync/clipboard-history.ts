/** Bounded, privately persisted clipboard history (newest first, 50 entries); depends on private atomic storage; a corrupt file starts empty, never crashes the service. */
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { atomicWrite } from '../security-pairing/atomic-file.js';
import { CLIPBOARD_HISTORY_LIMIT, HISTORY_PAGE_BYTES, clipboardHistoryEntrySchema, type ClipboardHistoryEntry } from '../protocol/clipboard.js';

export class ClipboardHistory {
  private entries: ClipboardHistoryEntry[] = []; // newest first

  constructor(private readonly path?: string) {
    if (!path || !existsSync(path)) return;
    try {
      const parsed = z.array(clipboardHistoryEntrySchema).max(CLIPBOARD_HISTORY_LIMIT).safeParse(JSON.parse(readFileSync(path, 'utf8')));
      if (parsed.success) this.entries = parsed.data;
    } catch { /* unreadable history is simply forgotten */ }
  }

  add(text: string, source: 'pc' | 'phone'): void {
    if (this.entries[0]?.text === text) return; // consecutive duplicate
    this.entries.unshift({ id: randomUUID(), text, at: Date.now(), source });
    this.entries.length = Math.min(this.entries.length, CLIPBOARD_HISTORY_LIMIT);
    if (this.path) atomicWrite(this.path, JSON.stringify(this.entries));
  }

  get(id: string): ClipboardHistoryEntry | undefined { return this.entries.find(entry => entry.id === id); }

  /** Newest-first page after the `before` entry, capped so the JSON stays well under the 64KB message limit. */
  page(before?: string): { entries: ClipboardHistoryEntry[]; nextCursor: string | null } {
    let start = 0;
    if (before) {
      const index = this.entries.findIndex(entry => entry.id === before);
      if (index === -1) return { entries: [], nextCursor: null };
      start = index + 1;
    }
    const out: ClipboardHistoryEntry[] = []; let bytes = 0; let i = start;
    for (; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      const size = Buffer.byteLength(entry.text, 'utf8') + 80;
      if (out.length && bytes + size > HISTORY_PAGE_BYTES) break;
      out.push(entry); bytes += size;
    }
    return { entries: out, nextCursor: i < this.entries.length && out.length ? out[out.length - 1]!.id : null };
  }
}
