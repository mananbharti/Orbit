/** Local graph memory: entities, typed relations and short facts with sources, kept in one private file; depends on node:fs; never calls a network or model, and only stores what the caller explicitly remembers. */
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { atomicWrite } from '../security-pairing/atomic-file.js';

export const MAX_ENTITIES = 5_000;
export const MAX_FACTS_PER_ENTITY = 50;
const name = z.string().trim().min(1).max(80);
const kind = z.string().trim().min(1).max(24).regex(/^[a-z][a-z0-9_-]*$/);
const factText = z.string().trim().min(1).max(280);
export const entitySchema = z.strictObject({ id: z.string().uuid(), name, kind, aliases: z.array(name).max(8),
  facts: z.array(z.strictObject({ text: factText, at: z.number().int().min(0), source: z.string().max(40).optional() })).max(MAX_FACTS_PER_ENTITY),
  createdAt: z.number().int().min(0), updatedAt: z.number().int().min(0) });
export const relationSchema = z.strictObject({ from: z.string().uuid(), to: z.string().uuid(), type: kind, at: z.number().int().min(0) });
const fileSchema = z.strictObject({ version: z.literal(1), entities: z.array(entitySchema).max(MAX_ENTITIES), relations: z.array(relationSchema).max(MAX_ENTITIES * 8) });
export type Entity = z.infer<typeof entitySchema>;
export type Relation = z.infer<typeof relationSchema>;

export class MemoryLimit extends Error { constructor() { super('MEMORY_LIMIT'); } }
const norm = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const tokens = (s: string): string[] => norm(s).split(/[^\p{L}\p{N}]+/u).filter(t => t.length > 1);

export class GraphStore {
  private entities = new Map<string, Entity>();
  private relations: Relation[] = [];
  constructor(private readonly path: string, private readonly now: () => number = Date.now) {
    if (!existsSync(path)) return;
    let data: z.infer<typeof fileSchema>;
    try { data = fileSchema.parse(JSON.parse(readFileSync(path, 'utf8'))); }
    catch {
      // One unreadable memory file must never take the whole desktop down: set it aside intact and start fresh.
      try { renameSync(path, `${path}.corrupt-${this.now()}`); } catch { /* no matter; the store still starts empty */ }
      return;
    }
    for (const e of data.entities) this.entities.set(e.id, e);
    const ids = new Set(this.entities.keys());
    this.relations = data.relations.filter(r => ids.has(r.from) && ids.has(r.to));
  }

  /** Finds an entity by exact name or alias (case-insensitive) or creates it. */
  remember(entityName: string, entityKind = 'thing'): Entity {
    const n = name.parse(entityName); const k = kind.parse(entityKind);
    const found = this.find(n);
    if (found) return found;
    if (this.entities.size >= MAX_ENTITIES) throw new MemoryLimit();
    const at = this.now();
    const entity: Entity = { id: randomUUID(), name: n, kind: k, aliases: [], facts: [], createdAt: at, updatedAt: at };
    this.entities.set(entity.id, entity); this.save();
    return entity;
  }
  find(entityName: string): Entity | undefined {
    const n = norm(entityName);
    return [...this.entities.values()].find(e => norm(e.name) === n || e.aliases.some(a => norm(a) === n));
  }
  alias(id: string, alias: string): void {
    const e = this.get(id); const a = name.parse(alias);
    if (norm(a) === norm(e.name) || e.aliases.some(x => norm(x) === norm(a))) return;
    const clash = this.find(a);
    if (clash && clash.id !== id) throw new Error('ALIAS_IN_USE');
    if (e.aliases.length >= 8) throw new MemoryLimit();
    e.aliases.push(a); e.updatedAt = this.now(); this.save();
  }
  addFact(id: string, text: string, source?: string): void {
    const e = this.get(id); const t = factText.parse(text);
    if (e.facts.some(f => norm(f.text) === norm(t))) return;
    if (e.facts.length >= MAX_FACTS_PER_ENTITY) e.facts.shift(); // oldest fact makes room
    e.facts.push({ text: t, at: this.now(), ...(source ? { source: source.slice(0, 40) } : {}) });
    e.updatedAt = this.now(); this.save();
  }
  relate(fromId: string, toId: string, type: string): void {
    this.get(fromId); this.get(toId);
    const t = kind.parse(type);
    if (fromId === toId || this.relations.some(r => r.from === fromId && r.to === toId && r.type === t)) return;
    this.relations.push({ from: fromId, to: toId, type: t, at: this.now() }); this.save();
  }
  /** Removes an entity, its facts and every relation to it. */
  forget(id: string): boolean {
    if (!this.entities.delete(id)) return false;
    this.relations = this.relations.filter(r => r.from !== id && r.to !== id);
    this.save(); return true;
  }

  /** Ranks entities against the query (name, alias, fact words), then adds direct neighbours at lower weight. Returns at most `limit`. */
  recall(query: string, limit = 5): { entity: Entity; score: number; via?: string }[] {
    const q = tokens(query);
    if (!q.length) return [];
    const scores = new Map<string, number>();
    for (const e of this.entities.values()) {
      const nameWords = new Set([...tokens(e.name), ...e.aliases.flatMap(tokens)]);
      const factWords = new Set(e.facts.flatMap(f => tokens(f.text)));
      let s = 0;
      for (const w of q) { if (nameWords.has(w)) s += 3; else if (factWords.has(w)) s += 1; }
      if (norm(query).includes(norm(e.name))) s += 2;
      if (s > 0) scores.set(e.id, s);
    }
    const out = new Map<string, { entity: Entity; score: number; via?: string }>();
    for (const [id, score] of scores) out.set(id, { entity: this.get(id), score });
    for (const [id, score] of scores) {
      for (const r of this.relations) {
        const other = r.from === id ? r.to : r.to === id ? r.from : undefined;
        if (!other || scores.has(other)) continue;
        const have = out.get(other);
        const s = score * 0.4;
        if (!have || have.score < s) out.set(other, { entity: this.get(other), score: s, via: `${r.type} ${this.get(id).name}` });
      }
    }
    return [...out.values()].sort((a, b) => b.score - a.score || b.entity.updatedAt - a.entity.updatedAt).slice(0, Math.max(1, Math.min(limit, 20)));
  }
  size(): number { return this.entities.size; }
  private get(id: string): Entity { const e = this.entities.get(id); if (!e) throw new Error('NOT_FOUND'); return e; }
  private save(): void {
    atomicWrite(this.path, JSON.stringify({ version: 1, entities: [...this.entities.values()], relations: this.relations }));
  }
}
