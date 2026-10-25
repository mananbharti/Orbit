/** Adapts a local Laya decision server into an NL intent decider: the model picks ONE intent id
 *  from the catalog (with the server's own probability); parameters are never taken from it.
 *  Loopback-only via LayaClient; any server/parse failure throws and the caller answers unknown. */
import { LayaClient } from '../router/laya-engine.js';
import type { NlDecider } from './nl-service.js';
import { NL_INTENTS } from './intents.js';

export class LayaNlDecider implements NlDecider {
  private readonly client: LayaClient;
  constructor(layaUrl = 'http://127.0.0.1:8000') { this.client = new LayaClient(layaUrl, { minProbability: 0 }); }
  async decide(text: string, criteria: readonly string[]): Promise<{ choice: string; probability: number }> {
    const d = await this.client.decide({
      state: `The phone's owner said: "${text.slice(0, 200)}". Which single computer-control intent does this ask for?`,
      instructions: 'Pick the one intent the phrase is asking for, or none if it asks for something else entirely.',
      criteria: Object.fromEntries(criteria.map(id => [id, NL_INTENTS.find(i => i.id === id)?.describe ?? null])),
    });
    return { choice: d.choice, probability: d.probability };
  }
}
