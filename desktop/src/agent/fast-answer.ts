/** Answer-only tasks: asks the user's picked local model for a text answer. No eligibility classifier:
 *  the person explicitly chooses answer-only per request on their phone, so intent never depends on a
 *  model's judgment (the laya-multilingual eligibility evaluation on October 24, 2026 was confidently
 *  wrong on mixed-intent requests in both directions; the evidence lives in docs/laya.md). */
import { LocalLlmClient } from '../router/local-llm.js';
import type { FastModel } from '../agent-config.js';

export type FastAnswer = (prompt: string, signal: AbortSignal) => Promise<string | undefined>;

export function makeFastAnswer(fastModel: FastModel | undefined, fetchImpl?: typeof fetch): FastAnswer | undefined {
  if (!fastModel) return undefined;
  const llm = new LocalLlmClient(fetchImpl as never);
  const server = { kind: fastModel.kind, baseUrl: fastModel.baseUrl, models: [fastModel.model] };
  return (prompt, signal) => llm.answer(server, fastModel.model, prompt, signal);
}
