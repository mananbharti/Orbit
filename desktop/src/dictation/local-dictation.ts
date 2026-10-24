/** Desktop push-to-talk state machine: an explicit toggle (press to start, press again or the cap to stop - never an always-on listener) records one clip, transcribes it with the local engine, and lands the text only where focus identity still matches; otherwise it goes to the preview surface. Depends on injected capture/transcribe/insert so every transition is testable without hardware. */
import type { FocusHandle, FocusProbe } from './local-insert.js';
import { decideInsertion } from './local-insert.js';

export interface LocalDictationDeps {
  probe?: FocusProbe;
  transcribe: (pcm: Int16Array) => Promise<string | undefined>; // undefined = no speech / failure
  typeText: (text: string) => Promise<void>;
  onPreview: (text: string, reason: 'focus-changed' | 'focus-unknown') => void;
  onState?: (state: LocalDictationState) => void;
}
export type LocalDictationState = 'idle' | 'recording' | 'working';

export class LocalDictation {
  private state: LocalDictationState = 'idle';
  private startFocus?: FocusHandle;
  constructor(private readonly deps: LocalDictationDeps) {}

  private set(state: LocalDictationState): void { this.state = state; this.deps.onState?.(state); }

  /** The toggle handler bound to the user's shortcut. Returns what happened so the shell can mirror it in the tray. */
  async toggle(capture: () => Promise<Int16Array | undefined>): Promise<'started' | 'stopped' | 'ignored'> {
    if (this.state === 'working') return 'ignored';
    if (this.state === 'idle') {
      this.startFocus = await this.deps.probe?.current();
      this.set('recording');
      return 'started';
    }
    this.set('working');
    const pcm = await capture();
    if (!pcm || pcm.length === 0) { this.set('idle'); return 'stopped'; }
    const text = await this.deps.transcribe(pcm).catch(() => undefined);
    pcm.fill(0);
    if (!text) { this.set('idle'); return 'stopped'; }
    const endFocus = await this.deps.probe?.current();
    const decision = decideInsertion(this.startFocus, endFocus);
    if (decision.action === 'type') await this.deps.typeText(text);
    else this.deps.onPreview(text, decision.reason);
    this.set('idle');
    return 'stopped';
  }

  get current(): LocalDictationState { return this.state; }
}
