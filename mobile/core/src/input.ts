/** Phone side of remote mouse and keyboard: one confirmed session, batched events, steady heartbeat; depends on OrbitSession; never starts without the computer owner's confirmation. */
import { InvalidDesktopReply } from './agent.js';
import { MAX_INPUT_EVENTS, MAX_POINTER_STEP, MAX_TEXT_CHARS, inputBeginSchema, inputSentSchema, keyboardMacrosSchema, type InputEvent, type KeyboardMacro, type MacroStep } from './protocol.js';
import { CommandError, NotSent, type OrbitSession } from './session.js';

export type InputStatus = 'idle' | 'waiting' | 'active' | 'ended';
export interface InputState { status: InputStatus; error?: string }

const clampStep = (n: number): number => Number.isNaN(n) ? 0 : Math.max(-MAX_POINTER_STEP, Math.min(MAX_POINTER_STEP, Math.round(n)));

export class InputApi {
  private state: InputState = { status: 'idle' };
  private listeners = new Set<() => void>();
  private lease?: { id: string; sequence: number; heartbeatMs: number };
  private timer?: ReturnType<typeof setInterval>;
  private queue: InputEvent[] = [];
  private flushing?: Promise<void>;
  private offStatus: () => void;
  /** Bumped when a pending begin is abandoned, so its late reply is released instead of activating. */
  private epoch = 0;

  constructor(private readonly session: OrbitSession) {
    this.offStatus = session.onStatus(() => { if (this.lease) this.finish('ended', 'Connection lost'); });
  }
  getState = (): InputState => this.state;
  subscribe = (l: () => void): (() => void) => { this.listeners.add(l); return () => this.listeners.delete(l); };
  dispose(): void { this.epoch++; this.offStatus(); this.stopTimer(); this.listeners.clear(); }

  /** Asks the computer for control. Resolves once its owner confirmed; rejects with BIOMETRIC_REQUIRED if they did not. */
  async begin(): Promise<void> {
    if (this.lease || this.state.status === 'waiting') throw new NotSent('Already controlling');
    this.set({ status: 'waiting' });
    const epoch = ++this.epoch;
    try {
      const parsed = inputBeginSchema.safeParse(await this.session.command('input.begin', {}, { timeoutMs: 60_000 }));
      if (!parsed.success) throw new InvalidDesktopReply();
      if (epoch !== this.epoch) {
        // The user left while waiting for the owner: release the session that was just approved.
        void this.session.command('input.end', { controlSessionId: parsed.data.controlSessionId }).catch(() => {});
        throw new NotSent('Control cancelled');
      }
      this.lease = { id: parsed.data.controlSessionId, sequence: parsed.data.nextSequence, heartbeatMs: parsed.data.heartbeatTimeoutMs };
      this.timer = setInterval(() => { void this.beat(); }, Math.max(250, Math.floor(parsed.data.heartbeatTimeoutMs / 3)));
      this.set({ status: 'active' });
    } catch (error) {
      if (epoch === this.epoch) this.set({ status: 'idle', error: error instanceof CommandError ? error.code : 'Could not start' });
      throw error;
    }
  }
  /** Queues events; they are sent in order in batches. Pointer movement queued together is merged. */
  push(event: InputEvent): void {
    if (!this.lease) throw new NotSent('Not controlling the computer');
    const normalised: InputEvent = event.t === 'move' || event.t === 'scroll' ? { ...event, dx: clampStep(event.dx), dy: clampStep(event.dy) }
      : event.t === 'text' ? { ...event, text: event.text.slice(0, MAX_TEXT_CHARS) } : event;
    const last = this.queue[this.queue.length - 1];
    if (last && (normalised.t === 'move' || normalised.t === 'scroll') && last.t === normalised.t
      && Math.abs(last.dx + normalised.dx) <= MAX_POINTER_STEP && Math.abs(last.dy + normalised.dy) <= MAX_POINTER_STEP) {
      last.dx += normalised.dx; last.dy += normalised.dy;
    } else this.queue.push(normalised);
    void this.flush();
  }
    /** Saved keyboard macros, as stored on the desktop. */
  async macros(): Promise<KeyboardMacro[]> {
    const parsed = keyboardMacrosSchema.safeParse(await this.session.command('input.macros', {}, { timeoutMs: 20_000 }));
    if (!parsed.success) throw new InvalidDesktopReply();
    return parsed.data.macros;
  }
  /** Creates a macro (no id) or replaces it. */
  async saveMacro(name: string, steps: MacroStep[], id?: string): Promise<KeyboardMacro[]> {
    const parsed = keyboardMacrosSchema.safeParse(await this.session.command('input.macro.save', { name, steps, ...(id ? { id } : {}) }, { timeoutMs: 20_000 }));
    if (!parsed.success) throw new InvalidDesktopReply();
    return parsed.data.macros;
  }
  async deleteMacro(id: string): Promise<KeyboardMacro[]> {
    const parsed = keyboardMacrosSchema.safeParse(await this.session.command('input.macro.delete', { id }, { timeoutMs: 20_000 }));
    if (!parsed.success) throw new InvalidDesktopReply();
    return parsed.data.macros;
  }
  /** Runs a macro inside the current control session: every chord goes out as one batch, in order. */
  runMacro(macro: KeyboardMacro): Promise<void> {
    if (!this.lease) throw new NotSent('Not controlling the computer');
    for (const step of macro.steps) this.queue.push({ t: 'key', key: step.key, ...(step.modifiers?.length ? { modifiers: [...step.modifiers] } : {}) });
    return this.flush();
  }

  /** Resolves when everything queued so far has been applied (or the session failed). */
  flush(): Promise<void> {
    this.flushing ??= (async () => {
      try {
        while (this.lease && this.queue.length) {
          const lease = this.lease;
          const events = this.queue.splice(0, MAX_INPUT_EVENTS);
          const parsed = inputSentSchema.safeParse(await this.session.command('input.send', { controlSessionId: lease.id, sequence: lease.sequence, events: events as never }));
          if (!parsed.success) throw new InvalidDesktopReply();
          lease.sequence = parsed.data.nextSequence;
        }
      } catch (error) {
        // The computer consumes a sequence number before acting, so a failed batch must never be replayed.
        this.finish('ended', error instanceof CommandError ? error.code : 'Connection lost');
      } finally { this.flushing = undefined; }
    })();
    return this.flushing;
  }
  async end(): Promise<void> {
    const lease = this.lease;
    if (!lease) {
      if (this.state.status === 'waiting') { this.epoch++; this.set({ status: 'idle' }); }
      return;
    }
    this.queue = [];
    this.finish('ended');
    try { await this.session.command('input.end', { controlSessionId: lease.id }); } catch { /* the computer releases on disconnect or heartbeat timeout */ }
  }

  private async beat(): Promise<void> {
    const lease = this.lease;
    if (!lease) return;
    try { await this.session.command('input.keepalive', { controlSessionId: lease.id }); }
    catch (error) { if (this.lease === lease) this.finish('ended', error instanceof CommandError ? error.code : 'Connection lost'); }
  }
  private stopTimer(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  private finish(status: InputStatus, error?: string): void { this.lease = undefined; this.queue = []; this.stopTimer(); this.set({ status, ...(error ? { error } : {}) }); }
  private set(next: InputState): void { this.state = next; for (const l of [...this.listeners]) l(); }
}
