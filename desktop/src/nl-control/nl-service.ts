/** Natural-language control: one new command, nl.control, that maps a short typed or dictated
 *  phrase onto Orbit's existing command surface and executes the mapped command through the real
 *  dispatch path - the mapped command faces exactly the same scope checks, sensitive-command
 *  confirmation and activity logging as if the phone had sent it directly. Matching is
 *  deterministic first (curated en + romanized-Hindi patterns); an optional model decider may
 *  pick the INTENT when patterns miss, but parameters are only ever extracted by the
 *  deterministic builders - model output is never executed and never becomes a parameter.
 *  Unknown phrases return an honest "unknown"; nothing is guessed. */
import { randomUUID } from 'node:crypto';
import type { CommandRegistry } from '../command-router/command-registry.js';
import type { CommandRouter } from '../command-router/command-router.js';
import type { CommandConnection } from '../command-router/command-context.js';
import type { ActivityLog } from '../activity-log/activity-log.js';
import type { JsonValue } from '../protocol/messages.js';
import { nlControlSchema, type NlOutcome } from '../protocol/nl-control.js';
import { matchIntent, NL_INTENTS } from './intents.js';

/** Optional intent picker (e.g. a local Laya decision server). Returns one catalog id with a
 *  probability; anything below the service threshold is treated as "unknown". */
export interface NlDecider {
  decide(text: string, criteria: readonly string[]): Promise<{ choice: string; probability: number }>;
}

export class NlControlService {
  private readonly unregister: () => void;
  constructor(registry: CommandRegistry, private readonly router: CommandRouter, private readonly log: ActivityLog,
    private readonly decider?: NlDecider, private readonly minProbability = 0.6) {
    this.unregister = registry.register('nl.control', {
      validate: payload => nlControlSchema.safeParse(payload).success,
      execute: async (payload, context) => {
        if (!context.connection?.isAuthorized()) throw new Error('Connection is not authorized');
        const { text } = nlControlSchema.parse(payload);
        return this.handle(text, context.session, context.connection);
      },
    });
  }

  stop(): void { this.unregister(); }

  private async handle(text: string, session: Parameters<CommandRouter['dispatchAuthorized']>[1],
    connection?: CommandConnection): Promise<NlOutcome & JsonValue> {
    let matched = matchIntent(text);
    if (!matched && this.decider) {
      // Model route: choose an intent only. Parameters still come from the deterministic builder.
      try {
        const ids = NL_INTENTS.map(i => i.id);
        const decision = await this.decider.decide(text, ids);
        if (decision.probability >= this.minProbability && ids.includes(decision.choice)) {
          const intent = NL_INTENTS.find(i => i.id === decision.choice)!;
          const payload = intent.build(text.toLowerCase().replace(/\s+/g, ' ').trim());
          matched = payload === 'needs-params' ? { intent, missing: true } : payload !== undefined ? { intent, payload } : undefined;
        }
      } catch { /* decider unreachable: fall through to unknown */ }
    }
    if (!matched) {
      this.log.record({ severity: 'info', eventType: 'nl.unmatched', outcome: 'rejected' });
      return { status: 'unknown' };
    }
    if ('missing' in matched) return { status: 'unclear', hint: `${matched.intent.describe} - say a number from 0 to 100` };
    const inner = await this.router.dispatchAuthorized(
      { version: 1, type: matched.intent.command, requestId: randomUUID(), payload: matched.payload }, session, connection);
    return inner.payload.ok
      ? { status: 'executed', command: matched.intent.command, result: inner.payload.result as JsonValue }
      : { status: 'rejected', command: matched.intent.command, error: inner.payload.error.code };
  }
}
