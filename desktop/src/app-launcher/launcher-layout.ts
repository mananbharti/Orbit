/** Privately persisted launcher favourites (ordered pinned app ids); depends on private atomic storage; a corrupt file starts empty. */
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { atomicWrite } from '../security-pairing/atomic-file.js';
import { appIdSchema, MAX_PINS } from '../protocol/app-launcher.js';

export class LauncherLayout {
  private pinned: string[] = [];

  constructor(private readonly path?: string) {
    if (!path || !existsSync(path)) return;
    try {
      const parsed = z.array(appIdSchema).max(MAX_PINS).safeParse(JSON.parse(readFileSync(path, 'utf8')));
      if (parsed.success) this.pinned = parsed.data;
    } catch { /* unreadable layout is simply forgotten */ }
  }

  list(): string[] { return [...this.pinned]; }

  pin(appId: string): string[] {
    if (!this.pinned.includes(appId)) {
      if (this.pinned.length >= MAX_PINS) throw new Error('LAUNCHER_PIN_LIMIT');
      this.pinned = [...this.pinned, appId];
      this.save();
    }
    return this.list();
  }

  unpin(appId: string): string[] {
    const next = this.pinned.filter(id => id !== appId);
    if (next.length !== this.pinned.length) { this.pinned = next; this.save(); }
    return this.list();
  }

  /** A reorder must name every pinned id exactly once - anything else is a stale client and rejected wholesale. */
  reorder(appIds: string[]): string[] {
    const current = new Set(this.pinned);
    if (appIds.length !== this.pinned.length || appIds.some(id => !current.has(id))) throw new Error('LAUNCHER_STALE_LAYOUT');
    this.pinned = [...appIds];
    this.save();
    return this.list();
  }

  /** App ids persist across restarts, so pins survive them; ids whose app vanished stay stored (the app may return). */
  private save(): void { if (this.path) atomicWrite(this.path, JSON.stringify(this.pinned)); }
}
