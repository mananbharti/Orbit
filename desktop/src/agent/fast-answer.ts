/** Fast answers: the user's picked local model answers a task only when BOTH gates pass - the triage kind is
 *  answer-only (research/other) AND the decision model, asked a second stricter question, is confident a
 *  text-only answer fully satisfies the request. Any doubt, any failure, any mixed intent: the agent runs.
 *  A kind label alone is never proof a request needs nothing done. */
import { LayaClient, layaEngine } from '../router/laya-engine.js';
import { LocalLlmClient } from '../router/local-llm.js';
import { Router } from '../router/router.js';
import type { FastModel } from '../agent-config.js';

/** Kinds whose deliverable can be pure text. Coding, files, communication and system never qualify:
 *  they can need tools, side effects or approval no matter how the request is phrased. */
const ANSWERABLE_KINDS = new Set(['research', 'other']);
/** The second gate is stricter than triage (0.5): answering when unsure silently fails the requested work. */
const ELIGIBILITY_CONFIDENCE = 0.8;
const ELIGIBILITY_CRITERIA = {
  yes: 'A text-only answer fully satisfies the request: explanation, summary, ideas or known knowledge. No actions, no live or current data, no tools, nothing to check or fetch.',
  no: 'Something must be done, booked, created, changed, sent, checked or fetched; current or live data is needed; the request mixes an answer with an action; or unclear.',
};

export type FastAnswer = (prompt: string, kind: string, signal: AbortSignal) => Promise<string | undefined>;

export function makeFastAnswer(fastModel: FastModel | undefined, layaUrl?: string, fetchImpl?: typeof fetch): FastAnswer | undefined {
  if (!fastModel) return undefined;
  const llm = new LocalLlmClient(fetchImpl as never);
  const laya = new LayaClient(layaUrl ?? 'http://127.0.0.1:8000', fetchImpl ? { fetchImpl } : {});
  const gate = new Router([layaEngine(laya, ELIGIBILITY_CONFIDENCE)]);
  const server = { kind: fastModel.kind, baseUrl: fastModel.baseUrl, models: [fastModel.model] };
  return async (prompt, kind, signal) => {
    if (!ANSWERABLE_KINDS.has(kind)) return undefined;
    const input = { state: prompt.slice(0, 6_000), instructions: 'Can a text-only answer fully satisfy this request, with no actions and no current or live data?', criteria: ELIGIBILITY_CRITERIA };
    let verdict: string;
    try { verdict = (await gate.route({ task: 'classify', prompt: JSON.stringify(input), private: true })).text; }
    catch { return undefined; } // unsure, low-confidence or no decision server: the agent runs
    if (verdict !== 'yes') return undefined;
    return llm.answer(server, fastModel.model, prompt, signal);
  };
}
