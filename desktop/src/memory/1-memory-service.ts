/** Registers memory.* commands over the graph store: remember, recall, forget; depends on GraphStore; never reads files, the network or other features. */
import type { CommandRegistry } from '../command-router/command-registry.js';
import type { CommandContext } from '../command-router/command-context.js';
import type { ActivityLog } from '../activity-log/activity-log.js';
import type { JsonValue } from '../protocol/messages.js';
import { ProtocolError } from '../protocol/errors.js';
import { z } from 'zod';
import { GraphStore, MemoryLimit } from './graph-store.js';

const remember = z.strictObject({ name: z.string().max(80), kind: z.string().max(24).optional(), fact: z.string().max(280).optional(),
  alias: z.string().max(80).optional(), relatedTo: z.string().max(80).optional(), relation: z.string().max(24).optional() });
const recall = z.strictObject({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(20).optional() });
const forget = z.strictObject({ id: z.string().uuid() });

export class MemoryService {
  private readonly unregister: (() => void)[];
  constructor(registry: CommandRegistry, private readonly store: GraphStore, private readonly log: ActivityLog) {
    const authed = (c: CommandContext): void => { if (!c.connection?.isAuthorized()) throw new ProtocolError('UNAUTHENTICATED'); };
    const guard = <T>(fn: () => T): T => {
      try { return fn(); } catch (e) {
        if (e instanceof ProtocolError) throw e;
        if (e instanceof MemoryLimit) throw new ProtocolError('COMMAND_FAILED');
        throw new ProtocolError('INVALID_PAYLOAD');
      }
    };
    this.unregister = [
      registry.register('memory.remember', { validate: p => remember.safeParse(p).success, execute: async (p, c): Promise<JsonValue> => {
        authed(c); const v = remember.parse(p);
        return guard(() => {
          const e = this.store.remember(v.name, v.kind);
          if (v.fact) this.store.addFact(e.id, v.fact, 'phone');
          if (v.alias) this.store.alias(e.id, v.alias);
          if (v.relatedTo) this.store.relate(e.id, this.store.remember(v.relatedTo).id, v.relation ?? 'related-to');
          this.log.record({ severity: 'info', eventType: 'memory.remembered', outcome: 'success' });
          return { id: e.id };
        });
      } }),
      registry.register('memory.recall', { validate: p => recall.safeParse(p).success, execute: async (p, c): Promise<JsonValue> => {
        authed(c); const v = recall.parse(p);
        return { results: this.store.recall(v.query, v.limit).map(r => ({ id: r.entity.id, name: r.entity.name, kind: r.entity.kind,
          facts: r.entity.facts.map(f => f.text), ...(r.via ? { via: r.via } : {}) })) };
      } }),
      registry.register('memory.forget', { validate: p => forget.safeParse(p).success, execute: async (p, c): Promise<JsonValue> => {
        authed(c);
        const removed = this.store.forget(forget.parse(p).id);
        this.log.record({ severity: 'info', eventType: 'memory.forgotten', outcome: removed ? 'success' : 'failed' });
        return { removed };
      } }),
    ];
  }
  stop(): void { for (const u of this.unregister) u(); }
}
