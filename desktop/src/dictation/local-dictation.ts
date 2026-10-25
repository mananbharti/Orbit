/** Desktop dictation toggle state machine: an explicit shortcut (press to start, press again or the cap to stop - never an always-on listener) records one clip and transcribes it with the local engine. The transcript is NEVER typed automatically: it always lands on the preview surface with the captured focus target attached, and the user decides per use whether to copy it or confirm typing into that verified window. cancel() drops a recording in progress (shortcut disabled, app quitting). Depends on injected capture/transcribe so every transition is testable without hardware. */
import type { FocusHandle, FocusProbe } from './local-insert.js';

export interface LocalDictationDeps {
  probe?: FocusProbe;
  transcribe: (pcm: Int16Array) => Promise<string | undefined>; // undefined = no speech / failure
  onPreview: (text: string, target?: FocusHandle) => void; // the only exit for transcript text
  onState?: (state: LocalDictationState) => void;
  // A finished recording that produced no transcript still needs an answer: silence and engine
  // failure look identical to a broken shortcut without one. Never fired for a cancel.
  onEmpty?: (reason: 'no-speech' | 'error') => void;
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
    let failed = false;
    const text = await this.deps.transcribe(pcm).catch(() => { failed = true; return undefined; });
    pcm.fill(0);
    if (this.cancelled) { this.cancelled = false; this.set('idle'); return 'stopped'; }
    if (!text) { this.set('idle'); this.deps.onEmpty?.(failed ? 'error' : 'no-speech'); return 'stopped'; }
    this.deps.onPreview(text, this.startFocus);
    this.set('idle');
    return 'stopped';
  }

  /** Drops a recording in progress and suppresses the preview from a transcription already running (shortcut disabled or app quitting). Returns true when something was cancelled. */
  cancel(): boolean {
    if (this.state === 'idle') return false;
    this.cancelled = true;
    if (this.state === 'recording') this.set('idle');
    return true;
  }

  get current(): LocalDictationState { return this.state; }
}
