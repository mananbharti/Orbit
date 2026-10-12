/** Energy-based voice activity detection over 16-bit mono PCM; trims leading and trailing silence and reports whether any speech exists; pure, no I/O. */

export interface VadOptions { sampleRate?: number; frameMs?: number; thresholdRms?: number; padMs?: number; minSpeechMs?: number }

export interface VadResult { speech: boolean; start: number; end: number }

/** Returns sample indices [start, end) covering the speech plus padding. */
export function trimSilence(samples: Int16Array, options: VadOptions = {}): VadResult {
  const rate = options.sampleRate ?? 16_000;
  const frame = Math.max(1, Math.round((rate * (options.frameMs ?? 20)) / 1000));
  const threshold = options.thresholdRms ?? 500;
  const pad = Math.round((rate * (options.padMs ?? 200)) / 1000);
  const minFrames = Math.ceil((options.minSpeechMs ?? 120) / (options.frameMs ?? 20));
  const voiced: boolean[] = [];
  for (let i = 0; i + frame <= samples.length; i += frame) {
    let sum = 0;
    for (let j = i; j < i + frame; j++) sum += samples[j]! * samples[j]!;
    voiced.push(Math.sqrt(sum / frame) >= threshold);
  }
  // A run of voiced frames shorter than minSpeechMs (a click, a cough) is not speech.
  let first = -1, last = -1;
  for (let i = 0; i < voiced.length;) {
    if (!voiced[i]) { i++; continue; }
    let j = i; while (j < voiced.length && voiced[j]) j++;
    if (j - i >= minFrames) { if (first < 0) first = i; last = j; }
    i = j;
  }
  if (first < 0) return { speech: false, start: 0, end: 0 };
  return { speech: true, start: Math.max(0, first * frame - pad), end: Math.min(samples.length, last * frame + pad) };
}
