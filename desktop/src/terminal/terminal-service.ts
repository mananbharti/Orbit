/** One approved remote-terminal session at a time; depends on the registry, an injectable shell spawner and the approval hook; owns no PTY. */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { CommandRegistry } from '../command-router/command-registry.js';
import type { CommandContext, CommandConnection } from '../command-router/command-context.js';
import type { JsonValue } from '../protocol/messages.js';
import { ProtocolError } from '../protocol/errors.js';
import { requireBiometricConfirmation, type BiometricConfirmation } from '../security-pairing/biometric-confirmation.js';
import { TERMINAL_CHUNK, TERMINAL_DEFAULT_TIMEOUT_MS, TERMINAL_IDLE_MS, MAX_TERMINAL_OUTPUT,
  terminalExecSchema, terminalSessionSchema } from '../protocol/terminal.js';
import type { ActivityLog } from '../activity-log/activity-log.js';

export type SpawnShell = (command: string, cwd: string) => ChildProcessWithoutNullStreams;
export const defaultSpawnShell: SpawnShell = (command, cwd) => process.platform === 'win32'
  ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], { cwd, windowsHide: true })
  // detached: the shell leads its own process group, so interrupt/timeout stops the whole command tree, not just the shell.
  : spawn(process.env.SHELL ?? '/bin/sh', ['-c', command], { cwd, detached: true });

interface Running {
  child: ChildProcessWithoutNullStreams;
  outputBytes: number;
  truncated: boolean;
  timedOut: boolean;
  timer: ReturnType<typeof setTimeout>;
}
interface Session {
  id: string;
  context: CommandContext;
  connection: CommandConnection;
  cwd: string;
  abort: AbortController;
  detach: () => void;
  idle?: ReturnType<typeof setTimeout>;
  current?: Running;
  cleanup?: Promise<void>;
}

// The 'terminal' command family is deliberately absent from FAMILY_SCOPE: a shell is the most powerful capability Orbit has, so only full-access devices may use it, and every session needs a Yes at the computer.
export class TerminalService {
  private readonly unregister: (() => void)[];
  private session?: Session;
  private stopped = false;

  constructor(registry: CommandRegistry, private readonly log: ActivityLog,
    private readonly confirmation: BiometricConfirmation = requireBiometricConfirmation,
    private readonly spawnShell: SpawnShell = defaultSpawnShell, private readonly home: string = homedir()) {
    this.unregister = [
      registry.register('terminal.begin', { validate: p => p === null || (typeof p === 'object' && Object.keys(p).length === 0),
        execute: async (_p, context) => this.begin(context) }),
      registry.register('terminal.exec', { validate: p => terminalExecSchema.safeParse(p).success,
        execute: async (p, context) => this.exec(context, terminalExecSchema.parse(p)) }),
      registry.register('terminal.interrupt', { validate: p => terminalSessionSchema.safeParse(p).success,
        execute: async (p, context) => this.interrupt(context, terminalSessionSchema.parse(p).sessionId) }),
      registry.register('terminal.end', { validate: p => terminalSessionSchema.safeParse(p).success,
        execute: async (p, context) => { await this.endSession(this.owned(context, terminalSessionSchema.parse(p).sessionId)); return { ended: true }; } }),
    ];
  }

  private async begin(context: CommandContext): Promise<JsonValue> {
    this.authorize(context);
    if (this.stopped) throw new ProtocolError('TERMINAL_UNAVAILABLE');
    if (this.session) throw new ProtocolError('BUSY');
    const connection = context.connection!;
    const session: Session = { id: randomUUID(), context, connection, cwd: this.home, abort: new AbortController(),
      detach: () => {} };
    this.session = session; // reserve before the approval dialog so two connections cannot race in
    const onClose = (): void => { void this.endSession(session); };
    connection.closed.addEventListener('abort', onClose, { once: true });
    session.detach = () => connection.closed.removeEventListener('abort', onClose);
    session.idle = this.idleTimer(session);
    try {
      const confirmed = await this.confirmation.verify({ version: 1, type: 'terminal.begin', requestId: context.requestId, payload: {} }, context);
      if (!confirmed) throw new ProtocolError('BIOMETRIC_REQUIRED');
    } catch (error) {
      await this.endSession(session);
      throw error;
    }
    this.log.record({ severity: 'info', eventType: 'terminal.started', outcome: 'success',
      deviceId: context.session.deviceId, sessionId: context.session.sessionId });
    return { sessionId: session.id, cwd: session.cwd, idleTimeoutMs: TERMINAL_IDLE_MS };
  }

