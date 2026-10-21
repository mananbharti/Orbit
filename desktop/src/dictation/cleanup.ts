/** Turns raw speech-to-text into tidy text: removes fillers, applies the personal dictionary, fixes spacing and capitalisation; pure functions, no audio, no model, no storage. */

export interface CleanupOptions {
  /** "wrong heard form" -> "what the user means", matched as whole words, case-insensitive. */
  dictionary?: Readonly<Record<string, string>>;
  removeFillers?: boolean;
}

// Only unambiguous fillers. Words like "like" or "matlab" can be real content, so they are never removed.
const FILLERS = ['um', 'umm', 'uh', 'uhh', 'er', 'erm', 'hmm', 'mm', 'ah'];
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SENTENCE_START = /(^|[.!?।]\s+)(\p{Ll})/gu;

export function cleanTranscript(raw: string, options: CleanupOptions = {}): string {
  let text = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (options.removeFillers !== false) {
    text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}])(?:${FILLERS.join('|')})(?![\\p{L}\\p{N}])[,.]?\\s*`, 'giu'), '');
  }
  // Longest keys first so "open ai" wins over "open".
  const entries = Object.entries(options.dictionary ?? {}).filter(([k]) => k.trim()).sort((a, b) => b[0].length - a[0].length);
  for (const [heard, meant] of entries) {
    text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escape(heard.trim())}(?![\\p{L}\\p{N}])`, 'giu'), () => meant);
  }
  // A comma followed by a digit is never spaced: "1,000" or "3,50,000" must stay one number. Other punctuation gets its space.
  text = text.replace(/\s+([,.!?;:।])/g, '$1').replace(/([;:!?।])(?=[\p{L}\p{N}])/gu, '$1 ').replace(/,(?=\p{L})/gu, ', ')
    .replace(/\s+/g, ' ').trim();
  text = text.replace(SENTENCE_START, (_m, lead: string, ch: string) => lead + ch.toUpperCase());
  return text;
}
