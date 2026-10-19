/** Runs commands on the computer inside an approved session; depends on OrbitSession and Zod; output arrives as events between exec start and its reply. */
import { InvalidDesktopReply } from './agent.js';
import { terminalBeginResultSchema, terminalExecResultSchema, terminalOutputEventSchema, type TerminalExecResult } from './protocol.js';
import type { OrbitSession } from './session.js';

const TERMINAL_TIMEOUT_PAD_MS = 15_000; // the desktop caps a command at 120s; the wire waits a little longer

export class TerminalApi {
  private outputListeners = new Set<(stream: 'stdout' | 'stderr', data: string) => void>();
  private sessionId?: string;
  private off?: () => void;

  constructor(private readonly session: OrbitSession) {
    session.onStatus(status => { if (status !== 'connected') this.sessionId = undefined; });
    this.off = session.onEvent(event => {
      if (event.eventType !== 'terminal.output') return;
      const parsed = terminalOutputEventSchema.safeParse(event.data);
      if (!parsed.success || parsed.data.sessionId !== this.sessionId) return;
      for (const listener of this.outputListeners) listener(parsed.data.stream, parsed.data.data);
    });
  }

  get activeSessionId(): string | undefined { return this.sessionId; }

  /** Subscribes to streamed output for the active session; returns an unsubscribe. */
  onOutput(listener: (stream: 'stdout' | 'stderr', data: string) => void): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  /** Opens a session; the computer shows an approval dialog and can say no. Returns the starting directory. */
  async begin(): Promise<{ cwd: string }> {
    const result: unknown = await this.session.command('terminal.begin', {}, { timeoutMs: 45_000 }); // the owner may need a moment at the PC
    const parsed = terminalBeginResultSchema.safeParse(result);
    if (!parsed.success) throw new InvalidDesktopReply();
    this.sessionId = parsed.data.sessionId;
    return { cwd: parsed.data.cwd };
  }

  async exec(command: string, timeoutMs?: number): Promise<TerminalExecResult> {
    const result: unknown = await this.session.command('terminal.exec',
      { sessionId: this.requireSession(), command, ...(timeoutMs ? { timeoutMs } : {}) },
      { timeoutMs: (timeoutMs ?? 60_000) + TERMINAL_TIMEOUT_PAD_MS });
    const parsed = terminalExecResultSchema.safeParse(result);
    if (!parsed.success) throw new InvalidDesktopReply();
    return parsed.data;
  }

  async interrupt(): Promise<void> {
    // immediate: interrupt must overtake the very exec it is stopping; queueing it would deadlock.
    await this.session.command('terminal.interrupt', { sessionId: this.requireSession() }, { timeoutMs: 10_000, immediate: true });
  }

  async end(): Promise<void> {
    const id = this.sessionId;
    this.sessionId = undefined;
    if (id) await this.session.command('terminal.end', { sessionId: id }, { timeoutMs: 10_000, immediate: true }).catch(() => { /* already gone is fine */ });
  }

  dispose(): void { this.off?.(); this.outputListeners.clear(); }

  private requireSession(): string {
    if (!this.sessionId) throw new Error('TERMINAL_SESSION_REQUIRED');
    return this.sessionId;
  }
}
