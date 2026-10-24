/** Durable, bounded record of who asked the agent to do what and who approved it; depends on node:fs; never stores prompts or approval text. */
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const MAX_AUDIT_ENTRIES = 2_000;
export const AUDIT_PAGE = 50;
export const auditKinds = ['submitted', 'approval-requested', 'approved', 'denied', 'approval-timeout', 'cancelled-by-user', 'finished', 'paused', 'resumed', 'approval-stacked-refused'] as const;
export const auditEntrySchema = z.strictObject({ at: z.number().int().min(0), taskId: z.string().uuid().optional(), deviceId: z.string().uuid(),
  kind: z.enum(auditKinds), outcome: z.string().max(32).optional() });
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export class AuditTrail {
  private readonly path: string;
  private count = 0;
  constructor(directory: string, private readonly now: () => number = Date.now) {
    this.path = join(directory, 'agent-audit.jsonl');
    if (!existsSync(this.path)) writeFileSync(this.path, '', { mode: 0o600 });
    chmodSync(this.path, 0o600);
    this.count = this.load().length;
  }

  /** Never throws: an unwritable audit file must not change what the agent is allowed to do, but it is reported to the caller. */
  record(entry: Omit<AuditEntry, 'at'>): boolean {
    try {
      const line = JSON.stringify(auditEntrySchema.parse({ ...entry, at: this.now() }));
      appendFileSync(this.path, line + '\n');
      if (++this.count > MAX_AUDIT_ENTRIES + 200) this.compact();
      return true;
    } catch { return false; }
  }

  /** Newest first, only entries for one device. */
  forDevice(deviceId: string, limit = AUDIT_PAGE): AuditEntry[] {
    return this.load().filter(entry => entry.deviceId === deviceId).slice(-limit).reverse();
  }

  /** Every entry, oldest first, for the desktop owner. JSON is an array; CSV has a header row and ISO-8601 UTC times. */
  exportAll(format: 'json' | 'csv'): string {
    const entries = this.load();
    if (format === 'json') return JSON.stringify(entries.map(e => ({ ...e, time: new Date(e.at).toISOString() })), null, 2) + '\n';
    // Every field is a UUID, an enum value or a short outcome code, but quote and neutralise formulas anyway.
    const cell = (v: string | undefined): string => { const t = v ?? ''; const safe = /^[=+\-@\t\r]/.test(t) ? `'${t}` : t; return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe; };
    return ['time,kind,deviceId,taskId,outcome', ...entries.map(e => [new Date(e.at).toISOString(), e.kind, e.deviceId, e.taskId, e.outcome].map(cell).join(','))].join('\n') + '\n';
  }

  private load(): AuditEntry[] {
    const entries: AuditEntry[] = [];
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (!line) continue;
      try { const parsed = auditEntrySchema.safeParse(JSON.parse(line)); if (parsed.success) entries.push(parsed.data); } catch { /* torn final line after a crash */ }
    }
    return entries;
  }
  private compact(): void {
    const keep = this.load().slice(-MAX_AUDIT_ENTRIES);
    writeFileSync(this.path, keep.map(entry => JSON.stringify(entry)).join('\n') + '\n', { mode: 0o600 });
    this.count = keep.length;
  }
}
