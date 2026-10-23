/** Adapter for a local Laya server (POST /v1/systemone): one decision per call, classify only; depends on an injected fetch; never starts the server and refuses non-loopback URLs. */
import { z } from 'zod';
import type { Engine } from './router.js';

const MAX_BODY = 256 * 1024;
const answerSchema = z.object({ type: z.literal('choice'), choice: z.string().min(1).max(80), probabilities: z.record(z.string(), z.number()),
  answer_confidence: z.number().min(0).max(1).optional(), confidence: z.number().optional() });
const responseSchema = z.object({ answers: z.record(z.string(), answerSchema) });
export const decisionInput = z.strictObject({ state: z.string().min(1).max(6_000), instructions: z.string().min(1).max(400),
  criteria: z.record(z.string().min(1).max(40), z.string().min(1).max(200).nullable()).refine(c => { const n = Object.keys(c).length; return n >= 2 && n <= 20; }) });
export interface Decision { choice: string; probability: number; probabilities: Record<string, number>; }
export class LayaError extends Error { constructor(readonly code: 'BAD_URL' | 'HTTP' | 'BAD_RESPONSE' | 'UNKNOWN_CHOICE') { super(code); } }

const isLoopback = (h: string): boolean => h === 'localhost' || h === '127.0.0.1' || h === '[::1]';

export class LayaClient {
  private readonly url: URL;
  constructor(baseUrl: string, private readonly opts: { apiKey?: string; model?: string; fetchImpl?: typeof fetch; minProbability?: number } = {}) {
    const u = new URL(baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new LayaError('BAD_URL');
    if (!isLoopback(u.hostname)) throw new LayaError('BAD_URL'); // an unauthenticated LAN decision server is not allowed
    this.url = u;
  }
  async decide(input: z.input<typeof decisionInput>, signal?: AbortSignal): Promise<Decision> {
    const q = decisionInput.parse(input);
    const res = await (this.opts.fetchImpl ?? fetch)(new URL('/v1/systemone', this.url), { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}) },
      // Wire contract per nvkudva/laya-server and api.typesafe.ai v0.2.0: model is required.
      body: JSON.stringify({ state: q.state, model: this.opts.model ?? 'laya', questions: { q: { type: 'choice', instructions: q.instructions, criteria: q.criteria } } }), ...(signal ? { signal } : {}) });
    if (!res.ok) throw new LayaError('HTTP');
    const text = await res.text();
    if (text.length > MAX_BODY) throw new LayaError('BAD_RESPONSE');
    let parsed; try { parsed = responseSchema.safeParse(JSON.parse(text)); } catch { throw new LayaError('BAD_RESPONSE'); }
    const a = parsed.success ? parsed.data.answers['q'] : undefined;
    if (!a) throw new LayaError('BAD_RESPONSE');
    if (!(a.choice in q.criteria)) throw new LayaError('UNKNOWN_CHOICE');
    const probability = a.answer_confidence ?? a.probabilities[a.choice] ?? 0;
    return { choice: a.choice, probability, probabilities: a.probabilities };
  }
  async healthy(signal?: AbortSignal): Promise<boolean> {
    // The Jev wire contract has no /health; the models list is the cheap readiness probe. The body must actually
    // name the model we will call, so an unrelated server on the port is never treated as a decision engine.
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(new URL('/v1/models', this.url), { redirect: 'error', ...(signal ? { signal } : {}) });
      if (!res.ok) return false;
      const text = await res.text();
      if (text.length > MAX_BODY) return false;
      return text.toLowerCase().includes((this.opts.model ?? 'laya').toLowerCase());
    } catch { return false; }
  }
}

/** Router engine: the prompt is the JSON of a decision input; the result is the chosen key. Laya decides, it does not write text, so only 'classify' is supported. */
export function layaEngine(client: LayaClient, minProbability = 0): Engine {
  return { id: 'laya', tier: 'local', tasks: ['classify'], async run(prompt, signal) {
    let input: unknown; try { input = JSON.parse(prompt); } catch { throw new LayaError('BAD_RESPONSE'); }
    const d = await client.decide(input as never, signal);
    if (d.probability < minProbability) throw new Error('LOW_CONFIDENCE');
    return d.choice;
  } };
}
