/** Client for local OpenAI-style chat servers (Ollama on :11434, LM Studio on :1234): discovers what is
 *  actually running on this computer and asks one model for one answer; depends on an injected fetch;
 *  never starts a server, never sends anything anywhere but loopback, and never executes anything -
 *  it returns text, and the caller decides what that text is allowed to mean. */
import { MAX_PROMPT } from './router.js';

export interface LocalLlmServer { kind: 'ollama' | 'lmstudio'; baseUrl: string; models: string[] }
export const OLLAMA_URL = 'http://127.0.0.1:11434';
export const LMSTUDIO_URL = 'http://127.0.0.1:1234';
const isLoopback = (h: string): boolean => h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
const checkedBase = (baseUrl: string): string => {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error('bad address'); }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !isLoopback(url.hostname)) throw new Error('local model servers must be on loopback');
  return baseUrl.replace(/\/+$/, '');
};

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class LocalLlmClient {
  constructor(private readonly fetchImpl: Fetch = globalThis.fetch as unknown as Fetch) {}

  /** Probes the two well-known local servers, Ollama first, and reports the first one that answers.
   *  A server that answers with zero models is reported as-is (installed, nothing downloaded yet). */
  async detect(signal?: AbortSignal): Promise<LocalLlmServer | undefined> {
    for (const probe of [
      { kind: 'ollama' as const, baseUrl: OLLAMA_URL, path: '/api/tags', pick: (j: any) => Array.isArray(j?.models) ? j.models.map((m: any) => String(m?.name ?? '')).filter(Boolean) : undefined },
      { kind: 'lmstudio' as const, baseUrl: LMSTUDIO_URL, path: '/v1/models', pick: (j: any) => Array.isArray(j?.data) ? j.data.map((m: any) => String(m?.id ?? '')).filter(Boolean) : undefined },
    ]) {
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 1_500);
        if (signal) { if (signal.aborted) return undefined; signal.addEventListener('abort', () => ac.abort(), { once: true }); }
        try {
          const res = await this.fetchImpl(probe.baseUrl + probe.path, { signal: ac.signal });
          if (!res.ok) continue;
          const models = probe.pick(await res.json());
          if (models) return { kind: probe.kind, baseUrl: probe.baseUrl, models };
        } finally { clearTimeout(timer); }
      } catch { /* not installed / not answering: try the next one */ }
    }
    return undefined;
  }

  /** One question, one answer, no streaming. Throws on any junk shape so a proxy on the port can never
   *  pass for a model. The answer is capped; prompts longer than MAX_PROMPT are refused, not truncated. */
  async answer(server: LocalLlmServer, model: string, prompt: string, signal?: AbortSignal): Promise<string> {
    if (prompt.length > MAX_PROMPT) throw new Error('prompt too long');
    const base = checkedBase(server.baseUrl);
    const messages = [{ role: 'user', content: prompt }];
    const res = await this.fetchImpl(
      server.kind === 'ollama' ? `${base}/api/chat` : `${base}/v1/chat/completions`,
      { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(server.kind === 'ollama' ? { model, messages, stream: false } : { model, messages }), ...(signal ? { signal } : {}) });
    if (!res.ok) throw new Error(`server answered ${res.status}`);
    const body: any = await res.json();
    const text = server.kind === 'ollama' ? body?.message?.content : body?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error('the model returned no answer');
    return text.trim().slice(0, 4_000);
  }
}
