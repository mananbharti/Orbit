/** Natural-language control of the paired desktop: send a short typed phrase ("volume 50", "agla gana")
 *  and the desktop maps it onto its own command surface. The desktop answers honestly: executed,
 *  rejected (with the mapped command's own error, e.g. SCOPE_DENIED), unclear (it understood the
 *  intent but needs a value), or unknown (it did not understand - nothing was done). */
import { z } from 'zod';
import { InvalidDesktopReply } from './agent.js';
import { NotSent, type OrbitSession } from './session.js';

export const NL_MAX_TEXT = 200;
const nlOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('executed'), command: z.string(), result: z.unknown() }),
  z.strictObject({ status: z.literal('rejected'), command: z.string(), error: z.string() }),
  z.strictObject({ status: z.literal('unclear'), hint: z.string() }),
  z.strictObject({ status: z.literal('unknown') }),
]);
export type NlOutcome = z.infer<typeof nlOutcomeSchema>;

export class NlControlApi {
  constructor(private readonly session: OrbitSession) {}
  /** One phrase, one outcome. The phrase is capped client-side at the same 200 chars the desktop enforces. */
  async say(text: string): Promise<NlOutcome> {
    if (this.session.status !== 'connected') throw new NotSent('Not connected');
    if (!text.trim() || text.length > NL_MAX_TEXT) throw new NotSent('Phrase must be 1-200 characters');
    const result: unknown = await this.session.command('nl.control', { text });
    const parsed = nlOutcomeSchema.safeParse(result);
    if (!parsed.success) throw new InvalidDesktopReply();
    return parsed.data;
  }
}
