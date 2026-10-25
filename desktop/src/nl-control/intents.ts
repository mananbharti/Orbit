/** Maps short natural-language phrases (English and romanized Hindi/Hinglish) onto Orbit's existing
 *  command surface. Deliberately conservative: patterns are anchored and a small curated set - an
 *  input that matches nothing is an honest "unknown", never a guess. An optional model decider may
 *  pick an INTENT, but parameters are only ever extracted by these deterministic builders - the
 *  model's text is never executed and never becomes a parameter. */
import type { JsonValue } from '../protocol/messages.js';

export interface NlIntent {
  readonly id: string;
  /** The existing registered command this intent routes to. */
  readonly command: string;
  /** One line the UI can show back. */
  readonly describe: string;
  /** Returns the command payload, 'needs-params' when the intent is clear but a required value is
   *  missing/invalid, or undefined when the text does not match this intent. */
  readonly build: (text: string) => JsonValue | 'needs-params' | undefined;
}

const pct = (raw: string | undefined): number | 'needs-params' => {
  const level = Number(raw);
  return Number.isInteger(level) && level >= 0 && level <= 100 ? level : 'needs-params';
};

const num = (re: RegExp, text: string): number | 'needs-params' | undefined => {
  const m = re.exec(text);
  return m ? pct(m[1]) : undefined;
};

/** Anchored patterns only. Romanized Hindi spellings vary; cover the common ones without guessing. */
export const NL_INTENTS: readonly NlIntent[] = [
  {
    id: 'volume.get', command: 'system.volume.get', describe: 'Report the current volume',
    build: t => (/^(?:(?:what'?s|what is|bata(?:o|o na)|kitna)\s+)?(?:the\s+)?(?:current\s+)?(?:system\s+)?volume(?:\s+(?:kitna|kya)\s+(?:hai|he))?[\s?]*$/i.test(t)
      || /^(?:volume|awa?az)\s+(?:kitna|kitni|kya)\s+(?:hai|he)[\s?]*$/i.test(t)) ? {} : undefined,
  },
  {
    id: 'volume.set', command: 'system.volume.set', describe: 'Set the volume to a percent',
    build: t => {
      const level = num(/^(?:set\s+)?(?:system\s+)?(?:volume|awa?az)\s+(?:(?:ko|to)\s+)?(\d{1,3})\s?%?\s*(?:(?:pe|par|per)\s+)?(?:kar|kardo|kar do|rakh|rakho|set kar|bada do|ghata do)?$/i, t)
        ?? num(/^(\d{1,3})\s?%\s*(?:volume|awa?az)$/i, t);
      return level === undefined ? undefined : level === 'needs-params' ? 'needs-params' : { level };
    },
  },
  {
    id: 'volume.mute', command: 'system.volume.set', describe: 'Mute the volume',
    build: t => (/^(?:mute|volume\s+mute|awa?az\s+band|chup)(?:\s+(?:karo|kar do|kar))?(?:\s+(?:the\s+)?(?:volume|sound))?$/i.test(t)) ? { muted: true } : undefined,
  },
  {
    id: 'volume.unmute', command: 'system.volume.set', describe: 'Unmute the volume',
    build: t => (/^(?:unmute|volume\s+unmute|awa?az\s+(?:on|chalu|wapas))(?:\s+(?:karo|kar do|kar))?(?:\s+(?:the\s+)?(?:volume|sound))?$/i.test(t)) ? { muted: false } : undefined,
  },
  {
    id: 'media.playpause', command: 'system.media.transport', describe: 'Play or pause media',
    build: t => (/^(?:play|pause|play\s?-?pause|rok|chalu|chala|play\s+pause)(?:\s+(?:kar|karo|kar do|de|music|gana|song|it))*$/i.test(t)) ? { action: 'playpause' } : undefined,
  },
  {
    id: 'media.next', command: 'system.media.transport', describe: 'Skip to the next track',
    build: t => (/^(?:next|agla|aage)(?:\s+(?:track|song|gana|karo|kar do|chala|laga|laga do))*$/i.test(t)) ? { action: 'next' } : undefined,
  },
  {
    id: 'media.previous', command: 'system.media.transport', describe: 'Go back to the previous track',
    build: t => (/^(?:previous|prev|pichla|pichhla|peeche|back)(?:\s+(?:track|song|gana|karo|kar do|chala|laga|laga do))*$/i.test(t)) ? { action: 'previous' } : undefined,
  },
  {
    id: 'brightness.set', command: 'system.brightness.set', describe: 'Set screen brightness to a percent',
    build: t => {
      const level = num(/^(?:set\s+)?(?:screen\s+)?brightness\s+(?:to\s+)?(\d{1,3})\s?%?$/i, t)
        ?? num(/^brightness\s+(\d{1,3})\s?%?\s*(?:pe|par|per)\s*(?:kar|kardo|kar do|rakh|rakho)$/i, t);
      return level === undefined ? undefined : level === 'needs-params' ? 'needs-params' : { level };
    },
  },
  {
    id: 'brightness.get', command: 'system.brightness.get', describe: 'Report the current brightness',
    build: t => (/^(?:(?:what'?s|what is|bata(?:o|o na)|kitni)\s+)?(?:the\s+)?(?:current\s+)?(?:screen\s+)?brightness(?:\s+(?:kitni|kya)\s+(?:hai|he))?[\s?]*$/i.test(t)) ? {} : undefined,
  },
  {
    id: 'volume.up', command: 'system.volume.set', describe: 'Turn the volume up',
    // { delta } is a marker: the service reads the real level through the same dispatch path and sends the absolute value.
    build: t => (/^(?:(?:volume|awa?az)\s+)?(?:badha|badhao|bada|badha do|badhao na|up|louder|tez)(?:\s+(?:karo|kar do|kar|volume|awa?az|thoda|thodi))*$/i.test(t)) ? { delta: 10 } : undefined,
  },
  {
    id: 'volume.down', command: 'system.volume.set', describe: 'Turn the volume down',
    build: t => (/^(?:(?:volume|awa?az)\s+)?(?:kam|ghata|ghatao|ghata do|down|quieter|dheere)(?:\s+(?:karo|kar do|kar|volume|awa?az|thoda|thodi))*$/i.test(t)) ? { delta: -10 } : undefined,
  },
  {
    id: 'brightness.up', command: 'system.brightness.set', describe: 'Turn the brightness up',
    build: t => (/^brightness\s+(?:badha|badhao|up|badha do)$/i.test(t) || /^(?:badha|badhao)\s+brightness(?:\s+(?:karo|kar do))?$/i.test(t)) ? { delta: 10 } : undefined,
  },
  {
    id: 'brightness.down', command: 'system.brightness.set', describe: 'Turn the brightness down',
    build: t => (/^brightness\s+(?:kam|ghata|down|kam karo)$/i.test(t) || /^kam\s+brightness(?:\s+(?:karo|kar do))?$/i.test(t)) ? { delta: -10 } : undefined,
  },
];

/** Deterministic match: normalized text (lowercased, collapsed spaces) against the catalog, first hit wins. */
export function matchIntent(text: string): { intent: NlIntent; payload: JsonValue } | { intent: NlIntent; missing: true } | undefined {
  const t = text.toLowerCase().replace(/[.!,]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const intent of NL_INTENTS) {
    const payload = intent.build(t);
    if (payload === 'needs-params') return { intent, missing: true };
    if (payload !== undefined) return { intent, payload };
  }
  return undefined;
}
