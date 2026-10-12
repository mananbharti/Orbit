/** Turns one recorded clip into text: trim silence, transcribe locally, clean up; keeps audio only in memory and wipes it afterwards; never touches the network or disk. */
import { cleanTranscript, type CleanupOptions } from './cleanup.js';
import { trimSilence, type VadOptions } from './vad.js';

export const SAMPLE_RATE = 16_000;
export const MAX_CLIP_SECONDS = 120;

/** A local speech-to-text engine (whisper.cpp, faster-whisper...). Implementations must not send audio anywhere off this computer. */
export interface Transcriber {
  transcribe(pcm: Int16Array, options: { language?: string; signal: AbortSignal }): Promise<string>;
}
export type DictationResult = { status: 'text'; text: string } | { status: 'no-speech' };

export class DictationError extends Error {
  constructor(readonly code: 'CLIP_TOO_LONG' | 'ENGINE_FAILED' | 'CANCELLED') { super(code); }
}

export async function dictate(pcm: Int16Array, engine: Transcriber, options: {
  language?: string; vad?: VadOptions; cleanup?: CleanupOptions; signal?: AbortSignal } = {}): Promise<DictationResult> {
  if (pcm.length > SAMPLE_RATE * MAX_CLIP_SECONDS) { pcm.fill(0); throw new DictationError('CLIP_TOO_LONG'); }
  const signal = options.signal ?? new AbortController().signal;
  let trimmed: Int16Array | undefined;
  try {
    const span = trimSilence(pcm, { sampleRate: SAMPLE_RATE, ...options.vad });
    if (!span.speech) return { status: 'no-speech' };
    trimmed = pcm.slice(span.start, span.end);
    if (signal.aborted) throw new DictationError('CANCELLED');
    let raw: string;
    try { raw = await engine.transcribe(trimmed, { ...(options.language ? { language: options.language } : {}), signal }); }
    catch (error) { throw signal.aborted ? new DictationError('CANCELLED') : error instanceof DictationError ? error : new DictationError('ENGINE_FAILED'); }
    const text = cleanTranscript(raw, options.cleanup);
    return text ? { status: 'text', text } : { status: 'no-speech' };
  } finally { pcm.fill(0); trimmed?.fill(0); }
}
