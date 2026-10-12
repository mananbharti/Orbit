/** Engine-agnostic model router: picks a local engine first and falls back to a cloud tier only when policy allows; depends on caller-supplied engines; never ships an engine, key or network client itself. */
import { z } from 'zod';

export const MAX_PROMPT = 8_000;
export const routeRequestSchema = z.strictObject({
  task: z.enum(['classify', 'summarize', 'plan', 'cleanup']),
  prompt: z.string().min(1).max(MAX_PROMPT),
  /** Data marked private is never sent to a cloud engine. */
  private: z.boolean().default(true),
});
export type RouteRequest = z.input<typeof routeRequestSchema>;
export interface Engine { readonly id: string; readonly tier: 'local' | 'cloud'; readonly tasks: readonly RouteRequest['task'][]; run(prompt: string, signal: AbortSignal): Promise<string>; }
export interface RouteResult { engine: string; tier: 'local' | 'cloud'; text: string; attempts: { engine: string; error: string }[]; }
export class RouteError extends Error { constructor(readonly code: 'NO_ENGINE' | 'ALL_FAILED' | 'CLOUD_BLOCKED', readonly attempts: { engine: string; error: string }[] = []) { super(code); } }

export class Router {
  constructor(private readonly engines: Engine[], private readonly opts: { allowCloud: boolean; timeoutMs?: number } = { allowCloud: false }) {}

  async route(input: RouteRequest): Promise<RouteResult> {
    const req = routeRequestSchema.parse(input);
    const capable = this.engines.filter(e => e.tasks.includes(req.task));
    const usable = capable.filter(e => e.tier === 'local' || (this.opts.allowCloud && !req.private))
      .sort((a, b) => (a.tier === b.tier ? 0 : a.tier === 'local' ? -1 : 1));
    if (!usable.length) throw new RouteError(capable.length ? 'CLOUD_BLOCKED' : 'NO_ENGINE');
    const attempts: { engine: string; error: string }[] = [];
    for (const e of usable) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.opts.timeoutMs ?? 30_000);
      try {
        const text = await Promise.race([e.run(req.prompt, ac.signal), new Promise<never>((_, rej) => ac.signal.addEventListener('abort', () => rej(new Error('TIMEOUT'))))]);
        return { engine: e.id, tier: e.tier, text, attempts };
      } catch (err) { attempts.push({ engine: e.id, error: err instanceof Error ? err.message.slice(0, 80) : 'ERROR' }); }
      finally { clearTimeout(timer); }
    }
    throw new RouteError('ALL_FAILED', attempts);
  }
}