  private async exec(context: CommandContext, payload: { sessionId: string; command: string; timeoutMs?: number }): Promise<JsonValue> {
    const session = this.owned(context, payload.sessionId);
    if (session.current) throw new ProtocolError('BUSY');
    clearTimeout(session.idle);
    session.idle = this.idleTimer(session);
    const command = payload.command;

    // cd is handled by the service so the working directory is real state, not a shell quirk; other shell state (variables, functions) does not carry between commands.
    const cd = /^\s*cd(?:\s+(?<target>[^;&|]*))?\s*$/.exec(command)?.groups?.target;
    if (cd !== undefined) {
      let wanted = (cd.trim() || this.home).replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
      // A real shell expands ~ to the home directory; without this, "cd ~" looked for a folder literally named ~.
      if (wanted === '~' || wanted.startsWith('~/') || wanted.startsWith('~\\')) wanted = join(this.home, wanted.slice(1));
      const target = resolve(session.cwd, wanted);
      try { if (!statSync(target).isDirectory()) throw new Error('not a directory'); }
      catch {
        session.connection.publish('terminal.output', { sessionId: session.id, stream: 'stderr', data: `cd: no such directory: ${cd.trim()}\n` });
        return { exitCode: 1, cwd: session.cwd, truncated: false, timedOut: false };
      }
      session.cwd = target;
      return { exitCode: 0, cwd: session.cwd, truncated: false, timedOut: false };
    }

    const timeoutMs = payload.timeoutMs ?? TERMINAL_DEFAULT_TIMEOUT_MS;
    let child: ChildProcessWithoutNullStreams;
    try { child = this.spawnShell(command, session.cwd); }
    catch { throw new ProtocolError('TERMINAL_UNAVAILABLE'); }
    const running: Running = { child, outputBytes: 0, truncated: false, timedOut: false,
      timer: setTimeout(() => { running.timedOut = true; this.kill(child); }, timeoutMs) };
    session.current = running;
    try {
      const onData = (stream: 'stdout' | 'stderr') => (chunk: Buffer | string): void => {
        const text = chunk.toString();
        if (running.outputBytes >= MAX_TERMINAL_OUTPUT) {
          if (!running.truncated) { running.truncated = true; this.kill(child); }
          return;
        }
        running.outputBytes += text.length;
        for (let i = 0; i < text.length; i += TERMINAL_CHUNK) {
          session.connection.publish('terminal.output', { sessionId: session.id, stream, data: text.slice(i, i + TERMINAL_CHUNK) });
        }
      };
      child.stdout.on('data', onData('stdout'));
      child.stderr.on('data', onData('stderr'));
      const exitCode = await new Promise<number | null>(resolvePromise => {
        child.once('exit', code => resolvePromise(code));
        child.once('error', () => resolvePromise(null));
      });
      return { exitCode, cwd: session.cwd, truncated: running.truncated, timedOut: running.timedOut };
    } finally {
      clearTimeout(running.timer);
      if (session.current === running) session.current = undefined;
    }
  }

  private async interrupt(context: CommandContext, sessionId: string): Promise<{ interrupted: boolean }> {
    const session = this.owned(context, sessionId);
    const current = session.current;
    if (!current) return { interrupted: false };
    this.kill(current.child);
    return { interrupted: true };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const unregister of this.unregister) unregister();
    if (this.session) await this.endSession(this.session);
  }

  private kill(child: ChildProcessWithoutNullStreams): void {
    const tree = (signal: 'SIGTERM' | 'SIGKILL'): void => {
      const pid = child.pid;
      if (pid === undefined) { try { child.kill(signal); } catch { /* already gone */ } return; } // no pid: best effort on the handle
      if (process.platform === 'win32') {
        if (signal !== 'SIGTERM') return; // taskkill /T /F already covers the tree, forced
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
        return;
      }
      try { process.kill(-pid, signal); } // the whole process group
      catch { try { child.kill(signal); } catch { /* already gone */ } }
    };
    tree('SIGTERM');
    setTimeout(() => tree('SIGKILL'), 2_000).unref();
  }

  private idleTimer(session: Session): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => { void this.endSession(session); }, TERMINAL_IDLE_MS);
    timer.unref?.();
    return timer;
  }

  private endSession(session: Session): Promise<void> {
    if (session.cleanup) return session.cleanup;
    session.cleanup = Promise.resolve().then(async () => {
      session.abort.abort();
      session.detach();
      clearTimeout(session.idle);
      if (session.current) { clearTimeout(session.current.timer); this.kill(session.current.child); }
      this.log.record({ severity: 'info', eventType: 'terminal.ended', outcome: 'success',
        deviceId: session.context.session.deviceId, sessionId: session.context.session.sessionId });
    }).finally(() => { if (this.session === session) this.session = undefined; });
    return session.cleanup;
  }

  private authorized(context: CommandContext): boolean {
    try {
      return !!context.connection && !context.connection.closed.aborted
        && context.session.expiresAt > Date.now() && context.connection.isAuthorized();
    } catch { return false; }
  }
  private authorize(context: CommandContext): void {
    if (!this.authorized(context)) throw new ProtocolError('UNAUTHENTICATED');
  }
  private owned(context: CommandContext, id: string): Session {
    this.authorize(context);
    const session = this.session;
    if (!session || session.abort.signal.aborted || id !== session.id
      || context.connection !== session.connection || context.session.sessionId !== session.context.session.sessionId
      || context.session.deviceId !== session.context.session.deviceId) throw new ProtocolError('TERMINAL_SESSION_REQUIRED');
    if (this.stopped) throw new ProtocolError('TERMINAL_UNAVAILABLE');
    return session;
  }
}
