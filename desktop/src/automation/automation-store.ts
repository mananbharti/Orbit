/** Privately persisted scheduled actions; depends on private atomic storage; a corrupt file starts empty. */
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { atomicWrite } from '../security-pairing/atomic-file.js';
import { MAX_AUTOMATIONS, automationSchema, type Automation, type AutomationAction } from '../protocol/automation.js';

/** Internal record: the wire shape plus the desktop-owner confirmation stamp for power schedules. Never sent to phones (strict wire schemas reject extra keys). */
const storedSchema = automationSchema.extend({ powerConfirmedAt: z.number().int().nonnegative().optional() });
type StoredAutomation = z.infer<typeof storedSchema>;

export class AutomationStore {
  private automations: StoredAutomation[] = [];
  /** Power schedules disabled at load because they predate the owner-confirmation gate (ids, for logging). */
  readonly disabledAtLoad: string[] = [];

  constructor(private readonly path?: string) {
    if (!path || !existsSync(path)) return;
    try {
      const parsed = z.array(storedSchema).max(MAX_AUTOMATIONS).safeParse(JSON.parse(readFileSync(path, 'utf8')));
      if (parsed.success) {
        // Migration: a stored power schedule without an owner-confirmation stamp predates the gate and must never fire silently.
        this.automations = parsed.data.map(a => {
          if (a.action.type === 'power' && a.enabled && a.powerConfirmedAt === undefined) { this.disabledAtLoad.push(a.id); return { ...a, enabled: false }; }
          return a;
        });
        if (this.disabledAtLoad.length) this.persist();
      }
    } catch { /* unreadable automations are simply forgotten */ }
  }

  private static strip(a: StoredAutomation): Automation {
    const { powerConfirmedAt: _, ...wire } = a;
    return { ...wire, days: [...wire.days] };
  }

  list(): Automation[] { return this.automations.map(a => AutomationStore.strip(a)); }
  get(id: string): Automation | undefined { const a = this.automations.find(x => x.id === id); return a ? AutomationStore.strip(a) : undefined; }

  /** Creates without an id, replaces with one. */
  save(entry: { id?: string; time: string; days: number[]; action: AutomationAction }, powerConfirmed = false): Automation[] {
    const stamp = powerConfirmed ? { powerConfirmedAt: Date.now() } : {};
    if (entry.id) {
      const index = this.automations.findIndex(a => a.id === entry.id);
      if (index === -1) throw new Error('AUTOMATION_NOT_FOUND');
      const prior = this.automations[index]!;
      // Every power save re-prompts upstream (service), so a fresh stamp replaces any prior one; non-power entries carry no stamp.
      const { powerConfirmedAt: _dropped, ...rest } = prior;
      this.automations[index] = { ...rest, time: entry.time, days: [...new Set(entry.days)].sort(), action: entry.action, ...stamp };
    } else {
      if (this.automations.length >= MAX_AUTOMATIONS) throw new Error('AUTOMATION_LIMIT');
      this.automations.push({ id: randomUUID(), time: entry.time, days: [...new Set(entry.days)].sort(), enabled: true, action: entry.action, ...stamp });
    }
    this.persist();
    return this.list();
  }

  setEnabled(id: string, enabled: boolean, powerConfirmed = false): Automation[] {
    const index = this.automations.findIndex(a => a.id === id);
    if (index === -1) throw new Error('AUTOMATION_NOT_FOUND');
    this.automations[index] = { ...this.automations[index]!, enabled, ...(powerConfirmed ? { powerConfirmedAt: Date.now() } : {}) };
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
