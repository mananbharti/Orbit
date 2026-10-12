/** Phone client for desktop graph memory (memory.remember / recall / forget); depends on OrbitSession and Zod; never caches memory on the phone. */
import { z } from 'zod';
import { InvalidDesktopReply } from './agent.js';
import type { OrbitSession } from './session.js';

const rememberReply = z.object({ id: z.string().uuid() });
const recallReply = z.object({ results: z.array(z.object({ id: z.string().uuid(), name: z.string(), kind: z.string(), facts: z.array(z.string()), via: z.string().optional() })).max(20) });
const forgetReply = z.object({ removed: z.boolean() });
export type MemoryHit = z.infer<typeof recallReply>['results'][number];
export interface RememberInput { name: string; kind?: string; fact?: string; alias?: string; relatedTo?: string; relation?: string }

export class MemoryApi {
  constructor(private readonly session: OrbitSession) {}
  async remember(input: RememberInput): Promise<string> {
    const r = rememberReply.safeParse(await this.session.command('memory.remember', { ...input }));
    if (!r.success) throw new InvalidDesktopReply();
    return r.data.id;
  }
  async recall(query: string, limit?: number): Promise<MemoryHit[]> {
    const r = recallReply.safeParse(await this.session.command('memory.recall', { query, ...(limit ? { limit } : {}) }));
    if (!r.success) throw new InvalidDesktopReply();
    return r.data.results;
  }
  async forget(id: string): Promise<boolean> {
    const r = forgetReply.safeParse(await this.session.command('memory.forget', { id }));
    if (!r.success) throw new InvalidDesktopReply();
    return r.data.removed;
  }
}
