/** Desktop push-to-talk state machine: an explicit toggle (press to start, press again or the cap to stop - never an always-on listener) records one clip, transcribes it with the local engine, and lands the text only where focus identity still matches, chunk by chunk; otherwise it goes to the preview surface. cancel() drops a recording in progress (shortcut disabled, app quitting) and skips any pending insertion. Depends on injected capture/transcribe/insert so every transition is testable without hardware. */
import type { FocusHandle, FocusProbe } from './local-insert.js';
import { decideInsertion, typeVerified } from './local-insert.js';

export type PreviewReason = 'focus-changed' | 'focus-unknown' | 'focus-changed-mid-type';
export interface LocalDictationDeps {
  probe?: FocusProbe;
  transcribe: (pcm: Int16Array) => Promise<string | undefined>; // undefined = no speech / failure
  typeChunk: (chunk: string) => Promise<void>; // types one chunk into the currently focused window
  onPreview: (text: string, reason: PreviewReason) => void;
  onState?: (state: LocalDictationState) => void;
}
export type LocalDictationState = 'idle' | 'recording' | 'working';

export class LocalDictation {
  private state: LocalDictationState = 'idle';
  private startFocus?: FocusHandle;
  private cancelled = false;
  constructor(private readonly deps: LocalDictationDeps) {}

  private set(state: LocalDictationState): void { this.state = state; this.deps.onState?.(state); }

  /** The toggle handler bound to the user's shortcut. Returns what happened so the shell can mirror it in the tray. */
  async toggle(capture: () => Promise<Int16Array | undefined>): Promise<'started' | 'stopped' | 'ignored'> {
    if (this.state === 'working') return 'ignored';
    if (this.state === 'idle') {
      this.cancelled = false;
      this.startFocus = await this.deps.probe?.current();
      this.set('recording');
      return 'started';
    }
    this.set('working');
    const pcm = await capture();
    if (!pcm || pcm.length === 0) { this.set('idle'); return 'stopped'; }
    const text = await this.deps.transcribe(pcm).catch(() => undefined);
    pcm.fill(0);
    if (!text || this.cancelled) { this.cancelled = false; this.set('idle'); return 'stopped'; }
    const endFocus = await this.deps.probe?.current();
    const decision = decideInsertion(this.startFocus, endFocus);
    if (decision.action === 'type' && this.startFocus && this.deps.probe) {
      const outcome = await typeVerified(text, this.startFocus, this.deps.probe, this.deps.typeChunk);
      if (outcome.action === 'aborted') this.deps.onPreview(outcome.remaining, 'focus-changed-mid-type');
      else if (outcome.action === 'preview') this.deps.onPreview(text, outcome.reason);
    } else if (decision.action === 'preview') this.deps.onPreview(text, decision.reason);
    this.set('idle');
    return 'stopped';
  }

  /** Drops a recording in progress and suppresses any insertion from a transcription already running (shortcut disabled or app quitting). Returns true when something was cancelled. */
  cancel(): boolean {
    if (this.state === 'idle') return false;
    this.cancelled = true;
    if (this.state === 'recording') this.set('idle');
    return true;
  }

  get current(): LocalDictationState { return this.state; }
}
