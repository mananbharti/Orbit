/** Fast answers: the user's picked local model answers a task only when BOTH gates pass - the triage kind is
 *  answer-only (research/other) AND the decision model, asked a second stricter question, is confident a
 *  text-only answer fully satisfies the request. Any doubt, any failure, any mixed intent: the agent runs.
 *  A kind label alone is never proof a request needs nothing done. */
import { LayaClient } from '../router/laya-engine.js';
import { LocalLlmClient } from '../router/local-llm.js';
import type { FastModel } from '../agent-config.js';

/** Kinds whose deliverable can be pure text. Coding, files, communication and system never qualify:
 *  they can need tools, side effects or approval no matter how the request is phrased. */
const ANSWERABLE_KINDS = new Set(['research', 'other']);
/** The second gate is stricter than triage (0.5) and asks two questions in one call, because a single yes/no
 *  misjudged real requests both ways on laya-multilingual (measured October 24, 2026): it passed a mixed
 *  'research and book' request and refused plain static questions. Both must say no, confidently. */
const ELIGIBILITY_CONFIDENCE = 0.8;
const ELIGIBILITY_QUESTIONS = {
  act: { instructions: 'Does satisfying this request require doing anything in the real world or on a device: booking, buying, creating, changing, moving, sending, or checking/fetching something?',
    criteria: { yes: 'An action, booking, purchase, creation, change, send, or check/fetch is required', no: 'Only a written reply is needed; nothing has to be done, checked or fetched' } },
  cur: { instructions: 'Does a correct answer need current, live or personal data the model cannot already know: prices today, weather, the user files or accounts?',
    criteria: { yes: 'Current, live, personal or local data is needed for a correct answer', no: 'Static general knowledge or only the text in the request is enough' } },
};

export type FastAnswer = (prompt: string, kind: string, signal: AbortSignal) => Promise<string | undefined>;

export function makeFastAnswer(fastModel: FastModel | undefined, layaUrl?: string, fetchImpl?: typeof fetch): FastAnswer | undefined {
  if (!fastModel) return undefined;
  const llm = new LocalLlmClient(fetchImpl as never);
  const laya = new LayaClient(layaUrl ?? 'http://127.0.0.1:8000', fetchImpl ? { fetchImpl } : {});
  const server = { kind: fastModel.kind, baseUrl: fastModel.baseUrl, models: [fastModel.model] };
  return async (prompt, kind, signal) => {
    if (!ANSWERABLE_KINDS.has(kind)) return undefined;
    let verdicts;
    try { verdicts = await laya.decideMany({ state: prompt.slice(0, 6_000), questions: ELIGIBILITY_QUESTIONS }, signal); }
    catch { return undefined; } // unsure or no decision server: the agent runs
    const eligible = (['act', 'cur'] as const).every(name => verdicts[name]?.choice === 'no' && verdicts[name]!.probability >= ELIGIBILITY_CONFIDENCE);
    if (!eligible) return undefined;
    return llm.answer(server, fastModel.model, prompt, signal);
  };
}
