/** Privately persisted scheduled actions; depends on private atomic storage; a corrupt file starts empty. */
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { atomicWrite } from '../security-pairing/atomic-file.js';
import { MAX_AUTOMATIONS, automationSchema, type Automation, type AutomationAction } from '../protocol/automation.js';

export class AutomationStore {
  private automations: Automation[] = [];

  constructor(private readonly path?: string) {
    if (!path || !existsSync(path)) return;
    try {
      const parsed = z.array(automationSchema).max(MAX_AUTOMATIONS).safeParse(JSON.parse(readFileSync(path, 'utf8')));
      if (parsed.success) this.automations = parsed.data;
    } catch { /* unreadable automations are simply forgotten */ }
  }

  list(): Automation[] { return this.automations.map(a => ({ ...a, days: [...a.days] })); }
  get(id: string): Automation | undefined { const a = this.automations.find(x => x.id === id); return a ? { ...a, days: [...a.days] } : undefined; }

  /** Creates without an id, replaces with one. */
  save(entry: { id?: string; time: string; days: number[]; action: AutomationAction }): Automation[] {
    if (entry.id) {
      const index = this.automations.findIndex(a => a.id === entry.id);
      if (index === -1) throw new Error('AUTOMATION_NOT_FOUND');
      this.automations[index] = { ...this.automations[index]!, time: entry.time, days: [...new Set(entry.days)].sort(), action: entry.action };
    } else {
      if (this.automations.length >= MAX_AUTOMATIONS) throw new Error('AUTOMATION_LIMIT');
      this.automations.push({ id: randomUUID(), time: entry.time, days: [...new Set(entry.days)].sort(), enabled: true, action: entry.action });
    }
    this.persist();
    return this.list();
  }

  setEnabled(id: string, enabled: boolean): Automation[] {
    const index = this.automations.findIndex(a => a.id === id);
    if (index === -1) throw new Error('AUTOMATION_NOT_FOUND');
    this.automations[index] = { ...this.automations[index]!, enabled };
    this.persist();
    return this.list();
  }

  remove(id: string): Automation[] {
    const next = this.automations.filter(a => a.id !== id);
    if (next.length === this.automations.length) throw new Error('AUTOMATION_NOT_FOUND');
    this.automations = next;
    this.persist();
    return this.list();
  }

  /** Marks a firing so the same minute never fires twice; written through so a restart cannot double-fire. */
  markFired(id: string, at: number): void {
    const index = this.automations.findIndex(a => a.id === id);
    if (index === -1) return;
    this.automations[index] = { ...this.automations[index]!, lastFiredAt: at };
    this.persist();
  }

  private persist(): void { if (this.path) atomicWrite(this.path, JSON.stringify(this.automations)); }
}
