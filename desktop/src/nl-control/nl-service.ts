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

export interface NlCatalog { revision: string; apps: { appId: string; name: string }[] }

export class NlControlService {
  private readonly unregister: () => void;
  constructor(registry: CommandRegistry, private readonly router: CommandRouter, private readonly log: ActivityLog,
    private readonly decider?: NlDecider, private readonly minProbability = 0.6,
    private readonly apps?: () => NlCatalog, private readonly scenes?: () => { id: string; name: string }[]) {
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

  /** The name half of "open X" / "X kholo" style phrases, shared by app and scene matching. */
  private extractName(text: string): string | undefined {
    const t = text.toLowerCase().replace(/[.!,?]+/g, ' ').replace(/\s+/g, ' ').trim();
    const m = /^(?:open|launch|start|kholo|khol do|chalao|chalu karo)\s+(.+)$/i.exec(t)
      ?? /^(.+?)\s+(?:kholo|khol do|kholo na|chalao|chalu karo|chalu kar do)$/i.exec(t);
    const wanted = m?.[1]?.trim();
    return wanted || undefined;
  }

  /** Against the live app catalog: exact name wins, a unique substring wins, several matches ask
   *  which one, none falls through to scenes / the honest unknown. */
  private matchLaunch(wanted: string): { appId: string; name: string; revision: string } | { ambiguous: string[] } | undefined {
    const { revision, apps } = this.apps!();
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    const exact = apps.filter(a => norm(a.name) === wanted);
    const hits = exact.length ? exact : apps.filter(a => norm(a.name).includes(wanted));
    if (hits.length === 1) return { appId: hits[0]!.appId, name: hits[0]!.name, revision };
    if (hits.length > 1) return { ambiguous: hits.slice(0, 4).map(a => a.name) };
    return undefined;
  }

  /** Same matching against the saved launcher scenes; a leading or trailing "scene" word is
   *  stripped so "launch scene movie mode" and "movie mode scene chalu karo" both work. */
  private matchScene(wanted: string): { id: string; name: string } | { ambiguous: string[] } | undefined {
    const w = wanted.replace(/^scene\s+/, '').replace(/\s+scene$/, '').trim();
    if (!w) return undefined;
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    const scenes = this.scenes!();
    const exact = scenes.filter(s => norm(s.name) === w);
    const hits = exact.length ? exact : scenes.filter(s => norm(s.name).includes(w));
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) return { ambiguous: hits.slice(0, 4).map(s => s.name) };
    return undefined;
  }

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
    if (!matched && (this.apps || this.scenes)) {
      const name = this.extractName(text);
      if (name) {
        const launch = this.apps ? this.matchLaunch(name) : undefined;
        if (launch && 'ambiguous' in launch) return { status: 'unclear', hint: `Which one: ${launch.ambiguous.join(', ')}?` };
        if (launch) matched = { intent: { id: 'launcher.launch', command: 'launcher.launch', describe: `Open ${launch.name}`, build: () => undefined }, payload: { appId: launch.appId, catalogRevision: launch.revision } };
        else if (this.scenes) {
          // App names win over scene names; scenes are the fallback for the same phrase.
          const scene = this.matchScene(name);
          if (scene && 'ambiguous' in scene) return { status: 'unclear', hint: `Which scene: ${scene.ambiguous.join(', ')}?` };
          if (scene) matched = { intent: { id: 'launcher.scene.launch', command: 'launcher.scene.launch', describe: `Start the ${scene.name} scene`, build: () => undefined }, payload: { id: scene.id } };
        }
      }
    }
    if (!matched) {
      this.log.record({ severity: 'info', eventType: 'nl.unmatched', outcome: 'rejected' });
      return { status: 'unknown' };
    }
    if ('missing' in matched) return { status: 'unclear', hint: `${matched.intent.describe} - say a number from 0 to 100` };
    // Relative intents ("volume badha do") read the real level first - same gates, same dispatch path -
    // then send the absolute value; a failed read fails the whole phrase honestly.
    if (typeof (matched.payload as { delta?: unknown }).delta === 'number') {
      const getCommand = matched.intent.command.replace(/\.set$/, '.get');
      const current = await this.router.dispatchAuthorized(
        { version: 1, type: getCommand, requestId: randomUUID(), payload: {} }, session, connection);
      if (!current.payload.ok) return { status: 'rejected', command: getCommand, error: current.payload.error.code };
      const level = (current.payload.result as { level?: unknown }).level;
      if (typeof level !== 'number') return { status: 'rejected', command: getCommand, error: 'COMMAND_FAILED' };
      const delta = (matched.payload as { delta: number }).delta;
      matched = { ...matched, payload: { level: Math.max(0, Math.min(100, level + delta)) } };
    }
    const inner = await this.router.dispatchAuthorized(
      { version: 1, type: matched.intent.command, requestId: randomUUID(), payload: matched.payload }, session, connection);
    return inner.payload.ok
      ? { status: 'executed', command: matched.intent.command, result: inner.payload.result as JsonValue }
      : { status: 'rejected', command: matched.intent.command, error: inner.payload.error.code };
  }
}
